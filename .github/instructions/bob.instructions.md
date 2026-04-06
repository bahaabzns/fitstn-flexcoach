# bob.instructions.md — Developer Framework
> Read this file at the start of every session. Follow every rule. Never skip steps.

---

## QUICK REFERENCE — TRIGGER MAP

Every routine has a trigger. When the trigger happens, run the routine. No exceptions.

| Trigger | Routine to Run |
|---|---|
| Starting a brand new project | → NEW PROJECT ROUTINE |
| Starting any coding session | → SESSION OPENING ROUTINE |
| Adding any new feature | → FEATURE ROUTINE |
| Feature is working and ready to commit | → CODE REVIEW ROUTINE |
| After every function or feature | → TESTING ROUTINE |
| Before every commit | → PRE-COMMIT CHECKLIST |
| Before merging any branch | → PRE-MERGE CHECKLIST |
| Project feels messy or hard to navigate | → REORGANIZATION ROUTINE |
| Every 4–5 features completed | → DEBT PAYMENT SESSION |
| Ending any coding session | → SESSION CLOSING ROUTINE |
| A bug is found | → BUG FIX PROTOCOL |

---

## MASTER WORKFLOW

This is how everything connects. One feature, start to finish:

```
SESSION OPENS
     ↓
SESSION OPENING ROUTINE
(git status, last 5 commits, top 3 debt items, fuzzy concepts from last session)
     ↓
NEW FEATURE NEEDED?
     ↓
FEATURE ROUTINE
(backup → describe → plan → approve → build one file at a time)
     ↓
FUNCTION WRITTEN?
     ↓
TESTING ROUTINE
(write tests → confirm red → write code → confirm green → refactor)
     ↓
FEATURE COMPLETE?
     ↓
CODE REVIEW ROUTINE
(correctness → readability → security → scalability)
     ↓
REVIEW PASSED?
  NO  → Fix blockers → Re-run review
  YES → PRE-COMMIT CHECKLIST → commit → merge to dev
     ↓
EVERY 4–5 FEATURES
     ↓
DEBT PAYMENT SESSION
(fix DEBT.md items, no new features)
     ↓
PROJECT HEALTH CHECK
(review PROJECT.md, DEPENDENCIES.md, folder structure)
     ↓
SESSION CLOSES
     ↓
SESSION CLOSING ROUTINE
(boy scout improvement, update logs, confirm all committed)
```

---

## PART 1 — CORE STANDARDS
*These apply always. Every file. Every session. No exceptions.*

### 1.1 — Naming Rules

| Type | Rule | Good | Bad |
|---|---|---|---|
| Variables | Describe what the data IS | `userAge`, `productList` | `x`, `data`, `temp` |
| Functions | Describe what they DO | `calculateTotal()`, `getUserById()` | `func1()`, `run()`, `handle()` |
| Booleans | Phrase as a yes/no question | `isActive`, `hasPermission`, `canEdit` | `login`, `perm`, `check` |
| Files | Match exactly what is inside | `userHelpers.js` | `utils2.js`, `stuff.js` |
| Constants | ALL_CAPS with underscores | `MAX_RETRIES`, `TAX_RATE` | `maxR`, `tax` |
| Branches | type/description | `feature/user-login`, `fix/checkout-bug` | `new-stuff`, `test` |

- No abbreviations unless universally known (`url`, `id`, `api` are fine)
- No generic names ever: `data`, `info`, `stuff`, `temp`, `obj`, `result`, `val`
- If a function name needs the word "and" — it is doing two jobs, split it

### 1.2 — Function Rules

- One function = one job, no exceptions
- Maximum 3 parameters — if more are needed, pass an object instead
- Maximum 20–30 lines — if longer, flag and suggest splitting
- No side effects — a function named `getUser()` must never delete, send, or modify anything
- Every function must always return what its name promises — never `undefined` with no explanation
- Async functions must always have error handling — no silent promise failures

### 1.3 — File and Structure Rules

- One file = one clear responsibility
- Files over 200 lines → flag and suggest how to split
- Related files live in the same folder — never scatter connected things
- Standard project structure:

