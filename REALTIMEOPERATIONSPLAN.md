Real-Time Operations Management System
Architectural Specification — FitStn FollowUp RTM
CURRENT STATE ASSESSMENT
Before designing, here is what the existing system does well and where it falls short:

Strengths to preserve:

Supabase RPC integration for live pending counts (get_chat_rooms_paginated)
Gap-based idle calculation (accurate, not event-dependent)
Hourly demand snapshots table (solid foundation)
Per-package SLA rule engine in demand-report.js
Per-agent workload ratio (required_pace / max_chats_per_hour)
Critical gaps this design addresses:

No real-time queue state — only historical snapshots
No SLA risk prediction — only backward-looking SLA rate
Utilization inflated: treats all packages equally, ignores concurrency
No operational alerts — managers must manually watch numbers
Fit Express treated identically to live packages (it should not be)
No agent fairness/balance metric
No what-if forecasting
No push mechanism — everything is manual refresh or polling
Dashboard is pure analytics, no actionable operations layer
PART 1: NEW DASHBOARD ARCHITECTURE
1.1 Page Structure
Replace the single demand-report.html monolith with a tabbed Operations Command Center hosted in a new ops-center.html. The existing pages (dashboard.html, demand-report.html) remain unchanged for backward compatibility.


/ops-center.html          ← New real-time command center
/demand-report.html       ← Existing (kept, will be extended)
/dashboard.html           ← Existing agent status view (kept)
1.2 Layout Hierarchy

┌─────────────────────────────────────────────────────────────────┐
│  STICKY ALERT BAR  [Critical alerts only, auto-dismiss]         │
├─────────────────────────────────────────────────────────────────┤
│  STICKY KPI HEADER                                              │
│  [Ops Score] [SLA Health] [Queue Depth] [Agents Online]         │
│  [Burnout Risk] [Premium Risk]  ·  Last updated: 00:23 ago      │
├──────────┬──────────────────────────────────────────────────────┤
│          │                                                       │
│  LEFT    │  MAIN CONTENT AREA                                    │
│  NAV     │                                                       │
│  RAIL    │  Tab: LIVE OPS  │  SLA ENGINE  │  AGENTS  │  PLAN    │
│          │                                                       │
│  [Live]  │  ┌─────────────────────┐  ┌────────────────────┐    │
│  [SLA]   │  │  QUEUE MONITOR      │  │  EXEC SUMMARY      │    │
│  [Agent] │  └─────────────────────┘  └────────────────────┘    │
│  [Plan]  │  ┌─────────────────────────────────────────────┐    │
│  [Alert] │  │  PACKAGE QUEUE BREAKDOWN (with severity)    │    │
│  [Hist]  │  └─────────────────────────────────────────────┘    │
│          │  ┌─────────────────────────────────────────────┐    │
│          │  │  HOURLY DEMAND HEATMAP                       │    │
│          │  └─────────────────────────────────────────────┘    │
│          │  ┌─────────────────────┐  ┌────────────────────┐    │
│          │  │  AGENT LIVE GRID    │  │  ALERTS FEED       │    │
│          │  └─────────────────────┘  └────────────────────┘    │
└──────────┴──────────────────────────────────────────────────────┘
1.3 Tab Definitions
Tab	Content
Live Ops	Queue monitor, exec summary, agent grid, alerts feed
SLA Engine	Risk scores by package, projected SLA charts, breach predictions
Agent Ops	Deep agent management: occupancy, fairness, reassignment
Planning	Hourly heatmaps, staffing charts, forecasting, what-if simulator
Alert Log	Full historical alerts with filters
History	Legacy analytics (merged from demand-report.html)
PART 2: DATABASE SCHEMA IMPROVEMENTS
2.1 New Tables
queue_state
Stores the most recent real-time queue poll per package. Replaces the need to query Supabase in every dashboard request.


CREATE TABLE queue_state (
    id                    SERIAL PRIMARY KEY,
    captured_at           TIMESTAMP NOT NULL DEFAULT NOW(),
    package_name          VARCHAR(100) NOT NULL,
    pending_count         INTEGER NOT NULL DEFAULT 0,
    oldest_pending_at     TIMESTAMP,
    avg_wait_minutes      NUMERIC(8,2),
    near_sla_breach_count INTEGER NOT NULL DEFAULT 0,
    -- "near breach" = waiting > 75% of package SLA window
    sla_breach_threshold_pct NUMERIC(5,2) DEFAULT 75.0,
    UNIQUE(captured_at, package_name)
);

CREATE INDEX idx_queue_state_captured ON queue_state(captured_at DESC);
queue_snapshots
Time-series of queue_state for growth rate calculation.


CREATE TABLE queue_snapshots (
    id             SERIAL PRIMARY KEY,
    snapshot_at    TIMESTAMP NOT NULL DEFAULT NOW(),
    package_name   VARCHAR(100) NOT NULL,
    pending_count  INTEGER NOT NULL,
    agent_id       INTEGER REFERENCES agents(id),
    -- NULL agent_id = aggregate across all agents for package
    UNIQUE(snapshot_at, package_name, agent_id)
);

CREATE INDEX idx_queue_snapshots_time ON queue_snapshots(snapshot_at DESC);
sla_risk_scores
Output of the SLA prediction engine, computed every 15 minutes.


CREATE TABLE sla_risk_scores (
    id                    SERIAL PRIMARY KEY,
    computed_at           TIMESTAMP NOT NULL DEFAULT NOW(),
    package_name          VARCHAR(100) NOT NULL,
    risk_level            VARCHAR(10) NOT NULL CHECK (risk_level IN ('low','medium','high','critical')),
    risk_score            NUMERIC(5,2) NOT NULL,        -- 0–100
    current_sla_rate      NUMERIC(5,2),                 -- % so far today
    projected_sla_1h      NUMERIC(5,2),                 -- projected 1hr from now
    projected_sla_eod     NUMERIC(5,2),                 -- projected end-of-shift
    breach_probability    NUMERIC(5,2),                 -- 0–100%
    predicted_breaches    INTEGER DEFAULT 0,            -- absolute count
    current_queue         INTEGER DEFAULT 0,
    projected_queue_1h    INTEGER DEFAULT 0,
    incoming_rate         NUMERIC(8,2),                 -- chats/hour observed
    handling_rate         NUMERIC(8,2),                 -- chats/hour current capacity
    agents_needed         INTEGER DEFAULT 0,
    UNIQUE(computed_at, package_name)
);

CREATE INDEX idx_sla_risk_time ON sla_risk_scores(computed_at DESC);
operational_alerts

CREATE TABLE operational_alerts (
    id              SERIAL PRIMARY KEY,
    created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
    severity        VARCHAR(10) NOT NULL CHECK (severity IN ('info','warning','critical')),
    alert_type      VARCHAR(50) NOT NULL,
    -- Types: sla_danger, queue_overload, agent_overload, inactive_agent,
    --        demand_spike, no_reply_risk, premium_sla_risk, staffing_gap,
    --        burnout_risk, workload_imbalance
    title           TEXT NOT NULL,
    body            TEXT,
    package_name    VARCHAR(100),
    agent_id        INTEGER REFERENCES agents(id),
    metric_value    NUMERIC(10,2),       -- the triggering value
    metric_threshold NUMERIC(10,2),     -- the threshold it crossed
    is_acknowledged BOOLEAN DEFAULT FALSE,
    acknowledged_at TIMESTAMP,
    acknowledged_by INTEGER REFERENCES admins(id),
    auto_resolved   BOOLEAN DEFAULT FALSE,
    resolved_at     TIMESTAMP
);

