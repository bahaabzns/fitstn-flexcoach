# Project Overview

FitSTN FlexCoach is an agent performance tracking and management system for the FitSTN fitness coaching platform. It monitors coach/agent activity in real-time — tracking chat sessions, shift hours, idle time, and calculating salaries.

**Users:**
- **Admins** — manage agents, view live dashboards, track performance, calculate salaries
- **Agents (coaches)** — log shifts, view their own stats via a personal overview page
- **Chrome extension** — auto-tracks chat interactions on the FlexCoach web app

**Production URL:** https://fitstn-flexcoach.onrender.com (free tier — cold starts ~50s)
**FlexCoach app:** https://fitstn.flexcoach.app

# Tech Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| Backend | Node.js + Express | Express 5.2.1 |
| Database | PostgreSQL (Supabase-hosted) | via `postgres` 3.4.8 |
| Auth | Custom token-based (Bearer tokens in `auth_tokens` table) | bcryptjs 3.0.3 |
| Chat API | Supabase JS client | @supabase/supabase-js 2.100.1 |
| Frontend | Vanilla HTML/CSS/JS (no framework) | — |
| Extension | Chrome Extension Manifest V3 | — |
| Env config | dotenv | 17.3.1 |
| CORS | cors | 2.8.6 |
| Hosting | Render (free tier) | — |
| Dev tooling | nodemon | 3.1.14 |
| No tests, no CI/CD, no Docker | — | — |

# Project Structure

```
fitstn-flexcoach/
├── CLAUDE.md                           # This file — project docs & dev rules
├── .env                                # Root env (Supabase + DB creds)
├── .gitignore
│
├── fitstn_plugin/                      # ★ MAIN APP — deployed to Render
│   ├── admin-dashboard/                # Express API server + admin frontend
│   │   ├── index.js                    # Server entry: routes, DB schema init, API endpoints (583 lines)
│   │   ├── package.json
│   │   ├── .env                        # Production DB + Supabase credentials
│   │   ├── middleware/
│   │   │   └── auth.js                 # Token auth: requireAdmin / requireAgent
│   │   ├── routes/
│   │   │   ├── admin-auth.js           # POST /api/admin/login, /logout
│   │   │   ├── agent-auth.js           # POST /api/agent/login, /logout, GET /me
│   │   │   ├── agents.js              # CRUD for agent accounts
│   │   │   ├── shifts.js              # Start/end shifts, active-shift, status
│   │   │   ├── salaries.js            # Salary calc: base, bonus, deductions, overtime (385 lines)
│   │   │   └── agent-overview.js      # Performance stats, daily breakdown, charts (377 lines)
│   │   ├── overview.html              # Admin + agent overview (charts, live status cards)
│   │   ├── dashboard.html             # Admin sessions list
│   │   ├── shifts.html                # Admin shifts list
│   │   ├── agents.html                # Admin agent management
│   │   ├── salaries.html              # Admin salary management
│   │   ├── settings.html              # Admin settings (idle thresholds)
│   │   ├── login.html                 # Admin login page
│   │   ├── agent-sessions.html        # Agent's own sessions view
│   │   └── agent-shifts.html          # Agent's own shifts view
│   │
│   └── chrome-extension/              # Browser extension for auto-tracking
│       ├── manifest.json              # MV3 config, host_permissions for Render API
│       ├── popup.html / popup.js      # Agent login, start/end shift, status display
│       ├── background.js              # Tab tracking, close-session on tab close
│       ├── content.js                 # Injected into FlexCoach app — chat click handlers, status badge
│       ├── status-popup.html/.js      # Floating status window
│       └── icons/                     # Extension icons
│
├── admin-dashboard/                   # ⚠ LEGACY — old simple session tracker (not deployed)
│   ├── index.js                       # Basic Express server, no auth, no shifts
│   └── index.html                     # Simple session table
│
├── fitstn_extractor/                  # Utility — export clients from Supabase to JSON/CSV
│   └── index.mjs
│
├── fitstn_quality/                    # Utility — chat/CRM data extraction & analysis
│   ├── index.js                       # Reads Supabase chat data
│   ├── fetch_crm_data.js             # Pulls from external CRM
│   └── filter_rooms.js               # Chat room filtering
│
└── staff_assignator/                  # Utility — maps staff CRM IDs to FlexCoach IDs
    ├── index.js
    └── staff_data.json
```

# Commands

