---
name: init-game-project
description: Initialize a new local-first Game Dev Hub project structure with Git, AGENTS.md, GDD/worldbuilding folders, and .hub/project.json.
---

# `init-game-project` Skill

When the user opens an uninitialized directory (no `.hub/project.json` and no files other than `.git/`), run this initialization workflow:

1. **Check Git repository:**
   - If `.git/` does not exist in the workspace root, run `git init -b main` (or `git init`).
2. **Ask Engine Choice:**
   - Ask the user whether the project targets `"godot"` (Godot 4) or `"web"` (Vite / Three.js / WebGL).
3. **Create Directory Structure:**
   - `.hub/presets/`
   - `.hub/captures/`
   - `.hub/views/`
   - `.hub/pi-session/`
   - `brainstorm/`
   - `world/faccoes/`
   - `world/locais/`
   - `gdd/`
   - `game/`
4. **Copy & Populate Templates:**
   - Write `.gitignore` from `templates/.gitignore`.
   - Write `AGENTS.md` from `templates/AGENTS.md`.
   - Write `.hub/project.json` from `templates/project.json` with `"engine"` set to the user's choice (`"godot"` or `"web"`).
   - Seed starter Markdown files:
     - `brainstorm/00-inbox.md`
     - `world/_regras-mundo.md`
     - `gdd/01-visao-geral.md`
     - `gdd/02-core-loop.md`
     - `gdd/03-mecanicas.md`
5. **Confirm:**
   - Report the created structure and remind the user that `.hub/project.json`, `AGENTS.md`, `brainstorm/`, `world/`, `gdd/`, and `game/` are versioned in Git while `.hub/layout.json`, `.hub/captures/`, `.hub/pi-session/`, and `.loops/` are git-ignored.
