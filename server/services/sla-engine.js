// SlaEngine v2 — per-package SLA risk scoring.
//
// When agent_capacity_config.supabase_package_id is populated for a package,
// the engine polls Supabase directly for that package's actual pending count
// (fixes D4: "per-package SLA is proportional fake").
//
// Packages without a supabase_package_id fall back to the proportional
// distribution from global queue counts (legacy behaviour, safe default).

const { SLA_RULES, UTC_OFFSET, TENANT_ID } = require('../constants/sla-rules');

const ENGINE_INTERVAL_MS = 15 * 60 * 1000;

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

const LIVE_PACKAGES = Object.entries(SLA_RULES).filter(([, r]) => !r.isScheduled);
const TOTAL_PRIORITY_WEIGHT = LIVE_PACKAGES.reduce((s, [, r]) => s + (5 - r.priority), 0);

class SlaEngine {
    constructor({ sql, supabase, ensureSupabaseAuth, queueEngine, broadcast }) {
        this.sql                = sql;
        this.supabase           = supabase;
        this.ensureSupabaseAuth = ensureSupabaseAuth;
        this.queueEngine        = queueEngine;
        this.broadcast          = broadcast;
        this._timer             = null;
        this.latestScores       = {};

        // Cache: packageName → supabase_package_id (null = use proportional fallback)
        this._pkgIdCache     = null;
        this._pkgIdCachedAt  = 0;
        this._PKG_ID_TTL_MS  = 5 * 60_000;
    }

    start() {
        this._runSafe();
        this._timer = setInterval(() => this._runSafe(), ENGINE_INTERVAL_MS);
        console.log('[SlaEngine] v2 started — per-package polling when IDs configured, runs every 15 min');
    }

    stop() { if (this._timer) clearInterval(this._timer); }

    getScores() { return Object.values(this.latestScores); }

    // ── private ──────────────────────────────────────────────────────────────

    _runSafe() {
        this._compute().catch(err =>
            console.error('[SlaEngine] run error:', err.message)
        );
    }

