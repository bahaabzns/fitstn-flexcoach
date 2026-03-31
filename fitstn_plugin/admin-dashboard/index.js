const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, ".env") });
const express = require("express");
const postgres = require("postgres");
const bcrypt = require("bcryptjs");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");

// Supabase client for chat platform API
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
);
let supabaseAuthenticated = false;

async function ensureSupabaseAuth() {
    if (supabaseAuthenticated) return;
    const { error } = await supabase.auth.signInWithPassword({
        email: process.env.SUPABASE_USER_EMAIL,
        password: process.env.SUPABASE_USER_PASSWORD,
    });
    if (error) throw new Error("Supabase auth failed: " + error.message);
    supabaseAuthenticated = true;
}

const app = express();
const PORT = process.env.PORT || 3000;

const sql = process.env.DATABASE_URL
    ? postgres(process.env.DATABASE_URL, { ssl: "require" })
    : postgres({
        host: "localhost",
        port: 5432,
        database: process.env.DATABASE_NAME,
        username: process.env.DATABASE_USERNAME,
        password: process.env.DATABASE_PASSWORD,
    });

// Auth middleware
const { requireAdmin, requireAgent } = require("./middleware/auth")(sql);

// Route modules
const adminAuthRoutes = require("./routes/admin-auth")(sql);
const agentAuthRoutes = require("./routes/agent-auth")(sql, requireAgent);
const agentRoutes = require("./routes/agents")(sql, requireAdmin);
const shiftRoutes = require("./routes/shifts")(sql, requireAgent);
const salaryRoutes = require("./routes/salaries")(sql, requireAdmin);
const agentOverviewRoutes = require("./routes/agent-overview")(sql);
const activityEventRoutes = require("./routes/activity-events")(sql, requireAgent, requireAdmin);

app.use(cors({ origin: "*", allowedHeaders: ["Content-Type", "Authorization"] }));
app.use(express.json());
app.use(express.text());
app.use(express.static(path.join(__dirname)));

// Mount auth and CRUD routes
app.use("/api/admin", adminAuthRoutes);
app.use("/api/agent", agentAuthRoutes);
app.use("/api/agents", agentRoutes);
app.use("/api/agent", shiftRoutes);
app.use("/api/salaries", salaryRoutes);
app.use("/api/agent-overview", agentOverviewRoutes);
app.use("/api", activityEventRoutes);

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "login.html"));
});

app.get("/api/overview", requireAdmin, async (req, res) => {
    try {
        const result = await sql`
            SELECT
                a.id, a.name, a.email,
                (SELECT sh.id FROM shifts sh WHERE sh.agent_id = a.id AND sh.shift_ended_at IS NULL ORDER BY sh.shift_started_at DESC LIMIT 1) AS shift_id,
                (SELECT sh.shift_started_at FROM shifts sh WHERE sh.agent_id = a.id AND sh.shift_ended_at IS NULL ORDER BY sh.shift_started_at DESC LIMIT 1) AS shift_started_at,
                (SELECT s.id FROM sessions s WHERE s.agent_id = a.id AND s.ended_at IS NULL ORDER BY s.clicked_at DESC LIMIT 1) AS current_session_id,
                (SELECT s.chat_name FROM sessions s WHERE s.agent_id = a.id AND s.ended_at IS NULL ORDER BY s.clicked_at DESC LIMIT 1) AS current_chat_name,
                (SELECT s.clicked_at FROM sessions s WHERE s.agent_id = a.id AND s.ended_at IS NULL ORDER BY s.clicked_at DESC LIMIT 1) AS current_chat_started_at,
                (SELECT s.ended_at FROM sessions s WHERE s.agent_id = a.id AND s.ended_at IS NOT NULL ORDER BY s.ended_at DESC LIMIT 1) AS last_session_ended_at,
                (SELECT COUNT(*)::int FROM sessions s WHERE s.agent_id = a.id AND s.clicked_at >= CURRENT_DATE) AS today_sessions,
                (SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (
                    LEAST(COALESCE(s.ended_at, NOW()), COALESCE(sh2.shift_ended_at, NOW()))
                    - GREATEST(s.clicked_at, sh2.shift_started_at)
                ))), 0)::int
                FROM sessions s, shifts sh2
                WHERE s.agent_id = a.id AND sh2.agent_id = a.id AND sh2.shift_ended_at IS NULL
                AND s.clicked_at < COALESCE(sh2.shift_ended_at, NOW())
                AND COALESCE(s.ended_at, NOW()) > sh2.shift_started_at
                ) AS shift_active_seconds,
                (SELECT sb.id FROM shift_breaks sb
                    JOIN shifts sh3 ON sb.shift_id = sh3.id
                    WHERE sh3.agent_id = a.id AND sh3.shift_ended_at IS NULL AND sb.ended_at IS NULL
                    LIMIT 1) AS active_break_id,
                (SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (
                    COALESCE(sb.ended_at, NOW()) - sb.started_at
                ))), 0)::int
                FROM shift_breaks sb
                JOIN shifts sh4 ON sb.shift_id = sh4.id
                WHERE sh4.agent_id = a.id AND sh4.shift_ended_at IS NULL
                ) AS shift_break_seconds
            FROM agents a
            WHERE a.is_active = true
            ORDER BY
                (EXISTS (SELECT 1 FROM shifts sh WHERE sh.agent_id = a.id AND sh.shift_ended_at IS NULL)) DESC,
                a.name ASC
        `;
        const rows = result.map(row => {
            const onShift = !!row.shift_id;
            const hasActiveChat = !!row.current_session_id;
            const hasActiveBreak = !!row.active_break_id;
            let status, idle_since = null;

            if (!onShift) {
                status = "off_shift";
            } else if (hasActiveBreak) {
                status = "on_break";
            } else if (hasActiveChat) {
                status = "active";
            } else {
                status = "idle";
                const lastEnded = row.last_session_ended_at ? new Date(row.last_session_ended_at) : null;
                const shiftStart = new Date(row.shift_started_at);
                idle_since = (lastEnded && lastEnded > shiftStart ? lastEnded : shiftStart).toISOString();
            }

            let shift_idle_seconds = null;
            if (onShift) {
                const shiftSec = Math.round((Date.now() - new Date(row.shift_started_at).getTime()) / 1000);
                const breakSec = row.shift_break_seconds || 0;
                shift_idle_seconds = Math.max(0, shiftSec - (row.shift_active_seconds || 0) - breakSec);
            }

            return {
                id: row.id,
                name: row.name,
                email: row.email,
                status,
                shift_started_at: row.shift_started_at || null,
                current_chat_name: row.current_chat_name || null,
                current_chat_started_at: row.current_chat_started_at || null,
                idle_since,
                today_sessions: row.today_sessions,
                shift_idle_seconds,
                shift_break_seconds: row.shift_break_seconds || 0,
            };
        });
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch overview", details: err.message });
    }
});

