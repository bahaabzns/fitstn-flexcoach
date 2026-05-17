// AlertEngine — runs every 5 minutes, evaluates alert rules against live queue
// and SLA data, writes new alerts to operational_alerts (with 15-min dedup),
// and broadcasts each new alert via SSE.

const ALERT_INTERVAL_MS = 5 * 60 * 1000;

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

class AlertEngine {
    constructor({ sql, queueEngine, slaEngine, broadcast }) {
        this.sql         = sql;
        this.queueEngine = queueEngine;
        this.slaEngine   = slaEngine;
        this.broadcast   = broadcast;
        this._timer      = null;
    }

    start() {
        this._runSafe();
        this._timer = setInterval(() => this._runSafe(), ALERT_INTERVAL_MS);
        console.log('[AlertEngine] started — runs every 5 min');
    }

    stop() { if (this._timer) clearInterval(this._timer); }

    // ── private ──────────────────────────────────────────────────────────────

    _runSafe() {
        this._check().catch(err =>
            console.error('[AlertEngine] run error:', err.message)
        );
    }

    async _check() {
        const queueState = this.queueEngine.getState();
        const slaScores  = this.slaEngine.getScores();
        const agents     = await this._agentStatuses();

        const candidates = [];

        // ── 1. SLA danger ────────────────────────────────────────────────────
        for (const s of slaScores) {
            if (s.risk_score < 50) continue;
            candidates.push({
                alert_type:       'sla_danger',
                severity:         s.risk_score >= 75 ? 'critical' : 'warning',
                title:            `${s.package_name} SLA at risk`,
                body:             `SLA projected to fall to ${s.projected_sla_eod}% by EOD. Risk score: ${s.risk_score}.`,
                package_name:     s.package_name,
                agent_id:         null,
                metric_value:     s.projected_sla_eod,
                metric_threshold: 90,
            });
        }

        // ── 2. Global queue overload ─────────────────────────────────────────
        const globalGrowth = queueState.global_growth_rate ?? 0;
        if (globalGrowth > 5) {
            candidates.push({
                alert_type:       'queue_overload',
                severity:         globalGrowth > 10 ? 'critical' : 'warning',
                title:            'Queue growing rapidly',
                body:             `Global queue increasing at +${globalGrowth} chats/hr. ${queueState.global_total} pending.`,
                package_name:     null,
                agent_id:         null,
                metric_value:     globalGrowth,
                metric_threshold: 5,
            });
        }

        // ── 3. Per-agent queue overload ──────────────────────────────────────
        for (const a of queueState.byAgent ?? []) {
            if (a.growth_rate_per_hour <= 5) continue;
            candidates.push({
                alert_type:       'queue_overload',
                severity:         'warning',
                title:            `${a.agent_name} queue growing`,
                body:             `+${a.growth_rate_per_hour}/hr. Currently ${a.pending_count} pending.`,
                package_name:     null,
                agent_id:         a.agent_id,
                metric_value:     a.growth_rate_per_hour,
                metric_threshold: 5,
            });
        }

        // ── 4. Inactive agents (idle ≥ 15 min, queue has work) ───────────────
        if (queueState.global_total > 0) {
            for (const a of agents) {
                if (a.status !== 'idle' || a.idle_minutes < 15) continue;
                candidates.push({
                    alert_type:       'inactive_agent',
                    severity:         'warning',
                    title:            `${a.name} idle for ${Math.round(a.idle_minutes)}m`,
                    body:             `Agent on shift but no sessions. ${queueState.global_total} chats pending globally.`,
                    package_name:     null,
                    agent_id:         a.id,
                    metric_value:     a.idle_minutes,
                    metric_threshold: 15,
                });
            }
        }

        // ── 5. Agent overload (pending > 20) ─────────────────────────────────
        for (const qa of queueState.byAgent ?? []) {
            if (qa.pending_count <= 20) continue;
            candidates.push({
                alert_type:       'agent_overload',
                severity:         qa.pending_count > 35 ? 'critical' : 'warning',
                title:            `${qa.agent_name} overloaded`,
                body:             `${qa.pending_count} chats pending. Growth: ${qa.growth_rate_per_hour > 0 ? '+' : ''}${qa.growth_rate_per_hour}/hr.`,
                package_name:     null,
                agent_id:         qa.agent_id,
                metric_value:     qa.pending_count,
                metric_threshold: 20,
            });
        }

        // ── 6. Workload imbalance (Gini > 0.35) ──────────────────────────────
        const byAgent = queueState.byAgent ?? [];
        if (byAgent.length >= 2) {
            const loads = byAgent.map(a => a.pending_count);
            const g = gini(loads);
            if (g > 0.35) {
                const sorted      = [...byAgent].sort((a, b) => b.pending_count - a.pending_count);
                const overloaded  = sorted[0];
                const underloaded = sorted[sorted.length - 1];
                const diff        = Math.round((overloaded.pending_count - underloaded.pending_count) / 2);
                candidates.push({
                    alert_type:       'workload_imbalance',
                    severity:         'warning',
                    title:            'Workload imbalance detected',
                    body:             `Reassign ~${diff} chats from ${overloaded.agent_name} to ${underloaded.agent_name}. Gini: ${Math.round(g * 100) / 100}.`,
                    package_name:     null,
                    agent_id:         null,
                    metric_value:     Math.round(g * 100) / 100,
                    metric_threshold: 0.35,
                });
            }
        }

        // ── Emit with deduplication ───────────────────────────────────────────
        let emitted = 0;
        for (const c of candidates) {
            const ok = await this._canEmit(c.alert_type, c.package_name, c.agent_id);
            if (!ok) continue;
            try {
                const [row] = await this.sql`
                    INSERT INTO operational_alerts
                        (severity, alert_type, title, body,
                         package_name, agent_id, metric_value, metric_threshold)
                    VALUES
                        (${c.severity}, ${c.alert_type}, ${c.title}, ${c.body ?? null},
                         ${c.package_name ?? null}, ${c.agent_id ?? null},
                         ${c.metric_value ?? null}, ${c.metric_threshold ?? null})
                    RETURNING *
                `;
                this.broadcast('alert', row);
                emitted++;
            } catch (err) {
                console.error('[AlertEngine] insert failed:', err.message);
            }
        }

        if (emitted > 0) {
            console.log(`[AlertEngine] emitted ${emitted} new alert(s)`);
        }
    }

    // Suppress if the same alert type + scope already fired in the last 15 minutes
    async _canEmit(alertType, packageName, agentId) {
        const rows = await this.sql`
            SELECT id FROM operational_alerts
            WHERE alert_type   = ${alertType}
              AND package_name IS NOT DISTINCT FROM ${packageName ?? null}
              AND agent_id     IS NOT DISTINCT FROM ${agentId ?? null}
              AND auto_resolved  = FALSE
              AND is_acknowledged = FALSE
              AND created_at  >= NOW() - INTERVAL '15 minutes'
            LIMIT 1
        `;
        return rows.length === 0;
    }

    // Lightweight agent status query (no sessions join — just shifts + breaks)
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
                    WHEN ash.agent_id IS NULL                                  THEN 'off_shift'
                    WHEN ab.agent_id  IS NOT NULL                              THEN 'on_break'
                    WHEN ls.ended_at IS NULL AND ls.clicked_at IS NOT NULL     THEN 'in_session'
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
                idle_minutes = ref
                    ? Math.round((now - new Date(ref).getTime()) / 60_000)
                    : 0;
            }
            return { ...r, idle_minutes };
        });
    }
}

module.exports = AlertEngine;
