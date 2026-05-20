# FitStn FollowUp RTM — Enterprise Operations Platform Redesign

**Complete Professional Review & Implementation Plan**

---

## 0. ROOT-CAUSE DIAGNOSIS

### Why Your System Shows "0 Agents On Shift" But "Overloaded Agents"

The system has **four structural defects** that create the trust breakdowns you describe:

| # | Symptom | Root Cause | Code Evidence |
|---|---------|-----------|---|
| **D1** | "Agents on shift = 0 but agents overloaded" | Single presence signal: `shifts WHERE shift_ended_at IS NULL`. Queue data from Supabase is **independent**. No reconciliation. | `server/index.js:195-208` defines on_shift; `queue-engine.js:70-99` queries Supabase separately |
| **D2** | "Utilization unreliable / low pending = high util" | Uses only shift-end time, ignores SLA windows, package complexity, breach urgency, active concurrency | `server/index.js:958-967`, `1042-1059` |
| **D3** | "Alerts repeat every refresh" | No state machine. Inserts new row if none in last 15 min, ignoring underlying condition lifecycle. Acknowledging doesn't terminate. | `alert-engine.js:151-176`, `180-192` |
| **D4** | "Ops Score / SLA per-package feel arbitrary" | Per-package SLA is **proportional fake** of global queue, not actual per-package count. Code admits: `// Phase 5 will replace this with true per-package polling` | `sla-engine.js:14-18`, `82-99` |

**Every other UX issue** (density, TTB, no actionable queue) layers on top of these four.

---

## 1. SYSTEM ARCHITECTURE REVIEW

### 1.1 Strengths to Preserve

- **Engine pattern**: QueueEngine, SlaEngine, AlertEngine, ExpressScheduler, ForecastingService are correctly modeled as long-running services with explicit start/stop and in-memory caching. ✓ Keep.
- **SSE infrastructure**: Works correctly with heartbeats, query-token auth, proxy-safe buffering control. ✓ Keep.
- **Time-series schema**: `queue_snapshots`, `hourly_demand_snapshots`, `sla_risk_scores`, `forecast_models` enable replay/audit. ✓ Build on it.
- **Data-driven capacity config**: `agent_capacity_config` is editable per package. ✓ Expand this pattern.

### 1.2 Architectural Weaknesses

| Issue | Location | Impact |
|---|---|---|
| **W1. Monolithic index.js** | 2126 lines | Untestable, unmaintainable, cannot scale to multi-tenant |
| **W2. Single presence signal** | shift table only | Cannot distinguish scheduled vs actively responding vs clocked-in idle |
| **W3. Per-room data discarded** | queue-engine.js:113 | Cannot do TTB, per-room urgency, breach forecasting, drilldown |
| **W4. No per-package live counts** | sla-engine.js | Risk per package is fictional distribution |
| **W5. No stateful alerts** | operational_alerts append-only | Cannot dedupe lifecycle, escalate, auto-resolve |
| **W6. Polling-only, 60-sec granularity** | All engines | Pro chats can sit 14 min before SLA risk reflects |
| **W7. No event log** | No ops_event_log | Cannot replay incidents, audit, train models |
| **W8. Hard-coded UTC offset** | sla-rules.js:2 | DST breaks; multi-region impossible |
| **W9. Single 2302-line HTML file** | ops-center.html | Untestable, doom-scroll layout, refresh mixed |

### 1.3 Operational Blind Spots

- **No occupancy metric** (active-chat-seconds / on-shift-seconds)
- **First-response-time unused** despite schema column at `sessions.first_response_seconds`
- **No queue-age distribution** (how many <15min, 15-45min, 45+min)
- **No SLA breach ledger** — breaches unauditable next week
- **Ghost/abandoned client detection** never uses Supabase's `p_ghost_days` parameter

---

## 2. OPERATIONS LOGIC DESIGN

### 2.1 Presence Model — The "On-Shift" Fix (Replaces D1)

Replace single boolean with **layered presence state** = MAX() of independent signals:

```
PresenceState = max(
    P_scheduled,         // inside agent.shift_start_time..shift_end_time?
    P_clockedIn,         // open shifts row?
    P_recentlyActive,    // session/message/activity in last N minutes?
    P_assignedLive       // open chat rooms assigned in Supabase right now?
)
```

Status labels (priority high→low):
- `IN_SESSION` — open session OR assigned chat with staff msg in last 5min
- `RESPONDING` — recent staff msg in any room within 10min, no open session
- `IDLE_ON_SHIFT` — clocked-in AND scheduled AND no signal ≥ idle_warning_minutes
- `ON_BREAK` — open shift_breaks row
- `SCHEDULED_NOT_CLOCKED_IN` — inside window but no shifts row (warn at +15min)
- `UNSCHEDULED_ACTIVE` — outside window but has Supabase activity
- `OFF_SHIFT` — nothing

