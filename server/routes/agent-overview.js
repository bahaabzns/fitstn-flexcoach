const express = require("express");
const { computeGapIdle } = require("../utils/shift-utils");

module.exports = function (sql, getCachedSettings) {
    const router = express.Router();

    // Allow both admin and agent (agent can only view their own data)
    async function requireAdminOrAgent(req, res, next) {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith("Bearer ")) {
            return res.status(401).json({ error: "No token provided" });
        }
        const token = authHeader.slice(7);
        try {
            const adminRows = await sql`
                SELECT t.user_id, a.email
                FROM auth_tokens t
                JOIN admins a ON t.user_id = a.id
                WHERE t.token = ${token} AND t.user_type = 'admin' AND t.expires_at > NOW()
            `;
            if (adminRows.length > 0) {
                req.user = { id: adminRows[0].user_id, email: adminRows[0].email, type: "admin" };
                return next();
            }

            const agentRows = await sql`
                SELECT t.user_id, a.email, a.name, a.is_active
                FROM auth_tokens t
                JOIN agents a ON t.user_id = a.id
                WHERE t.token = ${token} AND t.user_type = 'agent' AND t.expires_at > NOW()
            `;
            if (agentRows.length > 0) {
                if (!agentRows[0].is_active) {
                    return res.status(403).json({ error: "Agent account is deactivated" });
                }
                req.user = { id: agentRows[0].user_id, email: agentRows[0].email, name: agentRows[0].name, type: "agent" };
                return next();
            }

            return res.status(401).json({ error: "Invalid or expired token" });
        } catch (err) {
            res.status(500).json({ error: "Auth check failed" });
        }
    }

    router.get("/:agentId", requireAdminOrAgent, async (req, res) => {
        try {
            const agentId = parseInt(req.params.agentId);

            if (req.user.type === "agent" && req.user.id !== agentId) {
                return res.status(403).json({ error: "You can only view your own overview" });
            }

            const period = req.query.period || "month";
            const dateParam = req.query.date || new Date().toISOString().slice(0, 10);
            const { startDate, endDate } = getDateRange(period, dateParam);

            const agentRows = await sql`SELECT id, name, email FROM agents WHERE id = ${agentId}`;
            if (agentRows.length === 0) {
                return res.status(404).json({ error: "Agent not found" });
            }

            const shiftData = await sql`
                SELECT
                    DATE(sh.shift_started_at) as shift_date,
                    SUM(GREATEST(0, EXTRACT(EPOCH FROM (
                        LEAST(COALESCE(sh.shift_ended_at, NOW()), ${endDate}::date + INTERVAL '1 day')
                        - sh.shift_started_at
                    ))))::int as shift_seconds,
                    SUM((SELECT COALESCE(SUM(GREATEST(0, EXTRACT(EPOCH FROM (
                        LEAST(COALESCE(s.ended_at, COALESCE(sh.shift_ended_at, NOW())), COALESCE(sh.shift_ended_at, NOW()))
                        - GREATEST(s.clicked_at, sh.shift_started_at)
                    )))), 0)::int
                    FROM sessions s
                    WHERE s.agent_id = sh.agent_id
                    AND s.clicked_at < COALESCE(sh.shift_ended_at, NOW())
                    AND COALESCE(s.ended_at, NOW()) > sh.shift_started_at
                    ))::int as active_in_shift_seconds,
                    SUM((SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (
                        COALESCE(sb.ended_at, COALESCE(sh.shift_ended_at, NOW())) - sb.started_at
                    ))), 0)::int
                    FROM shift_breaks sb
                    WHERE sb.shift_id = sh.id
                    ))::int as break_seconds
                FROM shifts sh
                WHERE sh.agent_id = ${agentId}
                AND sh.shift_started_at >= ${startDate}::date
                AND sh.shift_started_at < ${endDate}::date + INTERVAL '1 day'
                GROUP BY DATE(sh.shift_started_at)
                ORDER BY shift_date
            `;

            const sessionData = await sql`
                SELECT
                    DATE(clicked_at) as session_date,
                    COUNT(*)::int as session_count,
                    COUNT(*) FILTER (WHERE ended_at IS NOT NULL AND jsonb_array_length(COALESCE(messages, '[]'::jsonb)) = 0)::int as empty_session_count,
                    COUNT(*) FILTER (WHERE last_message_from = 'client')::int as client_initiated_count,
                    COUNT(*) FILTER (WHERE last_message_from = 'staff')::int as staff_initiated_count,
                    SUM(GREATEST(0, EXTRACT(EPOCH FROM (
                        LEAST(COALESCE(ended_at, NOW()), ${endDate}::date + INTERVAL '1 day')
                        - clicked_at
                    ))))::int as active_seconds,
                    SUM(jsonb_array_length(COALESCE(messages, '[]'::jsonb)))::int as total_messages
                FROM sessions
                WHERE agent_id = ${agentId}
                AND clicked_at >= ${startDate}::date
                AND clicked_at < ${endDate}::date + INTERVAL '1 day'
                GROUP BY DATE(clicked_at)
                ORDER BY session_date
            `;

            const totalShiftSeconds = shiftData.reduce((sum, r) => sum + (r.shift_seconds || 0), 0);
            const totalActiveInShift = shiftData.reduce((sum, r) => sum + (r.active_in_shift_seconds || 0), 0);
            const totalBreakSeconds = shiftData.reduce((sum, r) => sum + (r.break_seconds || 0), 0);
            const totalSessions = sessionData.reduce((sum, r) => sum + r.session_count, 0);
            const totalEmptySessions = sessionData.reduce((sum, r) => sum + (r.empty_session_count || 0), 0);
            const totalClientSessions = sessionData.reduce((sum, r) => sum + (r.client_initiated_count || 0), 0);
            const totalStaffSessions = sessionData.reduce((sum, r) => sum + (r.staff_initiated_count || 0), 0);
            const totalActiveSeconds = sessionData.reduce((sum, r) => sum + (r.active_seconds || 0), 0);
            const totalMessages = sessionData.reduce((sum, r) => sum + (r.total_messages || 0), 0);

            // Gap-based idle: fetch all shifts and sessions for this agent in period, compute idle per shift
            const settings = await getCachedSettings();
            const activityThresholdSeconds = (parseInt(settings.idle_warning_minutes) || 5) * 60;

            const allShiftsInPeriod = await sql`
                SELECT id, agent_id, shift_started_at, shift_ended_at
                FROM shifts
                WHERE agent_id = ${agentId}
                AND shift_started_at >= ${startDate}::date
                AND shift_started_at < ${endDate}::date + INTERVAL '1 day'
                ORDER BY shift_started_at
            `;

            let totalIdleSeconds = 0;
            const idleByDate = {};
            for (const sh of allShiftsInPeriod) {
                const shiftEnd = sh.shift_ended_at || new Date();
                const sessions = await sql`
                    SELECT clicked_at, ended_at FROM sessions
                    WHERE agent_id = ${sh.agent_id}
                    AND ended_at IS NOT NULL
                    AND clicked_at < ${shiftEnd}
                    AND ended_at > ${sh.shift_started_at}
                    ORDER BY clicked_at
                `;
                const shiftIdleSeconds = computeGapIdle(sh.shift_started_at, shiftEnd, sessions, activityThresholdSeconds);
                totalIdleSeconds += shiftIdleSeconds;
                const dateKey = formatLocalDate(new Date(sh.shift_started_at));
                idleByDate[dateKey] = (idleByDate[dateKey] || 0) + shiftIdleSeconds;
            }

            const totalRemainderSeconds = Math.max(0, totalShiftSeconds - totalActiveInShift - totalBreakSeconds);
            totalIdleSeconds = Math.min(totalIdleSeconds, totalRemainderSeconds);
            const totalOffSessionSeconds = Math.max(0, totalRemainderSeconds - totalIdleSeconds);
            const effectiveShiftSeconds = Math.max(0, totalShiftSeconds - totalBreakSeconds);
            const productivityPercentage = effectiveShiftSeconds > 0
                ? Math.round((totalActiveInShift / effectiveShiftSeconds) * 100)
                : 0;
            const averageSessionSeconds = totalSessions > 0
                ? Math.round(totalActiveSeconds / totalSessions)
                : 0;
            const averageMessagesPerSession = totalSessions > 0
                ? Math.round((totalMessages / totalSessions) * 10) / 10
                : 0;

            const dailyBreakdown = buildDailyBreakdown(startDate, endDate, shiftData, sessionData, idleByDate);

            const selectedMonth = dateParam.slice(0, 7);
            let salaryInfo = null;

            const payslipRows = await sql`
                SELECT * FROM salary_records
                WHERE agent_id = ${agentId} AND month = ${selectedMonth}
                LIMIT 1
            `;
            if (payslipRows.length > 0) {
                const p = payslipRows[0];
                salaryInfo = {
                    basic_salary: parseFloat(p.basic_salary),
                    bonus: parseFloat(p.bonus),
                    total_deductions: parseFloat(p.total_deductions),
                    total_overtime: parseFloat(p.total_overtime),
                    net_salary: parseFloat(p.net_salary),
                    source: "payslip"
                };
            } else {
                const salaryRows = await sql`
                    SELECT * FROM agent_salaries WHERE agent_id = ${agentId}
                `;
                if (salaryRows.length > 0) {
                    const s = salaryRows[0];
                    salaryInfo = {
                        basic_salary: parseFloat(s.basic_salary),
                        bonus: parseFloat(s.bonus),
                        total_deductions: 0,
                        total_overtime: 0,
                        net_salary: parseFloat(s.basic_salary) + parseFloat(s.bonus),
                        source: "definition"
                    };
                }
            }

            const salaryHistory = await sql`
                SELECT month, net_salary, basic_salary, bonus, total_deductions, total_overtime
                FROM salary_records
                WHERE agent_id = ${agentId}
                ORDER BY month DESC
                LIMIT 6
            `;

            const sessionsList = await sql`
                SELECT
                    s.id, s.chat_name, s.chat_preview, s.clicked_at, s.ended_at,
                    CASE WHEN s.ended_at IS NOT NULL THEN
                        EXTRACT(EPOCH FROM (s.ended_at - s.clicked_at))::int
                    ELSE NULL END as duration_seconds,
                    jsonb_array_length(COALESCE(s.messages, '[]'::jsonb))::int as message_count
                FROM sessions s
                WHERE s.agent_id = ${agentId}
                AND s.clicked_at >= ${startDate}::date
                AND s.clicked_at < ${endDate}::date + INTERVAL '1 day'
                ORDER BY s.clicked_at DESC
            `;

            const shiftsList = await sql`
                SELECT
                    sh.id, sh.shift_started_at, sh.shift_ended_at,
                    EXTRACT(EPOCH FROM (
                        COALESCE(sh.shift_ended_at, NOW()) - sh.shift_started_at
                    ))::int as duration_seconds,
                    (SELECT COALESCE(SUM(GREATEST(0, EXTRACT(EPOCH FROM (
                        LEAST(COALESCE(s.ended_at, COALESCE(sh.shift_ended_at, NOW())), COALESCE(sh.shift_ended_at, NOW()))
                        - GREATEST(s.clicked_at, sh.shift_started_at)
                    )))), 0)::int
                    FROM sessions s
                    WHERE s.agent_id = sh.agent_id
                    AND s.clicked_at < COALESCE(sh.shift_ended_at, NOW())
                    AND COALESCE(s.ended_at, NOW()) > sh.shift_started_at
                    ) as active_seconds,
                    (SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (
                        COALESCE(sb.ended_at, COALESCE(sh.shift_ended_at, NOW())) - sb.started_at
                    ))), 0)::int
                    FROM shift_breaks sb
                    WHERE sb.shift_id = sh.id
                    ) as break_seconds
                FROM shifts sh
                WHERE sh.agent_id = ${agentId}
                AND sh.shift_started_at >= ${startDate}::date
                AND sh.shift_started_at < ${endDate}::date + INTERVAL '1 day'
                ORDER BY sh.shift_started_at DESC
            `;

            const shiftsWithIdle = [];
            for (const sh of shiftsList) {
                const shiftEnd = sh.shift_ended_at || new Date();
                const shiftSessions = await sql`
                    SELECT clicked_at, ended_at FROM sessions
                    WHERE agent_id = ${agentId}
                    AND ended_at IS NOT NULL
                    AND clicked_at < ${shiftEnd}
                    AND ended_at > ${sh.shift_started_at}
                    ORDER BY clicked_at
                `;
                const rawIdleSec = computeGapIdle(sh.shift_started_at, shiftEnd, shiftSessions, activityThresholdSeconds);
                const breakSec = sh.break_seconds || 0;
                const remainder = Math.max(0, sh.duration_seconds - sh.active_seconds - breakSec);
                const idleSec = Math.min(rawIdleSec, remainder);
                const offSessionSec = Math.max(0, remainder - idleSec);
                shiftsWithIdle.push({
                    ...sh,
                    break_seconds: breakSec,
                    idle_seconds: idleSec,
                    off_session_seconds: offSessionSec,
                });
            }

            // Response time metrics from activity events
            const responseTimeData = await sql`
                SELECT
                    COALESCE(AVG((metadata->>'response_time_seconds')::numeric), 0)::int AS avg_response_seconds,
                    COALESCE(MIN((metadata->>'response_time_seconds')::numeric), 0)::int AS min_response_seconds,
                    COALESCE(MAX((metadata->>'response_time_seconds')::numeric), 0)::int AS max_response_seconds,
                    COUNT(*)::int AS total_messages_tracked
                FROM activity_events
                WHERE agent_id = ${agentId}
                    AND event_type = 'message_sent'
                    AND created_at >= ${startDate}::date
                    AND created_at < ${endDate}::date + INTERVAL '1 day'
                    AND metadata->>'response_time_seconds' IS NOT NULL
            `;

            res.json({
                agent: agentRows[0],
                period: { type: period, start: startDate, end: endDate },
                salary: salaryInfo,
                salary_history: salaryHistory.reverse(),
                performance: {
                    total_sessions: totalSessions,
                    total_empty_sessions: totalEmptySessions,
                    client_sessions: totalClientSessions,
                    staff_sessions: totalStaffSessions,
                    total_shift_seconds: totalShiftSeconds,
                    total_active_seconds: totalActiveSeconds,
                    total_break_seconds: totalBreakSeconds,
                    total_idle_seconds: totalIdleSeconds,
                    total_off_session_seconds: totalOffSessionSeconds,
                    productivity_percentage: productivityPercentage,
                    average_session_seconds: averageSessionSeconds,
                    average_messages_per_session: averageMessagesPerSession,
                    total_messages: totalMessages,
                    average_response_seconds: responseTimeData[0].avg_response_seconds,
                    min_response_seconds: responseTimeData[0].min_response_seconds,
                    max_response_seconds: responseTimeData[0].max_response_seconds,
                },
                daily_breakdown: dailyBreakdown,
                sessions: sessionsList,
                shifts: shiftsWithIdle
            });
        } catch (err) {
            res.status(500).json({ error: "Failed to fetch agent overview", details: err.message });
        }
    });

    router.get("/:agentId/sessions", requireAdminOrAgent, async (req, res) => {
        try {
            const agentId = parseInt(req.params.agentId);
            if (req.user.type === "agent" && req.user.id !== agentId) {
                return res.status(403).json({ error: "You can only view your own sessions" });
            }

            const period = req.query.period || "month";
            const dateParam = req.query.date || new Date().toISOString().slice(0, 10);
            const { startDate, endDate } = getDateRange(period, dateParam);

            const sessions = await sql`
                SELECT
                    s.id, s.chat_name, s.chat_preview, s.clicked_at, s.ended_at,
                    s.last_message_from,
                    CASE WHEN s.ended_at IS NOT NULL THEN
                        EXTRACT(EPOCH FROM (s.ended_at - s.clicked_at))::int
                    ELSE NULL END as duration_seconds,
                    jsonb_array_length(COALESCE(s.messages, '[]'::jsonb))::int as message_count
                FROM sessions s
                WHERE s.agent_id = ${agentId}
                AND s.clicked_at >= ${startDate}::date
                AND s.clicked_at < ${endDate}::date + INTERVAL '1 day'
                ORDER BY s.clicked_at DESC
            `;

            res.json({ period: { type: period, start: startDate, end: endDate }, sessions });
        } catch (err) {
            res.status(500).json({ error: "Failed to fetch sessions", details: err.message });
        }
    });

    router.get("/:agentId/shifts", requireAdminOrAgent, async (req, res) => {
        try {
            const agentId = parseInt(req.params.agentId);
            if (req.user.type === "agent" && req.user.id !== agentId) {
                return res.status(403).json({ error: "You can only view your own shifts" });
            }

            const period = req.query.period || "month";
            const dateParam = req.query.date || new Date().toISOString().slice(0, 10);
            const { startDate, endDate } = getDateRange(period, dateParam);

            const shifts = await sql`
                SELECT
                    sh.id, sh.agent_id, sh.shift_started_at, sh.shift_ended_at,
                    EXTRACT(EPOCH FROM (
                        COALESCE(sh.shift_ended_at, NOW()) - sh.shift_started_at
                    ))::int as duration_seconds,
                    (SELECT COALESCE(SUM(GREATEST(0, EXTRACT(EPOCH FROM (
                        LEAST(COALESCE(s.ended_at, COALESCE(sh.shift_ended_at, NOW())), COALESCE(sh.shift_ended_at, NOW()))
                        - GREATEST(s.clicked_at, sh.shift_started_at)
                    )))), 0)::int
                    FROM sessions s
                    WHERE s.agent_id = sh.agent_id
                    AND s.clicked_at < COALESCE(sh.shift_ended_at, NOW())
                    AND COALESCE(s.ended_at, NOW()) > sh.shift_started_at
                    ) as active_seconds,
                    (SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (
                        COALESCE(sb.ended_at, COALESCE(sh.shift_ended_at, NOW())) - sb.started_at
                    ))), 0)::int
                    FROM shift_breaks sb
                    WHERE sb.shift_id = sh.id
                    ) as break_seconds
                FROM shifts sh
                WHERE sh.agent_id = ${agentId}
                AND sh.shift_started_at >= ${startDate}::date
                AND sh.shift_started_at < ${endDate}::date + INTERVAL '1 day'
                ORDER BY sh.shift_started_at DESC
            `;

            const shiftSettings = await getCachedSettings();
            const shiftThresholdSeconds = (parseInt(shiftSettings.idle_warning_minutes) || 5) * 60;

            const shiftsWithIdle = [];
            for (const sh of shifts) {
                const shiftEnd = sh.shift_ended_at || new Date();
                const sessions = await sql`
                    SELECT clicked_at, ended_at FROM sessions
                    WHERE agent_id = ${sh.agent_id}
                    AND ended_at IS NOT NULL
                    AND clicked_at < ${shiftEnd}
                    AND ended_at > ${sh.shift_started_at}
                    ORDER BY clicked_at
                `;
                const rawIdleSeconds = computeGapIdle(sh.shift_started_at, shiftEnd, sessions, shiftThresholdSeconds);
                const breakSeconds = sh.break_seconds || 0;
                const remainderSeconds = Math.max(0, sh.duration_seconds - sh.active_seconds - breakSeconds);
                const idleSeconds = Math.min(rawIdleSeconds, remainderSeconds);
                const offSessionSeconds = Math.max(0, remainderSeconds - idleSeconds);
                shiftsWithIdle.push({
                    ...sh,
                    break_seconds: breakSeconds,
                    idle_seconds: idleSeconds,
                    off_session_seconds: offSessionSeconds,
                });
            }

            res.json({ period: { type: period, start: startDate, end: endDate }, shifts: shiftsWithIdle });
        } catch (err) {
            res.status(500).json({ error: "Failed to fetch shifts", details: err.message });
        }
    });

    return router;
};

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
            endDate: formatLocalDate(weekEnd)
        };
    }

    // month (default)
    const year = date.getFullYear();
    const month = date.getMonth();
    return {
        startDate: formatLocalDate(new Date(year, month, 1)),
        endDate: formatLocalDate(new Date(year, month + 1, 0))
    };
}

