// PremiumProtectionService — watches Pro rooms approaching SLA deadline and
// escalates when the assigned agent is idle or off-shift.
//
// Tick: 30 s. Deduplication: at most one escalation per room per 60 min.

const TICK_MS                = 30_000;
const DEADLINE_WARN_MINUTES  = 30;
const DEDUP_WINDOW_MS        = 60 * 60_000;  // 1 hour
const PRO_PACKAGES           = new Set(['Fit Solo Pro', 'Fit Fam Pro']);

class PremiumProtectionService {
    constructor({ sql, queueEngine, presenceService, isEffectivelyOnShift, isAvailable, broadcast }) {
        this.sql                  = sql;
        this.queueEngine          = queueEngine;
        this.presenceService      = presenceService;
        this.isEffectivelyOnShift = isEffectivelyOnShift;
        this.isAvailable          = isAvailable;
        this.broadcast            = broadcast;

        // room_id → timestamp of last escalation
        this._escalatedAt = new Map();
        this._timer       = null;
    }

    start() {
        this._timer = setInterval(() => this._tick().catch(err =>
            console.error('[PremiumProtection] tick error:', err.message)
        ), TICK_MS);
        console.log('[PremiumProtection] started — 30s tick, watching Pro rooms ≤30m to deadline');
    }

    stop() {
        if (this._timer) clearInterval(this._timer);
    }

    async _tick() {
        const now     = new Date();
        const rooms   = this.queueEngine.getRooms({ limit: 1000 });
        const proRooms = rooms.filter(r =>
            PRO_PACKAGES.has(r.package_name) &&
            r.state !== 'RESOLVED' &&
            r.assigned_agent_id != null
        );

        if (proRooms.length === 0) return;

        // Build presence map for quick lookup
        const allPresence = await this.presenceService.getAll();
        const presenceById = Object.fromEntries(allPresence.map(a => [a.id, a]));

        for (const room of proRooms) {
            const minutesToDeadline = (new Date(room.sla_deadline_at) - now) / 60_000;
            if (minutesToDeadline > DEADLINE_WARN_MINUTES || minutesToDeadline < 0) continue;

            const lastEscalated = this._escalatedAt.get(room.room_id);
            if (lastEscalated && (now - lastEscalated) < DEDUP_WINDOW_MS) continue;

            const agentPresence = presenceById[room.assigned_agent_id];
            const presence      = agentPresence?.presence ?? 'UNKNOWN';
            const agentIdle     = !agentPresence || !this.isEffectivelyOnShift(presence);

            if (!agentIdle) continue;

            const reason = `Agent presence: ${presence}. Pro room ${room.room_id} has ${Math.round(minutesToDeadline)}m to SLA deadline.`;

            // Write to premium_escalations
            await this.sql`
                INSERT INTO premium_escalations
                    (escalated_at, room_id, package_name, assigned_agent_id,
                     agent_presence, minutes_to_deadline, reason)
                VALUES
                    (${now}, ${room.room_id}, ${room.package_name},
                     ${room.assigned_agent_id}, ${presence},
                     ${Math.round(minutesToDeadline)}, ${reason})
            `.catch(err => console.error('[PremiumProtection] write failed:', err.message));

            // Broadcast SSE alert
            this.broadcast('premium_alert', {
                room_id:             room.room_id,
                package_name:        room.package_name,
                assigned_agent_id:   room.assigned_agent_id,
                agent_presence:      presence,
                minutes_to_deadline: Math.round(minutesToDeadline),
                client_name:         room.client_name,
                priority_score:      room.priority_score,
                reason,
                escalated_at:        now.toISOString(),
            });

            this._escalatedAt.set(room.room_id, now);

            console.log(
                `[PremiumProtection] escalated: room ${room.room_id} ` +
                `(${room.package_name}, ${Math.round(minutesToDeadline)}m left, agent ${presence})`
            );
        }

        // Clean up stale dedup entries
        for (const [roomId, ts] of this._escalatedAt) {
            if ((now - ts) > DEDUP_WINDOW_MS * 2) this._escalatedAt.delete(roomId);
        }
    }
}

module.exports = { PremiumProtectionService };
