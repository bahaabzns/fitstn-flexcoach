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

// Checks if a client's room is in the "waiting for agent" queue
async function checkIfClientWaiting(chatName) {
    const clientCodeMatch = (chatName || "").match(/#(\S+)/);
    const clientCode = clientCodeMatch ? clientCodeMatch[1] : "";
    if (!clientCode) return false;

    try {
        await ensureSupabaseAuth();

        const { data, error } = await supabase.rpc("get_chat_rooms_paginated", {
            p_assigned_staff_id: null,
            p_client_gender: null,
            p_coach_id: null,
            p_ghost_days: null,
            p_ghost_only: false,
            p_last_interaction: null,
            p_last_interaction_from: null,
            p_last_interaction_to: null,
            p_last_message_from: "client",
            p_limit: 1,
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

        if (error) {
            console.warn("checkIfClientWaiting Supabase error:", error.message);
            return false;
        }

        const isWaiting = (data?.total || 0) > 0;
        console.log(`Client ${clientCode} waiting: ${isWaiting}`);
        return isWaiting;
    } catch (err) {
        console.warn("checkIfClientWaiting failed:", err.message);
        return false;
    }
}

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_ROOMS_PER_FETCH = 500; // RPC pagination cap for cutoff-split analysis

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

// Settings cache — avoids querying DB on every status poll
const settingsCache = { data: null, lastFetchedAt: 0 };
const SETTINGS_CACHE_TTL_MS = 60_000; // 1 minute

async function getCachedSettings() {
    const now = Date.now();
    if (settingsCache.data && (now - settingsCache.lastFetchedAt) < SETTINGS_CACHE_TTL_MS) {
        return settingsCache.data;
    }
    const rows = await sql`SELECT key, value FROM settings`;
    const settings = {};
    for (const row of rows) settings[row.key] = row.value;
    settingsCache.data = settings;
    settingsCache.lastFetchedAt = now;
    return settings;
}

function invalidateSettingsCache() {
    settingsCache.data = null;
    settingsCache.lastFetchedAt = 0;
}

// Route modules
const adminAuthRoutes = require("./routes/admin-auth")(sql);
const agentAuthRoutes = require("./routes/agent-auth")(sql, requireAgent);
const agentRoutes = require("./routes/agents")(sql, requireAdmin);
const shiftRoutes = require("./routes/shifts")(sql, requireAgent, getCachedSettings);
const salaryRoutes = require("./routes/salaries")(sql, requireAdmin);
const agentOverviewRoutes = require("./routes/agent-overview")(sql, getCachedSettings);
const activityEventRoutes = require("./routes/activity-events")(sql, requireAgent, requireAdmin);
const staffAssignatorRoutes = require("./routes/staff-assignator")(requireAdmin);
const { computeGapIdle } = require("./utils/shift-utils");

// CORS: restrict to known clients (dev + production + FlexCoach host page for content scripts)
const ALLOWED_ORIGINS = [
    "http://localhost:3000",
    "https://fitstn-flexcoach.onrender.com",
    "https://fitstn.flexcoach.app",
    "chrome-extension://",
];
app.use(cors({
    origin: (origin, callback) => {
        // Allow requests with no origin (server-to-server, curl, chrome extensions)
        if (!origin || ALLOWED_ORIGINS.some(allowed => origin.startsWith(allowed))) {
            callback(null, true);
        } else {
            callback(new Error("Not allowed by CORS"));
        }
    },
    allowedHeaders: ["Content-Type", "Authorization"],
}));
app.use(express.json());
app.use(express.text());
app.use(express.static(path.join(__dirname, "public")));

// Mount auth and CRUD routes
app.use("/api/admin", adminAuthRoutes);
app.use("/api/agent", agentAuthRoutes);
app.use("/api/agents", agentRoutes);
app.use("/api/agent", shiftRoutes);
app.use("/api/salaries", salaryRoutes);
app.use("/api/agent-overview", agentOverviewRoutes);
app.use("/api", activityEventRoutes);
app.use("/api/staff-assignator", staffAssignatorRoutes);

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "login.html"));
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
                (SELECT COUNT(*)::int FROM sessions s WHERE s.agent_id = a.id AND s.clicked_at >= CURRENT_DATE AND s.ended_at IS NOT NULL AND jsonb_array_length(COALESCE(s.messages, '[]'::jsonb)) = 0) AS today_empty_sessions,
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

        // Fetch activity threshold from settings (cached)
        const settings = await getCachedSettings();
        const activityThresholdSeconds = (parseInt(settings.idle_warning_minutes) || 5) * 60;

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
                status = "in_session";
            } else {
                // Determine between_sessions vs idle using activity threshold
                const lastEnded = row.last_session_ended_at ? new Date(row.last_session_ended_at) : null;
                const shiftStart = new Date(row.shift_started_at);
                idle_since = (lastEnded && lastEnded > shiftStart ? lastEnded : shiftStart).toISOString();
                const idleSinceSeconds = Math.round((Date.now() - new Date(idle_since).getTime()) / 1000);
                status = idleSinceSeconds >= activityThresholdSeconds ? "idle" : "between_sessions";
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
                today_empty_sessions: row.today_empty_sessions,
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

        const settings = await getCachedSettings();
        const activityThresholdSeconds = (parseInt(settings.idle_warning_minutes) || 5) * 60;

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

        // Compute gap-based idle per shift using shared utility
        const shiftIds = result.map(r => r.id);
        let idleByShift = {};
        if (shiftIds.length > 0) {
            for (const row of result) {
                const shiftEnd = row.shift_ended_at || new Date();
                const sessions = await sql`
                    SELECT clicked_at, ended_at FROM sessions
                    WHERE agent_id = ${row.agent_id}
                    AND ended_at IS NOT NULL
                    AND clicked_at < ${shiftEnd}
                    AND ended_at > ${row.shift_started_at}
                    ORDER BY clicked_at
                `;
                idleByShift[row.id] = computeGapIdle(row.shift_started_at, shiftEnd, sessions, activityThresholdSeconds);
            }
        }

        const rows = result.map(row => {
            const shiftEnd = row.shift_ended_at ? new Date(row.shift_ended_at) : new Date();
            const shiftDuration = Math.round((shiftEnd - new Date(row.shift_started_at)) / 1000);
            const breakSeconds = row.break_seconds || 0;
            const activeSeconds = row.active_seconds || 0;
            const remainderSeconds = Math.max(0, shiftDuration - activeSeconds - breakSeconds);
            const idleSeconds = Math.min(idleByShift[row.id] || 0, remainderSeconds);
            const offSessionSeconds = Math.max(0, remainderSeconds - idleSeconds);
            return {
                ...row,
                duration_seconds: row.shift_ended_at ? shiftDuration : null,
                active_seconds: activeSeconds,
                break_seconds: breakSeconds,
                idle_seconds: idleSeconds,
                off_session_seconds: offSessionSeconds,
            };
        });
        res.json({ period: { type: period, start: startDate, end: endDate }, shifts: rows });
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch shifts", details: err.message });
    }
});