**Build once as SQL view, consume everywhere:**

```sql
CREATE OR REPLACE VIEW v_agent_presence AS
SELECT
  a.id, a.name, a.fitstn_id,
  a.shift_start_time, a.shift_end_time,
  (SELECT id FROM shifts WHERE agent_id = a.id AND shift_ended_at IS NULL) AS open_shift_id,
  (SELECT id FROM sessions WHERE agent_id = a.id AND ended_at IS NULL LIMIT 1) AS open_session_id,
  (SELECT MAX(created_at) FROM activity_events WHERE agent_id = a.id) AS last_activity_at,
  COALESCE(qs.last_staff_msg_at, NULL) AS last_staff_msg_at,
  qs.assigned_live_count
FROM agents a
LEFT JOIN agent_live_state qs ON qs.agent_id = a.id
WHERE a.is_active = TRUE;
```

### 2.2 Queue Logic — Three Dimensions

1. **Live queue** (Fit Solo Pro, Fit Fam Pro, Fit Solo, Fit Duo, Fit Fam) — reactive, SLA in minutes/hours
2. **Scheduled queue** (Fit Express) — batch, SLA = served on weekday
3. **Unassigned queue** — pending rooms with no assigned_staff_id

Each pending room is a fact:

```
RoomFact {
  room_id,
  package_name,
  assigned_agent_id,       // may be null
  last_client_message_at,
  last_staff_message_at,
  sla_deadline_at,         // computed formula
  state,                   // OPEN | IN_PROGRESS | AT_RISK | BREACHED | RESOLVED
}
```

**SLA Deadline Formula** (core operation):

```
sla_deadline_at = first_pending_moment_inside_sla_window
                  + advance_minutes(rule.maxMinutes, sla_window)
```

where `advance_minutes()` walks forward through working hours only (no nights/weekends), returning wall-clock time when cumulative in-window minutes = rule.maxMinutes.

### 2.3 SLA Engine — Per-Package, Real Counts (Replaces D4)

Today: synthetic per-package by proportional split. Replace with **actual per-package polling**.

```
For each (package, weekday, agent):
  - Pull pending rooms: p_last_message_from='client' AND p_package_id=X
  - Compute sla_deadline_at per room
  - Bucket: OK (>30min to deadline), WARN (≤30min), URGENT (≤10min), BREACHING (<0min)
```

**Package-level SLA health** (no fake distribution):

```
sla_health[pkg] = 100 × (rooms_OK / total_rooms)
breach_probability[pkg] = 1 - Π(1 - p_breach_room_i)
  where p_breach_room_i = sigmoid((30 - minutes_to_deadline_i) / 10)
```

### 2.4 Prioritization — Queue Routing Score

Every pending room gets a `PriorityScore` broadcast with every poll:

```
PriorityScore = w1·PackagePriority + w2·TTB_Urgency + w3·AgingPenalty
              + w4·PremiumBoost   + w5·ReopenPenalty

PackagePriority  = (5 − rule.priority) / 4
TTB_Urgency      = clamp(1 - (minutes_to_deadline / rule.maxMinutes), 0, 1.2)
AgingPenalty     = log1p(queue_age_minutes / 60) / log1p(8)
PremiumBoost     = 1.0 if package in {Pro packages} else 0
ReopenPenalty    = 0.5 if room breached today
```

Weights `[0.20, 0.40, 0.15, 0.20, 0.05]` stored in tunable `ops_config`.

---

## 3. UTILIZATION MODEL (Replaces D2)

### 3.1 Workforce-Management Formula

**Effective Capacity Per Hour**:

```
CapacityPerHour(agent) =
   Σ_pkg (time_share_pkg × 60/avg_handling_min_pkg × max_concurrent_pkg)
   × stamina_factor
```

**Weighted Load Per Hour**:

```
WeightedLoadPerHour(agent) =
   Σ_pkg (pending_count_pkg × complexity_weight_pkg × urgency_multiplier_pkg)
   / hours_remaining_in_shift

UrgencyMultiplier_room = 
   1.0                    if minutes_to_deadline > 60
   1.0 + (60−mtd)/60      if 0 ≤ mtd ≤ 60   (scales 1→2)
   3.0                    if breached
```

**Utilization**:

```
U_agent = WeightedLoadPerHour(agent) / CapacityPerHour(agent)
```

**Bands**:
- `U < 0.5` → underutilized (redeploy)
- `0.5 ≤ U < 0.85` → healthy
- `0.85 ≤ U < 1.0` → at capacity
- `U ≥ 1.0` → overloaded
- `U ≥ 1.5` → critical

`stamina_factor` ≈ 1.0 normally; drops after >75% occupancy for consecutive hours (prevents claiming agents can sustain 100% utilization 8h straight).

### 3.2 Concurrency Handling

