# Spec: Image viewer pan/zoom and the F5 game preview

Status: approved (decisions settled 2026-11-26) · Date: 2026-11-26 · Independent of the chat UX slices (S3+)

This short spec covers two Hub fixes:

- **Part A:** the image viewer in `MediaViewerPanel` gets middle-mouse panning and a zoom that works correctly.
- **Part B:** the F5 preview detects the project's engine and shows the running game on top of the Hub.

It contains no code.

---

## Part A — Image viewer: pan with the middle mouse button, correct zoom

### A.1 Current behaviour (evidence)

All references are to `src/panels/MediaViewerPanel.tsx` (`ImageViewer`, `:130-258`) and `src/index.css:1972-2005`.

| # | Problem | Cause |
|---|---|---|
| Z1 | The first zoom step out of "Fit" jumps abruptly. For example, a 4000 px image shown at an effective 25 % jumps to 115 %. | `stepZoom` treats `'fit'` as scale `1` (`:178`) instead of the real fitted scale. |
| Z2 | The label shows "Fit" or "100 %" in fit mode, never the real scale. | `zoomPercent` returns 100 for `'fit'` (`:174`). |
| Z3 | Once zoomed in, the top and left parts of the image can't be reached by scrolling. | `transform: scale()` doesn't change layout size, so `overflow: auto` sees the unscaled box. In addition, a centred flex container clips overflow on the negative side. |
| Z4 | Zoom is anchored to the image centre, not the cursor. | `transform-origin: center` and no offset handling. |
| Z5 | The wheel also scrolls the panel, and the console warns about `preventDefault` in a passive listener. | React attaches `onWheel` as passive. Its `preventDefault()` at `:239` has no effect. |
| Z6 | Steps feel uneven: +0.15 is large at 20 % and tiny at 600 %. Trackpads fire dozens of steps per gesture. | Additive steps that ignore `deltaY` magnitude. |
| Z7 | There is no way to drag the image. | Not implemented. |

### A.2 Target behaviour

- **View model:** the image is drawn at `translate(x, y) scale(s)` inside a stage with `overflow: hidden`. The state is `{ scale, x, y, mode: 'fit' | 'free' }`. Scrollbars go away, and navigation happens only through pan and zoom.
- **Fit:** computes the real scale, `min(stageW / imgW, stageH / imgH, 1)`, and centres the image. Fit is recomputed when the panel is resized (`ResizeObserver`) while `mode === 'fit'`. Any zoom or pan switches to `'free'`.
- **Wheel zoom:**
  - Zoom is anchored at the cursor, so the image pixel under the pointer stays under the pointer.
  - The zoom factor is multiplicative: `s × 2^(-deltaY × k)`, with `deltaY` normalised for `deltaMode` (lines and pages).
  - Scale is clamped to **5 %–3200 %** (decision 2).
  - The wheel listener is a native listener with `{ passive: false }`, so the panel doesn't scroll.
- **Toolbar buttons (− / +):** step ×1.25 or ÷1.25, anchored at the stage centre. **Fit** and **1:1** keep their current meaning. 1:1 is centred on the current view centre.
- **Label:** always shows the real percentage, including in fit mode (for example "Fit · 25 %").
- **Pan with the middle mouse button:**
  - Pointer down with `button === 1` starts a pan. The app uses pointer capture, so the drag keeps working outside the panel. Pointer up or `pointercancel` ends it.
  - The cursor shows `grabbing` while dragging.
  - The middle button's default behaviour is prevented on `mousedown`, and `auxclick` is suppressed. On Linux/WebKitGTK, this blocks autoscroll and primary-selection paste.
  - Panning is clamped so that at least 48 px of the image stays visible. The image can't be lost off-screen.
  - Pan works in fit mode too, and switches the mode to `'free'`.
- **Not in scope:** left-drag pan, Space+drag, keyboard shortcuts, touch pinch, minimap, the 3D viewer (`Model3DViewer` already uses OrbitControls).
- The image's natural pixels are rendered crisply above 100 % (`image-rendering: pixelated` at ≥ 200 %), which suits pixel-art assets. This is decision 1.

### A.3 Design for testability

- Keep the maths in a pure module, `src/panels/imageViewport.ts`, with no DOM access:
  - `fitTransform(stage, image)`
  - `zoomAt(state, factor, anchor, bounds)`
  - `panBy(state, dx, dy, stage, image)`
  - `clampScale`
  - `wheelFactor(deltaY, deltaMode)`
- `ImageViewer` keeps only the DOM wiring: pointer and wheel listeners, `ResizeObserver` and the toolbar.

### A.4 Acceptance criteria

1. Wheel zoom anchored at the cursor keeps the image point under the cursor fixed (within 0.5 px, unit test).
2. Leaving Fit with the + button gives 1.25 × the real fit scale, not 125 %.
3. At any zoom level, every edge of the image can be reached with middle-drag.
4. The wheel never scrolls the panel or the page, and the console shows no passive-listener warning.
5. Middle-click doesn't paste or start autoscroll on Linux.
6. While in Fit mode, resizing the dock panel re-fits the image. In free mode, the view stays where it is.
7. Opening another file resets the view to Fit (as today, `:145`).

