// AlertEngine v2 — stateful alert lifecycle with fingerprint deduplication.
//
// Fixes D3: same alert no longer repeats every 5 minutes.
// Each alert has a state machine: started → worsening|stable|improving → escalated → resolved.
// A fingerprint (sha1 of alert_type:package:agent) ensures only ONE open alert per scope.
// Transitions are logged to alert_transitions for audit.

const crypto = require('crypto');

const ALERT_INTERVAL_MS   = 5 * 60 * 1000;
const BASELINE_CACHE_MS   = 55 * 60 * 1000;  // re-query DB at most once per hour
const ANOMALY_Z_ALERT     = 3.0;             // |z| threshold to fire an alert
const ANOMALY_Z_WARN      = 2.0;             // |z| threshold to log only

// State machine transitions:
//   started → worsening | stable | improving
//   worsening → escalated | stable | improving
//   stable → worsening | improving
//   improving → worsening | stable | resolved (after cooldown)
//   escalated → stable | improving
//   resolved — terminal (open index removed)
const OPEN_STATES = new Set(['started', 'worsening', 'stable', 'improving', 'escalated']);

function gini(loads) {
    if (loads.length < 2) return 0;
    const sorted = [...loads].sort((a, b) => a - b);
    const n    = sorted.length;
    const mean = sorted.reduce((s, x) => s + x, 0) / n;
    if (mean === 0) return 0;
    const sumDiffs = sorted.reduce(
        (acc, xi) => acc + sorted.reduce((acc2, xj) => acc2 + Math.abs(xi - xj), 0), 0
    );
    return sumDiffs / (2 * n * n * mean);
}

function fingerprint(alertType, packageName, agentId) {
    const raw = `${alertType}:${packageName ?? '∅'}:${agentId ?? '∅'}`;
    return crypto.createHash('sha1').update(raw).digest('hex').slice(0, 16);
}

// Thresholds loaded from ops_config at engine start (falls back to compile-time defaults)
const DEFAULTS = {
    'alert.sla_danger.risk_threshold':       50,
    'alert.sla_danger.critical_threshold':   75,
    'alert.queue_overload.growth_warn':       5,
    'alert.queue_overload.growth_critical':  10,
    'alert.agent_overload.pending_warn':     20,
    'alert.agent_overload.pending_critical': 35,
    'alert.inactive_agent.idle_minutes':     15,
    'alert.workload_imbalance.gini':         0.35,
    'alert.cooldown.sla_danger_min':         10,
    'alert.cooldown.agent_overload_min':     15,
    'alert.cooldown.queue_overload_min':     10,
    'alert.cooldown.inactive_agent_min':      5,
    'alert.cooldown.workload_imbalance_min': 20,
    'alert.escalate.sla_danger_min':         20,
    'alert.escalate.agent_overload_min':     30,
    'alert.escalate.queue_overload_min':     15,
};

const COOLDOWN_KEY = {
    sla_danger:          'alert.cooldown.sla_danger_min',
    agent_overload:      'alert.cooldown.agent_overload_min',
    queue_overload:      'alert.cooldown.queue_overload_min',
    inactive_agent:      'alert.cooldown.inactive_agent_min',
    workload_imbalance:  'alert.cooldown.workload_imbalance_min',
    anomaly_high:        'alert.cooldown.queue_overload_min',
    breach_cluster:      'alert.cooldown.queue_overload_min',  // 10-min cooldown
    client_surge:        'alert.cooldown.queue_overload_min',  // 10-min cooldown
    agent_burnout:       'alert.cooldown.agent_overload_min',  // 15-min cooldown
};
const ESCALATE_KEY = {
    sla_danger:          'alert.escalate.sla_danger_min',
    agent_overload:      'alert.escalate.agent_overload_min',
    queue_overload:      'alert.escalate.queue_overload_min',
};

class AlertEngine {
    constructor({ sql, queueEngine, slaEngine, presenceService, broadcast }) {
        this.sql             = sql;
        this.queueEngine     = queueEngine;
        this.slaEngine       = slaEngine;
        this.presenceService = presenceService;
        this.broadcast       = broadcast;
        this._timer          = null;

        // In-memory index: fingerprint → open alert row
        this._openByFp = new Map();

        // Config cache (reloaded every run)
        this._cfg = { ...DEFAULTS };

        // Anomaly baseline cache: key "wd:h" → { mean, stdDev, cachedAt }
        this._baselineCache = new Map();

        // Burnout tracking: agent_id → { firstSeen: Date, lastPending: number }
        this._burnoutTracking = new Map();
    }