CREATE INDEX idx_alerts_created ON operational_alerts(created_at DESC);
CREATE INDEX idx_alerts_severity ON operational_alerts(severity, is_acknowledged);
fit_express_schedule
Tracks the Fit Express weekly follow-up workload separately from live queue.


CREATE TABLE fit_express_schedule (
    id               SERIAL PRIMARY KEY,
    schedule_date    DATE NOT NULL,
    weekday          SMALLINT NOT NULL,    -- 0=Sun, 1=Mon ... 4=Thu
    coach_name       VARCHAR(255),
    total_rooms      INTEGER DEFAULT 0,
    replied_count    INTEGER DEFAULT 0,
    pending_count    INTEGER DEFAULT 0,
    completion_pct   NUMERIC(5,2) DEFAULT 0,
    created_at       TIMESTAMP DEFAULT NOW(),
    updated_at       TIMESTAMP DEFAULT NOW(),
    UNIQUE(schedule_date, coach_name)
);
hourly_demand_snapshots
More granular than the existing demand_snapshots (which is 1 row per agent per day). This records once per hour.


CREATE TABLE hourly_demand_snapshots (
    id              SERIAL PRIMARY KEY,
    snapshot_date   DATE NOT NULL,
    snapshot_hour   SMALLINT NOT NULL,     -- 0–23
    agent_id        INTEGER REFERENCES agents(id),
    package_name    VARCHAR(100),          -- NULL = all packages for agent
    pending_count   INTEGER NOT NULL DEFAULT 0,
    incoming_count  INTEGER NOT NULL DEFAULT 0,  -- chats that arrived this hour
    handled_count   INTEGER NOT NULL DEFAULT 0,  -- chats replied this hour
    breach_count    INTEGER NOT NULL DEFAULT 0,
    agent_active    BOOLEAN DEFAULT TRUE,
    UNIQUE(snapshot_date, snapshot_hour, agent_id, package_name)
);

CREATE INDEX idx_hourly_snap_date ON hourly_demand_snapshots(snapshot_date, snapshot_hour);
agent_capacity_config
Configurable per-package capacity weights (replaces the single avg_minutes_per_chat setting).


CREATE TABLE agent_capacity_config (
    id                    SERIAL PRIMARY KEY,
    package_name          VARCHAR(100) NOT NULL UNIQUE,
    complexity_weight     NUMERIC(4,2) NOT NULL DEFAULT 1.0,
    -- multiplier on base handling time: 1.5 = 50% harder than baseline
    avg_handling_minutes  NUMERIC(6,2) NOT NULL DEFAULT 10.0,
    max_concurrent_chats  SMALLINT DEFAULT 3,
    -- Max chats agent should handle in parallel for this package
    sla_priority          SMALLINT NOT NULL DEFAULT 3,
    -- 1=highest (Fit Solo Pro), 4=lowest (Fit Express)
    is_scheduled_workload BOOLEAN DEFAULT FALSE,
    -- TRUE = Fit Express, handled as batch, not live queue
    updated_at            TIMESTAMP DEFAULT NOW()
);

-- Seed data
INSERT INTO agent_capacity_config
    (package_name, complexity_weight, avg_handling_minutes, max_concurrent_chats, sla_priority, is_scheduled_workload)
VALUES
    ('Fit Solo Pro', 1.5, 12.0, 2, 1, FALSE),
    ('Fit Fam Pro',  1.5, 12.0, 2, 2, FALSE),
    ('Fit Solo',     1.0, 10.0, 3, 3, FALSE),
    ('Fit Duo',      1.0, 10.0, 3, 3, FALSE),
    ('Fit Fam',      1.1, 11.0, 3, 3, FALSE),
    ('Fit Express',  0.4,  5.0, 5, 4, TRUE);
forecast_models
Stores precomputed forecast parameters updated nightly.


CREATE TABLE forecast_models (
    id                  SERIAL PRIMARY KEY,
    package_name        VARCHAR(100) NOT NULL,
    weekday             SMALLINT NOT NULL,           -- 0=Sun .. 6=Sat
    model_type          VARCHAR(20) DEFAULT 'ema',   -- 'ema', 'seasonal'
    alpha               NUMERIC(4,3) DEFAULT 0.3,    -- EMA smoothing factor
    forecast_demand     NUMERIC(8,2),                -- expected daily demand
    seasonality_index   NUMERIC(6,3) DEFAULT 1.0,    -- relative to weekly avg
    std_deviation       NUMERIC(8,2),                -- demand variability
    agents_required     NUMERIC(6,2),
    confidence_low      NUMERIC(8,2),
    confidence_high     NUMERIC(8,2),
    last_computed_at    TIMESTAMP DEFAULT NOW(),
    UNIQUE(package_name, weekday)
);
2.2 Schema Migrations for Existing Tables
Add to agents

ALTER TABLE agents ADD COLUMN IF NOT EXISTS package_specialty VARCHAR(100);
-- Primary package this agent handles (for assignment recommendations)

ALTER TABLE agents ADD COLUMN IF NOT EXISTS max_concurrent_chats SMALLINT DEFAULT 3;
-- Override global capacity config at agent level

ALTER TABLE agents ADD COLUMN IF NOT EXISTS status_updated_at TIMESTAMP;
-- For detecting truly inactive agents (status stale > N minutes)
Add to sessions

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS package_name VARCHAR(100);
-- Backfilled from Supabase room data, enables per-package session metrics

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS first_response_seconds INTEGER;
-- Time from session start to first agent message (key SLA metric)
Add to demand_snapshots

ALTER TABLE demand_snapshots ADD COLUMN IF NOT EXISTS package_breakdown JSONB DEFAULT '{}';
-- { "Fit Solo Pro": 3, "Fit Solo": 12, ... } per agent at snapshot time
PART 3: CALCULATIONS & FORMULAS
3.1 Redesigned Utilization Model
The current formula is:


workload_ratio = (pending / hours_remaining) / (60 / avg_minutes_per_chat)
This is inflated because it ignores package complexity, concurrency, and actual handling capacity.

New formula:


// Step 1: Weighted pending load
function weightedPendingLoad(pendingByPackage, capacityConfig) {
    return Object.entries(pendingByPackage).reduce((total, [pkg, count]) => {
        const cfg = capacityConfig[pkg];
        if (cfg.is_scheduled_workload) return total; // Fit Express excluded from live load
        return total + (count * cfg.complexity_weight);
    }, 0);
}

// Step 2: Agent throughput capacity (chats/hour at sustainable pace)
function agentThroughputCapacity(agent, capacityConfig) {
    // Weighted avg handling time across agent's package mix
    const weightedAvgHandling = computeWeightedAvgHandling(agent, capacityConfig);
    // Base: how many chats per hour the agent can handle sustainably
    const concurrencyFactor = agent.max_concurrent_chats; // e.g., 3
    return (60 / weightedAvgHandling) * concurrencyFactor;
    // Example: 60/10 * 3 = 18 chats/hour max
}

