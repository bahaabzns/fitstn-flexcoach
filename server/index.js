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
// Returns "client" or "staff" — whichever side sent the last message in this chat
async function fetchLastMessageSide(chatName) {
    const clientCodeMatch = (chatName || "").match(/#(\S+)/);
    const clientCode = clientCodeMatch ? clientCodeMatch[1] : "";
    if (!clientCode) return null;

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
            console.warn("fetchLastMessageSide Supabase error:", error.message);
            return null;
        }

        const side = (data?.total || 0) > 0 ? "client" : "staff";
        console.log(`Client ${clientCode} last message from: ${side}`);
        return side;
    } catch (err) {
        console.warn("fetchLastMessageSide failed:", err.message);
        return null;
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
const demandReportRoutes = require("./routes/demand-report")(sql, supabase, ensureSupabaseAuth, requireAdmin);
const alertRoutes         = require("./routes/alerts")(sql, requireAdmin);
const planningRoutes      = require("./routes/planning")(sql, requireAdmin);
const { computeGapIdle } = require("./utils/shift-utils");

// SSE — broadcast is exported so QueueEngine (and future engines) can push updates
const sseModule   = require("./routes/sse");
const sseRoutes   = sseModule(sql, requireAdmin);
const { broadcast } = sseModule;

// Queue engine — instantiated here so it can be started after DB init
const QueueEngine = require("./services/queue-engine");
const queueEngine = new QueueEngine({ sql, supabase, ensureSupabaseAuth, broadcast });

// Presence service — authoritative multi-signal agent presence (fixes D1)
const { PresenceService, isEffectivelyOnShift, isAvailable } = require("./services/presence");
const presenceService = new PresenceService({ sql });

// SLA + Alert engines — depend on queueEngine, started after DB is ready
const SlaEngine          = require("./services/sla-engine");
const AlertEngine        = require("./services/alert-engine");
const { ForecastingService } = require("./services/forecasting");
const ExpressScheduler   = require("./services/express-scheduler");
const slaEngine          = new SlaEngine({ sql, supabase, ensureSupabaseAuth, queueEngine, broadcast });
const alertEngine        = new AlertEngine({ sql, queueEngine, slaEngine, presenceService, broadcast });
const forecastingService = new ForecastingService({ sql });
const expressScheduler   = new ExpressScheduler({ sql, supabase, ensureSupabaseAuth, broadcast });

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
app.use("/api", demandReportRoutes);
app.use("/api", alertRoutes);
app.use("/api", planningRoutes);
app.use("/api", sseRoutes);

// Returns the current in-memory queue state built by QueueEngine
app.get("/api/queue-state", requireAdmin, (req, res) => {
    res.json(queueEngine.getState());
});

// Live queue room drilldown — sortable, filterable view of live_queue_rooms.
// In-memory fast path; falls back to DB when cache is cold.
app.get("/api/queue/rooms", requireAdmin, async (req, res) => {
    try {
        const { package: pkgName, state, limit = "200" } = req.query;
        const agentId  = req.query.agent_id ? parseInt(req.query.agent_id) : undefined;
        const limitNum = Math.min(parseInt(limit) || 200, 500);

        const cached = queueEngine.getRooms({ agentId, packageName: pkgName, state, limit: limitNum });
        if (cached.length > 0) {
            const withAge = cached.map(r => ({
                ...r,
                minutes_since_client_msg: Math.round((Date.now() - new Date(r.last_client_msg_at).getTime()) / 60_000),
                minutes_to_deadline: Math.round((new Date(r.sla_deadline_at).getTime() - Date.now()) / 60_000),
            }));
            return res.json({ rooms: withAge, source: "live", total: withAge.length });
        }

        // DB fallback when engine cache is cold
        const agentIdParam  = agentId  ?? null;
        const pkgNameParam  = pkgName  ?? null;
        const stateParam    = state    ?? null;
        const rows = await sql`
            SELECT lqr.room_id, lqr.package_name, lqr.assigned_agent_id,
                   lqr.client_name, lqr.last_client_msg_at, lqr.last_staff_msg_at,
                   lqr.sla_deadline_at, lqr.priority_score, lqr.state,
                   lqr.state_changed_at, lqr.first_seen_at, lqr.updated_at,
                   a.name AS agent_name,
                   EXTRACT(EPOCH FROM (NOW() - lqr.last_client_msg_at)) / 60 AS minutes_since_client_msg,
                   EXTRACT(EPOCH FROM (lqr.sla_deadline_at - NOW())) / 60   AS minutes_to_deadline
            FROM live_queue_rooms lqr
            LEFT JOIN agents a ON lqr.assigned_agent_id = a.id
            WHERE lqr.state <> 'RESOLVED'
              AND (${agentIdParam}::int  IS NULL OR lqr.assigned_agent_id = ${agentIdParam}::int)
              AND (${pkgNameParam}::text IS NULL OR lqr.package_name       = ${pkgNameParam}::text)
              AND (${stateParam}::text   IS NULL OR lqr.state              = ${stateParam}::text)
            ORDER BY lqr.priority_score DESC
            LIMIT ${limitNum}
        `;
        res.json({ rooms: rows, source: "db", total: rows.length });
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch queue rooms", details: err.message });
    }
});

// Ops Score v2 — 6-pillar explainable composite with per-pillar confidence.
// Pillars: SLA Health (40%), Queue Pressure (20%), Staffing Match (15%),
//          Workload Evenness (10%), Premium Risk (10%), Breach Burndown (5%).
app.get("/api/ops-health", requireAdmin, async (req, res) => {
    try {
        const now           = new Date();
        const queueState    = queueEngine.getState();
        const agentPresence = await presenceService.getAll();
        const ttbState      = queueEngine.getTtbState();

        const totalAgents = agentPresence.length;
        const onShift     = agentPresence.filter(a => isEffectivelyOnShift(a.presence)).length;
        const inSession   = agentPresence.filter(a => a.presence === 'IN_SESSION').length;
        const globalTotal = queueState.global_total    || 0;
        const growthRate  = queueState.global_growth_rate || 0;

        // ── Pillar 1: SLA Health (40%) ────────────────────────────────────────
        // 100 - max(0, 95 - min_projected_sla_eod)  [penalises only when below 95% target]
        const slaScores = slaEngine.getScores().filter(s => s.projected_sla_eod != null);
        const slaMinEod = slaScores.length > 0
            ? Math.min(...slaScores.map(s => s.projected_sla_eod)) : 100;
        const slaHealth = Math.max(0, Math.round(100 - Math.max(0, 95 - slaMinEod)));
        const slaConf   = Math.min(1, slaScores.length / 5);  // 5 live packages

        // ── Pillar 2: Queue Pressure (20%) ───────────────────────────────────
        const queueLoad     = Math.min(1, globalTotal / Math.max(onShift * 15, 1));
        const growthPressure = Math.max(0, growthRate * 5);
        const queuePressure = Math.max(0, Math.round(100 - queueLoad * 70 - growthPressure));
        const queueConf     = queueState.capturedAt ? 1.0 : 0.3;

        // ── Pillar 3: Staffing Match (15%) ───────────────────────────────────
        // Required agents estimated from SLA engine agents_needed sum (with floor = onShift)
        const agentsRequired = Math.max(1,
            slaScores.reduce((s, r) => s + (r.agents_needed || 0), 0) || onShift
        );
        const staffingMatch = Math.round(100 * Math.min(1, onShift / agentsRequired));
        const staffingConf  = 0.8;

        // ── Pillar 4: Workload Evenness (10%) ────────────────────────────────
        const capacityConfig = await sql`
            SELECT complexity_weight, avg_handling_minutes, max_concurrent_chats
            FROM agent_capacity_config WHERE is_scheduled_workload = FALSE
        `;
        const totalCfgWeight = capacityConfig.reduce((s, r) => s + parseFloat(r.complexity_weight), 0);
        const weightedCapHr  = totalCfgWeight > 0
            ? capacityConfig.reduce((s, r) => {
                const cap = (60 / parseFloat(r.avg_handling_minutes)) * parseFloat(r.max_concurrent_chats);
                return s + cap * parseFloat(r.complexity_weight) / totalCfgWeight;
            }, 0) : 6;
        const avgComplexity = totalCfgWeight > 0 ? totalCfgWeight / capacityConfig.length : 1.0;
        const byAgentQueue  = Object.fromEntries((queueState.byAgent || []).map(a => [a.agent_id, a]));

        const onShiftRatios = agentPresence
            .filter(a => isEffectivelyOnShift(a.presence))
            .map(a => {
                const pending     = byAgentQueue[a.id]?.pending_count ?? 0;
                const shiftEndDt  = new Date(now);
                shiftEndDt.setHours(19, 0, 0, 0);
                const hoursLeft   = Math.max(0, (shiftEndDt - now) / 3_600_000);
                const pace        = hoursLeft > 0 ? pending / hoursLeft : pending;
                return weightedCapHr > 0 ? (pace * avgComplexity) / weightedCapHr : 0;
            });
        const gini         = computeGini(onShiftRatios);
        const workloadEven = Math.round(100 * (1 - gini));
        const workloadConf = onShiftRatios.length >= 2 ? 1.0 : 0.5;

        // ── Pillar 5: Premium Risk (10%) ─────────────────────────────────────
        let premiumRisk = 100, premiumConf = 0.3;
        const proRooms  = queueEngine.getRooms({ limit: 1000 }).filter(r => r.package_name.includes('Pro'));
        if (proRooms.length > 0) {
            const proSafe = proRooms.filter(r => r.state === 'OPEN').length;
            premiumRisk   = Math.round(100 * proSafe / proRooms.length);
            premiumConf   = 1.0;
        } else if (ttbState) {
            premiumConf = 0.6;  // L3 running but no Pro rooms
        }

        // ── Pillar 6: Breach Burndown (5%) ───────────────────────────────────
        let breachBurndown = 100, breachConf = 0.3;
        if (ttbState) {
            const atRisk30  = ttbState.breaching_now + ttbState.breaching_30m;
            const totalOpen = Math.max(ttbState.total_open, 1);
            breachBurndown  = Math.round(100 * (1 - atRisk30 / totalOpen));
            breachConf      = 1.0;
        }

        // ── Composite OpsScore ────────────────────────────────────────────────
        const pillars = [
            { key: "sla_health",      label: "SLA Health",        value: slaHealth,      weight: 0.40, confidence: slaConf,      explain: `Min projected EOD SLA: ${slaMinEod.toFixed(1)}% (target 95%)` },
            { key: "queue_pressure",  label: "Queue Pressure",    value: queuePressure,  weight: 0.20, confidence: queueConf,    explain: `${globalTotal} pending, growth ${growthRate > 0 ? "+" : ""}${growthRate}/hr` },
            { key: "staffing_match",  label: "Staffing Match",    value: staffingMatch,  weight: 0.15, confidence: staffingConf, explain: `${onShift} on shift, ~${agentsRequired} required` },
            { key: "workload_even",   label: "Workload Evenness", value: workloadEven,   weight: 0.10, confidence: workloadConf, explain: `Gini ${gini.toFixed(3)} (0=perfect, 1=worst)` },
            { key: "premium_risk",    label: "Premium Risk",      value: premiumRisk,    weight: 0.10, confidence: premiumConf,  explain: `${proRooms.filter(r => r.state === 'OPEN').length}/${proRooms.length} Pro rooms safe` },
            { key: "breach_burndown", label: "Breach Burndown",   value: breachBurndown, weight: 0.05, confidence: breachConf,   explain: ttbState ? `${ttbState.breaching_now} breached, ${ttbState.breaching_30m} at risk <30m` : "L2 not yet run" },
        ];

        const rawScore    = Math.round(pillars.reduce((s, p) => s + p.value * p.weight, 0));
        const overallConf = harmonicMean(pillars.map(p => p.confidence));
        const opsScore    = Math.round(rawScore * (0.5 + 0.5 * overallConf));

        // Presence breakdown
        const presenceBreakdown = agentPresence.reduce((acc, a) => {
            acc[a.presence] = (acc[a.presence] || 0) + 1;
            return acc;
        }, {});

        // Persist to ops_score_history (fire-and-forget)
        sql`
            INSERT INTO ops_score_history (computed_at, ops_score, confidence, pillars)
            VALUES (NOW(), ${opsScore}, ${Math.round(overallConf * 1000) / 1000}, ${JSON.stringify(pillars)}::jsonb)
        `.catch(err => console.error('ops_score_history write:', err.message));

        res.json({
            opsScore,
            confidence: Math.round(overallConf * 100) / 100,
            pillars,
            components: {
                // v2 names
                slaHealth, queuePressure, staffingMatch, workloadEven, premiumRisk, breachBurndown,
                // legacy aliases for backward-compat
                queueHealth:    queuePressure,
                staffingHealth: staffingMatch,
                loadHealth:     workloadEven,
            },
            summary: {
                agentsOnShift:   onShift,
                agentsInSession: inSession,
                agentsTotal:     totalAgents,
                queueTotal:      globalTotal,
                queueGrowthRate: growthRate,
            },
            presenceBreakdown,
            ttb: ttbState,
        });
    } catch (err) {
        res.status(500).json({ error: "Failed to compute ops health", details: err.message });
    }
});

// Current SLA risk scores — returns in-memory scores from SlaEngine (instant),
// falls back to DB latest if engine hasn't run yet this session
app.get("/api/sla-risk", requireAdmin, async (req, res) => {
    try {
        const live = slaEngine.getScores();
        if (live.length > 0) {
            return res.json({ scores: live, source: "live" });
        }
        // Fallback: latest row per package from DB
        const rows = await sql`
            SELECT DISTINCT ON (package_name) *
            FROM sla_risk_scores
            ORDER BY package_name, computed_at DESC
        `;
        res.json({ scores: rows, source: "db" });
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch SLA risk scores", details: err.message });
    }
});

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.get("/api/overview", requireAdmin, async (req, res) => {
    try {
        const result = await sql`
            WITH active_shifts AS (
                SELECT DISTINCT ON (agent_id)
                    agent_id,
                    id            AS shift_id,
                    shift_started_at
                FROM shifts
                WHERE shift_ended_at IS NULL
                ORDER BY agent_id, shift_started_at DESC
            ),
            current_sessions AS (
                SELECT DISTINCT ON (agent_id)
                    agent_id,
                    id        AS session_id,
                    chat_name,
                    clicked_at AS chat_started_at
                FROM sessions
                WHERE ended_at IS NULL
                ORDER BY agent_id, clicked_at DESC
            ),
            last_ended_sessions AS (
                SELECT DISTINCT ON (agent_id)
                    agent_id,
                    ended_at AS last_session_ended_at
                FROM sessions
                WHERE ended_at IS NOT NULL
                ORDER BY agent_id, ended_at DESC
            ),
            active_breaks AS (
                SELECT DISTINCT ON (sh.agent_id)
                    sh.agent_id,
                    sb.id AS break_id
                FROM shift_breaks sb
                JOIN shifts sh ON sb.shift_id = sh.id
                WHERE sh.shift_ended_at IS NULL AND sb.ended_at IS NULL
                ORDER BY sh.agent_id, sb.started_at DESC
            ),
            today_sessions AS (
                SELECT
                    agent_id,
                    COUNT(*)::int                                                                                                    AS total,
                    COUNT(*) FILTER (WHERE ended_at IS NOT NULL AND jsonb_array_length(COALESCE(messages,'[]'::jsonb)) = 0)::int    AS empty_count,
                    COUNT(*) FILTER (WHERE last_message_from = 'client')::int                                                       AS client_count,
                    COUNT(*) FILTER (WHERE last_message_from = 'staff')::int                                                        AS staff_count
                FROM sessions
                WHERE clicked_at >= CURRENT_DATE
                GROUP BY agent_id
            ),
            shift_active AS (
                SELECT
                    sh.agent_id,
                    COALESCE(SUM(EXTRACT(EPOCH FROM (
                        LEAST(COALESCE(s.ended_at, NOW()), COALESCE(sh.shift_ended_at, NOW()))
                        - GREATEST(s.clicked_at, sh.shift_started_at)
                    ))), 0)::int AS active_seconds
                FROM active_shifts sh
                JOIN sessions s ON s.agent_id = sh.agent_id
                WHERE s.clicked_at < COALESCE((SELECT shift_ended_at FROM shifts WHERE id = sh.shift_id), NOW())
                  AND COALESCE(s.ended_at, NOW()) > sh.shift_started_at
                GROUP BY sh.agent_id
            ),
            shift_breaks_sum AS (
                SELECT
                    sh.agent_id,
                    COALESCE(SUM(EXTRACT(EPOCH FROM (
                        COALESCE(sb.ended_at, NOW()) - sb.started_at
                    ))), 0)::int AS break_seconds
                FROM shift_breaks sb
                JOIN active_shifts sh ON sb.shift_id = sh.shift_id
                GROUP BY sh.agent_id
            )
            SELECT
                a.id, a.name, a.email,
                ash.shift_id,
                ash.shift_started_at,
                cs.session_id          AS current_session_id,
                cs.chat_name           AS current_chat_name,
                cs.chat_started_at     AS current_chat_started_at,
                les.last_session_ended_at,
                ab.break_id            AS active_break_id,
                COALESCE(ts.total,        0) AS today_sessions,
                COALESCE(ts.empty_count,  0) AS today_empty_sessions,
                COALESCE(ts.client_count, 0) AS today_client_sessions,
                COALESCE(ts.staff_count,  0) AS today_staff_sessions,
                COALESCE(sa.active_seconds, 0) AS shift_active_seconds,
                COALESCE(sbs.break_seconds, 0) AS shift_break_seconds
            FROM agents a
            LEFT JOIN active_shifts       ash ON ash.agent_id = a.id
            LEFT JOIN current_sessions    cs  ON cs.agent_id  = a.id
            LEFT JOIN last_ended_sessions les ON les.agent_id = a.id
            LEFT JOIN active_breaks       ab  ON ab.agent_id  = a.id
            LEFT JOIN today_sessions      ts  ON ts.agent_id  = a.id
            LEFT JOIN shift_active        sa  ON sa.agent_id  = a.id
            LEFT JOIN shift_breaks_sum    sbs ON sbs.agent_id = a.id
            WHERE a.is_active = true
            ORDER BY (ash.shift_id IS NOT NULL) DESC, a.name ASC
        `;

        // Fetch activity threshold from settings (cached)
        const settings = await getCachedSettings();
        const activityThresholdSeconds = (parseInt(settings.idle_warning_minutes) || 5) * 60;

        // Enrich with multi-signal presence (fixes D1: on_shift count now consistent)
        const presenceMap = new Map(
            (await presenceService.getAll()).map(p => [p.id, p])
        );

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

            const pres = presenceMap.get(row.id);

            return {
                id: row.id,
                name: row.name,
                email: row.email,
                status,
                // Multi-signal presence state (richer than status; used by ops-health count)
                presence:        pres?.presence        ?? (onShift ? 'IDLE_ON_SHIFT' : 'OFF_SHIFT'),
                presenceDetail:  pres?.presenceDetail  ?? null,
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

        // Load package capacity config for weighted utilization formula
        const capacityConfig = await sql`
            SELECT complexity_weight, avg_handling_minutes, max_concurrent_chats
            FROM agent_capacity_config
            WHERE is_scheduled_workload = FALSE
        `;
        const totalCfgWeight = capacityConfig.reduce((s, r) => s + parseFloat(r.complexity_weight), 0);
        const weightedCapPerHour = totalCfgWeight > 0
            ? capacityConfig.reduce((s, r) => {
                const cap = (60 / parseFloat(r.avg_handling_minutes)) * parseFloat(r.max_concurrent_chats);
                return s + cap * parseFloat(r.complexity_weight) / totalCfgWeight;
              }, 0)
            : 6;
        const avgComplexity = totalCfgWeight > 0 ? totalCfgWeight / capacityConfig.length : 1.0;

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

                const weightedPace  = requiredPace * avgComplexity;
                const weightedRatio = weightedCapPerHour > 0 ? weightedPace / weightedCapPerHour : 0;

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
                    weighted_util_ratio: Math.round(weightedRatio * 100) / 100,
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

// ── Agent Fairness ────────────────────────────────────────────────────────
// Computes weighted utilization per agent using package complexity weights
// and concurrency from agent_capacity_config, then derives a Gini coefficient.
app.get("/api/agent-fairness", requireAdmin, async (req, res) => {
    try {
        const capacityConfig = await sql`
            SELECT complexity_weight, avg_handling_minutes, max_concurrent_chats
            FROM agent_capacity_config
            WHERE is_scheduled_workload = FALSE
        `;

        // Weighted effective throughput: sum over packages of (cap_i × weight_i) / total_weight
        const totalWeight = capacityConfig.reduce((s, r) => s + parseFloat(r.complexity_weight), 0);
        const weightedCapPerHour = totalWeight > 0
            ? capacityConfig.reduce((s, r) => {
                const cap = (60 / parseFloat(r.avg_handling_minutes)) * parseFloat(r.max_concurrent_chats);
                return s + cap * parseFloat(r.complexity_weight) / totalWeight;
              }, 0)
            : 6;
        const avgComplexity = totalWeight > 0 ? totalWeight / capacityConfig.length : 1.0;

        const queueState   = queueEngine.getState();
        const byAgentQueue = Object.fromEntries((queueState.byAgent || []).map(a => [a.agent_id, a]));

        const now    = new Date();
        const agents = await sql`
            SELECT a.id, a.name,
                   (EXISTS(SELECT 1 FROM shifts s WHERE s.agent_id = a.id AND s.shift_ended_at IS NULL)) AS on_shift,
                   COALESCE(a.shift_end_time, '19:00') AS shift_end_time
            FROM agents a
            WHERE a.is_active = TRUE
        `;

        const scored = agents.map(a => {
            const q         = byAgentQueue[a.id];
            const pending   = q?.pending_count ?? 0;
            const [seh, sem] = a.shift_end_time.split(':').map(Number);
            const shiftEnd  = new Date(now);
            shiftEnd.setHours(seh, sem, 0, 0);
            const hoursLeft = Math.max(0, (shiftEnd - now) / 3_600_000);
            const pace      = hoursLeft > 0 ? pending / hoursLeft : pending;
            const ratio     = weightedCapPerHour > 0 ? (pace * avgComplexity) / weightedCapPerHour : 0;
            return {
                agent_id:           a.id,
                agent_name:         a.name,
                on_shift:           a.on_shift,
                pending,
                hours_left:         Math.round(hoursLeft * 10) / 10,
                weighted_util_ratio: Math.round(ratio * 100) / 100,
            };
        });

        const onShiftRatios = scored.filter(a => a.on_shift).map(a => a.weighted_util_ratio);
        const gini = computeGini(onShiftRatios);

        res.json({
            agents: scored,
            gini_coefficient:    Math.round(gini * 1000) / 1000,
            weighted_cap_per_hour: Math.round(weightedCapPerHour * 10) / 10,
            avg_complexity:      Math.round(avgComplexity * 100) / 100,
        });
    } catch (err) {
        res.status(500).json({ error: "Failed to compute agent fairness", details: err.message });
    }
});

function computeGini(values) {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const n      = sorted.length;
    const mean   = sorted.reduce((s, v) => s + v, 0) / n;
    if (mean === 0) return 0;
    let sumDiff = 0;
    for (let i = 0; i < n; i++)
        for (let j = 0; j < n; j++)
            sumDiff += Math.abs(sorted[i] - sorted[j]);
    return sumDiff / (2 * n * n * mean);
}

function harmonicMean(values) {
    const positive = values.filter(v => v > 0);
    if (positive.length === 0) return 0.3;
    const sumRecip = positive.reduce((s, v) => s + 1 / v, 0);
    return positive.length / sumRecip;
}

// ── Reassignment Recommendations ─────────────────────────────────────────
app.get("/api/reassign-recommendations", requireAdmin, async (req, res) => {
    try {
        const [avgMinRow] = await sql`SELECT value FROM settings WHERE key = 'avg_minutes_per_chat'`;
        const maxChatsPerHour = 60 / (parseInt(avgMinRow?.value) || 10);

        const queueState   = queueEngine.getState();
        const byAgentQueue = Object.fromEntries((queueState.byAgent || []).map(a => [a.agent_id, a]));
        const now          = new Date();

        const agents = await sql`
            SELECT a.id, a.name,
                   (EXISTS(SELECT 1 FROM shifts s WHERE s.agent_id = a.id AND s.shift_ended_at IS NULL)) AS on_shift,
                   COALESCE(a.shift_end_time, '19:00') AS shift_end_time
            FROM agents a
            WHERE a.is_active = TRUE
        `;

        const scored = agents
            .filter(a => a.on_shift)
            .map(a => {
                const q          = byAgentQueue[a.id];
                const pending    = q?.pending_count ?? 0;
                const [seh, sem] = a.shift_end_time.split(':').map(Number);
                const shiftEnd   = new Date(now);
                shiftEnd.setHours(seh, sem, 0, 0);
                const hoursLeft  = Math.max(0, (shiftEnd - now) / 3_600_000);
                const pace       = hoursLeft > 0 ? pending / hoursLeft : pending;
                const ratio      = maxChatsPerHour > 0 ? pace / maxChatsPerHour : 0;
                return { agent_id: a.id, agent_name: a.name, pending, hours_left: hoursLeft, ratio };
            });

        const overloaded  = scored.filter(a => a.ratio > 0.8).sort((a, b) => b.ratio - a.ratio);
        const underloaded = scored.filter(a => a.ratio < 0.4).sort((a, b) => a.ratio - b.ratio);

        const recommendations = [];
        for (const from of overloaded) {
            const to = underloaded.find(u => u.agent_id !== from.agent_id);
            if (!to) break;
            const chatsToMove = Math.max(1, Math.ceil((from.ratio - 0.6) * from.hours_left * maxChatsPerHour));
            recommendations.push({
                from_agent_id:   from.agent_id,
                from_agent_name: from.agent_name,
                to_agent_id:     to.agent_id,
                to_agent_name:   to.agent_name,
                chats_to_move:   chatsToMove,
                from_ratio_pct:  Math.round(from.ratio * 100),
                to_ratio_pct:    Math.round(to.ratio * 100),
            });
        }

        res.json({ recommendations, computed_at: new Date().toISOString() });
    } catch (err) {
        res.status(500).json({ error: "Failed to compute reassignment recommendations", details: err.message });
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

    const now         = new Date();
    const today       = formatLocalDate(now);
    const snapshotHour = now.getHours();
    const results     = [];

    // Load previous hour's snapshot for delta computation (incoming/handled)
    const prevHour = snapshotHour === 0 ? 23 : snapshotHour - 1;
    const prevRows = await sql`
        SELECT agent_id, pending_count
        FROM hourly_demand_snapshots
        WHERE snapshot_date = CURRENT_DATE
          AND snapshot_hour = ${prevHour}
          AND package_name  = 'all'
    `;
    const prevByAgent = Object.fromEntries(prevRows.map(r => [String(r.agent_id), r.pending_count]));

    for (const agent of agents) {
        try {
            const { data, error } = await supabase.rpc("get_chat_rooms_paginated", rpcParams({ p_assigned_staff_id: agent.fitstn_id }));
            const demandCount = error ? 0 : (data?.total || 0);

            // ── daily snapshot (existing table) ─────────────────────────────
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

            // ── hourly snapshot (new table) ──────────────────────────────────
            const prevCount    = prevByAgent[String(agent.id)] ?? demandCount;
            const incomingCount = Math.max(0, demandCount - prevCount);  // chats that arrived since last hour
            const handledCount  = Math.max(0, prevCount - demandCount);  // chats that were handled since last hour

            await sql`
                INSERT INTO hourly_demand_snapshots
                    (snapshot_date, snapshot_hour, agent_id, package_name,
                     pending_count, incoming_count, handled_count, agent_active)
                VALUES
                    (${today}, ${snapshotHour}, ${agent.id}, 'all',
                     ${demandCount}, ${incomingCount}, ${handledCount}, TRUE)
                ON CONFLICT (snapshot_date, snapshot_hour, agent_id, package_name)
                DO UPDATE SET
                    pending_count  = EXCLUDED.pending_count,
                    incoming_count = EXCLUDED.incoming_count,
                    handled_count  = EXCLUDED.handled_count,
                    agent_active   = TRUE
            `;

            results.push({ agent_id: agent.id, agent_name: agent.name, demand_count: demandCount });
        } catch (err) {
            console.error(`Snapshot failed for ${agent.name}:`, err.message);
            results.push({ agent_id: agent.id, agent_name: agent.name, demand_count: 0, error: err.message });
        }
    }

    return { saved: results.length, snapshot_date: today, snapshot_hour: snapshotHour, agents: results };
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

        // Insert session immediately so status polls see it right away
        // (last_message_from is backfilled asynchronously after the slow Supabase RPC)
        const result = await sql`
            INSERT INTO sessions (chat_name, chat_preview, agent_id)
            VALUES (${chatName || null}, ${chatPreview || null}, ${req.user.id})
            RETURNING *
        `;

        const sessionId = result[0].id;

        // Log session_started event
        await sql`
            INSERT INTO activity_events (agent_id, event_type, session_id)
            VALUES (${req.user.id}, 'session_started', ${sessionId})
        `;

        // Respond immediately — session exists for status polls
        res.json({ success: true, data: result[0] });

        // Backfill last_message_from asynchronously (slow Supabase RPC)
        fetchLastMessageSide(chatName).then(async (lastMessageFrom) => {
            if (!lastMessageFrom) return;
            try {
                await sql`
                    UPDATE sessions
                    SET last_message_from = ${lastMessageFrom},
                        is_client_initiated = ${lastMessageFrom === "client"}
                    WHERE id = ${sessionId}
                `;
                // Update session_started event metadata with the result
                await sql`
                    UPDATE activity_events
                    SET metadata = ${JSON.stringify({ last_message_from: lastMessageFrom })}::jsonb
                    WHERE session_id = ${sessionId} AND event_type = 'session_started'
                `;
            } catch (err) {
                console.warn("Backfill last_message_from failed for session", sessionId, err.message);
            }
        }).catch((err) => {
            console.warn("fetchLastMessageSide failed for session", sessionId, err.message);
        });
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

        // Add last_message_from column — tracks which side (client/staff) sent the last message when session started
        await sql`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_message_from VARCHAR(10)`;

        // Add fitstn_id column to agents (links to Supabase staff UUID)
        await sql`ALTER TABLE agents ADD COLUMN IF NOT EXISTS fitstn_id VARCHAR(100)`;

        // Add working hours and SLA columns to agents
        await sql`ALTER TABLE agents ADD COLUMN IF NOT EXISTS shift_start_time TIME`;
        await sql`ALTER TABLE agents ADD COLUMN IF NOT EXISTS shift_end_time TIME`;
        await sql`ALTER TABLE agents ADD COLUMN IF NOT EXISTS sla_cutoff_time TIME`;

        // Demand report cache — stores pre-computed daily stats for fast reloads
        await sql`
            CREATE TABLE IF NOT EXISTS daily_stats_cache (
                range_key              TEXT PRIMARY KEY,
                range_from             TIMESTAMPTZ NOT NULL,
                range_to               TIMESTAMPTZ NOT NULL,
                peak_hours_client_first   JSONB NOT NULL DEFAULT '[]',
                peak_hours_client_replied JSONB NOT NULL DEFAULT '[]',
                demand_rows            JSONB NOT NULL DEFAULT '[]',
                coach_rows             JSONB NOT NULL DEFAULT '[]',
                total_demand_rooms     INT NOT NULL DEFAULT 0,
                total_active_rooms     INT NOT NULL DEFAULT 0,
                total_coach_initiated  INT NOT NULL DEFAULT 0,
                total_client_replied   INT NOT NULL DEFAULT 0,
                client_messages        INT NOT NULL DEFAULT 0,
                coach_messages         INT NOT NULL DEFAULT 0,
                saved_at               TIMESTAMPTZ DEFAULT NOW()
            )
        `;
        await sql`ALTER TABLE daily_stats_cache ADD COLUMN IF NOT EXISTS client_messages INT NOT NULL DEFAULT 0`;
        await sql`ALTER TABLE daily_stats_cache ADD COLUMN IF NOT EXISTS coach_messages  INT NOT NULL DEFAULT 0`;

        // ── Phase-1 schema additions ──────────────────────────────────────────

        // Per-package capacity & complexity config (editable by admins)
        await sql`
            CREATE TABLE IF NOT EXISTS agent_capacity_config (
                id                   SERIAL PRIMARY KEY,
                package_name         VARCHAR(100) NOT NULL UNIQUE,
                complexity_weight    NUMERIC(4,2) NOT NULL DEFAULT 1.0,
                avg_handling_minutes NUMERIC(6,2) NOT NULL DEFAULT 10.0,
                max_concurrent_chats SMALLINT     NOT NULL DEFAULT 3,
                sla_priority         SMALLINT     NOT NULL DEFAULT 3,
                is_scheduled_workload BOOLEAN     NOT NULL DEFAULT FALSE,
                updated_at           TIMESTAMP    DEFAULT NOW()
            )
        `;
        await sql`
            INSERT INTO agent_capacity_config
                (package_name, complexity_weight, avg_handling_minutes, max_concurrent_chats, sla_priority, is_scheduled_workload)
            VALUES
                ('Fit Solo Pro', 1.5, 12.0, 2, 1, FALSE),
                ('Fit Fam Pro',  1.5, 12.0, 2, 2, FALSE),
                ('Fit Solo',     1.0, 10.0, 3, 3, FALSE),
                ('Fit Duo',      1.0, 10.0, 3, 3, FALSE),
                ('Fit Fam',      1.1, 11.0, 3, 3, FALSE),
                ('Fit Express',  0.4,  5.0, 5, 4, TRUE)
            ON CONFLICT (package_name) DO NOTHING
        `;

        // Live queue snapshots — time-series written by QueueEngine every 5 m
        await sql`
            CREATE TABLE IF NOT EXISTS queue_snapshots (
                id            SERIAL PRIMARY KEY,
                snapshot_at   TIMESTAMP    NOT NULL DEFAULT NOW(),
                agent_id      INTEGER      REFERENCES agents(id),
                package_name  VARCHAR(100) NOT NULL DEFAULT 'all',
                pending_count INTEGER      NOT NULL DEFAULT 0
            )
        `;
        await sql`
            CREATE INDEX IF NOT EXISTS idx_queue_snapshots_time
            ON queue_snapshots(snapshot_at DESC)
        `;
        await sql`
            CREATE INDEX IF NOT EXISTS idx_queue_snapshots_agent_time
            ON queue_snapshots(agent_id, snapshot_at DESC)
        `;

        // Current queue state (latest values — queried by SSE init payload)
        await sql`
            CREATE TABLE IF NOT EXISTS queue_state (
                id               SERIAL PRIMARY KEY,
                captured_at      TIMESTAMP    NOT NULL DEFAULT NOW(),
                entity_type      VARCHAR(20)  NOT NULL DEFAULT 'agent',
                entity_id        VARCHAR(100) NOT NULL,
                pending_count    INTEGER      NOT NULL DEFAULT 0,
                growth_rate_per_hour NUMERIC(8,2) DEFAULT 0,
                oldest_pending_at TIMESTAMP,
                near_breach_count INTEGER     NOT NULL DEFAULT 0,
                severity         VARCHAR(10)  NOT NULL DEFAULT 'green'
            )
        `;
        await sql`
            CREATE INDEX IF NOT EXISTS idx_queue_state_time
            ON queue_state(captured_at DESC)
        `;

        // SLA risk scores — computed by the SLA engine every 15 m (Phase 3)
        await sql`
            CREATE TABLE IF NOT EXISTS sla_risk_scores (
                id                 SERIAL PRIMARY KEY,
                computed_at        TIMESTAMP    NOT NULL DEFAULT NOW(),
                package_name       VARCHAR(100) NOT NULL,
                risk_level         VARCHAR(10)  NOT NULL DEFAULT 'low',
                risk_score         NUMERIC(5,2) NOT NULL DEFAULT 0,
                current_sla_rate   NUMERIC(5,2),
                projected_sla_1h   NUMERIC(5,2),
                projected_sla_eod  NUMERIC(5,2),
                breach_probability NUMERIC(5,2),
                predicted_breaches INTEGER      DEFAULT 0,
                current_queue      INTEGER      DEFAULT 0,
                projected_queue_1h INTEGER      DEFAULT 0,
                incoming_rate      NUMERIC(8,2),
                handling_rate      NUMERIC(8,2),
                agents_needed      INTEGER      DEFAULT 0,
                UNIQUE(computed_at, package_name)
            )
        `;
        await sql`
            CREATE INDEX IF NOT EXISTS idx_sla_risk_time
            ON sla_risk_scores(package_name, computed_at DESC)
        `;

        // Operational alerts — written by the alert engine, read by the ops dashboard
        await sql`
            CREATE TABLE IF NOT EXISTS operational_alerts (
                id                SERIAL PRIMARY KEY,
                created_at        TIMESTAMP   NOT NULL DEFAULT NOW(),
                severity          VARCHAR(10) NOT NULL DEFAULT 'info',
                alert_type        VARCHAR(50) NOT NULL,
                title             TEXT        NOT NULL,
                body              TEXT,
                package_name      VARCHAR(100),
                agent_id          INTEGER     REFERENCES agents(id),
                metric_value      NUMERIC(10,2),
                metric_threshold  NUMERIC(10,2),
                is_acknowledged   BOOLEAN     NOT NULL DEFAULT FALSE,
                acknowledged_at   TIMESTAMP,
                acknowledged_by   INTEGER     REFERENCES admins(id),
                auto_resolved     BOOLEAN     NOT NULL DEFAULT FALSE,
                resolved_at       TIMESTAMP
            )
        `;
        await sql`
            CREATE INDEX IF NOT EXISTS idx_alerts_created
            ON operational_alerts(created_at DESC)
        `;
        await sql`
            CREATE INDEX IF NOT EXISTS idx_alerts_unacked
            ON operational_alerts(severity, created_at DESC)
            WHERE is_acknowledged = FALSE
        `;

        // Fit Express scheduled follow-up tracker (weekly batch workload)
        await sql`
            CREATE TABLE IF NOT EXISTS fit_express_schedule (
                id             SERIAL PRIMARY KEY,
                schedule_date  DATE         NOT NULL,
                weekday        SMALLINT     NOT NULL,
                coach_name     VARCHAR(255),
                total_rooms    INTEGER      NOT NULL DEFAULT 0,
                replied_count  INTEGER      NOT NULL DEFAULT 0,
                pending_count  INTEGER      NOT NULL DEFAULT 0,
                completion_pct NUMERIC(5,2) NOT NULL DEFAULT 0,
                created_at     TIMESTAMP    DEFAULT NOW(),
                updated_at     TIMESTAMP    DEFAULT NOW(),
                UNIQUE(schedule_date, coach_name)
            )
        `;

        // Hourly demand snapshots — more granular than the daily demand_snapshots table
        await sql`
            CREATE TABLE IF NOT EXISTS hourly_demand_snapshots (
                id             SERIAL    PRIMARY KEY,
                snapshot_date  DATE      NOT NULL,
                snapshot_hour  SMALLINT  NOT NULL,
                agent_id       INTEGER   REFERENCES agents(id),
                package_name   VARCHAR(100) NOT NULL DEFAULT 'all',
                pending_count  INTEGER   NOT NULL DEFAULT 0,
                incoming_count INTEGER   NOT NULL DEFAULT 0,
                handled_count  INTEGER   NOT NULL DEFAULT 0,
                breach_count   INTEGER   NOT NULL DEFAULT 0,
                agent_active   BOOLEAN   NOT NULL DEFAULT TRUE,
                UNIQUE(snapshot_date, snapshot_hour, agent_id, package_name)
            )
        `;
        await sql`
            CREATE INDEX IF NOT EXISTS idx_hourly_snap_date
            ON hourly_demand_snapshots(snapshot_date, snapshot_hour)
        `;

        // Nightly forecast model parameters per package × weekday
        await sql`
            CREATE TABLE IF NOT EXISTS forecast_models (
                id               SERIAL PRIMARY KEY,
                package_name     VARCHAR(100) NOT NULL,
                weekday          SMALLINT     NOT NULL,
                model_type       VARCHAR(20)  NOT NULL DEFAULT 'ema',
                alpha            NUMERIC(4,3) NOT NULL DEFAULT 0.3,
                forecast_demand  NUMERIC(8,2),
                seasonality_index NUMERIC(6,3) NOT NULL DEFAULT 1.0,
                std_deviation    NUMERIC(8,2),
                agents_required  NUMERIC(6,2),
                confidence_low   NUMERIC(8,2),
                confidence_high  NUMERIC(8,2),
                last_computed_at TIMESTAMP    DEFAULT NOW(),
                UNIQUE(package_name, weekday)
            )
        `;

        // ── Per-agent column additions ─────────────────────────────────────────
        await sql`ALTER TABLE agents ADD COLUMN IF NOT EXISTS package_specialty  VARCHAR(100)`;
        await sql`ALTER TABLE agents ADD COLUMN IF NOT EXISTS max_concurrent_chats SMALLINT DEFAULT 3`;
        await sql`ALTER TABLE agents ADD COLUMN IF NOT EXISTS status_updated_at  TIMESTAMP`;

        // Per-session package tracking (backfilled from Supabase in later phases)
        await sql`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS package_name        VARCHAR(100)`;
        await sql`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS first_response_seconds INTEGER`;

        // Package-level demand breakdown per daily snapshot
        await sql`ALTER TABLE demand_snapshots ADD COLUMN IF NOT EXISTS package_breakdown JSONB DEFAULT '{}'`;

        // Supabase package ID mapping (admin-configured)
        await sql`ALTER TABLE agent_capacity_config ADD COLUMN IF NOT EXISTS supabase_package_id INTEGER`;

        // ── Phase 1 — Enterprise schema additions ──────────────────────────────

        // Per-room live queue state (populated by QueueEngine L2 tier)
        await sql`
            CREATE TABLE IF NOT EXISTS live_queue_rooms (
                room_id             TEXT PRIMARY KEY,
                package_name        VARCHAR(100) NOT NULL,
                assigned_agent_id   INTEGER REFERENCES agents(id),
                client_name         TEXT,
                last_client_msg_at  TIMESTAMPTZ NOT NULL,
                last_staff_msg_at   TIMESTAMPTZ,
                sla_deadline_at     TIMESTAMPTZ NOT NULL,
                priority_score      NUMERIC(6,3) NOT NULL DEFAULT 0,
                state               VARCHAR(20)  NOT NULL DEFAULT 'OPEN',
                state_changed_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
                first_seen_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
                updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
            )
        `;
        await sql`CREATE INDEX IF NOT EXISTS idx_lqr_state_deadline ON live_queue_rooms(state, sla_deadline_at) WHERE state IN ('OPEN','AT_RISK','URGENT')`;
        await sql`CREATE INDEX IF NOT EXISTS idx_lqr_agent_priority  ON live_queue_rooms(assigned_agent_id, priority_score DESC) WHERE state <> 'RESOLVED'`;
        await sql`CREATE INDEX IF NOT EXISTS idx_lqr_priority        ON live_queue_rooms(priority_score DESC) WHERE state <> 'RESOLVED'`;

        // Per-agent live summary (updated by QueueEngine after each poll)
        await sql`
            CREATE TABLE IF NOT EXISTS agent_live_state (
                agent_id               INTEGER PRIMARY KEY REFERENCES agents(id),
                last_staff_msg_at      TIMESTAMPTZ,
                assigned_live_count    INTEGER     NOT NULL DEFAULT 0,
                weighted_load_per_hour NUMERIC(8,2),
                utilization            NUMERIC(5,3),
                concurrency_p95        NUMERIC(5,2),
                updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `;

        // Append-only operational event log (audit + replay)
        // seq = alias of id, kept separate so callers can reference it by name
        await sql`
            CREATE TABLE IF NOT EXISTS ops_event_log (
                id          BIGSERIAL   PRIMARY KEY,
                occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                event_type  VARCHAR(50) NOT NULL,
                entity_type VARCHAR(20),
                entity_id   TEXT,
                payload     JSONB       NOT NULL DEFAULT '{}'
            )
        `;
        await sql`CREATE INDEX IF NOT EXISTS idx_ops_event_id   ON ops_event_log(id DESC)`;
        await sql`CREATE INDEX IF NOT EXISTS idx_ops_event_type ON ops_event_log(event_type, occurred_at DESC)`;

        // Immutable SLA breach ledger
        await sql`
            CREATE TABLE IF NOT EXISTS sla_breach_ledger (
                id                           BIGSERIAL    PRIMARY KEY,
                room_id                      TEXT         NOT NULL,
                package_name                 VARCHAR(100) NOT NULL,
                assigned_agent_id            INTEGER,
                sla_deadline_at              TIMESTAMPTZ  NOT NULL,
                breached_at                  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
                resolved_at                  TIMESTAMPTZ,
                minutes_overdue_at_resolution INTEGER,
                cause_tag                    VARCHAR(50),
                notes                        TEXT
            )
        `;
        await sql`CREATE INDEX IF NOT EXISTS idx_breach_ledger_room ON sla_breach_ledger(room_id, breached_at DESC)`;
        await sql`CREATE INDEX IF NOT EXISTS idx_breach_ledger_pkg  ON sla_breach_ledger(package_name, breached_at DESC)`;

        // Reassignment recommendation log
        await sql`
            CREATE TABLE IF NOT EXISTS reassignment_actions (
                id                   SERIAL       PRIMARY KEY,
                recommended_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
                from_agent_id        INTEGER      REFERENCES agents(id),
                to_agent_id          INTEGER      REFERENCES agents(id),
                package_name         VARCHAR(100),
                chats_recommended    INTEGER,
                chats_actually_moved INTEGER,
                expected_util_delta  NUMERIC(5,3),
                actioned_by          INTEGER      REFERENCES admins(id),
                actioned_at          TIMESTAMPTZ
            )
        `;

        // Ops score history (written after every ops-health computation)
        await sql`
            CREATE TABLE IF NOT EXISTS ops_score_history (
                id          BIGSERIAL   PRIMARY KEY,
                computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                ops_score   SMALLINT    NOT NULL,
                confidence  NUMERIC(4,3),
                pillars     JSONB       NOT NULL DEFAULT '{}'
            )
        `;
        await sql`CREATE INDEX IF NOT EXISTS idx_ops_score_history_time ON ops_score_history(computed_at DESC)`;

        // Alert state-transition log (written by AlertEngine v2)
        await sql`
            CREATE TABLE IF NOT EXISTS alert_transitions (
                id           BIGSERIAL   PRIMARY KEY,
                alert_id     INTEGER     REFERENCES operational_alerts(id),
                from_state   VARCHAR(20),
                to_state     VARCHAR(20) NOT NULL,
                metric_value NUMERIC(12,3),
                reason       TEXT,
                occurred_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `;

        // Tunable runtime config (replaces scattered hardcoded thresholds)
        await sql`
            CREATE TABLE IF NOT EXISTS ops_config (
                key         VARCHAR(80) PRIMARY KEY,
                value       JSONB       NOT NULL,
                description TEXT,
                updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `;
        await sql`
            INSERT INTO ops_config (key, value, description) VALUES
                ('alert.sla_danger.risk_threshold',     '50',    'Minimum risk_score to fire sla_danger alert'),
                ('alert.sla_danger.critical_threshold', '75',    'Risk score above which severity becomes critical'),
                ('alert.queue_overload.growth_warn',    '5',     'Queue growth rate (chats/hr) to fire queue_overload warning'),
                ('alert.queue_overload.growth_critical','10',    'Queue growth rate (chats/hr) for critical severity'),
                ('alert.agent_overload.pending_warn',   '20',    'Per-agent pending count to fire agent_overload warning'),
                ('alert.agent_overload.pending_critical','35',   'Per-agent pending count for critical severity'),
                ('alert.inactive_agent.idle_minutes',   '15',    'Idle minutes threshold for inactive_agent alert'),
                ('alert.workload_imbalance.gini',       '0.35',  'Gini coefficient threshold for workload_imbalance alert'),
                ('alert.cooldown.sla_danger_min',       '10',    'Minutes stable before sla_danger auto-resolves'),
                ('alert.cooldown.agent_overload_min',   '15',    'Minutes stable before agent_overload auto-resolves'),
                ('alert.cooldown.queue_overload_min',   '10',    'Minutes stable before queue_overload auto-resolves'),
                ('alert.cooldown.inactive_agent_min',   '5',     'Minutes stable before inactive_agent auto-resolves'),
                ('alert.cooldown.workload_imbalance_min','20',   'Minutes stable before workload_imbalance auto-resolves'),
                ('alert.escalate.sla_danger_min',       '20',    'Minutes worsening before sla_danger escalates'),
                ('alert.escalate.agent_overload_min',   '30',    'Minutes worsening before agent_overload escalates'),
                ('alert.escalate.queue_overload_min',   '15',    'Minutes worsening before queue_overload escalates'),
                ('queue.priority_weights',              '[0.20,0.40,0.15,0.20,0.05]', 'Weights: [PackagePriority, TTB_Urgency, AgingPenalty, PremiumBoost, ReopenPenalty]'),
                ('presence.idle_warning_minutes',       '10',    'Minutes without activity before agent is considered idle'),
                ('presence.responding_window_minutes',  '10',    'Minutes lookback for RESPONDING state')
            ON CONFLICT (key) DO NOTHING
        `;

        // ALTER operational_alerts to support state-machine lifecycle (AlertEngine v2)
        await sql`ALTER TABLE operational_alerts ADD COLUMN IF NOT EXISTS fingerprint       TEXT`;
        await sql`ALTER TABLE operational_alerts ADD COLUMN IF NOT EXISTS state             VARCHAR(20) NOT NULL DEFAULT 'started'`;
        await sql`ALTER TABLE operational_alerts ADD COLUMN IF NOT EXISTS last_evaluated_at TIMESTAMPTZ`;
        await sql`ALTER TABLE operational_alerts ADD COLUMN IF NOT EXISTS escalation_level  SMALLINT    NOT NULL DEFAULT 0`;
        await sql`ALTER TABLE operational_alerts ADD COLUMN IF NOT EXISTS snooze_until      TIMESTAMPTZ`;
        await sql`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_alerts_open_fingerprint
            ON operational_alerts(fingerprint)
            WHERE state IN ('started','worsening','stable','improving','escalated')
        `;

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
                console.log(`Demand snapshot updated: ${result.saved} agents for ${result.snapshot_date} hour ${result.snapshot_hour}`);
            } catch (err) {
                console.error("Auto demand snapshot failed:", err.message);
            }
        }, SNAPSHOT_INTERVAL_MS);

        // Presence view — depends on agent_live_state existing
        await presenceService.createView();

        // Queue engine — polls Supabase every 60 s and broadcasts via SSE
        queueEngine.start();

        // SLA engine — computes per-package risk scores every 15 min
        slaEngine.start();

        // Alert engine — evaluates rules every 5 min, writes to operational_alerts
        alertEngine.start();

        // Forecasting service — seeds models immediately then reruns nightly at midnight
        forecastingService.start();

        // Express scheduler — snapshots Fit Express rooms daily at 11:00 local
        expressScheduler.start();

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
