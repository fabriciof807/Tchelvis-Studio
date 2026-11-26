# Image Viewer Pan/Zoom + F5 Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Hub image viewer pan with the middle mouse button and zoom correctly, and make F5 detect the project engine and show the running game over the Hub.

**Architecture:** Part A moves all viewport maths into a pure TS module (`imageViewport.ts`); `ImageViewer` only wires DOM events to it. Part B makes Rust `PreviewStatus` the single wire contract, resolves the engine in a pure Rust function, injects a `PreviewLauncher` so dispatch is testable without real Godot/npm, runs the web healthcheck outside the `preview_manager` lock so Start can be cancelled and polled, and turns `PreviewLightbox` into a phase-driven overlay (starting / running-web / running-godot / error).

**Tech Stack:** React 19 + Zustand 5 + Vitest 3 (jsdom, `@testing-library/react`, `fireEvent` — no user-event dep), Rust (Tauri 2, serde), Godot 4 CLI, Vite.

**Spec:** `docs/specs/hub-image-viewer-and-preview.md` (approved 2026-11-26)

## Global Constraints

- Zoom clamp **5 %–3200 %** (`MIN_SCALE = 0.05`, `MAX_SCALE = 32`).
- Toolbar step ×1.25 / ÷1.25, anchored at stage centre. Wheel factor `2^(-deltaY × k)`, multiplicative, anchored at cursor.
- Pan keeps at least **48 px** of the image visible.
- `image-rendering: pixelated` at scale **≥ 2** (200 %).
- Label always shows the real percentage; in fit mode: `Fit · 25 %` (format `${t('media.fit')} · ${pct}%`).
- Wire `PreviewStatus` keys, exactly: `running, mode, engine, url, pid, worktree_path, compositor_available, can_capture, degraded_reason, logs` (snake_case; `port` dropped; `logs` = last 50 lines).
- `mode` means *which tree* (`main` | `staging` | `idle`), never the engine.
- Engine: `.hub/project.json` `engine` wins when it is `"godot"`/`"web"`; file fallback only when missing/unknown; conflict → warning in `degraded_reason`.
- Godot launch flags: `--windowed --resolution WxH --position X,Y --always-on-top`; preview size from `compositor.preview_width/height` (default 1280×720) scaled to fit the Hub with a 5 % margin.
- CSP diff limited to adding `http://127.0.0.1:*` to `frame-src`. Iframe: `sandbox="allow-scripts allow-same-origin allow-pointer-lock"`, `allow="fullscreen; gamepad; autoplay"`. "Open external" keeps `noopener,noreferrer`.
- F5 while running never spawns a second process.
- No unhandled promise rejections from preview actions.
- New user-facing strings in en, pt-BR and zh-CN (i18n parity test must pass).
- **Commit steps are checkpoints, not authorization.** Run them only if the user authorized commits for this execution (identity `-c user.name=fabriciof807 -c user.email=fabriciof807@users.noreply.github.com`); otherwise leave changes uncommitted. Opus review of the diff before any commit (project convention).
- Validation: `npx vitest run`, `npx tsc --noEmit`, `cargo test --manifest-path src-tauri/Cargo.toml` with and without `--features desktop`, clippy with no new warnings. Don't run `cargo fmt` on unrelated code (repo-wide fmt already fails).

## Plan decisions (not in the spec — review these)

1. **Start is non-blocking and cancellable.** `preview_start` becomes an async `on_worker` command. For web, the child is spawned under the `preview_manager` lock, the lock is released during the HTTP healthcheck, then re-taken to mark it ready. This is what makes **Cancel** (→ `preview_stop`) and the "last log line" in the starting state possible. While starting, the status is `running: false` with `pid` set; the frontend treats `running=false && pid!=null` as "starting" (no new wire field).
2. **New commands** `preview_status` (cheap read, polled every 500 ms by the overlay while starting) and `preview_focus` (Focus game). `CompositorAdapter` gains `focus_pid(pid)`; the degraded adapter returns `Err("focus not supported without Hyprland")`, which the UI shows as a non-blocking note.
3. **Failed-start logs are kept.** On healthcheck failure the manager kills the process group and keeps its log tail as `last_failure_logs`; `status()` returns them in `logs` while idle, so the error state can show the last 20 lines.
4. **Godot bar is non-modal.** In the running-godot state the overlay is a compact fixed bar (no backdrop, no `activeModalCount` increment), so the Hub stays usable around the game window. Web and starting/error states keep the modal lightbox.
5. **Hub rect is optional.** `ipc.previewStart` reads `getCurrentWindow().outerPosition()/outerSize()` (physical px) in Tauri; in the browser mock or on error it sends `null`, and the backend omits `--position`.
6. **Same tree = idempotent.** `cmd_preview_start` returns the current status without spawning when a preview for the same `(mode, worktree_path)` is starting or running; a different tree stops the old one first.
7. **`PreviewCaptureResult` TS type is fixed** to mirror Rust (`image_path: string | null`, `log_tail`, `error: string | null`), since the Godot bar's **Capture frame** depends on it.
8. **`ProjectConfig.engine` gets `#[serde(default)]`**; an empty string counts as "missing".