```
ConcurrentLoad(agent, t) = count(sessions where clicked_at ≤ t AND (ended_at IS NULL OR ended_at ≥ t))
Concurrency_p95(agent, day) = 95th percentile of ConcurrentLoad over shift
```

Flag agent as "concurrency-saturated" if `Concurrency_p95 > 0.8 × max_concurrent_chats`.

### 3.3 Sustainable Capacity

```
SustainableDailyChats(agent) =
   shift_hours × Σ_pkg (time_share_pkg × 60 / avg_handling_minutes_pkg)
   × 0.75
```

The 0.75 is **WFM shrinkage** (breaks, admin, switch cost). Display as the line agents should not cross.

### 3.4 Staffing Formula

```
AgentsRequired(pkg, demand_per_day) =
   ceil( demand_per_day × complexity_weight_pkg
        / (shift_hours × 60/avg_handling_min × max_concurrent × 0.75)
       × (1 + sla_buffer_pct/100) )
```

Buffer = 15% for Pro, 10% for others.

---

## 4. QUEUE ENGINE DESIGN

### 4.1 Three-Tier Architecture

| Layer | Cadence | Source | Output |
|---|---|---|---|
| **L1 — Fast count** | 30s | Supabase RPC per-agent | "is queue growing?" |
| **L2 — Per-room snapshot** | 60s | Supabase paginated rooms | live_queue_rooms table + priority_score |
| **L3 — Breach watch** | 15s | in-memory cached rooms | State transitions (OPEN→AT_RISK→BREACHED) |

Why three: Supabase RPC has latency. You want fast counts, slow drilldown, and breach detection on tight loop without re-querying.

### 4.2 `live_queue_rooms` Table

```sql
CREATE TABLE live_queue_rooms (
  room_id           TEXT PRIMARY KEY,
  package_name      VARCHAR(100) NOT NULL,
  assigned_agent_id INTEGER REFERENCES agents(id),
  client_name       TEXT,
  last_client_msg_at TIMESTAMPTZ NOT NULL,
  last_staff_msg_at  TIMESTAMPTZ,
  sla_deadline_at    TIMESTAMPTZ NOT NULL,
  priority_score     NUMERIC(6,3) NOT NULL,
  state              VARCHAR(20),  -- OPEN|AT_RISK|URGENT|BREACHED|RESOLVED
  state_changed_at   TIMESTAMPTZ DEFAULT NOW(),
  first_seen_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at         TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_lqr_deadline ON live_queue_rooms (sla_deadline_at) WHERE state <> 'RESOLVED';
CREATE INDEX idx_lqr_agent_state ON live_queue_rooms (assigned_agent_id, state);
CREATE INDEX idx_lqr_priority ON live_queue_rooms (priority_score DESC) WHERE state <> 'RESOLVED';
```

**The actionable queue table** = `SELECT * FROM live_queue_rooms WHERE state <> 'RESOLVED' ORDER BY priority_score DESC LIMIT 200`.

### 4.3 Time-to-Breach Stream

Every 15s, broadcast:

```json
{
  "breaching_now": count(state='BREACHED'),
  "breaching_15m": count(sla_deadline < now()+15m AND state='OPEN'),
  "breaching_30m": count(sla_deadline < now()+30m),
  "breaching_60m": count(sla_deadline < now()+60m)
}
```

Per package and per agent versions too.

### 4.4 Queue Flow Metrics

```
intake_rate_30min     = (first_seen_at in last 30min) × 2 → per hour
resolution_rate_30m   = (state→RESOLVED in last 30min) × 2
net_growth            = intake_rate - resolution_rate
drain_time_minutes    = current_open_count / resolution_per_min
stabilization_eta     = when net_growth crosses zero
```

Persist hourly to `queue_flow_metrics`.

---

## 5. ALERT ENGINE DESIGN (Replaces D3)

### 5.1 State Machine

```
                         ┌──────────────┐
                         │   started    │
                         └──────┬───────┘
                                │
       ┌──────────────┐  metric worse   ┌──────────────┐
       │  worsening   │◄──────────────►│   stable     │
       └──────┬───────┘  metric better  └──────┬───────┘
              │                                 │
              │ crosses critical band          │
              ▼                                 ▼
       ┌──────────────┐                 ┌──────────────┐
       │ escalated    │                 │  improving   │
       └──────┬───────┘                 └──────┬───────┘
              │                                 │
              └─────────────────┬───────────────┘
                                │ cooldown reached
                                ▼
                        ┌──────────────┐
                        │   resolved   │
                        └──────────────┘
```

### 5.2 Schema Changes

