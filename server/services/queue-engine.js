// QueueEngine — polls Supabase every 60 s for live pending-chat counts per agent.
// Maintains in-memory state for instant /api/queue-state reads and emits SSE
// broadcast events so the ops-center page updates without client polling.

const POLL_INTERVAL_MS     = 60 * 1000;   // how often to query Supabase
const SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000; // how often to write queue_snapshots row

const { TENANT_ID } = require('../constants/sla-rules');

class QueueEngine {
    constructor({ sql, supabase, ensureSupabaseAuth, broadcast }) {
        this.sql                = sql;
        this.supabase           = supabase;
        this.ensureSupabaseAuth = ensureSupabaseAuth;
        this.broadcast          = broadcast;

        // In-memory state — returned immediately by GET /api/queue-state
        this.state = {
            byAgent:            [],   // [{agent_id, agent_name, pending_count, growth_rate_per_hour}]
            unassigned_count:   0,
            global_total:       0,
            global_growth_rate: 0,
            capturedAt:         null,
            pollCount:          0,
        };

        // Ring buffer of recent polls for growth-rate computation (last 30 = 30 min)
        this._history = [];

        this._pollTimer     = null;
        this._snapshotTimer = null;
    }

    start() {
        this._runPoll();

        this._pollTimer = setInterval(() => this._runPoll(), POLL_INTERVAL_MS);
        this._snapshotTimer = setInterval(() => this._runSnapshot(), SNAPSHOT_INTERVAL_MS);

        console.log('[QueueEngine] started — polling every 60 s, snapshots every 5 m');
    }

    stop() {
        if (this._pollTimer)     clearInterval(this._pollTimer);
        if (this._snapshotTimer) clearInterval(this._snapshotTimer);
    }

    // Called by GET /api/queue-state
    getState() {
        return this.state;
    }

    // ── private ──────────────────────────────────────────────────────────────

    _runPoll() {
        this._poll().catch(err =>
            console.error('[QueueEngine] poll error:', err.message)
        );
    }

    _runSnapshot() {
        this._persistSnapshot().catch(err =>
            console.error('[QueueEngine] snapshot write error:', err.message)
        );
    }

    async _poll() {
        await this.ensureSupabaseAuth();

        const agents = await this.sql`
            SELECT id, name, fitstn_id
            FROM agents
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

        // Fire all RPC calls in parallel: global + unassigned + one per agent
        const promises = [
            this.supabase.rpc('get_chat_rooms_paginated', { ...rpcBase }),
            this.supabase.rpc('get_chat_rooms_paginated', { ...rpcBase, p_no_assigned_staff: true }),
            ...agents.map(a =>
                this.supabase.rpc('get_chat_rooms_paginated', {
                    ...rpcBase, p_assigned_staff_id: a.fitstn_id,
                })
            ),
        ];

        const [globalResult, unassignedResult, ...agentResults] = await Promise.all(promises);

        const now          = new Date();
        const globalTotal  = globalResult.data?.total ?? 0;
        const unassigned   = unassignedResult.data?.total ?? 0;

        // Previous poll state for growth rate
        const prevEntry   = this._history.length > 0 ? this._history[this._history.length - 1] : null;
        const prevByAgent = prevEntry ? prevEntry.byAgent : new Map();
        const elapsedHrs  = prevEntry
            ? (now - prevEntry.capturedAt) / 3_600_000
            : POLL_INTERVAL_MS / 3_600_000;

        const byAgent = agents.map((agent, i) => {
            const count = agentResults[i]?.data?.total ?? 0;
            const prev  = prevByAgent.get(agent.id) ?? count;
            const rate  = elapsedHrs > 0 ? (count - prev) / elapsedHrs : 0;
            return {
                agent_id:            agent.id,
                agent_name:          agent.name,
                pending_count:       count,
                growth_rate_per_hour: Math.round(rate * 10) / 10,
                error:               agentResults[i]?.error?.message ?? null,
            };
        });

        const prevGlobal   = prevEntry?.global_total ?? globalTotal;
        const globalRate   = elapsedHrs > 0 ? (globalTotal - prevGlobal) / elapsedHrs : 0;

        this.state = {
            byAgent,
            unassigned_count:   unassigned,
            global_total:       globalTotal,
            global_growth_rate: Math.round(globalRate * 10) / 10,
            capturedAt:         now.toISOString(),
            pollCount:          this.state.pollCount + 1,
        };

        // Update ring buffer (keep 30 entries ≈ 30 minutes)
        this._history.push({
            capturedAt:   now,
            global_total: globalTotal,
            byAgent:      new Map(byAgent.map(a => [a.agent_id, a.pending_count])),
        });
        if (this._history.length > 30) this._history.shift();

        this.broadcast('queue_update', this.state);

        console.log(
            `[QueueEngine] poll #${this.state.pollCount}: ` +
            `global=${globalTotal}, unassigned=${unassigned}, agents=${byAgent.length}`
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
                console.error(`[QueueEngine] queue_snapshot write failed for agent ${agent.agent_id}:`, err.message);
            }
        }

        // Global row
        try {
            await this.sql`
                INSERT INTO queue_snapshots (snapshot_at, agent_id, package_name, pending_count)
                VALUES (${now}, NULL, 'all', ${this.state.global_total})
            `;
        } catch (err) {
            console.error('[QueueEngine] global queue_snapshot write failed:', err.message);
        }
    }
}

module.exports = QueueEngine;