    start() {
        this._runSafe();
        this._timer = setInterval(() => this._runSafe(), ALERT_INTERVAL_MS);
        console.log('[AlertEngine] started — stateful mode, runs every 5 min');
    }

    stop() { if (this._timer) clearInterval(this._timer); }

    // ── private ──────────────────────────────────────────────────────────────

    _runSafe() {
        this._check().catch(err =>
            console.error('[AlertEngine] run error:', err.message)
        );
    }

    async _check() {
        await this._reloadConfig();
        await this._loadOpenAlerts();

        const queueState = this.queueEngine.getState();
        const slaScores  = this.slaEngine.getScores();
        const agents     = await this._agentStatuses();

        const anomalyCandidates = await this._buildAnomalyCandidates(queueState, agents);
        const candidates = [
            ...this._buildCandidates(queueState, slaScores, agents),
            ...anomalyCandidates,
        ];

        const seenFps = new Set();
        let transitions = 0;

        // ── Process each candidate ───────────────────────────────────────────
        for (const c of candidates) {
            const fp  = fingerprint(c.alert_type, c.package_name, c.agent_id);
            seenFps.add(fp);
            const cur = this._openByFp.get(fp);

            if (!cur) {
                // New alert
                const row = await this._insertAlert(c, fp);
                if (row) {
                    this._openByFp.set(fp, row);
                    this._broadcast(row);
                    transitions++;
                }
                continue;
            }

            // Existing open alert — compute trend
            const trend     = this._trend(c.alert_type, cur.metric_value, c.metric_value);
            const ageMin    = (Date.now() - new Date(cur.created_at).getTime()) / 60_000;
            const escalKey  = ESCALATE_KEY[c.alert_type];
            const escalMin  = escalKey ? this._cfg[escalKey] : Infinity;

            let nextState = cur.state;
            if (trend === 'worsening') {
                nextState = (ageMin >= escalMin && cur.state !== 'escalated') ? 'escalated' : 'worsening';
            } else if (trend === 'improving') {
                nextState = 'improving';
            } else {
                nextState = 'stable';
            }

            if (nextState !== cur.state || Math.abs(c.metric_value - cur.metric_value) > 0.01) {
                await this._transition(cur, nextState, c.metric_value, trend);
                this._openByFp.set(fp, { ...cur, state: nextState, metric_value: c.metric_value, last_evaluated_at: new Date() });
                this._broadcast({ ...cur, state: nextState, metric_value: c.metric_value, prev_state: cur.state });
                transitions++;
            } else {
                // Heartbeat — just update last_evaluated_at
                await this.sql`
                    UPDATE operational_alerts
                    SET last_evaluated_at = NOW()
                    WHERE id = ${cur.id}
                `;
            }
        }

        // ── Auto-resolve stale open alerts ───────────────────────────────────
        for (const [fp, cur] of this._openByFp) {
            if (seenFps.has(fp)) continue;

            const cooldownMs = (this._cfg[COOLDOWN_KEY[cur.alert_type]] ?? 10) * 60_000;
            const lastEval   = cur.last_evaluated_at ? new Date(cur.last_evaluated_at) : new Date(cur.created_at);
            const stableMs   = Date.now() - lastEval.getTime();

            if (stableMs >= cooldownMs) {
                await this._transition(cur, 'resolved', cur.metric_value, 'condition_cleared');
                this._openByFp.delete(fp);
                this._broadcast({ ...cur, state: 'resolved', prev_state: cur.state });
                transitions++;
            }
        }

        if (transitions > 0) {
            console.log(`[AlertEngine] ${transitions} state transition(s) this cycle`);
        }
    }