```sql
ALTER TABLE operational_alerts ADD COLUMN fingerprint TEXT;
ALTER TABLE operational_alerts ADD COLUMN state VARCHAR(20) DEFAULT 'started';
ALTER TABLE operational_alerts ADD COLUMN last_evaluated_at TIMESTAMPTZ;
ALTER TABLE operational_alerts ADD COLUMN escalation_level SMALLINT DEFAULT 0;
ALTER TABLE operational_alerts ADD COLUMN snooze_until TIMESTAMPTZ;

CREATE UNIQUE INDEX idx_alerts_open_fingerprint
  ON operational_alerts(fingerprint) WHERE state IN ('started','worsening','stable','improving');

CREATE TABLE alert_transitions (
  id BIGSERIAL PRIMARY KEY,
  alert_id INTEGER REFERENCES operational_alerts(id),
  from_state VARCHAR(20), to_state VARCHAR(20),
  metric_value NUMERIC(12,3),
  reason TEXT,
  occurred_at TIMESTAMPTZ DEFAULT NOW()
);
```

`fingerprint = sha1(alert_type || ':' || (package_name||'∅') || ':' || (agent_id||'∅'))`.

### 5.3 Lifecycle Rules

| alert_type | cooldown_to_resolve | escalate_after | action |
|---|---|---|---|
| sla_danger (pkg) | 10 min stable improvement | 20 min worsening | Page tier-2 |
| agent_overload | 15 min stable | 30 min worsening | Auto-suggest reassignment |
| queue_overload | 10 min | 15 min growth >10/hr | Show "surge mode" banner |
| inactive_agent | 5 min activity | 30 min idle | DM agent + supervisor flag |
| workload_imbalance | 20 min Gini < threshold | 45 min | Suggest reassignment |

### 5.4 Engine Logic

```javascript
for (const candidate of candidates) {
  const fp  = fingerprint(candidate);
  const cur = openAlertsByFp.get(fp);

  if (!cur) {
    insertNew(candidate, 'started');
    continue;
  }

  const trend = classifyTrend(cur.alert_type, cur.metric_value, candidate.metric_value);
  // trend ∈ {worsening, stable, improving}

  const nextState =
      trend === 'worsening' && candidate.metric > criticalBand(cur)  ? 'escalated'
    : trend                                                            ? trend
    : cur.state;

  if (nextState !== cur.state) {
    recordTransition(cur, nextState, candidate.metric_value);
    update(cur.id, { state: nextState, metric_value: ..., last_evaluated_at: NOW() });
  }
}

// Auto-resolve stale
for (const stale of openAlertsByFp.values()) {
  if (!seenFingerprints.has(stale.fingerprint)) {
    if (stable_for_minutes(stale) >= cooldownFor(stale.alert_type)) {
      transitionTo(stale, 'resolved');
    }
  }
}
```

### 5.5 SSE Payload

```json
{
  "fingerprint": "...",
  "alert_id": 123,
  "state": "worsening",
  "prev_state": "stable",
  "severity": "warning",
  "metric_value": 32,
  "metric_threshold": 20,
  "escalation_level": 1,
  "title": "...",
  "body": "...",
  "since": "2026-05-20T14:23:00Z"
}
```

UI updates card in place; resolved alerts fade after 30s.

---

## 6. OPS SCORE ENGINE

### 6.1 Explainable Formula

```
OpsScore = Σ_i weight_i × pillar_i

Pillars (each 0..100):
  SLA_Health      40%  = 100 - max(0, 95 - projected_sla_eod_p95)
  Queue_Pressure  20%  = 100 - clamp(net_growth×5 + queue_load×0.7, 0, 100)
  Staffing_Match  15%  = 100 × min(1, on_shift_effective / agents_required)
  Workload_Even   10%  = 100 × (1 − gini_on_shift)
  Premium_Risk    10%  = 100 × (pro_rooms_safe / max(pro_rooms_total, 1))
  Breach_Burndown  5%  = 100 × (1 − breaching_30m / max(open, 1))
```

### 6.2 Confidence

```
confidence_per_pillar ∈ [0, 1]  based on sample size
OverallConfidence = harmonic_mean(pillar_confidences)
DisplayedOpsScore = OpsScore × (0.5 + 0.5 × OverallConfidence)
```

### 6.3 Drilldown Payload

```json
{
  "ops_score": 73,
  "confidence": 0.82,
  "pillars": [
    {
      "key": "sla_health",
      "value": 84,
      "weight": 0.40,
      "confidence": 0.9,
      "explain": "Pro packages projected 92% EOD vs 95% target; 8 rooms at risk.",
      "drivers": [
        { "label": "Fit Solo Pro projected SLA", "value": 92, "target": 95 },
        { "label": "At-risk rooms (≤15min)",     "value": 8 }
      ]
    },
    …
  ],
  "as_of": "2026-05-20T14:23:00Z"
}
```

Clickable tiles expand to show drivers.

---

## 7. REAL-TIME SYSTEM DESIGN

### 7.1 Refresh Tiers (Stratified by Latency Budget)

