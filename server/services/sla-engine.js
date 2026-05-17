// SlaEngine — runs every 15 minutes, computes per-package SLA risk scores,
// persists them to sla_risk_scores, and broadcasts via SSE.
//
// In Phase 3, per-package queue data isn't available from Supabase (we don't
// have package IDs). Risk is distributed across packages proportionally by
// SLA priority weight. Phase 5 will replace this with true per-package polling.

const { SLA_RULES, UTC_OFFSET } = require('../constants/sla-rules');

const ENGINE_INTERVAL_MS = 15 * 60 * 1000;

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

// Packages that participate in live SLA risk scoring (exclude scheduled workloads)
const LIVE_PACKAGES = Object.entries(SLA_RULES).filter(([, r]) => !r.isScheduled);

// Sum of all priority weights (used to distribute global queue proportionally)
const TOTAL_PRIORITY_WEIGHT = LIVE_PACKAGES.reduce((s, [, r]) => s + (5 - r.priority), 0);

class SlaEngine {
    constructor({ sql, queueEngine, broadcast }) {
        this.sql         = sql;
        this.queueEngine = queueEngine;
        this.broadcast   = broadcast;
        this._timer      = null;
        this.latestScores = {};   // { packageName: scoreRow }
    }

    start() {
        this._runSafe();
        this._timer = setInterval(() => this._runSafe(), ENGINE_INTERVAL_MS);
        console.log('[SlaEngine] started — runs every 15 min');
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

        // ── Aggregate hourly stats (last 3 hours from hourly_demand_snapshots) ──
        const hourNow     = now.getUTCHours() + UTC_OFFSET; // local hour
        const lookback    = Math.max(0, hourNow - 3);

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
        const periods        = Math.max(agg.periods, 1);
        const avgIncoming    = agg.total_incoming / periods;  // chats/hour
        const avgHandling    = agg.total_handled  / periods;

        // ── Today's handled vs pending ────────────────────────────────────────
        const [snap] = await this.sql`
            SELECT COALESCE(SUM(demand_count), 0)::int AS total_demand
            FROM demand_snapshots
            WHERE snapshot_date = CURRENT_DATE
        `;
        const totalDemandToday = snap.total_demand;
        const globalPending    = queueState.global_total || 0;
        const handledToday     = Math.max(0, totalDemandToday - globalPending);
        const currentSlaRate   = totalDemandToday > 0
            ? (handledToday / totalDemandToday) * 100
            : 100;

        // ── Per-package scores ────────────────────────────────────────────────
        const scores = {};

        for (const [pkgName, rule] of LIVE_PACKAGES) {
            const weight    = (5 - rule.priority) / TOTAL_PRIORITY_WEIGHT;
            const hoursLeft = this._hoursLeftInWindow(rule, now);

            // Distribute global queue proportionally to SLA priority
            const estimatedQueue = Math.round(globalPending * weight);
            const incomingRate   = avgIncoming * weight;
            const handlingRate   = avgHandling  * weight;

            // Net rate (chats/hour): positive = growing, negative = shrinking
            const netRate = incomingRate - handlingRate;

            // Projected queue at EOD
            const projectedQueueEod = Math.max(0, estimatedQueue + netRate * hoursLeft);

            // Projected SLA at EOD
            const myHandledToday = handledToday * weight;
            const expectedTotal  = myHandledToday + estimatedQueue;
            const projectedSlaEod = expectedTotal > 0
                ? clamp(((expectedTotal - projectedQueueEod) / expectedTotal) * 100, 0, 100)
                : 100;

            // Projected queue in 1 hour
            const projectedQueue1h = Math.max(0, estimatedQueue + netRate);

            // Estimated oldest pending: time it would take to drain the queue at handling rate
            const oldestPendingMinutes = handlingRate > 0
                ? clamp((estimatedQueue / handlingRate) * 60, 0, rule.maxMinutes ?? 1440)
                : 0;

            const { riskScore, riskLevel } = this._riskScore({
                currentSlaRate,
                projectedSlaEod,
                queueDepth:          estimatedQueue,
                incomingRate,
                handlingRate,
                oldestPendingMinutes,
                slaWindowMinutes:    rule.maxMinutes,
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
            };

            // Persist (round computed_at to the minute to allow upsert)
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
                         ${s.package_name},   ${s.risk_level},        ${s.risk_score},
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
        console.log(`[SlaEngine] computed ${Object.keys(scores).length} package scores — global pending: ${globalPending}`);
    }

    // Hours remaining in a package's operational window today (local time)
    _hoursLeftInWindow(rule, now) {
        const localHour = (now.getUTCHours() + UTC_OFFSET) % 24;
        const localDay  = (now.getUTCDay() + (localHour < 0 ? -1 : 0) + 7) % 7;
        if (!rule.days.includes(localDay)) return 0;
        if (localHour >= rule.endHour)     return 0;
        if (localHour <  rule.startHour)   return rule.endHour - rule.startHour;
        return Math.max(0, rule.endHour - localHour);
    }

    _riskScore({ currentSlaRate, projectedSlaEod, queueDepth, incomingRate, handlingRate, oldestPendingMinutes, slaWindowMinutes }) {
        // Component 1: queue capacity pressure (are we falling behind?)
        const capacityRatio  = incomingRate / Math.max(handlingRate, 0.01);
        const queuePressure  = clamp(capacityRatio - 0.5, 0, 1);

        // Component 2: SLA erosion (how far below 95% are we projected to land?)
        const slaGap = clamp((95 - projectedSlaEod) / 95, 0, 1);

        // Component 3: breach urgency (oldest chat as % of SLA window)
        const breachUrgency = slaWindowMinutes
            ? clamp(oldestPendingMinutes / slaWindowMinutes, 0, 1.5)
            : 0;

        const rawScore  = (queuePressure * 0.35 + slaGap * 0.40 + breachUrgency * 0.25) * 100;
        const riskScore = clamp(rawScore, 0, 100);
        const riskLevel = riskScore >= 75 ? 'critical'
            : riskScore >= 50 ? 'high'
            : riskScore >= 25 ? 'medium'
            : 'low';

        return { riskScore, riskLevel };
    }
}

module.exports = SlaEngine;