app.get("/api/shifts", requireAdmin, async (req, res) => {
    try {
        const period = req.query.period || "month";
        const dateParam = req.query.date || new Date().toISOString().slice(0, 10);
        const { startDate, endDate } = getDateRange(period, dateParam);

        const result = await sql`
            SELECT sh.*, a.email as agent_email, a.name as agent_name,
                (SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (
                    LEAST(COALESCE(s.ended_at, COALESCE(sh.shift_ended_at, NOW())), COALESCE(sh.shift_ended_at, NOW()))
                    - GREATEST(s.clicked_at, sh.shift_started_at)
                ))), 0)::int
                FROM sessions s
                WHERE s.agent_id = sh.agent_id
                AND s.clicked_at < COALESCE(sh.shift_ended_at, NOW())
                AND COALESCE(s.ended_at, NOW()) > sh.shift_started_at
                ) AS active_seconds,
                (SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (
                    COALESCE(sb.ended_at, COALESCE(sh.shift_ended_at, NOW())) - sb.started_at
                ))), 0)::int
                FROM shift_breaks sb
                WHERE sb.shift_id = sh.id
                ) AS break_seconds
            FROM shifts sh
            LEFT JOIN agents a ON sh.agent_id = a.id
            WHERE sh.shift_started_at >= ${startDate}::date
            AND sh.shift_started_at < ${endDate}::date + INTERVAL '1 day'
            ORDER BY sh.shift_started_at DESC
        `;
        const rows = result.map(row => {
            const shiftEnd = row.shift_ended_at ? new Date(row.shift_ended_at) : new Date();
            const shiftDuration = Math.round((shiftEnd - new Date(row.shift_started_at)) / 1000);
            const breakSeconds = row.break_seconds || 0;
            return {
                ...row,
                duration_seconds: row.shift_ended_at ? shiftDuration : null,
                active_seconds: row.active_seconds || 0,
                break_seconds: breakSeconds,
                idle_seconds: Math.max(0, shiftDuration - (row.active_seconds || 0) - breakSeconds),
            };
        });
        res.json({ period: { type: period, start: startDate, end: endDate }, shifts: rows });
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch shifts", details: err.message });
    }
});