| Tier | Cadence | Mechanism | Payload |
|---|---|---|---|
| T0 | 1s (client-side) | requestAnimationFrame | Countdown timers (TTB, shift remaining, room age) |
| T1 | 15s | SSE `queue_state_delta` | State transitions (OPEN→AT_RISK→BREACHED) |
| T2 | 30s | SSE `queue_counts` | Per-agent pending counts |
| T3 | 60s | SSE `queue_rooms_diff` | Delta of `live_queue_rooms` |
| T4 | 60s | SSE `sla_pkg` | Per-package SLA + breach probabilities |
| T5 | 60s | SSE `ops_health` | Recomputed ops_score + pillars |
| T6 | event-driven | SSE `alert_state` | Transitions only |
| T7 | nightly | DB read on demand | EMA forecast models |

### 7.2 SSE Improvements

- **Sequence numbers**: each broadcast carries `seq`. Client tracks last seq; gap detected → request `/api/snapshot?since=<seq>` to recover.
- **Topic subscription**: `/api/stream?topics=queue,alerts,sla` so UI doesn't pay for unused updates.
- **Backpressure**: drop slow clients (buffer fills for 30s → close).
- **Server-side fanout**: consolidate to single tick so engines don't desync.

### 7.3 Supabase Polling Optimization

- Cache `package_id ↔ package_name` in memory.
- One RPC per package with pagination instead of per-agent. (20 agents → 5–6 RPCs).
- **Circuit breaker**: 3 consecutive poll failures or >5s timeout → mark engine `DEGRADED`. SSE emits `system_health` → UI shows banner.

### 7.4 Caching

| Layer | TTL | Why |
|---|---|---|
| In-memory engine state | n/a | Source of truth between polls |
| `live_queue_rooms` | persisted | Crash recovery + replay |
| `daily_stats_cache` | used already | Demand report |
| Settings | 60s | Fast path (already cached) |
| Capacity config | 60s | Cache on read (not done today) |

---

## 8. DATABASE DESIGN

### 8.1 New Tables

```sql
-- Per-room live state (Section 4.2)
CREATE TABLE live_queue_rooms (
  room_id TEXT PRIMARY KEY,
  package_name VARCHAR(100) NOT NULL,
  assigned_agent_id INTEGER REFERENCES agents(id),
  client_name TEXT,
  last_client_msg_at TIMESTAMPTZ NOT NULL,
  last_staff_msg_at TIMESTAMPTZ,
  sla_deadline_at TIMESTAMPTZ NOT NULL,
  priority_score NUMERIC(6,3) NOT NULL,
  state VARCHAR(20),
  state_changed_at TIMESTAMPTZ DEFAULT NOW(),
  first_seen_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Per-agent live summary
CREATE TABLE agent_live_state (
  agent_id INTEGER PRIMARY KEY REFERENCES agents(id),
  last_staff_msg_at TIMESTAMPTZ,
  assigned_live_count INTEGER NOT NULL DEFAULT 0,
  weighted_load_per_hour NUMERIC(8,2),
  utilization NUMERIC(5,3),
  concurrency_p95 NUMERIC(5,2),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Append-only event log for replay/audit
CREATE TABLE ops_event_log (
  id BIGSERIAL PRIMARY KEY,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  event_type VARCHAR(50) NOT NULL,
  entity_type VARCHAR(20),  -- room|agent|package|system
  entity_id TEXT,
  payload JSONB NOT NULL,
  seq BIGINT NOT NULL UNIQUE
);

-- SLA breach ledger (immutable)
CREATE TABLE sla_breach_ledger (
  id BIGSERIAL PRIMARY KEY,
  room_id TEXT NOT NULL,
  package_name VARCHAR(100) NOT NULL,
  assigned_agent_id INTEGER,
  sla_deadline_at TIMESTAMPTZ NOT NULL,
  breached_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  minutes_overdue_at_resolution INTEGER,
  cause_tag VARCHAR(50),  -- understaffed|imbalance|after_hours|client_storm
  notes TEXT
);

-- Reassignment log
CREATE TABLE reassignment_actions (
  id SERIAL PRIMARY KEY,
  recommended_at TIMESTAMPTZ DEFAULT NOW(),
  from_agent_id INTEGER, to_agent_id INTEGER,
  package_name VARCHAR(100),
  chats_recommended INTEGER,
  chats_actually_moved INTEGER,
  expected_util_delta NUMERIC(5,3),
  actioned_by INTEGER REFERENCES admins(id),
  actioned_at TIMESTAMPTZ
);

-- Ops score history
CREATE TABLE ops_score_history (
  id BIGSERIAL PRIMARY KEY,
  computed_at TIMESTAMPTZ DEFAULT NOW(),
  ops_score SMALLINT NOT NULL,
  confidence NUMERIC(4,3),
  pillars JSONB NOT NULL
);

-- Alert state transitions
CREATE TABLE alert_transitions (
  id BIGSERIAL PRIMARY KEY,
  alert_id INTEGER REFERENCES operational_alerts(id),
  from_state VARCHAR(20), to_state VARCHAR(20),
  metric_value NUMERIC(12,3),
  reason TEXT,
  occurred_at TIMESTAMPTZ DEFAULT NOW()
);

-- Tunable runtime config
CREATE TABLE ops_config (
  key VARCHAR(80) PRIMARY KEY,
  value JSONB NOT NULL,
  description TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Extend operational_alerts
ALTER TABLE operational_alerts ADD COLUMN fingerprint TEXT;
ALTER TABLE operational_alerts ADD COLUMN state VARCHAR(20) DEFAULT 'started';
ALTER TABLE operational_alerts ADD COLUMN last_evaluated_at TIMESTAMPTZ;
ALTER TABLE operational_alerts ADD COLUMN escalation_level SMALLINT DEFAULT 0;
ALTER TABLE operational_alerts ADD COLUMN snooze_until TIMESTAMPTZ;
```

