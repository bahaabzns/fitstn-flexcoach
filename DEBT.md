# DEBT.md — Technical Debt Register

> Track all known shortcuts, hacks, and things that need fixing.
> Priority: HIGH (fix soon) | MEDIUM (fix when nearby) | LOW (fix when bored)

---

| # | Priority | Description | Where | Added | Status |
|---|----------|-------------|-------|-------|--------|
| 1 | HIGH | CORS set to `origin: "*"` — should restrict to known clients | server/index.js | 2026-04-05 | ✅ RESOLVED 2026-04-06 — restricted to allowlist (localhost, production, chrome-extension) |
| 2 | HIGH | No test suite — zero test coverage | entire project | 2026-04-05 | OPEN |
| 3 | HIGH | Silent `catch(() => {})` in extension — errors swallowed silently | chrome-extension/background.js | 2026-04-05 | ✅ RESOLVED 2026-04-06 — added console.warn to all silent catches |
| 4 | MEDIUM | Magic numbers in content.js (idle: 2 min, check: 10s, timeout: 30 min) — should be server-configurable | chrome-extension/content.js | 2026-04-05 | ✅ RESOLVED 2026-04-06 — extracted into named constants (DEFAULT_IDLE_THRESHOLD_MS, etc.) |
| 5 | MEDIUM | No input validation/sanitization on route handlers | server/routes/*.js | 2026-04-05 | OPEN |
| 6 | MEDIUM | Event listeners (mousemove, keydown, click) may attach multiple times on script reload | chrome-extension/content.js | 2026-04-05 | ✅ RESOLVED 2026-04-06 — verified existing guards: stopIdleDetection() before start, dataset.handlerAttached, messageInterceptorAttached flag |
| 7 | MEDIUM | No refresh token mechanism — auth tokens lack proper lifecycle | server/middleware/auth.js | 2026-04-05 | OPEN |
| 8 | LOW | Inconsistent error response patterns across routes | server/routes/*.js | 2026-04-05 | OPEN |
| 9 | LOW | No intermediate roles (e.g., supervisor) — only admin/agent | server/middleware/auth.js | 2026-04-05 | OPEN |
| 10 | MEDIUM | Extra DB query for `idle_warning_minutes` on every agent status poll (every 5s per agent) — should cache in memory | server/routes/shifts.js | 2026-04-05 | ✅ RESOLVED 2026-04-06 — added getCachedSettings() with 60s TTL, invalidated on PUT /api/settings |
| 11 | MEDIUM | Duplicated idle_event_seconds SQL subquery (18 lines) — divergence risk if logic changes | server/index.js + server/routes/agent-overview.js | 2026-04-05 | ✅ RESOLVED 2026-04-06 — replaced event-based idle with gap-based idle, extracted shared computeGapIdle() into server/utils/shift-utils.js |
| 12 | LOW | showOffSessionToast and showBreakError are near-duplicate toast functions — extract shared showToast() | chrome-extension/content.js | 2026-04-05 | ✅ RESOLVED 2026-04-05 — extracted shared showToast() |
| 13 | MEDIUM | closeSessionViaApi() inner .catch(() => {}) silently swallows errors — handleOffSessionWork error toast never fires | chrome-extension/content.js | 2026-04-05 | ✅ RESOLVED 2026-04-06 — added console.warn + re-throw so callers can handle errors |
| 16 | LOW | Duplicated WHERE clauses in count vs events query — adding a filter to one but not the other breaks pagination | server/routes/activity-events.js | 2026-04-05 | ✅ RESOLVED 2026-04-06 — extracted shared whereFilters SQL fragment |
| 17 | MEDIUM | innerHTML used with server-returned strings without HTML escaping — XSS risk (pre-existing across all admin pages) | server/public/*.html | 2026-04-05 | ✅ RESOLVED 2026-04-06 — added escapeHtml() to all 9 admin pages, wrapped 24 dynamic values |
| 14 | MEDIUM | N+1 query pattern — sessions fetched per-shift in a loop (1 DB query per shift) in /api/shifts, /api/agent-overview | server/index.js, server/routes/agent-overview.js | 2026-04-06 | OPEN |
| 15 | LOW | SQL CTE in shifts.js and JS function in shift-utils.js implement same idle algorithm in two languages — keep in sync | server/routes/shifts.js, server/utils/shift-utils.js | 2026-04-06 | OPEN |
| 16 | LOW | Duplicate `.empty-session` / `.empty-tag` CSS in dashboard.html and agent-sessions.html — extract to shared stylesheet | server/public/dashboard.html, server/public/agent-sessions.html | 2026-04-07 | OPEN |
| 17 | LOW | `SELECT s.*` in /api/sessions fetches full messages JSONB before stripping — use explicit column list | server/index.js | 2026-04-07 | OPEN |
| 18 | LOW | Dead `loadMessages()` function and `msgCache` in dashboard.html — no onclick references them anymore | server/public/dashboard.html | 2026-04-07 | OPEN |
| 18 | LOW | MAX_ROOMS_PER_FETCH=500 cap — if agent has >500 pending rooms, cutoff split and oldest-pending will be inaccurate | server/index.js | 2026-04-06 | OPEN |
| 19 | LOW | Cutoff split counts timestamps from ALL rooms (handled+pending) then caps with Math.min — should filter rooms to pending-only (last_message_from=client) before splitting | server/index.js | 2026-04-06 | OPEN |
| 20 | MEDIUM | Slow Supabase RPC (fetchLastMessageSide) was blocking session INSERT — caused session timer to disappear in production. Root cause: synchronous call ordering. Prevention: never put slow external calls between session creation and response | server/index.js | 2026-04-07 | ✅ RESOLVED 2026-04-07 — moved INSERT before Supabase RPC, backfill async |
