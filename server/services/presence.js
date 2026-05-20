// PresenceService — authoritative multi-signal agent presence state.
//
// Replaces the single `shift_ended_at IS NULL` boolean (D1 root cause).
// Presence = MAX() of four independent signals:
//   P_scheduled   — inside agent.shift_start_time..shift_end_time?
//   P_clockedIn   — open shifts row?
//   P_recentlyActive — recent internal activity_event?
//   P_assignedLive — last_staff_msg_at within responding_window (from agent_live_state)?
//
// States (priority highest → lowest):
//   IN_SESSION               — open session exists
//   RESPONDING               — recent Supabase staff msg, no open session
//   ON_BREAK                 — open shift_breaks row
//   IDLE_ON_SHIFT            — clocked-in, no activity signal
//   SCHEDULED_NOT_CLOCKED_IN — inside scheduled window but no shifts row
//   UNSCHEDULED_ACTIVE       — outside window but has recent activity
//   OFF_SHIFT                — no signal

const { UTC_OFFSET } = require('../constants/sla-rules');

// Compute current local time components from UTC
function localNow() {
    const now = new Date();
    const localMs = now.getTime() + UTC_OFFSET * 3_600_000;
    const local = new Date(localMs);
    return {
        hours:   local.getUTCHours(),
        minutes: local.getUTCMinutes(),
        dayOfWeek: local.getUTCDay(),
        date: local,
    };
}

// Check if the agent's scheduled window is active right now
function isInScheduledWindow(shiftStartTime, shiftEndTime) {
    if (!shiftStartTime || !shiftEndTime) return false;
    const { hours, minutes } = localNow();
    const nowMinutes = hours * 60 + minutes;

    // shiftStartTime / shiftEndTime come from DB as strings like "09:00:00"
    const [sh, sm] = (shiftStartTime.toString()).split(':').map(Number);
    const [eh, em] = (shiftEndTime.toString()).split(':').map(Number);
    const startMinutes = sh * 60 + sm;
    const endMinutes   = eh * 60 + em;

    return nowMinutes >= startMinutes && nowMinutes < endMinutes;
}

class PresenceService {
    constructor({ sql }) {
        this.sql = sql;
    }

    // Create (or replace) the v_agent_presence view in the DB.
    // Call once at startup after tables exist.
    async createView() {
        await this.sql`
            CREATE OR REPLACE VIEW v_agent_presence AS
            SELECT
                a.id,
                a.name,
                a.fitstn_id,
                a.shift_start_time,
                a.shift_end_time,
                a.package_specialty,
                (SELECT sh.id FROM shifts sh
                 WHERE sh.agent_id = a.id AND sh.shift_ended_at IS NULL
                 LIMIT 1) AS open_shift_id,
                (SELECT se.id FROM sessions se
                 WHERE se.agent_id = a.id AND se.ended_at IS NULL
                 LIMIT 1) AS open_session_id,
                (SELECT MAX(ae.created_at) FROM activity_events ae
                 WHERE ae.agent_id = a.id) AS last_activity_at,
                (SELECT sb.id FROM shift_breaks sb
                 JOIN shifts sh2 ON sb.shift_id = sh2.id
                 WHERE sh2.agent_id = a.id
                   AND sh2.shift_ended_at IS NULL
                   AND sb.ended_at IS NULL
                 LIMIT 1) AS open_break_id,
                als.last_staff_msg_at,
                COALESCE(als.assigned_live_count, 0) AS assigned_live_count
            FROM agents a
            LEFT JOIN agent_live_state als ON als.agent_id = a.id
            WHERE a.is_active = TRUE
        `;
    }

    // Returns presence rows for all active agents.
    // Each row:  { id, name, fitstn_id, presence, presence_detail, idle_minutes, ... }
    async getAll(opts = {}) {
        const idleWarningMinutes = opts.idleWarningMinutes ?? 10;
        const respondingWindowMs = (opts.respondingWindowMinutes ?? 10) * 60_000;

        const rows = await this.sql`
            SELECT
                id, name, fitstn_id,
                shift_start_time, shift_end_time, package_specialty,
                open_shift_id, open_session_id, open_break_id,
                last_activity_at, last_staff_msg_at, assigned_live_count
            FROM v_agent_presence
        `;

        const now = Date.now();

        return rows.map(r => {
            const presence = this._computePresence(r, now, idleWarningMinutes, respondingWindowMs);
            return { ...r, ...presence };
        });
    }

    // Returns presence for a single agent by id, or null if not found.
    async getOne(agentId, opts = {}) {
        const all = await this.getAll(opts);
        return all.find(a => a.id === agentId) ?? null;
    }

    // ── private ──────────────────────────────────────────────────────────────

    _computePresence(r, nowMs, idleWarningMinutes, respondingWindowMs) {
        const hasClockedIn    = Boolean(r.open_shift_id);
        const hasOpenSession  = Boolean(r.open_session_id);
        const isOnBreak       = Boolean(r.open_break_id);
        const inWindow        = isInScheduledWindow(r.shift_start_time, r.shift_end_time);

        const lastStaffMsgMs  = r.last_staff_msg_at ? new Date(r.last_staff_msg_at).getTime() : 0;
        const lastActivityMs  = r.last_activity_at  ? new Date(r.last_activity_at).getTime()  : 0;
        const lastSignalMs    = Math.max(lastStaffMsgMs, lastActivityMs);

        const msSinceSignal   = lastSignalMs > 0 ? nowMs - lastSignalMs : Infinity;
        const msSinceStaffMsg = lastStaffMsgMs > 0 ? nowMs - lastStaffMsgMs : Infinity;

        const idleMs          = idleWarningMinutes * 60_000;
        const idleMinutes     = hasClockedIn && lastSignalMs > 0
            ? Math.max(0, Math.floor((nowMs - lastSignalMs) / 60_000))
            : null;

        let presence;
        let presenceDetail = null;

        if (hasOpenSession) {
            presence = 'IN_SESSION';
        } else if (hasClockedIn && isOnBreak) {
            presence = 'ON_BREAK';
        } else if (hasClockedIn && msSinceStaffMsg < respondingWindowMs) {
            presence = 'RESPONDING';
        } else if (hasClockedIn) {
            presence = 'IDLE_ON_SHIFT';
            if (idleMinutes !== null && idleMinutes >= idleWarningMinutes) {
                presenceDetail = `idle ${idleMinutes}m`;
            }
        } else if (!hasClockedIn && inWindow) {
            presence = 'SCHEDULED_NOT_CLOCKED_IN';
        } else if (!hasClockedIn && msSinceSignal < 30 * 60_000) {
            presence = 'UNSCHEDULED_ACTIVE';
        } else {
            presence = 'OFF_SHIFT';
        }

        return { presence, presenceDetail, idleMinutes };
    }
}

// Maps presence state → the "is effectively on shift" boolean used by capacity math
function isEffectivelyOnShift(presence) {
    return ['IN_SESSION', 'RESPONDING', 'ON_BREAK', 'IDLE_ON_SHIFT'].includes(presence);
}

// Maps presence state → is agent available for new work (not in session or on break)
function isAvailable(presence) {
    return presence === 'IDLE_ON_SHIFT' || presence === 'RESPONDING';
}

module.exports = { PresenceService, isEffectivelyOnShift, isAvailable };