app.put("/api/shifts/:id", requireAdmin, async (req, res) => {
    try {
        const shiftId = parseInt(req.params.id);
        if (!shiftId) return res.status(400).json({ error: "Invalid shift ID" });

        const { shift_started_at, shift_ended_at, reason } = req.body;
        if (!reason || reason.trim().length < 3) {
            return res.status(400).json({ error: "A reason is required (at least 3 characters)" });
        }
        if (!shift_started_at) {
            return res.status(400).json({ error: "shift_started_at is required" });
        }

        const startDate = new Date(shift_started_at);
        const endDate = shift_ended_at ? new Date(shift_ended_at) : null;
        if (isNaN(startDate.getTime())) {
            return res.status(400).json({ error: "Invalid shift_started_at date" });
        }
        if (endDate && isNaN(endDate.getTime())) {
            return res.status(400).json({ error: "Invalid shift_ended_at date" });
        }
        if (endDate && endDate <= startDate) {
            return res.status(400).json({ error: "shift_ended_at must be after shift_started_at" });
        }

        const original = await sql`SELECT * FROM shifts WHERE id = ${shiftId}`;
        if (original.length === 0) {
            return res.status(404).json({ error: "Shift not found" });
        }

        const result = await sql`
            UPDATE shifts
            SET shift_started_at = ${startDate.toISOString()},
                shift_ended_at = ${endDate ? endDate.toISOString() : null}
            WHERE id = ${shiftId}
            RETURNING *
        `;

        const adjustmentMetadata = JSON.stringify({
            reason: reason.trim(),
            admin_id: req.user.id,
            before: {
                shift_started_at: original[0].shift_started_at,
                shift_ended_at: original[0].shift_ended_at,
            },
            after: {
                shift_started_at: result[0].shift_started_at,
                shift_ended_at: result[0].shift_ended_at,
            },
        });
        await sql`
            INSERT INTO activity_events (agent_id, event_type, shift_id, metadata)
            VALUES (${original[0].agent_id}, 'shift_adjusted', ${shiftId}, ${adjustmentMetadata}::jsonb)
        `;

        res.json({ success: true, shift: result[0] });
    } catch (err) {
        res.status(500).json({ error: "Failed to adjust shift", details: err.message });
    }
});

app.get("/api/sessions", requireAdmin, async (req, res) => {
    try {
        const period = req.query.period || "month";
        const dateParam = req.query.date || new Date().toISOString().slice(0, 10);
        const { startDate, endDate } = getDateRange(period, dateParam);

        const result = await sql`
            SELECT s.*, a.email as agent_email, a.name as agent_name
            FROM sessions s
            LEFT JOIN agents a ON s.agent_id = a.id
            WHERE s.clicked_at >= ${startDate}::date
            AND s.clicked_at < ${endDate}::date + INTERVAL '1 day'
            ORDER BY s.clicked_at DESC
        `;
        const rows = result.map(row => ({
            ...row,
            duration_seconds: row.ended_at
                ? Math.round((new Date(row.ended_at) - new Date(row.clicked_at)) / 1000)
                : null,
        }));
        res.json({ period: { type: period, start: startDate, end: endDate }, sessions: rows });
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch sessions", details: err.message });
    }
});

