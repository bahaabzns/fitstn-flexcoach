# DEPENDENCIES.md — Dependencies Log

> Every dependency installed must be logged here with its purpose.
> Review before adding anything new — avoid duplicates and bloat.

---

## Server (server/package.json)

| Package | Version | Purpose | Added |
|---------|---------|---------|-------|
| express | ^5.1.0 | HTTP server and routing | Pre-2026 |
| postgres | ^3.4.7 | PostgreSQL database client | Pre-2026 |
| @supabase/supabase-js | ^2.49.4 | FlexCoach platform data access via Supabase | Pre-2026 |
| bcryptjs | ^3.0.2 | Password hashing for agent/admin auth | Pre-2026 |
| cors | ^2.8.5 | Cross-origin request handling | Pre-2026 |
| dotenv | ^16.5.0 | Environment variable loading | Pre-2026 |

## Chrome Extension

| Dependency | Purpose |
|-----------|---------|
| *(no npm dependencies — vanilla JS)* | Chrome Extension Manifest V3 APIs only |