### 8.2 Critical Indexes

```sql
-- Breach watch (<50ms for 10K rooms)
CREATE INDEX idx_lqr_state_deadline
  ON live_queue_rooms(state, sla_deadline_at)
  WHERE state IN ('OPEN','AT_RISK','URGENT');

-- Agent drilldown
CREATE INDEX idx_lqr_agent_priority
  ON live_queue_rooms(assigned_agent_id, priority_score DESC)
  WHERE state <> 'RESOLVED';

-- Session occupancy
CREATE INDEX idx_sessions_agent_open
  ON sessions(agent_id, clicked_at DESC)
  WHERE ended_at IS NULL;

-- Existing (keep)
-- idx_one_active_shift_per_agent
-- idx_one_active_break_per_shift
```

### 8.3 Retention

| Table | Retention | Compaction |
|---|---|---|
| live_queue_rooms | resolved + 24h | Archive nightly |
| ops_event_log | 90d hot, 1yr cold | Monthly partition; ship to S3 |
| queue_snapshots | 90d | Aggregate to daily after 30d |
| hourly_demand_snapshots | 2yr | Keep (forecast training) |
| operational_alerts | resolved 180d | Standard |
| sla_breach_ledger | indefinite | Compliance requirement |
| ops_score_history | 1yr | Down-sample to hourly after 30d |

---

## 9. UI/UX REDESIGN PLAN

### 9.1 Layout Hierarchy

```
┌────────────────────────────────────────────────────────────┐
│ TOPBAR: Ops Score|Confidence|Stream health|Action queue    │
├─────────────────────┬──────────────────────────────────────┤
│ LEFT RAIL (220px)   │        MAIN GRID                     │
│ ┌─────────────────┐ │  ┌─────────────────────────────────┐ │
│ │ HUD (8 tiles)   │ │  │ Live Queue Table (virtualized)  │ │
│ ├─────────────────┤ │  ├─────────────────────────────────┤ │
│ │ TTB Wave Chart  │ │  │ Agent Matrix (sparklines)       │ │
│ ├─────────────────┤ │  ├─────────────────────────────────┤ │
│ │ Pillar Details  │ │  │ Queue Flow / Forecast Mini      │ │
│ ├─────────────────┤ │  └─────────────────────────────────┘ │
│ │ Alert Stream(5) │ │                                       │
│ └─────────────────┘ │                                       │
└─────────────────────┴──────────────────────────────────────┘
```

**Goal: 50+ data points visible without scroll.**

### 9.2 Compact Card System

```css
:root {
  --u: 4px;           /* base unit */
  --row-h: 28px;      /* dense */
  --row-h-comf: 36px; /* comfortable */
  --tile-pad: 8px;
  --font-data: 12px;
  --gap: 6px;
}

.tile { padding: var(--tile-pad); border-radius: 6px; }
.tile-data { font: 13px/1 monospace; }
```

**Tiles**: 64×40px (KPI), 64×64px (with sparkline). Current tiles are ~120px tall with wasteful space.

### 9.3 Live Queue Table

Columns: Priority | Client | Pkg | Agent | Wait | TTB ⏱ | Last Msg | Age | State | Actions

- Sticky header, virtual scroll
- TTB color-coded by urgency
- Tick every 1s client-side
- Click row → inline reassign drawer
- Keyboard: j/k navigate, r reassign, s snooze, o open in FlexCoach

### 9.4 Operational Ergonomics

- **Hotkeys** (`Ctrl/Cmd+K` palette): jump agent/package/sim, reassign, snooze
- **Density toggle**: 28/36/44px rows (cookie-persisted)
- **Color**: Red=#dc2626 (breach/critical), Amber=#f59e0b (at_risk), Green=#16a34a (healthy), Slate for neutral
- **Sound + flash on breach transitions** (configurable)