// Step 3: Required throughput to clear queue before shift end
function requiredThroughput(weightedLoad, hoursRemaining) {
    if (hoursRemaining <= 0) return Infinity;
    return weightedLoad / hoursRemaining;
}

// Step 4: Utilization score (0–100+)
function utilizationScore(required, capacity) {
    return (required / capacity) * 100;
}

// Thresholds
const UTILIZATION_THRESHOLDS = {
    HEALTHY:       { max: 70,  label: 'Healthy',       color: '#22c55e' },
    BUSY:          { max: 85,  label: 'Busy',           color: '#f59e0b' },
    OVERLOAD:      { max: 100, label: 'Overload',       color: '#ef4444' },
    UNSUSTAINABLE: { max: Infinity, label: 'Critical',  color: '#991b1b' },
};
Burnout Risk Score (agent-level):


function burnoutRiskScore(agent, sessionData, shiftData) {
    const factors = {
        utilizationScore:   clamp(utilizationScore / 100, 0, 1.5),  // weight: 0.40
        continuousHours:    clamp(shiftData.activeHours / 8, 0, 2),  // weight: 0.25
        messagesPerHour:    clamp(sessionData.msgPerHour / 30, 0, 2),// weight: 0.20
        breakFrequency:     clamp(1 - (breakCount / expectedBreaks), 0, 1), // weight: 0.15
    };
    return (
        factors.utilizationScore   * 0.40 +
        factors.continuousHours    * 0.25 +
        factors.messagesPerHour    * 0.20 +
        factors.breakFrequency     * 0.15
    ) * 100;
    // 0–100: <40 safe, 40–70 elevated, >70 high risk
}
3.2 SLA Risk Score (per package)

function computeSlaRiskScore({
    currentSlaRate,          // % achieved so far today
    projectedSlaEod,         // projected by end of shift
    queueDepth,              // pending chats right now
    incomingRate,            // chats arriving per hour (last 2h avg)
    handlingRate,            // chats resolved per hour (last 2h avg)
    oldestPendingMinutes,    // age of oldest unanswered chat
    slaWindowMinutes,        // package max SLA (e.g. 60 for Pro, 1440 for Solo)
}) {
    // Component 1: Queue depth pressure (0–1)
    const queueCapacityRatio = incomingRate / Math.max(handlingRate, 1);
    const queuePressure = clamp(queueCapacityRatio - 0.5, 0, 1);

    // Component 2: SLA erosion (0–1)
    const targetSla = 95; // target SLA %
    const slaGap = clamp((targetSla - projectedSlaEod) / targetSla, 0, 1);

    // Component 3: Near-breach urgency (0–1)
    const breachUrgency = clamp(oldestPendingMinutes / slaWindowMinutes, 0, 1.5);

    // Weighted composite
    const rawScore = (
        queuePressure  * 0.35 +
        slaGap         * 0.40 +
        breachUrgency  * 0.25
    ) * 100;

    const riskScore = clamp(rawScore, 0, 100);

    const riskLevel =
        riskScore >= 75 ? 'critical' :
        riskScore >= 50 ? 'high'     :
        riskScore >= 25 ? 'medium'   : 'low';

    return { riskScore, riskLevel };
}
3.3 Queue Growth Rate

function queueGrowthRate(snapshots, windowMinutes = 15) {
    // snapshots: [{captured_at, pending_count}, ...] sorted newest-first
    const cutoff = Date.now() - windowMinutes * 60 * 1000;
    const recent   = snapshots.filter(s => s.captured_at >= cutoff);
    const baseline = snapshots.find(s => s.captured_at < cutoff);

    if (!baseline || recent.length === 0) return 0;

    const latest = recent[0];
    const delta  = latest.pending_count - baseline.pending_count;
    const elapsedHours = (latest.captured_at - baseline.captured_at) / 3_600_000;
    return delta / elapsedHours; // chats added per hour; negative = shrinking
}
3.4 Projected Queue at T+N

function projectQueueAtTime(currentQueue, incomingRate, handlingRate, hoursAhead) {
    // Linear projection (suitable for 1–4h lookahead)
    const netRate = incomingRate - handlingRate; // chats/hour
    return Math.max(0, currentQueue + netRate * hoursAhead);
}

// Extended version: projected SLA breaches
function projectedBreaches(queueByAge, handlingRate, slaWindowMinutes, hoursAhead) {
    let breaches = 0;
    for (const chat of queueByAge) {
        const projectedAgeMinutes = chat.currentAgeMinutes + (hoursAhead * 60);
        const projectedPosition   = chat.queuePosition / Math.max(handlingRate, 1);
        const totalWaitMinutes    = projectedAgeMinutes + projectedPosition * 60;
        if (totalWaitMinutes > slaWindowMinutes) breaches++;
    }
    return breaches;
}
3.5 Workload Fairness (Gini Coefficient)

function workloadFairness(agentLoads) {
    // Returns 0 (perfect equality) to 1 (maximum inequality)
    const sorted = [...agentLoads].sort((a, b) => a - b);
    const n = sorted.length;
    if (n === 0) return 0;
    const sumDiffs = sorted.reduce((acc, xi, i) =>
        acc + sorted.reduce((acc2, xj) => acc2 + Math.abs(xi - xj), 0), 0);
    const mean = sorted.reduce((a, b) => a + b, 0) / n;
    return sumDiffs / (2 * n * n * mean);
}

// Score: <0.15 balanced, 0.15–0.35 uneven, >0.35 critical imbalance
3.6 Staffing Requirements Formula

function staffingRequired(forecastedDemand, shiftHours, capacityConfig, packageMix) {
    // forecastedDemand: total chats expected for this period
    // packageMix: { 'Fit Solo Pro': 0.2, 'Fit Solo': 0.6, ... } (proportion)
    
    // Weighted chats per agent per shift
    const weightedHandlingTime = Object.entries(packageMix).reduce((sum, [pkg, pct]) => {
        const cfg = capacityConfig[pkg];
        if (cfg.is_scheduled_workload) return sum;
        return sum + cfg.avg_handling_minutes * cfg.complexity_weight * pct;
    }, 0);
    
    const chatsPerAgentPerShift = (shiftHours * 60) / weightedHandlingTime;
    const rawRequired = forecastedDemand / chatsPerAgentPerShift;
    
    // Add 15% buffer for SLA safety
    return Math.ceil(rawRequired * 1.15);
}
3.7 Forecasting: EMA with Day-of-Week Seasonality