### A.5 Tests

- **Vitest, `imageViewportLogic.test.ts`** (pure module): fit for landscape, portrait and small images; anchor invariance for `zoomAt`; clamps for scale and pan; normalisation in `wheelFactor`.
- **Vitest + Testing Library, `ImageViewer`** (jsdom): a middle-button pointer sequence changes the transform; a left-button sequence doesn't; wheel events call `preventDefault`.
- **Manual check:** a large photo, a 32×32 pixel-art sprite and a trackpad, all in the Tauri build.

---

## Part B — F5 preview: detect the engine, show the game on top of the Hub

### B.1 Current behaviour (evidence)

F5 (`src/App.tsx:41-49`) calls `startPreview('main')` when nothing is running. Nothing appears in the Tauri build, for three reasons. The browser mock hides all three because it returns a hand-written, already-correct status (`src/types/ipc.ts:976-993`).

| # | Problem | Evidence |
|---|---|---|
| P1 | **`'main'` is rejected.** The frontend sends `mode = 'main' \| 'staging'`, but `cmd_preview_start` matches on `"web" \| "vite" \| "godot" \| "staging"`. As a result, `'main'` returns "unsupported preview mode: main", and `'staging'` always launches Godot. | `src-tauri/src/lib.rs:463-479` |
| P2 | **The engine is never read.** `.hub/project.json` has `engine` (`ProjectConfig.engine`, `types.rs:109`), but `AppState` only exposes `game_dir()` and `default_branch()`. The engine choice is hard-wired to the mode string. | `lib.rs:95-110` |
| P3 | **The IPC contract doesn't match.** The frontend reads fields that Rust never sends. Rust sends `{active, mode, port, url, pid, degraded_reason}` (`types.rs:328-335`). TS expects `{running, engine, worktree_path, compositor_available, can_capture, logs, …}` (`ipc.ts:282-293`). The results: `status.running` is always `undefined`, so a second F5 restarts the preview instead of reopening it; `previewLightboxOpen` is never set; and the lightbox placeholder would crash on `previewStatus.logs.length`. | — |
| P4 | **Errors are silent.** `startPreview` has no `try/catch` (`workspaceStore.ts:794-800`), and F5 uses `void`, so a rejection becomes an unhandled promise. The user sees nothing. | — |
| P5 | **The web iframe is blocked by the CSP.** Even with a correct status, `frame-src 'self' blob: data:` blocks `http://127.0.0.1:<port>`. | `src-tauri/tauri.conf.json:27` |
| P6 | **The Godot window isn't "over the Hub".** It is only floated and centred when the Hyprland adapter is active. With the null adapter (`compositor.rs:134`), it opens wherever the window manager places it, often behind the Hub. | `preview.rs:193-260` |

### B.2 Target behaviour

**F5 when no preview is running:**

