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

            // Calculate effective duration (gross shift time minus total break time)
            const grossShiftSeconds = Math.round(
                (new Date(result[0].shift_ended_at) - new Date(result[0].shift_started_at)) / 1000
            );
            const breakData = await sql`
                SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (ended_at - started_at))), 0) AS total_seconds
                FROM shift_breaks
                WHERE shift_id = ${result[0].id}
            `;
            const totalBreakSeconds = Math.round(Number(breakData[0].total_seconds));
            const effectiveShiftSeconds = Math.max(0, grossShiftSeconds - totalBreakSeconds);

            const shiftEndedMetadata = JSON.stringify({
                duration_seconds: effectiveShiftSeconds,
                gross_duration_seconds: grossShiftSeconds,
                break_seconds: totalBreakSeconds,
            });
            await sql`
                INSERT INTO activity_events (agent_id, event_type, shift_id, metadata)
                VALUES (${req.user.id}, 'shift_ended', ${result[0].id}, ${shiftEndedMetadata}::jsonb)
            `;

            res.json({ success: true, shift: result[0] });
        } catch (err) {
            res.status(500).json({ error: "Failed to end shift", details: err.message });
        }
    });

    const REOPEN_GRACE_PERIOD_MINUTES = 5;

    router.post("/reopen-shift", requireAgent, async (req, res) => {
        try {
            const recentlyEnded = await sql`
                SELECT id, shift_started_at, shift_ended_at
                FROM shifts
                WHERE agent_id = ${req.user.id}
                AND DATE(shift_started_at) = CURRENT_DATE
                AND shift_ended_at IS NOT NULL
                AND shift_ended_at > NOW() - INTERVAL '${sql.unsafe(String(REOPEN_GRACE_PERIOD_MINUTES))} minutes'
                ORDER BY shift_ended_at DESC
                LIMIT 1
            `;
            if (recentlyEnded.length === 0) {
                return res.status(400).json({ error: "No recently ended shift to reopen. Grace period is " + REOPEN_GRACE_PERIOD_MINUTES + " minutes." });
            }

            const result = await sql`
                UPDATE shifts SET shift_ended_at = NULL
                WHERE id = ${recentlyEnded[0].id}
                RETURNING *
            `;

            await sql`
                INSERT INTO activity_events (agent_id, event_type, shift_id, metadata)
                VALUES (${req.user.id}, 'shift_reopened', ${result[0].id}, '{"reason": "agent_reopened"}'::jsonb)
            `;

            res.json({ success: true, shift: result[0] });
        } catch (err) {
            res.status(500).json({ error: "Failed to reopen shift", details: err.message });
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
                SELECT id, shift_started_at,
                    ROUND(EXTRACT(EPOCH FROM (NOW() - shift_started_at)))::int AS shift_duration_seconds
                FROM shifts
                WHERE agent_id = ${agentId} AND shift_ended_at IS NULL
                ORDER BY shift_started_at DESC LIMIT 1
            `;
            if (shift.length === 0) {
                return res.json({ status: "off_shift" });
            }

            const shiftId = shift[0].id;
            const shiftStartedAt = shift[0].shift_started_at;
            const shiftDurationSeconds = shift[0].shift_duration_seconds;

            // Check for active break (compute duration server-side)
            const activeBreak = await sql`
                SELECT id, started_at,
                    ROUND(EXTRACT(EPOCH FROM (NOW() - started_at)))::int AS current_break_seconds
                FROM shift_breaks
                WHERE shift_id = ${shiftId} AND ended_at IS NULL
                LIMIT 1
            `;

            // Total completed break seconds for this shift
            const breakData = await sql`
                SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (ended_at - started_at))), 0)::int AS total_seconds
                FROM shift_breaks
                WHERE shift_id = ${shiftId} AND ended_at IS NOT NULL
            `;
            const completedBreakSeconds = Number(breakData[0].total_seconds);

            // Total completed session seconds within this shift (clamped to shift boundaries)
            const completedSessions = await sql`
                SELECT COALESCE(SUM(GREATEST(0, EXTRACT(EPOCH FROM (
                    LEAST(ended_at, NOW()) - GREATEST(clicked_at, ${shiftStartedAt})
                )))), 0)::int AS total_seconds
                FROM sessions
                WHERE agent_id = ${agentId}
                  AND clicked_at < NOW()
                  AND ended_at > ${shiftStartedAt}
                  AND ended_at IS NOT NULL
            `;
            const completedActiveSeconds = Number(completedSessions[0].total_seconds);

            // On break — return pre-computed durations
            if (activeBreak.length > 0) {
                const currentBreakSeconds = activeBreak[0].current_break_seconds;
                const totalBreakSeconds = completedBreakSeconds + currentBreakSeconds;
                const idleSeconds = Math.max(0, shiftDurationSeconds - completedActiveSeconds - totalBreakSeconds);
                return res.json({
                    status: "on_break",
                    shift_started_at: shiftStartedAt,
                    shift_duration_seconds: shiftDurationSeconds,
                    current_break_seconds: currentBreakSeconds,
                    total_break_seconds: totalBreakSeconds,
                    total_active_seconds: completedActiveSeconds,
                    idle_duration_seconds: idleSeconds,
                });
            }

            // Check for active chat session (clamped to shift start)
            const session = await sql`
                SELECT id, chat_name,
                    GREATEST(0, ROUND(EXTRACT(EPOCH FROM (NOW() - GREATEST(clicked_at, ${shiftStartedAt})))))::int AS chat_duration_seconds
                FROM sessions
                WHERE agent_id = ${agentId} AND ended_at IS NULL
                ORDER BY clicked_at DESC LIMIT 1
            `;

            if (session.length > 0) {
                const chatDurationSeconds = session[0].chat_duration_seconds;
                const totalActiveSeconds = completedActiveSeconds + chatDurationSeconds;
                const totalBreakSeconds = completedBreakSeconds;
                const idleSeconds = Math.max(0, shiftDurationSeconds - totalActiveSeconds - totalBreakSeconds);
                return res.json({
                    status: "active",
                    chat_name: session[0].chat_name,
                    shift_started_at: shiftStartedAt,
                    shift_duration_seconds: shiftDurationSeconds,
                    chat_duration_seconds: chatDurationSeconds,
                    total_active_seconds: totalActiveSeconds,
                    total_break_seconds: totalBreakSeconds,
                    idle_duration_seconds: idleSeconds,
                });
            }

            // Idle: on shift but no active session and not on break
            const lastSession = await sql`
                SELECT ROUND(EXTRACT(EPOCH FROM (NOW() - ended_at)))::int AS idle_since_seconds
                FROM sessions
                WHERE agent_id = ${agentId} AND ended_at IS NOT NULL
                ORDER BY ended_at DESC LIMIT 1
            `;
            const idleSinceSeconds = lastSession.length > 0
                ? Math.min(lastSession[0].idle_since_seconds, shiftDurationSeconds)
                : shiftDurationSeconds;
            const totalBreakSeconds = completedBreakSeconds;
            const idleSeconds = Math.max(0, shiftDurationSeconds - completedActiveSeconds - totalBreakSeconds);
            return res.json({
                status: "idle",
                shift_started_at: shiftStartedAt,
                shift_duration_seconds: shiftDurationSeconds,
                idle_since_seconds: idleSinceSeconds,
                total_active_seconds: completedActiveSeconds,
                total_break_seconds: totalBreakSeconds,
                idle_duration_seconds: idleSeconds,
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