**Main app** (`fitstn_plugin/admin-dashboard/`):
| Command | What it does |
|---------|-------------|
| `npm start` | Start production server (`node index.js`) |
| `npm run dev` | Kill port 3000 + start with nodemon (auto-reload) |

**Legacy** (`admin-dashboard/`):
| Command | What it does |
|---------|-------------|
| `npm start` | Kill port 3000 + start server |
| `npm run dev` | Kill port 3000 + start with nodemon |

**Utilities** (`fitstn_extractor/`, `fitstn_quality/`, `staff_assignator/`):
Run directly with `node index.js` or `node index.mjs` — no npm scripts.

# Database Schema

10 tables, auto-created on server startup in `index.js`:

```
admins          (id, email, password_hash, created_at)
agents          (id, email, password_hash, name, is_active, created_at, updated_at)
auth_tokens     (id, token, user_type, user_id, created_at, expires_at)
shifts          (id, agent_id→agents, shift_started_at, shift_ended_at, created_at)
sessions        (id, chat_name, chat_preview, agent_id→agents, clicked_at, ended_at, messages JSONB, created_at)
settings        (key PK, value, updated_at)
agent_salaries  (id, agent_id UNIQUE→agents, basic_salary, bonus, calculate_on_base, created_at, updated_at)
salary_deductions (id, agent_id→agents, name, type, value, is_active, created_at)
salary_overtime   (id, agent_id→agents, month, type, hours, rate_per_hour, note, created_at)
salary_records    (id, agent_id→agents, month, basic_salary, bonus, total_deductions, total_overtime, net_salary, details JSONB, created_at)
```

# API Route Map

**Auth:**
- `POST /api/admin/login` · `POST /api/admin/logout`
- `POST /api/agent/login` · `POST /api/agent/logout` · `GET /api/agent/me`

**Shifts (agent token):**
- `POST /api/agent/start-shift` · `POST /api/agent/end-shift`
- `GET /api/agent/active-shift` · `GET /api/agent/status` · `GET /api/agent/settings`

**Sessions (agent token):**
- `POST /api/chat-click` · `POST /api/session-message` · `POST /api/close-session`

**Admin dashboard (admin token):**
- `GET /api/overview` · `GET /api/shifts` · `GET /api/sessions`
- `GET /api/session-messages/:id` · `GET /api/settings` · `PUT /api/settings`
- `GET /api/agents` · `POST /api/agents` · `PUT /api/agents/:id` · `DELETE /api/agents/:id`
- `GET|PUT|POST /api/salaries/*`

**Agent overview (admin or agent token):**
- `GET /api/agent-overview/:id` · `GET /api/agent-overview/:id/sessions` · `GET /api/agent-overview/:id/shifts`

# Environment Variables

**Render (production):**
| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | Full PostgreSQL connection string (Supabase pooler) |

**Local `.env` (`fitstn_plugin/admin-dashboard/.env`):**
| Variable | Description |
|----------|-------------|
| `DATABASE_NAME` | PostgreSQL database name (`fitstnflexcoach`) |
| `DATABASE_USERNAME` | PostgreSQL user |
| `DATABASE_PASSWORD` | PostgreSQL password |
| `SUPABASE_URL` | Supabase project URL (for chat platform API) |
| `SUPABASE_ANON_KEY` | Supabase anonymous JWT key |
| `SUPABASE_USER_EMAIL` | Supabase auth email (for server-side chat access) |
| `SUPABASE_USER_PASSWORD` | Supabase auth password |

**DB connection logic** (`index.js:29-37`): uses `DATABASE_URL` with SSL if set, otherwise falls back to `localhost` with individual env vars.

# Coding Conventions

**Naming:**
- Variables/functions: `camelCase` (chatName, loadShiftState, formatDuration)
- Database columns: `snake_case` (shift_started_at, is_active, chat_preview)
- Table names: plural `snake_case` (agents, sessions, salary_records)
- HTML files: `kebab-case` (agent-shifts.html, agent-sessions.html)
- No CONSTANT_CASE used yet — hardcoded values inline (this violates the clean code rules below)

**Error handling:**
- Try-catch on all async operations
- Consistent response shape: `{ error: "message", details: err.message }`
- HTTP codes: 400 (validation), 401 (auth), 403 (forbidden), 404 (not found), 409 (conflict), 500 (server)
- Chrome extension silently catches fetch errors (`.catch(() => {})`) to preserve UI state