```
my-project/
├── src/
│   ├── components/       ← reusable UI pieces
│   ├── pages/            ← one file per page or screen
│   ├── features/         ← self-contained feature folders
│   ├── utils/            ← shared helper functions
│   ├── services/         ← API calls and external connections
│   └── constants/        ← all hardcoded values and config
├── public/               ← images, fonts, static files
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── e2e/
│   └── helpers/
├── .env                  ← secrets (never committed)
├── .gitignore
├── bob.instructions.md
├── PROJECT.md
├── DEBT.md
├── DEPENDENCIES.md
├── GLOSSARY.md
├── WHY.md
├── LEARNING.md
└── REVIEWS.md
```

### 1.4 — Code Quality Rules

**No magic numbers or strings:**
```
Bad:  if (status === 3) ...
Good: const ORDER_SHIPPED = 3
      if (status === ORDER_SHIPPED) ...
```

**Comments explain WHY, never WHAT:**
```
Bad:  // add 1 to counter
      counter = counter + 1

Good: // retry limit reached, stop polling
      if (attempts >= MAX_RETRIES) stop()
```

**Error messages tell the user what happened AND what to do:**
```
Bad:  "Error occurred"
Good: "Could not save profile — check your internet connection and try again"
```

**Always flag these violations immediately:**
- 🔴 Duplicate logic appearing more than once → extract to shared function
- 🔴 Empty catch blocks silently swallowing errors
- 🔴 Commented-out old code → delete it, we have git
- 🔴 Deeply nested if/else (more than 2–3 levels) → refactor
- 🔴 Dead code (unused functions or variables) → delete them
- 🔴 Functions mixing concerns (fetching data AND formatting UI)
- 🔴 Hardcoded secrets, API keys, URLs → move to .env immediately
- 🟡 Unused imports → remove them
- 🟡 console.log exposing sensitive data → remove before commit to main

### 1.5 — FSMR Philosophy
*Every piece of code written must be: Fixed, Scalable, Maintainable, Reusable.*

- **Fixed** — simple, stable solutions over clever ones. Warn before any risky change.
- **Scalable** — use loops not copy-paste. Config files not hardcoded values. Max 2–3 levels of nesting.
- **Maintainable** — if it takes more than 60 seconds to understand, simplify it.
- **Reusable** — if the same logic appears twice, extract it. Build with parameters, not hardcoded specifics.

---

## PART 2 — GIT STANDARDS
*Applied at every commit, every branch, every session.*

### Branch Strategy

```
main      → production only. Always working. Never commit here directly.
dev       → active development. Merges into main when stable.
feature/* → one branch per feature, branches off dev
fix/*     → one branch per bug fix, branches off dev
refactor/ → reorganization only, branches off dev
```

### Commit Format

```
type: short description in plain English (max 60 characters)
```

| Type | Use for |
|---|---|
| `feat:` | a new feature |
| `fix:` | a bug fix |
| `refactor:` | restructuring without changing behavior |
| `style:` | naming, formatting, clean code only |
| `test:` | adding or updating tests |
| `docs:` | comments, readme, documentation |
| `chore:` | setup, config, dependencies |
| `review:` | post-code-review commit |
| `release:` | version release |

**Good commits:**
```
feat: add login form with email and password fields
fix: prevent crash when user submits empty search
test: add unit tests for calculateTotal function
refactor: extract price calculation into its own function
```

**Bad commits (never):**
```
"update" / "fix stuff" / "changes" / "final" / "final2" / "asdfgh"
```

**Commit rules:**
- One commit = one logical change
- If the message needs "and" → split into two commits
- Never commit broken code
- Never force push to main

### What to Never Commit
```
.env files / node_modules/ / dist/ / build/ / .DS_Store / *.log
```
Warn immediately if any of these appear in staged files.

---

## PART 3 — ROUTINES

---

### ROUTINE 1 — NEW PROJECT ROUTINE
**TRIGGER: Starting a brand new project**
*Run once. No feature code is written until this routine is 100% complete.*

#### Phase 1 — Define Before You Build

**Step 1 — Project identity** *(log in PROJECT.md → Identity)*
Ask me:
1. What is the name of this project?
2. In one sentence — what does it do? (If more than one sentence is needed, help simplify it)
3. Who is it for?
4. What is the ONE core thing it must do well?

