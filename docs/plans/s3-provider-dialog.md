# S3 — Provider Connection Dialog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the inline auto-opening `PiSetupWizard` card with an app-level "Connect an AI provider" modal that has one primary action per state, a searchable provider list, guarded Disconnect, OAuth auto-poll, and a default-model picker decoupled from credential editing.

**Architecture:** Backend gains `pi_connect_provider` (save key + `pi auth check`, restore on `invalid`), stops taking the adapter lock in configure (lazy upgrade at send), and redacts keys in `Debug`. Frontend splits into pure modules (`providerDialogLogic.ts`, `signInPoller.ts`), a store slice (`providerDialog`, `providerSignIn`, connect/disconnect/default flows), a reusable `ModalDialog` primitive, and the `ProviderDialog` UI rendered once in `App.tsx`. The API key lives only in `ProviderDialog`'s React state.

**Tech Stack:** React 19, Zustand 5, Vitest 3 (jsdom, `@testing-library/react` with `fireEvent` — no user-event dep, matching `modelPicker.test.tsx`), Rust (Tauri 2, serde), pi CLI.

**Spec:** `docs/specs/s3-provider-dialog.md` (approved 2026-11-26; decisions §8 are binding). Parent: `docs/specs/chat-ux-redesign.md`.

## Global Constraints

- Dialog: `width: min(520px, 100vw - 32px)`, `max-height: 85vh`, fixed header/footer, scrolling body; provider list capped ≈ 220 px; backdrop = `.lightbox-backdrop`; **backdrop click never closes**; existing dark tokens only (`--hub-surface`, `--hub-border`, `--hub-bg-elevated`).
- **Exactly one primary** in the dialog in every state (AC10). One shared constant `PRIMARY_CLASS` (e.g. `'btn-primary-xs'`), with the danger variant `'btn-danger-xs'`; the AC10 test counts both.
- ✕ and `Esc` always close (decision 2), except **no-op while busy** (connecting, disconnecting, Done saving). `Esc` closes innermost first: picker → S-CONFIRM → dialog.
- **No auto-open** anywhere (S3-1). Only openers: chat CTA, header pill, Settings "Manage providers…", send-while-not-connected, sign-in success while hidden.
- Sign-in hides the dialog (decision 1); poll every **3000 ms**, first check after 3 s, timeout **120000 ms** by injected clock, stop after **3** consecutive rejections, never overlapping.
- First successful Connect writes the default **only** when there's no usable default (decision 4): `!provider_ready || !first_run_completed || active_provider not connected`.
- Key field: `type="password"`, `autoComplete="off"`, `spellCheck={false}`, `autoCapitalize="off"`, placeholder `providerDialog.keyPlaceholder` only; env var only in `envHelper`, linked via `aria-describedby`.
- **Secrets:** key never in Zustand, `localStorage`, `console.*`, any `Err`/`check_error` string, any `Debug` output, any returned DTO. Tests use fake keys `sk-test-…` and temp dirs, never `~/.pi`.
- `pi auth check` always `--no-refresh --json`, never `--credentials`, 5 s timeout. No online key validation (decision 3).
- Slug regex `^[a-z0-9-]{1,64}$` (mirrors `validate_provider_slug`).
- All copy from spec §3.6 tables, verbatim, in en / pt-BR / zh-CN. No "Pi Durable" in any user-facing string. Removed keys listed in §3.6 are deleted from all three locales.
- Don't migrate `SettingsModal` to `ModalDialog`; don't touch S4/S6/S8 items (§1.2).
- Validation: `npx vitest run`, `npx tsc --noEmit`, `cargo test --manifest-path src-tauri/Cargo.toml` with and without `--features desktop`, clippy no new warnings (7 pre-existing), no repo-wide `cargo fmt`.
- Git identity for commits: `-c user.name=fabriciof807 -c user.email=fabriciof807@users.noreply.github.com`.
- **Commit steps are checkpoints, not authorization.** Run them only if the user authorized commits for this execution; otherwise leave changes uncommitted and continue. Opus review of the diff before any commit (project convention).

## Plan decisions (not in the spec — review these)

