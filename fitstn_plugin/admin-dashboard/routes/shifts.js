const express = require("express");

module.exports = function (sql, requireAgent) {
    const router = express.Router();

    router.post("/start-shift", requireAgent, async (req, res) => {
        try {
            const existing = await sql`
                SELECT id FROM shifts WHERE agent_id = ${req.user.id} AND shift_ended_at IS NULL
            `;
            if (existing.length > 0) {
                return res.status(400).json({ error: "Shift already active" });
            }

            // One shift per calendar day
            const todayShift = await sql`
                SELECT id FROM shifts
                WHERE agent_id = ${req.user.id}
                AND DATE(shift_started_at) = CURRENT_DATE
            `;
            if (todayShift.length > 0) {
                return res.status(400).json({ error: "You already had a shift today. Only one shift per day is allowed." });
            }

            const result = await sql`
                INSERT INTO shifts (agent_id, shift_started_at)
                VALUES (${req.user.id}, NOW())
                RETURNING *
            `;

            await sql`
                INSERT INTO activity_events (agent_id, event_type, shift_id)
                VALUES (${req.user.id}, 'shift_started', ${result[0].id})
            `;

            res.status(201).json({ success: true, shift: result[0] });
        } catch (err) {
            res.status(500).json({ error: "Failed to start shift", details: err.message });
        }
    });

    router.post("/end-shift", requireAgent, async (req, res) => {
        try {
            const result = await sql`
                UPDATE shifts SET shift_ended_at = NOW()
                WHERE agent_id = ${req.user.id} AND shift_ended_at IS NULL
                RETURNING *
            `;
            if (result.length === 0) {
                return res.status(400).json({ error: "No active shift" });
            }

            const shiftId = result[0].id;

            // Close any open break
            await sql`
                UPDATE shift_breaks SET ended_at = NOW()
                WHERE shift_id = ${shiftId} AND ended_at IS NULL
            `;

            // Close any open sessions
            const closedSessions = await sql`
                UPDATE sessions SET ended_at = NOW()
                WHERE agent_id = ${req.user.id} AND ended_at IS NULL
                RETURNING id
            `;
            for (const closed of closedSessions) {
                await sql`
                    INSERT INTO activity_events (agent_id, event_type, session_id, metadata)
                    VALUES (${req.user.id}, 'session_ended', ${closed.id}, '{"reason": "shift_ended"}'::jsonb)
                `;
            }

            // Calculate effective duration (total minus breaks)
            const breakData = await sql`
                SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (ended_at - started_at))), 0)::int AS total_break_seconds
                FROM shift_breaks WHERE shift_id = ${shiftId}
            `;
            const totalBreakSeconds = breakData[0].total_break_seconds;
            const totalShiftSeconds = Math.round(
                (new Date(result[0].shift_ended_at) - new Date(result[0].shift_started_at)) / 1000
            );
            const effectiveShiftSeconds = Math.max(0, totalShiftSeconds - totalBreakSeconds);

            await sql`
                INSERT INTO activity_events (agent_id, event_type, shift_id, metadata)
                VALUES (${req.user.id}, 'shift_ended', ${shiftId}, ${JSON.stringify({
                    duration_seconds: effectiveShiftSeconds,
                    total_seconds: totalShiftSeconds,
                    break_seconds: totalBreakSeconds,
                })}::jsonb)
            `;

            res.json({ success: true, shift: result[0] });
        } catch (err) {
            res.status(500).json({ error: "Failed to end shift", details: err.message });
        }
    });

    router.post("/start-break", requireAgent, async (req, res) => {
        try {
            const shift = await sql`
                SELECT id FROM shifts
                WHERE agent_id = ${req.user.id} AND shift_ended_at IS NULL
                LIMIT 1
            `;
            if (shift.length === 0) {
                return res.status(400).json({ error: "No active shift to take a break from" });
            }

            const existingBreak = await sql`
                SELECT id FROM shift_breaks
                WHERE shift_id = ${shift[0].id} AND ended_at IS NULL
            `;
            if (existingBreak.length > 0) {
                return res.status(400).json({ error: "Break already active" });
            }

            // Close any open sessions before break
            const closedSessions = await sql`
                UPDATE sessions SET ended_at = NOW()
                WHERE agent_id = ${req.user.id} AND ended_at IS NULL
                RETURNING id
            `;
            for (const closed of closedSessions) {
                await sql`
                    INSERT INTO activity_events (agent_id, event_type, session_id, metadata)
                    VALUES (${req.user.id}, 'session_ended', ${closed.id}, '{"reason": "break_started"}'::jsonb)
                `;
            }

            const result = await sql`
                INSERT INTO shift_breaks (shift_id, agent_id, started_at)
                VALUES (${shift[0].id}, ${req.user.id}, NOW())
                RETURNING *
            `;

            await sql`
                INSERT INTO activity_events (agent_id, event_type, shift_id, metadata)
                VALUES (${req.user.id}, 'break_started', ${shift[0].id}, ${JSON.stringify({ break_id: result[0].id })}::jsonb)
            `;

            res.json({ success: true, shiftBreak: result[0] });
        } catch (err) {
            res.status(500).json({ error: "Failed to start break", details: err.message });
        }
    });

    router.post("/end-break", requireAgent, async (req, res) => {
        try {
            const result = await sql`
                UPDATE shift_breaks SET ended_at = NOW()
                WHERE agent_id = ${req.user.id} AND ended_at IS NULL
                RETURNING *
            `;
            if (result.length === 0) {
                return res.status(400).json({ error: "No active break to end" });
            }

            const breakDurationSeconds = Math.round(
                (new Date(result[0].ended_at) - new Date(result[0].started_at)) / 1000
            );

            await sql`
                INSERT INTO activity_events (agent_id, event_type, shift_id, metadata)
                VALUES (${req.user.id}, 'break_ended', ${result[0].shift_id}, ${JSON.stringify({
                    break_id: result[0].id,
                    break_duration_seconds: breakDurationSeconds,
                })}::jsonb)
            `;

            res.json({ success: true, shiftBreak: result[0] });
        } catch (err) {
            res.status(500).json({ error: "Failed to end break", details: err.message });
        }
    });

    router.get("/active-shift", requireAgent, async (req, res) => {
        try {
            const result = await sql`
                SELECT * FROM shifts
                WHERE agent_id = ${req.user.id} AND shift_ended_at IS NULL
                LIMIT 1
            `;
            if (result.length > 0) {
                const activeBreak = await sql`
                    SELECT id, started_at FROM shift_breaks
                    WHERE shift_id = ${result[0].id} AND ended_at IS NULL
                    LIMIT 1
                `;
                res.json({
                    active: true,
                    shift: result[0],
                    is_on_break: activeBreak.length > 0,
                    break_started_at: activeBreak.length > 0 ? activeBreak[0].started_at : null,
                });
            } else {
                res.json({ active: false, shift: null, is_on_break: false, break_started_at: null });
            }
        } catch (err) {
            res.status(500).json({ error: "Failed to check shift", details: err.message });
        }
    });

    router.get("/status", requireAgent, async (req, res) => {
        try {
            const agentId = req.user.id;
            const shift = await sql`
                SELECT id, shift_started_at FROM shifts
                WHERE agent_id = ${agentId} AND shift_ended_at IS NULL
                ORDER BY shift_started_at DESC LIMIT 1
            `;
            if (shift.length === 0) {
                return res.json({ status: "off_shift" });
            }

            const shiftId = shift[0].id;
            const shiftStartedAt = shift[0].shift_started_at;

            // Check if on break
            const activeBreak = await sql`
                SELECT id, started_at FROM shift_breaks
                WHERE shift_id = ${shiftId} AND ended_at IS NULL
                LIMIT 1
            `;
            const isOnBreak = activeBreak.length > 0;

            // Total break seconds for this shift
            const breakData = await sql`
                SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (
                    COALESCE(ended_at, NOW()) - started_at
                ))), 0)::int AS total_break_seconds
                FROM shift_breaks WHERE shift_id = ${shiftId}
            `;
            const totalBreakSeconds = breakData[0].total_break_seconds;

            // Total active seconds from sessions
            const completedSessions = await sql`
                SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (ended_at - clicked_at))), 0) AS total_seconds
                FROM sessions
                WHERE agent_id = ${agentId}
                  AND clicked_at >= ${shiftStartedAt}
                  AND ended_at IS NOT NULL
            `;
            const completedActiveSeconds = Math.round(Number(completedSessions[0].total_seconds));

            // Server-computed durations
            const totalShiftSeconds = Math.round((Date.now() - new Date(shiftStartedAt).getTime()) / 1000);
            const effectiveShiftSeconds = Math.max(0, totalShiftSeconds - totalBreakSeconds);

            if (isOnBreak) {
                return res.json({
                    status: "on_break",
                    break_started_at: activeBreak[0].started_at,
                    shift_started_at: shiftStartedAt,
                    total_active_seconds: completedActiveSeconds,
                    total_break_seconds: totalBreakSeconds,
                    total_shift_seconds: totalShiftSeconds,
                    effective_shift_seconds: effectiveShiftSeconds,
                });
            }

            const session = await sql`
                SELECT id, chat_name, clicked_at FROM sessions
                WHERE agent_id = ${agentId} AND ended_at IS NULL
                ORDER BY clicked_at DESC LIMIT 1
            `;

            if (session.length > 0) {
                const currentSessionSeconds = Math.round((Date.now() - new Date(session[0].clicked_at).getTime()) / 1000);
                const totalActiveSeconds = completedActiveSeconds + currentSessionSeconds;
                return res.json({
                    status: "active",
                    chat_name: session[0].chat_name,
                    chat_started_at: session[0].clicked_at,
                    shift_started_at: shiftStartedAt,
                    total_active_seconds: totalActiveSeconds,
                    total_break_seconds: totalBreakSeconds,
                    total_shift_seconds: totalShiftSeconds,
                    effective_shift_seconds: effectiveShiftSeconds,
                });
            }

            // Idle: on shift but no active session
            const lastSession = await sql`
                SELECT ended_at FROM sessions
                WHERE agent_id = ${agentId} AND ended_at IS NOT NULL
                ORDER BY ended_at DESC LIMIT 1
            `;
            const shiftStart = new Date(shiftStartedAt);
            const lastEnded = lastSession.length > 0 ? new Date(lastSession[0].ended_at) : null;
            const idleSince = lastEnded && lastEnded > shiftStart ? lastEnded : shiftStart;
            return res.json({
                status: "idle",
                idle_since: idleSince.toISOString(),
                shift_started_at: shiftStartedAt,
                total_active_seconds: completedActiveSeconds,
                total_break_seconds: totalBreakSeconds,
                total_shift_seconds: totalShiftSeconds,
                effective_shift_seconds: effectiveShiftSeconds,
            });
        } catch (err) {
            res.status(500).json({ error: "Failed to fetch status", details: err.message });
        }
    });

    router.get("/settings", requireAgent, async (req, res) => {
        try {
            const rows = await sql`SELECT key, value FROM settings WHERE key IN ('max_session_minutes', 'idle_inside_session_minutes', 'session_timeout_minutes')`;
            const settings = {};
            for (const row of rows) settings[row.key] = row.value;
            res.json(settings);
        } catch (err) {
            res.status(500).json({ error: "Failed to fetch settings", details: err.message });
        }
    });

    return router;
};