### 9.5 Mobile

- <720px: single column (Ops Score, alerts, top-10 rooms, page-on-call button)
- 720–1100px: grid + bottom sheet

### 9.6 Keyboard Shortcuts

| Key | Action |
|---|---|
| Ctrl/Cmd+K | Command palette |
| g q | Go to queue |
| g a | Go to agents |
| g s | Go to staffing |
| j / k | Next / prev row |
| Enter | Open drawer |
| r | Reassign |
| s | Snooze alert |
| ? | Show help |

---

## 10. ADVANCED OPERATIONAL FEATURES

### 10.1 Staffing Simulator

- Slider inputs: agents_present (±5), demand_multiplier (50–200%), break_overlap (%), shift_window_shift (±2h)
- Backend outputs:
  - Expected SLA % per package per hour (next 24h)
  - Expected breach count
  - Utilization distribution (box plot)
  - "Earliest bottleneck hour"
- Save to `staffing_scenarios` table for A/B comparison

### 10.2 Forecasting Engine

Replace EMA-only with **Holt-Winters** (additive seasonality, trend, weekday + hour-of-day cycles):

```
forecast[h] = HW_day_forecast × hour_seasonal_index[h]
```

- **Backtesting**: evaluate last 14 days predictions vs actuals; publish MAPE per package
- **Low-confidence flagging**: if MAPE > 30%, widen prediction interval
- **Special-event override**: admin flags days (Ramadan, campaigns) to exclude from training or multiply

### 10.3 What-if Engine

- Cascading scenarios ("Manar absent + demand +30% + shift delayed 1h")
- Optimization mode ("Minimum agents to keep Pro SLA ≥95% all week?")
- Cost view tied to `agent_salaries`

### 10.4 Anomaly Detection

Statistical (z-score), not ML. Every poll:

```
baseline_mean[m, hour-of-day, weekday] = trimmed mean, 8 weeks
baseline_std[m, hour-of-day, weekday]  = robust stddev
z = (current - baseline_mean) / baseline_std
if |z| > 3 → anomaly_high (alert)
if |z| > 2 → anomaly_low (record only)
```

Self-explaining alert: metric name, z_score, baseline, current.

### 10.5 Premium-Client Protection

- Tick every 30s: Pro room with minutes_to_deadline < 30 AND assigned_agent idle/off_shift → escalate to most-available Pro-specialty agent
- "Pro Lane" view: Pro packages only with live TTB countdown
- Auto-escalation log (immutable)

### 10.6 Burnout Prediction

Per agent, rolling 7-day metrics:
- `avg_utilization`, `avg_active_seconds_per_shift`, `breaches_attributed`
- 3+ consecutive high-util days (>0.85) → `risk_burnout=medium`
- 5+ → `risk_burnout=high` (surface to supervisor with load-redistribution recommendation)

---

## 11. IMPLEMENTATION ROADMAP

### Phase 1 — Foundation Fixes (2 weeks, ~80 hrs)
**Goal: trustworthy presence + per-package SLA + stateful alerts.**

| Task | Complexity | Impact |
|---|---|---|
| Add new schema tables (live_queue_rooms, ops_event_log, agent_live_state, etc.) | M | High |
| Replace QueueEngine with per-room version | L | High |
| Build presence view + state machine (v_agent_presence) | M | **Fixes D1** |
| Per-package SLA polling (use p_package_id) | M | **Fixes D4** |
| AlertEngine rewrite with state machine + fingerprints | M | **Fixes D3** |
| Migrate thresholds to ops_config table | S | Medium |

**Exit criteria**:
- "Agents on shift" count never disagrees with "agents with active queues"
- SLA % per package matches Supabase hand-count
- Same alert never repeats — updates in place

### Phase 2 — Operational Intelligence (2 weeks, ~70 hrs)
**Goal: actionable queue, TTB everywhere, weighted utilization.**

| Task | Complexity | Impact |
|---|---|---|
| Live queue drilldown table + filters (/api/queue/rooms) | L | High |
| Time-to-Breach stream (T1 tier in Section 7.1) | M | High |
| Replace utilization with weighted formula (Section 3) | M | **Fixes D2** |
| Ops Score v2 with pillars + confidence + drilldown | M | High |
| Queue flow metrics (intake/resolution/drain/stab) | S | Medium |
| Breach ledger (write breaches as they happen) | S | Medium |

**Exit criteria**:
- Ops manager can sort/filter pending rooms by priority, click reassign
- Every Pro room shows live TTB countdown
- Ops Score is clickable → reveals pillar drivers

### Phase 3 — Predictive & UX (2.5 weeks, ~90 hrs)
**Goal: enterprise feel + predictive layer.**

