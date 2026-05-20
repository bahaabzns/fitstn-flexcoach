// QueueEngine — three-tier Supabase queue monitoring.
//
// L1 (60s): Per-agent pending count → in-memory state + SSE broadcast.
// L2 (60s, +30s offset): Per-room fetch → live_queue_rooms upsert +
//   agent_live_state (last_staff_msg_at, assigned_live_count, D2 utilization).
// L3 (15s): In-memory breach watch → state transitions + TTB SSE broadcast +
//   sla_breach_ledger writes on first BREACHED detection.

const { SLA_RULES, TENANT_ID } = require('../constants/sla-rules');

const L1_INTERVAL_MS       = 60_000;
const L2_INTERVAL_MS       = 60_000;
const L2_OFFSET_MS         = 30_000;
const L3_INTERVAL_MS       = 15_000;
const SNAPSHOT_INTERVAL_MS = 5 * 60_000;
const MAX_ROOMS_PER_AGENT  = 500;

// Priority score weights: [PackagePriority, TTB_Urgency, AgingPenalty, PremiumBoost, ReopenPenalty]
const DEFAULT_WEIGHTS = [0.20, 0.40, 0.15, 0.20, 0.05];

// State advancement order (never go backward)
const STATE_ORDER = { OPEN: 0, AT_RISK: 1, URGENT: 2, BREACHED: 3 };

class QueueEngine {
    constructor({ sql, supabase, ensureSupabaseAuth, broadcast }) {
        this.sql                = sql;
        this.supabase           = supabase;
        this.ensureSupabaseAuth = ensureSupabaseAuth;
        this.broadcast          = broadcast;

        // L1 in-memory state
        this.state = {
            byAgent:            [],
            unassigned_count:   0,
            global_total:       0,
            global_growth_rate: 0,
            capturedAt:         null,
            pollCount:          0,
        };

        // L2/L3 in-memory state
        this._roomCache   = new Map();   // room_id → room object
        this._breachedSet = new Set();   // room_ids written to sla_breach_ledger this session
        this._ttbState    = null;        // latest TTB counts
        this._weights     = [...DEFAULT_WEIGHTS];

        // Growth-rate ring buffer (last 30 L1 polls ≈ 30 min)
        this._history = [];

        // Concurrency guards
        this._l1Running = false;
        this._l2Running = false;

        this._l1Timer       = null;
        this._l2Timer       = null;
        this._l3Timer       = null;
        this._snapshotTimer = null;
    }

    start() {
        this._runL1();
        this._l1Timer = setInterval(() => this._runL1(), L1_INTERVAL_MS);

        setTimeout(() => {
            this._runL2();
            this._l2Timer = setInterval(() => this._runL2(), L2_INTERVAL_MS);
        }, L2_OFFSET_MS);

        this._l3Timer       = setInterval(() => this._runL3(), L3_INTERVAL_MS);
        this._snapshotTimer = setInterval(() => this._runSnapshot(), SNAPSHOT_INTERVAL_MS);

        console.log('[QueueEngine] started — L1: 60s, L2: 60s+30s, L3: 15s');
    }

    stop() {
        [this._l1Timer, this._l2Timer, this._l3Timer, this._snapshotTimer]
            .forEach(t => t && clearInterval(t));
    }

    // Public accessors

    getState()    { return this.state; }
    getTtbState() { return this._ttbState; }

    getRooms({ agentId, packageName, state, limit = 200 } = {}) {
        let rooms = [...this._roomCache.values()].filter(r => r.state !== 'RESOLVED');
        if (agentId)     rooms = rooms.filter(r => r.assigned_agent_id === agentId);
        if (packageName) rooms = rooms.filter(r => r.package_name === packageName);
        if (state)       rooms = rooms.filter(r => r.state === state);
        rooms.sort((a, b) => b.priority_score - a.priority_score);
        return rooms.slice(0, limit);
    }

    // ── L1 — Fast per-agent counts ────────────────────────────────────────────

    _runL1() {
        if (this._l1Running) return;
        this._l1Running = true;
        this._pollL1()
            .catch(err => console.error('[QueueEngine L1] error:', err.message))
            .finally(() => { this._l1Running = false; });
    }

