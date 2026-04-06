# REVIEWS.md — Code Review History

> Log every code review. Track what was found and what was fixed.

---

## Review Log

| Date | Feature/Change | Blockers Found | Fixed? |
|------|---------------|----------------|--------|
| 2026-04-05 | Agent status differentiation (in_session/between_sessions/idle) | 1 — `isAgentSignedInAndOnShift()` still referenced old `"active"` status | Yes — fixed before commit |
| 2026-04-05 | Activity log page + shift time breakdown (idle/off-session) | 0 blockers, 3 warnings (duplicate SQL, duplicate WHERE, innerHTML XSS) | Warnings logged in DEBT.md #11-13 |
| 2026-04-05 | Off-session work button + break-block + label rename | 0 blockers, 2 warnings (duplicate toast, silent catch) | #12 resolved (Boy Scout), #13 logged in DEBT.md |
| 2026-04-06 | Debt payment session — 8 items resolved | N/A (no new features) | CORS, silent catches, XSS escaping, SQL dedup, magic numbers, settings cache |

---

## Test Health Log

| Date | Total Tests | Passing | Failing | Coverage |
|------|-------------|---------|---------|----------|
| 2026-04-05 | 0 | 0 | 0 | 0% — no test suite yet |