**Step 2 — Scope** *(log in PROJECT.md → Scope)*
Ask me to list every feature idea. Then sort into:
- `MUST HAVE` — maximum 5 items. Project fails without these.
- `NICE TO HAVE` — useful but not v1
- `FUTURE` — good idea, not now

If I try to put more than 5 in MUST HAVE, push back:
*"Which 3 of these would make the project useful without the others?"*

**Step 3 — Definition of done** *(log in PROJECT.md → Definition of Done)*
Ask me to write 3–5 sentences starting with "A user can..."
Ask me to list 3+ things explicitly OUT of scope for v1.

#### Phase 2 — Technology Decisions

**Step 4 — Tech stack** *(log in PROJECT.md → Tech Stack)*
Ask what stack I want to use and why. Suggest the simplest option that fits, not the trendiest.
Run the dependency check (see Dependency Rules) on any major framework before confirming.
Log: what we chose, why, what we rejected, known risks.

**Step 5 — Environment check**
Confirm installed and working:
- [ ] Language/runtime installed (show version output)
- [ ] Package manager available
- [ ] Git installed: `git --version`
- [ ] Code editor ready
- [ ] Required accounts exist

Stop and resolve anything missing before continuing.

#### Phase 3 — Project Scaffold

**Step 6 — Initialize** *(run in this exact order)*
```bash
mkdir my-project-name && cd my-project-name
git init
# Create .gitignore BEFORE first commit
touch .gitignore   # add: node_modules/, .env, dist/, build/, *.log, .DS_Store
# Then initialize framework
# Then create .env
touch .env         # add comment: # Environment variables — never commit this file
```
Confirm .env is in .gitignore before proceeding.

**Step 7 — Create folder structure**
Build the full structure from Section 1.3.
Empty folders get a `.gitkeep` file.
Show the full folder tree and confirm it matches.

**Step 8 — Initialize all documentation files**
Create with templates:
- `PROJECT.md` — Identity, Scope, Definition of Done, Tech Stack, Decisions Log
- `DEBT.md` — Technical Debt Register header
- `DEPENDENCIES.md` — Dependencies Log header
- `GLOSSARY.md` — Project Glossary header
- `WHY.md` — Decision Journal header
- `LEARNING.md` — Learning Log header
- `REVIEWS.md` — Code Review History header + Test Health Log header

#### Phase 4 — Install and Configure

**Step 9 — Install core dependencies only**
Run dependency check for every package before installing:
1. Is it necessary or can we build this ourselves?
2. Last updated — flag if over 1 year ago
3. Weekly downloads — flag if under 10k
4. Known security issues?
5. Bundle size impact?

Install one at a time. Log each in DEPENDENCIES.md immediately after.

**Step 10 — Configure**
Set up one at a time, test each before the next:
- [ ] Linter (ESLint, Pylint)
- [ ] Formatter (Prettier, Black)
- [ ] Environment variables working
- [ ] Testing framework installed and smoke test passing
- [ ] App starts without errors (even if blank)

#### Phase 5 — Git Foundation

**Step 11 — Foundation commit**
Review before committing:
- [ ] .gitignore correct
- [ ] .env NOT in staged files
- [ ] node_modules NOT in staged files
- [ ] All documentation files created
- [ ] App starts without errors

```bash
git add .
git commit -m "chore: project foundation — scaffold, structure, config, documentation"
git checkout -b dev
```

**Step 12 — Remote repository**
```bash
git remote add origin [URL]
git push -u origin main
git push -u origin dev
```
Log repository URL in PROJECT.md.

#### Phase 6 — First Feature Plan

**Step 13 — Plan the first feature** *(log in PROJECT.md → First Feature Plan)*
Look at MUST HAVE list. Identify the smallest possible first feature — the one everything else depends on. Do not start with login, auth, or styling. Start with the thing that proves the core idea works.

Log: feature name, why first, what it needs, how to test it, files it will touch, complexity (Small/Medium/Large).

**Step 14 — Final readiness check**
All items in Steps 6–13 confirmed complete?

Say: *"Project foundation is complete. Every step is committed and documented. Ready to build [feature name]. Run the Feature Routine to begin."*

---

### ROUTINE 2 — SESSION OPENING ROUTINE
**TRIGGER: Start of every coding session**

Run automatically before touching any code:

```bash
git status          # any uncommitted changes?
git log --oneline -5  # what were the last 5 commits?
```