## Review Focus

1. **Tiny images (e.g. 16×16) with the 48 px pan margin** — the margin must be `min(48, displayed width/height)`, or a small image can't be panned at all / jitters. Test in Task 1 (`panBy keeps a 16px image reachable`).
2. **Image not yet loaded / stage size 0** (panel collapsed, ResizeObserver fires with 0×0) — fit must not produce `NaN`/`Infinity`. Test in Task 1 (`fitTransform with zero stage returns scale 1 at origin`).
3. **Trackpad bursts** (dozens of small `deltaY` per gesture, or a single `deltaMode=2` page event) — one event must never jump more than ×2. Test in Task 1 (`wheelFactor clamps a page delta`).
4. **Double F5 / F5 while starting** — must not spawn twice or reset the starting overlay. Tests in Task 4 (Rust, same pid) and Task 6 (store, `previewStart` called once).
5. **Cancel pressed during the web healthcheck** — the worker must not resurrect the cancelled preview when the healthcheck later succeeds. Test in Task 4 (`start_returns_cancelled_when_stopped_during_healthcheck`).

---

### Task 1: Pure viewport maths (`imageViewport.ts`)

**Files:**
- Create: `src/panels/imageViewport.ts`
- Test: `src/__tests__/imageViewportLogic.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface Size { w: number; h: number }
  export interface Point { x: number; y: number }
  /** x,y = image top-left in stage coords; transform = translate(x,y) scale(scale), origin 0 0. */
  export interface ViewState { scale: number; x: number; y: number; mode: 'fit' | 'free' }
  export interface ViewportBounds { stage: Size; image: Size }
  export const MIN_SCALE = 0.05, MAX_SCALE = 32, BUTTON_STEP = 1.25, PAN_MARGIN = 48;
  export function clampScale(s: number): number
  export function fitTransform(b: ViewportBounds): ViewState          // mode 'fit'
  export function zoomAt(s: ViewState, factor: number, anchor: Point, b: ViewportBounds): ViewState // mode 'free'
  export function panBy(s: ViewState, dx: number, dy: number, b: ViewportBounds): ViewState         // mode 'free'
  export function oneToOne(s: ViewState, b: ViewportBounds): ViewState // scale 1, keeps the image point at stage centre
  export function wheelFactor(deltaY: number, deltaMode: number): number
  export function isPixelated(scale: number): boolean                 // scale >= 2
  export function formatZoomLabel(s: ViewState, fitLabel: string): string // 'Fit · 25%' | '250%'
  ```

- [ ] **Step 1: Write the failing tests** (`describe('imageViewport')`):
  - `fitTransform` landscape 4000×1000 in 800×600 → `scale 0.2`, centred (`x 0`, `y 200`), `mode 'fit'`.
  - portrait 1000×4000 in 800×600 → `scale 0.15`, `x 325`, `y 0`.
  - small 32×32 in 800×600 → `scale 1` (never upscales), centred `x 384`, `y 284`.
  - zero stage `{w:0,h:0}` → finite numbers, `scale 1`, `x 0`, `y 0`.
  - `zoomAt` anchor invariance: for several states/factors/anchors, the image point under the anchor before (`(a - x)/s`) equals the one after within `0.5` px; result `mode 'free'`.
  - `zoomAt` clamps: factor 1000 → `scale 32`; factor 0.0001 → `scale 0.05`.
  - leaving fit with `+`: `zoomAt(fitTransform(b), BUTTON_STEP, stageCentre, b).scale` ≈ `0.2 × 1.25` (AC A.2).
  - `panBy` clamp: dragging far left/right/up/down leaves exactly `PAN_MARGIN` px of the image on stage; `panBy keeps a 16px image reachable` (margin becomes 16 at scale 1); pan from fit switches to `'free'`.
  - `wheelFactor(-100, 0) > 1`, `wheelFactor(100, 0) < 1`, `wheelFactor(-100,0) × wheelFactor(100,0) ≈ 1`; line mode (`deltaMode 1`, deltaY 3) equals pixel mode deltaY 120; `wheelFactor clamps a page delta`: `wheelFactor(-1, 2) <= 2` and `wheelFactor(1, 2) >= 0.5`.
  - `isPixelated(1.99) === false`, `isPixelated(2) === true`.
  - `formatZoomLabel({scale:0.25,mode:'fit'}, 'Fit') === 'Fit · 25%'`, `({scale:2.5,mode:'free'}) === '250%'`.

