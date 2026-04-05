# DEBT.md — Technical Debt Register

> Track all known shortcuts, hacks, and things that need fixing.
> Priority: HIGH (fix soon) | MEDIUM (fix when nearby) | LOW (fix when bored)

---

| # | Priority | Description | Where | Added | Status |
|---|----------|-------------|-------|-------|--------|
| 1 | HIGH | CORS set to `origin: "*"` — should restrict to known clients | server/index.js | 2026-04-05 | OPEN |
| 2 | HIGH | No test suite — zero test coverage | entire project | 2026-04-05 | OPEN |
| 3 | HIGH | Silent `catch(() => {})` in extension — errors swallowed silently | chrome-extension/background.js | 2026-04-05 | OPEN |
| 4 | MEDIUM | Magic numbers in content.js (idle: 2 min, check: 10s, timeout: 30 min) — should be server-configurable | chrome-extension/content.js | 2026-04-05 | OPEN |
| 5 | MEDIUM | No input validation/sanitization on route handlers | server/routes/*.js | 2026-04-05 | OPEN |
| 6 | MEDIUM | Event listeners (mousemove, keydown, click) may attach multiple times on script reload | chrome-extension/content.js | 2026-04-05 | OPEN |
| 7 | MEDIUM | No refresh token mechanism — auth tokens lack proper lifecycle | server/middleware/auth.js | 2026-04-05 | OPEN |
| 8 | LOW | Inconsistent error response patterns across routes | server/routes/*.js | 2026-04-05 | OPEN |
| 9 | LOW | No intermediate roles (e.g., supervisor) — only admin/agent | server/middleware/auth.js | 2026-04-05 | OPEN |
| 10 | MEDIUM | Extra DB query for `idle_warning_minutes` on every agent status poll (every 5s per agent) — should cache in memory | server/routes/shifts.js | 2026-04-05 | OPEN |
| 11 | MEDIUM | Duplicated idle_event_seconds SQL subquery (18 lines) — divergence risk if logic changes | server/index.js + server/routes/agent-overview.js | 2026-04-05 | OPEN |
| 12 | LOW | Duplicated WHERE clauses in count vs events query — adding a filter to one but not the other breaks pagination | server/routes/activity-events.js | 2026-04-05 | OPEN |
| 13 | MEDIUM | innerHTML used with server-returned strings without HTML escaping — XSS risk (pre-existing across all admin pages) | server/public/*.html | 2026-04-05 | OPEN |