function updateEmaForecast(historicalDemand, alpha = 0.3) {
    // historicalDemand: array of {date, weekday, demand} sorted oldest-first
    
    // Group by weekday
    const byWeekday = Array.from({length: 7}, () => []);
    historicalDemand.forEach(d => byWeekday[d.weekday].push(d.demand));
    
    // Compute EMA per weekday
    const forecasts = {};
    for (let wd = 0; wd <= 6; wd++) {
        const series = byWeekday[wd];
        if (series.length === 0) continue;
        
        let ema = series[0];
        for (let i = 1; i < series.length; i++) {
            ema = alpha * series[i] + (1 - alpha) * ema;
        }
        
        const stdDev = computeStdDev(series);
        forecasts[wd] = {
            forecast: Math.round(ema),
            confidenceLow:  Math.round(ema - 1.96 * stdDev),
            confidenceHigh: Math.round(ema + 1.96 * stdDev),
            stdDev: Math.round(stdDev),
        };
    }
    return forecasts;
}
PART 4: QUEUE MANAGEMENT LOGIC
4.1 Queue Polling Engine
The Supabase RPC get_chat_rooms_paginated is the source of truth for queue state. Build a dedicated queue polling service in the backend.


// server/services/queue-engine.js

const POLL_INTERVAL_MS    = 60 * 1000;  // Poll Supabase every 60 seconds
const SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000; // Write snapshot every 5 minutes

class QueueEngine {
    constructor(supabase, db, capacityConfig) {
        this.supabase = supabase;
        this.db = db;
        this.capacityConfig = capacityConfig;
        this.state = {};  // In-memory: { packageName: QueueState }
        this.subscribers = new Set(); // SSE subscribers
    }

    async poll() {
        const packages = Object.keys(SLA_RULES); // ['Fit Solo Pro', ...]
        const results  = await Promise.all(packages.map(p => this.fetchQueueForPackage(p)));
        const now      = new Date();
        
        const newState = {};
        for (const result of results) {
            newState[result.package] = {
                ...result,
                capturedAt: now,
                growthRate: this.computeGrowthRate(result.package, result.pendingCount),
                severity:   this.classifySeverity(result),
            };
        }
        
        this.state = newState;
        this.notifySubscribers({ type: 'queue_update', data: newState, ts: now });
        
        // Persist to queue_state table every N polls
        await this.persistQueueState(newState);
    }

    async fetchQueueForPackage(packageName) {
        // Query Supabase: all rooms waiting for staff reply, for this package
        const { data, error } = await this.supabase.rpc('get_chat_rooms_paginated', {
            p_package_name:      packageName,
            p_last_message_from: 'client',
            p_limit:             500,
            p_offset:            0,
        });
        if (error) throw error;

        const slaRule = SLA_RULES[packageName];
        const now     = Date.now();
        
        let oldestAt = null;
        let nearBreachCount = 0;
        const waitTimes = [];
        
        for (const room of data.rooms) {
            const lastClientMsgAt = new Date(room.last_message_at).getTime();
            const waitMinutes     = (now - lastClientMsgAt) / 60_000;
            waitTimes.push(waitMinutes);
            
            if (!oldestAt || lastClientMsgAt < new Date(oldestAt).getTime()) {
                oldestAt = room.last_message_at;
            }
            
            const breachPct = waitMinutes / slaRule.maxMinutes;
            if (breachPct >= 0.75) nearBreachCount++;  // 75% of SLA window elapsed
        }
        
        const avgWait = waitTimes.length > 0
            ? waitTimes.reduce((a, b) => a + b, 0) / waitTimes.length
            : 0;
        
        return {
            package:          packageName,
            pendingCount:     data.total_count ?? data.rooms.length,
            oldestPendingAt:  oldestAt,
            avgWaitMinutes:   avgWait,
            nearBreachCount:  nearBreachCount,
            maxWaitMinutes:   waitTimes.length > 0 ? Math.max(...waitTimes) : 0,
        };
    }

    classifySeverity(queueState) {
        const { nearBreachCount, pendingCount, avgWaitMinutes } = queueState;
        const slaRule = SLA_RULES[queueState.package];
        
        if (nearBreachCount >= 3 || avgWaitMinutes > slaRule.maxMinutes * 0.85) return 'red';
        if (nearBreachCount >= 1 || avgWaitMinutes > slaRule.maxMinutes * 0.60) return 'yellow';
        return 'green';
    }

    computeGrowthRate(packageName, currentCount) {
        const recent = this.history?.[packageName];
        if (!recent || recent.length < 2) return 0;
        const oldest  = recent[0];
        const delta   = currentCount - oldest.pendingCount;
        const elapsed = (Date.now() - oldest.capturedAt) / 3_600_000;
        return delta / elapsed;  // chats/hour
    }
}
4.2 Priority Queue Sorting
When presenting the queue to managers for action, chats are sorted by priority score:


function priorityScore(chat, packageConfig, slaRule) {
    const waitMinutes    = (Date.now() - new Date(chat.last_message_at)) / 60_000;
    const urgencyRatio   = waitMinutes / slaRule.maxMinutes;    // 0–1+
    const priorityTier   = (5 - packageConfig.sla_priority);    // 4 for Pro, 1 for Express
    
    // Express is scheduled, not live queue → override to 0 urgency
    if (packageConfig.is_scheduled_workload) return 0;
    
    return (urgencyRatio * 60) + (priorityTier * 15);
    // Higher = must be handled first
}

// Queue sorted by priorityScore DESC:
// 1. Fit Solo Pro / Fit Fam Pro approaching breach
// 2. Any package at or past SLA window
// 3. Fit Solo / Duo / Fam by wait time
// 4. Fit Express (scheduled batch, lowest)
4.3 Fit Express Scheduled Workload
Fit Express follows a weekly schedule, not a live queue. Build a separate scheduler:


// server/services/express-scheduler.js

const WORKING_DAYS = [0, 1, 2, 3, 4]; // Sun–Thu
const WINDOW_START = 11;               // 11:00 local
const WINDOW_END   = 18;               // 18:00 local

async function scheduleFitExpressFollowUps(db, supabase, date) {
    const weekday = new Date(date).getDay();
    if (!WORKING_DAYS.includes(weekday)) return;
    
    // Fetch all Fit Express rooms whose scheduled reply day = today
    // "Scheduled reply day" is determined by the room's subscription weekday
    const rooms = await supabase.rpc('get_chat_rooms_paginated', {
        p_package_name: 'Fit Express',
        p_scheduled_weekday: weekday,
        p_limit: 1000,
        p_offset: 0,
    });
    
    await db`
        INSERT INTO fit_express_schedule
            (schedule_date, weekday, total_rooms, pending_count, replied_count)
        VALUES
            (${date}, ${weekday}, ${rooms.total_count}, ${rooms.total_count}, 0)
        ON CONFLICT (schedule_date, COALESCE(coach_name, ''))
        DO UPDATE SET
            total_rooms   = EXCLUDED.total_rooms,
            pending_count = EXCLUDED.pending_count,
            updated_at    = NOW()
    `;
}
PART 5: SLA ENGINE LOGIC
5.1 Engine Architecture
The SLA engine runs as a background service, computing risk scores every 15 minutes and writing to sla_risk_scores.


// server/services/sla-engine.js

const ENGINE_INTERVAL_MS = 15 * 60 * 1000; // Every 15 minutes

class SlaEngine {
    async run(db, queueEngine, agentService) {
        const packages = Object.keys(SLA_RULES);
        
        for (const packageName of packages) {
            const score = await this.computeRiskScore(
                packageName, db, queueEngine, agentService
            );
            
            await this.persistRiskScore(db, packageName, score);
            
            if (score.riskLevel !== 'low') {
                await this.emitAlert(db, packageName, score);
            }
        }
    }

