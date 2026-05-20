# FitStn Real-Time Operations Management System
## Enterprise-Grade Implementation Plan

> **Audience:** Workforce Management Architect, Support Operations Engineer, Enterprise Dashboard Designer
> **Scope:** Online fitness coaching follow-up team — SLA-critical, multi-tier support
> **Date:** 2026-05-17

---

## Table of Contents

1. [System Architecture Review](#1-system-architecture-review)
2. [Operations Logic Design](#2-operations-logic-design)
3. [Utilization Model](#3-utilization-model)
4. [Queue Engine Design](#4-queue-engine-design)
5. [Alert Engine Design](#5-alert-engine-design)
6. [Ops Score Engine](#6-ops-score-engine)
7. [Real-Time System Design](#7-real-time-system-design)
8. [Database Design](#8-database-design)
9. [UI/UX Redesign Plan](#9-uiux-redesign-plan)
10. [Advanced Operational Features](#10-advanced-operational-features)
11. [Implementation Roadmap](#11-implementation-roadmap)
12. [Enterprise-Grade Improvements](#12-enterprise-grade-improvements)

---

## 1. System Architecture Review

### 1.1 Current Architectural Weaknesses

| Layer | Weakness | Risk Level |
|---|---|---|
| Shift Detection | No real-time shift boundary evaluation — agents on shift derived from static schedule lookup | CRITICAL |
| Utilization | Chat count used as a proxy for workload — ignores package weight, SLA age, and concurrency | CRITICAL |
| Alert Engine | Stateless — re-fires identical alerts on every polling cycle | HIGH |
| Queue State | No persistent queue state — queue rebuilt from scratch on every request | HIGH |
| Ops Score | No transparent formula — score appears to be an arbitrary aggregation | HIGH |
| Data Freshness | Polling-based — stale windows between polls allow silent SLA breaches | MEDIUM |
| Forecasting | No time-series model — predictions are static thresholds not demand curves | MEDIUM |
| Audit Trail | No event log — operational decisions are unverifiable after the fact | MEDIUM |

### 1.2 Scaling Risks

- **Single polling loop:** All dashboards poll the same endpoints independently. At 10 concurrent admin sessions, the server executes 10x redundant DB queries per cycle.
- **No queue partitioning:** A single queue table scan on every refresh becomes expensive as conversation volume grows.
- **No caching layer:** Every metric recalculated from raw data on demand — no materialized intermediate state.
- **Shift logic tightly coupled to display layer:** Shift boundary logic lives in the frontend or mixed in route handlers rather than a dedicated service.

### 1.3 Operational Blind Spots

- No visibility into **time-to-breach** at a per-chat granularity.
- No **queue velocity** metric — cannot tell if the queue is draining or growing.
- No **agent concurrency tracking** — how many simultaneous active conversations an agent holds.
- No **premium tier isolation** — Pro clients not separately monitored; breaches treated equally to Express breaches.
- No **shift gap detection** — no alarm when agent count drops below minimum coverage threshold.
- No **SLA breach wave forecasting** — unable to predict "5 breaches arriving in the next 10 minutes."

### 1.4 Target Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    CLIENT LAYER                          │
│  Admin Dashboard │ Ops Center │ Mobile View              │
└────────────┬─────────────────────────────────────────────┘
             │ WebSocket (push) + REST (init load)
┌────────────▼─────────────────────────────────────────────┐
│                   API GATEWAY (Express)                  │
│  Auth Middleware │ Rate Limiting │ Request Logging        │
└────────────┬─────────────────────────────────────────────┘
             │
┌────────────▼─────────────────────────────────────────────┐
│               CORE SERVICES (Node.js)                    │
│                                                          │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐  │
│  │ Shift Engine│  │  SLA Engine │  │ Workload Engine  │  │
│  └─────────────┘  └─────────────┘  └─────────────────┘  │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐  │
│  │Queue Engine │  │Alert Engine │  │ Forecast Engine  │  │
│  └─────────────┘  └─────────────┘  └─────────────────┘  │
│  ┌─────────────────────────────────────────────────────┐ │
│  │              Ops Score Engine                       │ │
│  └─────────────────────────────────────────────────────┘ │
└────────────┬─────────────────────────────────────────────┘
             │
┌────────────▼─────────────────────────────────────────────┐
│                   DATA LAYER (Supabase)                  │
│  conversations │ agents │ shifts │ alerts │ queue_state  │
│  sla_events    │ workload_snapshots │ audit_log           │
└──────────────────────────────────────────────────────────┘
```

---

## 2. Operations Logic Design

### 2.1 Package Definitions (Source of Truth)

```js
const PACKAGES = {
  'Fit Solo Pro': {
    sla_hours: 1,
    working_days: [0,1,2,3,4,5],   // Sun–Fri
    window_start: 12,               // 12:00
    window_end: 21,                 // 21:00
    tier: 'PRO',
    complexity_weight: 2.5,
  },
  'Fit Fam Pro': {
    sla_hours: 1,
    working_days: [0,1,2,3,4,5],
    window_start: 12,
    window_end: 21,
    tier: 'PRO',
    complexity_weight: 2.5,
  },
  'Fit Solo': {
    sla_hours: 24,
    working_days: [0,1,2,3,4],     // Sun–Thu
    window_start: 11,
    window_end: 18,
    tier: 'STANDARD',
    complexity_weight: 1.5,
  },
  'Fit Duo': {
    sla_hours: 24,
    working_days: [0,1,2,3,4],
    window_start: 11,
    window_end: 18,
    tier: 'STANDARD',
    complexity_weight: 1.5,
  },
  'Fit Fam': {
    sla_hours: 24,
    working_days: [0,1,2,3,4],
    window_start: 11,
    window_end: 18,
    tier: 'STANDARD',
    complexity_weight: 1.5,
  },
  'Fit Express': {
    sla_hours: null,                // weekly scheduled reply
    working_days: [0,1,2,3,4],
    window_start: 11,
    window_end: 18,
    tier: 'EXPRESS',
    complexity_weight: 0.8,
  },
};
```

### 2.2 SLA Engine — Working-Hours-Only Clock

SLA breach calculations MUST account for working hours only, not wall-clock time.

**Algorithm: `computeSlaDeadline(received_at, package)`**

```
1. Start from received_at
2. If outside working window → advance to next window open
3. Consume SLA hours only while inside working window
4. Return deadline timestamp
```

**Algorithm: `computeTimeToBreachMinutes(deadline, now)`**

```
1. If now > deadline → already breached (negative value)
2. Remaining = deadline - now (working minutes only)
3. Return remaining_minutes
```

### 2.3 Shift Detection Engine

**Problem:** "Agents on shift = 0" while overloaded agents show data. Root cause is static schedule lookup failing to match current time to active shift windows.

**Correct Logic:**

```js
function isAgentOnShift(agent, now) {
  const dayOfWeek = now.getDay();       // 0=Sun, 6=Sat
  const hour = now.getHours();
  const minute = now.getMinutes();
  const timeDecimal = hour + minute / 60;

  const todayShift = agent.shifts.find(s =>
    s.day_of_week === dayOfWeek &&
    s.start_hour <= timeDecimal &&
    s.end_hour > timeDecimal
  );

  return !!todayShift;
}

function getAgentShiftStatus(agent, now) {
  if (!isAgentOnShift(agent, now)) return 'OFF_SHIFT';
  if (agent.last_seen < now - ONLINE_THRESHOLD_MS) return 'ON_SHIFT_OFFLINE';
  return 'ON_SHIFT_ONLINE';
}
```

**Agent Status Taxonomy:**

| Status | Definition |
|---|---|
| `ON_SHIFT_ONLINE` | Shift is active AND agent activity seen within threshold |
| `ON_SHIFT_OFFLINE` | Shift is active BUT no recent activity (possible absence) |
| `OFF_SHIFT` | Shift window not active for this agent right now |
| `ON_BREAK` | Agent manually marked on break |

### 2.4 Prioritization System

Every pending conversation is scored and sorted by a **Priority Score**:

```
Priority Score = (SLA Urgency Weight × 40)
              + (Package Tier Weight × 30)
              + (Queue Age Weight × 20)
              + (Client VIP Flag × 10)
```

| Component | Formula |
|---|---|
| SLA Urgency | `1 - (minutes_remaining / sla_window_minutes)` → 0.0–1.0 |
| Package Tier | PRO=1.0, STANDARD=0.5, EXPRESS=0.2 |
| Queue Age | `min(queue_age_minutes / 120, 1.0)` → capped at 1.0 |
| VIP Flag | 1 if client flagged VIP, else 0 |

---

## 3. Utilization Model

### 3.1 The Problem with Chat Count

Using raw chat count as utilization ignores:
- A Pro chat requires ~2.5× more cognitive effort than Express
- An SLA-critical chat demands immediate attention (urgency multiplier)
- Active (typing) conversations require more attention than waiting ones
- Concurrency — handling 3 simultaneous chats is non-linear effort

### 3.2 Weighted Workload Score (WWS)

For each agent:

```
WWS = Σ (chat_i.base_weight × chat_i.urgency_multiplier × chat_i.activity_multiplier)
```

**Base Weight by Package:**

| Package | Base Weight |
|---|---|
| Fit Solo Pro | 2.5 |
| Fit Fam Pro | 2.5 |
| Fit Solo | 1.5 |
| Fit Duo | 1.5 |
| Fit Fam | 1.5 |
| Fit Express | 0.8 |

**Urgency Multiplier:**

```
urgency_pct = 1 - (minutes_to_breach / sla_window_minutes)

if urgency_pct >= 0.90 → multiplier = 3.0   (breach imminent)
if urgency_pct >= 0.75 → multiplier = 2.0   (critical)
if urgency_pct >= 0.50 → multiplier = 1.5   (elevated)
else                   → multiplier = 1.0   (normal)
```

**Activity Multiplier:**

```
if chat.state = 'ACTIVE'   → 1.3  (agent actively typing/reading)
if chat.state = 'WAITING'  → 1.0  (awaiting client reply)
if chat.state = 'RESOLVED' → 0.0  (excluded)
```

### 3.3 Utilization Percentage

```
Utilization% = (Agent_WWS / Agent_Max_WWS) × 100
```

**Agent_Max_WWS** is the sustainable capacity ceiling. Default model:

```
Agent_Max_WWS = concurrent_capacity × avg_chat_weight × comfort_factor

Where:
  concurrent_capacity = 6 chats (configurable per agent)
  avg_chat_weight     = 1.5 (weighted average of STANDARD package)
  comfort_factor      = 0.85 (15% headroom for quality)

Default Max_WWS = 6 × 1.5 × 0.85 = 7.65
```

**Utilization thresholds:**

| Range | Status |
|---|---|
| 0–60% | Underutilized |
| 60–80% | Optimal |
| 80–95% | Elevated |
| 95–110% | Overloaded |
| >110% | Critical Overload |

### 3.4 Team Utilization

```
Team_Utilization% = (Σ Agent_WWS) / (Σ Agent_Max_WWS) × 100
```

Only agents with status `ON_SHIFT_ONLINE` or `ON_SHIFT_OFFLINE` are included in the denominator.

### 3.5 Effective Capacity

```
Effective_Capacity = Σ (Agent_Max_WWS) for ON_SHIFT_ONLINE agents only

Capacity_Gap = Team_Demand_WWS - Effective_Capacity
```

A positive `Capacity_Gap` means the team is structurally overloaded — not just one agent.

### 3.6 Occupancy Rate

```
Occupancy% = (Time_Handling_Chats) / (Total_Shift_Time) × 100
```

Target occupancy for sustainable operations: **70–80%**. Above 85% leads to quality degradation and burnout.

---

## 4. Queue Engine Design

### 4.1 Queue State Model

Each conversation in the queue carries this state:

```ts
interface QueueEntry {
  conversation_id:     string;
  client_name:         string;
  package:             PackageKey;
  tier:                'PRO' | 'STANDARD' | 'EXPRESS';
  assigned_agent_id:   string | null;
  received_at:         Date;
  last_interaction_at: Date;
  last_message_side:   'client' | 'staff';
  sla_deadline:        Date;
  minutes_to_breach:   number;        // recalculated on each tick
  queue_age_minutes:   number;
  base_weight:         number;
  urgency_multiplier:  number;
  priority_score:      number;        // composite (see §2.4)
  urgency_level:       'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  breach_predicted_at: Date | null;   // forecasted breach time
}
```

### 4.2 Urgency Level Assignment

```
if minutes_to_breach <= 0            → BREACHED (outside queue, tracked separately)
if minutes_to_breach <= 15           → CRITICAL
if minutes_to_breach <= 60           → HIGH
if minutes_to_breach <= sla_30pct   → MEDIUM
else                                 → LOW
```

Where `sla_30pct = sla_window_minutes × 0.30`.

### 4.3 Queue Sorting Algorithm

Default sort order (multi-key, descending priority):

```
1. urgency_level (CRITICAL > HIGH > MEDIUM > LOW)
2. tier (PRO > STANDARD > EXPRESS)
3. priority_score (descending)
4. minutes_to_breach (ascending — soonest breach first)
5. queue_age_minutes (descending — oldest first as tiebreaker)
```

### 4.4 Time-to-Breach Engine

Working-hours-aware countdown:

```js
function getWorkingMinutesRemaining(now, deadline, packageKey) {
  const pkg = PACKAGES[packageKey];
  let remaining = 0;
  let cursor = new Date(now);

  while (cursor < deadline) {
    if (isWorkingTime(cursor, pkg)) {
      remaining++;
    }
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return remaining;
}
```

For performance, pre-compute deadlines and cache them. Recalculate only when `now` crosses a working window boundary.

### 4.5 Breach Wave Forecasting

Every 60 seconds, compute:

```
breach_waves = {
  next_15_min: queue.filter(c => c.minutes_to_breach <= 15).length,
  next_30_min: queue.filter(c => c.minutes_to_breach <= 30).length,
  next_60_min: queue.filter(c => c.minutes_to_breach <= 60).length,
  by_tier: {
    PRO: queue.filter(c => c.tier === 'PRO' && c.minutes_to_breach <= 60),
    ...
  }
}
```

### 4.6 Queue Flow Metrics

Track these every tick:

| Metric | Formula |
|---|---|
| Incoming Rate | new conversations per 15-min window |
| Processed Rate | replied conversations per 15-min window |
| Net Queue Growth | Incoming Rate − Processed Rate |
| Drain Time | current_queue_size / processed_rate_per_hour |
| Queue Velocity | signed rate of change (negative = draining) |

If `Net Queue Growth > 0` consistently for 3 windows → trigger staffing alert.

---

## 5. Alert Engine Design

### 5.1 The Deduplication Problem

Current engine fires one alert per polling cycle. An overloaded agent alert fires every 30 seconds — creating noise that masks real escalations.

**Solution: Stateful Alert Registry**

```ts
interface AlertRecord {
  alert_id:     string;               // stable hash of (type + subject_id)
  type:         AlertType;
  subject_id:   string;               // agent_id, queue segment, etc.
  state:        'FIRING' | 'WORSENING' | 'STABLE' | 'RESOLVED';
  severity:     'INFO' | 'WARNING' | 'CRITICAL' | 'EMERGENCY';
  first_fired:  Date;
  last_updated: Date;
  resolved_at:  Date | null;
  fire_count:   number;
  metadata:     Record<string, any>;
}
```

### 5.2 Alert Lifecycle

```
NEW CONDITION DETECTED
        │
        ▼
Alert exists in registry?
   NO  ─────► CREATE alert (state=FIRING, severity=initial)
        │
       YES
        ▼
Condition worsened?
   YES ─────► UPDATE state=WORSENING, escalate severity
        │      reset cooldown timer
        ▼
Condition improved?
   NO  ─────► state=STABLE (no new notification)
        │
       YES
        ▼
Condition resolved?
   YES ─────► state=RESOLVED, log to alert_history
```

### 5.3 Cooldown Logic

```
On FIRING:    notify immediately
On WORSENING: notify immediately (overrides cooldown)
On STABLE:    suppress for cooldown_minutes (default: 15 min)
On RESOLVED:  notify once (resolution notification)
```

Cooldown is **per alert_id**, not global.

### 5.4 Severity Escalation Matrix

| Alert Type | INFO | WARNING | CRITICAL | EMERGENCY |
|---|---|---|---|---|
| Agent Overload | WWS 80–95% | WWS 95–110% | WWS >110% | WWS >130% |
| SLA Breach Risk | 60 min to breach | 30 min to breach | 15 min to breach | Breach active |
| Queue Velocity | net +2/hr | net +5/hr | net +10/hr | net +20/hr |
| Staffing Coverage | 1 below min | at min | 2 below min | 0 agents on shift |
| PRO Tier At Risk | 1 PRO near breach | 2 PRO near breach | PRO breached | Multiple PRO breached |

### 5.5 Alert Types Registry

```
AGENT_OVERLOAD          — per agent
AGENT_OFFLINE_ON_SHIFT  — per agent
SLA_BREACH_IMMINENT     — per conversation
SLA_BREACH_ACTIVE       — per conversation
QUEUE_GROWING           — team level
QUEUE_CRITICAL          — team level
STAFFING_SHORTAGE       — shift level
CAPACITY_GAP            — team level
PRO_TIER_AT_RISK        — package level
FORECAST_FAILURE        — predictive
```

---

## 6. Ops Score Engine

### 6.1 Scoring Philosophy

The Ops Score is a **weighted composite** of 6 operational health dimensions. Each dimension produces a score from 0–100. A transparent formula ensures managers can explain why the score changed.

### 6.2 Dimension Formulas

**Dimension 1: SLA Health (weight: 25%)**
```
SLA_Health = 100 × (1 - (breached_count / max(pending_count, 1)))
           - (near_breach_count × 5)   // penalty per near-breach
Clamped to [0, 100]
```

**Dimension 2: Queue Health (weight: 20%)**
```
Queue_Health = 100 - clamp(queue_velocity × 10, 0, 100)
             - clamp((queue_size / ideal_queue_size - 1) × 50, 0, 50)
```

**Dimension 3: Staffing Health (weight: 20%)**
```
Staffing_Health = clamp((online_agents / required_agents) × 100, 0, 100)
```

**Dimension 4: PRO Tier Risk (weight: 20%)**
```
PRO_Risk = 100 - (pro_breached × 30) - (pro_near_breach × 15)
Clamped to [0, 100]
```

**Dimension 5: Capacity Balance (weight: 10%)**
```
Capacity_Balance = 100 - clamp(max_agent_utilization - 80, 0, 20) × 5
                 - clamp(overloaded_agent_count × 10, 0, 40)
```

**Dimension 6: Backlog Risk (weight: 5%)**
```
Backlog_Risk = 100 - clamp((drain_time_hours - 1) × 20, 0, 100)
```

### 6.3 Composite Ops Score

```
Ops_Score = (SLA_Health × 0.25)
          + (Queue_Health × 0.20)
          + (Staffing_Health × 0.20)
          + (PRO_Tier_Risk × 0.20)
          + (Capacity_Balance × 0.10)
          + (Backlog_Risk × 0.05)
```

### 6.4 Score Bands

| Score | Label | Color |
|---|---|---|
| 90–100 | Excellent | Green |
| 75–89 | Good | Blue |
| 60–74 | Fair | Yellow |
| 40–59 | At Risk | Orange |
| 0–39 | Critical | Red |

### 6.5 Explainability Output

Every score emission includes a breakdown:

```json
{
  "ops_score": 71,
  "band": "Fair",
  "dimensions": {
    "sla_health":        { "score": 85, "weight": 0.25, "contribution": 21.25, "note": "2 near-breach chats" },
    "queue_health":      { "score": 60, "weight": 0.20, "contribution": 12.00, "note": "queue growing +4/hr" },
    "staffing_health":   { "score": 80, "weight": 0.20, "contribution": 16.00, "note": "4/5 required agents online" },
    "pro_tier_risk":     { "score": 70, "weight": 0.20, "contribution": 14.00, "note": "1 PRO near breach" },
    "capacity_balance":  { "score": 75, "weight": 0.10, "contribution":  7.50, "note": "Manar at 98% utilization" },
    "backlog_risk":      { "score": 100, "weight": 0.05, "contribution":  5.00, "note": "queue draining normally" }
  },
  "top_risk": "queue_health",
  "confidence": "HIGH"
}
```

**Confidence Level:**
- `HIGH`: all required data freshness < 2 minutes
- `MEDIUM`: some data 2–5 minutes stale
- `LOW`: data older than 5 minutes or missing components

---

## 7. Real-Time System Design

### 7.1 Refresh Strategy

**Problem:** Pure polling means stale data between cycles and redundant computation.

**Solution: Hybrid Push + Pull**

```
WebSocket (push):
  - Alert state changes     → immediate push on event
  - SLA breach imminent     → push when TTB crosses threshold
  - Agent status changes    → push on state transition
  - Ops score updates       → push every 60 seconds or on trigger

REST polling (pull):
  - Queue table data        → every 30 seconds (operator-tunable)
  - Workload snapshot       → every 60 seconds
  - Forecast data           → every 5 minutes
  - Historical analytics    → on demand
```

### 7.2 Server-Side Event Loop Architecture

```js
class OpsEngineLoop {
  async tick() {
    const now = new Date();

    const [conversations, agents, shifts] = await Promise.all([
      this.fetchPendingConversations(),
      this.fetchAgentStatuses(),
      this.fetchActiveShifts(now),
    ]);

    const shiftState    = this.shiftEngine.evaluate(agents, shifts, now);
    const queueState    = this.queueEngine.evaluate(conversations, now);
    const workloadState = this.workloadEngine.evaluate(agents, conversations, now);
    const alertDelta    = this.alertEngine.evaluate(shiftState, queueState, workloadState);
    const opsScore      = this.scoreEngine.compute(shiftState, queueState, workloadState);

    await this.persistSnapshot({ shiftState, queueState, workloadState, opsScore, now });

    this.pushDeltas({ alertDelta, opsScore, queueState });
  }
}
```

### 7.3 WebSocket Architecture

```
ws://server/ops-stream

Client → Server:
  { type: 'SUBSCRIBE', channels: ['alerts', 'queue', 'score'] }
  { type: 'UNSUBSCRIBE', channels: ['queue'] }

Server → Client:
  { type: 'ALERT_DELTA',  payload: AlertRecord[] }
  { type: 'SCORE_UPDATE', payload: OpsScoreResult }
  { type: 'QUEUE_UPDATE', payload: QueueEntry[] }
  { type: 'HEARTBEAT',    payload: { server_time, data_freshness } }
```

### 7.4 Caching Strategy

| Data Type | Cache TTL | Cache Layer |
|---|---|---|
| Agent shift schedule | 5 minutes | In-memory (server) |
| Package definitions | Indefinite | Module-level constant |
| Working hours calculations | 1 minute | In-memory per agent |
| Historical queue snapshots | 1 hour | Redis / Supabase |
| Demand forecast | 15 minutes | DB materialized view |

### 7.5 Polling Optimization

- Deduplicate identical requests within a 500ms window (debounce)
- Add `ETag`/`Last-Modified` headers to queue endpoints
- Respond with `304 Not Modified` when queue state hash unchanged
- Implement server-sent compression (gzip) for queue payloads > 1KB

---

## 8. Database Design

### 8.1 Core Tables

**`queue_state` — live queue snapshot**
```sql
CREATE TABLE queue_state (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id     TEXT NOT NULL UNIQUE,
  client_name         TEXT,
  package             TEXT NOT NULL,
  tier                TEXT NOT NULL CHECK (tier IN ('PRO','STANDARD','EXPRESS')),
  assigned_agent_id   UUID REFERENCES agents(id),
  received_at         TIMESTAMPTZ NOT NULL,
  last_interaction_at TIMESTAMPTZ,
  last_message_side   TEXT CHECK (last_message_side IN ('client','staff')),
  sla_deadline        TIMESTAMPTZ NOT NULL,
  priority_score      NUMERIC(5,2),
  urgency_level       TEXT,
  queue_age_minutes   INTEGER,
  wws_contribution    NUMERIC(5,2),
  updated_at          TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_queue_sla_deadline ON queue_state(sla_deadline);
CREATE INDEX idx_queue_tier ON queue_state(tier);
CREATE INDEX idx_queue_agent ON queue_state(assigned_agent_id);
CREATE INDEX idx_queue_urgency ON queue_state(urgency_level, priority_score DESC);
```

**`alert_registry` — stateful alert store**
```sql
CREATE TABLE alert_registry (
  alert_id       TEXT PRIMARY KEY,
  type           TEXT NOT NULL,
  subject_id     TEXT NOT NULL,
  state          TEXT NOT NULL,
  severity       TEXT NOT NULL,
  first_fired    TIMESTAMPTZ NOT NULL,
  last_updated   TIMESTAMPTZ NOT NULL,
  resolved_at    TIMESTAMPTZ,
  fire_count     INTEGER DEFAULT 1,
  metadata       JSONB,
  cooldown_until TIMESTAMPTZ
);

CREATE INDEX idx_alert_state ON alert_registry(state) WHERE state != 'RESOLVED';
CREATE INDEX idx_alert_subject ON alert_registry(subject_id, type);
```

**`workload_snapshots` — time-series agent utilization**
```sql
CREATE TABLE workload_snapshots (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_at     TIMESTAMPTZ NOT NULL,
  agent_id        UUID REFERENCES agents(id),
  wws             NUMERIC(6,2),
  utilization_pct NUMERIC(5,2),
  chat_count      INTEGER,
  shift_status    TEXT,
  recorded_at     TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_workload_agent_time ON workload_snapshots(agent_id, snapshot_at DESC);
CREATE INDEX idx_workload_time ON workload_snapshots(snapshot_at DESC);
```

**`ops_score_history` — historical score tracking**
```sql
CREATE TABLE ops_score_history (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scored_at        TIMESTAMPTZ NOT NULL,
  ops_score        NUMERIC(5,2),
  sla_health       NUMERIC(5,2),
  queue_health     NUMERIC(5,2),
  staffing_health  NUMERIC(5,2),
  pro_tier_risk    NUMERIC(5,2),
  capacity_balance NUMERIC(5,2),
  backlog_risk     NUMERIC(5,2),
  confidence       TEXT,
  metadata         JSONB
);

CREATE INDEX idx_ops_score_time ON ops_score_history(scored_at DESC);
```

**`sla_events` — breach audit log**
```sql
CREATE TABLE sla_events (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id   TEXT NOT NULL,
  agent_id          UUID,
  package           TEXT,
  tier              TEXT,
  event_type        TEXT NOT NULL,  -- 'NEAR_BREACH' | 'BREACH' | 'RESOLVED'
  sla_deadline      TIMESTAMPTZ,
  event_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  minutes_overdue   INTEGER,
  metadata          JSONB
);

CREATE INDEX idx_sla_events_conv ON sla_events(conversation_id, event_at DESC);
CREATE INDEX idx_sla_events_type ON sla_events(event_type, event_at DESC);
CREATE INDEX idx_sla_events_agent ON sla_events(agent_id, event_at DESC);
```

**`audit_log` — immutable operations log**
```sql
CREATE TABLE audit_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  logged_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_id    UUID,
  actor_type  TEXT,
  action      TEXT NOT NULL,
  entity_type TEXT,
  entity_id   TEXT,
  before_val  JSONB,
  after_val   JSONB,
  ip_address  INET,
  session_id  TEXT
);

CREATE INDEX idx_audit_time ON audit_log(logged_at DESC);
CREATE INDEX idx_audit_actor ON audit_log(actor_id, logged_at DESC);
CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id, logged_at DESC);
```

### 8.2 Retention Policy

| Table | Retention | Strategy |
|---|---|---|
| queue_state | Live only | Truncate on resolution |
| workload_snapshots | 90 days | Partition by month |
| ops_score_history | 180 days | Partition by month |
| sla_events | 365 days | Archive to cold storage |
| audit_log | Indefinite | Append-only, compress after 90 days |
| alert_registry | 30 days resolved | Auto-archive resolved alerts |

---

## 9. UI/UX Redesign Plan

### 9.1 Command Center Layout

```
┌──────────────────────────────────────────────────────────────┐
│  HEADER BAR: Ops Score [71] │ Shift Status │ Live Clock      │
│             Alert Count [3] │ Queue [47]   │ Refresh         │
├────────────┬─────────────────────────────┬───────────────────┤
│            │                             │                   │
│  ALERT     │   QUEUE TABLE               │  STAFFING         │
│  PANEL     │   (sortable / filterable)   │  PANEL            │
│  (5 rows)  │   Full width, compact rows  │  Agent cards      │
│            │                             │  WWS bar          │
│            │                             │  Shift status     │
├────────────┴─────────────────────────────┴───────────────────┤
│  METRICS ROW: SLA Health │ Queue Flow │ Capacity │ Breaches  │
├──────────────────────────────────────────────────────────────┤
│  FORECAST ROW: Breach Wave │ Drain Time │ Demand Curve       │
└──────────────────────────────────────────────────────────────┘
```

### 9.2 Information Density System

**Compact Card Spec (metric cards):**
- Height: 56px
- Label: 11px, muted
- Value: 24px bold
- Trend indicator: 12px, right-aligned
- Color stripe: 4px left border = status color

**Queue Table Row Spec (36px row height):**

| Column | Width | Content |
|---|---|---|
| Priority # | 28px | Rank |
| Urgency badge | 48px | CRITICAL / HIGH / MED / LOW |
| Client name | 120px | Full name |
| Package tier chip | 72px | PRO / STD / EXP |
| Agent | 100px | Assigned agent |
| TTB countdown | 80px | `14m 22s` |
| Queue age | 64px | `2h 15m` |
| Last msg side | 24px | Client/Staff icon |
| Action | 32px | Reassign button |

### 9.3 Breach Wave Display

```
┌─────────────────────────────────────┐
│  SLA BREACH WAVES                   │
│                                     │
│  ⚠ 3 chats breaching in 15 min     │  RED, pulsing
│  ▲ 7 chats breaching in 30 min     │  ORANGE
│  ● 12 chats breaching in 60 min    │  YELLOW
│                                     │
│  PRO: 1 critical │ STD: 2 high     │
└─────────────────────────────────────┘
```

### 9.4 Agent Utilization Card (compact)

```
┌─────────────────────────────────────────┐
│  Manar           ● ON SHIFT    98% ████▓│
│  6 chats │ WWS 7.5/7.65 │ 2 PRO active │
│  ⚠ OVERLOADED — reassign 2 chats       │
├─────────────────────────────────────────┤
│  Mahmoud         ● ON SHIFT    52% ███░ │
│  4 chats │ WWS 4.0/7.65 │ AVAILABLE    │
└─────────────────────────────────────────┘
```

### 9.5 Operational Ergonomics

- **Keyboard shortcuts:**
  - `Q` — focus queue filter
  - `A` — focus alert panel
  - `R` — force refresh
  - `Esc` — clear selection
- One-click reassignment from queue row → agent dropdown
- Alert dismiss with mandatory reason (feeds audit log)
- Sticky column headers on queue table while scrolling
- Visual urgency heatmap: row background intensity scales with priority score

### 9.6 Color System

| Meaning | Color |
|---|---|
| Critical / Breach | `#dc2626` (red-600) |
| Warning / Elevated | `#ea580c` (orange-600) |
| Caution / Near-breach | `#d97706` (amber-600) |
| Normal / Online | `#16a34a` (green-600) |
| Off shift / Inactive | `#6b7280` (gray-500) |
| PRO tier indicator | `#7c3aed` (violet-600) |
| EXPRESS tier indicator | `#0284c7` (sky-600) |

### 9.7 Mobile Responsiveness

- Below 768px: single-column feed layout
- Queue table → swipeable cards on mobile
- Agent cards → stacked vertical layout
- Alerts → full-width banner at top
- Ops Score → fixed bottom bar on mobile

---

## 10. Advanced Operational Features

### 10.1 Staffing Simulator

Answers the question: "What happens if I add/remove an agent?"

**Inputs:** current queue state, current workload distribution, proposed staffing change

**Outputs:**
- Projected TTB for each breach-risk chat
- New team utilization %
- Estimated breach count under new staffing
- Recommended action: "Add 1 agent to cover Pro queue"

**What-if scenarios:**
```
Scenario A: "Remove agent X"     → show utilization spike + breach risk
Scenario B: "Add agent X"        → show capacity relief + drain time
Scenario C: "All agents on break"→ show blackout risk window
```

### 10.2 Forecasting Engine

**Demand Forecasting:**
```
Use historical conversation volumes by:
  - Hour of day
  - Day of week
  - Package distribution

Model: Weighted moving average (7-day rolling)
Output: Projected hourly incoming rate for next 8 hours
```

**Staffing Recommendation:**
```
Required_Agents = ceil(Projected_Demand_WWS / Agent_Max_WWS)
Minimum_Coverage = Required_Agents + 1  (redundancy buffer)
```

**Surge Detection:**
```
If actual_incoming_rate > forecast × 1.4 for 2 consecutive windows:
  → SURGE ALERT: demand exceeds forecast by X%
  → Trigger staffing review notification
```

### 10.3 Anomaly Detection

| Anomaly | Detection Rule |
|---|---|
| Sudden queue spike | queue_size > 3σ above rolling average |
| Agent burnout risk | utilization > 90% for > 45 minutes |
| Unusual silence | agent 0 chats handled in last 30 min during shift |
| Client surge | incoming rate doubles vs prior hour |
| SLA breach cluster | 3+ breaches in 10-minute window |

### 10.4 Premium Client Protection System

For PRO tier (Fit Solo Pro, Fit Fam Pro):

- **Dedicated queue lane** — PRO chats always render at top with purple badge
- **Dedicated alert type** — `PRO_TIER_AT_RISK` fires independently
- **Auto-escalation:** If PRO chat has no response in 45 min → notify admin directly
- **Minimum dedicated capacity:** Warn if no agent has capacity < 60% when PRO chats are pending
- **Breach post-mortem:** Every PRO breach logged to `sla_events` with full context

### 10.5 Reassignment Engine

```
1. Manager sees: "Manar: 98% utilization, 2 Pro chats, 3 Standard chats"
2. System suggests: "Move 2 Standard chats to Mahmoud (52% utilization)"
3. Manager clicks "Reassign" on queue row
4. System:
   a. Updates conversation assignment in DB
   b. Notifies receiving agent
   c. Logs to audit_log
   d. Recalculates workload for both agents
   e. Emits QUEUE_UPDATE via WebSocket
```

---

## 11. Implementation Roadmap

### Phase 1 — Foundation Fix (Weeks 1–2)
**Priority: CRITICAL — Restores system trust**

| Task | Complexity | Impact |
|---|---|---|
| Fix shift detection engine | Medium | Eliminates "0 agents on shift" bug |
| Implement WWS utilization model | Medium | Fixes utilization inversion bug |
| Working-hours-aware SLA engine | Medium | Accurate TTB countdowns |
| Stateful alert engine with deduplication | Medium | Eliminates alert fatigue |
| Ops Score with transparent formula | Low | Trustworthy scoring |

**Dependencies:** None — these are self-contained service rewrites.
**Expected Impact:** Dashboard becomes operationally trustworthy.

---

### Phase 2 — Queue Intelligence (Weeks 3–4)
**Priority: HIGH — Enables actionable operations**

| Task | Complexity | Impact |
|---|---|---|
| Live queue table with all fields | Medium | Per-chat visibility |
| Priority score engine | Medium | Correct sorting and urgency |
| Time-to-breach countdown per row | Low | Breach prevention |
| Breach wave forecasting panel | Medium | Proactive staffing |
| Queue flow metrics (velocity, drain) | Low | Queue health awareness |

**Dependencies:** Phase 1 SLA engine.
**Expected Impact:** Managers can act on at-risk chats before breach.

---

### Phase 3 — Workforce Intelligence (Weeks 5–7)
**Priority: HIGH — Enables capacity management**

| Task | Complexity | Impact |
|---|---|---|
| Agent concurrency tracking | Medium | True capacity visibility |
| Effective capacity calculation | Low | Structural overload detection |
| Reassignment engine UI | Medium | Workload balancing |
| Staffing simulator | High | What-if planning |
| PRO client protection system | Medium | Premium SLA defense |

**Dependencies:** Phase 2 queue engine.
**Expected Impact:** Managers can redistribute load and prevent systemic overload.

---

### Phase 4 — Predictive & Enterprise (Weeks 8–12)
**Priority: MEDIUM — Reactive ops → proactive command center**

| Task | Complexity | Impact |
|---|---|---|
| Demand forecasting engine | High | Staffing pre-planning |
| Anomaly detection | High | Early warning system |
| Audit log implementation | Medium | Compliance & accountability |
| Historical analytics | High | Pattern recognition |
| UI density redesign (Ops Center) | High | Operational ergonomics |
| WebSocket push architecture | High | Real-time reactivity |
| Mobile-responsive layout | Medium | On-the-go monitoring |

**Dependencies:** Phases 1–3 complete.
**Expected Impact:** Predictive enterprise command center.

---

## 12. Enterprise-Grade Improvements

### 12.1 Observability

- **`/metrics` endpoint:** ops engine cycle time, queue size, alert count, DB query latency
- **`/health` endpoint:** engine status, data freshness, last tick time
- **Slow query logging:** flag any DB query > 200ms with full context
- **Error boundary logging:** all engine errors logged with stack trace + operational context

### 12.2 Audit Log

Every state-changing action writes to `audit_log`:
- Manual reassignment
- Alert dismiss/acknowledge
- Settings change
- Shift override
- Manual SLA exception

Each entry: `actor`, `action`, `entity`, `before`, `after`, `timestamp`, `ip`.

### 12.3 SLA Auditability

For every SLA breach:
1. Log to `sla_events` with full context (agent, queue age, package, assigned time)
2. Compute: was breach preventable? (agent had capacity before breach)
3. Generate weekly SLA breach report by agent, package, time-of-day
4. Track **Mean Time to Respond (MTTR)** per package tier

### 12.4 Incident Management

When Ops Score drops below 40 (CRITICAL):
1. Trigger `INCIDENT_DECLARED` alert
2. Log incident start to `incidents` table
3. Capture operational snapshot at incident time
4. Track incident duration and resolution
5. Post-incident: auto-generate summary (score drop causes, resolution)

### 12.5 Historical Analytics

Retain and expose:
- Hourly queue size over past 30 days
- Daily SLA breach rate by package
- Agent utilization trends (weekly)
- Ops score trend (daily)
- Peak demand windows (day of week × hour)
- Breach pattern analysis (recurring breach times = structural problem)

### 12.6 Replay System

For incident investigation:
- Record queue state snapshots every 5 minutes
- Replay endpoint: `/ops/replay?from=T1&to=T2`
- Reconstruct what the dashboard showed at any past moment
- Use case: "why did 3 chats breach at 2pm on Tuesday?"

---

## Summary: Critical Path

```
Weeks 1–2:  Phase 1 — Shift fix + WWS utilization + Alert dedup + Ops Score
Weeks 3–4:  Phase 2 — Queue table + TTB engine + Breach waves
Weeks 5–7:  Phase 3 — Reassignment + Capacity model + PRO protection
Weeks 8–12: Phase 4 — Forecasting + Anomaly detection + UI redesign + WebSocket
```

**After Phase 1** — Operationally trustworthy
**After Phase 2** — Actionable
**After Phase 3** — Manageable at scale
**After Phase 4** — Predictive enterprise command center

---

*FitStn Follow-Up Operations | Confidential | 2026-05-17*
