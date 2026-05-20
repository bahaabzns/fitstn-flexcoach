const { SLA_RULES, UTC_OFFSET } = require('../constants/sla-rules');

const CAPACITY_CONFIG = {
    'Fit Solo Pro': { complexityWeight: 1.5, avgHandlingMinutes: 12, maxConcurrentChats: 2, isScheduledWorkload: false },
    'Fit Fam Pro':  { complexityWeight: 1.5, avgHandlingMinutes: 12, maxConcurrentChats: 2, isScheduledWorkload: false },
    'Fit Solo':     { complexityWeight: 1.0, avgHandlingMinutes: 10, maxConcurrentChats: 3, isScheduledWorkload: false },
    'Fit Duo':      { complexityWeight: 1.0, avgHandlingMinutes: 10, maxConcurrentChats: 3, isScheduledWorkload: false },
    'Fit Fam':      { complexityWeight: 1.1, avgHandlingMinutes: 11, maxConcurrentChats: 3, isScheduledWorkload: false },
    'Fit Express':  { complexityWeight: 0.4, avgHandlingMinutes:  5, maxConcurrentChats: 5, isScheduledWorkload: true  },
};

function staffingRequired(forecastDemand, shiftHours, pkgName) {
    const cfg = CAPACITY_CONFIG[pkgName];
    if (!cfg || cfg.isScheduledWorkload || shiftHours <= 0) return 0;
    const chatsPerAgentPerShift = (shiftHours * 60) / (cfg.avgHandlingMinutes * cfg.complexityWeight);
    return Math.ceil((forecastDemand / Math.max(chatsPerAgentPerShift, 1)) * 1.15);
}

// ── EMA (kept as fallback when series < 6 weeks) ─────────────────────────────

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

function runEma(series, alpha) {
    let ema = series[0];
    for (let i = 1; i < series.length; i++) ema = alpha * series[i] + (1 - alpha) * ema;
    return ema;
}

function computeStdDev(series) {
    if (series.length < 2) return 0;
    const mean = series.reduce((a, b) => a + b, 0) / series.length;
    return Math.sqrt(series.reduce((sum, x) => sum + (x - mean) ** 2, 0) / (series.length - 1));
}

// ── Holt-Winters additive (trend + level, no seasonal — daily cadence) ────────
//
// We use Holt's double exponential smoothing (trend + level) rather than full
// triple HW because our granularity is daily per weekday, not intra-day.
// Per-weekday seasonality is handled by the weekday-bucketed training data.
//
// Parameters:
//   alpha ∈ (0,1) — level smoothing
//   beta  ∈ (0,1) — trend smoothing
//
// Returns { forecast, stdDev, alpha, beta, trend }

function holtsDoubleExp(series, alpha, beta) {
    if (series.length < 2) return null;
    let L = series[0];
    let T = series[1] - series[0];
    const errors = [];

    for (let i = 1; i < series.length; i++) {
        const Lprev = L;
        L = alpha * series[i] + (1 - alpha) * (L + T);
        T = beta  * (L - Lprev) + (1 - beta) * T;
        errors.push(series[i] - (Lprev + T));
    }

    const forecast = L + T;
    const stdDev   = computeStdDev(errors);
    return { forecast: Math.max(0, forecast), stdDev, alpha, beta, trend: T };
}

// Grid search over (alpha, beta) to minimise MSE on training data.
function fitHoltsParams(series) {
    if (series.length < 4) return { alpha: 0.3, beta: 0.1 };
    let best = { mse: Infinity, alpha: 0.3, beta: 0.1 };
    for (let a = 0.1; a <= 0.9; a += 0.1) {
        for (let b = 0.05; b <= 0.5; b += 0.05) {
            let L = series[0], T = series[1] - series[0], mse = 0, n = 0;
            for (let i = 1; i < series.length; i++) {
                const pred = L + T;
                const err  = series[i] - pred;
                mse += err * err; n++;
                const Lprev = L;
                L = a * series[i] + (1 - a) * (L + T);
                T = b * (L - Lprev) + (1 - b) * T;
            }
            mse /= Math.max(n, 1);
            if (mse < best.mse) best = { mse, alpha: a, beta: b };
        }
    }
    return best;
}

// ── MAPE ──────────────────────────────────────────────────────────────────────

function mape(actuals, predictions) {
    const pairs = actuals.map((a, i) => ({ a, p: predictions[i] }))
        .filter(({ a }) => a > 0);
    if (pairs.length === 0) return null;
    return pairs.reduce((s, { a, p }) => s + Math.abs(a - p) / a, 0) / pairs.length;
}

// ── Backtesting — last-N-points leave-one-out ─────────────────────────────────

function backtest(series, { alpha, beta }, windowSize = 4) {
    if (series.length < windowSize + 2) return { mape: null, predictions: [] };
    const actuals = [], predictions = [];

    for (let i = windowSize; i < series.length; i++) {
        const trainSlice = series.slice(0, i);
        const hw = holtsDoubleExp(trainSlice, alpha, beta);
        if (hw) {
            predictions.push(hw.forecast);
            actuals.push(series[i]);
        }
    }

    return { mape: mape(actuals, predictions), predictions, actuals };
}