    _buildCandidates(queueState, slaScores, agents) {
        const c     = this._cfg;
        const items = [];

        // SLA danger
        for (const s of slaScores) {
            if (s.risk_score < c['alert.sla_danger.risk_threshold']) continue;
            items.push({
                alert_type:       'sla_danger',
                severity:         s.risk_score >= c['alert.sla_danger.critical_threshold'] ? 'critical' : 'warning',
                title:            `${s.package_name} SLA at risk`,
                body:             `SLA projected ${s.projected_sla_eod}% EOD. Risk score: ${s.risk_score}.`,
                package_name:     s.package_name,
                agent_id:         null,
                metric_value:     s.projected_sla_eod,
                metric_threshold: 90,
            });
        }

        // Global queue overload
        const globalGrowth = queueState.global_growth_rate ?? 0;
        if (globalGrowth > c['alert.queue_overload.growth_warn']) {
            items.push({
                alert_type:       'queue_overload',
                severity:         globalGrowth > c['alert.queue_overload.growth_critical'] ? 'critical' : 'warning',
                title:            'Queue growing rapidly',
                body:             `+${globalGrowth} chats/hr. ${queueState.global_total} pending.`,
                package_name:     null,
                agent_id:         null,
                metric_value:     globalGrowth,
                metric_threshold: c['alert.queue_overload.growth_warn'],
            });
        }

        // Per-agent queue overload
        for (const a of queueState.byAgent ?? []) {
            if (a.growth_rate_per_hour <= c['alert.queue_overload.growth_warn']) continue;
            items.push({
                alert_type:       'queue_overload',
                severity:         'warning',
                title:            `${a.agent_name} queue growing`,
                body:             `+${a.growth_rate_per_hour}/hr. ${a.pending_count} pending.`,
                package_name:     null,
                agent_id:         a.agent_id,
                metric_value:     a.growth_rate_per_hour,
                metric_threshold: c['alert.queue_overload.growth_warn'],
            });
        }

        // Inactive agents
        const idleMin = c['alert.inactive_agent.idle_minutes'];
        if (queueState.global_total > 0) {
            for (const a of agents) {
                if (a.status !== 'idle' || a.idle_minutes < idleMin) continue;
                items.push({
                    alert_type:       'inactive_agent',
                    severity:         'warning',
                    title:            `${a.name} idle ${Math.round(a.idle_minutes)}m`,
                    body:             `On shift but no sessions. ${queueState.global_total} chats pending.`,
                    package_name:     null,
                    agent_id:         a.id,
                    metric_value:     a.idle_minutes,
                    metric_threshold: idleMin,
                });
            }
        }

        // Agent overload
        for (const qa of queueState.byAgent ?? []) {
            if (qa.pending_count <= c['alert.agent_overload.pending_warn']) continue;
            items.push({
                alert_type:       'agent_overload',
                severity:         qa.pending_count > c['alert.agent_overload.pending_critical'] ? 'critical' : 'warning',
                title:            `${qa.agent_name} overloaded`,
                body:             `${qa.pending_count} chats pending. Growth: ${qa.growth_rate_per_hour > 0 ? '+' : ''}${qa.growth_rate_per_hour}/hr.`,
                package_name:     null,
                agent_id:         qa.agent_id,
                metric_value:     qa.pending_count,
                metric_threshold: c['alert.agent_overload.pending_warn'],
            });
        }

        // Workload imbalance
        const byAgent = queueState.byAgent ?? [];
        if (byAgent.length >= 2) {
            const loads = byAgent.map(a => a.pending_count);
            const g = gini(loads);
            if (g > c['alert.workload_imbalance.gini']) {
                const sorted     = [...byAgent].sort((a, b) => b.pending_count - a.pending_count);
                const over       = sorted[0];
                const under      = sorted[sorted.length - 1];
                const diff       = Math.round((over.pending_count - under.pending_count) / 2);
                items.push({
                    alert_type:       'workload_imbalance',
                    severity:         'warning',
                    title:            'Workload imbalance detected',
                    body:             `Reassign ~${diff} chats from ${over.agent_name} → ${under.agent_name}. Gini: ${Math.round(g * 100) / 100}.`,
                    package_name:     null,
                    agent_id:         null,
                    metric_value:     Math.round(g * 100) / 100,
                    metric_threshold: c['alert.workload_imbalance.gini'],
                });
            }
        }

        return items;
    }

