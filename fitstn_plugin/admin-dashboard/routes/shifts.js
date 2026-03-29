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

            const result = await sql`
                INSERT INTO shifts (agent_id, shift_started_at)
                VALUES (${req.user.id}, NOW())
                RETURNING *
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
            res.json({ success: true, shift: result[0] });
        } catch (err) {
            res.status(500).json({ error: "Failed to end shift", details: err.message });
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
            const session = await sql`
                SELECT id, chat_name, clicked_at FROM sessions
                WHERE agent_id = ${agentId} AND ended_at IS NULL
                ORDER BY clicked_at DESC LIMIT 1
            `;
            const shiftStartedAt = shift[0].shift_started_at;
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
            });
        } catch (err) {
            res.status(500).json({ error: "Failed to fetch status", details: err.message });
        }
    });

    router.get("/settings", requireAgent, async (req, res) => {
        try {
            const rows = await sql`SELECT key, value FROM settings WHERE key = 'max_session_minutes'`;
            const settings = {};
            for (const row of rows) settings[row.key] = row.value;
            res.json(settings);
        } catch (err) {
            res.status(500).json({ error: "Failed to fetch settings", details: err.message });
        }
    });

    return router;
};
