const express = require("express");

const ALLOWED_EVENT_TYPES = [
    "message_sent",
    "session_started",
    "session_ended",
    "shift_started",
    "shift_ended",
    "idle_started",
    "idle_resumed",
    "tab_focus_lost",
    "tab_focus_gained",
];

const MAX_EVENTS_LIMIT = 500;
const DEFAULT_EVENTS_LIMIT = 100;
const DEFAULT_FEED_LIMIT = 50;
const MAX_FEED_LIMIT = 100;

module.exports = function (sql, requireAgent, requireAdmin) {
    const router = express.Router();

    // POST /api/activity-event — log a single activity event
    router.post("/activity-event", requireAgent, async (req, res) => {
        try {
            const { event_type, session_id, shift_id, metadata } = req.body;

            if (!event_type) {
                return res.status(400).json({ error: "event_type is required" });
            }

            if (!ALLOWED_EVENT_TYPES.includes(event_type)) {
                return res.status(400).json({
                    error: `Invalid event_type. Allowed: ${ALLOWED_EVENT_TYPES.join(", ")}`,
                });
            }

            const result = await sql`
                INSERT INTO activity_events (agent_id, event_type, session_id, shift_id, metadata)
                VALUES (
                    ${req.user.id},
                    ${event_type},
                    ${session_id || null},
                    ${shift_id || null},
                    ${JSON.stringify(metadata || {})}::jsonb
                )
                RETURNING id, created_at
            `;

            res.json({ success: true, event_id: result[0].id, created_at: result[0].created_at });
        } catch (err) {
            console.error("Error logging activity event:", err.message);
            res.status(500).json({ error: "Failed to log activity event", details: err.message });
        }
    });

    // GET /api/activity-events — query events with filters (admin only)
    router.get("/activity-events", requireAdmin, async (req, res) => {
        try {
            const agentId = req.query.agent_id ? parseInt(req.query.agent_id) : null;
            const eventType = req.query.event_type || null;
            const since = req.query.since || null;
            const limit = Math.min(parseInt(req.query.limit) || DEFAULT_EVENTS_LIMIT, MAX_EVENTS_LIMIT);

            const events = await sql`
                SELECT
                    ae.id,
                    ae.agent_id,
                    a.name AS agent_name,
                    ae.event_type,
                    ae.session_id,
                    ae.shift_id,
                    ae.metadata,
                    ae.created_at
                FROM activity_events ae
                JOIN agents a ON a.id = ae.agent_id
                WHERE 1=1
                    ${agentId ? sql`AND ae.agent_id = ${agentId}` : sql``}
                    ${eventType ? sql`AND ae.event_type = ${eventType}` : sql``}
                    ${since ? sql`AND ae.created_at > ${since}::timestamp` : sql``}
                ORDER BY ae.created_at DESC
                LIMIT ${limit}
            `;

            res.json({ events });
        } catch (err) {
            console.error("Error fetching activity events:", err.message);
            res.status(500).json({ error: "Failed to fetch activity events", details: err.message });
        }
    });

    // GET /api/activity-feed — live feed for admin dashboard
    router.get("/activity-feed", requireAdmin, async (req, res) => {
        try {
            const sinceId = req.query.since_id ? parseInt(req.query.since_id) : null;
            const limit = Math.min(parseInt(req.query.limit) || DEFAULT_FEED_LIMIT, MAX_FEED_LIMIT);

            const events = await sql`
                SELECT
                    ae.id,
                    ae.agent_id,
                    a.name AS agent_name,
                    ae.event_type,
                    ae.session_id,
                    ae.shift_id,
                    ae.metadata,
                    ae.created_at,
                    s.chat_name
                FROM activity_events ae
                JOIN agents a ON a.id = ae.agent_id
                LEFT JOIN sessions s ON s.id = ae.session_id
                WHERE 1=1
                    ${sinceId ? sql`AND ae.id > ${sinceId}` : sql``}
                ORDER BY ae.created_at DESC
                LIMIT ${limit}
            `;

            const latestId = events.length > 0 ? Math.max(...events.map(e => e.id)) : sinceId;

            res.json({ events, latest_id: latestId });
        } catch (err) {
            console.error("Error fetching activity feed:", err.message);
            res.status(500).json({ error: "Failed to fetch activity feed", details: err.message });
        }
    });

    return router;
};