- [ ] **Step 2: Run** `npx vitest run src/__tests__/imageViewportLogic.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/panels/imageViewport.ts`.** Constants: `WHEEL_K = 0.0025` (100 px notch ≈ ×1.19), line = 40 px, page = 800 px; per-event factor clamped to `[0.5, 2]`. Fit: `min(stage.w/img.w, stage.h/img.h, 1)`, guard zero/NaN sizes → scale 1 at origin. `zoomAt`: `p = (anchor - pos)/s`; `s' = clampScale(s×factor)`; `pos' = anchor - p×s'`; then apply pan clamp. Pan clamp: `m = min(PAN_MARGIN, img.w×s, img.h×s)` per axis; `x ∈ [m - img.w×s, stage.w - m]`, same for y.

- [ ] **Step 4: Run** the same command — Expected: PASS.

- [ ] **Step 5: Commit** `git add src/panels/imageViewport.ts src/__tests__/imageViewportLogic.test.ts && git commit -m "Add pure image viewport maths (fit, cursor zoom, clamped pan)"`

### Task 2: `ImageViewer` wiring (pan, wheel, resize, toolbar)

**Files:**
- Modify: `src/panels/MediaViewerPanel.tsx:130-258` (export `ImageViewer`; replace `zoom` state)
- Modify: `src/index.css:1972-2005` (`.media-image-stage`, `.media-image-fit`, `.media-image-scaled`)
- Test: `src/__tests__/imageViewer.test.tsx`

**Interfaces:**
- Consumes: everything from Task 1.
- Produces: `export const ImageViewer: React.FC<{ relPath: string }>` (exported for tests only).

- [ ] **Step 1: Write the failing tests.** Setup: `vi.spyOn(ipc, 'readBinaryFile').mockResolvedValue(<1×1 PNG base64>)`; stub `URL.createObjectURL`; stub `ResizeObserver` (class capturing the callback so the test can fire it); define `PointerEvent` as a `MouseEvent` subclass if jsdom lacks it; stub `Element.prototype.setPointerCapture/releasePointerCapture`; give the stage `clientWidth/clientHeight` 800×600 via `Object.defineProperty`; fire `load` on the `<img>` after defining `naturalWidth 4000 / naturalHeight 1000`. Tests:
  - `middle-button drag changes the transform`: `pointerDown {button:1, clientX:100, clientY:100}`, `pointerMove {clientX:150, clientY:120}`, `pointerUp` → img `style.transform` changes and contains `translate(`; stage has class `is-panning` during the drag only.
  - `left-button drag does nothing`: same sequence with `button:0` → transform unchanged.
  - `wheel calls preventDefault`: dispatch `new WheelEvent('wheel', {deltaY:-100, cancelable:true})` on the stage → `defaultPrevented === true` and the label changes from `Fit · 20%`.
  - `middle mousedown default is prevented`: `mouseDown {button:1}` event → `defaultPrevented`; `auxclick {button:1}` → `defaultPrevented`.
  - `+ from fit gives 1.25 × fit`: click the zoom-in button → label `25%`.
  - `resize re-fits only in fit mode`: fire the RO callback with 400×300 → label `Fit · 10%`; after a wheel zoom, firing RO again leaves the label unchanged.
  - `new file resets to fit`: rerender with another `relPath` → label starts with `Fit`.
  - `pixelated at 200%`: after `1:1` then zoom to ≥ 2 → img has class `media-image-pixelated`.

