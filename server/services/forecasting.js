const { SLA_RULES, UTC_OFFSET } = require('../constants/sla-rules');

// Mirrors agent_capacity_config seed data from the architectural plan.
// Used by both the forecasting engine and the what-if simulator.
const CAPACITY_CONFIG = {
    'Fit Solo Pro': { complexityWeight: 1.5, avgHandlingMinutes: 12, maxConcurrentChats: 2, isScheduledWorkload: false },
    'Fit Fam Pro':  { complexityWeight: 1.5, avgHandlingMinutes: 12, maxConcurrentChats: 2, isScheduledWorkload: false },
    'Fit Solo':     { complexityWeight: 1.0, avgHandlingMinutes: 10, maxConcurrentChats: 3, isScheduledWorkload: false },
    'Fit Duo':      { complexityWeight: 1.0, avgHandlingMinutes: 10, maxConcurrentChats: 3, isScheduledWorkload: false },
    'Fit Fam':      { complexityWeight: 1.1, avgHandlingMinutes: 11, maxConcurrentChats: 3, isScheduledWorkload: false },
    'Fit Express':  { complexityWeight: 0.4, avgHandlingMinutes:  5, maxConcurrentChats: 5, isScheduledWorkload: true  },
};

function computeStdDev(series) {
    if (series.length < 2) return 0;
    const mean = series.reduce((a, b) => a + b, 0) / series.length;
    const variance = series.reduce((sum, x) => sum + (x - mean) ** 2, 0) / (series.length - 1);
    return Math.sqrt(variance);
}

function runEma(series, alpha) {
    let ema = series[0];
    for (let i = 1; i < series.length; i++) {
        ema = alpha * series[i] + (1 - alpha) * ema;
    }
    return ema;
}

// Minimize MSE over the training window to pick optimal smoothing factor.
function computeOptimalAlpha(series) {
    if (series.length < 3) return 0.3;
    let bestAlpha = 0.3, bestMse = Infinity;
    for (let a = 0.1; a <= 0.9; a += 0.05) {
        let ema = series[0], mse = 0;
        for (let i = 1; i < series.length; i++) {
            const err = ema - series[i];
            mse += err * err;
            ema = a * series[i] + (1 - a) * ema;
        }
        mse /= series.length - 1;
        if (mse < bestMse) { bestMse = mse; bestAlpha = a; }
    }
    return Math.round(bestAlpha * 100) / 100;
}

// Agents needed to clear forecasted demand in one shift with a 15% SLA buffer.
function staffingRequired(forecastDemand, shiftHours, pkgName) {
    const cfg = CAPACITY_CONFIG[pkgName];
    if (!cfg || cfg.isScheduledWorkload || shiftHours <= 0) return 0;
    const chatsPerAgentPerShift = (shiftHours * 60) / (cfg.avgHandlingMinutes * cfg.complexityWeight);
    return Math.ceil((forecastDemand / Math.max(chatsPerAgentPerShift, 1)) * 1.15);
}

class ForecastingService {
    constructor({ sql }) {
        this.sql    = sql;
        this._timer = null;
    }

    start() {
        // Run once immediately (seeds models on first deploy), then nightly at midnight local.
        this._runSafe();
        this._scheduleNext();
        console.log('[Forecasting] started — initial run triggered, then nightly at midnight');
    }

    stop() {
        if (this._timer) clearTimeout(this._timer);
    }

    _scheduleNext() {
        const now       = Date.now();
        const localNow  = new Date(now + UTC_OFFSET * 3_600_000);
        const tomorrow  = new Date(localNow);
        tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
        tomorrow.setUTCHours(0 - UTC_OFFSET, 1, 0, 0); // 00:01 local next day
        const delay = Math.max(tomorrow.getTime() - now, 60_000);
        this._timer = setTimeout(() => {
            this._runSafe();
            // After first scheduled run, repeat every 24 h.
            this._timer = setInterval(() => this._runSafe(), 24 * 3_600_000);
        }, delay);
    }

    _runSafe() {
        this.recomputeModels().catch(err =>
            console.error('[Forecasting] run error:', err.message)
        );
    }