1. The backend resolves the engine (§B.3).
2. While the preview starts, the overlay opens straight away in a **"Starting {engine} preview…"** state. That state shows a spinner, the last log line and a **Cancel** button.
3. Once the game is running:
   - **Web:** the overlay shows the game in a 16:9 viewport using the existing lightbox (`PreviewLightbox.tsx`), with an iframe on the `http://127.0.0.1:<port>/` URL.
   - **Godot:** the game runs in its own native window (Godot can't be embedded in a webview). The native window is placed **centred over the Hub window and always on top** (§B.4). The Hub shows a compact overlay bar with the engine, the PID and the **Focus game**, **Capture frame** and **Stop** buttons. The bar replaces the empty 16:9 placeholder.

**F5 while running:** brings the overlay back (web) or focuses the game window (Godot). It never restarts the game.

**Failure:** the overlay switches to an error state with the backend message and the last 20 log lines, plus **Retry** and **Close** buttons. Example messages: "`godot` not found in $PATH", "no `dev` script in game/package.json", or the healthcheck timeout.

**Closing:** ✕ or `Esc` closes the overlay but **keeps the game running**. The toolbar badge shows "Preview active (F5)", as today. **Stop** ends the process.

**Staging:** `mode` keeps its meaning of *which tree* to run: `main` for the workspace root, `staging` for a worktree. Mode is never used for engine selection again.

### B.3 Engine detection (backend, pure function)

`resolve_preview_engine(project_config, game_dir_path) -> Result<Engine, String>`, where `Engine = Godot | Web`:

1. If `.hub/project.json` has `engine` set to `"godot"` or `"web"`, use it.
2. If the value is missing or unknown, inspect the files:
   - `<game_dir>/project.godot` means Godot.
   - Otherwise, `<game_dir>/package.json` with a `scripts.dev` entry means Web.
3. If neither matches, return an error that names the files checked.
4. If `project.json` and the files disagree (for example `engine: "web"` alongside a `project.godot`), `project.json` wins and the status carries a warning in `degraded_reason`.

The new command signature is `preview_start(mode: 'main' | 'staging', worktree_path?)`. The engine is resolved on the backend and returned in the status.

### B.4 Placing the Godot window over the Hub

Approach (decision 3):

- The frontend sends the Hub window's outer position and size with `preview_start`. In Tauri these come from `getCurrentWindow().outerPosition()` and `.outerSize()`.
- The backend computes a centred rectangle using the configured preview size (`compositor.preview_width/height`, default 1280×720), scaled down to fit inside the Hub with a 5 % margin.
- Godot 4 is launched with `--windowed --resolution WxH --position X,Y --always-on-top`.
- When the Hyprland adapter is active, it still runs `float_and_center_pid`, because Hyprland ignores client positioning.
- Under native Wayland, `--position` may be ignored. The window still opens always-on-top, and the overlay bar offers **Focus game**. That case is reported in `degraded_reason` and isn't treated as an error.

### B.5 IPC contract fix (single source of truth)

Rust `PreviewStatus` becomes the contract, serialised in snake_case:

```
running: bool
mode: "main" | "staging" | "idle"
engine: "web" | "godot" | null
url: string | null          // web only
pid: u32 | null
worktree_path: string | null
compositor_available: bool
can_capture: bool
degraded_reason: string | null
logs: string[]              // last 50 lines from the existing log_tail
```

- `port` is dropped from the wire format, because the URL already contains it.
- TS `PreviewStatus` mirrors these fields exactly. The browser mock has to build its value through the same shape, which a type test enforces.
- A Rust serde test pins the JSON keys, so the two sides can't drift again.

### B.6 Security

- The CSP gains only `frame-src http://127.0.0.1:*`. It doesn't allow `localhost` or any other host. The Vite server already binds to the port chosen by `allocate_free_port`.
- The iframe gets `sandbox="allow-scripts allow-same-origin allow-pointer-lock"` plus `allow="fullscreen; gamepad; autoplay"`.
- `allow-same-origin` is safe here only because the origin (`127.0.0.1:<port>`) differs from the Hub's, so the frame can't reach Tauri IPC. This must be recorded in `docs/DECISIONS.md`.
- "Open external" keeps `noopener,noreferrer`.

### B.7 Acceptance criteria

1. In a Godot project (`engine: "godot"`), F5 in the Tauri build launches Godot centred over the Hub and on top of it. The Hub shows the overlay bar.
2. In a web project, F5 shows the starting state, and then the running game in the 16:9 overlay within the healthcheck timeout.
3. When `project.json` has no `engine`, detection falls back to the files and the right engine starts.
4. A second F5 while the game is running never spawns a second process. Covered by a Rust test that checks the PID is unchanged, and by a store test.
5. Any start failure appears in the overlay with the message and logs. There are no unhandled promise rejections.
6. Closing the overlay keeps the game running, and Stop ends the whole process group (existing `terminate_process_group`).
7. The JSON for `PreviewStatus` matches the TS type. Covered by a serde key test and a TS type test.
8. The CSP diff is limited to `frame-src http://127.0.0.1:*`.

### B.8 Tests

- **Rust:**
  - `resolve_preview_engine`: config wins; file fallback for Godot and web; neither found; conflict warning.
  - Godot window-rectangle maths: centring, scaling down, small Hub windows.
  - `PreviewStatus` serde keys.
  - `cmd_preview_start` with `mode = "main"` dispatches on the resolved engine, using a fake engine launcher that is injected and never spawns real Godot or npm.
- **Vitest:**
  - F5 handler: idle → start; running → reopen or focus; never restarts.
  - Store: `startPreview` sets a `starting` → `running` / `error` state and catches rejections.
  - `PreviewLightbox`: the starting, running-web, running-godot and error states render the right actions.
- **Manual check:** a real Godot 4 project under Hyprland and under GNOME/KDE (XWayland), and a real Vite project.

---

## Decisions (settled by the user on 2026-11-26)

1. **Pixel art:** use `image-rendering: pixelated` at ≥ 200 % zoom.
2. **Zoom limits:** 5 %–3200 %.
3. **Godot over the Hub:** a native window, always on top and centred over the Hub through Godot CLI flags, plus Hyprland float when available (§B.4). Web export inside the iframe is rejected because it needs a 10–60 s export on every F5, requires export templates, and some features don't work on Web.
4. **Engine detection:** `.hub/project.json` `engine` is authoritative. The file fallback applies only when the field is missing or unknown (§B.3).

Record decisions 3 and 4, together with the CSP/iframe sandbox choice (§B.6), in `docs/DECISIONS.md` during implementation.

## Suggested TDD order

1. Part A, pure maths module and its tests.
2. Part A, `ImageViewer` wiring and its tests.
3. Part B, contract: the serde test and the `PreviewStatus` change on both sides.
4. Part B, `resolve_preview_engine` and the dispatch in `cmd_preview_start`.
5. Part B, the starting/error states in the store and overlay, and the F5 behaviour.
6. Part B, the Godot window rectangle and launch flags.
7. Part B, the CSP and iframe sandbox, plus the `docs/DECISIONS.md` entry.

Each step follows the same loop: write a failing test, write the minimum code, then run the affected suite.

Validation:

- `npx vitest run`
- `npx tsc --noEmit`
- `cargo test --manifest-path src-tauri/Cargo.toml`, both without and with `--features desktop`
- clippy: no new warnings