- [ ] **Step 2: Run** `npx vitest run src/__tests__/imageViewer.test.tsx` — Expected: FAIL (`ImageViewer` not exported).

- [ ] **Step 3: Implement.** State `view: ViewState | null` + `stageSize` + `naturalSize`; `stageRef`. Native `wheel` listener added in `useEffect` with `{ passive: false }` (`preventDefault`, anchor = `clientX/Y − stage rect`). `onPointerDown` with `button === 1` → `setPointerCapture`, store last point; `onPointerMove` while panning → `panBy`; `onPointerUp`/`onPointerCancel` end it. `onMouseDown`/`onAuxClick` with `button === 1` → `preventDefault`. `ResizeObserver` updates `stageSize` and re-fits only when `view.mode === 'fit'`. Image style: `transform: translate(${x}px, ${y}px) scale(${scale})`, `transform-origin: 0 0`, `position: absolute; left:0; top:0`, `max-width: none`. CSS: stage `position: relative; overflow: hidden; padding: 0`, `.is-panning { cursor: grabbing }`, `.media-image-pixelated { image-rendering: pixelated }`; drop the `transition` (it lags the cursor anchor) and `.media-image-fit`. Toolbar: −/+ → `zoomAt(view, 1/BUTTON_STEP | BUTTON_STEP, stageCentre, b)`; Fit → `fitTransform`; `1:1` → `oneToOne`; label → `formatZoomLabel`.

- [ ] **Step 4: Run** `npx vitest run src/__tests__/imageViewer.test.tsx src/__tests__/imageViewportLogic.test.ts && npx tsc --noEmit` — Expected: PASS, no type errors, no "passive" warning in test output.

- [ ] **Step 5: Commit** `git commit -m "Image viewer: middle-mouse pan, cursor-anchored zoom, real fit scale"` (add the three files).

### Task 3: `PreviewStatus` contract on both sides

**Files:**
- Modify: `src-tauri/src/types.rs:327-335` (`PreviewStatus`), add `PreviewEngine`
- Modify: `src-tauri/src/preview.rs:86-128` (`ActivePreview`, `PreviewManager::status`)
- Modify: `src/types/ipc.ts:282-298` (`PreviewStatus`, `PreviewCaptureResult`), `:976-1012` (mock)
- Test: `src-tauri/src/preview.rs` tests; `src/__tests__/previewContract.test.ts`

**Interfaces:**
- Produces (Rust, `types.rs`):
  ```rust
  #[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
  #[serde(rename_all = "lowercase")]
  pub enum PreviewEngine { Godot, Web }
  pub struct PreviewStatus {
      pub running: bool, pub mode: String, pub engine: Option<PreviewEngine>,
      pub url: Option<String>, pub pid: Option<u32>, pub worktree_path: Option<String>,
      pub compositor_available: bool, pub can_capture: bool,
      pub degraded_reason: Option<String>, pub logs: Vec<String>,
  }
  ```
  `ActivePreview` gains `engine: PreviewEngine`, `tree: String` (`"main"|"staging"`), `worktree_path: Option<String>`, `ready: bool`, `warning: Option<String>`; `PreviewManager` gains `last_failure_logs: Vec<String>`.
- Produces (TS): `PreviewStatus` with exactly those keys (`engine: 'web' | 'godot' | null`, `mode: 'main' | 'staging' | 'idle'`); `PreviewCaptureResult { image_path: string | null; log_tail: string[]; error: string | null }`; `export const PREVIEW_STATUS_KEYS = [...] as const` and `export function mockPreviewStatus(over: Partial<PreviewStatus>): PreviewStatus` used by the mock.

- [ ] **Step 1: Write the failing tests.**
  - Rust `preview_status_serializes_exact_keys`: serialize an idle and a running `PreviewStatus`; collect object keys sorted; assert equal to `["can_capture","compositor_available","degraded_reason","engine","logs","mode","pid","running","url","worktree_path"]`; assert `engine` serializes as `"godot"`.
  - Rust `idle_status_reports_compositor_and_failure_logs`: `PreviewManager::new().status(&DegradedCompositorAdapter{..})` → `running false`, `mode "idle"`, `engine None`, `compositor_available false`, `can_capture false`, `logs` empty.
  - TS `previewContract.test.ts`: `Object.keys(mockPreviewStatus({})).sort()` equals `[...PREVIEW_STATUS_KEYS].sort()` and equals the same literal list as the Rust test; a compile-time check `const _k: Record<keyof PreviewStatus, true> = {running:true, …}` (fails `tsc` if keys drift).