    async computeRiskScore(packageName, db, queueEngine, agentService) {
        const slaRule       = SLA_RULES[packageName];
        const queueState    = queueEngine.state[packageName];
        const activeAgents  = await agentService.getActiveAgentsForPackage(packageName);
        
        // --- Incoming rate: chats arriving per hour (last 3 hours from hourly_demand_snapshots)
        const incomingRate = await this.computeIncomingRate(db, packageName, 3);
        
        // --- Handling rate: chats resolved per hour (last 3 hours from sessions)
        const handlingRate = await this.computeHandlingRate(db, packageName, activeAgents, 3);
        
        // --- Current SLA rate (today so far, from SLA computation)
        const currentSlaRate = await this.computeCurrentSlaRate(db, packageName);
        
        // --- Project queue in 1h
        const projectedQueue1h = projectQueueAtTime(
            queueState?.pendingCount ?? 0,
            incomingRate,
            handlingRate,
            1
        );
        
        // --- Simulate SLA at end of shift
        const hoursLeftInShift = computeHoursLeftInShift(slaRule);
        const projectedQueueEod = projectQueueAtTime(
            queueState?.pendingCount ?? 0,
            incomingRate,
            handlingRate,
            hoursLeftInShift
        );
        
        // --- Projected SLA rates
        // Total chats expected by EOD
        const totalExpected = await this.getTotalExpectedToday(db, packageName, incomingRate, hoursLeftInShift);
        const projectedBreachesByEod = Math.max(0, projectedQueueEod);
        const projectedSlaEod = totalExpected > 0
            ? ((totalExpected - projectedBreachesByEod) / totalExpected) * 100
            : 100;
        
        // --- Risk score composite
        const { riskScore, riskLevel } = computeSlaRiskScore({
            currentSlaRate,
            projectedSlaEod,
            queueDepth:          queueState?.pendingCount ?? 0,
            incomingRate,
            handlingRate,
            oldestPendingMinutes: queueState?.maxWaitMinutes ?? 0,
            slaWindowMinutes:    slaRule.maxMinutes,
        });
        
        // --- Agents needed to clear queue safely
        const agentsNeeded = Math.ceil(incomingRate / this.targetHandlingRatePerAgent(packageName));
        
        return {
            riskScore,
            riskLevel,
            currentSlaRate:   Math.round(currentSlaRate * 10) / 10,
            projectedSlaEod:  Math.round(projectedSlaEod * 10) / 10,
            projectedSla1h:   this.estimateProjectedSla1h(currentSlaRate, projectedSlaEod, hoursLeftInShift),
            breachProbability: this.breachProbability(riskScore),
            predictedBreaches: projectedBreachesByEod,
            currentQueue:     queueState?.pendingCount ?? 0,
            projectedQueue1h,
            incomingRate:     Math.round(incomingRate * 10) / 10,
            handlingRate:     Math.round(handlingRate * 10) / 10,
            agentsNeeded,
        };
    }

    async computeIncomingRate(db, packageName, hours) {
        // Use hourly_demand_snapshots: sum incoming_count over last N hours
        const rows = await db`
            SELECT SUM(incoming_count) AS total, COUNT(*) AS periods
            FROM hourly_demand_snapshots
            WHERE package_name = ${packageName}
              AND snapshot_date = CURRENT_DATE
              AND snapshot_hour >= EXTRACT(HOUR FROM NOW()) - ${hours}
        `;
        const { total, periods } = rows[0];
        return periods > 0 ? (total / periods) : 0;  // avg chats/hour
    }
}
5.2 SLA Risk Display Logic

// Translate risk score into human-readable warning
function slaRiskMessage(packageName, score) {
    if (score.riskLevel === 'critical') {
        return `${packageName} SLA projected to fall to ${score.projectedSlaEod.toFixed(0)}% — immediate action required.`;
    }
    if (score.riskLevel === 'high') {
        return `${packageName} SLA at risk (${score.projectedSlaEod.toFixed(0)}% projected). ${score.agentsNeeded} agents needed.`;
    }
    if (score.riskLevel === 'medium') {
        return `${packageName} showing queue pressure. Monitor closely.`;
    }
    return null;
}
PART 6: FORECASTING LOGIC
6.1 Nightly Model Recomputation
Run once daily at midnight (use node-cron or setInterval with 24h drift guard):


// server/services/forecasting.js

async function recomputeForecastModels(db) {
    // Pull last 8 weeks of daily demand per package per weekday
    const history = await db`
        SELECT
            EXTRACT(DOW FROM snapshot_date)::int AS weekday,
            package_breakdown,
            snapshot_date
        FROM demand_snapshots
        WHERE snapshot_date >= CURRENT_DATE - INTERVAL '56 days'
          AND agent_id IS NOT NULL
        ORDER BY snapshot_date ASC
    `;
    
    // Aggregate demand per package per weekday
    const demandByPkgWeekday = aggregateByPackageWeekday(history);
    
    for (const [packageName, byWeekday] of Object.entries(demandByPkgWeekday)) {
        for (const [weekday, series] of Object.entries(byWeekday)) {
            if (series.length < 3) continue;  // Need at least 3 data points
            
            const alpha    = computeOptimalAlpha(series);  // Minimize MSE
            const ema      = runEma(series, alpha);
            const stdDev   = computeStdDev(series);
            const avgDaily = series.reduce((a, b) => a + b, 0) / series.length;
            const seasonality = ema / (avgDaily || 1);
            
            const capacityCfg = await getCapacityConfig(db, packageName);
            const agentsReq   = staffingRequired(
                ema, SHIFT_HOURS_BY_PACKAGE[packageName],
                capacityCfg, { [packageName]: 1.0 }
            );
            
            await db`
                INSERT INTO forecast_models
                    (package_name, weekday, alpha, forecast_demand, seasonality_index,
                     std_deviation, agents_required, confidence_low, confidence_high,
                     last_computed_at)
                VALUES
                    (${packageName}, ${weekday}, ${alpha}, ${ema}, ${seasonality},
                     ${stdDev}, ${agentsReq},
                     ${Math.max(0, ema - 1.96 * stdDev)},
                     ${ema + 1.96 * stdDev},
                     NOW())
                ON CONFLICT (package_name, weekday) DO UPDATE SET
                    alpha              = EXCLUDED.alpha,
                    forecast_demand    = EXCLUDED.forecast_demand,
                    seasonality_index  = EXCLUDED.seasonality_index,
                    std_deviation      = EXCLUDED.std_deviation,
                    agents_required    = EXCLUDED.agents_required,
                    confidence_low     = EXCLUDED.confidence_low,
                    confidence_high    = EXCLUDED.confidence_high,
                    last_computed_at   = NOW()
            `;
        }
    }
}
6.2 What-If Simulation Engine

// server/routes/what-if.js

// POST /api/what-if/simulate
// Body: { scenario: 'demand_spike'|'agent_absent'|'package_growth', params: {...} }