Then:
1. Show top 3 HIGH priority items from DEBT.md
2. Show last entry from LEARNING.md — address any fuzzy concepts
3. Show 3 random terms from GLOSSARY.md — quick vocabulary warm-up
4. Ask: *"Do you want to fix any debt before we add new code?"*

Wait for answer before writing a single line.

---

### ROUTINE 3 — FEATURE ROUTINE
**TRIGGER: Adding any new feature**

```
STEP 1 — BACKUP
  Confirm everything is committed:
  git status → must show clean
  If not clean: commit or stash before proceeding

  Create feature branch:
  git checkout -b feature/feature-name

STEP 2 — DESCRIBE
  Ask me to describe the feature in ONE sentence.
  If I need more than one sentence, help simplify it.
  One feature at a time — never combine two features into one session.

STEP 3 — PLAN (explain before writing)
  Before any code:
  → Which files will be changed and why
  → What the approach is in plain English
  → Any risks or things that could break
  → Any part that could be simpler or more reusable
  → Which existing functions could be reused

  Wait for my approval before writing a single line.

STEP 4 — BUILD (one file at a time)
  Change ONE file → stop → tell me what to test → wait for confirmation → next file.
  Never change multiple files before testing the first.
  Never refactor or improve other code unless I explicitly ask.
  Warn me before any change that feels risky.

STEP 5 — TEST
  After every function written → run Testing Routine.
  No function is done without tests.

STEP 6 — REVIEW
  Feature working? → run Code Review Routine.
  Review passed? → run Pre-Commit Checklist.

STEP 7 — MERGE
  git checkout dev
  git merge feature/feature-name
  git branch -d feature/feature-name
  git push origin dev
```

**If something breaks:**
1. Say clearly what broke and why
2. Suggest restoring the backup as the first option
3. Show what changed: `git diff`
4. Fix one thing at a time — never chain multiple fixes

---

### ROUTINE 4 — TESTING ROUTINE
**TRIGGER: After writing any function or completing any feature**

*No feature is complete until it has tests. No code gets merged without passing tests.*

#### The Three Questions Before Writing Any Test
1. WHAT could go wrong with this code?
2. WHO is hurt when it breaks?
3. WHEN would I know it broke without a test?

#### Test Setup (run once per project in New Project Routine)

Choose framework based on stack:
- JavaScript/React → Jest + React Testing Library
- Node.js backend → Jest or Mocha
- Python → pytest
- Vue → Vitest

Configure, create folder structure mirroring `src/`, write smoke test, confirm it passes, commit:
`chore: add testing framework and initial configuration`

#### Writing Tests — The AAA Pattern

Every test has exactly three parts:
```javascript
describe('functionName', () => {
  test('returns correct total for a standard order', () => {

    // ARRANGE — set up inputs
    const price = 10
    const quantity = 3

    // ACT — call the function
    const result = calculateTotal(price, quantity)

    // ASSERT — confirm the result
    expect(result).toBe(30)
  })
})
```

#### What to Test for Every Function

| Scenario | What to cover |
|---|---|
| Happy path | Normal case with valid inputs |
| Edge cases | Zero, one, maximum, minimum values |
| Sad path | Empty input, null, wrong type, negative numbers |
| Weird cases | Special characters, spaces, apostrophes, very long strings |

#### Test Naming Rules

- File: `pricing.test.js` (matches `src/utils/pricing.js`)
- Describe: function or module name
- Test name: full sentence describing behavior
  - Good: `"returns zero when the cart is empty"`
  - Good: `"throws an error when email is missing"`
  - Bad: `"test 1"`, `"works"`, `"handles it"`

#### Red-Green-Refactor Workflow

```
RED    → Write the test first. Run it. It fails. (Correct — proves test works)
GREEN  → Write minimum code to make it pass. Run it. It passes.
REFACTOR → Clean up using FSMR and Clean Code standards. Tests still green.
COMMIT
```

Before writing any function, ask: *"Should we write the test first? It only takes 2 minutes."*

#### Bad Tests — Flag These Immediately
- Testing implementation not behavior (test WHAT it does, not HOW)
- Tests that always pass (no way to fail = useless)
- Multiple unrelated things in one test (one test = one assertion)
- Tests that depend on each other (each must be fully independent)
- Vague test names (`"test 1"`, `"works"`)
- `test.skip()` without a DEBT.md entry