1. **Injectable pi dirs.** To test configure/connect at the `lib.rs` level without touching `~/.pi`, add `sidecar::PiDirs { agent_dir, hub_config_dir }` and `AppState.pi_dirs: Option<PiDirs>` (`None` = defaults via `default_pi_agent_dir()`/`config_dir()`). All `cmd_pi_*` setup commands call the `_in` functions through `state_pi_dirs(state)`. The convenience wrappers in `pi_setup.rs` stay for other callers.
2. **Key state lives in `ProviderDialog`** (container), not in a child panel, because the footer's **Done** must run Connect when a key is typed (§3.4 footer rule 1). Still component-local, so the secrets rule holds.
3. **Panel state = pure function of inputs.** `derivePanelState` takes status + local `intent` + store `providerSignIn` + local `busy`; S-ERROR is not a state but an `error` string shown on top of the current state (the spec defines S-ERROR as "previous state + inline error", same primary).
4. **One sign-in poller at module level in the store** (like `modelCatalogRequest`), with real `setTimeout`/`Date.now` injected at that call site; tests use `vi.useFakeTimers()`.
5. **`ModalDialog` sets `inert` on `#root`** while mounted (the portal lives on `document.body`, outside `#root`), plus the `focusin` trap as fallback.
6. **Tests use `fireEvent`**, not `userEvent.keyboard` (AC24 wording); adding `@testing-library/user-event` is not needed.

## Review Focus

1. **Typing a key then pressing Done** (no Connect click) — Done must Connect first and stay open on failure, keeping the key. Test in Task 10 (`done with an unsaved key connects first and stays open on invalid`).
2. **Workspace switch while the sign-in poll is running hidden** — the poll must stop and no late result may reopen the dialog. Test in Task 7 (`openWorkspace stops a hidden sign-in poll and ignores its late result`).
3. **Disconnecting the default provider when the catalog fetch fails** — fallback must still pick a connected provider with `model: null` rather than crash or write a mismatched pair. Test in Task 5 (`pickFallbackDefault with null catalog`) and Task 7 (`disconnect default with failing catalog writes fallback with null model`).
4. **Custom slug typed that equals a curated id or is invalid** — must select the curated row / disable Connect, and never send an invalid slug. Test in Task 10 (`custom slug equal to curated id selects the curated row`).
5. **Double-click on Connect / Done** — exactly one IPC call. Test in Task 10 (`double click on connect makes one ipc call`).

---

### Task 1: Rust — redacted `Debug` and no mismatched default pair

**Files:**
- Modify: `src-tauri/src/types.rs:535-543` (`PiConfigureProviderRequest`: drop derived `Debug`, add manual impl)
- Modify: `src-tauri/src/sidecar/pi_setup.rs:707-788` (`configure_pi_provider_in`)
- Test: `src-tauri/src/sidecar/pi_setup.rs` tests

**Interfaces:**
- Produces: `impl fmt::Debug for PiConfigureProviderRequest` printing `api_key: Some("<redacted>")` / `None`.

- [ ] **Step 1: Write the failing tests.**
  - `configure_request_debug_redacts_key`: `format!("{:?}", PiConfigureProviderRequest{provider:"x".into(), api_key:Some("sk-test-secret".into()), ..Default::default()})` does not contain `sk-test-secret` and contains `<redacted>`.
  - `configure_other_provider_without_model_clears_default_model` (S3-8): settings `{"defaultProvider":"a","defaultModel":"m1"}`; configure `{provider:"b", model:None}` → `settings.json` has `defaultProvider "b"` and no `defaultModel`.
  - `configure_same_provider_without_model_keeps_default_model`: same start, provider `"a"` → `defaultModel "m1"` kept.
