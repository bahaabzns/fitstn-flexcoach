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