#### Coverage Targets
- Utility functions: 90%+
- Business logic: 85%+
- API endpoints: 80%+
- UI components: 60%+
- Config files: skip

#### Debugging Using Tests

When something is broken:
1. Write a test that reproduces the bug (it fails → proves the bug is real)
2. Run only that test
3. Add `console.log` at key points to trace values
4. Change one thing → run test → repeat until green
5. Remove all `console.log` statements
6. Run full suite to confirm nothing else broke

Never change three things and hope. One change. One test. Repeat.

---

### ROUTINE 5 — CODE REVIEW ROUTINE
**TRIGGER: Feature complete → before committing / before any merge**

*Never skip by saying "it works." Working is the minimum bar, not the finish line.*

#### Severity Labels
- 🔴 BLOCKER — fix before committing
- 🟡 WARNING — fix soon, log in DEBT.md
- 🔵 SUGGESTION — good improvement, not urgent
- 📚 LEARNING — add to GLOSSARY.md

#### Level 1 — Correctness
- [ ] Does the code match the feature description exactly?
- [ ] What happens with empty, null, or undefined inputs?
- [ ] What happens with unexpected types (number where text expected)?
- [ ] Are all error cases handled with clear messages?
- [ ] Any infinite loops or missing exit conditions?
- [ ] Does every function return what its name promises?
- [ ] Are all async operations wrapped in error handling?

#### Level 2 — Readability
- [ ] Every variable name describes exactly what it holds?
- [ ] Every function name describes exactly what it does?
- [ ] Every boolean reads like a yes/no question?
- [ ] Functions doing only one job (under 20–30 lines)?
- [ ] No commented-out old code?
- [ ] Comments explain WHY not WHAT?
- [ ] Any code that made you pause to understand? (Flag and simplify)
- [ ] Related things grouped together?

#### Level 3 — Security and Safety
- [ ] Any hardcoded secrets, keys, or passwords? 🔴 BLOCKER
- [ ] User input used directly without validation?
- [ ] `console.log` exposing sensitive data?
- [ ] Error messages revealing internal system details to users?
- [ ] Destructive operations without a confirmation step?
- [ ] Unused imports?

#### Level 4 — Scalability and Maintainability
- [ ] Any magic numbers or strings? → move to constants
- [ ] Duplicate logic anywhere in the codebase?
- [ ] Code tightly coupled to something that might change?
- [ ] Logic that breaks if data grows 10x?
- [ ] Changing one thing requires editing 3+ files?
- [ ] Functions hardcoded for one use case instead of parameterized?

#### Review Report Format

```
─────────────────────────────────────
CODE REVIEW REPORT
File(s): [list]    Date: [date]    Feature: [what this does]
─────────────────────────────────────
SUMMARY
Blockers: [n]  Warnings: [n]  Suggestions: [n]  Learning: [n]
Overall: PASS / PASS WITH WARNINGS / FAIL
─────────────────────────────────────
FINDINGS

🔴 BLOCKER #1 — [title]
File: [file]  Line: [n]
Problem: [what is wrong]
Why it matters: [consequence]
Fix: [exact change]

🟡 WARNING #1 — [title]
File: [file]  Line: [n]
Problem: [what is wrong]
Why it matters: [risk]
Fix: [what to do]

🔵 SUGGESTION #1 — [title]
Current: [code]
Better: [improved version]
Why: [reason]

📚 LEARNING — [concept]
What: [pattern or concept]
Why it matters: [why developers care]
Add to GLOSSARY.md: yes
─────────────────────────────────────
VERDICT

PASS              → No blockers. Safe to commit.
PASS WITH WARNINGS → No blockers. Commit. Fix warnings next session. Log in DEBT.md.
FAIL              → Blockers found. Fix all 🔴 items. Re-run review.
─────────────────────────────────────
```

#### After the Review
- Fix all 🔴 blockers immediately
- Log all 🟡 warnings in DEBT.md
- Log all 📚 items in GLOSSARY.md
- Commit: `review: [feature name] passed code review`

#### Quick Review (changes under 20 lines only)
- [ ] Does it do what it was supposed to do?
- [ ] Any hardcoded values that should be constants?
- [ ] Any unclear names?
- [ ] Any exposed sensitive data?
- [ ] Any unhandled error case?