app.post("/api/shifts", requireAdmin, async (req, res) => {
    try {
        const { agent_id, shift_started_at, shift_ended_at, reason } = req.body;

        if (!agent_id) {
            return res.status(400).json({ error: "Agent is required" });
        }
        if (!shift_started_at) {
            return res.status(400).json({ error: "Start time is required" });
        }
        if (!reason || reason.trim().length < 3) {
            return res.status(400).json({ error: "Reason is required (at least 3 characters)" });
        }

        const agentExists = await sql`SELECT id FROM agents WHERE id = ${agent_id}`;
        if (agentExists.length === 0) {
            return res.status(404).json({ error: "Agent not found" });
        }

        const startDate = new Date(shift_started_at);
        const endDate = shift_ended_at ? new Date(shift_ended_at) : null;
        if (isNaN(startDate.getTime())) {
            return res.status(400).json({ error: "Invalid start time" });
        }
        if (endDate && isNaN(endDate.getTime())) {
            return res.status(400).json({ error: "Invalid end time" });
        }
        if (endDate && endDate <= startDate) {
            return res.status(400).json({ error: "End time must be after start time" });
        }

        const result = await sql`
            INSERT INTO shifts (agent_id, shift_started_at, shift_ended_at)
            VALUES (${agent_id}, ${startDate.toISOString()}, ${endDate ? endDate.toISOString() : null})
            RETURNING *
        `;

        const metadata = JSON.stringify({
            reason: reason.trim(),
            admin_id: req.user.id,
            manual: true,
        });
        await sql`
            INSERT INTO activity_events (agent_id, event_type, shift_id, metadata)
            VALUES (${agent_id}, 'shift_added_manually', ${result[0].id}, ${metadata}::jsonb)
        `;

        res.status(201).json({ success: true, shift: result[0] });
    } catch (err) {
        res.status(500).json({ error: "Failed to create shift", details: err.message });
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
            SELECT s.*, a.email as agent_email, a.name as agent_name,
                jsonb_array_length(COALESCE(s.messages, '[]'::jsonb))::int as message_count
            FROM sessions s
            LEFT JOIN agents a ON s.agent_id = a.id
            WHERE s.clicked_at >= ${startDate}::date
            AND s.clicked_at < ${endDate}::date + INTERVAL '1 day'
            ORDER BY s.clicked_at DESC
        `;
        const rows = result.map(row => {
            const { messages: _msgs, ...rest } = row;
            return {
                ...rest,
                message_count: row.message_count || 0,
                duration_seconds: row.ended_at
                    ? Math.round((new Date(row.ended_at) - new Date(row.clicked_at)) / 1000)
                    : null,
            };
        });
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

        // Fetch per-agent demand + unassigned + global total in parallel
        const rpcParams = (overrides) => ({
            p_assigned_staff_id: null,
            p_client_gender: null,
            p_coach_id: null,
            p_ghost_days: null,
            p_ghost_only: false,
            p_last_interaction: null,
            p_last_interaction_from: null,
            p_last_interaction_to: null,
            p_last_message_from: "client",
            p_limit: 1,
            p_no_assigned_staff: false,
            p_offset: 0,
            p_package_id: null,
            p_search: null,
            p_staff_id: null,
            p_subscription_start_date: null,
            p_subscription_start_weekday: null,
            p_subscription_status: null,
            p_subscription_t_status: null,
            p_tenant_id: "fitstn",
            p_unread_only: false,
            ...overrides,
        });

        const globalPromise = supabase.rpc("get_chat_rooms_paginated", rpcParams({ p_staff_id: agents[0].fitstn_id }));
        const unassignedPromise = supabase.rpc("get_chat_rooms_paginated", rpcParams({ p_no_assigned_staff: true }));

        const agentPromises = agents.map(async (agent) => {
            try {
                const { data, error } = await supabase.rpc("get_chat_rooms_paginated", rpcParams({ p_assigned_staff_id: agent.fitstn_id }));

                if (error) {
                    console.error(`Demand fetch failed for ${agent.name}:`, error.message);
                    return { agent_id: agent.id, agent_name: agent.name, demand_count: 0, error: error.message };
                }

                const totalCount = data?.total || 0;
                return { agent_id: agent.id, agent_name: agent.name, demand_count: totalCount };
            } catch (err) {
                console.error(`Demand fetch error for ${agent.name}:`, err.message);
                return { agent_id: agent.id, agent_name: agent.name, demand_count: 0, error: err.message };
            }
        });

        const [globalResult, unassignedResult, ...demandResults] = await Promise.all([globalPromise, unassignedPromise, ...agentPromises]);

        const globalTotal = globalResult.data?.total || 0;
        const unassignedCount = unassignedResult.data?.total || 0;
        const agentTotal = demandResults.reduce((sum, d) => sum + d.demand_count, 0);
        const otherStaffCount = Math.max(0, globalTotal - agentTotal - unassignedCount);

        res.json({ agents: demandResults, unassigned_count: unassignedCount, other_staff_count: otherStaffCount, global_total: globalTotal });
    } catch (err) {
        console.error("GET /api/agent-demand error:", err.message);
        supabaseAuthenticated = false;
        res.status(500).json({ error: "Failed to fetch agent demand", details: err.message });
    }
});

app.get("/api/agent-workload", requireAdmin, async (req, res) => {
    try {
        const [avgMinRow] = await sql`SELECT value FROM settings WHERE key = 'avg_minutes_per_chat'`;
        const avgMinutesPerChat = parseInt(avgMinRow?.value) || 10;
        const { slaCutoffTime, cutH, cutM, isPastCutoff } = await getSlaCutoffStatus();

        const agents = await sql`
            SELECT id, name, fitstn_id, shift_end_time
            FROM agents
            WHERE is_active = true AND fitstn_id IS NOT NULL AND fitstn_id != ''
        `;

        if (agents.length === 0) {
            return res.json({ agents: [], sla_cutoff_time: slaCutoffTime, avg_minutes_per_chat: avgMinutesPerChat });
        }

        await ensureSupabaseAuth();

        // Fetch today's + yesterday's snapshots
        const today = formatLocalDate(new Date());
        const yesterdayDate = new Date();
        yesterdayDate.setDate(yesterdayDate.getDate() - 1);
        const yesterday = formatLocalDate(yesterdayDate);

        const snapshotRows = await sql`
            SELECT snapshot_date::text, agent_id, demand_count, cutoff_demand_count
            FROM demand_snapshots
            WHERE snapshot_date IN (${today}::date, ${yesterday}::date)
        `;
        const dailyDemandByAgent = {};
        const cutoffDemandByAgent = {};
        const yesterdayDemandByAgent = {};
        for (const row of snapshotRows) {
            const dateStr = row.snapshot_date.slice(0, 10);
            if (dateStr === today) {
                dailyDemandByAgent[row.agent_id] = row.demand_count;
                cutoffDemandByAgent[row.agent_id] = row.cutoff_demand_count;
            } else {
                yesterdayDemandByAgent[row.agent_id] = row.demand_count;
            }
        }

        const now = new Date();

        const rpcParams = (overrides) => ({
            p_assigned_staff_id: null,
            p_client_gender: null,
            p_coach_id: null,
            p_ghost_days: null,
            p_ghost_only: false,
            p_last_interaction: "today",
            p_last_interaction_from: null,
            p_last_interaction_to: null,
            p_last_message_from: "client",
            p_limit: 1,
            p_no_assigned_staff: false,
            p_offset: 0,
            p_package_id: null,
            p_search: null,
            p_staff_id: null,
            p_subscription_start_date: null,
            p_subscription_start_weekday: null,
            p_subscription_status: null,
            p_subscription_t_status: null,
            p_tenant_id: "fitstn",
            p_unread_only: false,
            ...overrides,
        });

        const maxChatsPerHour = 60 / avgMinutesPerChat;

        // Build cutoff timestamp for today to split pending rooms
        const cutoffToday = new Date(now);
        cutoffToday.setHours(cutH, cutM, 0, 0);

        const agentPromises = agents.map(async (agent) => {
            try {
                // Fetch with high limit to get room details for cutoff split
                const { data, error } = await supabase.rpc("get_chat_rooms_paginated", rpcParams({ p_assigned_staff_id: agent.fitstn_id, p_limit: MAX_ROOMS_PER_FETCH }));

                if (error) {
                    console.error(`Workload fetch failed for ${agent.name}:`, error.message);
                    return { agent_id: agent.id, agent_name: agent.name, pending_count: 0, daily_demand: 0, error: error.message };
                }

                const pendingCount = data?.total || 0;
                const rooms = data?.rooms || [];

                // Split pending by cutoff: rooms array may include handled rooms, so cap at pendingCount
                let pendingBeforeCutoff = pendingCount;
                let pendingAfterCutoff = 0;
                let oldestBeforeCutoff = null;
                if (isPastCutoff && rooms.length > 0) {
                    const beforeCutoffRooms = [];
                    let afterCount = 0;
                    for (const r of rooms) {
                        const msgTime = r.last_client_message_at ? new Date(r.last_client_message_at) : null;
                        if (msgTime && msgTime >= cutoffToday) {
                            afterCount++;
                        } else {
                            beforeCutoffRooms.push(r);
                        }
                    }
                    // Cap: rooms includes handled + pending, but total is pending-only
                    pendingAfterCutoff = Math.min(afterCount, pendingCount);
                    pendingBeforeCutoff = pendingCount - pendingAfterCutoff;
                    // Find oldest last_client_message_at among before-cutoff rooms
                    for (const r of beforeCutoffRooms) {
                        const t = r.last_client_message_at ? new Date(r.last_client_message_at) : null;
                        if (t && (!oldestBeforeCutoff || t < oldestBeforeCutoff)) oldestBeforeCutoff = t;
                    }
                } else if (rooms.length > 0) {
                    // Before cutoff time — all rooms are "before cutoff", find oldest
                    for (const r of rooms) {
                        const t = r.last_client_message_at ? new Date(r.last_client_message_at) : null;
                        if (t && (!oldestBeforeCutoff || t < oldestBeforeCutoff)) oldestBeforeCutoff = t;
                    }
                }

                const dailyDemand = dailyDemandByAgent[agent.id] || 0;
                const yesterdayDemand = yesterdayDemandByAgent[agent.id] || 0;
                const cutoffDemand = cutoffDemandByAgent[agent.id];
                const tomorrowDemand = (isPastCutoff && cutoffDemand != null) ? Math.max(0, dailyDemand - cutoffDemand) : null;
                const handledCount = Math.max(0, dailyDemand - pendingCount);
                const completionPct = dailyDemand > 0 ? Math.round((handledCount / dailyDemand) * 100) : 100;

                // Hours remaining until this agent's shift ends
                const shiftEnd = agent.shift_end_time || '19:00';
                const [seh, sem] = shiftEnd.split(':').map(Number);
                const shiftEndToday = new Date(now);
                shiftEndToday.setHours(seh, sem, 0, 0);
                const hoursLeft = Math.max(0, (shiftEndToday - now) / (1000 * 60 * 60));
                const isPastShiftEnd = hoursLeft === 0;

                const requiredPace = isPastShiftEnd ? pendingCount : (hoursLeft > 0 ? pendingCount / hoursLeft : 0);
                const workloadRatio = maxChatsPerHour > 0 ? requiredPace / maxChatsPerHour : 0;

                let status = 'comfortable';
                if (isPastShiftEnd && pendingCount > 0) status = 'overloaded';
                else if (workloadRatio > 1) status = 'overloaded';
                else if (workloadRatio > 0.7) status = 'busy';

                return {
                    agent_id: agent.id,
                    agent_name: agent.name,
                    yesterday_demand: yesterdayDemand,
                    daily_demand: dailyDemand,
                    tomorrow_demand: tomorrowDemand,
                    pending_count: pendingCount,
                    pending_before_cutoff: pendingBeforeCutoff,
                    pending_after_cutoff: isPastCutoff ? pendingAfterCutoff : null,
                    oldest_pending_at: oldestBeforeCutoff ? oldestBeforeCutoff.toISOString() : null,
                    handled_count: handledCount,
                    completion_pct: completionPct,
                    required_pace: Math.round(requiredPace * 10) / 10,
                    workload_ratio: Math.round(workloadRatio * 100) / 100,
                    hours_remaining: Math.round(hoursLeft * 10) / 10,
                    shift_end_time: shiftEnd,
                    status,
                };
            } catch (err) {
                console.error(`Workload fetch error for ${agent.name}:`, err.message);
                return { agent_id: agent.id, agent_name: agent.name, pending_count: 0, daily_demand: 0, error: err.message };
            }
        });

        const workloadResults = await Promise.all(agentPromises);

        res.json({
            agents: workloadResults,
            sla_cutoff_time: slaCutoffTime,
            is_past_cutoff: isPastCutoff,
            avg_minutes_per_chat: avgMinutesPerChat,
            max_chats_per_hour: maxChatsPerHour,
        });
    } catch (err) {
        console.error("GET /api/agent-workload error:", err.message);
        res.status(500).json({ error: "Failed to fetch agent workload", details: err.message });
    }
});

// =====================
// DEMAND SNAPSHOTS
// =====================
async function takeDemandSnapshot() {
    const agents = await sql`
        SELECT id, name, fitstn_id
        FROM agents
        WHERE is_active = true AND fitstn_id IS NOT NULL AND fitstn_id != ''
    `;

    if (agents.length === 0) return { saved: 0, agents: [] };

    const { isPastCutoff } = await getSlaCutoffStatus();

    await ensureSupabaseAuth();

    const rpcParams = (overrides) => ({
        p_assigned_staff_id: null, p_client_gender: null, p_coach_id: null,
        p_ghost_days: null, p_ghost_only: false, p_last_interaction: "today",
        p_last_interaction_from: null, p_last_interaction_to: null,
        p_last_message_from: null, p_limit: 1, p_no_assigned_staff: false,
        p_offset: 0, p_package_id: null, p_search: null, p_staff_id: null,
        p_subscription_start_date: null, p_subscription_start_weekday: null,
        p_subscription_status: null, p_subscription_t_status: null,
        p_tenant_id: "fitstn", p_unread_only: false,
        ...overrides,
    });

    const today = formatLocalDate(new Date());
    const results = [];

    for (const agent of agents) {
        try {
            const { data, error } = await supabase.rpc("get_chat_rooms_paginated", rpcParams({ p_assigned_staff_id: agent.fitstn_id }));
            const demandCount = error ? 0 : (data?.total || 0);

            await sql`
                INSERT INTO demand_snapshots (snapshot_date, agent_id, agent_name, demand_count, cutoff_demand_count)
                VALUES (${today}, ${agent.id}, ${agent.name}, ${demandCount}, ${isPastCutoff ? demandCount : null})
                ON CONFLICT (snapshot_date, agent_id)
                DO UPDATE SET
                    demand_count = ${demandCount},
                    agent_name = ${agent.name},
                    cutoff_demand_count = COALESCE(demand_snapshots.cutoff_demand_count, EXCLUDED.cutoff_demand_count),
                    created_at = NOW()
            `;

            results.push({ agent_id: agent.id, agent_name: agent.name, demand_count: demandCount });
        } catch (err) {
            console.error(`Snapshot failed for ${agent.name}:`, err.message);
            results.push({ agent_id: agent.id, agent_name: agent.name, demand_count: 0, error: err.message });
        }
    }

    return { saved: results.length, snapshot_date: today, agents: results };
}

app.post("/api/demand-snapshot", requireAdmin, async (req, res) => {
    try {
        const result = await takeDemandSnapshot();
        res.json(result);
    } catch (err) {
        console.error("POST /api/demand-snapshot error:", err.message);
        supabaseAuthenticated = false;
        res.status(500).json({ error: "Failed to take demand snapshot", details: err.message });
    }
});

app.get("/api/demand-history", requireAdmin, async (req, res) => {
    try {
        const { days } = req.query;
        const lookbackDays = Math.min(Math.max(parseInt(days) || 30, 1), 365);

        const startDate = new Date();
        startDate.setDate(startDate.getDate() - lookbackDays);
        const startDateStr = formatLocalDate(startDate);

        const rows = await sql`
            SELECT snapshot_date::text, agent_id, agent_name, demand_count
            FROM demand_snapshots
            WHERE snapshot_date >= ${startDateStr}::date
            ORDER BY snapshot_date ASC, agent_name ASC
        `;

        res.json({ days: lookbackDays, snapshots: rows });
    } catch (err) {
        console.error("GET /api/demand-history error:", err.message);
        res.status(500).json({ error: "Failed to fetch demand history", details: err.message });
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

        // Check if client was waiting (= client-initiated session)
        const isClientInitiated = await checkIfClientWaiting(chatName);

        const result = await sql`
            INSERT INTO sessions (chat_name, chat_preview, agent_id, is_client_initiated)
            VALUES (${chatName || null}, ${chatPreview || null}, ${req.user.id}, ${isClientInitiated})
            RETURNING *
        `;

        // Log session_started event
        await sql`
            INSERT INTO activity_events (agent_id, event_type, session_id, metadata)
            VALUES (${req.user.id}, 'session_started', ${result[0].id}, ${JSON.stringify({ is_client_initiated: isClientInitiated })}::jsonb)
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
        const { idle_warning_minutes, idle_critical_minutes, max_session_minutes, idle_inside_session_minutes, session_timeout_minutes, max_shift_hours, avg_minutes_per_chat, sla_cutoff_time } = req.body;
        const warning = parseInt(idle_warning_minutes);
        const critical = parseInt(idle_critical_minutes);
        const maxSession = parseInt(max_session_minutes);
        const idleInSession = parseInt(idle_inside_session_minutes);
        const sessionTimeout = parseInt(session_timeout_minutes);
        const maxShiftHours = parseInt(max_shift_hours);
        const avgMinutesPerChat = parseInt(avg_minutes_per_chat);
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
        if (!avgMinutesPerChat || avgMinutesPerChat < 1) {
            return res.status(400).json({ error: "Avg minutes per chat must be >= 1." });
        }
        if (!sla_cutoff_time || !/^\d{2}:\d{2}$/.test(sla_cutoff_time)) {
            return res.status(400).json({ error: "SLA cutoff time must be in HH:MM format." });
        }

        const settingsToSave = {
            idle_warning_minutes: String(warning),
            idle_critical_minutes: String(critical),
            max_session_minutes: String(maxSession),
            idle_inside_session_minutes: String(idleInSession),
            session_timeout_minutes: String(sessionTimeout),
            max_shift_hours: String(maxShiftHours),
            avg_minutes_per_chat: String(avgMinutesPerChat),
            sla_cutoff_time: sla_cutoff_time,
        };
        for (const [key, value] of Object.entries(settingsToSave)) {
            await sql`
                INSERT INTO settings (key, value, updated_at) VALUES (${key}, ${value}, NOW())
                ON CONFLICT (key) DO UPDATE SET value = ${value}, updated_at = NOW()
            `;
        }

        invalidateSettingsCache();

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
                ('max_shift_hours', '14'),
                ('avg_minutes_per_chat', '10'),
                ('sla_cutoff_time', '14:00')
            ON CONFLICT (key) DO NOTHING
        `;

        // Daily demand snapshots for historical tracking
        await sql`
            CREATE TABLE IF NOT EXISTS demand_snapshots (
                id SERIAL PRIMARY KEY,
                snapshot_date DATE NOT NULL,
                agent_id INTEGER NOT NULL REFERENCES agents(id),
                agent_name VARCHAR(255) NOT NULL,
                demand_count INTEGER NOT NULL DEFAULT 0,
                created_at TIMESTAMP DEFAULT NOW(),
                UNIQUE(snapshot_date, agent_id)
            )
        `;
        await sql`ALTER TABLE demand_snapshots ADD COLUMN IF NOT EXISTS cutoff_demand_count INTEGER DEFAULT NULL`;

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

        // Add working hours and SLA columns to agents
        await sql`ALTER TABLE agents ADD COLUMN IF NOT EXISTS shift_start_time TIME`;
        await sql`ALTER TABLE agents ADD COLUMN IF NOT EXISTS shift_end_time TIME`;
        await sql`ALTER TABLE agents ADD COLUMN IF NOT EXISTS sla_cutoff_time TIME`;

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

        // Demand snapshot — runs every hour, always updates today's count
        const SNAPSHOT_INTERVAL_MS = 60 * 60 * 1000;
        setInterval(async () => {
            try {
                console.log("Taking hourly demand snapshot...");
                const result = await takeDemandSnapshot();
                console.log(`Demand snapshot updated: ${result.saved} agents for ${result.snapshot_date}`);
            } catch (err) {
                console.error("Auto demand snapshot failed:", err.message);
            }
        }, SNAPSHOT_INTERVAL_MS);

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

async function getSlaCutoffStatus() {
    const rows = await sql`SELECT value FROM settings WHERE key = 'sla_cutoff_time'`;
    const slaCutoffTime = rows[0]?.value || '18:00';
    const [cutH, cutM] = slaCutoffTime.split(':').map(Number);
    const now = new Date();
    const isPastCutoff = now.getHours() > cutH || (now.getHours() === cutH && now.getMinutes() >= cutM);
    return { slaCutoffTime, cutH, cutM, isPastCutoff };
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