- [ ] **Step 2: Run** `cargo test --manifest-path src-tauri/Cargo.toml pi_setup` — Expected: FAIL.
- [ ] **Step 3: Implement** the manual `Debug`; in `configure_pi_provider_in`, read the previous `defaultProvider` before inserting and `settings_map.remove("defaultModel")` when the trimmed model is `None` and the provider changed.
- [ ] **Step 4: Run** the same — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "pi setup: redact key in Debug, clear defaultModel on provider change"`.

### Task 2: Rust — `connect_pi_provider_in`

**Files:**
- Modify: `src-tauri/src/types.rs` (new DTOs after `PiAuthCheckResult`)
- Modify: `src-tauri/src/sidecar/pi_setup.rs` (new fn + wrapper), `src-tauri/src/sidecar/mod.rs` (re-export)
- Test: `src-tauri/src/sidecar/pi_setup.rs` tests

**Interfaces:**
- Produces:
  ```rust
  #[derive(Deserialize, Clone)]           // no Serialize; manual Debug redacts api_key
  pub struct PiConnectProviderRequest { pub provider: String, pub api_key: String }
  #[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
  pub struct PiConnectResult { pub status: PiSetupStatus, pub check: Option<PiAuthCheckResult>, pub check_error: Option<String> }
  pub fn connect_pi_provider_in(pi_bin: Option<&Path>, pi_agent_dir: &Path, hub_config_dir: &Path,
                                req: &PiConnectProviderRequest) -> Result<PiConnectResult, String>
  pub fn connect_pi_provider(bin_name: &str, req: &PiConnectProviderRequest) -> Result<PiConnectResult, String>
  ```

- [ ] **Step 1: Write the failing tests** (S3-6, S3-7). Helper `fake_pi(dir, status_json)` writes an executable script that appends `"$@"` to `<dir>/argv.log` and prints the given JSON line.
  - `connect_writes_key_0600_and_checks_with_safe_flags`: fake answers `{"status":"ready","provider":"opencode-go","authType":"api_key"}` → `auth.json` mode `0o600` containing the key under `opencode-go`; `argv.log` == `auth check --provider opencode-go --no-refresh --json`, no `--credentials`; result `check.status "ready"`, `check_error None`.
  - `connect_invalid_restores_previous_entry`: `auth.json` pre-seeded with `{"opencode-go":{"type":"api_key","key":"sk-test-old"}}`; fake answers `invalid` → entry equals the previous `serde_json::Value`; result `check.status "invalid"`.
  - `connect_invalid_without_previous_removes_entry`.
  - `connect_garbage_check_keeps_key_and_reports_check_error`: fake prints `nope` → key kept, `check None`, `check_error Some(_)`.
  - `connect_without_pi_saves_key_unchecked`: `pi_bin None` → key saved, `check None`, `check_error None`.
  - `connect_does_not_touch_settings_or_setup_record`: `settings.json` and `pi_setup.json` bytes unchanged.
  - `connect_rejects_empty_key_and_bad_slug`: `"   "` → Err `"api key is empty"`; slug `"Bad Slug"` → Err.
  - `connect_never_leaks_key`: for each case above, the key (`sk-test-new-…`) is absent from every `Err` string, `check_error`, `serde_json::to_string(&result)` and `format!("{:?}", req)`.
- [ ] **Step 2: Run** `cargo test --manifest-path src-tauri/Cargo.toml connect_` — Expected: FAIL.
- [ ] **Step 3: Implement** per spec §5.1 (validate → read `auth.json` → remember previous entry in memory → insert → `write_json_atomic(…, 0o600)` → if `pi_bin` is Some, `check_pi_provider_auth`; on `invalid` restore/remove atomically; on check `Err` keep key and sanitize the message (generic text, raw stderr to `eprintln!` only) → `get_pi_setup_status_in`).
- [ ] **Step 4: Run** the same — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Add connect_pi_provider: save key, pi auth check, restore on invalid"`.

### Task 3: Rust — command wiring, no lock in configure, lazy upgrade at send

**Files:**
- Modify: `src-tauri/src/sidecar/mod.rs` (`PiDirs`)
- Modify: `src-tauri/src/lib.rs:36-84` (`AppState.pi_dirs`), `:296-350` (`cmd_pi_*`), `:803-855` (desktop commands), handler list (`pi_connect_provider`)
- Test: `src-tauri/src/lib.rs` tests

**Interfaces:**
- Consumes: `connect_pi_provider_in` (Task 2).
- Produces:
  ```rust
  pub struct PiDirs { pub agent_dir: PathBuf, pub hub_config_dir: PathBuf }   // sidecar
  pub fn cmd_pi_connect_provider(state: &AppState, req: PiConnectProviderRequest) -> Result<PiConnectResult, String>
  // desktop: pub async fn pi_connect_provider(app, req) via on_worker
  ```
  `cmd_pi_configure_provider` no longer touches `pi_adapter`. `cmd_pi_send_message` upgrades an offline adapter to `create_pi_adapter(&bin_name, &state.pi_cancel)` under the lock it already holds, when `resolve_pi_binary(&bin_name)` is Some.

- [ ] **Step 1: Write the failing tests** (S3-5), pattern of `open_workspace_does_not_wait_behind_a_running_pi_turn` (`lib.rs:1335`), with `state.pi_dirs = Some(PiDirs{…temp…})`:
  - `configure_does_not_wait_behind_a_running_turn`: a scoped thread holds `state.pi_adapter.lock()` until signalled; another thread runs `cmd_pi_configure_provider` and sends its result on a channel; `recv_timeout(1s)` must be `Ok(Ok(_))`; then release.
  - `send_upgrades_offline_adapter_lazily`: adapter set to the offline adapter; `global_config.sidecar.dpi_backend_bin` points at a fake pi script; after `cmd_pi_send_message`, `state.pi_adapter.lock().unwrap().mode() != "offline"`.
  - `connect_command_uses_injected_dirs`: `cmd_pi_connect_provider` writes into the temp `agent_dir`, not `$HOME`.