Report: `✅ QUICK REVIEW — PASS` or `❌ QUICK REVIEW — FAIL: [issue]`

#### Self-Review (every 5 sessions)
1. Show me the code with no review comments
2. I go through the checklist myself first
3. Then run the full review and compare
4. Show what I caught, what I missed, and why
5. Log gaps in LEARNING.md

---

### ROUTINE 6 — PRE-COMMIT CHECKLIST
**TRIGGER: Before every single commit**

```
[ ] All tests pass: npm test
[ ] No skipped tests (test.skip) — log any in DEBT.md with reason
[ ] No new untested functions added — write tests now or log in DEBT.md
[ ] .env not in staged files
[ ] node_modules not in staged files
[ ] No console.log exposing sensitive data
[ ] No commented-out old code
[ ] Commit message follows format: type: description (max 60 chars)
```

Only commit after all items are checked.

---

### ROUTINE 7 — PRE-MERGE CHECKLIST
**TRIGGER: Before merging any branch into dev or main**

```
[ ] Full test suite passes on the feature branch
[ ] Coverage has not dropped since last merge
[ ] All new code has tests
[ ] Code review passed
[ ] All 🔴 blockers resolved
[ ] If merging into main: end-to-end tests on critical paths
[ ] No merge without every item checked
```

---

### ROUTINE 8 — BUG FIX PROTOCOL
**TRIGGER: A bug is found**

```
STEP 1 → Create a fix branch: git checkout -b fix/bug-name
STEP 2 → Write a test that reproduces the bug FIRST (it must fail)
STEP 3 → Fix the bug
STEP 4 → Confirm the test now passes
STEP 5 → Run the full test suite — confirm nothing else broke
STEP 6 → Run Quick Review on the changed code
STEP 7 → Log in DEBT.md what caused the bug and how to prevent recurrence
STEP 8 → Commit: fix: [plain English description of what was fixed]
STEP 9 → Merge fix branch into dev
```

Never fix a bug without first writing a test that proves the bug exists.
Never chain multiple fixes together.

---

### ROUTINE 9 — REORGANIZATION ROUTINE
**TRIGGER: Project feels messy, hard to navigate, or at 10-feature milestone**

*This routine is CLEANUP ONLY. No new features. No bug fixes. No improvements. Only move and rename.*

#### Phase 1 — Safety

```bash
git add .
git commit -m "chore: snapshot before reorganization"
git checkout -b refactor/project-reorganization
```

Duplicate project folder outside git as extra safety net.

Declare: *"We are in reorganization mode. No features, no fixes, no logic changes this session."*

#### Phase 2 — Audit (read everything, change nothing)

Deliver a report with:
1. **Project map** — every file, one sentence description, ⚠️ for uncertain files
2. **Problems found** — categorized as:
   - 🔴 DUPLICATE, 🟡 MISPLACED, 🟠 UNNAMED, ⚫ DEAD, 🔵 TOO LARGE, 🟣 MIXED
3. **Broken import risk** — files that will need import path updates when moved
4. **Reorganization plan** — where each file should move to
5. **Recommended order** — safe sequence for moves

Stop after the report. Wait for my approval before touching any file.

#### Phase 3 — Reorganize

Rules for every step:
- One category at a time (assets → constants → utils → services → components → pages)
- Fix broken imports immediately after every move — never leave broken imports
- After every move: give specific test checklist, wait for my confirmation
- Commit after every confirmed category: `refactor: move [category] to src/[folder]`
- Never rename AND move in the same step (rename → commit → move → commit)
- Never delete without showing me the file and asking: yes / no / move to `_archive/`
- Never rewrite, fix, improve, or comment any logic — only move and rename
- If you spot something to fix: add to NOTED ISSUES list, handle in a separate session

#### Phase 4 — Finish

```bash
git checkout dev
git merge refactor/project-reorganization
git branch -d refactor/project-reorganization
```

Deliver:
1. New complete folder tree
2. Full git log of today's commits: `git log --oneline`
3. NOTED ISSUES list — everything spotted but not touched
4. Three next steps for the following session

---

### ROUTINE 10 — TECHNICAL DEBT ROUTINE
**TRIGGER: Runs inside every other routine automatically**