    // Classify metric change direction for the given alert type
    _trend(alertType, prevValue, newValue) {
        if (!prevValue) return 'worsening';
        const delta = newValue - prevValue;
        const threshold = prevValue * 0.03; // 3% noise band

        // For sla_danger: lower projected_sla_eod = worse
        if (alertType === 'sla_danger') {
            if (delta < -threshold) return 'worsening';
            if (delta > threshold)  return 'improving';
            return 'stable';
        }
        // For everything else: higher metric = worse
        if (delta > threshold)  return 'worsening';
        if (delta < -threshold) return 'improving';
        return 'stable';
    }

    async _insertAlert(candidate, fp) {
        try {
            const [row] = await this.sql`
                INSERT INTO operational_alerts
                    (severity, alert_type, title, body,
                     package_name, agent_id, metric_value, metric_threshold,
                     fingerprint, state, last_evaluated_at)
                VALUES
                    (${candidate.severity}, ${candidate.alert_type}, ${candidate.title},
                     ${candidate.body ?? null},
                     ${candidate.package_name ?? null}, ${candidate.agent_id ?? null},
                     ${candidate.metric_value ?? null}, ${candidate.metric_threshold ?? null},
                     ${fp}, 'started', NOW())
                RETURNING *
            `;
            await this._logTransition(row.id, null, 'started', candidate.metric_value, 'new_condition');
            return row;
        } catch (err) {
            // Unique constraint violation means another process beat us — load existing
            if (err.code === '23505') {
                const [existing] = await this.sql`
                    SELECT * FROM operational_alerts WHERE fingerprint = ${fp} AND state = ANY(${[...OPEN_STATES]})
                `;
                return existing ?? null;
            }
            console.error('[AlertEngine] insert failed:', err.message);
            return null;
        }
    }

    async _transition(cur, toState, metricValue, reason) {
        await this.sql`
            UPDATE operational_alerts
            SET state             = ${toState},
                last_evaluated_at = NOW(),
                metric_value      = ${metricValue ?? cur.metric_value},
                auto_resolved     = ${toState === 'resolved'},
                resolved_at       = ${toState === 'resolved' ? new Date() : null}
            WHERE id = ${cur.id}
        `;
        await this._logTransition(cur.id, cur.state, toState, metricValue, reason);
    }

    async _logTransition(alertId, fromState, toState, metricValue, reason) {
        try {
            await this.sql`
                INSERT INTO alert_transitions (alert_id, from_state, to_state, metric_value, reason)
                VALUES (${alertId}, ${fromState ?? null}, ${toState}, ${metricValue ?? null}, ${reason ?? null})
            `;
        } catch (err) {
            console.error('[AlertEngine] transition log failed:', err.message);
        }
    }

    _broadcast(row) {
        this.broadcast('alert_state', {
            fingerprint:      row.fingerprint,
            alert_id:         row.id,
            state:            row.state,
            prev_state:       row.prev_state ?? null,
            severity:         row.severity,
            alert_type:       row.alert_type,
            metric_value:     row.metric_value,
            metric_threshold: row.metric_threshold,
            escalation_level: row.escalation_level ?? 0,
            title:            row.title,
            body:             row.body,
            since:            row.created_at,
        });
    }

    // Load all currently open alerts into the in-memory index
    async _loadOpenAlerts() {
        const rows = await this.sql`
            SELECT * FROM operational_alerts
            WHERE state = ANY(${[...OPEN_STATES]})
              AND fingerprint IS NOT NULL
        `;
        this._openByFp.clear();
        for (const r of rows) {
            this._openByFp.set(r.fingerprint, r);
        }
    }

    async _reloadConfig() {
        try {
            const rows = await this.sql`SELECT key, value FROM ops_config WHERE key LIKE 'alert.%'`;
            for (const r of rows) {
                const parsed = parseFloat(r.value);
                this._cfg[r.key] = isNaN(parsed) ? r.value : parsed;
            }
        } catch {
            // Table may not exist on very first startup before schema runs; use defaults
        }
    }

    // Composite anomaly detection: queue spike, breach cluster, client surge, agent burnout.
    async _buildAnomalyCandidates(queueState, agents = []) {
        const results = [];
        await Promise.all([
            this._queueSpikeCandidate(queueState).then(r => results.push(...r)),
            this._breachClusterCandidates().then(r => results.push(...r)),
            this._clientSurgeCandidates().then(r => results.push(...r)),
        ]);
        results.push(...this._agentBurnoutCandidates(queueState));
        return results;
    }