    async _pollL1() {
        await this.ensureSupabaseAuth();

        const agents = await this.sql`
            SELECT id, name, fitstn_id FROM agents
            WHERE is_active = true AND fitstn_id IS NOT NULL AND fitstn_id != ''
        `;

        const rpcBase = {
            p_assigned_staff_id: null, p_client_gender: null, p_coach_id: null,
            p_ghost_days: null, p_ghost_only: false, p_last_interaction: null,
            p_last_interaction_from: null, p_last_interaction_to: null,
            p_last_message_from: 'client',
            p_limit: 1, p_no_assigned_staff: false, p_offset: 0,
            p_package_id: null, p_search: null, p_staff_id: null,
            p_subscription_start_date: null, p_subscription_start_weekday: null,
            p_subscription_status: null, p_subscription_t_status: null,
            p_tenant_id: TENANT_ID, p_unread_only: false,
        };

        const [globalResult, unassignedResult, ...agentResults] = await Promise.all([
            this.supabase.rpc('get_chat_rooms_paginated', { ...rpcBase }),
            this.supabase.rpc('get_chat_rooms_paginated', { ...rpcBase, p_no_assigned_staff: true }),
            ...agents.map(a =>
                this.supabase.rpc('get_chat_rooms_paginated', {
                    ...rpcBase, p_assigned_staff_id: a.fitstn_id,
                })
            ),
        ]);

        const now         = new Date();
        const globalTotal = globalResult.data?.total ?? 0;
        const unassigned  = unassignedResult.data?.total ?? 0;

        const prevEntry   = this._history.at(-1) ?? null;
        const prevByAgent = prevEntry ? prevEntry.byAgent : new Map();
        const elapsedHrs  = prevEntry
            ? (now - prevEntry.capturedAt) / 3_600_000
            : L1_INTERVAL_MS / 3_600_000;

        const byAgent = agents.map((agent, i) => {
            const count = agentResults[i]?.data?.total ?? 0;
            const prev  = prevByAgent.get(agent.id) ?? count;
            const rate  = elapsedHrs > 0 ? (count - prev) / elapsedHrs : 0;
            return {
                agent_id:             agent.id,
                agent_name:           agent.name,
                pending_count:        count,
                growth_rate_per_hour: Math.round(rate * 10) / 10,
                error:                agentResults[i]?.error?.message ?? null,
            };
        });

        const prevGlobal = prevEntry?.global_total ?? globalTotal;
        const globalRate = elapsedHrs > 0 ? (globalTotal - prevGlobal) / elapsedHrs : 0;

        this.state = {
            byAgent,
            unassigned_count:   unassigned,
            global_total:       globalTotal,
            global_growth_rate: Math.round(globalRate * 10) / 10,
            capturedAt:         now.toISOString(),
            pollCount:          this.state.pollCount + 1,
        };

        this._history.push({
            capturedAt:   now,
            global_total: globalTotal,
            byAgent:      new Map(byAgent.map(a => [a.agent_id, a.pending_count])),
        });
        if (this._history.length > 30) this._history.shift();

        this.broadcast('queue_update', this.state);
        console.log(
            `[QueueEngine L1] poll #${this.state.pollCount}: ` +
            `global=${globalTotal}, unassigned=${unassigned}, agents=${byAgent.length}`
        );
    }

    // ── L2 — Per-room snapshot ────────────────────────────────────────────────

    _runL2() {
        if (this._l2Running) return;
        this._l2Running = true;
        this._pollL2()
            .catch(err => console.error('[QueueEngine L2] error:', err.message))
            .finally(() => { this._l2Running = false; });
    }

