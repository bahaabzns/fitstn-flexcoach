# REVIEWS.md — Code Review History

> Log every code review. Track what was found and what was fixed.

---

## Review Log

| Date | Feature/Change | Blockers Found | Fixed? |
|------|---------------|----------------|--------|
| 2026-04-05 | Agent status differentiation (in_session/between_sessions/idle) | 1 — `isAgentSignedInAndOnShift()` still referenced old `"active"` status | Yes — fixed before commit |
| 2026-04-05 | Activity log page + shift time breakdown (idle/off-session) | 0 blockers, 3 warnings (duplicate SQL, duplicate WHERE, innerHTML XSS) | Warnings logged in DEBT.md #11-13 |

---

## Test Health Log

| Date | Total Tests | Passing | Failing | Coverage |
|------|-------------|---------|---------|----------|
| 2026-04-05 | 0 | 0 | 0 | 0% — no test suite yet |