app.get("/api/session-messages/:sessionId", requireAdmin, async (req, res) => {
    try {
        const sessionId = parseInt(req.params.sessionId);
        if (!sessionId) return res.status(400).json({ error: "Invalid session ID" });

        // Get session details (client code from chat_preview, time window)
        const sessions = await sql`
            SELECT chat_preview, clicked_at, ended_at FROM sessions WHERE id = ${sessionId}
        `;
        if (sessions.length === 0) return res.status(404).json({ error: "Session not found" });

        const session = sessions[0];
        const clientCode = (session.chat_preview || "").trim().replace(/^#/, "");
        if (!clientCode) return res.json({ messages: [], reason: "No client code in chat_preview" });
        console.log(`Fetching messages for session ${sessionId}, client code: ${clientCode}`);

        await ensureSupabaseAuth();

        // Find room by client code using search
        const { data: roomData, error: roomError } = await supabase.rpc("get_chat_rooms_paginated", {
            p_assigned_staff_id: null,
            p_client_gender: null,
            p_coach_id: null,
            p_ghost_days: null,
            p_ghost_only: false,
            p_last_interaction: null,
            p_last_interaction_from: null,
            p_last_interaction_to: null,
            p_last_message_from: null,
            p_limit: 5,
            p_no_assigned_staff: false,
            p_offset: 0,
            p_package_id: null,
            p_search: clientCode,
            p_staff_id: null,
            p_subscription_start_date: null,
            p_subscription_start_weekday: null,
            p_subscription_status: null,
            p_subscription_t_status: null,
            p_tenant_id: "fitstn",
            p_unread_only: false,
        });

        if (roomError) return res.status(500).json({ error: "Failed to search rooms", details: roomError.message });
        if (!roomData?.rooms?.length) return res.json({ messages: [], reason: "No room found for client code: " + clientCode });

        const roomId = roomData.rooms[0].id;

        // Fetch messages from that room
        const { data: messages, error: msgError } = await supabase.rpc("get_chat_messages", {
            p_before: (session.ended_at || new Date()).toISOString(),
            p_limit: 200,
            p_room_id: roomId,
        });

        if (msgError) return res.status(500).json({ error: "Failed to fetch messages", details: msgError.message });

        // Filter to messages within the session time window and sent by staff
        const sessionStart = new Date(session.clicked_at);
        const sessionEnd = session.ended_at ? new Date(session.ended_at) : new Date();

        const filtered = (messages || [])
            .filter(m => {
                const msgTime = new Date(m.created_at);
                return m.sender_staff_id && msgTime >= sessionStart && msgTime <= sessionEnd;
            })
            .map(m => ({
                id: m.id,
                text: m.content,
                type: m.type,
                sent_at: m.created_at,
            }));

        res.json({ messages: filtered, room_id: roomId, total_in_window: filtered.length });
    } catch (err) {
        console.error("GET /api/session-messages error:", err.message);
        supabaseAuthenticated = false; // Reset on error so next call re-authenticates
        res.status(500).json({ error: "Failed to fetch messages", details: err.message });
    }
});

app.get("/api/agent-demand", requireAdmin, async (req, res) => {
    try {
        const agents = await sql`
            SELECT id, name, email, fitstn_id
            FROM agents
            WHERE is_active = true AND fitstn_id IS NOT NULL AND fitstn_id != ''
        `;

        if (agents.length === 0) {
            return res.json([]);
        }

        await ensureSupabaseAuth();

        const demandResults = await Promise.all(
            agents.map(async (agent) => {
                try {
                    const { data, error } = await supabase.rpc("get_chat_rooms_paginated", {
                        p_assigned_staff_id: null,
                        p_client_gender: null,
                        p_coach_id: null,
                        p_ghost_days: null,
                        p_ghost_only: false,
                        p_last_interaction: null,
                        p_last_interaction_from: null,
                        p_last_interaction_to: null,
                        p_last_message_from: "Client",
                        p_limit: 1,
                        p_no_assigned_staff: false,
                        p_offset: 0,
                        p_package_id: null,
                        p_search: null,
                        p_staff_id: agent.fitstn_id,
                        p_subscription_start_date: null,
                        p_subscription_start_weekday: null,
                        p_subscription_status: null,
                        p_subscription_t_status: null,
                        p_tenant_id: "fitstn",
                        p_unread_only: false,
                    });

                    if (error) {
                        console.error(`Demand fetch failed for ${agent.name}:`, error.message);
                        return { agent_id: agent.id, agent_name: agent.name, demand_count: 0, error: error.message };
                    }

                    const totalCount = data?.total_count || 0;
                    return { agent_id: agent.id, agent_name: agent.name, demand_count: totalCount };
                } catch (err) {
                    console.error(`Demand fetch error for ${agent.name}:`, err.message);
                    return { agent_id: agent.id, agent_name: agent.name, demand_count: 0, error: err.message };
                }
            })
        );

        res.json(demandResults);
    } catch (err) {
        console.error("GET /api/agent-demand error:", err.message);
        supabaseAuthenticated = false;
        res.status(500).json({ error: "Failed to fetch agent demand", details: err.message });
    }
});

app.post("/api/chat-click", requireAgent, async (req, res) => {
    try {
        const { chatName, chatPreview } = req.body;

        // Close the previous open session for this agent
        const updated = await sql`
            UPDATE sessions SET ended_at = NOW()
            WHERE ended_at IS NULL AND agent_id = ${req.user.id}
            RETURNING id
        `;
        console.log("Closed sessions:", updated.map(r => r.id));

        // Log session_ended events for auto-closed previous sessions
        for (const closed of updated) {
            await sql`
                INSERT INTO activity_events (agent_id, event_type, session_id, metadata)
                VALUES (${req.user.id}, 'session_ended', ${closed.id}, '{"reason": "new_chat_opened"}'::jsonb)
            `;
        }

        const result = await sql`
            INSERT INTO sessions (chat_name, chat_preview, agent_id)
            VALUES (${chatName || null}, ${chatPreview || null}, ${req.user.id})
            RETURNING *
        `;

        // Log session_started event
        await sql`
            INSERT INTO activity_events (agent_id, event_type, session_id)
            VALUES (${req.user.id}, 'session_started', ${result[0].id})
        `;

        res.json({ success: true, data: result[0] });
    } catch (err) {
        console.error("POST /api/chat-click error:", err.message);
        res.status(500).json({ error: "Failed to save chat click", details: err.message });
    }
});

app.post("/api/session-message", requireAgent, async (req, res) => {
    try {
        const text = (req.body.message || "").slice(0, 5000);
        if (!text) return res.status(400).json({ error: "Message text is required" });

        const msgObj = JSON.stringify({ text, sent_at: new Date().toISOString() });
        const updated = await sql`
            UPDATE sessions
            SET messages = COALESCE(messages, '[]'::jsonb) || ${msgObj}::jsonb
            WHERE ended_at IS NULL AND agent_id = ${req.user.id}
            RETURNING id, jsonb_array_length(messages) as message_count
        `;
        if (updated.length === 0) return res.status(404).json({ error: "No active session" });

        // Calculate response time and log message_sent event
        const sessionInfo = await sql`
            SELECT clicked_at, messages FROM sessions WHERE id = ${updated[0].id}
        `;
        const messages = sessionInfo[0].messages || [];
        const messageCount = messages.length;
        let responseTimeSeconds = 0;
        if (messageCount <= 1) {
            responseTimeSeconds = Math.round((Date.now() - new Date(sessionInfo[0].clicked_at).getTime()) / 1000);
        } else {
            const previousMessage = messages[messageCount - 2];
            responseTimeSeconds = Math.round((Date.now() - new Date(previousMessage.sent_at).getTime()) / 1000);
        }

        await sql`
            INSERT INTO activity_events (agent_id, event_type, session_id, metadata)
            VALUES (${req.user.id}, 'message_sent', ${updated[0].id}, ${JSON.stringify({ response_time_seconds: responseTimeSeconds })}::jsonb)
        `;

        res.json({ success: true, session_id: updated[0].id, message_count: updated[0].message_count });
    } catch (err) {
        console.error("POST /api/session-message error:", err.message);
        res.status(500).json({ error: "Failed to save message", details: err.message });
    }
});

app.get("/api/settings", requireAdmin, async (req, res) => {
    try {
        const rows = await sql`SELECT key, value FROM settings`;
        const settings = {};
        for (const row of rows) settings[row.key] = row.value;
        res.json(settings);
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch settings", details: err.message });
    }
});

app.put("/api/settings", requireAdmin, async (req, res) => {
    try {
        const { idle_warning_minutes, idle_critical_minutes, max_session_minutes, idle_inside_session_minutes, session_timeout_minutes, max_shift_hours } = req.body;
        const warning = parseInt(idle_warning_minutes);
        const critical = parseInt(idle_critical_minutes);
        const maxSession = parseInt(max_session_minutes);
        const idleInSession = parseInt(idle_inside_session_minutes);
        const sessionTimeout = parseInt(session_timeout_minutes);
        const maxShiftHours = parseInt(max_shift_hours);
        if (!warning || !critical || warning < 1 || critical < 1 || warning >= critical) {
            return res.status(400).json({ error: "Invalid values. Warning must be less than critical, both must be >= 1." });
        }
        if (!maxSession || maxSession < 1) {
            return res.status(400).json({ error: "Max session duration must be >= 1 minute." });
        }
        if (!idleInSession || idleInSession < 1) {
            return res.status(400).json({ error: "Idle inside session must be >= 1 minute." });
        }
        if (!sessionTimeout || sessionTimeout < 1) {
            return res.status(400).json({ error: "Session timeout must be >= 1 minute." });
        }
        if (!maxShiftHours || maxShiftHours < 1) {
            return res.status(400).json({ error: "Max shift hours must be >= 1." });
        }

        const settingsToSave = {
            idle_warning_minutes: String(warning),
            idle_critical_minutes: String(critical),
            max_session_minutes: String(maxSession),
            idle_inside_session_minutes: String(idleInSession),
            session_timeout_minutes: String(sessionTimeout),
            max_shift_hours: String(maxShiftHours),
        };
        for (const [key, value] of Object.entries(settingsToSave)) {
            await sql`
                INSERT INTO settings (key, value, updated_at) VALUES (${key}, ${value}, NOW())
                ON CONFLICT (key) DO UPDATE SET value = ${value}, updated_at = NOW()
            `;
        }

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: "Failed to save settings", details: err.message });
    }
});

