# LEARNING.md — Learning Log

> Record things learned, concepts that were fuzzy, and breakthroughs.
> Review the last entry at the start of every session.

---

## 2026-04-05 — Session Opening

### Learned
- Project was reorganized: chrome-extension and server moved to project root, HTML pages moved to public/, staff_data to constants/
- API_BASE was hardcoded in multiple chrome extension files — extracted to shared config.js
- bob.instructions.md framework adopted for structured development workflow

### Still Fuzzy
- How sessions are initialized (close-session endpoint exists, but session creation flow unclear)
- Exact Supabase auth flow — `ensureSupabaseAuth()` may have race conditions under concurrent requests
- How SLA cutoff time is actually used in practice

### Next Steps
- Address top 3 debt items before adding new features
- Set up a basic test suite (debt item #2)

## 2026-04-05 — Session Close

**What we built:** Differentiated agent status into `in_session`, `between_sessions`, and `idle` using the activity threshold from settings.
**New concepts learned:**
- Server-computed status derived from DB state (no status column) — clean pattern for real-time systems
- Activity threshold reused from existing `idle_warning_minutes` setting to split between_sessions vs idle
**Concepts I understood immediately:**
- Status flow: check shift → check break → check session → compute idle duration → compare threshold
- Multi-file status propagation: server endpoint → chrome extension badge → admin overview
**Concepts I am still fuzzy on:**
- Whether the extra DB query per status poll (idle_warning_minutes) will be a performance concern at scale
- Session initialization flow still unclear
**Question I want to explore next:** Caching settings in server memory to reduce DB queries on hot paths
**Confidence today (1–10):** 7

## 2026-04-05 — Session 3

**What we built:** Activity Log page with filters/pagination/auto-refresh, and shift time breakdown (In-session, Off-session work, Idle, Break) across shifts tables and overview.
**New concepts learned:**
- Correlated SQL subqueries: computing idle time from idle_started/idle_resumed event pairs within a shift window using MIN() + LEAST() + COALESCE()
- Time decomposition: Total = In-session + Off-session + Idle + Break, with clamping (Math.min/Math.max) to prevent negative or overflow values
- Server-side pagination: COUNT query + OFFSET/LIMIT pattern for paginated API endpoints
- Client-side auto-refresh with setInterval without full page reload
**Concepts I understood immediately:**
- Separating idle (detected from events) vs off-session work (calculated remainder)
- Adding nav links consistently across all admin pages
- Stacked bar charts with 3 datasets in Chart.js
**Concepts I am still fuzzy on:**
- Performance implications of correlated subqueries at scale (nested SELECT per row)
- Whether innerHTML without escaping is a real risk when data is admin-controlled
**Question I want to explore next:** Building a shared escapeHtml() utility and applying it across all admin pages (DEBT #13)
**Confidence today (1–10):** 8

## 2026-04-05 — Session 4 Close

**What we built:** Off-session work button (manual session close), break-block guard on chat clicks, renamed "Between Sessions" → "Off-session work" across all UI.
**New concepts learned:**
- Reusing existing endpoints for new features — no server changes needed for the off-session button (closeSessionViaApi already existed)
- UI state guards: checking `currentStatus` before allowing actions (break-block pattern)
- Extracting shared utility functions from duplicate code (showToast boy scout refactor)
**Concepts I understood immediately:**
- Button visibility driven by existing status polling — no new polling needed
- Consistent label renaming across multiple files (5 files, search-and-replace discipline)
**Concepts I am still fuzzy on:**
- closeSessionViaApi() inner .catch(() => {}) silently swallows errors — need to fix this for proper error propagation
- Performance of status polling at scale still an open question
**Question I want to explore next:** Fixing silent error swallowing in closeSessionViaApi (DEBT #13) and setting up a test suite (DEBT #2)
**Confidence today (1–10):** 8

## 2026-04-06 — Session 5 (Debt Payment)

**What we built:** No new features. Debt payment session — fixed 8 of 13 open debt items.
**New concepts learned:**
- CORS origin allowlist with callback function pattern (instead of wildcard string)
- `escapeHtml()` via `textContent` → `innerHTML` as a safe browser-native XSS defense
- SQL template fragment reuse in postgres.js — storing a `sql\`...\`` fragment in a variable and interpolating it into both count and data queries
- In-memory settings cache with TTL + explicit invalidation pattern for reducing hot-path DB queries
- Re-throwing in `.catch()` to preserve error propagation for upstream callers
**Concepts I understood immediately:**
- CORS restriction — straightforward allowlist matching
- Named constants replacing magic numbers — simple rename exercise
- Verifying existing guards (stop-before-start, dataset flags) rather than adding redundant ones
**Concepts I am still fuzzy on:**
- Whether postgres.js SQL fragment interpolation has edge cases (e.g., with parameterized values leaking across queries)
- The two different idle calculation approaches (event-based in index.js vs remainder in agent-overview.js) — needs a design decision to unify
**Question I want to explore next:** Setting up a test suite (DEBT #2) — biggest remaining debt item. Also input validation across route handlers (DEBT #5).
**Confidence today (1–10):** 9

## 2026-04-06 — Session 6 (Bug Fix)

**What we fixed:** CORS blocking all chrome extension content script requests — `Error: Not allowed by CORS` spamming the server console on every request from the extension.
**New concepts learned:**
- Content scripts injected into a page send the **host page's origin** (e.g., `https://fitstn.flexcoach.app`), not the `chrome-extension://` origin — only popup/background scripts use the extension origin
- CORS allowlists must include the actual host page URL when content scripts make fetch requests
**Concepts I understood immediately:**
- The CORS origin callback pattern — `startsWith` matching against an allowlist
- Reading stack traces to pinpoint the exact line causing errors (index.js:133)
**Concepts I am still fuzzy on:**
- postgres.js SQL fragment interpolation edge cases (carried over from session 5)
- Two different idle calculation approaches still need design decision (carried over)
**Question I want to explore next:** Setting up a test suite (DEBT #2). Also the Boy Scout suggestion from this session: replace CORS Error objects with single-line console.warn to reduce console noise.
**Confidence today (1–10):** 9

## 2026-04-06 — Session 6 (Unify Shift Numbers)

**What we built:** Unified shift time metrics across Agent Top Bar, Admin Shifts, Agent Shifts, and Agent Overview. Replaced event-based idle (always 0) with gap-based idle. Organized 5 metrics into a tree: Total Shift = Active Shift (In-Session + Off-Session) + In-Active Shift (On Break + Idle).
**New concepts learned:**
- Gap-based idle computation — measuring time between consecutive sessions and counting gaps exceeding a threshold as idle, instead of relying on idle start/resume events that only fire during active sessions
- SQL CTEs (Common Table Expressions) for computing derived values in a single query — used `WITH ordered_sessions AS (...)` to compute inter-session gaps in shifts.js
- Chart.js grouped stacking — using `stack: 'active'` and `stack: 'inactive'` to group related datasets into visual sub-stacks within a stacked bar chart
- Colspan-based 2-row table headers — grouping sub-columns under parent headers (Active Shift → In-Session + Off-Session)
- Extracting shared utility functions across server routes — `server/utils/shift-utils.js` with `computeGapIdle()` required by both `index.js` and `agent-overview.js`
**Concepts I understood immediately:**
- Time decomposition formula: Total = Active + Inactive, with each further broken into sub-components
- Parenthetical sub-value display in the Chrome extension top bar (e.g., "Active: 2h30m (1h45m + 45m)")
- Inline sub-breakdown cards with colored border-left for visual hierarchy in overview.html
**Concepts I am still fuzzy on:**
- Whether the N+1 query pattern (fetching sessions per-shift in a loop) will be a real bottleneck at scale (DEBT #14)
- postgres.js SQL fragment interpolation edge cases (carried over)
**Question I want to explore next:** Setting up a test suite (DEBT #2) — still the biggest gap. Also fixing the N+1 query pattern (DEBT #14) with a batch query approach.
**Confidence today (1–10):** 9

## 2026-04-06 — Session 7 (Agent Workload Overhaul)

**What we built:** Overhauled agent workload feature — per-agent shift_end_time for hours remaining, yesterday/today/tomorrow demand timeline, cutoff demand freezing via `cutoff_demand_count`, pending before/after cutoff split with room-level timestamp analysis, oldest pending chat indicator.
**New concepts learned:**
- COALESCE in ON CONFLICT UPDATE — freezing a value on first write and preserving it on subsequent upserts (`COALESCE(table.col, EXCLUDED.col)`)
- Client-side timestamp splitting — fetching room objects from RPC and comparing `last_client_message_at` against a cutoff timestamp to split rooms into before/after buckets
- Cold start problem with snapshot-based features — deploying after cutoff means first snapshot equals current demand, producing `0` difference. Self-corrects next cycle.
- FlexCoach RPC `p_last_interaction` presets: only `"today"`, `"yesterday"`, `"week"` work; date ranges via `_from/_to` are ignored
**Concepts I understood immediately:**
- Per-agent shift_end_time replacing global cutoff for hours_remaining calculation
- Yesterday demand as simple DB lookup from previous day's snapshot row
- Extracting shared helper (`getSlaCutoffStatus()`) to eliminate duplicate cutoff logic
**Concepts I am still fuzzy on:**
- Whether p_limit=500 is sufficient for all agents (DEBT #18)
- postgres.js SQL fragment interpolation edge cases (carried over)
**Question I want to explore next:** Setting up a test suite (DEBT #2). Also pagination for the cutoff split if agents exceed 500 pending.
**Confidence today (1–10):** 9

## 2026-04-06 — Session 8 (Bug Fixes)

**What we fixed:** Two bugs in the agent workload feature — (1) `const demandLine` couldn't be reassigned with `+=` (changed to `let`), (2) negative `pendingBeforeCutoff` numbers caused by counting cutoff timestamps from ALL rooms (handled + pending) while `data.total` only counts pending rooms.
**New concepts learned:**
- RPC `data.rooms` vs `data.total` semantic mismatch — the rooms array includes all rooms matching filter criteria (handled + pending), but `total` is additionally filtered by `p_last_message_from`, so `rooms.length > total` is possible and common
- Defensive capping with `Math.min()` as a quick fix when upstream data has mixed semantics — not ideal but prevents user-facing bugs while the real fix (filtering rooms to pending-only) is planned
**Concepts I understood immediately:**
- `const` vs `let` — `const` prevents reassignment, caught immediately from error message
- Root cause analysis from user-reported numbers — pattern recognition (same "212 after-cutoff" for multiple agents = shared room pool, not agent-specific pending)
**Concepts I am still fuzzy on:**
- FlexCoach RPC exact filtering behavior for `rooms` array vs `total` count — which parameters affect which
- postgres.js SQL fragment interpolation edge cases (carried over)
**Question I want to explore next:** Filter rooms to pending-only before cutoff split (DEBT #19). Setting up a test suite (DEBT #2).
**Confidence today (1–10):** 9

## 2026-04-07 — Session 9 (Empty Session Detection)

**What we built:** Differentiated empty sessions (0 agent messages) from non-empty sessions across the entire system — overview cards, agent detail performance, dashboard table, agent sessions table. Also fixed `chatPreview` not being sent from the chrome extension.
**New concepts learned:**
- PostgreSQL `FILTER` clause for conditional aggregates — `COUNT(*) FILTER (WHERE condition)` counts only matching rows within a GROUP BY, cleaner than CASE WHEN
- Stripping unwanted columns from spread responses — `const { messages: _msgs, ...rest } = row` to exclude a field while keeping everything else
- Falsy-check `!value` as safer comparison than `=== 0` when values may arrive as strings or null from postgres
**Concepts I understood immediately:**
- `jsonb_array_length(COALESCE(messages, '[]'::jsonb))` for counting JSON array entries — already used this pattern in agent-overview.js
- CSS `opacity: 0.55` for visually de-emphasizing rows — simple and effective
- Adding `ended_at IS NOT NULL` guard so active sessions aren't incorrectly counted as "empty"
**Concepts I am still fuzzy on:**
- postgres.js SQL fragment interpolation edge cases (carried over)
- Performance of `jsonb_array_length` in subqueries on large session tables
**Question I want to explore next:** Setting up a test suite (DEBT #2). Also cleaning up the now-dead `loadMessages()` function in dashboard.html (DEBT #18).
**Confidence today (1–10):** 9
