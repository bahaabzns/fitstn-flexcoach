
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

## Git Version Control Rules — Always Enforce These

### The golden rule
Every working state must be committed before touching anything new.
No exceptions. A backup that isn't committed doesn't exist.

### Branch strategy — never work on main directly
- main (or master) = production-ready code only, always working
- dev = active development branch, merges into main when stable
- feature/feature-name = one branch per feature, branches off dev
- fix/bug-name = one branch per bug fix, branches off dev

Branch naming examples:
  feature/user-login
  feature/dark-mode
  fix/broken-checkout-button
  fix/mobile-layout

Workflow for every new feature:
  1. Make sure you're on dev and it's up to date
  2. Create a new branch:  git checkout -b feature/your-feature-name
  3. Build the feature with small commits along the way
  4. When done and tested, merge back into dev
  5. Only merge dev into main when everything is stable and tested

### Commit rules — every commit must follow this format

Format:
  type: short description in plain English (max 60 characters)

Types:
  feat:     a new feature
  fix:      a bug fix
  refactor: restructuring code without changing behavior
  style:    formatting, naming, clean code changes only
  docs:     comments, readme, documentation
  chore:    setup, config, dependencies

Good commit examples:
  feat: add login form with email and password fields
  fix: prevent crash when user submits empty search
  refactor: extract price calculation into its own function
  style: rename variable x to userAge for clarity
  docs: add comments explaining the retry logic
  chore: add CLAUDE.md with project coding rules

Bad commit examples (never do these):
  "update"
  "fix stuff"
  "changes"
  "asdfgh"
  "final"
  "final2"

### Commit size — small and focused
- One commit = one logical change, not a whole day of work
- If your commit message needs the word "and", split it into two commits
  Bad:  feat: add login form and fix navigation bug and update colors
  Good: feat: add login form
        fix: navigation not highlighting active page
        style: update primary color to match new brand
- Commit after every meaningful step, not just at end of day
- Never commit broken code — if it doesn't work, don't commit it

### What to never commit
Always have a .gitignore file that excludes:
  - API keys, passwords, secrets (.env files)
  - node_modules/ or any dependency folders
  - Build output folders (dist/, build/, .next/)
  - Editor config files (.DS_Store, .vscode/ unless team-shared)
  - Log files (*.log)

Claude must warn me immediately if any of these are about to be committed.

### Before every coding session
Run and report:
  git status        → are there uncommitted changes?
  git log --oneline -5  → what were the last 5 commits?

This gives us a clear picture of where we are before we touch anything.

### After every working feature
1. Commit all changes with a proper commit message
2. Confirm the app still works after committing
3. If on a feature branch, merge into dev:
   git checkout dev
   git merge feature/your-feature-name
4. Delete the feature branch after merging (keep it clean):
   git branch -d feature/your-feature-name
5. Only merge dev into main when the full feature set is stable

### When something breaks
1. First check what changed:  git diff
2. Check recent commits:      git log --oneline -10
3. To undo uncommitted changes to a file:
   git checkout -- filename
4. To go back to the last commit entirely:
   git reset --hard HEAD
5. To go back to a specific commit (use the commit hash from git log):
   git reset --hard abc1234
6. Never force push to main — ever

### Claude's responsibilities
- Remind me to commit before starting any new feature
- Suggest the correct commit message in the right format after each change
- Warn me if I'm about to change main directly
- Flag if too many things are changed without a commit
- Never let a session end with uncommitted working code


