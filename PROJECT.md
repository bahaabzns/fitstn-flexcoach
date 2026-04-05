# PROJECT.md — FitStn FollowUp RTM

---

## Identity

- **Name:** FitStn FollowUp RTM
- **What it does:** Real-time monitoring and management system for fitness coaching agents — tracks activity, shifts, sessions, and salaries via a server + Chrome extension integrated with FlexCoach.
- **Who it's for:** FitStn management/admins who oversee coaching agents on the FlexCoach platform.
- **Core thing it must do well:** Accurately track agent activity (shifts, sessions, idle time) in real time.

---

## Tech Stack

| Layer | Technology | Why |
|-------|-----------|-----|
| Backend | Express.js 5.x (Node.js) | Lightweight, fast to develop REST APIs |
| Database | PostgreSQL via `postgres` npm client | Relational data fits agent/shift/session model |
| Auth | Bearer tokens + bcryptjs | Simple token-based auth, passwords hashed |
| External | Supabase (@supabase/supabase-js) | FlexCoach chat platform integration |
| Extension | Chrome Extension (Manifest v3) | Embeds tracking into FlexCoach dashboard |
| Config | dotenv | Environment variable management |

---

## Scope

### MUST HAVE (v1)
1. Agent management (create, edit, deactivate)
2. Shift tracking (clock in/out, breaks, effective time)
3. Activity event logging (messages, idle, tab focus)
4. Chrome extension for FlexCoach integration
5. Admin dashboard for monitoring

### NICE TO HAVE
- Salary calculation and management
- Staff assignment tool
- Agent session history views
- Performance metrics / SLA tracking

### FUTURE
- Role granularity beyond admin/agent (supervisor role)
- Mobile app for agents
- Automated shift scheduling
- Client satisfaction tracking

---

## Definition of Done (v1)

**A user can...**
1. A user (admin) can view all agents and their current status (active, idle, on break, offline).
2. A user (agent) can clock in/out of shifts and take breaks, with time tracked accurately.
3. A user (admin) can see real-time activity events for any agent.
4. A user (agent) can have their FlexCoach chat interactions automatically tracked via the Chrome extension.
5. A user (admin) can manage agent profiles (create, edit, deactivate).

**Out of scope for v1:**
- Automated salary disbursement
- Client-facing features
- Multi-organization / multi-tenant support

---

## Repository

- **Branch:** `dev` (active development)
- **Remote:** *(add URL here when connected)*

---

## Decisions Log

| Date | Decision | Why | Alternatives Considered |
|------|----------|-----|------------------------|
| Pre-2026 | PostgreSQL over MongoDB | Relational data model (agents → shifts → events) fits SQL well | MongoDB |
| Pre-2026 | Chrome Extension over browser bookmarklet | Needs persistent background scripts, storage API, and tab monitoring | Bookmarklet, userscript |
| Pre-2026 | Express 5.x | Familiar, lightweight, async route support | Fastify, Koa |
| 2026-04-05 | Extract API_BASE to config.js | Simplify switching between dev/production environments | Hardcoded URLs per file |