**Database access:**
- PostgreSQL template literals: `` sql`SELECT * FROM agents WHERE id = ${id}` ``
- Parameterized by the `postgres` library — safe from SQL injection
- No ORM — raw SQL everywhere

**Auth pattern:**
- Bearer token in `Authorization` header
- Tokens: 32-byte random hex, stored in `auth_tokens` table
- Expiry: 24h (admin), 7d (agent)
- Middleware: `requireAdmin` / `requireAgent` validate token per request

**Route architecture:**
- Factory pattern: each route file exports `function(sql, middleware) { return router }`
- Dependency injection of `sql` connection and auth middleware
- Mounted in `index.js` with `app.use("/api/prefix", routeModule)`

**Frontend:**
- Vanilla JS, no build step, no framework
- `authFetch()` wrapper adds Bearer token and handles 401 redirects
- Pages poll API every 5 seconds for live updates (`setInterval`)
- Chart.js loaded via CDN for overview charts

# Architecture Patterns

**Chrome extension → Backend flow:**
1. Agent logs in via extension popup → stores token in `chrome.storage.local`
2. Content script injected on `fitstn.flexcoach.app/dashboard/chat*`
3. On chat click → `POST /api/chat-click` (creates session, closes previous)
4. On message send → `POST /api/session-message` (appends to session messages JSONB)
5. On tab close → background.js fires `POST /api/close-session`
6. Status badge polls `GET /api/agent/status` every 5 seconds

**Salary calculation** (`routes/salaries.js`):
1. Base = basic_salary (+ bonus if `calculate_on_base` is false)
2. Day price = base / 30
3. Deductions: percentage of base, or days × day_price, or fixed amount
4. Overtime: hours × rate_per_hour, or days × day_price
5. Net = basic + bonus + overtime - deductions

# Review Focus Areas

1. **Large files violating 200-line rule:**
   - `index.js` (583 lines) — API routes mixed with server setup and schema init
   - `salaries.js` (385 lines) — calculation logic should be extracted
   - `agent-overview.js` (377 lines) — multiple SQL concerns in one file

2. **Duplicate code — `getDateRange` + `formatLocalDate`:**
   Defined identically in 3 places: `index.js`, `agent-overview.js`, and used inline in HTML files. Should be a shared `utils/date-helpers.js`.

3. **Hardcoded magic numbers:**
   - `DAYS_IN_MONTH = 30` (salaries.js:310) — not actual month length
   - Token expiry `24 * 60 * 60 * 1000` and `7 * 24 * 60 * 60 * 1000` — should be named constants
   - Status poll interval `5000` — repeated in popup.js, content.js, dashboard HTML files

4. **No input validation beyond basic checks:**
   - Salary routes accept negative values
   - Settings accept any string for numeric fields
   - No request body schema validation (no Joi, Zod, etc.)

5. **Default admin credentials in code:**
   - `admin@fitstn.com / admin123` seeded on startup (index.js:508-511)

6. **No tests, no CI/CD:**
   - All `npm test` scripts are placeholders
   - No automated testing or deployment pipeline

7. **Silent error swallowing in Chrome extension:**
   - Multiple `.catch(() => {})` blocks lose error context
   - Makes debugging production issues difficult

8. **No pagination on list endpoints:**
   - `/api/sessions`, `/api/shifts`, `/api/overview` return all records
   - Will degrade as data grows

# Known Patterns to Preserve

1. **Middleware factory pattern** (`auth.js`) — clean dependency injection of `sql`, don't replace with global imports
2. **Route factory pattern** — `module.exports = function(sql, requireAgent) { return router }` — keeps routes testable and composable
3. **PostgreSQL template literals** — `` sql`...${param}` `` prevents SQL injection elegantly, never use string concatenation
4. **Session auto-closure** — clicking a new chat auto-closes the previous session (`UPDATE sessions SET ended_at = NOW()`)
5. **Consistent error response shape** — `{ error: "message", details: err.message }` across all endpoints
6. **Period-based date filtering** — day/week/month queries on all analytics endpoints
7. **Salary calculation transparency** — returns full breakdown (base, deductions list, overtime list, net) for audit trail
8. **Bearer token auth** — stored in `auth_tokens` table with expiry, validated per request via middleware

---

# My Feature Development Rules