- [ ] **Step 2: Run** `cargo test --manifest-path src-tauri/Cargo.toml configure_does_not_wait send_upgrades connect_command` — Expected: FAIL (the first one times out on the 1 s channel, not a hang).
- [ ] **Step 3: Implement** `state_pi_dirs(state) -> Result<PiDirs, String>`; route status/check/configure/logout/list/connect through the `_in` fns; remove the lock block from configure; add the upgrade to send; register `pi_connect_provider`.
- [ ] **Step 4: Run** `cargo test --manifest-path src-tauri/Cargo.toml` and with `--features desktop` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "pi: configure never waits behind a turn; register pi_connect_provider"`.

### Task 4: TS IPC — `piConnectProvider` + browser mock

**Files:**
- Modify: `src/types/ipc.ts` (types near `PiConfigureProviderRequest`; method near `:1314`)
- Test: `src/__tests__/piSetup.test.ts` (new `describe('piConnectProvider mock')`)

**Interfaces:**
- Produces:
  ```ts
  export interface PiConnectProviderRequest { provider: string; api_key: string }
  export interface PiConnectResult { status: PiSetupStatus; check: PiAuthCheckResult | null; check_error: string | null }
  ipc.piConnectProvider(req: PiConnectProviderRequest): Promise<PiConnectResult>  // Tauri: invoke('pi_connect_provider', { req })
  ```
- [ ] **Step 1: Write the failing tests:** mock connect with `sk-test-ok` → `check.status 'ready'`, provider in `status.configured_providers`; key `invalid-x` → `check.status 'invalid'` and provider **not** configured; after both, `JSON.stringify(localStorage)` contains neither key.
- [ ] **Step 2: Run** `npx vitest run src/__tests__/piSetup.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** types and method; mock mirrors `piConfigureProvider`'s key branch and persists only status via `saveMockPiSetup`.
- [ ] **Step 4: Run** the same + `npx tsc --noEmit` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "ipc: add piConnectProvider and its browser mock"`.

### Task 5: Pure logic — `providerDialogLogic.ts`

**Files:**
- Create: `src/components/providerDialog/providerDialogLogic.ts`
- Test: `src/__tests__/providerDialogLogic.test.ts`

**Interfaces:**
- Consumes: `normalizeSearchText`, `fuzzyMatch` from `src/components/modelPicker/modelPickerLogic.ts`; `PiSetupStatus`, `PiProviderCatalogEntry`, `PiModelCatalog` from `src/types/ipc.ts`.
- Produces:
  ```ts
  export const SLUG_RE = /^[a-z0-9-]{1,64}$/;
  export const PRIMARY_CLASS = 'btn-primary-xs', DANGER_PRIMARY_CLASS = 'btn-danger-xs';
  export type ConnectionKind = 'api_key' | 'signed_in' | 'env';
  export interface ProviderRow { id: string; label: string; connected: boolean; kind: ConnectionKind | null;
    supportsKey: boolean; supportsSignIn: boolean; envVar: string | null; curated: boolean }
  export interface ProviderListView { connected: ProviderRow[]; available: ProviderRow[]; noMatch: boolean; otherSlugPrefill: string | null }
  export type PanelIntent = 'default' | 'useKey' | 'useSignIn' | 'replace' | 'confirm';
  export type PanelState = 'key' | 'oauth' | 'connecting' | 'waiting' | 'timeout' | 'connected' | 'env' | 'replace' | 'confirm' | 'disconnecting';
  export type PrimaryAction = 'connect' | 'signIn' | 'busy' | 'checkAgain' | 'saveKey' | 'disconnect' | 'done';
  export type SignInPhase = 'waiting' | 'timeout' | 'invalid' | 'error';
  export function isValidSlug(s: string): boolean
  export function connectedProviderIds(status: PiSetupStatus): string[]        // configured ∪ {active if provider_ready}
  export function buildProviderRows(status: PiSetupStatus): ProviderRow[]
  export function buildProviderList(rows: ProviderRow[], query: string): ProviderListView
  export function initialSelection(status: PiSetupStatus, preselect: string | null): string
  export function derivePanelState(i: { row: ProviderRow; intent: PanelIntent;
    signIn: { provider: string; phase: SignInPhase } | null; busy: 'connecting' | 'disconnecting' | null }): PanelState
  export function primaryFor(state: PanelState): PrimaryAction                  // 'done' only for connected/env
  export function pickInitialDefault(catalog: PiModelCatalog | null, provider: string, curated: string[]): string | null
  export function pickFallbackDefault(target: string, rows: ProviderRow[], catalog: PiModelCatalog | null)
    : { provider: string; model: string | null } | null
  ```
- [ ] **Step 1: Write the failing tests:**
  - rows: connected kind from `auth_type` (`api_key` → `'api_key'`, `oauth` → `'signed_in'`); active + `provider_ready` + not configured → `'env'`; extra configured slug not in `providers` → label = slug, `supportsKey` and `supportsSignIn` both true, `curated false`.
  - list: CONNECTED in curated order then extras alphabetically; AVAILABLE in curated order; search is case/diacritic-insensitive over label and slug; no match → `noMatch true`, `otherSlugPrefill` = query when `isValidSlug(query)`, else `null`.
  - `initialSelection`: preselect wins; else active if connected; else first connected; else `providers[0].id`.
  - `derivePanelState` table: busy wins; sign-in `waiting`/`timeout` for this provider; connected + `confirm` → `confirm`, + `replace` → `replace`; env + `replace` → `replace`; not connected: OAuth-only → `oauth`, `useSignIn` + supportsSignIn → `oauth`, default with key → `key`; a sign-in for another provider is ignored.
  - `primaryFor` for all 10 states (one `it.each` table; `done` only for `connected`, `env`).
  - `pickInitialDefault` 4 branches (spec §4.3 step 5) incl. `null` catalog.
  - `pickFallbackDefault`: next connected in list order excluding target; `pickFallbackDefault with null catalog` → `{provider, model: <first curated suggestion or null>}`; none left → `null`.
- [ ] **Step 2: Run** `npx vitest run src/__tests__/providerDialogLogic.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the module (no React, no IO). "Curated suggestions" for a provider = `providers[].suggested_models`.
- [ ] **Step 4: Run** the same — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Add provider dialog pure logic (list, panel state, default picks)"`.

