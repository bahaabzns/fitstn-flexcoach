const express = require('express');
const { SLA_RULES, UTC_OFFSET, DAY_NAMES } = require('../constants/sla-rules');
const { CAPACITY_CONFIG, staffingRequired } = require('../services/forecasting');

module.exports = function (sql, requireAdmin) {
    const router = express.Router();

    // ── GET /api/hourly-heatmap?date=YYYY-MM-DD ───────────────────────────────
    // Returns 24 hourly buckets with demand totals from hourly_demand_snapshots.
    router.get('/hourly-heatmap', requireAdmin, async (req, res) => {
        try {
            const localToday = new Date(Date.now() + UTC_OFFSET * 3_600_000)
                .toISOString().slice(0, 10);
            const date = req.query.date || localToday;

            const rows = await sql`
                SELECT
                    snapshot_hour,
                    COALESCE(package_name, 'all') AS package_name,
                    SUM(incoming_count)::int  AS incoming,
                    SUM(handled_count)::int   AS handled,
                    SUM(pending_count)::int   AS pending,
                    SUM(breach_count)::int    AS breaches
                FROM hourly_demand_snapshots
                WHERE snapshot_date = ${date}
                GROUP BY snapshot_hour, package_name
                ORDER BY snapshot_hour, package_name
            `;

            const hours = Array.from({ length: 24 }, (_, h) => ({
                hour: h,
                label: `${String(h).padStart(2, '0')}:00`,
                incoming: 0, handled: 0, pending: 0, breaches: 0,
                packages: {},
            }));

            for (const row of rows) {
                const h = row.snapshot_hour;
                if (h < 0 || h > 23) continue;
                if (row.package_name === 'all') {
                    hours[h].incoming += Number(row.incoming);
                    hours[h].handled  += Number(row.handled);
                    hours[h].pending  += Number(row.pending);
                    hours[h].breaches += Number(row.breaches);
                } else {
                    hours[h].packages[row.package_name] = {
                        incoming: Number(row.incoming),
                        handled:  Number(row.handled),
                        pending:  Number(row.pending),
                        breaches: Number(row.breaches),
                    };
                }
            }

            const maxIncoming = Math.max(...hours.map(h => h.incoming), 1);
            res.json({ date, hours, maxIncoming });
        } catch (err) {
            res.status(500).json({ error: 'Failed to fetch hourly heatmap', details: err.message });
        }
    });

    // ── GET /api/forecast?weekday=N (0=Sun … 6=Sat) ──────────────────────────
    // Returns EMA forecast models for the given weekday from forecast_models.
    router.get('/forecast', requireAdmin, async (req, res) => {
        try {
            const localNow  = new Date(Date.now() + UTC_OFFSET * 3_600_000);
            const weekday   = req.query.weekday != null
                ? parseInt(req.query.weekday)
                : localNow.getUTCDay();

            if (isNaN(weekday) || weekday < 0 || weekday > 6) {
                return res.status(400).json({ error: 'weekday must be 0–6' });
            }

            const models = await sql`
                SELECT *
                FROM forecast_models
                WHERE weekday = ${weekday}
                ORDER BY package_name
            `;

            if (models.length === 0) {
                return res.json({
                    weekday,
                    day_name: DAY_NAMES[weekday],
                    models: [],
                    total_agents_required: 0,
                    note: 'No forecast data yet — models are computed nightly.',
                });
            }

            const totalAgentsRequired = models
                .filter(m => !SLA_RULES[m.package_name]?.isScheduled)
                .reduce((max, m) => Math.max(max, m.agents_required || 0), 0);

            res.json({
                weekday,
                day_name: DAY_NAMES[weekday],
                models,
                total_agents_required: totalAgentsRequired,
            });
        } catch (err) {
            res.status(500).json({ error: 'Failed to fetch forecast', details: err.message });
        }
    });

    // ── POST /api/what-if/simulate ────────────────────────────────────────────
    // Body: { scenario, params }
    //   scenario: 'demand_spike' | 'agent_absent' | 'package_growth'
    //   params (demand_spike):    { spikePercent: 50 }
    //   params (agent_absent):    { agentsAbsent: 2 }
    //   params (package_growth):  { packageName: 'Fit Solo', growthPct: 30 }
    router.post('/what-if/simulate', requireAdmin, async (req, res) => {
        try {
            const { scenario, params = {} } = req.body || {};
            const VALID = ['demand_spike', 'agent_absent', 'package_growth'];
            if (!VALID.includes(scenario)) {
                return res.status(400).json({ error: `scenario must be one of: ${VALID.join(', ')}` });
            }

            const localNow = new Date(Date.now() + UTC_OFFSET * 3_600_000);
            const weekday  = localNow.getUTCDay();

            const [models, onShiftRow, totalRow] = await Promise.all([
                sql`SELECT * FROM forecast_models WHERE weekday = ${weekday}`,
                sql`SELECT COUNT(*)::int AS count
                    FROM agents a
                    WHERE a.is_active = TRUE
                      AND EXISTS (
                          SELECT 1 FROM shifts s
                          WHERE s.agent_id = a.id AND s.shift_ended_at IS NULL
                      )`,
                sql`SELECT COUNT(*)::int AS count FROM agents WHERE is_active = TRUE`,
            ]);

            const onShift      = onShiftRow[0]?.count ?? 0;
            const totalAgents  = totalRow[0]?.count    ?? onShift;

            // Apply scenario transform to demand figures
            let adjusted = models.map(m => ({ ...m }));

            if (scenario === 'demand_spike') {
                const multiplier = 1 + (parseFloat(params.spikePercent) || 50) / 100;
                adjusted = adjusted.map(m => ({
                    ...m,
                    forecast_demand: Math.round(Number(m.forecast_demand) * multiplier),
                    confidence_low:  Math.round(Number(m.confidence_low)  * multiplier),
                    confidence_high: Math.round(Number(m.confidence_high) * multiplier),
                }));
            } else if (scenario === 'package_growth') {
                const pkgName    = params.packageName || 'Fit Solo';
                const multiplier = 1 + (parseFloat(params.growthPct) || 30) / 100;
                adjusted = adjusted.map(m =>
                    m.package_name === pkgName
                        ? { ...m, forecast_demand: Math.round(Number(m.forecast_demand) * multiplier) }
                        : m
                );
            }
            // agent_absent: demand unchanged, capacity reduced below

            const effectiveAgents = scenario === 'agent_absent'
                ? Math.max(0, totalAgents - (parseInt(params.agentsAbsent) || 1))
                : totalAgents;

            const results = adjusted.map(m => {
                const rule      = SLA_RULES[m.package_name];
                const shiftHrs  = rule ? (rule.endHour - rule.startHour) : 7;
                const cfg       = CAPACITY_CONFIG[m.package_name];
                const demand    = Number(m.forecast_demand);
                const required  = staffingRequired(demand, shiftHrs, m.package_name);
                const agentGap  = required - effectiveAgents;

                let utilization = 0;
                if (cfg && !cfg.isScheduledWorkload && effectiveAgents > 0) {
                    const chatsPerShift = (shiftHrs * 60) / (cfg.avgHandlingMinutes * cfg.complexityWeight);
                    utilization = Math.round((demand / (effectiveAgents * chatsPerShift)) * 100);
                }

                const slaRisk = utilization > 110 ? 'critical'
                    : utilization > 90 ? 'high'
                    : utilization > 70 ? 'medium'
                    : 'low';

                const recommendation = agentGap > 0
                    ? `Add ${agentGap} agent${agentGap > 1 ? 's' : ''} to meet demand`
                    : agentGap < -2
                    ? `${Math.abs(agentGap)} agents can be redeployed`
                    : 'Staffing is adequate';

                return {
                    package_name:     m.package_name,
                    forecast_demand:  demand,
                    confidence_low:   Number(m.confidence_low)  || 0,
                    confidence_high:  Number(m.confidence_high) || 0,
                    required_agents:  required,
                    effective_agents: effectiveAgents,
                    agent_gap:        agentGap,
                    utilization,
                    sla_risk:         slaRisk,
                    recommendation,
                };
            });

            res.json({
                scenario,
                params,
                weekday,
                day_name:         DAY_NAMES[weekday],
                on_shift:         onShift,
                effective_agents: effectiveAgents,
                results,
            });
        } catch (err) {
            res.status(500).json({ error: 'Failed to run simulation', details: err.message });
        }
    });

    // ── GET /api/fit-express-schedule?date=YYYY-MM-DD ────────────────────────
    // Returns Fit Express schedule snapshots for the given date (or today).
    router.get('/fit-express-schedule', requireAdmin, async (req, res) => {
        try {
            const localToday = new Date(Date.now() + UTC_OFFSET * 3_600_000)
                .toISOString().slice(0, 10);
            const date = req.query.date || localToday;

            const rows = await sql`
                SELECT *
                FROM fit_express_schedule
                WHERE schedule_date = ${date}
                ORDER BY coach_name NULLS FIRST
            `;

            const totals = rows.reduce((acc, r) => ({
                total_rooms:    acc.total_rooms    + (r.total_rooms    || 0),
                pending_count:  acc.pending_count  + (r.pending_count  || 0),
                replied_count:  acc.replied_count  + (r.replied_count  || 0),
            }), { total_rooms: 0, pending_count: 0, replied_count: 0 });

            totals.completion_pct = totals.total_rooms > 0
                ? Math.round((totals.replied_count / totals.total_rooms) * 10000) / 100
                : 0;

            res.json({ date, rows, totals });
        } catch (err) {
            res.status(500).json({ error: 'Failed to fetch Fit Express schedule', details: err.message });
        }
    });

    // ── GET /api/capacity-config ──────────────────────────────────────────────
    // Returns per-package capacity configuration from the DB.
    // Falls back to the hardcoded defaults from forecasting.js if the table is empty.
    router.get('/capacity-config', requireAdmin, async (req, res) => {
        try {
            const rows = await sql`
                SELECT package_name, complexity_weight, avg_handling_minutes,
                       max_concurrent_chats, sla_priority, is_scheduled_workload
                FROM agent_capacity_config
                ORDER BY sla_priority, package_name
            `;

            if (rows.length === 0) {
                // Return hardcoded defaults so the UI always has something to show
                const defaults = Object.entries(CAPACITY_CONFIG).map(([name, cfg], i) => ({
                    package_name:         name,
                    complexity_weight:    cfg.complexityWeight,
                    avg_handling_minutes: cfg.avgHandlingMinutes,
                    max_concurrent_chats: cfg.maxConcurrentChats,
                    sla_priority:         i + 1,
                    is_scheduled_workload: cfg.isScheduledWorkload,
                }));
                return res.json({ configs: defaults, source: 'defaults' });
            }

            res.json({ configs: rows, source: 'database' });
        } catch (err) {
            res.status(500).json({ error: 'Failed to fetch capacity config', details: err.message });
        }
    });

    // ── PUT /api/capacity-config/:package ─────────────────────────────────────
    // Updates a single package's capacity config in the DB.
    // Body: { complexity_weight, avg_handling_minutes, max_concurrent_chats }
    router.put('/capacity-config/:package', requireAdmin, async (req, res) => {
        try {
            const pkgName = req.params.package;
            const { complexity_weight, avg_handling_minutes, max_concurrent_chats } = req.body || {};

            const cw  = parseFloat(complexity_weight);
            const ahm = parseFloat(avg_handling_minutes);
            const mcc = parseInt(max_concurrent_chats, 10);

            if (isNaN(cw)  || cw  < 0.1 || cw  > 5)   return res.status(400).json({ error: 'complexity_weight must be 0.1–5' });
            if (isNaN(ahm) || ahm < 1   || ahm > 120)  return res.status(400).json({ error: 'avg_handling_minutes must be 1–120' });
            if (isNaN(mcc) || mcc < 1   || mcc > 20)   return res.status(400).json({ error: 'max_concurrent_chats must be 1–20' });

            const existing = await sql`
                SELECT id FROM agent_capacity_config WHERE package_name = ${pkgName}
            `;

            if (existing.length === 0) {
                // Seed from defaults first
                const def = CAPACITY_CONFIG[pkgName];
                if (!def) return res.status(404).json({ error: `Unknown package: ${pkgName}` });

                await sql`
                    INSERT INTO agent_capacity_config
                        (package_name, complexity_weight, avg_handling_minutes,
                         max_concurrent_chats, sla_priority, is_scheduled_workload)
                    VALUES
                        (${pkgName}, ${cw}, ${ahm}, ${mcc},
                         ${Object.keys(CAPACITY_CONFIG).indexOf(pkgName) + 1},
                         ${def.isScheduledWorkload})
                `;
            } else {
                await sql`
                    UPDATE agent_capacity_config
                    SET complexity_weight    = ${cw},
                        avg_handling_minutes = ${ahm},
                        max_concurrent_chats = ${mcc},
                        updated_at           = NOW()
                    WHERE package_name = ${pkgName}
                `;
            }

            res.json({ success: true, package_name: pkgName, complexity_weight: cw, avg_handling_minutes: ahm, max_concurrent_chats: mcc });
        } catch (err) {
            res.status(500).json({ error: 'Failed to update capacity config', details: err.message });
        }
    });

    return router;
};