app.post("/api/reset-database", requireAdmin, async (req, res) => {
    try {
        const { confirmation } = req.body;
        if (confirmation !== "RESET ALL DATA") {
            return res.status(400).json({ error: "Type 'RESET ALL DATA' to confirm." });
        }

        // Delete in order to respect foreign key constraints
        await sql`DELETE FROM activity_events`;
        await sql`DELETE FROM shift_breaks`;
        await sql`DELETE FROM sessions`;
        await sql`DELETE FROM shifts`;
        await sql`DELETE FROM salary_deductions`;
        await sql`DELETE FROM salary_overtime`;
        await sql`DELETE FROM salary_records`;

        console.log("Database reset by admin at", new Date().toISOString());
        res.json({ success: true, message: "All operational data has been cleared." });
    } catch (err) {
        console.error("POST /api/reset-database error:", err.message);
        res.status(500).json({ error: "Failed to reset database", details: err.message });
    }
});

app.post("/api/close-session", async (req, res) => {
    try {
        // Support both Authorization header and body token (for sendBeacon on reload)
        let agentId = null;
        const authHeader = req.headers.authorization;
        const bodyToken = req.body?._token;
        const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : bodyToken;

        if (!token) return res.status(401).json({ error: "No token provided" });

        const rows = await sql`
            SELECT t.user_id FROM auth_tokens t
            JOIN agents a ON t.user_id = a.id
            WHERE t.token = ${token} AND t.user_type = 'agent' AND t.expires_at > NOW() AND a.is_active = true
        `;
        if (rows.length === 0) return res.status(401).json({ error: "Invalid or expired token" });
        agentId = rows[0].user_id;

        const updated = await sql`
            UPDATE sessions SET ended_at = NOW()
            WHERE ended_at IS NULL AND agent_id = ${agentId}
            RETURNING id
        `;
        // Log session_ended events
        for (const closed of updated) {
            await sql`
                INSERT INTO activity_events (agent_id, event_type, session_id, metadata)
                VALUES (${agentId}, 'session_ended', ${closed.id}, '{"reason": "manual_close"}'::jsonb)
            `;
        }

        console.log("Tab closed - closed sessions:", updated.map(r => r.id));
        res.json({ success: true, closed: updated.length });
    } catch (err) {
        res.status(500).json({ error: "Failed to close session", details: err.message });
    }
});