### Task 6: Pure logic — `signInPoller.ts`

**Files:**
- Create: `src/components/providerDialog/signInPoller.ts`
- Test: `src/__tests__/signInPoller.test.ts`

**Interfaces:**
- Produces (exactly spec §4.4):
  ```ts
  export type SignInPollState = { kind: 'waiting'; elapsedMs: number } | { kind: 'ready'; check: PiAuthCheckResult }
    | { kind: 'timeout' } | { kind: 'invalid'; reason: string | null } | { kind: 'error'; detail: string };
  export interface SignInPollerDeps<H> { provider: string; check: (p: string) => Promise<PiAuthCheckResult>;
    schedule: (fn: () => void, ms: number) => H; cancel: (h: H) => void; now: () => number;
    intervalMs?: number; timeoutMs?: number; maxConsecutiveErrors?: number; onState: (s: SignInPollState) => void }
  export function createSignInPoller<H>(deps: SignInPollerDeps<H>): { start(): void; checkNow(): void; stop(): void }
  ```
- [ ] **Step 1: Write the failing tests** with a hand-rolled fake scheduler (queue of `{fn, ms}`) and a mutable clock; `check` returns controllable deferred promises:
  - first check is scheduled at 3000, not run on `start()`;
  - next check is scheduled only after the previous settles (no overlap: with a pending check, the queue is empty);
  - `ready` → `onState({kind:'ready'})`, nothing else scheduled;
  - `invalid` → `{kind:'invalid'}`, stop; `not_ready` → keeps waiting;
  - 3 consecutive rejections → `{kind:'error'}`; a success in between resets the count;
  - timeout when `now() - startedAt >= 120000` → `{kind:'timeout'}` (advance the clock, not tick counts);
  - `checkNow()` with no check in flight runs immediately and cancels the pending timer; with one in flight it's coalesced (check called once);
  - `stop()` cancels the timer; a result resolving after `stop()` triggers no `onState`.
- [ ] **Step 2: Run** `npx vitest run src/__tests__/signInPoller.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Add sign-in poller with injected scheduler and clock"`.

### Task 7: Store — dialog slice, connect/disconnect/default flows, sign-in, no auto-open