    async _compute() {
        const now        = new Date();
        const queueState = this.queueEngine.getState();
        const globalPending = queueState.global_total || 0;

        // Load package → supabase_package_id mapping
        const pkgIds = await this._loadPkgIds();

        // Identify packages that have a configured Supabase ID
        const configuredPkgs = LIVE_PACKAGES.filter(([name]) => pkgIds[name] != null);

        // Fire per-package Supabase RPC calls in parallel for configured packages
        const perPkgCounts = {};
        if (configuredPkgs.length > 0 && this.supabase) {
            try {
                await this.ensureSupabaseAuth();
                const rpcBase = {
                    p_assigned_staff_id: null, p_client_gender: null, p_coach_id: null,
                    p_ghost_days: null, p_ghost_only: false, p_last_interaction: null,
                    p_last_interaction_from: null, p_last_interaction_to: null,
                    p_last_message_from: 'client',
                    p_limit: 1, p_no_assigned_staff: false, p_offset: 0,
                    p_search: null, p_staff_id: null,
                    p_subscription_start_date: null, p_subscription_start_weekday: null,
                    p_subscription_status: null, p_subscription_t_status: null,
                    p_tenant_id: TENANT_ID, p_unread_only: false,
                };
                const results = await Promise.all(
                    configuredPkgs.map(([name]) =>
                        this.supabase.rpc('get_chat_rooms_paginated', {
                            ...rpcBase,
                            p_package_id: pkgIds[name],
                        })
                    )
                );
                configuredPkgs.forEach(([name], i) => {
                    if (!results[i].error) {
                        perPkgCounts[name] = results[i].data?.total ?? 0;
                    }
                });
            } catch (err) {
                console.warn('[SlaEngine] per-package Supabase poll failed, using proportional fallback:', err.message);
            }
        }

        // ── Aggregate hourly stats (last 3 hours) ─────────────────────────────
        const hourNow  = now.getUTCHours() + UTC_OFFSET;
        const lookback = Math.max(0, hourNow - 3);

        const [agg] = await this.sql`
            SELECT
                COALESCE(SUM(incoming_count), 0)::float AS total_incoming,
                COALESCE(SUM(handled_count),  0)::float AS total_handled,
                COUNT(*)::int                            AS periods
            FROM hourly_demand_snapshots
            WHERE snapshot_date = CURRENT_DATE
              AND snapshot_hour >= ${lookback}
              AND package_name  = 'all'
        `;
        const periods     = Math.max(agg.periods, 1);
        const avgIncoming = agg.total_incoming / periods;
        const avgHandling = agg.total_handled  / periods;

        const [snap] = await this.sql`
            SELECT COALESCE(SUM(demand_count), 0)::int AS total_demand
            FROM demand_snapshots
            WHERE snapshot_date = CURRENT_DATE
        `;
        const totalDemandToday = snap.total_demand;
        const handledToday     = Math.max(0, totalDemandToday - globalPending);
        const currentSlaRate   = totalDemandToday > 0
            ? (handledToday / totalDemandToday) * 100 : 100;

        // ── Per-package scores ────────────────────────────────────────────────
        const scores = {};

        for (const [pkgName, rule] of LIVE_PACKAGES) {
            const weight    = (5 - rule.priority) / TOTAL_PRIORITY_WEIGHT;
            const hoursLeft = this._hoursLeftInWindow(rule, now);

            // Use real count when available, proportional fallback otherwise
            const hasRealCount   = pkgName in perPkgCounts;
            const estimatedQueue = hasRealCount
                ? perPkgCounts[pkgName]
                : Math.round(globalPending * weight);

            const incomingRate = avgIncoming * weight;
            const handlingRate = avgHandling  * weight;
            const netRate      = incomingRate - handlingRate;

            const projectedQueueEod = Math.max(0, estimatedQueue + netRate * hoursLeft);
            const myHandledToday    = handledToday * weight;
            const expectedTotal     = myHandledToday + estimatedQueue;
            const projectedSlaEod   = expectedTotal > 0
                ? clamp(((expectedTotal - projectedQueueEod) / expectedTotal) * 100, 0, 100)
                : 100;
            const projectedQueue1h  = Math.max(0, estimatedQueue + netRate);

            const oldestPendingMinutes = handlingRate > 0
                ? clamp((estimatedQueue / handlingRate) * 60, 0, rule.maxMinutes ?? 1440) : 0;

            const { riskScore, riskLevel } = this._riskScore({
                currentSlaRate, projectedSlaEod, queueDepth: estimatedQueue,
                incomingRate, handlingRate, oldestPendingMinutes,
                slaWindowMinutes: rule.maxMinutes,
            });

            const agentsNeeded = incomingRate > handlingRate
                ? Math.ceil((incomingRate - handlingRate) / Math.max(handlingRate / LIVE_PACKAGES.length, 0.1))
                : 0;

            scores[pkgName] = {
                package_name:       pkgName,
                risk_level:         riskLevel,
                risk_score:         Math.round(riskScore * 10) / 10,
                current_sla_rate:   Math.round(currentSlaRate * 10) / 10,
                projected_sla_1h:   Math.round(clamp(((expectedTotal - projectedQueue1h) / Math.max(expectedTotal, 1)) * 100, 0, 100) * 10) / 10,
                projected_sla_eod:  Math.round(projectedSlaEod * 10) / 10,
                breach_probability: Math.round(riskScore * 10) / 10,
                predicted_breaches: Math.round(projectedQueueEod),
                current_queue:      estimatedQueue,
                projected_queue_1h: Math.round(projectedQueue1h),
                incoming_rate:      Math.round(incomingRate * 10) / 10,
                handling_rate:      Math.round(handlingRate * 10) / 10,
                agents_needed:      agentsNeeded,
                count_source:       hasRealCount ? 'supabase' : 'proportional',
            };

            try {
                const s = scores[pkgName];
                await this.sql`
                    INSERT INTO sla_risk_scores
                        (computed_at, package_name, risk_level, risk_score,
                         current_sla_rate, projected_sla_1h, projected_sla_eod,
                         breach_probability, predicted_breaches,
                         current_queue, projected_queue_1h,
                         incoming_rate, handling_rate, agents_needed)
                    VALUES
                        (date_trunc('minute', NOW()),
                         ${s.package_name},    ${s.risk_level},        ${s.risk_score},
                         ${s.current_sla_rate}, ${s.projected_sla_1h}, ${s.projected_sla_eod},
                         ${s.breach_probability}, ${s.predicted_breaches},
                         ${s.current_queue},   ${s.projected_queue_1h},
                         ${s.incoming_rate},   ${s.handling_rate},     ${s.agents_needed})
                    ON CONFLICT (computed_at, package_name) DO UPDATE SET
                        risk_level         = EXCLUDED.risk_level,
                        risk_score         = EXCLUDED.risk_score,
                        current_sla_rate   = EXCLUDED.current_sla_rate,
                        projected_sla_1h   = EXCLUDED.projected_sla_1h,
                        projected_sla_eod  = EXCLUDED.projected_sla_eod,
                        breach_probability = EXCLUDED.breach_probability,
                        predicted_breaches = EXCLUDED.predicted_breaches,
                        current_queue      = EXCLUDED.current_queue,
                        projected_queue_1h = EXCLUDED.projected_queue_1h,
                        incoming_rate      = EXCLUDED.incoming_rate,
                        handling_rate      = EXCLUDED.handling_rate,
                        agents_needed      = EXCLUDED.agents_needed
                `;
            } catch (err) {
                console.error(`[SlaEngine] persist failed for ${pkgName}:`, err.message);
            }
        }

        this.latestScores = scores;
        this.broadcast('sla_risk', Object.values(scores));

        const realCount = Object.values(scores).filter(s => s.count_source === 'supabase').length;
        console.log(
            `[SlaEngine] computed ${Object.keys(scores).length} packages — ` +
            `${realCount} with real counts, ${Object.keys(scores).length - realCount} proportional`
        );
    }