- [ ] **Step 2: Run** `cargo test --manifest-path src-tauri/Cargo.toml preview` and `npx vitest run src/__tests__/previewContract.test.ts` — Expected: FAIL (fields missing).

- [ ] **Step 3: Implement.** `status()`: `running = active && ready`; `mode = tree` or `"idle"`; `compositor_available = compositor.backend_name() != "degraded"`; `can_capture = running && compositor_available`; `logs` = last 50 of `log_tail` (active) or `last_failure_logs` (idle); `degraded_reason` = join of `warning` and `compositor.degraded_reason()` with `"; "`. Existing `start_web`/`start_godot` set `ready: true` for now (Task 4 changes web). Update the TS mock to build through `mockPreviewStatus`. Fix all TS readers of `status.engine`/`logs` so `tsc` passes.

- [ ] **Step 4: Run** both commands plus `npx tsc --noEmit` — Expected: PASS.

- [ ] **Step 5: Commit** `git commit -m "Make Rust PreviewStatus the single preview IPC contract"`.

### Task 4: Engine resolution, injected launcher, non-blocking start, idempotent dispatch

**Files:**
- Modify: `src-tauri/src/preview.rs` (resolution fn, `PreviewLauncher`, split start)
- Modify: `src-tauri/src/types.rs:107-112` (`#[serde(default)] engine`)
- Modify: `src-tauri/src/lib.rs:95-110` (`AppState::project_engine()`), `:438-480` (`cmd_preview_start`), `:483-500` (+ `cmd_preview_status`), `:934-950` + handler list `:1276` (async `preview_start`, `preview_status`)
- Modify: `src/types/ipc.ts` (`previewStatus()`)
- Test: `src-tauri/src/preview.rs` tests, `src-tauri/src/lib.rs` tests

**Interfaces:**
- Consumes: `PreviewEngine`, `PreviewStatus` (Task 3).
- Produces (Rust):
  ```rust
  pub struct EngineResolution { pub engine: PreviewEngine, pub warning: Option<String> }
  pub fn resolve_preview_engine(config_engine: Option<&str>, game_dir: &Path) -> Result<EngineResolution, String>
  pub struct LaunchSpec { pub engine: PreviewEngine, pub project_dir: PathBuf, pub args: Vec<String> }
  pub trait PreviewLauncher: Send + Sync {
      fn spawn(&self, spec: &LaunchSpec) -> Result<std::process::Child, String>;
      fn wait_ready(&self, port: u16, timeout: Duration) -> Result<(), String>;
  }
  pub struct SystemPreviewLauncher;            // npm/godot lookup, setsid, piped stdio, wait_for_http_ok
  pub fn web_args(port: u16) -> Vec<String>    // ["run","dev","--","--port",P,"--strictPort"]
  impl PreviewManager {
      pub fn is_active_for(&self, tree: &str, worktree: Option<&str>) -> bool;
      pub fn begin(&mut self, launcher: &dyn PreviewLauncher, spec: LaunchSpec, tree: &str,
                   worktree: Option<&str>, port: Option<u16>, warning: Option<String>) -> Result<u32, String>; // pid; ready = engine==Godot
      pub fn mark_ready(&mut self, pid: u32) -> bool;          // false if pid no longer active (cancelled)
      pub fn fail(&mut self, pid: u32);                         // kill group, keep logs in last_failure_logs
  }
  ```
  `AppState` gains `pub preview_launcher: Box<dyn PreviewLauncher>` (default `SystemPreviewLauncher`). `pub fn cmd_preview_start(state, mode: String, worktree_path: Option<String>, hub_rect: Option<HubWindowRect>) -> Result<PreviewStatus, String>` (`hub_rect` used in Task 5; pass through as unused `_hub_rect` here). `pub fn cmd_preview_status(state) -> Result<PreviewStatus, String>`.
- Produces (TS): `ipc.previewStatus(): Promise<PreviewStatus>`.