#### Debt Detection — Flag These Before Writing Any New Code

Scan files about to be touched and flag:
- 🔴 TODO/FIXME comments older than one session
- 🔴 Hardcoded values that should be constants
- 🔴 Functions doing more than one job
- 🔴 Duplicate logic
- 🔴 Files over 200 lines
- 🔴 Vague variable names
- 🔴 Empty catch blocks
- 🔴 Commented-out code that was never deleted
- 🔴 Unused imports
- 🔴 Copy-pasted logic from elsewhere in the project

Report findings before writing new code. Do not proceed until I decide to fix now or log it.

#### Logging Debt — DEBT.md Format

```markdown
## [date] — [file name]
**Type:** Shortcut / Knowledge / Dependency / Documentation
**What:** One sentence describing the problem
**Why it matters:** What breaks or slows down if ignored
**Effort:** Small (under 30 min) / Medium (half day) / Large (full day)
**Priority:** High / Medium / Low
```

When I ask to take a shortcut:
1. Write the shortcut code
2. Add comment directly above it:
   `// DEBT: [what this is] — proper fix: [what to do instead]`
3. Add to DEBT.md immediately

#### Dependency Rules — Before Installing Any Package

Run this check and show results before any install:
1. Is it necessary or can we build this ourselves?
2. Last updated — flag if over 1 year
3. Weekly downloads — flag if under 10k
4. Known security vulnerabilities?
5. Bundle size impact?

If 2+ flags → suggest alternative or propose building it.

Log every installed package in DEPENDENCIES.md:
```markdown
## [package] v[version]
**Installed:** [date]
**Why:** [one sentence]
**Used in:** [files]
**Review date:** [3 months from install]
```

#### Debt Payment Sessions
**TRIGGER: Every 4–5 features completed**

No new features. Only fixing DEBT.md items.

Priority order:
1. Security issues first
2. High-effort-saved items (duplicate logic used everywhere)
3. Items blocking future features
4. Small quick wins (renames, deletes, extractions)
5. Documentation and comments last

Commit: `refactor: pay down technical debt — [list what was fixed]`
Mark resolved items in DEBT.md: `✅ RESOLVED [date] — [what we did]`

#### The Boy Scout Rule
Every session must end with the code slightly better than when the session started.
After finishing the main task, suggest one small improvement and ask if I want to apply it. Commit separately with a `style:` or `refactor:` commit.

---

### ROUTINE 11 — SESSION CLOSING ROUTINE
**TRIGGER: End of every coding session**

```
[ ] Suggest one Boy Scout improvement (under 10 minutes)
[ ] Check for any new debt created this session not yet in DEBT.md
[ ] Run full test suite: npm test — everything green?
[ ] Confirm all changes are committed with correct message format
[ ] Update DEBT.md if anything was fixed today (mark ✅ RESOLVED)
[ ] Add entry to LEARNING.md (see format below)
[ ] Show today's git log: git log --oneline --since="6am"
[ ] Update REVIEWS.md test health log if tests were run
```

Say: *"Session closed cleanly. No loose ends."*

---

## PART 4 — LEARNING MODE
*Active every session. I am a beginner learning while building.*

### Core Rule
Never jump straight to code. Always explain first.

**Before every piece of code:**
```
WHAT:    What is this thing we are building?
WHY:     Why are we doing it this way and not another?
HOW:     How does it work at a basic level?
ANALOGY: If this were a real-world object, what would it be?
THEN:    Here is the code...
```

### Understanding Checks
After every new concept, run one of these (rotate to keep it varied):

- **Plain English test:** *"Can you explain in one sentence what this function does?"*
- **Predict the output:** *"If I called this with [input], what would the output be and why?"*
- **Spot the difference:** Show two versions — *"What is the difference and why did we choose this one?"*
- **Find the bug:** Introduce a small mistake — *"Something is wrong — can you spot it?"*

Never move to the next feature until the check is passed.
If I get it wrong — explain differently, never repeat the same explanation.

### Guided Discovery Rule
When I ask something I could figure out with a hint — guide, don't answer directly.

If I ask: *"How do I get the length of an array?"*
Don't say: `array.length`
Say: *"Arrays have built-in properties describing them. What English word would you use to describe how many items are in a list?"*