async function simulateScenario(db, queueEngine, scenario, params) {
    const baseForecasts = await db`SELECT * FROM forecast_models WHERE weekday = ${getCurrentWeekday()}`;
    const baseCapacity  = await computeBaseCapacity(db);
    
    switch (scenario) {
        case 'demand_spike': {
            // "What if demand spikes 50%?"
            const multiplier = 1 + (params.spikePercent / 100);
            return runSimulation(baseForecasts.map(f => ({
                ...f,
                forecast_demand: Math.round(f.forecast_demand * multiplier),
            })), baseCapacity);
        }
        case 'agent_absent': {
            // "What if N agents are absent?"
            const reducedCapacity = {
                ...baseCapacity,
                activeAgents: Math.max(0, baseCapacity.activeAgents - params.agentsAbsent),
            };
            return runSimulation(baseForecasts, reducedCapacity);
        }
        case 'package_growth': {
            // "What if Fit Solo Pro clients increase 30%?"
            return runSimulation(baseForecasts.map(f =>
                f.package_name === params.packageName
                    ? { ...f, forecast_demand: Math.round(f.forecast_demand * (1 + params.growthPct / 100)) }
                    : f
            ), baseCapacity);
        }
    }
}

function runSimulation(forecasts, capacity) {
    const results = [];
    for (const forecast of forecasts) {
        const requiredAgents = staffingRequired(
            forecast.forecast_demand,
            SHIFT_HOURS_BY_PACKAGE[forecast.package_name],
            capacityConfigFromForecast(forecast),
            { [forecast.package_name]: 1.0 }
        );
        
        const agentGap   = requiredAgents - capacity.activeAgents;
        const slaRisk    = estimateSlaRisk(forecast, capacity);
        const utilization = estimateUtilization(forecast.forecast_demand, capacity);
        
        results.push({
            package:        forecast.package_name,
            forecastDemand: forecast.forecast_demand,
            requiredAgents,
            agentGap,           // negative = buffer, positive = shortage
            slaRisk,
            utilization,
            recommendation: buildRecommendation(agentGap, slaRisk),
        });
    }
    return results;
}
PART 7: OPERATIONAL ALERT ENGINE
7.1 Alert Trigger Definitions

// server/services/alert-engine.js

const ALERT_RULES = [
    {
        type:      'sla_danger',
        severity:  (score) => score >= 75 ? 'critical' : 'warning',
        check:     ({ slaScores }) =>
            slaScores
                .filter(s => s.risk_score >= 50)
                .map(s => ({
                    title: `${s.package_name} SLA at risk`,
                    body:  `SLA projected to fall to ${s.projected_sla_eod}% by end of shift.`,
                    metric_value:     s.projected_sla_eod,
                    metric_threshold: 90,
                    package_name:     s.package_name,
                })),
    },
    {
        type:      'queue_overload',
        severity:  ({ growthRate }) => growthRate > 10 ? 'critical' : 'warning',
        check:     ({ queueState }) =>
            Object.values(queueState)
                .filter(q => q.growthRate > 5)  // +5 chats/hour
                .map(q => ({
                    title: `Queue growing: ${q.package}`,
                    body:  `Queue increased by ${Math.round(q.growthRate)} chats/hr. Currently ${q.pendingCount} pending.`,
                    metric_value:     q.growthRate,
                    metric_threshold: 5,
                    package_name:     q.package,
                })),
    },
    {
        type:      'no_reply_risk',
        severity:  () => 'critical',
        check:     ({ queueState }) =>
            Object.values(queueState)
                .filter(q => q.nearBreachCount >= 1)
                .map(q => ({
                    title: `${q.nearBreachCount} ${q.package} chat(s) near SLA breach`,
                    body:  `Oldest waiting: ${Math.round(q.maxWaitMinutes)}m. SLA window: ${SLA_RULES[q.package].maxMinutes}m.`,
                    metric_value:     q.nearBreachCount,
                    metric_threshold: 1,
                    package_name:     q.package,
                })),
    },
    {
        type:      'agent_overload',
        severity:  ({ score }) => score > 100 ? 'critical' : 'warning',
        check:     ({ agentUtilizations }) =>
            agentUtilizations
                .filter(a => a.utilizationScore > 85)
                .map(a => ({
                    title:    `${a.agent_name} utilization critical`,
                    body:     `Utilization at ${Math.round(a.utilizationScore)}%. Consider reassigning ${Math.ceil(a.overloadChats)} chats.`,
                    agent_id: a.agent_id,
                    metric_value:     a.utilizationScore,
                    metric_threshold: 85,
                })),
    },
    {
        type:      'inactive_agent',
        severity:  () => 'warning',
        check:     ({ agentStatuses }) =>
            agentStatuses
                .filter(a => a.status === 'idle' && a.idleSinceMinutes > 15)
                .map(a => ({
                    title:    `${a.name} has been idle ${Math.round(a.idleSinceMinutes)}m`,
                    body:     `Agent online but no sessions. ${pendingQueueDepth} chats pending.`,
                    agent_id: a.agent_id,
                    metric_value:     a.idleSinceMinutes,
                    metric_threshold: 15,
                })),
    },
    {
        type:      'workload_imbalance',
        severity:  () => 'warning',
        check:     ({ agentLoads }) => {
            const gini = workloadFairness(agentLoads.map(a => a.weightedLoad));
            if (gini < 0.35) return [];
            const overloaded  = agentLoads.reduce((m, a) => a.weightedLoad > m.weightedLoad ? a : m);
            const underloaded = agentLoads.reduce((m, a) => a.weightedLoad < m.weightedLoad ? a : m);
            const chatsDiff   = Math.round((overloaded.weightedLoad - underloaded.weightedLoad) / 2);
            return [{
                title: 'Workload imbalance detected',
                body: `Reassign ~${chatsDiff} chats from ${overloaded.name} to ${underloaded.name}`,
                metric_value:     gini,
                metric_threshold: 0.35,
            }];
        },
    },
];
7.2 Alert Deduplication

async function shouldEmitAlert(db, alertType, packageName, agentId) {
    // Suppress if same alert type fired in last 15 minutes and hasn't resolved
    const recent = await db`
        SELECT id FROM operational_alerts
        WHERE alert_type     = ${alertType}
          AND package_name   IS NOT DISTINCT FROM ${packageName}
          AND agent_id       IS NOT DISTINCT FROM ${agentId}
          AND auto_resolved  = FALSE
          AND created_at     >= NOW() - INTERVAL '15 minutes'
        LIMIT 1
    `;
    return recent.length === 0;
}
PART 8: REAL-TIME UPDATE STRATEGY
8.1 Server-Sent Events (SSE)
Replace all polling from the frontend with SSE for push-based updates. SSE is simpler than WebSockets for one-way server → client data, works with the existing Express setup, and requires no new dependencies.


// server/routes/sse.js

const clients = new Set();

router.get('/api/stream', requireAdmin, (req, res) => {
    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');  // Important for nginx proxy
    res.flushHeaders();
    
    const client = { res, connectedAt: Date.now() };
    clients.add(client);
    
    // Send initial state immediately
    sendEvent(client, 'init', {
        queue:   queueEngine.state,
        agents:  agentService.currentStatuses,
        alerts:  alertService.recentAlerts,
    });
    
    // Heartbeat every 30s to keep connection alive
    const heartbeat = setInterval(() => {
        res.write(':heartbeat\n\n');
    }, 30_000);
    
    req.on('close', () => {
        clearInterval(heartbeat);
        clients.delete(client);
    });
});