app.listen(PORT, async () => {
    try {
        await sql`SELECT 1`;
        console.log("Connected to PostgreSQL database: fitstnflexcoach");

        // Create tables if they don't exist
        await sql`
            CREATE TABLE IF NOT EXISTS admins (
                id SERIAL PRIMARY KEY,
                email VARCHAR(255) UNIQUE NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                created_at TIMESTAMP DEFAULT NOW()
            )
        `;
        await sql`
            CREATE TABLE IF NOT EXISTS agents (
                id SERIAL PRIMARY KEY,
                email VARCHAR(255) UNIQUE NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                name VARCHAR(255),
                is_active BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW()
            )
        `;
        await sql`
            CREATE TABLE IF NOT EXISTS auth_tokens (
                id SERIAL PRIMARY KEY,
                token VARCHAR(64) UNIQUE NOT NULL,
                user_type VARCHAR(10) NOT NULL,
                user_id INTEGER NOT NULL,
                created_at TIMESTAMP DEFAULT NOW(),
                expires_at TIMESTAMP NOT NULL
            )
        `;

        await sql`
            CREATE TABLE IF NOT EXISTS shifts (
                id SERIAL PRIMARY KEY,
                agent_id INTEGER NOT NULL REFERENCES agents(id),
                shift_started_at TIMESTAMP NOT NULL DEFAULT NOW(),
                shift_ended_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT NOW()
            )
        `;

        await sql`
            CREATE TABLE IF NOT EXISTS shift_breaks (
                id SERIAL PRIMARY KEY,
                shift_id INTEGER NOT NULL REFERENCES shifts(id),
                agent_id INTEGER NOT NULL REFERENCES agents(id),
                started_at TIMESTAMP NOT NULL DEFAULT NOW(),
                ended_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT NOW()
            )
        `;

        await sql`
            CREATE TABLE IF NOT EXISTS settings (
                key VARCHAR(100) PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TIMESTAMP DEFAULT NOW()
            )
        `;

        // Seed default settings
        await sql`
            INSERT INTO settings (key, value)
            VALUES
                ('idle_warning_minutes', '5'),
                ('idle_critical_minutes', '10'),
                ('max_session_minutes', '30'),
                ('idle_inside_session_minutes', '2'),
                ('session_timeout_minutes', '10'),
                ('max_shift_hours', '14')
            ON CONFLICT (key) DO NOTHING
        `;

        // Agent salary definition
        await sql`
            CREATE TABLE IF NOT EXISTS agent_salaries (
                id SERIAL PRIMARY KEY,
                agent_id INTEGER NOT NULL UNIQUE REFERENCES agents(id),
                basic_salary DECIMAL(10,2) NOT NULL DEFAULT 0,
                bonus DECIMAL(10,2) NOT NULL DEFAULT 0,
                calculate_on_base BOOLEAN NOT NULL DEFAULT TRUE,
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW()
            )
        `;

        // Named deductions per agent (percentage or fixed)
        await sql`
            CREATE TABLE IF NOT EXISTS salary_deductions (
                id SERIAL PRIMARY KEY,
                agent_id INTEGER NOT NULL REFERENCES agents(id),
                name VARCHAR(100) NOT NULL,
                type VARCHAR(20) NOT NULL DEFAULT 'fixed',
                value DECIMAL(10,2) NOT NULL DEFAULT 0,
                is_active BOOLEAN NOT NULL DEFAULT TRUE,
                created_at TIMESTAMP DEFAULT NOW()
            )
        `;

        // Overtime entries per agent per month
        await sql`
            CREATE TABLE IF NOT EXISTS salary_overtime (
                id SERIAL PRIMARY KEY,
                agent_id INTEGER NOT NULL REFERENCES agents(id),
                month VARCHAR(7) NOT NULL,
                type VARCHAR(10) NOT NULL DEFAULT 'hours',
                hours DECIMAL(6,2) NOT NULL DEFAULT 0,
                rate_per_hour DECIMAL(10,2) NOT NULL DEFAULT 0,
                note TEXT,
                created_at TIMESTAMP DEFAULT NOW()
            )
        `;

        // Monthly payslip snapshots
        await sql`
            CREATE TABLE IF NOT EXISTS salary_records (
                id SERIAL PRIMARY KEY,
                agent_id INTEGER NOT NULL REFERENCES agents(id),
                month VARCHAR(7) NOT NULL,
                basic_salary DECIMAL(10,2) NOT NULL DEFAULT 0,
                bonus DECIMAL(10,2) NOT NULL DEFAULT 0,
                total_deductions DECIMAL(10,2) NOT NULL DEFAULT 0,
                total_overtime DECIMAL(10,2) NOT NULL DEFAULT 0,
                net_salary DECIMAL(10,2) NOT NULL DEFAULT 0,
                details JSONB DEFAULT '{}',
                created_at TIMESTAMP DEFAULT NOW()
            )
        `;

        await sql`
            CREATE TABLE IF NOT EXISTS sessions (
                id SERIAL PRIMARY KEY,
                chat_name VARCHAR(255),
                chat_preview TEXT,
                agent_id INTEGER REFERENCES agents(id),
                clicked_at TIMESTAMP NOT NULL DEFAULT NOW(),
                ended_at TIMESTAMP,
                messages JSONB DEFAULT '[]',
                created_at TIMESTAMP DEFAULT NOW()
            )
        `;

        // Activity events — granular per-action tracking
        await sql`
            CREATE TABLE IF NOT EXISTS activity_events (
                id SERIAL PRIMARY KEY,
                agent_id INTEGER NOT NULL REFERENCES agents(id),
                event_type VARCHAR(30) NOT NULL,
                session_id INTEGER REFERENCES sessions(id),
                shift_id INTEGER REFERENCES shifts(id),
                metadata JSONB DEFAULT '{}',
                created_at TIMESTAMP NOT NULL DEFAULT NOW()
            )
        `;
        await sql`
            CREATE INDEX IF NOT EXISTS idx_activity_events_agent_created
            ON activity_events (agent_id, created_at DESC)
        `;

        // Prevent duplicate active shifts per agent (race condition safety net)
        await sql`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_shift_per_agent
            ON shifts (agent_id) WHERE shift_ended_at IS NULL
        `;

        // Prevent duplicate active breaks per shift (race condition safety net)
        await sql`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_break_per_shift
            ON shift_breaks (shift_id) WHERE ended_at IS NULL
        `;

        // Add type column to salary_overtime if it doesn't exist
        await sql`ALTER TABLE salary_overtime ADD COLUMN IF NOT EXISTS type VARCHAR(10) NOT NULL DEFAULT 'hours'`;

        // Add agent_id column to sessions if it doesn't exist
        await sql`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS agent_id INTEGER REFERENCES agents(id)`;

        // Add messages column to sessions if it doesn't exist
        await sql`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS messages JSONB DEFAULT '[]'`;

        // Add fitstn_id column to agents (links to Supabase staff UUID)
        await sql`ALTER TABLE agents ADD COLUMN IF NOT EXISTS fitstn_id VARCHAR(100)`;

        // Seed default admin
        const existingAdmin = await sql`SELECT id FROM admins WHERE email = 'admin@fitstn.com'`;
        if (existingAdmin.length === 0) {
            const hash = await bcrypt.hash("admin123", 10);
            await sql`INSERT INTO admins (email, password_hash) VALUES ('admin@fitstn.com', ${hash})`;
            console.log("Default admin user created (admin@fitstn.com / admin123)");
        }

        // Clean up expired tokens
        await sql`DELETE FROM auth_tokens WHERE expires_at < NOW()`;

        // Backfill old sessions: set ended_at to the next session's clicked_at
        await sql`
            UPDATE sessions s
            SET ended_at = (
                SELECT s2.clicked_at FROM sessions s2
                WHERE s2.clicked_at > s.clicked_at
                ORDER BY s2.clicked_at ASC LIMIT 1
            )
            WHERE s.ended_at IS NULL
            AND EXISTS (
                SELECT 1 FROM sessions s2 WHERE s2.clicked_at > s.clicked_at
            )
        `;
        // Start periodic session timeout check (every 60 seconds)
        const SESSION_TIMEOUT_CHECK_MS = 60 * 1000;
        setInterval(checkSessionTimeouts, SESSION_TIMEOUT_CHECK_MS);

        // Start periodic shift auto-timeout check (every 5 minutes)
        const SHIFT_TIMEOUT_CHECK_MS = 5 * 60 * 1000;
        setInterval(checkShiftTimeouts, SHIFT_TIMEOUT_CHECK_MS);

        console.log("Database schema ready.");
    } catch (err) {
        console.error("Failed to connect to database:", err.message);
    }
    console.log(`Server running on http://localhost:${PORT}`);
});