| Task | Complexity | Impact |
|---|---|---|
| UI redesign (ops-center → component structure) | L | High |
| Density toggle + keyboard navigation | S | Medium |
| Holt-Winters forecasting + hourly seasonality | M | Medium |
| Backtesting + MAPE publishing | M | Medium |
| Continuous staffing simulator | M | Medium |
| Anomaly detection (z-score) | S | Medium |
| Premium-client protection job | S | High (business) |

**Exit criteria**:
- Page-load shows 50+ data points without scroll
- Forecast MAPE published per package
- Anomaly alerts fire and self-explain

### Phase 4 — Enterprise Grade (2 weeks, ~70 hrs)
**Goal: replay, audit, observability, multi-region readiness.**

| Task | Complexity | Impact |
|---|---|---|
| Full ops_event_log emission from all engines | M | High (audit) |
| Replay endpoint (/api/replay?from=…&to=…) | L | Medium |
| Incident management (open/close, attach alerts) | M | Medium |
| SLA auditability (per-room timeline) | M | High (compliance) |
| Structured logging + Prometheus metrics | M | High (ops-of-ops) |
| Multi-region: timezone resolution (replace UTC_OFFSET constant) | M | Future-proofing |
| Cron job to archive resolved rooms | S | Hygiene |

---

## 12. ENTERPRISE-GRADE IMPROVEMENTS

### 12.1 Observability

- **Structured logging** (pino): `{engine, action, latency_ms, error?}` from every engine
- **Metrics endpoint** `/metrics` (Prometheus format):
  - `queue_poll_duration_seconds{engine="queue"}`
  - `supabase_rpc_errors_total`
  - `alerts_open{severity=…}`
  - `sla_breaches_total{package=…}`
  - `sse_clients_connected`
- **Health endpoint** `/api/system-health`: per-engine status + last run + consecutive failures

### 12.2 Audit & Replay

- `ops_event_log` is append-only, idempotent; every transition emits one event
- `/api/replay?since=<seq>&until=<seq>&entity=…` rebuilds queue state at any historical moment
- All admin actions (`reassign`, `snooze`, `ack_alert`, `config_update`) write to `admin_audit_log` with diff payloads

### 12.3 Incident Management

- Auto-promote 3+ related alerts in 10 min to an `incident`
- Incidents: `opened_at`, `severity`, `alerts[]`, `breaches[]`, `notes`, `commander_id`, `closed_at`, `postmortem_link`
- "Open incidents" pinned top of ops-center

### 12.4 SLA Auditability

Timeline per room reconstructed from `ops_event_log`:
- `room_created` → `assigned` → `state_changed_to_at_risk` → `breached` → `replied` → `resolved`
- One-click "audit timeline" modal

### 12.5 Historical Analytics

Weekly auto-emailed digest:
- SLA % per package vs target
- Top 5 breach root causes (understaffed, imbalance, after_hours, client_storm)
- Forecast accuracy (MAPE) per package
- Utilization distribution box plots
- Reassignment recommendations actioned vs ignored

All from `ops_event_log` + `sla_breach_ledger` + `ops_score_history`. No new pipelines.

### 12.6 Data Quality Guards

5-min sanity-check task:
- `live_queue_rooms.assigned_agent_id` references `is_active=false`? → data_quality alert
- Agent has rooms but no `agent_capacity_config` entry? → alert
- `ops_config` key referenced by code missing? → fall back to compile-time default + warning once

### 12.7 Security & Multi-Tenancy

- Bearer token rotation + last-used tracking + per-token scopes (read-only viewer vs full ops)
- Prepare for multi-tenant: add `tenant_id` column to every new table from day one
- Audit logs become legally meaningful: add tamper-evident hashing (`prev_hash | row_hash`)

---

## 13. ACTIONABLE NEXT STEP

If ready to implement, start **Phase 1, Task 1**:

1. **Schema migration block** — add new tables to [server/index.js](server/index.js) schema setup
2. **Build `services/presence.js`** — single source of presence state
3. **Wire `/api/ops-health` and `/api/overview` to consume presence** — fixes "0 on shift / overloaded" inconsistency on day 1

This single sequence makes the dashboard **trustworthy** before any further work.

---

## Summary

This plan transforms your system from **reactive monitors** (show counts, hope they're right) into **operational command center** (explain reasoning, predict failures, make trustworthy recommendations). Each phase delivers shippable value. Root causes are specific, not generic. Implementation sequence respects dependencies and maximizes early wins.

**Trust is earned through:**
1. Single authoritative source per concept (presence, queue, SLA)
2. Transparent formulas (every score explains itself)
3. Stateful lifecycle (alerts transition, don't repeat)
4. Actionable data (queue is sortable, TTB is clickable, utilization is formulaic)
5. Audit trail (breaches are ledgered, actions are logged)

Start Phase 1 today. Ship Phase 2 in 4 weeks. You'll have an enterprise ops platform.