function broadcast(eventType, data) {
    const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of clients) {
        try {
            client.res.write(payload);
        } catch {
            clients.delete(client);
        }
    }
}

// Called by queue engine, alert engine, etc.
export { broadcast };
8.2 Frontend SSE Client

// In ops-center.html
class OpsStream {
    constructor(onUpdate) {
        this.onUpdate = onUpdate;
        this.connect();
    }
    
    connect() {
        this.es = new EventSource('/api/stream');
        
        this.es.addEventListener('queue_update',  e => this.onUpdate('queue',  JSON.parse(e.data)));
        this.es.addEventListener('sla_risk',       e => this.onUpdate('sla',    JSON.parse(e.data)));
        this.es.addEventListener('agent_status',   e => this.onUpdate('agents', JSON.parse(e.data)));
        this.es.addEventListener('alert',          e => this.onUpdate('alert',  JSON.parse(e.data)));
        this.es.addEventListener('init',           e => this.onUpdate('init',   JSON.parse(e.data)));
        
        this.es.onerror = () => {
            this.es.close();
            setTimeout(() => this.connect(), 5_000);  // Auto-reconnect after 5s
        };
    }
}
8.3 Update Frequency Matrix
Data Type	Source	Frequency	Method
Queue state (per package)	Supabase RPC	Every 60s	SSE push after each poll
Agent status (on/off/idle)	PostgreSQL	Every 30s	SSE push after each poll
SLA risk scores	Computed	Every 15 min	SSE push after engine run
Operational alerts	Triggered	On event	SSE immediate push
Hourly heatmap	Computed	Every 5 min	SSE push
KPI bar (queue, score)	Derived	After any update	Frontend recompute
Forecast models	Historical	Nightly (00:00)	No SSE needed
Agent occupancy detail	PostgreSQL	Every 2 min	Polling (lower priority)
PART 9: FRONTEND COMPONENT ARCHITECTURE
9.1 Recommended Technology
Do not migrate to React — the overhead is not justified for this codebase. Instead, add Alpine.js (CDN, no build step required) for reactive data binding. It works within the existing HTML/vanilla JS pattern.


<!-- Add to ops-center.html head -->
<script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3.x.x/dist/cdn.min.js"></script>
9.2 Component Hierarchy

ops-center.html
├── <x-alert-bar>           — Sticky top, critical alerts only, auto-dismiss
├── <x-kpi-header>          — Sticky sub-header with 6 KPI pills + live dot
│
├── Tab: LIVE OPS
│   ├── <x-exec-summary>    — Ops health score card (5 sub-scores)
│   ├── <x-queue-monitor>   — Queue overview
│   │   ├── <x-queue-card pkg="Fit Solo Pro">
│   │   │   ├── Pending count (large number)
│   │   │   ├── Severity badge (green/yellow/red)
│   │   │   ├── Oldest wait (mm:ss countdown)
│   │   │   ├── Near-breach count
│   │   │   └── Growth rate arrow (+N/hr)
│   │   └── [repeated per package]
│   ├── <x-agent-grid>      — Live agent status cards
│   │   ├── <x-agent-card>
│   │   │   ├── Status dot (on-shift, idle, in-session, break)
│   │   │   ├── Utilization bar
│   │   │   ├── Active chats / pending
│   │   │   ├── Last activity (mm ago)
│   │   │   └── Burnout risk indicator
│   │   └── [repeated per agent]
│   └── <x-alerts-feed>     — Scrollable live alert stream
│
├── Tab: SLA ENGINE
│   ├── <x-sla-risk-grid>   — Risk score cards per package
│   │   ├── Risk gauge (0–100)
│   │   ├── Current SLA %
│   │   ├── Projected EOD SLA %
│   │   └── Breach count prediction
│   └── <x-sla-projection-chart>  — Dual-axis: projected queue vs SLA %
│
├── Tab: AGENT OPS
│   ├── <x-agent-table>     — Sortable table: all metrics per agent
│   ├── <x-workload-bar-chart>   — Horizontal bar: weighted load per agent
│   ├── <x-fairness-gauge>  — Gini coefficient visualization
│   └── <x-reassign-panel>  — Recommended reassignments with action buttons
│
├── Tab: PLANNING
│   ├── <x-hourly-heatmap>  — Day × Hour grid (colour = demand intensity)
│   ├── <x-staffing-chart>  — Stacked bars: required vs actual per hour
│   ├── <x-forecast-panel>  — Weekly forecast cards with confidence bands
│   └── <x-what-if-panel>   — Scenario simulator with sliders + result cards
│
├── Tab: ALERTS
│   └── <x-alert-log>       — Full alert history, filterable, acknowledgeable
│
└── Tab: HISTORY
    └── [existing demand-report.html content, embedded via iframe or migrated]
9.3 KPI Header Design

┌───────────────────────────────────────────────────────────────────────────────┐
│  ● LIVE    OPS SCORE: 84      SLA: 91%      QUEUE: 23     AGENTS: 7/9 ON     │
│             [healthy ▲]       [warning ▼]  [yellow ●]    [burnout: 1]         │
│                                                              Updated: 0:42 ago  │
└───────────────────────────────────────────────────────────────────────────────┘
Each pill is clickable — it deep-links to the relevant section.

9.4 Operational Health Score Computation

function computeOpsHealthScore({ slaScores, queueState, agentStatuses, utilizationScores }) {
    // Each component scored 0–100, then weighted
    
    const slaHealth = Math.min(...slaScores.map(s => s.projected_sla_eod ?? 100));
    // Use worst-case package SLA projection
    
    const queueHealth = 100 - Math.min(100,
        Object.values(queueState)
            .filter(q => !SLA_RULES[q.package]?.is_scheduled)
            .reduce((max, q) => Math.max(max, (q.severity === 'red' ? 60 : q.severity === 'yellow' ? 25 : 0)), 0)
    );
    
    const staffingHealth = clamp(
        (agentStatuses.filter(a => a.status === 'on_shift').length /
         Math.max(agentStatuses.length, 1)) * 100,
        0, 100
    );
    
    const loadHealth = 100 - Math.min(100,
        utilizationScores.reduce((sum, u) => sum + Math.max(0, u.utilizationScore - 70), 0) / 
        Math.max(utilizationScores.length, 1)
    );
    
    return Math.round(
        slaHealth      * 0.40 +
        queueHealth    * 0.30 +
        staffingHealth * 0.15 +
        loadHealth     * 0.15
    );
}
9.5 Recommended Charts & Widgets
Widget	Library	Type	Data Source
Ops Health Score	Chart.js Doughnut	Gauge-style	Computed
SLA Risk by Package	Chart.js Bar	Horizontal bar, colour-coded	sla_risk_scores
SLA Projection	Chart.js Line	Dual-axis (queue + SLA %)	SLA engine
Hourly Heatmap	Custom SVG grid	7×24 coloured cells	hourly_demand_snapshots
Queue Trend	Chart.js Line	Sparkline, last 3h	queue_snapshots
Utilization per Agent	Chart.js Bar	Horizontal, threshold lines	Computed
Workload Fairness	D3.js (or Chart.js)	Lorenz curve	Agent loads
Forecast Bands	Chart.js Line	Line + shaded area	forecast_models
Agent Occupancy	CSS progress bars	Inline bars	Live
Burnout Risk	CSS heatmap dots	3-level colour	Computed
PART 10: PERFORMANCE OPTIMIZATION
10.1 Backend Optimizations
Problem: Current GET /api/sla-stats fetches all rooms then all messages — O(N×M) Supabase RPC calls with up to 25 concurrent workers.

