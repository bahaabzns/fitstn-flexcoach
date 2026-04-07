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
| 2026-04-06 | Unify shift numbers — gap-based idle, Active/In-Active tree with sub-labels | 1 — duplicate computeGapIdle logic inlined in index.js | Yes — extracted to shared server/utils/shift-utils.js. 2 warnings logged (N+1 queries, dual-language idle algo) |
| 2026-04-06 | Agent workload — per-agent shift hours, demand timeline, cutoff split, oldest pending | 1 — duplicate isPastCutoff logic in endpoint + snapshot | Yes — extracted getSlaCutoffStatus(). 3 warnings fixed (magic 500, unused email col, var→const). DEBT #18 logged |
| 2026-04-06 | Bug fix — negative pendingBeforeCutoff + const demandLine | 2 bugs — const→let reassignment crash, rooms array includes handled rooms causing negative math | Yes — let fix + Math.min cap on pendingAfterCutoff. DEBT #19 logged for deeper fix |
| 2026-04-07 | Empty session detection across UI | 0 blockers, 0 warnings | Quick review PASS |
| 2026-04-07 | Hot/Unread session counter — broaden CHATS_SELECTOR | 0 blockers, 0 warnings | Quick review PASS |
| 2026-04-07 | Track last-message-side per session + display in UI | 0 blockers, 2 warnings (duplicate CSS DEBT #16, trailing whitespace false alarm) | PASS WITH WARNINGS — CSS tracked in existing DEBT #16 |
| 2026-04-07 | Bug fix — session timer disappearing after 5s (race condition) | 0 blockers, 0 warnings, 1 suggestion (pre-existing console.log) | PASS — fire-and-forget backfill pattern clean |

---

## Test Health Log

| Date | Total Tests | Passing | Failing | Coverage |
|------|-------------|---------|---------|----------|
| 2026-04-05 | 0 | 0 | 0 | 0% — no test suite yet |
