# WHY.md — Decision Journal

> When a non-obvious decision is made, log it here with the reasoning.
> Future-you will thank present-you.

---

## 2026-04-05 — Extracted API_BASE to config.js

**Decision:** Move all hardcoded API base URLs in the chrome extension into a single `config.js` file.

**Why:** The URL was duplicated in background.js, content.js, popup.js, and status-popup.js. Switching between dev (localhost:3000) and production (render.com) required editing 4 files. Now it's one toggle in one file.

**Alternatives:** Could have used chrome.storage or a build step — both overkill for a simple URL toggle.

---

## 2026-04-05 — Adopted bob.instructions.md framework

**Decision:** Replace the old instructions file with a structured developer framework (bob.instructions.md).

**Why:** Need consistent routines for session management, feature development, testing, commits, and debt tracking. The old instructions were less structured.

**Alternatives:** Ad-hoc development — rejected because the project is growing and needs discipline.

---

## Pre-2026 — Project Reorganization

**Decision:** Flatten the folder structure — move chrome-extension and server to project root, archive old versions.

**Why:** The original nested structure (inside fitstn_plugin/) added unnecessary depth. Flat structure is easier to navigate.

**Commits:** 858f865 through 9054ea2 (5 refactor commits).