    async _pollL2() {
        const now = new Date();
        await this.ensureSupabaseAuth();

        const agents = await this.sql`
            SELECT id, name, fitstn_id,
                   TO_CHAR(COALESCE(shift_end_time, '19:00'::time), 'HH24:MI') AS shift_end_time
            FROM agents
            WHERE is_active = true AND fitstn_id IS NOT NULL AND fitstn_id != ''
        `;
        if (agents.length === 0) return;

        // Capacity config for D2 utilization formula
        const configs = await this.sql`
            SELECT package_name, complexity_weight, avg_handling_minutes,
                   max_concurrent_chats, is_scheduled_workload
            FROM agent_capacity_config
        `;
        const configByPkg = Object.fromEntries(configs.map(c => [c.package_name, c]));
        const liveCfg     = configs.filter(c => !c.is_scheduled_workload);
        const totalWeight = liveCfg.reduce((s, c) => s + parseFloat(c.complexity_weight), 0);
        const weightedCapPerHour = totalWeight > 0
            ? liveCfg.reduce((s, c) => {
                const cap = (60 / parseFloat(c.avg_handling_minutes)) * parseFloat(c.max_concurrent_chats);
                return s + cap * parseFloat(c.complexity_weight) / totalWeight;
            }, 0) * 0.75   // WFM shrinkage factor
            : 4.5;

        const rpcBase = {
            p_assigned_staff_id: null, p_client_gender: null, p_coach_id: null,
            p_ghost_days: null, p_ghost_only: false, p_last_interaction: null,
            p_last_interaction_from: null, p_last_interaction_to: null,
            p_last_message_from: 'client',
            p_limit: MAX_ROOMS_PER_AGENT, p_no_assigned_staff: false, p_offset: 0,
            p_package_id: null, p_search: null, p_staff_id: null,
            p_subscription_start_date: null, p_subscription_start_weekday: null,
            p_subscription_status: null, p_subscription_t_status: null,
            p_tenant_id: TENANT_ID, p_unread_only: false,
        };

        const seenRoomIds = new Set();

        for (const agent of agents) {
            const { data, error } = await this.supabase.rpc('get_chat_rooms_paginated', {
                ...rpcBase, p_assigned_staff_id: agent.fitstn_id,
            });

            if (error) {
                console.warn(`[QueueEngine L2] ${agent.name} fetch error:`, error.message);
                continue;
            }

            const rooms       = data?.rooms || [];
            let maxStaffMsgAt = null;
            let weightedLoad  = 0;
            const roomRecords = [];

            for (const r of rooms) {
                const roomId          = String(r.id);
                seenRoomIds.add(roomId);

                const lastClientMsgAt    = r.last_client_message_at
                    ? new Date(r.last_client_message_at) : now;
                const lastStaffMsgAtRoom = r.last_staff_message_at
                    ? new Date(r.last_staff_message_at) : null;
                const pkgName    = r.package_name || 'unknown';
                const clientName = r.client_name || r.client_code || null;

                const rule       = SLA_RULES[pkgName];
                const maxMinutes = rule?.maxMinutes ?? 1440;
                const slaDeadlineAt     = new Date(lastClientMsgAt.getTime() + maxMinutes * 60_000);
                const minutesToDeadline = (slaDeadlineAt - now) / 60_000;

                // Compute state from deadline
                const computedState = minutesToDeadline <= 0  ? 'BREACHED'
                    : minutesToDeadline <= 10 ? 'URGENT'
                    : minutesToDeadline <= 30 ? 'AT_RISK'
                    : 'OPEN';

                // Advance existing state, never go backward
                const prevRoom      = this._roomCache.get(roomId);
                const prevStateRank = STATE_ORDER[prevRoom?.state ?? 'OPEN'] ?? 0;
                const newStateRank  = STATE_ORDER[computedState] ?? 0;
                const state         = newStateRank > prevStateRank ? computedState : (prevRoom?.state ?? computedState);

                // Write breach ledger on first BREACHED detection
                if (state === 'BREACHED' && !this._breachedSet.has(roomId)) {
                    this._breachedSet.add(roomId);
                    this._writeBreach({
                        room_id: roomId, package_name: pkgName,
                        assigned_agent_id: agent.id, sla_deadline_at: slaDeadlineAt,
                    }).catch(err => console.error('[QueueEngine L2] breach write:', err.message));
                }

                // Priority score
                const isPro    = pkgName.includes('Pro');
                const priority = rule?.priority ?? 3;
                const [w1, w2, w3, w4] = this._weights;
                const pkgPriScore  = (5 - priority) / 4;
                const ttbUrgency   = Math.min(1.2, Math.max(0, 1 - minutesToDeadline / maxMinutes));
                const ageMinutes   = (now - lastClientMsgAt) / 60_000;
                const agingPenalty = Math.log1p(ageMinutes / 60) / Math.log1p(8);
                const premiumBoost = isPro ? 1.0 : 0;
                const priorityScore = w1 * pkgPriScore + w2 * ttbUrgency + w3 * agingPenalty + w4 * premiumBoost;

                // D2 weighted load: complexity × urgency multiplier
                const cfg              = configByPkg[pkgName];
                const complexityWeight = parseFloat(cfg?.complexity_weight ?? 1.0);
                const urgencyMult      = minutesToDeadline <= 0   ? 3.0
                    : minutesToDeadline <= 60  ? 1.0 + (60 - minutesToDeadline) / 60
                    : 1.0;
                weightedLoad += complexityWeight * urgencyMult;

                if (lastStaffMsgAtRoom && (!maxStaffMsgAt || lastStaffMsgAtRoom > maxStaffMsgAt)) {
                    maxStaffMsgAt = lastStaffMsgAtRoom;
                }

                const roomRecord = {
                    room_id:           roomId,
                    package_name:      pkgName,
                    assigned_agent_id: agent.id,
                    client_name:       clientName,
                    last_client_msg_at: lastClientMsgAt,
                    last_staff_msg_at:  lastStaffMsgAtRoom,
                    sla_deadline_at:    slaDeadlineAt,
                    priority_score:     Math.round(priorityScore * 1000) / 1000,
                    state,
                };
                this._roomCache.set(roomId, roomRecord);
                roomRecords.push(roomRecord);
            }

            // Upsert rooms to DB (state only advances, never reverses)
            for (const rd of roomRecords) {
                this.sql`
                    INSERT INTO live_queue_rooms
                        (room_id, package_name, assigned_agent_id, client_name,
                         last_client_msg_at, last_staff_msg_at, sla_deadline_at,
                         priority_score, state, updated_at)
                    VALUES
                        (${rd.room_id}, ${rd.package_name}, ${rd.assigned_agent_id},
                         ${rd.client_name}, ${rd.last_client_msg_at}, ${rd.last_staff_msg_at},
                         ${rd.sla_deadline_at}, ${rd.priority_score}, ${rd.state}, ${now})
                    ON CONFLICT (room_id) DO UPDATE SET
                        package_name       = EXCLUDED.package_name,
                        assigned_agent_id  = EXCLUDED.assigned_agent_id,
                        client_name        = EXCLUDED.client_name,
                        last_client_msg_at = EXCLUDED.last_client_msg_at,
                        last_staff_msg_at  = COALESCE(EXCLUDED.last_staff_msg_at, live_queue_rooms.last_staff_msg_at),
                        sla_deadline_at    = EXCLUDED.sla_deadline_at,
                        priority_score     = EXCLUDED.priority_score,
                        state = CASE
                            WHEN EXCLUDED.state = 'BREACHED'
                              THEN 'BREACHED'
                            WHEN EXCLUDED.state = 'URGENT'
                             AND live_queue_rooms.state NOT IN ('BREACHED')
                              THEN 'URGENT'
                            WHEN EXCLUDED.state = 'AT_RISK'
                             AND live_queue_rooms.state = 'OPEN'
                              THEN 'AT_RISK'
                            WHEN live_queue_rooms.state = 'RESOLVED'
                              THEN EXCLUDED.state
                            ELSE live_queue_rooms.state
                        END,
                        state_changed_at = CASE
                            WHEN live_queue_rooms.state <> EXCLUDED.state THEN NOW()
                            ELSE live_queue_rooms.state_changed_at
                        END,
                        updated_at = NOW()
                `.catch(err =>
                    console.error(`[QueueEngine L2] upsert room ${rd.room_id}:`, err.message)
                );
            }

            // D2: weighted utilization → agent_live_state
            const [seh, sem]    = (agent.shift_end_time || '19:00').split(':').map(Number);
            const shiftEndToday = new Date(now);
            shiftEndToday.setHours(seh, sem, 0, 0);
            const hoursLeft            = Math.max(0, (shiftEndToday - now) / 3_600_000);
            const weightedLoadPerHour  = hoursLeft > 0 ? weightedLoad / hoursLeft : weightedLoad;
            const utilization          = weightedCapPerHour > 0 ? weightedLoadPerHour / weightedCapPerHour : 0;

            this.sql`
                INSERT INTO agent_live_state
                    (agent_id, last_staff_msg_at, assigned_live_count,
                     weighted_load_per_hour, utilization, updated_at)
                VALUES
                    (${agent.id}, ${maxStaffMsgAt}, ${roomRecords.length},
                     ${Math.round(weightedLoadPerHour * 100) / 100},
                     ${Math.round(utilization * 1000) / 1000}, ${now})
                ON CONFLICT (agent_id) DO UPDATE SET
                    last_staff_msg_at      = COALESCE(EXCLUDED.last_staff_msg_at, agent_live_state.last_staff_msg_at),
                    assigned_live_count    = EXCLUDED.assigned_live_count,
                    weighted_load_per_hour = EXCLUDED.weighted_load_per_hour,
                    utilization            = EXCLUDED.utilization,
                    updated_at             = EXCLUDED.updated_at
            `.catch(err =>
                console.error(`[QueueEngine L2] agent_live_state ${agent.id}:`, err.message)
            );
        }

        // Mark rooms no longer in pending query as RESOLVED
        for (const [roomId, room] of this._roomCache) {
            if (!seenRoomIds.has(roomId) && room.state !== 'RESOLVED') {
                room.state = 'RESOLVED';
                this.sql`
                    UPDATE live_queue_rooms
                    SET state = 'RESOLVED', updated_at = NOW()
                    WHERE room_id = ${roomId}
                `.catch(() => {});
            }
        }

        console.log(
            `[QueueEngine L2] ${seenRoomIds.size} pending rooms, ` +
            `cache: ${this._roomCache.size} total (${agents.length} agents)`
        );
    }