    // Z-score anomaly on global queue total vs 8-week historical baseline.
    async _queueSpikeCandidate(queueState) {
        try {
            const now      = new Date();
            const weekday  = now.getDay();
            const hour     = now.getHours();
            const cacheKey = `${weekday}:${hour}`;

            let baseline = this._baselineCache.get(cacheKey);
            if (!baseline || (Date.now() - baseline.cachedAt) > BASELINE_CACHE_MS) {
                const rows = await this.sql`
                    SELECT pending_count
                    FROM queue_snapshots
                    WHERE agent_id IS NULL
                      AND EXTRACT(DOW  FROM snapshot_at) = ${weekday}
                      AND EXTRACT(HOUR FROM snapshot_at) = ${hour}
                      AND snapshot_at >= NOW() - INTERVAL '56 days'
                    ORDER BY snapshot_at DESC
                `;
                if (rows.length < 4) return [];

                const series = rows.map(r => Number(r.pending_count));
                const mean   = series.reduce((s, x) => s + x, 0) / series.length;
                const stdDev = Math.sqrt(
                    series.reduce((s, x) => s + (x - mean) ** 2, 0) / (series.length - 1)
                );
                baseline = { mean, stdDev, cachedAt: Date.now(), samples: series.length };
                this._baselineCache.set(cacheKey, baseline);
            }

            if (baseline.stdDev < 1) return [];

            const current = queueState.global_total ?? 0;
            const z       = (current - baseline.mean) / baseline.stdDev;

            if (Math.abs(z) < ANOMALY_Z_WARN) return [];

            const direction = z > 0 ? 'higher' : 'lower';
            if (Math.abs(z) < ANOMALY_Z_ALERT) {
                console.log(
                    `[AlertEngine/Anomaly] queue z=${z.toFixed(2)} (${direction} than baseline ${Math.round(baseline.mean)} ±${Math.round(baseline.stdDev)})`
                );
                return [];
            }

            return [{
                alert_type:       'anomaly_high',
                severity:         z > 5 ? 'critical' : 'warning',
                title:            `Queue volume anomaly (z=${z.toFixed(1)})`,
                body:             `Global queue is ${Math.round(Math.abs(z))}σ ${direction} than baseline for this hour. Current: ${current}, baseline: ~${Math.round(baseline.mean)} (n=${baseline.samples}).`,
                package_name:     null,
                agent_id:         null,
                metric_value:     current,
                metric_threshold: Math.round(baseline.mean + ANOMALY_Z_ALERT * baseline.stdDev),
            }];
        } catch (err) {
            console.error('[AlertEngine/Anomaly/QueueSpike] error:', err.message);
            return [];
        }
    }

    // Detect 3+ new SLA breaches in the last 10 minutes.
    async _breachClusterCandidates() {
        try {
            const rows = await this.sql`
                SELECT COUNT(*)::int AS count
                FROM sla_breach_ledger
                WHERE breached_at >= NOW() - INTERVAL '10 minutes'
            `;
            const count = rows[0]?.count ?? 0;
            if (count < 3) return [];
            return [{
                alert_type:       'breach_cluster',
                severity:         count >= 6 ? 'critical' : 'warning',
                title:            `SLA breach cluster: ${count} breaches in 10 min`,
                body:             `${count} rooms breached SLA in the last 10 minutes. Immediate action required.`,
                package_name:     null,
                agent_id:         null,
                metric_value:     count,
                metric_threshold: 3,
            }];
        } catch (err) {
            console.error('[AlertEngine/Anomaly/BreachCluster] error:', err.message);
            return [];
        }
    }

    // Detect client surge: incoming rate in current hour > 2× previous hour.
    async _clientSurgeCandidates() {
        try {
            const rows = await this.sql`
                SELECT snapshot_hour, SUM(incoming_count)::int AS incoming
                FROM hourly_demand_snapshots
                WHERE snapshot_date = CURRENT_DATE
                  AND snapshot_hour IN (
                      EXTRACT(HOUR FROM NOW())::int,
                      EXTRACT(HOUR FROM NOW())::int - 1
                  )
                GROUP BY snapshot_hour
                ORDER BY snapshot_hour DESC
            `;
            if (rows.length < 2) return [];
            const curr = Number(rows[0].incoming);
            const prev = Number(rows[1].incoming);
            if (prev < 5 || curr <= prev * 2) return [];  // prev too small or no surge
            const ratio = Math.round((curr / prev) * 10) / 10;
            return [{
                alert_type:       'client_surge',
                severity:         ratio >= 3 ? 'critical' : 'warning',
                title:            `Client surge: ${ratio}× incoming rate`,
                body:             `Current hour: ${curr} incoming vs ${prev} prior hour (${ratio}× increase). Staff up immediately.`,
                package_name:     null,
                agent_id:         null,
                metric_value:     ratio,
                metric_threshold: 2.0,
            }];
        } catch (err) {
            console.error('[AlertEngine/Anomaly/ClientSurge] error:', err.message);
            return [];
        }
    }