**Files:**
- Modify: `src/store/workspaceStore.ts` (`piSetupOpen`/`setPiSetupOpen` removed; `:330`, `:428-429`, `:660-676`, `:818-882` changed; `openWorkspace`/`closeWorkspace` cleanup)
- Modify: `src/__tests__/piSetup.test.ts:26-44` (rewrite the first-run case, don't delete it)
- Create: `src/__tests__/providerDialogStore.test.ts`

**Interfaces:**
- Consumes: Tasks 4–6.
- Produces:
  ```ts
  providerDialog: { open: boolean; preselect: string | null; hiddenForSignIn: boolean };
  providerSignIn: { provider: string; phase: SignInPhase; startedAt: number; detail: string | null } | null;
  openProviderDialog(provider?: string): void;
  closeProviderDialog(): void;                       // stops a visible waiting poll
  connectPiProvider(provider: string, apiKey: string): Promise<{ result: PiConnectResult; defaultChangedTo: string | null }>;
  startProviderSignIn(provider: string): void;       // launchPiInteractiveLogin + poller + hiddenForSignIn
  checkProviderSignInNow(): void;
  cancelProviderSignIn(): void;
  revealProviderDialog(): void;                      // pill click while hidden → hiddenForSignIn false
  disconnectPiProvider(provider: string): Promise<{ defaultChangedTo: string | null; stillViaEnv: boolean }>;
  saveDefaultModel(sel: { provider: string; id: string } | null, markCompleted: boolean): Promise<void>;
  loadModelCatalog(): Promise<PiModelCatalog | null>; // now resolves with the catalog (stale guard kept)
  ```
- [ ] **Step 1: Write the failing tests** (`ipc` spies, `vi.useFakeTimers()` for sign-in):
  - S3-1 (rewritten `piSetup.test.ts` case): `openWorkspace` with `needs_setup`, `toggleRight`, `refreshPiSetupStatus` and `configurePiProvider` never set `providerDialog.open`; blocked `sendChatMessage` opens the dialog and posts **no** system message.
  - `openProviderDialog('openrouter')` sets `preselect`; `closeProviderDialog` resets it.
  - S3-4: first connect with no usable default → `piConfigureProvider` called once with `{provider, model: <pickInitialDefault>, mark_completed: true}` after `loadModelCatalog` resolved; with a usable default → not called; `defaultChangedTo` reflects it.
  - connect `invalid` → no configure call, `result.check.status 'invalid'` returned.
  - S3-7 (store part): after a connect with `sk-test-secret`, `JSON.stringify(useWorkspaceStore.getState())` and `localStorage` don't contain it.
  - disconnect default with a fallback → `piLogoutProvider` once, then configure `{provider: fb, model, mark_completed: false}`; `disconnect default with failing catalog writes fallback with null model`; non-default → no configure; env hint present + post-logout check `ready` → `stillViaEnv true`.
  - sign-in: `startProviderSignIn` → `launchPiInteractiveLogin` called, `hiddenForSignIn true`, `providerSignIn.phase 'waiting'`; advance 3 s with check → `ready` ⇒ `refreshPiSetupStatus` called, `providerSignIn null`, dialog `open true`, `hiddenForSignIn false`; advance 120 s of `not_ready` ⇒ `phase 'timeout'` and dialog stays hidden.
  - `openWorkspace stops a hidden sign-in poll and ignores its late result`: start sign-in, `openWorkspace`, resolve the pending check with `ready` → dialog closed, no `refreshPiSetupStatus` from the poll.
  - `loadModelCatalog` resolves with the catalog; a superseded request resolves `null`.
- [ ] **Step 2: Run** `npx vitest run src/__tests__/providerDialogStore.test.ts src/__tests__/piSetup.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.** Shared helper `applyInitialDefaultIfNeeded(provider)` used by connect and sign-in `ready`. `startProviderSignIn` wires the poller with `schedule: setTimeout`, `cancel: clearTimeout`, `now: Date.now`, `check: ipc.piCheckProvider`. Remove `piSetupOpen`, `setPiSetupOpen` and every auto-open/close. Keep `sendChatMessage`'s blocked branch as a guard that calls `openProviderDialog()` with no message.
- [ ] **Step 4: Run** the same + `npx tsc --noEmit` (expect TS errors only in `PiSetupWizard.tsx`/`ChatPanel.tsx`/`SettingsModal.tsx` that use `piSetupOpen`; stub those call sites to `openProviderDialog()` now so tsc passes) — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Store: provider dialog slice, connect/disconnect/sign-in flows, no auto-open"`.

### Task 8: `ModalDialog` primitive

**Files:**
- Create: `src/components/ModalDialog.tsx`
- Test: `src/__tests__/modalDialog.test.tsx`

**Interfaces:**
- Produces:
  ```ts
  export interface ModalDialogProps { titleId: string; descriptionId?: string; onClose: () => void;
    busy?: boolean; initialFocus?: React.RefObject<HTMLElement | null>; className?: string; children: React.ReactNode }
  export const ModalDialog: React.FC<ModalDialogProps>   // portal into document.body
  ```
- [ ] **Step 1: Write the failing tests:**
  - renders `role="dialog"`, `aria-modal="true"`, `aria-labelledby`/`aria-describedby` into `document.body`.
  - S3-10: `activeModalCount` +1 on mount, back on unmount.
  - trap: `Tab` on the last tabbable focuses the first; `Shift+Tab` on the first focuses the last (content changed between presses still works); focusing an outside button via `focusin` pulls focus back inside.
  - `Esc` on the dialog calls `onClose` and doesn't reach a `window` keydown spy; with `busy` it does nothing; an inner element that stops propagation on `Esc` prevents the close.
  - return focus: opener button refocused on unmount; when the opener was removed, `.chat-input` gets focus if present, else `document.body`.
  - `initialFocus` ref is focused after mount (flush `requestAnimationFrame` with fake timers).
  - backdrop click does not call `onClose`.
  - `#root` gets `inert` while mounted and loses it after.
- [ ] **Step 2: Run** `npx vitest run src/__tests__/modalDialog.test.tsx` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Add ModalDialog primitive (focus trap, Esc layering, focus return)"`.

### Task 9: i18n — new keys

**Files:**
- Modify: `src/i18n/index.ts` (all three locales)
- Modify: `src/__tests__/i18nAndMedia.test.ts`

- [ ] **Step 1: Write the failing tests** (AC22, S3-9): every `providerDialog.*` key of spec §3.6 plus `chat.connectCta.title`, `chat.connectCta.button`, `piSetup.pillWaiting` exists in en, pt-BR and zh-CN with the exact en values from the spec for a sample (`title`, `keyPlaceholder`, `envHelper`); `piSetup.pillConnect`, `settingsTitle`, `settingsDesc`, `settingsConfigureBtn` have the new copy; no translation value in any locale matches `/Pi Durable/`.
- [ ] **Step 2: Run** `npx vitest run src/__tests__/i18nAndMedia.test.ts` — Expected: FAIL.
- [ ] **Step 3: Add the keys** verbatim from spec §3.6 (both tables). Don't delete old keys yet (Task 11 does, once nothing uses them).
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "i18n: provider dialog copy in en, pt-BR, zh-CN"`.

### Task 10: `ProviderDialog` UI

**Files:**
- Create: `src/components/providerDialog/ProviderDialog.tsx` (container: header, list, panel, default model, footer; owns `apiKey`, `customSlug`, `intent`, `busy`, `error`, `stagedDefault`)
- Create: `src/components/providerDialog/ProviderList.tsx` (combobox search + listbox, ↑/↓/`Enter` from the search field, `aria-activedescendant`)
- Create: `src/components/providerDialog/ProviderPanel.tsx` (presentational, one branch per `PanelState`)
- Create: `src/__tests__/providerDialog.test.tsx`
- Delete: `src/components/PiSetupWizard.tsx`, `src/__tests__/piSetupWizardModelPicker.test.tsx` (after porting its still-valid picker cases)

**Interfaces:**
- Consumes: Tasks 5, 7, 8, 9; `ModelPicker` (`selectableProvider={null}`, `connectedProviders={connectedProviderIds(status)}`).
- Produces: `export const ProviderDialog: React.FC` — renders `null` unless `providerDialog.open && !hiddenForSignIn`.

- [ ] **Step 1: Write the failing tests** (store seeded with mock statuses; `ipc` spies; `vi.useFakeTimers()` for sign-in):
  - AC10: `it.each` over the 10 states + an S-ERROR case, driving each through status + events; `container.querySelectorAll('.btn-primary-xs, .btn-danger-xs').length === 1`; footer **Done** is primary only in `connected`/`env`.
  - AC12: for every provider in the mock status, key placeholder is `Paste your API key` and contains no env var; with `env_var_hint`, the helper text holds it and is in the field's `aria-describedby`.
  - AC11: Disconnect… → confirmation names the fallback (`Chat will switch to …`); Cancel → 0 `piLogoutProvider` calls; `Esc` in the box → 0 calls and the dialog stays open; confirm → 1 call.
  - AC13 (UI): Sign in → dialog hidden; check `ready` after 3 s → dialog visible in S-CONNECTED with focus on the panel heading; Cancel sign-in → S-OAUTH and no further checks.
  - S3-3: picking a model of another connected provider changes the staged default label but not the selected row (`aria-selected`).
  - Done: staged default differs → `piConfigureProvider({provider, model, mark_completed: true})` then close; `done with an unsaved key connects first and stays open on invalid` (key `invalid-x` → error shown, dialog open, key still in the field).
  - `double click on connect makes one ipc call`.
  - selecting another provider while S-WAITING stops the poll (no further `piCheckProvider` after advancing 10 s) and asks nothing.
  - Replace key success and Sign in again `ready` each trigger one `piListModels` call (not awaited; spec §4.7).
  - Connect success clears the key field DOM value; key cleared on provider switch.
  - `custom slug equal to curated id selects the curated row`; invalid slug shows `Use lowercase letters, digits and dashes.` and disables Connect.
  - first run shows "Use offline for now" → `skipPiSetup` + close; not shown when `first_run_completed`.
  - pi missing: `piMissing` banner, **Sign in** disabled with `aria-describedby` → banner; Connect success shows `savedUnchecked`.
  - S3-7 (UI): spy all `console.*` during a connect flow with `sk-test-secret`; no call argument contains it.
  - AC24: from the search field, `ArrowDown`/`Enter` selects a row and moves focus into the panel; `Esc` order picker → dialog.
  - Ported from `piSetupWizardModelPicker.test.tsx`: picker renders catalog models of connected providers and "Connect ▸" for others; "Connect ▸ X" selects X in the list and focuses its key field.
- [ ] **Step 2: Run** `npx vitest run src/__tests__/providerDialog.test.tsx` — Expected: FAIL.
- [ ] **Step 3: Implement** the three components. Catalog loads on open only if `modelCatalog === null`. Busy state blocks ✕/`Esc` via `ModalDialog busy`. Elapsed `m:ss` in S-WAITING from a 1 s `setInterval` cleared on unmount.
- [ ] **Step 4: Run** `npx vitest run && npx tsc --noEmit` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Add ProviderDialog; remove the inline PiSetupWizard"`.

### Task 11: Wiring — App, ChatPanel CTA + pill, Settings, old keys, CSS

**Files:**
- Modify: `src/App.tsx` (render `<ProviderDialog />` once)
- Modify: `src/panels/ChatPanel.tsx:91-97` (`handleSubmit`), `:120-143` (pill, remove inline wizard, CTA in transcript area)
- Modify: `src/components/SettingsModal.tsx:240-263` (close Settings, then `openProviderDialog()`)
- Modify: `src/i18n/index.ts` (delete the unused `piSetup.*` keys listed in spec §3.6)
- Modify: `src/index.css` (dialog layout, < 420 px stacking, ghost-red, danger primary, pill pulse with `prefers-reduced-motion`)
- Modify: `src/__tests__/i18nAndMedia.test.ts` (removed keys absent)
- Create: `src/__tests__/chatPanelConnect.test.tsx`

- [ ] **Step 1: Write the failing tests:**
  - S3-2: with `needs_setup`, typing "hello" and pressing `Enter` → `providerDialog.open true`, composer still holds "hello", no new chat message.
  - CTA: `Connect an AI provider to start` + **Connect** opens the dialog; "Use offline for now" only on first run.
  - pill click → `openProviderDialog()` (opens, never toggles: clicking twice keeps it open); with `providerSignIn.phase 'waiting'` and hidden dialog, pill shows `Waiting for sign-in…` and click calls `revealProviderDialog`.
  - Settings "Manage providers…" closes Settings and opens the dialog.
  - i18n: each removed key from spec §3.6 is absent in all three locales.
- [ ] **Step 2: Run** `npx vitest run src/__tests__/chatPanelConnect.test.tsx src/__tests__/i18nAndMedia.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** wiring, delete keys, add CSS.
- [ ] **Step 4: Run the full validation:** `npx vitest run`, `npx tsc --noEmit`, `cargo test --manifest-path src-tauri/Cargo.toml`, `cargo test --manifest-path src-tauri/Cargo.toml --features desktop`, `cargo clippy --manifest-path src-tauri/Cargo.toml --features desktop` — Expected: all PASS, only the 7 known clippy warnings.
- [ ] **Step 5: Record decisions** in `docs/DECISIONS.md` (dated 2026-11-26; check for duplicates first): sign-in hides the dialog (§8.1), ✕/Esc always close (§8.2), initial default on first Connect only (§8.4), `pi_connect_provider` + lazy adapter upgrade (§9.14).
- [ ] **Step 6: Commit** `git commit -m "Wire provider dialog into chat, pill and Settings; drop old copy"`.
- [ ] **Step 7: Manual (user):** 320 px window in pt-BR (AC23, screenshot for the PR); one real OAuth provider end to end.
- [ ] **Step 8:** Independent Opus review of the whole branch diff before the user commits/pushes (project convention).