function buildDailyBreakdown(startDate, endDate, shiftData, sessionData, idleByDate) {
    const shiftMap = {};
    shiftData.forEach(row => {
        const key = formatLocalDate(new Date(row.shift_date));
        shiftMap[key] = {
            shift_seconds: row.shift_seconds || 0,
            break_seconds: row.break_seconds || 0,
        };
    });

    const sessionMap = {};
    sessionData.forEach(row => {
        const key = formatLocalDate(new Date(row.session_date));
        sessionMap[key] = {
            sessions: row.session_count,
            active_seconds: row.active_seconds || 0,
            messages: row.total_messages || 0
        };
    });

    const days = [];
    const current = new Date(startDate + "T00:00:00");
    const end = new Date(endDate + "T00:00:00");

    while (current <= end) {
        const key = formatLocalDate(current);
        const shiftInfo = shiftMap[key] || { shift_seconds: 0, break_seconds: 0 };
        const sessionInfo = sessionMap[key] || { sessions: 0, active_seconds: 0, messages: 0 };
        const dayRemainder = Math.max(0, shiftInfo.shift_seconds - sessionInfo.active_seconds - shiftInfo.break_seconds);
        const dayIdleSeconds = Math.min(idleByDate[key] || 0, dayRemainder);
        const dayOffSessionSeconds = Math.max(0, dayRemainder - dayIdleSeconds);
        days.push({
            date: key,
            shift_seconds: shiftInfo.shift_seconds,
            break_seconds: shiftInfo.break_seconds,
            idle_seconds: dayIdleSeconds,
            off_session_seconds: dayOffSessionSeconds,
            sessions: sessionInfo.sessions,
            active_seconds: sessionInfo.active_seconds,
            messages: sessionInfo.messages
        });
        current.setDate(current.getDate() + 1);
    }

    return days;
}