Solution:


// Paginate with a single cursor-based fetch, not a count query first
// Cache intermediate results per date range in daily_stats_cache
// Add in-memory result cache with 5-minute TTL for repeated reads

const RESULT_CACHE = new Map();  // key → { data, expiresAt }

function withCache(key, ttlMs, fetchFn) {
    const cached = RESULT_CACHE.get(key);
    if (cached && Date.now() < cached.expiresAt) return cached.data;
    const data = fetchFn();
    RESULT_CACHE.set(key, { data, expiresAt: Date.now() + ttlMs });
    return data;
}
N+1 Query Fix for Overview:


-- Replace per-agent queries in GET /api/overview with single CTE
WITH active_shifts AS (
    SELECT agent_id, id, shift_started_at FROM shifts
    WHERE shift_ended_at IS NULL
),
active_breaks AS (
    SELECT agent_id, started_at FROM shift_breaks
    WHERE ended_at IS NULL
),
last_sessions AS (
    SELECT DISTINCT ON (agent_id)
        agent_id, id, ended_at, clicked_at
    FROM sessions
    ORDER BY agent_id, clicked_at DESC
)
SELECT
    a.id, a.name, a.status_updated_at,
    acs.id            AS active_shift_id,
    acs.shift_started_at,
    ab.started_at     AS break_started_at,
    ls.id             AS last_session_id,
    ls.ended_at       AS last_session_ended_at
FROM agents a
LEFT JOIN active_shifts acs ON acs.agent_id = a.id
LEFT JOIN active_breaks ab  ON ab.agent_id  = a.id
LEFT JOIN last_sessions ls  ON ls.agent_id  = a.id
WHERE a.is_active = TRUE;
Index additions:


-- For queue_snapshots time-range lookups
CREATE INDEX idx_queue_snapshots_pkg_time
    ON queue_snapshots(package_name, snapshot_at DESC);

-- For SLA risk history
CREATE INDEX idx_sla_risk_pkg_time
    ON sla_risk_scores(package_name, computed_at DESC);

-- For alert filtering
CREATE INDEX idx_alerts_unacked
    ON operational_alerts(severity, created_at DESC)
    WHERE is_acknowledged = FALSE;

-- For hourly heatmap
CREATE INDEX idx_hourly_snap_pkg_date
    ON hourly_demand_snapshots(package_name, snapshot_date, snapshot_hour);
10.2 Supabase RPC Batching
The current code makes one RPC call per agent for demand. Batch using a single RPC call with a staff_id array:


// Instead of: for each agent → supabase.rpc(...)
// Do: one RPC with all staff IDs

const { data } = await supabase.rpc('get_bulk_pending_counts', {
    p_staff_ids: agents.map(a => a.fitstn_id),
    p_last_message_from: 'client',
});
// Returns: [{ staff_id, count }]
// Requires adding this RPC to the Supabase schema
10.3 SSE Fan-out Optimization
With many concurrent dashboard viewers, avoid recomputing the SSE payload for each subscriber:


function broadcast(eventType, data) {
    const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
    // Serialize once, fan out to all N clients — O(N) writes, O(1) serialization
    for (const client of clients) {
        client.res.write(payload);
    }
}
PART 11: IMPLEMENTATION ROADMAP
Phase 1 — Foundation (Week 1–2)
These changes unlock everything else.

Run schema migrations: add queue_state, operational_alerts, agent_capacity_config, hourly_demand_snapshots, fit_express_schedule, sla_risk_scores, forecast_models
Seed agent_capacity_config with the values from the formula section
Add SSE endpoint (GET /api/stream) and broadcast helper
Build QueueEngine service — replace the ad-hoc Supabase RPC calls in agent-demand and agent-workload
Add GET /api/queue-state — returns current queueEngine.state as JSON (for initial page load)
Fix the N+1 overview query using the CTE above
Extend the hourly snapshot cronjob to write to hourly_demand_snapshots (per package breakdown)
Phase 2 — Live Ops Tab (Week 2–3)
Build ops-center.html skeleton with sticky KPI header and alert bar
Wire SSE client — replaces all setInterval polling on this page
Build Queue Monitor section with severity cards
Build Agent Live Grid with utilization bars and burnout indicators
Build Alerts Feed (live stream, acknowledge button)
Build Executive Summary card with health score
Phase 3 — SLA Engine Tab (Week 3–4)
Build SlaEngine service — runs every 15 minutes, writes to sla_risk_scores
Wire AlertEngine — reads from SLA engine + queue engine, writes to operational_alerts
Build SLA Risk Grid with risk gauges
Build SLA Projection chart (dual axis)
Phase 4 — Agent Ops Tab (Week 4–5)
Redesign utilization formula with package weights and concurrency
Add Gini fairness metric to API
Build Agent Ops tab: sortable table, workload bars, fairness gauge
Build reassignment recommendations
Phase 5 — Planning Tab (Week 5–6)
Build nightly forecast model recomputation
Build hourly heatmap
Build staffing coverage chart
Build What-If simulator (3 scenarios: demand spike, agent absent, package growth)
Phase 6 — Polish & Hardening (Week 6–7)
Add Fit Express scheduler as scheduled workload
Add agent_capacity_config admin UI (editable in settings.html)
Dark mode CSS implementation
Fix debt items: input validation, N+1 in shifts.js
Performance audit: cache all SLA computations, batch Supabase RPC calls
SUMMARY OF NEW ENDPOINTS
Method	Path	Purpose
GET	/api/stream	SSE live update stream
GET	/api/queue-state	Current queue per package
GET	/api/sla-risk	Current SLA risk scores
GET	/api/ops-health	Executive health score + components
GET	/api/alerts?unacked=true	Operational alerts (filterable)
POST	/api/alerts/:id/acknowledge	Acknowledge alert
GET	/api/hourly-heatmap?date=	24-hour demand by package
GET	/api/forecast?weekday=	Demand + staffing forecast
POST	/api/what-if/simulate	Run scenario simulation
GET	/api/capacity-config	Package capacity settings
PUT	/api/capacity-config/:package	Update capacity config
GET	/api/fit-express-schedule?date=	Fit Express follow-up tracker
GET	/api/agent-fairness	Workload fairness scores
GET	/api/reassign-recommendations	Suggested reassignments
The architecture gives you a true operations command center built on your existing Express + PostgreSQL + Supabase stack with no framework migration required. The SSE layer is the single biggest unlock — once that's in, every subsequent feature is additive.

Start with Phase 1 migrations and the QueueEngine service. That's the load-bearing foundation everything else sits on.