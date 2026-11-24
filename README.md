**English** | [Português (Brasil)](README.pt-BR.md) | [简体中文](README.zh-CN.md)

# Tchelvis Studio (Game Dev Hub)

**A local-first desktop studio for Game Design, Worldbuilding, and AI Agent Orchestration.**

Built with **Tauri v2 (Rust + WebKitGTK)**, **React 19**, **TypeScript**, **Dockview**, **CodeMirror 6**, **xterm.js**, and **Three.js**, Tchelvis Studio brings Markdown GDD authoring, assisted chat, visual reference generation, 2D/3D asset inspection, an embedded terminal, and automated loop monitoring into a single workspace backed directly by plain local files.

---

## Use Cases

- **Creative Pre-Production, GDD & Worldbuilding:** Author design documents (`gdd/`, `world/`, `brainstorm/`) with an Obsidian-style editable *Live Preview*, clickable `[[wikilinks]]`, autocomplete, and collision resolution.
- **Agent-Assisted Development with a Context Firewall:** Use the **Chat** panel to automatically attach your focused panel, open tabs, unsaved files (`dirty_files`), and clipboard screenshots (`Ctrl+V` one-shot attachments), while long coding tasks run isolated in *git worktrees* via `tchelvis`.
- **In-Project Visual Reference Generation:** Run `/flow <save_path.png> <prompt>` or the `generate_flow_reference` tool to generate concept art via **Google Flow** (using a persistent authenticated WebView profile) or fall back to the **Gemini Image API** (`GEMINI_API_KEY`), saving straight into your project for immediate preview (`![[image.png]]` or `![alt](image.png)`).
- **2D Image & 3D Model Inspection:** Click images (`.png`, `.jpg`, `.webp`, `.svg`, etc.) or 3D models (`.glb`, `.gltf`, `.obj`, `.stl`, `.fbx`) in the file explorer to open the built-in viewer with zoom/checkerboard controls or 3D orbit, grid, and wireframe modes.
- **Godot 4 & Web/Three.js Prototype Previews:** Launch Vite dev servers on dynamic ports (`F5`) with a 16:9 lightbox and external browser fallback, or run Godot 4 staging builds with CoW cache (`cp --reflink=auto`), optional Hyprland/`grim` integration, and safe worktree merging.

---

## Key Differentiators

- **100% Local-First (No Proprietary Database):** Everything lives in standard Markdown, JSON, and TOML files — fully compatible with Git, Obsidian, and VS Code.
- **Unified Obsidian-Style Live Preview:** Edit directly on the rendered document (headings, bold, italic, inline code, quotes, lists, inline images, and wikilinks); raw Markdown syntax is revealed only on the active cursor line.
- **Built-in Image & 3D Model Viewer:** Inspect sprites, concept art, and 3D meshes directly from the file explorer without switching apps.
- **Native PTY Terminal + Instant Zen Mode:** Real `$SHELL` terminal (`portable-pty`) with Hub shortcut pass-through (`Ctrl+B`, `Ctrl+L`, `Ctrl+J`, `F5`) that stays alive across Zen Mode toggles, plus draggable splitters on every drawer border.
- **Sandboxed Read-Only Lenses:** Custom HTML views (`.hub/views/*.html`) run inside `<iframe sandbox="allow-scripts">` with network-disabled CSP and a validated `postMessage` bridge.
- **Themes & Multi-Language:** Includes 4 built-in themes (**Tokyo Night**, **Gruvbox**, **Kanagawa**, **GitHub Dark**) and **English**, **Português (Brasil)**, and **简体中文** with automatic OS language detection on first launch.
- **Dual CI/CD Update Channels:**
  - **Stable (`0.x.0`):** Tested milestone releases (`v0.4.0`, `v0.5.0`, etc.).
  - **Nightly (`0.x.x`):** Continuous bleeding-edge builds with the latest fixes and features.

---

## Installation (Linux / Arch / EndeavourOS)

### Stable Channel (`0.x.0` — Recommended)
```bash
curl -fsSL https://raw.githubusercontent.com/fabriciof807/Tchelvis-Studio/stable/install.sh | bash
```

### Nightly Channel (`0.x.x` — Bleeding Edge)
```bash
curl -fsSL https://raw.githubusercontent.com/fabriciof807/Tchelvis-Studio/nightly/install.sh | bash -s -- --channel nightly
```

What `install.sh` does:
1. Installs required Arch/EndeavourOS runtime packages via `pacman` (`webkit2gtk-4.1`, `gtk3`, `dbus`, `libayatana-appindicator`, `librsvg`, `xdotool`).
2. Downloads the prebuilt CI/CD GitHub Release binary (verifying `SHA256SUMS.txt`) and installs it to `~/.local/bin/game-hub`.
3. If no prebuilt release exists yet for the chosen channel or `--from-source` is passed, clones into `~/.local/share/game-hub` and builds locally (`npm ci && npm run build` + `cargo build --release --features desktop,custom-protocol`).
4. Seeds default configuration into `~/.config/game-hub/` and creates `~/.local/share/applications/game-hub.desktop`.

> **Tip:** Make sure `~/.local/bin` is in your `PATH`. Run `game-hub` from your terminal or launch **Game Dev Hub** from your app launcher.

### Manual Build (Development)
```bash
git clone https://github.com/fabriciof807/Tchelvis-Studio.git
cd Tchelvis-Studio
npm ci
npm run build
cargo build --manifest-path src-tauri/Cargo.toml --release --features desktop,custom-protocol
```

---

## Updating

From inside the app:
1. Open **Settings** (gear icon in the Activity Bar, top bar, or Welcome screen).
2. Select your update channel (**Stable** or **Nightly**).
3. Click **Check for Updates** to view the remote version and changelog since your current build.
4. Click **Update Now**, then click **Restart Now** (with confirmation).

Or re-run the `curl` install command above in your terminal.

---

## Uninstalling

To completely remove the binary, desktop entry, installation cache, and global configuration:

```bash
rm -f ~/.local/bin/game-hub
rm -f ~/.local/share/applications/game-hub.desktop
rm -rf ~/.local/share/game-hub
rm -rf ~/.config/game-hub
rm -rf ~/.local/state/game-hub
```

*(Your project/workspace directories remain untouched.)*

---

## Default Shortcuts

| Shortcut | Action |
| :--- | :--- |
| `Ctrl+B` | Toggle left drawer (Explorer, Loops, Lenses) |
| `Ctrl+L` | Toggle Chat drawer |
| `Ctrl+J` | Toggle bottom Terminal drawer |
| `F5` | Open / focus Project Preview |
| `Ctrl+S` | Save active Markdown document |
| `Ctrl+V` (in Chat) | Paste clipboard screenshot as a one-shot attachment |

---

## License

See repository metadata for licensing and contribution details.
