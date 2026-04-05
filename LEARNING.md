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
