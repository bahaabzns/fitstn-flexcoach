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
                ) AS shift_active_seconds
            FROM agents a
            WHERE a.is_active = true
            ORDER BY
                (EXISTS (SELECT 1 FROM shifts sh WHERE sh.agent_id = a.id AND sh.shift_ended_at IS NULL)) DESC,
                a.name ASC
        `;
        const rows = result.map(row => {
            const onShift = !!row.shift_id;
            const hasActiveChat = !!row.current_session_id;
            let status, idle_since = null;

            if (!onShift) {
                status = "off_shift";
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
                shift_idle_seconds = Math.max(0, shiftSec - (row.shift_active_seconds || 0));
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
                ) AS active_seconds
            FROM shifts sh
            LEFT JOIN agents a ON sh.agent_id = a.id
            WHERE sh.shift_started_at >= ${startDate}::date
            AND sh.shift_started_at < ${endDate}::date + INTERVAL '1 day'
            ORDER BY sh.shift_started_at DESC
        `;
        const rows = result.map(row => {
            const shiftEnd = row.shift_ended_at ? new Date(row.shift_ended_at) : new Date();
            const shiftDuration = Math.round((shiftEnd - new Date(row.shift_started_at)) / 1000);
            return {
                ...row,
                duration_seconds: row.shift_ended_at ? shiftDuration : null,
                active_seconds: row.active_seconds || 0,
                idle_seconds: Math.max(0, shiftDuration - (row.active_seconds || 0)),
            };
        });
        res.json({ period: { type: period, start: startDate, end: endDate }, shifts: rows });
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch shifts", details: err.message });
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

        const result = await sql`
            INSERT INTO sessions (chat_name, chat_preview, agent_id)
            VALUES (${chatName || null}, ${chatPreview || null}, ${req.user.id})
            RETURNING *
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
        const { idle_warning_minutes, idle_critical_minutes, max_session_minutes } = req.body;
        const warning = parseInt(idle_warning_minutes);
        const critical = parseInt(idle_critical_minutes);
        const maxSession = parseInt(max_session_minutes);
        if (!warning || !critical || warning < 1 || critical < 1 || warning >= critical) {
            return res.status(400).json({ error: "Invalid values. Warning must be less than critical, both must be >= 1." });
        }
        if (!maxSession || maxSession < 1) {
            return res.status(400).json({ error: "Max session duration must be >= 1 minute." });
        }
        await sql`
            INSERT INTO settings (key, value, updated_at) VALUES ('idle_warning_minutes', ${String(warning)}, NOW())
            ON CONFLICT (key) DO UPDATE SET value = ${String(warning)}, updated_at = NOW()
        `;
        await sql`
            INSERT INTO settings (key, value, updated_at) VALUES ('idle_critical_minutes', ${String(critical)}, NOW())
            ON CONFLICT (key) DO UPDATE SET value = ${String(critical)}, updated_at = NOW()
        `;
        await sql`
            INSERT INTO settings (key, value, updated_at) VALUES ('max_session_minutes', ${String(maxSession)}, NOW())
            ON CONFLICT (key) DO UPDATE SET value = ${String(maxSession)}, updated_at = NOW()
        `;
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: "Failed to save settings", details: err.message });
    }
});

app.post("/api/close-session", requireAgent, async (req, res) => {
    try {
        const updated = await sql`
            UPDATE sessions SET ended_at = NOW()
            WHERE ended_at IS NULL AND agent_id = ${req.user.id}
            RETURNING id
        `;
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
            CREATE TABLE IF NOT EXISTS settings (
                key VARCHAR(100) PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TIMESTAMP DEFAULT NOW()
            )
        `;

        // Seed default settings
        await sql`
            INSERT INTO settings (key, value)
            VALUES ('idle_warning_minutes', '5'), ('idle_critical_minutes', '10'), ('max_session_minutes', '30')
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

        // Add type column to salary_overtime if it doesn't exist
        await sql`ALTER TABLE salary_overtime ADD COLUMN IF NOT EXISTS type VARCHAR(10) NOT NULL DEFAULT 'hours'`;

        // Add agent_id column to sessions if it doesn't exist
        await sql`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS agent_id INTEGER REFERENCES agents(id)`;

        // Add messages column to sessions if it doesn't exist
        await sql`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS messages JSONB DEFAULT '[]'`;

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
        console.log("Database schema ready.");
    } catch (err) {
        console.error("Failed to connect to database:", err.message);
    }
    console.log(`Server running on http://localhost:${PORT}`);
});

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