// ── ForecastingService ────────────────────────────────────────────────────────

class ForecastingService {
    constructor({ sql }) {
        this.sql    = sql;
        this._timer = null;
    }

    start() {
        this._runSafe();
        this._scheduleNext();
        console.log('[Forecasting] started — Holt-Winters model, initial run triggered, then nightly');
    }

    stop() {
        if (this._timer) clearTimeout(this._timer);
    }

    _scheduleNext() {
        const now      = Date.now();
        const localNow = new Date(now + UTC_OFFSET * 3_600_000);
        const tomorrow = new Date(localNow);
        tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
        tomorrow.setUTCHours(0 - UTC_OFFSET, 1, 0, 0);
        const delay = Math.max(tomorrow.getTime() - now, 60_000);
        this._timer = setTimeout(() => {
            this._runSafe();
            this._timer = setInterval(() => this._runSafe(), 24 * 3_600_000);
        }, delay);
    }

    _runSafe() {
        this.recomputeModels().catch(err =>
            console.error('[Forecasting] run error:', err.message)
        );
    }

    async recomputeModels() {
        console.log('[Forecasting] recomputing models (Holt-Winters)…');

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
                    demandMap[pkgName][wd] = series.map(d => Math.round(d / livePkgs.length));
                }
            }
        }

        let written = 0, backtestRows = 0;

        for (const [pkgName, byWeekday] of Object.entries(demandMap)) {
            const rule     = SLA_RULES[pkgName];
            const shiftHrs = rule ? (rule.endHour - rule.startHour) : 7;

            for (const [wdStr, series] of Object.entries(byWeekday)) {
                if (series.length < 2) continue;
                const weekday = parseInt(wdStr);

                // Choose model: Holt-Winters if ≥ 4 points, EMA otherwise
                let forecast, stdDev, alpha, beta, modelType, seasonalityIndex, trend = 0;
                const avgDaily = series.reduce((a, b) => a + b, 0) / series.length;

                if (series.length >= 4) {
                    const params = fitHoltsParams(series);
                    const hw     = holtsDoubleExp(series, params.alpha, params.beta);
                    if (hw) {
                        forecast        = hw.forecast;
                        stdDev          = hw.stdDev;
                        alpha           = params.alpha;
                        beta            = params.beta;
                        trend           = Math.round(hw.trend * 10) / 10;
                        seasonalityIndex = avgDaily > 0 ? forecast / avgDaily : 1;
                        modelType       = 'holt_winters';

                        // Backtesting — write MAPE to forecast_accuracy
                        const bt = backtest(series, params);
                        if (bt.mape != null) {
                            for (let i = 0; i < bt.actuals.length; i++) {
                                this.sql`
                                    INSERT INTO forecast_accuracy
                                        (computed_at, package_name, weekday, predicted_demand, actual_demand, absolute_pct_error)
                                    VALUES
                                        (NOW(), ${pkgName}, ${weekday},
                                         ${Math.round(bt.predictions[i])},
                                         ${bt.actuals[i]},
                                         ${Math.round(Math.abs(bt.actuals[i] - bt.predictions[i]) / Math.max(bt.actuals[i], 1) * 10000) / 10000})
                                    ON CONFLICT DO NOTHING
                                `.catch(() => {});
                                backtestRows++;
                            }
                        }
                    } else {
                        // fallback
                        alpha  = computeOptimalAlpha(series);
                        const ema = runEma(series, alpha);
                        forecast  = ema;
                        stdDev    = computeStdDev(series);
                        seasonalityIndex = avgDaily > 0 ? ema / avgDaily : 1;
                        modelType = 'ema';
                        beta      = null;
                    }
                } else {
                    alpha  = computeOptimalAlpha(series);
                    const ema = runEma(series, alpha);
                    forecast  = ema;
                    stdDev    = computeStdDev(series);
                    seasonalityIndex = avgDaily > 0 ? ema / avgDaily : 1;
                    modelType = 'ema';
                    beta      = null;
                }

                const agentsReq = staffingRequired(forecast, shiftHrs, pkgName);

                try {
                    await this.sql`
                        INSERT INTO forecast_models
                            (package_name, weekday, model_type, alpha, forecast_demand,
                             seasonality_index, std_deviation, agents_required,
                             confidence_low, confidence_high, last_computed_at)
                        VALUES
                            (${pkgName}, ${weekday}, ${modelType},
                             ${Math.round(alpha * 1000) / 1000},
                             ${Math.round(forecast)},
                             ${Math.round(seasonalityIndex * 1000) / 1000},
                             ${Math.round(stdDev * 10) / 10},
                             ${agentsReq},
                             ${Math.max(0, Math.round(forecast - 1.96 * stdDev))},
                             ${Math.round(forecast + 1.96 * stdDev)},
                             NOW())
                        ON CONFLICT (package_name, weekday) DO UPDATE SET
                            model_type        = EXCLUDED.model_type,
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

        console.log(`[Forecasting] done — ${written} model rows written, ${backtestRows} backtest rows`);
    }
}

module.exports = { ForecastingService, CAPACITY_CONFIG, staffingRequired };