    // ── L3 — Breach watch ────────────────────────────────────────────────────

    _runL3() {
        this._watchBreaches().catch(err =>
            console.error('[QueueEngine L3] error:', err.message)
        );
    }

    async _watchBreaches() {
        const now   = new Date();
        const rooms = [...this._roomCache.values()].filter(r => r.state !== 'RESOLVED');

        let breachingNow = 0, breaching15m = 0, breaching30m = 0, breaching60m = 0;

        for (const room of rooms) {
            const minsLeft = (new Date(room.sla_deadline_at) - now) / 60_000;

            const computedState = minsLeft <= 0  ? 'BREACHED'
                : minsLeft <= 10 ? 'URGENT'
                : minsLeft <= 30 ? 'AT_RISK'
                : 'OPEN';

            // Only advance state
            if ((STATE_ORDER[computedState] ?? 0) > (STATE_ORDER[room.state] ?? 0)) {
                if (computedState === 'BREACHED' && !this._breachedSet.has(room.room_id)) {
                    this._breachedSet.add(room.room_id);
                    this._writeBreach(room).catch(err =>
                        console.error('[QueueEngine L3] breach write:', err.message)
                    );
                }
                room.state = computedState;
                this.sql`
                    UPDATE live_queue_rooms
                    SET state = ${computedState}, state_changed_at = NOW(), updated_at = NOW()
                    WHERE room_id = ${room.room_id}
                `.catch(() => {});
            }

            if (room.state === 'BREACHED') breachingNow++;
            if (minsLeft > 0 && minsLeft <= 15) breaching15m++;
            if (minsLeft <= 30) breaching30m++;
            if (minsLeft <= 60) breaching60m++;
        }

        this._ttbState = {
            breaching_now: breachingNow,
            breaching_15m: breaching15m,
            breaching_30m: breaching30m,
            breaching_60m: breaching60m,
            total_open:    rooms.length,
            computed_at:   now.toISOString(),
        };

        this.broadcast('ttb_stream', this._ttbState);
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    async _writeBreach(room) {
        await this.sql`
            INSERT INTO sla_breach_ledger
                (room_id, package_name, assigned_agent_id, sla_deadline_at, breached_at)
            SELECT
                ${room.room_id}, ${room.package_name},
                ${room.assigned_agent_id ?? null}, ${room.sla_deadline_at}, NOW()
            WHERE NOT EXISTS (
                SELECT 1 FROM sla_breach_ledger
                WHERE room_id    = ${room.room_id}
                  AND breached_at > NOW() - INTERVAL '24 hours'
            )
        `;
    }

    _runSnapshot() {
        this._persistSnapshot().catch(err =>
            console.error('[QueueEngine] snapshot error:', err.message)
        );
    }

    async _persistSnapshot() {
        if (!this.state.capturedAt) return;
        const now = new Date();

        for (const agent of this.state.byAgent) {
            try {
                await this.sql`
                    INSERT INTO queue_snapshots (snapshot_at, agent_id, package_name, pending_count)
                    VALUES (${now}, ${agent.agent_id}, 'all', ${agent.pending_count})
                `;
            } catch (err) {
                console.error(`[QueueEngine] snapshot agent ${agent.agent_id}:`, err.message);
            }
        }
        try {
            await this.sql`
                INSERT INTO queue_snapshots (snapshot_at, agent_id, package_name, pending_count)
                VALUES (${now}, NULL, 'all', ${this.state.global_total})
            `;
        } catch (err) {
            console.error('[QueueEngine] global snapshot:', err.message);
        }
    }
}

module.exports = QueueEngine;