- [ ] **Step 1: Write the failing Rust tests.**
  - `resolve_preview_engine`: `config_wins` (`Some("web")` + `project.godot` present → Web with warning containing `project.godot`); `godot_file_fallback` (`None`, `project.godot` → Godot, no warning); `web_file_fallback` (`Some("")`/`Some("unity")` + `package.json` `{"scripts":{"dev":"vite"}}` → Web); `package_json_without_dev_is_not_web` → Err; `neither_found` → Err naming both `project.godot` and `package.json`.
  - lib.rs, with a `FakeLauncher` (records `LaunchSpec`s in a `Mutex<Vec<_>>`, spawns `sleep 30`, `wait_ready` returns a configured result or blocks on a channel):
    - `preview_start_main_dispatches_on_resolved_engine`: workspace with `.hub/project.json` `engine:"godot"` and `game/` → spec engine Godot, `project_dir` = `<ws>/game`, status `mode "main"`, `running true`. Repeat with `engine:"web"` → Web spec with `--strictPort`.
    - `second_start_same_tree_keeps_pid`: start twice → one recorded spawn, same `pid`.
    - `unknown_mode_is_rejected`: `mode "web"` → Err `"unsupported preview mode: web"`.
    - `start_returns_cancelled_when_stopped_during_healthcheck`: `wait_ready` blocks; another thread calls `cmd_preview_stop` (must not wait on the healthcheck: returns within 1 s); then release `wait_ready` with Ok → `cmd_preview_start` returns Err `"preview start cancelled"`, status idle.
    - `failed_healthcheck_keeps_logs`: `wait_ready` → Err("healthcheck timed out") → command Err contains it; `cmd_preview_status` → idle, `logs` non-empty (fake child: `sh -c 'echo boot; sleep 30'`).
    - `status_while_starting_has_pid_not_running`: during a blocked `wait_ready`, `cmd_preview_status` → `running false`, `pid Some`, `engine Some(Web)`.

- [ ] **Step 2: Run** `cargo test --manifest-path src-tauri/Cargo.toml preview` — Expected: FAIL (items not defined).

- [ ] **Step 3: Implement.** `cmd_preview_start`: validate `mode ∈ {main, staging}`; `staging` requires `worktree_path`; lock pm → if `is_active_for` return status; else `stop()`, resolve engine on `base.join(game_dir)` using `state.project_engine()` (`Option<String>` from `project_config`); Godot path keeps the existing worktree `.godot/imported` sync; build `LaunchSpec`; `begin(...)`; for Web drop the lock, `launcher.wait_ready(port, timeout)`, re-lock, `fail(pid)` on Err, else `mark_ready(pid)` or return `"preview start cancelled"`. Move spawn code from `start_web`/`start_godot` into `SystemPreviewLauncher::spawn` (delete the old methods). Desktop command: `pub async fn preview_start(app, mode, worktree_path, hub_rect: Option<HubWindowRect>)` via `on_worker`; `preview_status` sync is fine (no waiting).

- [ ] **Step 4: Run** `cargo test --manifest-path src-tauri/Cargo.toml` and `cargo test --manifest-path src-tauri/Cargo.toml --features desktop` — Expected: PASS.

- [ ] **Step 5: Commit** `git commit -m "Preview: resolve engine on the backend, cancellable start, idempotent F5"`.

### Task 5: Godot window over the Hub + focus

**Files:**
- Modify: `src-tauri/src/preview.rs` (rect maths, `godot_args`, placement warning)
- Modify: `src-tauri/src/compositor.rs:112-118` (+ `focus_pid`), Hyprland and degraded impls
- Modify: `src-tauri/src/types.rs` (`HubWindowRect`)
- Modify: `src-tauri/src/lib.rs` (`cmd_preview_focus`, `preview_focus` command, use `hub_rect`)
- Modify: `src/types/ipc.ts` (`HubWindowRect`, `previewStart` reads the window rect, `previewFocus()`)
- Test: `src-tauri/src/preview.rs` tests

**Interfaces:**
- Produces (Rust):
  ```rust
  #[derive(Deserialize, Serialize, Debug, Clone, Copy, PartialEq, Eq)]
  pub struct HubWindowRect { pub x: i32, pub y: i32, pub width: u32, pub height: u32 }
  #[derive(Debug, Clone, Copy, PartialEq, Eq)]
  pub struct WindowRect { pub x: i32, pub y: i32, pub width: u32, pub height: u32 }
  pub fn godot_window_rect(hub: Option<HubWindowRect>, preview_w: u32, preview_h: u32) -> WindowRect
  pub fn godot_args(project_dir: &Path, rect: WindowRect, with_position: bool) -> Vec<String>
  pub fn placement_warning(session_type: Option<&str>, compositor_backend: &str) -> Option<String>
  // CompositorAdapter: fn focus_pid(&self, pid: u32) -> Result<(), String>;
  pub fn cmd_preview_focus(state: &AppState) -> Result<(), String>
  ```
