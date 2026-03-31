const express = require("express");

module.exports = function (sql, requireAgent) {
    const router = express.Router();

    router.post("/start-shift", requireAgent, async (req, res) => {
        try {
            const existingToday = await sql`
                SELECT id, shift_ended_at FROM shifts
                WHERE agent_id = ${req.user.id}
                AND DATE(shift_started_at) = CURRENT_DATE
            `;
            const hasActiveShift = existingToday.some(s => !s.shift_ended_at);
            if (hasActiveShift) {
                return res.status(400).json({ error: "Shift already active" });
            }
            if (existingToday.length > 0) {
                return res.status(400).json({ error: "Only one shift per day is allowed. You already had a shift today." });
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

            // Close any active break when ending shift
            await sql`
                UPDATE shift_breaks SET ended_at = NOW()
                WHERE shift_id = ${result[0].id} AND ended_at IS NULL
            `;

            const shiftDurationSeconds = Math.round(
                (new Date(result[0].shift_ended_at) - new Date(result[0].shift_started_at)) / 1000
            );
            await sql`
                INSERT INTO activity_events (agent_id, event_type, shift_id, metadata)
                VALUES (${req.user.id}, 'shift_ended', ${result[0].id}, ${JSON.stringify({ duration_seconds: shiftDurationSeconds })}::jsonb)
            `;

            res.json({ success: true, shift: result[0] });
        } catch (err) {
            res.status(500).json({ error: "Failed to end shift", details: err.message });
        }
    });

    router.post("/start-break", requireAgent, async (req, res) => {
        try {
            const activeShift = await sql`
                SELECT id FROM shifts WHERE agent_id = ${req.user.id} AND shift_ended_at IS NULL
            `;
            if (activeShift.length === 0) {
                return res.status(400).json({ error: "No active shift — cannot start break" });
            }

            const existingBreak = await sql`
                SELECT id FROM shift_breaks
                WHERE shift_id = ${activeShift[0].id} AND ended_at IS NULL
            `;
            if (existingBreak.length > 0) {
                return res.status(400).json({ error: "Break already active" });
            }

            const result = await sql`
                INSERT INTO shift_breaks (shift_id, agent_id, started_at)
                VALUES (${activeShift[0].id}, ${req.user.id}, NOW())
                RETURNING *
            `;

            await sql`
                INSERT INTO activity_events (agent_id, event_type, shift_id, metadata)
                VALUES (${req.user.id}, 'break_started', ${activeShift[0].id}, ${JSON.stringify({})}::jsonb)
            `;

            res.status(201).json({ success: true, shiftBreak: result[0] });
        } catch (err) {
            res.status(500).json({ error: "Failed to start break", details: err.message });
        }
    });

    router.post("/end-break", requireAgent, async (req, res) => {
        try {
            const activeShift = await sql`
                SELECT id FROM shifts WHERE agent_id = ${req.user.id} AND shift_ended_at IS NULL
            `;
            if (activeShift.length === 0) {
                return res.status(400).json({ error: "No active shift" });
            }

            const result = await sql`
                UPDATE shift_breaks SET ended_at = NOW()
                WHERE shift_id = ${activeShift[0].id} AND ended_at IS NULL
                RETURNING *
            `;
            if (result.length === 0) {
                return res.status(400).json({ error: "No active break" });
            }

            const breakDurationSeconds = Math.round(
                (new Date(result[0].ended_at) - new Date(result[0].started_at)) / 1000
            );
            await sql`
                INSERT INTO activity_events (agent_id, event_type, shift_id, metadata)
                VALUES (${req.user.id}, 'break_resumed', ${activeShift[0].id}, ${JSON.stringify({ break_duration_seconds: breakDurationSeconds })}::jsonb)
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
                res.json({ active: true, shift: result[0] });
            } else {
                res.json({ active: false, shift: null });
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

            // Check for active break
            const activeBreak = await sql`
                SELECT id, started_at FROM shift_breaks
                WHERE shift_id = ${shiftId} AND ended_at IS NULL
                LIMIT 1
            `;

            // Total break seconds for this shift (completed breaks only)
            const breakData = await sql`
                SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (ended_at - started_at))), 0) AS total_seconds
                FROM shift_breaks
                WHERE shift_id = ${shiftId} AND ended_at IS NOT NULL
            `;
            const totalBreakSeconds = Math.round(Number(breakData[0].total_seconds));

            // If on break, return early with on_break status
            if (activeBreak.length > 0) {
                const currentBreakSeconds = Math.round((Date.now() - new Date(activeBreak[0].started_at).getTime()) / 1000);
                return res.json({
                    status: "on_break",
                    break_started_at: activeBreak[0].started_at,
                    shift_started_at: shiftStartedAt,
                    total_break_seconds: totalBreakSeconds + currentBreakSeconds,
                    total_active_seconds: 0,
                });
            }

            const session = await sql`
                SELECT id, chat_name, clicked_at FROM sessions
                WHERE agent_id = ${agentId} AND ended_at IS NULL
                ORDER BY clicked_at DESC LIMIT 1
            `;
            const completedSessions = await sql`
                SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (ended_at - clicked_at))), 0) AS total_seconds
                FROM sessions
                WHERE agent_id = ${agentId}
                  AND clicked_at >= ${shiftStartedAt}
                  AND ended_at IS NOT NULL
            `;
            const completedActiveSeconds = Math.round(Number(completedSessions[0].total_seconds));

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
                });
            }

            // Idle: on shift but no active session and not on break
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