    async recomputeModels() {
        console.log('[Forecasting] recomputing forecast models…');

        // Last 8 weeks of per-agent daily snapshots with package breakdown.
        const history = await this.sql`
            SELECT
                EXTRACT(DOW FROM snapshot_date)::int AS weekday,
                package_breakdown,
                SUM(demand_count)::int               AS total_demand
            FROM demand_snapshots
            WHERE snapshot_date >= CURRENT_DATE - INTERVAL '56 days'
              AND agent_id IS NOT NULL
            GROUP BY snapshot_date, package_breakdown
            ORDER BY snapshot_date ASC
        `;

        // Build { pkgName: { weekday: [demand, ...] } }
        const demandMap = {};

        for (const row of history) {
            const breakdown = row.package_breakdown || {};
            for (const [pkgName, demand] of Object.entries(breakdown)) {
                if (!demandMap[pkgName]) demandMap[pkgName] = {};
                const wd = row.weekday;
                if (!demandMap[pkgName][wd]) demandMap[pkgName][wd] = [];
                demandMap[pkgName][wd].push(Number(demand));
            }
        }

        // If no package breakdown yet, distribute total demand evenly across live packages.
        if (Object.keys(demandMap).length === 0) {
            const totals = {};
            for (const row of history) {
                const wd = row.weekday;
                if (!totals[wd]) totals[wd] = [];
                totals[wd].push(Number(row.total_demand));
            }
            const livePkgs = Object.entries(SLA_RULES)
                .filter(([, r]) => !r.isScheduled).map(([n]) => n);
            for (const pkgName of livePkgs) {
                demandMap[pkgName] = {};
                for (const [wd, series] of Object.entries(totals)) {
                    demandMap[pkgName][wd] = series.map(d =>
                        Math.round(d / livePkgs.length)
                    );
                }
            }
        }

        let written = 0;
        for (const [pkgName, byWeekday] of Object.entries(demandMap)) {
            const rule      = SLA_RULES[pkgName];
            const shiftHrs  = rule ? (rule.endHour - rule.startHour) : 7;

            for (const [wdStr, series] of Object.entries(byWeekday)) {
                if (series.length < 2) continue;
                const weekday    = parseInt(wdStr);
                const alpha      = computeOptimalAlpha(series);
                const ema        = runEma(series, alpha);
                const stdDev     = computeStdDev(series);
                const avgDaily   = series.reduce((a, b) => a + b, 0) / series.length;
                const seasonality = avgDaily > 0 ? ema / avgDaily : 1;
                const agentsReq  = staffingRequired(ema, shiftHrs, pkgName);

                try {
                    await this.sql`
                        INSERT INTO forecast_models
                            (package_name, weekday, model_type, alpha, forecast_demand,
                             seasonality_index, std_deviation, agents_required,
                             confidence_low, confidence_high, last_computed_at)
                        VALUES
                            (${pkgName}, ${weekday}, 'ema',
                             ${Math.round(alpha * 1000) / 1000},
                             ${Math.round(ema)},
                             ${Math.round(seasonality * 1000) / 1000},
                             ${Math.round(stdDev * 10) / 10},
                             ${agentsReq},
                             ${Math.max(0, Math.round(ema - 1.96 * stdDev))},
                             ${Math.round(ema + 1.96 * stdDev)},
                             NOW())
                        ON CONFLICT (package_name, weekday) DO UPDATE SET
                            model_type        = 'ema',
                            alpha             = EXCLUDED.alpha,
                            forecast_demand   = EXCLUDED.forecast_demand,
                            seasonality_index = EXCLUDED.seasonality_index,
                            std_deviation     = EXCLUDED.std_deviation,
                            agents_required   = EXCLUDED.agents_required,
                            confidence_low    = EXCLUDED.confidence_low,
                            confidence_high   = EXCLUDED.confidence_high,
                            last_computed_at  = NOW()
                    `;
                    written++;
                } catch (err) {
                    console.error(`[Forecasting] persist failed ${pkgName} wd${weekday}:`, err.message);
                }
            }
        }

        console.log(`[Forecasting] done — ${written} model rows written`);
    }
}

module.exports = { ForecastingService, CAPACITY_CONFIG, staffingRequired };