- Produces (TS): `ipc.previewStart(mode, worktreePath?)` (signature unchanged; internally sends `hubRect`), `ipc.previewFocus(): Promise<void>`.

- [ ] **Step 1: Write the failing tests.**
  - `rect_centres_preview_in_large_hub`: hub `{x:100,y:50,w:1920,h:1080}`, 1280×720 → `{w:1280,h:720,x:420,y:230}`.
  - `rect_scales_down_in_small_hub`: hub `{0,0,1000,700}` → fits in 900×630 keeping 16:9 → `{w:900,h:506}` (round), centred.
  - `rect_without_hub_uses_configured_size`: `None` → `{w:1280,h:720,x:0,y:0}`.
  - `godot_args_order`: `["--path", dir, "--windowed", "--resolution", "1280x720", "--position", "420,230", "--always-on-top"]`; with `with_position false` no `--position` pair.
  - `placement_warning`: `(Some("wayland"), "degraded")` → `Some(..)` mentioning position may be ignored; `(Some("wayland"), "hyprland")` → `None`; `(Some("x11"), _)` → `None`.
  - lib: `godot_start_passes_rect_args` with FakeLauncher and a hub rect → recorded args contain `--position` and `--always-on-top`.

- [ ] **Step 2: Run** `cargo test --manifest-path src-tauri/Cargo.toml preview` — Expected: FAIL.

- [ ] **Step 3: Implement.** Margin: available = `hub × 0.9`; `scale = min(1, avail_w/pw, avail_h/ph)`. Session type from `std::env::var("XDG_SESSION_TYPE")` read in `cmd_preview_start` (not in the pure fn). After `begin` for Godot, still call `compositor.float_and_center_pid(pid, w, h)`. Hyprland `focus_pid`: `hyprctl dispatch focuswindow pid:<pid>`. TS: in Tauri, `const win = getCurrentWindow(); const [p, s] = await Promise.all([win.outerPosition(), win.outerSize()])`, catch → `null`.

- [ ] **Step 4: Run** cargo tests (both feature sets) and `npx tsc --noEmit` — Expected: PASS.

- [ ] **Step 5: Commit** `git commit -m "Preview: place Godot centred over the Hub, always on top; add focus"`.

### Task 6: Store phases, overlay states, F5

**Files:**
- Modify: `src/store/workspaceStore.ts:71-72,137-140,232-233,293-294,344-345,794-816`
- Modify: `src/App.tsx:40-49` (F5 → `handlePreviewHotkey`)
- Modify: `src/panels/PreviewLightbox.tsx` (phase-driven)
- Modify: `src/i18n/index.ts` (`preview.*` keys, 3 locales)
- Modify: `src/index.css` (godot bar, starting spinner, error log)
- Test: `src/__tests__/previewStore.test.ts`, `src/__tests__/previewLightbox.test.tsx`

**Interfaces:**
- Consumes: `ipc.previewStart/previewStatus/previewStop/previewFocus/previewCapture` (Tasks 3–5).
- Produces (store):
  ```ts
  previewPhase: 'idle' | 'starting' | 'running' | 'error';
  previewError: string | null;
  startPreview(mode: 'main' | 'staging', worktreePath?: string): Promise<void>; // never rejects
  cancelPreviewStart(): Promise<void>;
  refreshPreviewStatus(): Promise<void>;
  focusPreview(): Promise<void>;
  handlePreviewHotkey(): void;
  ```
  i18n keys: `preview.starting` ("Starting preview…"), `preview.startingEngine` ("Starting {engine} preview…"), `preview.cancel`, `preview.focusGame` ("Focus game"), `preview.retry`, `preview.errorTitle` ("Preview failed to start"), `preview.engineBar` ("{engine} · PID {pid}"), `preview.focusUnsupported`.