    async _loadPkgIds() {
        if (this._pkgIdCache && Date.now() - this._pkgIdCachedAt < this._PKG_ID_TTL_MS) {
            return this._pkgIdCache;
        }
        try {
            const rows = await this.sql`
                SELECT package_name, supabase_package_id
                FROM agent_capacity_config
                WHERE supabase_package_id IS NOT NULL
            `;
            const map = {};
            for (const r of rows) map[r.package_name] = r.supabase_package_id;
            this._pkgIdCache    = map;
            this._pkgIdCachedAt = Date.now();
            return map;
        } catch {
            return {};
        }
    }

    _hoursLeftInWindow(rule, now) {
        const localHour = (now.getUTCHours() + UTC_OFFSET) % 24;
        const localDay  = (now.getUTCDay() + (localHour < 0 ? -1 : 0) + 7) % 7;
        if (!rule.days.includes(localDay)) return 0;
        if (localHour >= rule.endHour)     return 0;
        if (localHour <  rule.startHour)   return rule.endHour - rule.startHour;
        return Math.max(0, rule.endHour - localHour);
    }

    _riskScore({ currentSlaRate, projectedSlaEod, queueDepth, incomingRate, handlingRate, oldestPendingMinutes, slaWindowMinutes }) {
        const capacityRatio = incomingRate / Math.max(handlingRate, 0.01);
        const queuePressure = clamp(capacityRatio - 0.5, 0, 1);
        const slaGap        = clamp((95 - projectedSlaEod) / 95, 0, 1);
        const breachUrgency = slaWindowMinutes
            ? clamp(oldestPendingMinutes / slaWindowMinutes, 0, 1.5) : 0;

        const rawScore  = (queuePressure * 0.35 + slaGap * 0.40 + breachUrgency * 0.25) * 100;
        const riskScore = clamp(rawScore, 0, 100);
        const riskLevel = riskScore >= 75 ? 'critical'
            : riskScore >= 50 ? 'high'
            : riskScore >= 25 ? 'medium' : 'low';

        return { riskScore, riskLevel };
    }
}

module.exports = SlaEngine;