## Before every new feature
1. Remind me to save a backup or commit before starting
2. Ask me to describe the feature in one sentence
3. Explain your plan before writing any code — what files you'll touch and why
4. Wait for my approval before proceeding

## While coding
- Change ONE file at a time
- After each file change, stop and tell me what to test
- Never refactor or "clean up" other code unless I explicitly ask

## If something breaks
- Tell me clearly what broke and why
- Suggest restoring the backup as the first option
- Don't chain multiple fixes together

## General
- Use simple, beginner-friendly explanations
- Avoid changing things that are already working
- If a change feels risky, warn me first


## Clean Code Rules — Always Enforce These

### Naming
- Names must reveal intent — read like plain English
  - Variables: describe what the data IS (userAge, not x)
  - Functions: describe what they DO (calculateTotal, not calc)
  - Booleans: phrase as a yes/no question (isActive, hasPermission, canEdit)
- No abbreviations unless they are universally known (url, id, api are fine)
- No generic names: data, info, stuff, temp, obj, result → always be specific

### Functions
- One function = one job, no exceptions
- Function name must fully describe what it does — if you need "and" in the
  name, it's doing too much (saveAndSendEmail → split into two functions)
- Max 3 parameters per function — if you need more, pass an object instead
- No surprise side effects — a function named getUser() should never
  also delete something or send an email

### Comments
- Never write comments that just repeat the code:
  Bad:  // add 1 to counter
        counter = counter + 1
  Good: // retry limit reached, stop polling
        if (attempts >= MAX_RETRIES) stop()
- If you feel the urge to explain WHAT the code does, rewrite the code
  until it explains itself — comments explain WHY, not WHAT
- Delete commented-out old code — we have backups for that

### Files and structure
- One file = one clear responsibility
- File name must match what's inside (userHelpers.js should only have
  user-related helper functions)
- If a file exceeds 200 lines, flag it and suggest how to split it
- Related files live in the same folder — don't scatter connected things

### No magic numbers or strings
- Bad:  if (status === 3) ...
- Good: const ORDER_SHIPPED = 3
        if (status === ORDER_SHIPPED) ...
- All hardcoded values go in a constants file with a clear name

### Error handling
- Never silently ignore errors (no empty catch blocks)
- Error messages must say what went wrong AND what to do next
  Bad:  "Error occurred"
  Good: "Could not save profile — check your internet connection and try again"
- Handle the error where it makes sense, not just wherever is convenient

### Don'ts — always flag these as violations
- Dead code (functions or variables that are never used — delete them)
- Deeply nested if/else (more than 2-3 levels → refactor)
- Functions longer than 20-30 lines → suggest splitting
- Duplicate logic anywhere in the codebase → extract to shared function
- Mixing concerns (e.g. a function that fetches data AND formats the UI)

# Coding Style Rules — Always Follow These

## Core philosophy
Every piece of code I write must be: Fixed, Scalable, Maintainable, and Reusable (FSMR).

## Fixed — write stable code
- Each function does ONE thing only, no side effects
- Never modify working code unless explicitly asked
- If a change might break something, warn me before doing it
- Prefer simple, boring solutions over clever ones

## Scalable — write code that grows well
- Never hardcode values — use variables or a config/constants file
- Use loops and arrays instead of copy-pasting similar code
- Structure folders so new features can be added without reorganizing
- Avoid deeply nested logic (max 2-3 levels of indentation)

## Maintainable — write code humans can read
- Use clear, descriptive names for variables, functions, and files
  - Good: getUserById(), isLoggedIn, productList
  - Bad: func1(), flag, data2
- Add a one-line comment above any logic that isn't obvious
- Keep functions short — if it's longer than 20-30 lines, suggest splitting it
- Group related code together, separate unrelated code

## Reusable — write code that can be shared
- If the same logic appears more than once, extract it into a shared function
- Put shared functions in a dedicated utils/ or helpers/ file
- Build components/functions with inputs (parameters) so they work for
  multiple cases, not just the one case I'm solving right now

## Before writing any code
1. Tell me which file(s) you'll change
2. Explain the approach in plain English
3. Flag any part that feels like it could be done in a simpler, more reusable way
4. Wait for my go-ahead

## Red flags — always warn me if you see these
- Duplicate code that should be a shared function
- A function doing more than one job
- Hardcoded text, numbers, or URLs that should be variables
- A file getting too large (suggest splitting at 200+ lines)
- Logic that will break if the data grows (e.g. only works for 3 items, not 300)