    // Detect agent burnout: pending_count > 25 sustained for 45+ minutes.
    _agentBurnoutCandidates(queueState) {
        const BURNOUT_PENDING  = 25;
        const BURNOUT_MIN      = 45;
        const now              = Date.now();
        const results          = [];

        for (const a of queueState.byAgent ?? []) {
            if (a.pending_count > BURNOUT_PENDING) {
                if (!this._burnoutTracking.has(a.agent_id)) {
                    this._burnoutTracking.set(a.agent_id, { firstSeen: now, lastPending: a.pending_count });
                } else {
                    this._burnoutTracking.get(a.agent_id).lastPending = a.pending_count;
                }
                const { firstSeen } = this._burnoutTracking.get(a.agent_id);
                const sustainedMin  = (now - firstSeen) / 60_000;
                if (sustainedMin >= BURNOUT_MIN) {
                    results.push({
                        alert_type:       'agent_burnout',
                        severity:         sustainedMin >= 90 ? 'critical' : 'warning',
                        title:            `${a.agent_name} burnout risk (${Math.round(sustainedMin)}m overloaded)`,
                        body:             `${a.agent_name} has had ${a.pending_count} pending chats for ${Math.round(sustainedMin)} minutes. Reassign to prevent burnout.`,
                        package_name:     null,
                        agent_id:         a.agent_id,
                        metric_value:     Math.round(sustainedMin),
                        metric_threshold: BURNOUT_MIN,
                    });
                }
            } else {
                this._burnoutTracking.delete(a.agent_id);
            }
        }
        return results;
    }

    async _agentStatuses() {
        const rows = await this.sql`
            WITH active_shifts AS (
                SELECT DISTINCT ON (agent_id)
                    agent_id, shift_started_at
                FROM shifts
                WHERE shift_ended_at IS NULL
                ORDER BY agent_id, shift_started_at DESC
            ),
            last_sessions AS (
                SELECT DISTINCT ON (agent_id)
                    agent_id, ended_at, clicked_at
                FROM sessions
                ORDER BY agent_id, clicked_at DESC
            ),
            active_breaks AS (
                SELECT DISTINCT ON (sh.agent_id)
                    sh.agent_id
                FROM shift_breaks sb
                JOIN shifts sh ON sb.shift_id = sh.id
                WHERE sh.shift_ended_at IS NULL AND sb.ended_at IS NULL
                ORDER BY sh.agent_id
            )
            SELECT
                a.id, a.name,
                ash.shift_started_at,
                ls.ended_at   AS last_ended_at,
                ls.clicked_at AS last_started_at,
                CASE
                    WHEN ash.agent_id IS NULL                              THEN 'off_shift'
                    WHEN ab.agent_id  IS NOT NULL                          THEN 'on_break'
                    WHEN ls.ended_at IS NULL AND ls.clicked_at IS NOT NULL THEN 'in_session'
                    ELSE 'idle'
                END AS status
            FROM agents a
            LEFT JOIN active_shifts ash ON ash.agent_id = a.id
            LEFT JOIN last_sessions ls  ON ls.agent_id  = a.id
            LEFT JOIN active_breaks ab  ON ab.agent_id  = a.id
            WHERE a.is_active = TRUE
        `;

        const now = Date.now();
        return rows.map(r => {
            let idle_minutes = 0;
            if (r.status === 'idle') {
                const ref = r.last_ended_at ?? r.shift_started_at;
                idle_minutes = ref ? Math.round((now - new Date(ref).getTime()) / 60_000) : 0;
            }
            return { ...r, idle_minutes };
        });
    }
}

module.exports = AlertEngine;
