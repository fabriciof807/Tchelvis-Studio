# Project Agent Contract (`AGENTS.md`)

## Workspace Layout
- `brainstorm/` — Raw ideas, references, and `00-inbox.md`. Permanent visual references belong in `brainstorm/assets/`.
- `world/` — Worldbuilding, rules (`_regras-mundo.md`), factions (`faccoes/`), and locations (`locais/`).
- `gdd/` — Game Design Document (`01-visao-geral.md`, `02-core-loop.md`, `03-mecanicas.md`).
- `game/` — Playable game source code (`project.godot` or Vite/Three.js app).
- `.hub/` — Hub metadata (`project.json`, `presets/`, `views/` are versioned; `layout.json`, `captures/`, `pi-session/`, `hub.lock` are git-ignored).

## Rules for Agents
1. **Filesystem is the single source of truth.** Keep all design documents in standard Markdown with `[[wikilinks]]`.
2. **Respect active editor buffers.** Never overwrite files listed in `active_context.dirty_files` without user confirmation.
3. **Context firewall.** Long-running code generation belongs in `tchelvis loop` worktrees, not in the creative chat session.
4. **Read-only lenses.** Custom HTML views in `.hub/views/` must remain self-contained, offline, and read-only.