- [ ] **Step 1: Write the failing store tests** (`ipc` spies, no real timers):
  - `startPreview` sets `previewPhase 'starting'` and `previewLightboxOpen true` synchronously, then `'running'` with `previewStatus` on resolve.
  - rejection → `'error'`, `previewError` = message, `previewStatus.logs` from a follow-up `previewStatus()`; the returned promise resolves (no rejection).
  - `handlePreviewHotkey`: idle → `previewStart` called once with `'main'`; called again while `'starting'` → no second call; running web → only opens the lightbox; running godot → calls `previewFocus`, never `previewStart`.
  - `cancelPreviewStart` → calls `previewStop`, phase `'idle'`, overlay closed; a later `previewStart` resolution/rejection for the cancelled attempt doesn't change state (generation counter).
  - `stopPreview` → phase `'idle'`.

- [ ] **Step 2: Write the failing overlay tests** (`previewLightbox.test.tsx`, set store state directly):
  - starting: spinner, `Starting godot preview…` when `previewStatus.engine` is known else `Starting preview…`, last log line, **Cancel** button; no iframe.
  - running web: iframe with `src` = url, `sandbox="allow-scripts allow-same-origin allow-pointer-lock"`, `allow="fullscreen; gamepad; autoplay"`; Capture/Stop/Close present.
  - running godot: no backdrop (`.lightbox-backdrop` absent), bar text contains `godot` and the pid, buttons Focus game / Capture frame / Stop; `activeModalCount` stays 0.
  - error: message + at most 20 log lines (given 30), **Retry** (calls `startPreview('main')`) and **Close**.
  - `Esc` closes the overlay without calling `previewStop`.
  - while starting, the overlay polls `refreshPreviewStatus` every 500 ms (`vi.useFakeTimers()`), and stops polling on unmount.

- [ ] **Step 3: Run** `npx vitest run src/__tests__/previewStore.test.ts src/__tests__/previewLightbox.test.tsx` — Expected: FAIL.

- [ ] **Step 4: Implement** store actions (generation counter `previewStartGeneration` module-level like `modelCatalogRequest`), F5 in `App.tsx` calls `useWorkspaceStore.getState().handlePreviewHotkey()`, the overlay per phase, i18n keys in all three locales, CSS. Remove the old 16:9 placeholder that read `previewStatus.logs.length` unguarded.

- [ ] **Step 5: Run** `npx vitest run && npx tsc --noEmit` — Expected: PASS (incl. i18n parity).

- [ ] **Step 6: Commit** `git commit -m "Preview overlay: starting/running/error states and non-restarting F5"`.

### Task 7: CSP, iframe sandbox, decisions log

**Files:**
- Modify: `src-tauri/tauri.conf.json:27`
- Modify: `docs/DECISIONS.md`
- Test: `src/__tests__/previewCsp.test.ts`

- [ ] **Step 1: Write the failing test:** read `src-tauri/tauri.conf.json` with `fs`, extract `app.security.csp`, assert its `frame-src` directive equals `frame-src 'self' blob: data: http://127.0.0.1:*` and that the CSP contains no `localhost` in `frame-src`; assert the rest of the CSP string equals the current value (pin it, so the diff stays minimal).
- [ ] **Step 2: Run** `npx vitest run src/__tests__/previewCsp.test.ts` — Expected: FAIL.
- [ ] **Step 3: Edit the CSP** (only that directive) and add three dated entries (2026-11-26) to `docs/DECISIONS.md`: Godot native window centred + always-on-top (decision 3), engine detection authority (decision 4), CSP `frame-src http://127.0.0.1:*` + iframe sandbox with `allow-same-origin` safe because the origin differs from the Hub's and can't reach Tauri IPC. Check existing entries first to avoid duplicates.
- [ ] **Step 4: Run the full validation** — `npx vitest run`, `npx tsc --noEmit`, `cargo test --manifest-path src-tauri/Cargo.toml`, `cargo test --manifest-path src-tauri/Cargo.toml --features desktop`, `cargo clippy --manifest-path src-tauri/Cargo.toml --features desktop` (no new warnings vs. the 7 known). Expected: all PASS.
- [ ] **Step 5: Commit** `git commit -m "Allow loopback preview iframe in CSP; record preview decisions"`.
- [ ] **Step 6: Manual checks (user, Tauri build):** large photo, 32×32 sprite, trackpad; real Godot 4 project under Hyprland and under GNOME/KDE (XWayland); real Vite project; Cancel during start; F5 twice.