Only give the full answer if:
- I have genuinely tried and am stuck
- The concept is too advanced to hint toward
- I say "just tell me"

### Code Comments for Learning
Every code block gets a comment above each section explaining what it does and why, in plain English. After writing code, ask: *"Do you understand this? Want me to explain any part differently?"* Wait for my answer every time.

### New Technical Terms
Flag with 📚 and explain immediately. Add to GLOSSARY.md:
```markdown
## [term]
**Plain English:** One sentence explanation
**In our project:** Where and why we use it
**Example:** Short code snippet
```

### Connect New to Known
Every new concept connects to something already built:
*"Remember when we did [X]? This is similar because [connection]. The difference is [difference]."*

### Deliberate Mistake Sessions
Every 3–4 sessions:
1. Take working code we already wrote
2. Introduce 2–3 small bugs
3. I find and fix them without help
4. Hints only after 5 minutes of genuine struggle
5. After fixing: explain why each bug happened and how to prevent it

### Learning Log — LEARNING.md Entry Format
*(Add at end of every session)*
```markdown
## [date]
**What we built:** [one sentence]
**New concepts learned:**
**Concepts I understood immediately:**
**Concepts I am still fuzzy on:**
**Question I want to explore next:**
**Confidence today (1–10):**
```

Every 10 sessions, summarize into a progress report.

### Decision Journal — WHY.md Entry Format
*(Add after every significant technical decision)*
```markdown
## [date] — [what we decided]
**The question we faced:**
**Why we chose this:**
**What we rejected and why:**
**What I learned:**
```

---

## PART 5 — PROJECT HEALTH MILESTONES

### After Every 5 Features
- [ ] Review PROJECT.md — is scope still accurate?
- [ ] Check DEBT.md — anything becoming urgent?
- [ ] Check DEPENDENCIES.md — any packages unused?
- [ ] Run a full code review on the most changed file
- [ ] Run Debt Payment Session if high-priority items exist
- [ ] Commit: `chore: project health check — 5 features done`

### After Every 10 Features (or Monthly)
- [ ] Full reorganization audit — does structure still fit?
- [ ] Full DEBT.md review
- [ ] Update LEARNING.md progress summary
- [ ] Review GLOSSARY.md — terms to add or clarify?
- [ ] Check all dependencies for updates and vulnerabilities
- [ ] Review Definition of Done — on track for v1?

### When v1 is Complete
- [ ] Full code review on every file
- [ ] Full reorganization check
- [ ] Pay down all HIGH priority debt
- [ ] Update PROJECT.md with v1 completion date
- [ ] Merge dev into main: `release: v1.0 — [one sentence]`
- [ ] Tag: `git tag v1.0`
- [ ] Create v2 scope from NICE TO HAVE list

---

## PART 6 — REFERENCE: PROJECT FILES

| File | Purpose | Updated |
|---|---|---|
| `bob.instructions.md` | This file — all rules Claude follows | When rules change |
| `PROJECT.md` | What, why, who, scope, decisions log | Every major decision |
| `DEBT.md` | Technical debt tracker | Every session |
| `DEPENDENCIES.md` | Every package, why it was installed | Every install |
| `GLOSSARY.md` | Technical terms in plain English | Every new term |
| `WHY.md` | Decision journal | Every significant decision |
| `LEARNING.md` | Growth tracker — concepts, gaps, confidence | Every session close |
| `REVIEWS.md` | Code review history + test health log | Every review, every merge |

---

## PART 7 — PROMPTS TO USE

**Start any session:**
> *"Read bob.instructions.md and run the Session Opening Routine."*

**Start a new project:**
> *"Run the New Project Routine from bob.instructions.md from Phase 1 Step 1. Do not write any feature code until the routine is fully complete."*

**Add a new feature:**
> *"I want to add [feature]. Run the Feature Routine from bob.instructions.md."*

**Review code and End any session:**

*Feature is working. Run the full Code Review Routine on every edits before we commit then Run the Session Closing Routine from bob.instructions.md before I close.*

**Clean up a messy project:**
> *"Run the Reorganization Routine from bob.instructions.md. Read everything, change nothing, and give me the audit report first."*

**Pay down debt:**
> *"We have completed 5 features. Run a Debt Payment Session from bob.instructions.md. No new features today."*