async function checkSessionTimeouts() {
    try {
        const timeoutSetting = await sql`
            SELECT value FROM settings WHERE key = 'session_timeout_minutes'
        `;
        const timeoutMinutes = parseInt(timeoutSetting[0]?.value) || 10;

        // Find sessions with no activity past the timeout threshold
        const timeoutInterval = timeoutMinutes + " minutes";
        const staleSessions = await sql`
            SELECT s.id, s.agent_id
            FROM sessions s
            WHERE s.ended_at IS NULL
            AND (
                CASE
                    WHEN jsonb_array_length(COALESCE(s.messages, '[]'::jsonb)) > 0
                    THEN (s.messages->-1->>'sent_at')::timestamptz < NOW() - ${timeoutInterval}::interval
                    ELSE s.clicked_at < NOW() - ${timeoutInterval}::interval
                END
            )
        `;

        for (const session of staleSessions) {
            await sql`UPDATE sessions SET ended_at = NOW() WHERE id = ${session.id}`;
            await sql`
                INSERT INTO activity_events (agent_id, event_type, session_id, metadata)
                VALUES (${session.agent_id}, 'session_ended', ${session.id}, '{"reason": "auto_timeout"}'::jsonb)
            `;
        }

        if (staleSessions.length > 0) {
            console.log(`Auto-closed ${staleSessions.length} timed-out session(s)`);
        }
    } catch (err) {
        console.error("Session timeout check failed:", err.message);
    }
}

async function checkShiftTimeouts() {
    try {
        const maxHoursSetting = await sql`
            SELECT value FROM settings WHERE key = 'max_shift_hours'
        `;
        const maxHours = parseInt(maxHoursSetting[0]?.value) || 14;
        const timeoutInterval = maxHours + " hours";

        const staleShifts = await sql`
            SELECT id, agent_id FROM shifts
            WHERE shift_ended_at IS NULL
            AND shift_started_at < NOW() - ${timeoutInterval}::interval
        `;

        for (const shift of staleShifts) {
            // Close any open breaks
            await sql`
                UPDATE shift_breaks SET ended_at = NOW()
                WHERE shift_id = ${shift.id} AND ended_at IS NULL
            `;
            // Close any open sessions
            const openSessions = await sql`
                SELECT id FROM sessions
                WHERE agent_id = ${shift.agent_id} AND ended_at IS NULL
            `;
            for (const session of openSessions) {
                await sql`UPDATE sessions SET ended_at = NOW() WHERE id = ${session.id}`;
                await sql`
                    INSERT INTO activity_events (agent_id, event_type, session_id, metadata)
                    VALUES (${shift.agent_id}, 'session_ended', ${session.id}, '{"reason": "shift_auto_timeout"}'::jsonb)
                `;
            }
            // End the shift
            await sql`UPDATE shifts SET shift_ended_at = NOW() WHERE id = ${shift.id}`;
            await sql`
                INSERT INTO activity_events (agent_id, event_type, metadata)
                VALUES (${shift.agent_id}, 'shift_ended', '{"reason": "auto_timeout"}'::jsonb)
            `;
        }

        if (staleShifts.length > 0) {
            console.log(`Auto-closed ${staleShifts.length} timed-out shift(s)`);
        }
    } catch (err) {
        console.error("Shift timeout check failed:", err.message);
    }
}

function formatLocalDate(d) {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

function getDateRange(period, dateStr) {
    const date = new Date(dateStr + "T00:00:00");

    if (period === "day") {
        return { startDate: dateStr, endDate: dateStr };
    }

    if (period === "week") {
        const dayOfWeek = date.getDay();
        const weekStart = new Date(date);
        weekStart.setDate(date.getDate() - dayOfWeek);
        const weekEnd = new Date(weekStart);
        weekEnd.setDate(weekStart.getDate() + 6);
        return {
            startDate: formatLocalDate(weekStart),
            endDate: formatLocalDate(weekEnd),
        };
    }

    // month (default)
    const year = date.getFullYear();
    const month = date.getMonth();
    return {
        startDate: formatLocalDate(new Date(year, month, 1)),
        endDate: formatLocalDate(new Date(year, month + 1, 0)),
    };
}
