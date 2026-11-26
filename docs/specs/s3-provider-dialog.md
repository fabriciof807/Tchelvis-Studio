# Spec: S3 — Provider connection dialog

Status: approved (decisions §8 settled 2026-11-26) · Date: 2026-11-25 · Parent spec: `docs/specs/chat-ux-redesign.md` (§4.7, §10 row S3) · Depends on: S2 (ModelPicker field mode, `modelCatalog` slice, `translatePlural`)

This spec turns the inline "Connect Pi Durable Provider" card into the **Connect an AI provider** modal dialog. It fixes problems P5–P10 and C12 from the parent spec. The user-facing behaviour comes first; technical notes are included only where they are needed to implement and test the change. It is a spec only and contains no code.

---

## 1. Scope

### 1.1 In S3

| # | Change | Fixes |
|---|---|---|
| 1 | The inline `PiSetupWizard` card becomes a **modal dialog** (`ProviderDialog`). It is rendered once at app level, not inside `ChatPanel`, and opens only on an explicit user action. | P5–P10, C12 |
| 2 | **One primary action per state** (§3). The form-wide double submit and the separate "Use detected" banner are removed. | P5 |
| 3 | **Searchable provider list** with CONNECTED / AVAILABLE sections. Sign-in methods appear as plain text, and the connected status is shown once. | P7 |
| 4 | **Disconnect...** moves into the connected provider's panel and requires confirmation. If the disconnected provider was the default, the default falls back to another connected provider. | P6 |
| 5 | **Env var as helper text** below the key field. The placeholder never contains an env var name. | P8 |
| 6 | **OAuth auto-poll**: after **Sign in**, the app checks `pi_check_provider` every 3 s for up to 2 min. It flips to Connected without a manual click. | AC13 |
| 7 | **Default model is independent of the selected provider.** The ModelPicker from S2 lists connected providers only. Picking a model no longer changes which provider's credentials are being edited. | P9 residue, C3 residue (S2 review nit 13) |
| 8 | Title, subtitle and Settings copy changes: no "Pi Durable" in user-facing strings. | P10 |
| 9 | **No auto-open.** A minimal "not connected" call to action in the chat panel replaces the auto-expanding card. Sending while not connected opens the dialog and keeps the draft. | C12 |
| 10 | Backend: a new `pi_connect_provider` command (save key + `pi auth check`). `pi_configure_provider` stops waiting behind a running turn. Mismatched default provider/model pairs are prevented. The request's `Debug` output redacts the key. | S2 leftover, secrets |
| 11 | A reusable `ModalDialog` primitive with focus trap, `Esc`, focus return and `activeModalCount`. | AC24 |

### 1.2 Left for later slices (do not build in S3)

| Item | Slice |
|---|---|
| Composer model chip, compact picker, per-conversation model, favorites/recents, thinking level, removal of the header provider pill | S4 |
| Full empty states (starter chips, offline strip, pi-missing strip), header `⋯` menu, **+ New**, moving the hardcoded Portuguese store strings to i18n | S8 |
| Error card with **Reconnect provider** after an auth failure during a turn | S6 |
| Removing `pi auth check` from every `pi_get_setup_status` read and removing `available_models` (parent §5.3) | Later (performance), not S3 |
| `pi update --models` / ⟳ catalog refresh | S4 |
| Migrating `SettingsModal` to the new `ModalDialog` primitive | Optional follow-up; S3 does not touch it beyond copy and the open action |

S3 keeps the header provider pill (`ChatPanel.tsx:126-134`). Its click now opens the dialog instead of toggling the inline card, and it shows the sign-in waiting state (§4.5). S4 removes it and must move the waiting indicator to the model chip.

---

## 2. Current behaviour inventory (evidence)

References are to the working tree at `3994a57`. The screenshot provided predates S2: it still shows the free-text model field.

### P5 — Two (or three) primary-looking buttons do the same thing
- `src/components/PiSetupWizard.tsx:262`: a single `<form onSubmit={handleSaveKeyAndConnect}>` wraps everything.
- `:354-360`: **Save Key & Connect** (`piSetup.saveKeyBtn`, `type="submit"`, `btn-primary-xs`) sits next to the key field.
- `:413-419`: **Save & Connect Chat** (`piSetup.saveConnectBtn`, `type="submit"`, `btn-primary-xs`) sits in the footer. Both buttons run `handleSaveKeyAndConnect` (`:115-136`), which calls `configurePiProvider({provider, model, api_key, mark_completed: true})`.
- Other primaries can show at the same time: **Use {provider}** (`:251-258`, the detected-credential banner) and **Open Terminal Login** (`:367-374`). Up to three `btn-primary-xs` buttons can be visible together.

### P6 — Disconnect is unguarded and unexplained
- `:428-437`: **Disconnect** (`piSetup.logoutBtn`) sits in the footer next to Save and Offline and wraps onto its own row. It runs `handleLogout` (`:189-203`) immediately, with no confirmation.
- Store `logoutPiProvider` (`src/store/workspaceStore.ts:848-855`) → `pi_logout_provider` → `logout_pi_provider_in` (`src-tauri/src/sidecar/pi_setup.rs:790-806`) deletes the provider's entry from `~/.pi/agent/auth.json`.
- Nothing explains what is removed or that env vars still work. If the disconnected provider was the default, `settings.json` keeps `defaultProvider`, `provider_ready` becomes false and the chat silently drops to `needs_setup`. No fallback is offered.

### P7 — Status duplicated, capability badges look like buttons
- `:273-278`: the `<select>` option label appends ` (Configured)`.
- `:292-307`: the pill badges `API Key`, `OAuth` and `Configured (api_key)` use `.pi-capability-badge`, and the method names are hardcoded English.
- `:310-333`: the tabs "API Key" / "OAuth / Interactive Login" repeat the same information a third time.

### P8 — Env var looks like a filled-in key
- `:348-352`: `placeholder={env_var_hint ? \`${env_var_hint} ...\` : t('piSetup.apiKeyPlaceholder')}` renders `OPENCODE_API_KEY ...` in grey inside a password field.

### P9 — Model list (fixed by S2, residue remains)
- S2 replaced the datalist with `ModelPicker` (`:387-404`).
- Residue: `handleModelChange` (`:90-102`) switches the provider `<select>` when a model of another provider is picked. `selectableProvider` (`:398`) makes an *unconnected* provider's curated suggestions selectable. Choosing a default model and choosing whose credentials to edit are therefore coupled. Changing the provider keeps the old model id (S2 review nit 13), so Save can write a mismatched `defaultProvider`/`defaultModel` pair.
- Backend: `configure_pi_provider_in` (`pi_setup.rs:707-788`) always overwrites `defaultProvider` and keeps the old `defaultModel` when `model` is `None` (`:744-763`).

### P10 — Internal jargon
- `src/i18n/index.ts`: `piSetup.title` is "Connect Pi Durable Provider" (en `:411`, pt-BR `:146`, zh-CN `:673`), and `piSetup.settingsTitle` is "Pi Durable (AI Chat)" (en `:436`, pt-BR `:171`, zh-CN `:698`). The subtitle says "Choose how AI Chat authenticates…".

### C12 — Inline card auto-opens
- `src/panels/ChatPanel.tsx:143` renders `{piSetupOpen && <PiSetupWizard />}` inline between the header and the transcript.
- The store auto-opens it in four places:
  - `openWorkspace` (`workspaceStore.ts:330`, `piSetupOpen: needs_setup`);
  - `toggleRight` (`:428-429`);
  - `sendChatMessage` (`:660-676`), which also posts a system message `piSetup.chatBlockedHint` "…in the panel above…";
  - `configurePiProvider` (`:842`, `piSetupOpen: status.needs_setup`).
- `refreshPiSetupStatus` (`:824`) auto-closes it.
- `ChatPanel.handleSubmit` (`:91-97`) clears the draft before the store decides the message is blocked, so the user's text is lost.

### Modal infrastructure today
- No focus trap exists anywhere. `SettingsModal` (`src/components/SettingsModal.tsx:62-75`) listens for `Escape` on `window`. Its dialog has `role="dialog" aria-modal` (`:161-163`) and no focus management.
- `activeModalCount` (`workspaceStore.ts:404-408`) is read by `BrowserPanel.tsx:36` to hide the native child WebView while a modal is open (z-order). Every new modal **must** increment and decrement it.

### S2 leftover — configure waits behind a running turn
- `cmd_pi_configure_provider` (`src-tauri/src/lib.rs:326-340`) writes the files and then calls `state.pi_adapter.lock()` to swap an offline adapter for a process adapter. A running turn holds that lock for up to 180 s (`cmd_pi_send_message`, `:296-306`). The command runs on a worker (`on_worker`, `:840-845`), so the window doesn't freeze, but **Save** spins for up to 3 minutes.
- `check`, `logout`, `status` and `list_models` don't take the lock.

### Secrets surface today
- `PiConfigureProviderRequest` (`src-tauri/src/types.rs:536-543`) derives `Debug` and `Serialize` with `api_key: Option<String>`. Any future `{:?}` log of the request would print the key.
- `check_pi_provider_auth` (`pi_setup.rs:559-603`) runs `pi auth check --provider <p> --no-refresh --json` with a 5 s timeout. It never passes `--credentials`, which keeps it safe (`pi auth --help`: `--credentials` would emit the secret).
- `pi auth check` reports `ready` / `not_ready` / `invalid`. It resolves stored credentials and env vars and does **not** call the provider's API. It cannot prove that a key is accepted by the provider.

---

## 3. Dialog design

### 3.1 Size and placement

- Centred modal over the whole window, independent of the chat dock width: `width: min(520px, 100vw - 32px)`, `max-height: 85vh`.
- The header and footer are fixed, and the body scrolls.
- The provider list is capped at about 6.5 rows (≈ 220 px) and scrolls inside, so the panel and the default model stay visible.
- Backdrop: same as `.lightbox-backdrop`.
- Clicking the backdrop **does not** close the dialog (a stray click mustn't lose a typed key). ✕, `Esc` and **Done** close it.
- Existing dark tokens only (`--hub-surface`, `--hub-border`, `--hub-bg-elevated`); no new theme tokens.

### 3.2 Anatomy (520 px)

```
┌ Connect an AI provider ───────────────────────────── ✕ ┐
│ Chat uses the pi agent. Keys stay on this machine.     │  subtitle, muted
│ ┌────────────────────────────────────────────────────┐ │
│ │ 🔍 Search providers                                │ │  combobox → listbox
│ └────────────────────────────────────────────────────┘ │
│ CONNECTED                                              │  section only if ≥1
│▌● OpenCode Go                               API key   │  ▌ = selected row
│ AVAILABLE                                              │
│   Anthropic (Claude)                   Key · Sign-in   │  methods = plain muted text
│   OpenRouter                           Key · Sign-in   │
│   OpenAI                                         Key   │
│   OpenAI Codex (ChatGPT OAuth)               Sign-in   │
│   …                                                    │
│   Other provider (slug)…                               │  always last, never filtered out
├────────────────────────────────────────────────────────┤
│  «provider panel — one of the states in 3.4»           │
├────────────────────────────────────────────────────────┤
│ Default model for new conversations                    │
│ [ DeepSeek V4.1 Flash · OpenCode Go                ▾ ] │  S2 ModelPicker, field mode
├────────────────────────────────────────────────────────┤
│ Use offline for now                           [ Done ] │  link: first run only
└────────────────────────────────────────────────────────┘
```

- **Row text:**
  - Connected rows show a green `●` plus the connection kind: `API key`, `Signed in`, or `Environment` (§3.4 S-ENV).
  - Available rows show the methods: `Key`, `Sign-in`, or `Key · Sign-in`.
  - Nothing else is shown: no pills, no "(Configured)".
- **Sort order:** CONNECTED follows curated order, then extra connected slugs alphabetically. AVAILABLE follows curated order (`CURATED_PROVIDERS`).
- **Search:** filters both sections over label and slug, case- and diacritic-insensitive. It reuses `normalizeSearchText` / `fuzzyMatch` from `modelPickerLogic.ts`. Empty sections are hidden. With no match, the list reads `No provider matches "<q>"`, and **Other provider (slug)…** stays visible with the query pre-filled as the slug if it is a valid slug.
- **Selection:** there is always exactly one selected provider (§3.3 picks the initial one). Clicking a row, or pressing `Enter` on the active row, selects it. Focus then moves to the panel's first interactive element.

### 3.3 Initial selection and focus on open

| Opened from | Selected provider | Initial focus |
|---|---|---|
| `openProviderDialog(p)` with a provider (picker "Connect ▸", sign-in reopen) | `p` | First field of the panel (key field, or the **Sign in** button) |
| Any other opener, ≥1 provider connected | Active provider if connected, else the first CONNECTED row | Search field |
| Any other opener, none connected | First curated provider (`opencode-go`) | Search field |

### 3.4 Provider panel state machine

These states are per selected provider. "Primary" is the single `btn-primary` in the whole dialog, including the footer. While a request runs, the primary slot shows a disabled busy button with a spinner; it is never removed. Removing it would make the layout jump and break "exactly one primary".

| State | Entered when | Panel content | Primary | Secondary / links | Focus on enter |
|---|---|---|---|---|---|
| **S-KEY** Not connected, key method | Provider not connected and `supports_api_key` (also the default for custom slugs) | Key field (`type=password`, placeholder "Paste your API key"). Helper text below: "Or set `OPENCODE_API_KEY` in your environment." (only when `env_var_hint` is set). | **Connect**, disabled while the key is empty | "Sign in with browser instead" (if `supports_oauth`) → S-OAUTH | Key field |
| **S-OAUTH** Not connected, sign-in | Provider is OAuth-only, or the user chose sign-in | "Sign-in runs in the built-in terminal (`pi auth login <slug>`)." | **Sign in** | "Use an API key instead" (if `supports_api_key`) → S-KEY | **Sign in** |
| **S-CONNECTING** | Connect pressed | Key field disabled. Inline status "Connecting…", then "Checking…" | busy **Connecting…** | — | stays on the busy button |
| **S-WAITING** Sign-in pending | Sign in pressed; poll running (§4.4) | "Waiting for sign-in… 0:42" (`role="status"`, elapsed m:ss) | busy **Waiting for sign-in…** | "I've signed in — check now" · "Show terminal" · "Cancel sign-in" | "Show terminal" |
| **S-TIMEOUT** | 2 min passed without `ready` | "No sign-in detected after 2 minutes." | **Check again** (one check; if `ready` → S-CONNECTED, else restart the poll) | "Open the terminal again" (re-runs `pi auth login`) · "Use an API key instead" | **Check again** |
| **S-CONNECTED** | Provider in `configured_providers` | "OpenCode Go · Connected with API key ✓" or "· Signed in ✓", plus muted "Stored by pi in ~/.pi/agent/auth.json" | *(none in panel)*: footer **Done** is primary | **Replace key** (`auth_type` api_key) or **Sign in again** (oauth); **Disconnect…** (ghost-red, right-aligned) | Panel heading (`tabIndex=-1`) |
| **S-ENV** Connected only via env | Provider is the active provider, `provider_ready` is true, and it is not in `configured_providers` | "OpenCode Go · Available through `OPENCODE_API_KEY` in your environment ✓", plus "To disconnect it, remove the variable from your environment." | *(none in panel)*: footer **Done** | "Save a key instead" → S-REPLACE | Panel heading |
| **S-REPLACE** | Replace key / Save a key instead | The connected status line stays. Key field + helper text below it. | **Save key** | "Cancel" → back to S-CONNECTED/S-ENV | Key field |
| **S-CONFIRM** Disconnect confirmation | Disconnect… pressed | Inline confirmation box replacing the action row (`role="alertdialog"`, `aria-labelledby` title, `aria-describedby` body): **Disconnect OpenCode Go?** "This removes its stored credential from pi. Environment variables are not affected." If it's the default provider, an extra line: "It's your default provider. Chat will switch to *Kimi K3 · OpenRouter*." or "…Chat will be disconnected until you connect a provider." | **Disconnect** (danger-styled primary) | **Cancel** | **Cancel** (the safe choice) |
| **S-DISCONNECTING** | Confirmed | Same box, controls disabled | busy **Disconnecting…** | — | busy button |
| **S-ERROR** | Connect / sign-in / disconnect failed | The previous state's content plus an inline error below the field (`role="alert"`), e.g. "pi says this key is invalid (invalid). Check it and try again." The key stays in the field so the user can fix it. | Same as the previous state (**Connect** / **Check again** / **Disconnect**) | Same as the previous state | The field in error, or the primary |

**Footer rules**

- The footer always has **Done**. It is styled **primary only when the panel shows no primary** (S-CONNECTED, S-ENV); otherwise it is `btn-ghost`. This keeps exactly one primary visible (AC10).
- **Done** behaviour:
  1. If a key is typed in S-KEY/S-REPLACE and not yet saved, Done runs Connect first and closes only on success (parent §4.7).
  2. If the staged default model differs from the stored one, or it is the first run and a default exists, Done calls `configurePiProvider({provider, model, mark_completed: true})`. While that runs the button shows "Saving…".
  3. Then it closes.
- "Use offline for now" (link, footer-left) appears only while `first_run_completed === false`. It calls `skipPiSetup()` and closes.

**Default model section**

- Shown below the panel in every state. It is disabled, with the muted text "Connect a provider to choose a model.", until at least one provider is connected (or S-ENV applies).
- It uses the S2 `ModelPicker` with `connectedProviders = configured_providers ∪ {active provider if provider_ready}` and **`selectableProvider = null`**. Unconnected providers appear only as "Connect ▸" rows.
- Picking a model only **stages** the default (`{provider, id}`). It never changes the selected provider in the list.
- "Connect ▸ <provider>" in the picker selects that provider in the list, scrolls it into view and focuses its key field (S-KEY) or **Sign in** (S-OAUTH).

### 3.5 State mockups (520 px; the panel area only)

**S-KEY (OpenCode Go, first run)**
```
│ OpenCode Go                                            │
│ API key                                                │
│ ┌──────────────────────────────────────┐ [ Connect ]   │  primary
│ │ Paste your API key                   │               │
│ └──────────────────────────────────────┘               │
│ Or set OPENCODE_API_KEY in your environment.           │  helper, muted
│ Sign in with browser instead                           │  link
├────────────────────────────────────────────────────────┤
│ Default model for new conversations                    │
│ [ Connect a provider to choose a model.         ▾ ]    │  disabled
├────────────────────────────────────────────────────────┤
│ Use offline for now                           [ Done ] │  ghost
```

**S-CONNECTING → success**
```
│ ┌──────────────────────────────────────┐ [◌ Connecting…]│
│ │ ••••••••••••••••••                   │               │
│ └──────────────────────────────────────┘               │
│ ◌ Checking…                                            │  role=status
```
followed by
```
│ OpenCode Go · Connected with API key ✓                 │
│ Stored by pi in ~/.pi/agent/auth.json                  │
│ [Replace key]                          [Disconnect…]   │  ghost · ghost-red
├────────────────────────────────────────────────────────┤
│ Default model for new conversations                    │
│ [ DeepSeek V4.1 Flash · OpenCode Go             ▾ ]    │  auto-picked, §4.3
├────────────────────────────────────────────────────────┤
│ Use offline for now                           [ Done ] │  now primary
```

**S-OAUTH / S-WAITING / S-TIMEOUT**
```
│ OpenAI Codex (ChatGPT OAuth)                           │
│ Sign-in runs in the built-in terminal                  │
│ (pi auth login openai-codex).                          │
│ [ Sign in ]                                            │  primary
```
```
│ ◌ Waiting for sign-in… 0:42                            │
│ [◌ Waiting for sign-in…]                               │  busy primary
│ I've signed in — check now · Show terminal · Cancel    │
```
```
│ No sign-in detected after 2 minutes.                   │
│ [ Check again ]   Open the terminal again              │
│ Use an API key instead                                 │
```

**S-CONFIRM**
```
│ OpenCode Go · Connected with API key ✓                 │
│ ┌ Disconnect OpenCode Go? ─────────────────────────┐   │
│ │ This removes its stored credential from pi.      │   │
│ │ Environment variables are not affected.          │   │
│ │ It's your default provider. Chat will switch to  │   │
│ │ Kimi K3 · OpenRouter.                            │   │
│ │                       [ Cancel ]  [ Disconnect ] │   │  Disconnect = danger primary
│ └──────────────────────────────────────────────────┘   │
├────────────────────────────────────────────────────────┤
│                                               [ Done ] │  ghost while confirming
```

**Custom slug (Other provider…)**
```
│ Other provider                                         │
│ Provider slug                                          │
│ ┌────────────────────────────┐                         │
│ │ e.g. my-provider           │                         │
│ └────────────────────────────┘                         │
│ API key                                                │
│ ┌──────────────────────────────────────┐ [ Connect ]   │
│ │ Paste your API key                   │               │
│ └──────────────────────────────────────┘               │
│ Sign in with browser instead                           │
```
The slug is validated live against `^[a-z0-9-]{1,64}$` (mirroring `validate_provider_slug`). If it is invalid, the field shows "Use lowercase letters, digits and dashes." and Connect is disabled. A slug equal to a curated id selects that curated row instead.

**320 px viewport** (narrow window; the chat dock width doesn't matter for a centred modal)
```
┌ Connect an AI provider ───── ✕ ┐
│ Chat uses the pi agent. Keys   │
│ stay on this machine.          │
│ [🔍 Search providers         ] │
│ CONNECTED                      │
│▌● OpenCode Go                  │
│    API key                     │  method wraps under the name
│ AVAILABLE                      │
│   Anthropic (Claude)           │
│    Key · Sign-in               │
│   …                            │
├────────────────────────────────┤
│ OpenCode Go · Connected with   │
│ API key ✓                      │
│ [Replace key]                  │  actions stack, full width,
│ [Disconnect…]                  │  never truncated
├────────────────────────────────┤
│ Default model for new          │
│ conversations                  │
│ [DeepSeek V4.1 Flash · Op… ▾]  │  label may ellipsize (tooltip)
├────────────────────────────────┤
│ Use offline for now   [ Done ] │  wraps to two lines if needed
└────────────────────────────────┘
```
Below 420 px: the key row stacks (field, then a full-width **Connect**), and the action rows wrap. Buttons never use fixed widths. Labels may ellipsize; actions may not (parent §7). Test this width in pt-BR.

### 3.6 Copy (proposed keys, namespace `providerDialog.*`)

Model and provider names, slugs, env var names, commands and paths are not translated. `{x}` marks a placeholder.

| Key | en | pt-BR | zh-CN |
|---|---|---|---|
| `title` | Connect an AI provider | Conectar um provedor de IA | 连接 AI 提供商 |
| `subtitle` | Chat uses the pi agent. Keys stay on this machine. | O Chat usa o agente pi. As chaves ficam nesta máquina. | 聊天使用 pi 智能体。密钥只保存在本机。 |
| `close` | Close | Fechar | 关闭 |
| `searchPlaceholder` | Search providers | Buscar provedores | 搜索提供商 |
| `listLabel` | Providers | Provedores | 提供商 |
| `sectionConnected` | Connected | Conectados | 已连接 |
| `sectionAvailable` | Available | Disponíveis | 可用 |
| `methodKey` | Key | Chave | 密钥 |
| `methodSignIn` | Sign-in | Login | 登录 |
| `kindApiKey` | API key | Chave de API | API 密钥 |
| `kindSignedIn` | Signed in | Login feito | 已登录 |
| `kindEnv` | Environment | Ambiente | 环境变量 |
| `noMatch` | No provider matches "{query}" | Nenhum provedor corresponde a "{query}" | 没有与“{query}”匹配的提供商 |
| `otherProvider` | Other provider (slug)… | Outro provedor (slug)… | 其他提供商（slug）… |
| `otherProviderTitle` | Other provider | Outro provedor | 其他提供商 |
| `slugLabel` | Provider slug | Slug do provedor | 提供商 slug |
| `slugPlaceholder` | e.g. my-provider | ex.: meu-provedor | 例如 my-provider |
| `slugInvalid` | Use lowercase letters, digits and dashes. | Use letras minúsculas, números e hífens. | 只能使用小写字母、数字和连字符。 |
| `keyLabel` | API key | Chave de API | API 密钥 |
| `keyPlaceholder` | Paste your API key | Cole sua chave de API | 粘贴你的 API 密钥 |
| `envHelper` | Or set {envVar} in your environment. | Ou defina {envVar} no seu ambiente. | 或在环境变量中设置 {envVar}。 |
| `useSignIn` | Sign in with browser instead | Entrar pelo navegador | 改用浏览器登录 |
| `useKey` | Use an API key instead | Usar uma chave de API | 改用 API 密钥 |
| `connect` | Connect | Conectar | 连接 |
| `connecting` | Connecting… | Conectando… | 正在连接… |
| `checking` | Checking… | Verificando… | 正在检查… |
| `signInHint` | Sign-in runs in the built-in terminal ({command}). | O login roda no terminal integrado ({command}). | 登录将在内置终端中进行（{command}）。 |
| `signIn` | Sign in | Entrar | 登录 |
| `waiting` | Waiting for sign-in… {elapsed} | Aguardando login… {elapsed} | 正在等待登录… {elapsed} |
| `waitingBtn` | Waiting for sign-in… | Aguardando login… | 正在等待登录… |
| `checkNow` | I've signed in — check now | Já entrei — verificar agora | 我已登录，立即检查 |
| `showTerminal` | Show terminal | Mostrar terminal | 显示终端 |
| `cancelSignIn` | Cancel sign-in | Cancelar login | 取消登录 |
| `signInTimeout` | No sign-in detected after 2 minutes. | Nenhum login detectado em 2 minutos. | 2 分钟内未检测到登录。 |
| `checkAgain` | Check again | Verificar de novo | 再次检查 |
| `reopenTerminal` | Open the terminal again | Abrir o terminal de novo | 重新打开终端 |
| `statusApiKey` | {provider} · Connected with API key ✓ | {provider} · Conectado com chave de API ✓ | {provider} · 已通过 API 密钥连接 ✓ |
| `statusSignedIn` | {provider} · Signed in ✓ | {provider} · Login feito ✓ | {provider} · 已登录 ✓ |
| `statusEnv` | {provider} · Available through {envVar} in your environment ✓ | {provider} · Disponível via {envVar} no seu ambiente ✓ | {provider} · 已通过环境变量 {envVar} 可用 ✓ |
| `storedWhere` | Stored by pi in ~/.pi/agent/auth.json | Guardada pelo pi em ~/.pi/agent/auth.json | 由 pi 保存在 ~/.pi/agent/auth.json |
| `envDisconnectNote` | To disconnect it, remove the variable from your environment. | Para desconectar, remova a variável do seu ambiente. | 如需断开，请从环境变量中移除它。 |
| `replaceKey` | Replace key | Trocar chave | 更换密钥 |
| `saveKeyInstead` | Save a key instead | Salvar uma chave | 改为保存密钥 |
| `saveKey` | Save key | Salvar chave | 保存密钥 |
| `signInAgain` | Sign in again | Entrar de novo | 重新登录 |
| `cancel` | Cancel | Cancelar | 取消 |
| `disconnect` | Disconnect… | Desconectar… | 断开连接… |
| `confirmTitle` | Disconnect {provider}? | Desconectar {provider}? | 断开 {provider}？ |
| `confirmBody` | This removes its stored credential from pi. Environment variables are not affected. | Isso remove a credencial guardada no pi. Variáveis de ambiente não são afetadas. | 这会从 pi 中移除其已保存的凭据。环境变量不受影响。 |
| `confirmDefaultFallback` | It's your default provider. Chat will switch to {model}. | É o seu provedor padrão. O Chat vai passar a usar {model}. | 这是你的默认提供商。聊天将切换到 {model}。 |
| `confirmDefaultNone` | It's your default provider. Chat will be disconnected until you connect a provider. | É o seu provedor padrão. O Chat ficará desconectado até você conectar um provedor. | 这是你的默认提供商。在你连接新的提供商之前，聊天将处于未连接状态。 |
| `confirmDisconnect` | Disconnect | Desconectar | 断开连接 |
| `disconnecting` | Disconnecting… | Desconectando… | 正在断开… |
| `disconnected` | {provider} disconnected. | {provider} desconectado. | 已断开 {provider}。 |
| `stillViaEnv` | {provider} is still available through {envVar}. | {provider} continua disponível via {envVar}. | {provider} 仍可通过 {envVar} 使用。 |
| `defaultModelLabel` | Default model for new conversations | Modelo padrão para novas conversas | 新对话的默认模型 |
| `defaultModelLocked` | Connect a provider to choose a model. | Conecte um provedor para escolher um modelo. | 连接提供商后即可选择模型。 |
| `defaultChanged` | Default model is now {model}. | O modelo padrão agora é {model}. | 默认模型已改为 {model}。 |
| `done` | Done | Concluir | 完成 |
| `saving` | Saving… | Salvando… | 正在保存… |
| `useOffline` | Use offline for now | Usar offline por enquanto | 暂时离线使用 |
| `piMissing` | The pi CLI wasn't found in $PATH. You can save a key now; sign-in and checks need pi. | O CLI pi não foi encontrado no $PATH. Você pode salvar uma chave agora; login e verificação precisam do pi. | 在 $PATH 中未找到 pi CLI。你可以先保存密钥；登录和检查需要 pi。 |
| `errInvalid` | pi says this credential is invalid ({reason}). Check it and try again. | O pi diz que esta credencial é inválida ({reason}). Confira e tente de novo. | pi 报告此凭据无效（{reason}）。请检查后重试。 |
| `errNotReady` | pi can't use {provider} yet ({reason}). | O pi ainda não consegue usar {provider} ({reason}). | pi 暂时无法使用 {provider}（{reason}）。 |
| `errGeneric` | Something went wrong: {detail} | Algo deu errado: {detail} | 出错了：{detail} |
| `savedUnchecked` | Key saved. pi wasn't found, so it couldn't be checked. | Chave salva. O pi não foi encontrado, então não foi possível verificá-la. | 密钥已保存。未找到 pi，因此无法检查。 |

Chat panel and Settings keys (replacing `piSetup.*` uses):

| Key | en | pt-BR | zh-CN |
|---|---|---|---|
| `chat.connectCta.title` | Connect an AI provider to start | Conecte um provedor de IA para começar | 连接 AI 提供商以开始使用 |
| `chat.connectCta.button` | Connect | Conectar | 连接 |
| `piSetup.pillConnect` (copy change) | Connect provider | Conectar provedor | 连接提供商 |
| `piSetup.pillWaiting` | Waiting for sign-in… | Aguardando login… | 正在等待登录… |
| `piSetup.settingsTitle` (copy change) | AI provider (Chat) | Provedor de IA (Chat) | AI 提供商（聊天） |
| `piSetup.settingsDesc` (copy change) | Connect providers and choose the default chat model. | Conecte provedores e escolha o modelo padrão do Chat. | 连接提供商并选择聊天的默认模型。 |
| `piSetup.settingsConfigureBtn` (copy change) | Manage providers… | Gerenciar provedores… | 管理提供商… |

Keys that become unused are **deleted** from all three locales:
- `piSetup.title`, `subtitle`, `readyBanner`, `useDetectedBtn`, `providerLabel`, `customProvider*`, `configuredBadge`, `authApiKeyTab`, `authOAuthTab`, `apiKeyLabel`, `apiKeyPlaceholder`;
- `piSetup.saveKeyBtn`, `oauthHint`, `openTerminalLoginBtn`, `verifyAuthBtn`, `checking`, `logoutBtn`, `modelLabel`, `saveConnectBtn`, `skipOfflineBtn`, `closeBtn`, `authReadyMsg`, `authNotReadyMsg`, `piMissingHint`, `chatBlockedHint`.

The i18n parity test (`i18nAndMedia.test.ts`) guards the result.

---

## 4. Interaction details

### 4.1 Modal semantics (`ModalDialog` primitive)

`src/components/ModalDialog.tsx` is a small, reusable component. S3 uses it for the provider dialog only.

- **Rendering:** it renders into `document.body` through a portal, as `role="dialog"`, `aria-modal="true"`, `aria-labelledby` (title) and `aria-describedby` (subtitle).
- **Modal count:** it increments `activeModalCount` on mount and decrements it on unmount, so `BrowserPanel` hides its native WebView.
- **Focus trap:**
  - `Tab` / `Shift+Tab` cycle through the dialog's tabbable elements (query on each keypress, so content that changes with the state is handled).
  - Focus that lands outside the dialog is pulled back in, via `focusin` on `document`.
  - The background gets `inert` where supported (WebKitGTK supports `inert`); the trap is the fallback.
- **`Esc`:**
  - The handler is on the dialog element (`onKeyDown`), **not** on `window`. It calls `stopPropagation` so `SettingsModal`'s and `App.tsx`'s window listeners don't react.
  - The innermost layer closes first. The S2 `ModelPicker` already stops propagation on `Esc` (`ModelPicker.tsx:166-169`). An open S-CONFIRM box handles `Esc` as **Cancel**. Only then does `Esc` close the dialog.
  - **`Esc` is a no-op while a request is in flight** (S-CONNECTING, S-DISCONNECTING, Done saving), so a half-applied state is never hidden.
- **Return focus:** the primitive records `document.activeElement` when it opens. On close it focuses that element if it's still connected. Otherwise it focuses the chat composer textarea (`.chat-input`) if mounted, else `document.body`. This covers the Settings path, where the opener unmounts.
- **Initial focus:** per §3.3, applied after mount (`requestAnimationFrame`, or an effect after layout).
- **Global shortcuts** (`Ctrl+B/L/J`, F5 in `App.tsx`) keep working. They don't unmount a portal-rendered dialog. Suppressing them is out of scope.

### 4.2 Opening the dialog (no auto-open)

Store state replaces `piSetupOpen: boolean`:

```
providerDialog: { open: boolean; preselect: string | null; hiddenForSignIn: boolean }
openProviderDialog(provider?: string)   closeProviderDialog()
```

**Openers in S3**

| # | Opener | Call |
|---|---|---|
| 1 | Chat "not connected" call to action | `openProviderDialog()` |
| 2 | Header provider pill | `openProviderDialog()` (opens, never toggles) |
| 3 | Settings → "Manage providers…" | Closes Settings first, then `openProviderDialog()`. It no longer un-collapses the right dock: the dialog is app-level. |
| 4 | Sending while not connected | Opens the dialog (§4.6) |
| 5 | Sign-in success while hidden | §4.4 |

**Removed couplings**

- `openWorkspace` no longer opens anything (`:330`).
- `toggleRight` no longer opens anything (`:428-429`).
- `configurePiProvider` and `refreshPiSetupStatus` no longer open or close the dialog (`:824`, `:842`). Only user actions and `skipPiSetup` (which closes the dialog) do.
- `openWorkspace` / `closeWorkspace` **close** the dialog and cancel any sign-in poll. The dialog is about global pi state, but a workspace switch resets the chat underneath, so closing it avoids a stale panel.

**Not-connected call to action (minimal S8 precursor)**

When `piSetupStatus.needs_setup` is true, `ChatPanel` shows a centred block **in the transcript area** (not above it):
- "Connect an AI provider to start" + **Connect** (primary);
- on first run only, a "Use offline for now" link.

It takes the place of `chat.empty` and doesn't push the transcript. The rest of the empty-state work (starter chips, offline strip) stays in S8.

### 4.3 Connect (API key)

1. The user presses **Connect** (or `Enter` in the key field). The trimmed key must be non-empty, and a custom slug must be valid.
2. State S-CONNECTING. The store calls `connectPiProvider(provider, key)` → `ipc.piConnectProvider({provider, api_key})` (§5.1).
3. The result `{status, check}` arrives:
   - **`check.status === 'ready'`**, or **`check === null`** (pi missing): the key field clears (both the component state and the DOM value) and the panel moves to S-CONNECTED. If `check === null`, the muted note `savedUnchecked` is shown.
   - **`invalid`:** S-ERROR with `errInvalid`. The backend has already restored the previous credential.
   - **`not_ready`:** S-ERROR with `errNotReady`.
   - **IPC rejection:** S-ERROR with `errGeneric`. The detail comes from the backend and never contains the key (§5.4).
4. After success, the store **awaits** `loadModelCatalog()`. pi lists only connected providers, so the catalog changes. `loadModelCatalog` is changed to resolve with the new catalog; it keeps its stale-request guard.
5. **Initial default (makes first run usable without Done).** If there is no usable default, write one at once with `configurePiProvider({provider, model: pickInitialDefault(...), mark_completed: true})` and show `defaultChanged` under the picker. "No usable default" means:
   - `!status.provider_ready`, or
   - `!status.first_run_completed`, or
   - `status.active_provider` is not connected.

   `pickInitialDefault(catalog, provider, curatedSuggestions)` picks, in order:
   1. the provider's first curated suggestion if it is in the catalog;
   2. else the provider's first catalog model, in catalog order;
   3. else the first curated suggestion;
   4. else `null`. Then `model: null` is sent, and the backend clears `defaultModel` (§5.2) so pi uses its own default.
6. If a usable default already exists, the default is **not** changed. Connecting a second provider never changes the user's default silently.

**Validation honesty:** `pi auth check` confirms that pi can resolve a credential for the provider. It does **not** call the provider, and it shouldn't: the app makes no network calls by itself. A wrong key passes as `ready` here and surfaces on the first message (S6 error card → **Reconnect**). See Q3.

### 4.4 Sign in (OAuth) and auto-poll

**Flow**

1. **Sign in** → `startProviderSignIn(provider)` in the store:
   - queues `pi auth login <slug>\r` in the terminal through the existing `launchPiInteractiveLogin` (opens the bottom panel);
   - starts the poller;
   - sets `providerDialog.hiddenForSignIn = true`.
2. **The dialog hides while the user signs in.** `pi auth login` may print a device code or ask a question in the terminal, and a modal backdrop would block the terminal (see Q1). Hiding unmounts the `ModalDialog`, so the modal count decrements and focus moves to the terminal. The dialog's selection and sign-in state live in the store, so nothing is lost.
3. While hidden, the header pill shows `● Waiting for sign-in…` (amber, pulsing; static under `prefers-reduced-motion`). Clicking the pill re-shows the dialog in S-WAITING (`hiddenForSignIn = false`).
4. **When the poll sees `ready`:**
   - the poll stops;
   - the store runs `refreshPiSetupStatus()`, which already refetches the catalog when `configured_providers` changes (`workspaceStore.ts:821-828`);
   - the initial-default rule of §4.3 step 5 applies;
   - the dialog **re-shows** with that provider in S-CONNECTED, focused on the panel heading.

   Re-showing is the continuation of a flow the user started, not an auto-open.

**Poller** (`src/components/providerDialog/signInPoller.ts`)

The poller is pure orchestration. All of its dependencies are injected:

```
createSignInPoller({
  provider, check: (p) => Promise<PiAuthCheckResult>,
  schedule: (fn, ms) => cancelHandle, cancel: (handle) => void, now: () => number,
  intervalMs = 3000, timeoutMs = 120000, maxConsecutiveErrors = 3,
  onState: (s: { kind: 'waiting', elapsedMs } | { kind: 'ready', check }
                | { kind: 'timeout' } | { kind: 'invalid', reason } | { kind: 'error', detail }) => void,
}) → { start(), checkNow(), stop() }
```

**Poller rules**

| Rule | Behaviour |
|---|---|
| Chained polling | The next check is scheduled **after** the previous one settles (`setTimeout` chain, never `setInterval`). `pi auth check` can take up to 5 s, and checks never overlap. |
| First check | 3 s after Sign in, not immediately. The terminal needs time to start. |
| `ready` | → `ready`, stop. |
| `invalid` | → `invalid`, stop (S-ERROR "pi says this credential is invalid"). |
| `not_ready` | Keep waiting. |
| Rejected check | Counted. After 3 consecutive rejections → `error`, stop. |
| Timeout | When `now() - startedAt >= timeoutMs` and no `ready` → `timeout`, stop. Measured with the injected clock, not by counting ticks. |
| `checkNow()` | Runs a check immediately if none is in flight (otherwise it is coalesced with the in-flight one), then resumes the chain. |
| `stop()` | Cancels the pending timer and sets a `stopped` flag. Results that arrive after `stop()` are ignored: no `onState` call, no store write. |
| Elapsed time | The m:ss in S-WAITING is updated by a separate 1 s ticker in the component. It is cleared on unmount, so the poller has no UI timer. |

**Cleanup**
- **Cancel sign-in** calls `stop()` and returns the panel to S-OAUTH.
- Closing the visible dialog (✕, `Esc`, Done) during S-WAITING also stops the poll.
- Hiding for sign-in does **not** stop it.
- `openWorkspace` / `closeWorkspace` stop it.
- Selecting another provider while S-WAITING asks nothing and stops the poll. Only one sign-in poll exists at a time.

The terminal process is not killed; the user owns it.

**Timeout while hidden:** the pill goes back to its normal label and the store keeps `signIn.kind = 'timeout'`. Opening the dialog shows S-TIMEOUT for that provider. The dialog is never shown unprompted on timeout or error.

### 4.5 Disconnect

1. **Disconnect…** → S-CONFIRM. The store computes `pickFallbackDefault(...)`, a pure function:
   - Input: connected providers minus the target; the catalog; the curated order.
   - Output: the next connected provider in list order, plus `pickInitialDefault` for it, or `null`.

   The confirmation text names the result **before** the user confirms.
2. **Cancel** / `Esc` → back to S-CONNECTED. No IPC call is made (AC11).
3. **Disconnect** → S-DISCONNECTING → `logoutPiProvider(provider)` (unchanged backend) → the catalog is refetched and awaited.
   - If the target was the default provider and a fallback exists: `configurePiProvider({provider: fb.provider, model: fb.model, mark_completed: false})`, then show `defaultChanged`.
   - If no fallback exists: the defaults are left in place. The status becomes `provider_ready=false`/`needs_setup=true`, and the chat shows the call to action.
4. The panel then shows S-KEY / S-OAUTH for that provider with the note `disconnected`.
   - If the store's post-logout `ipc.piCheckProvider(provider)` returns `ready`, an env var still provides the credential. The panel then shows S-ENV for the active provider, or the note `stillViaEnv` for others.
   - That check runs only when the provider has an `env_var_hint`, so it stays cheap.
5. If the logout fails: S-ERROR inside the confirmation box with `errGeneric`. The confirmation box stays open, and **Disconnect** can be retried.

S-ENV offers no Disconnect. The Hub can't unset a user's environment variable.

### 4.6 Sending while not connected

`ChatPanel.handleSubmit`:
- If `piSetupStatus?.needs_setup` is true, it calls `openProviderDialog()` and **returns without clearing the draft**.
- No system message is posted. `sendChatMessage`'s blocked branch (`workspaceStore.ts:660-676`) is kept only as a defensive guard for other callers: it returns without a message and opens the dialog.

### 4.7 Model catalog refresh

| Event | Catalog action |
|---|---|
| Dialog opens | Load only if `modelCatalog === null`. The S2 wizard loads on every mount; that is replaced. A failed or curated catalog keeps the S2 fallback banner and **Retry**. |
| Connect success | `await loadModelCatalog()` (needed for the initial default). |
| Sign-in `ready` | Via `refreshPiSetupStatus` when the members of `configured_providers` changed (already implemented). |
| Disconnect success | `await loadModelCatalog()` (needed for the fallback). |
| Replace key / Sign in again | Refetch (not awaited). The provider set is unchanged, but the model set can depend on the plan. |

While a load is in flight, the picker keeps the previous catalog (stale-while-revalidate, already implemented).

### 4.8 What the key field must never do

- Placeholder: `keyPlaceholder` only; the env var appears only in `envHelper` (AC12).
- Input attributes: `type="password"`, `autoComplete="off"`, `spellCheck={false}`, `autoCapitalize="off"`.
- **The key lives only in the panel component's local state.** It is never in Zustand, never in `localStorage` (the browser mock must not persist it: `saveMockPiSetup` stores only status), and never in any `console.*` output.
- It is cleared on success, on provider switch, on dialog close and on hide-for-sign-in.

---

## 5. Backend touch points

### 5.1 New command `pi_connect_provider`

- **Rust:** `connect_pi_provider_in(pi_bin: Option<&Path>, pi_agent_dir, hub_config_dir, req) -> Result<PiConnectResult, String>` in `sidecar/pi_setup.rs`, with a `connect_pi_provider(bin_name, req)` wrapper. It is exposed as `cmd_pi_connect_provider` + `pi_connect_provider` (async, `on_worker`) in `lib.rs` and registered in the handler list.
- **Request:** `PiConnectProviderRequest { provider: String, api_key: String }`.
  - `Deserialize` only (it is never serialized).
  - **Manual `Debug`** that prints `api_key: "<redacted>"`.
- **Behaviour:**
  1. `validate_provider_slug(provider)`. The key is trimmed and must be non-empty; the error is `"api key is empty"`.
  2. Read `auth.json`, remember the previous entry for `provider` (in memory only), insert `{"type":"api_key","key":…}` and write it atomically with mode `0600`. This is the existing `write_json_atomic` logic.
  3. If pi is resolvable, run `check_pi_provider_auth` (`--no-refresh --json`, never `--credentials`, 5 s).
     - If `status == "invalid"`: restore the previous entry (or remove the new one) atomically and return `Ok` with that check, so the UI can show the reason.
     - If the check errors: keep the key and return `check: None` plus `check_error: Some(sanitized message)`.
  4. Return `PiConnectResult { status: get_pi_setup_status_in(...)?, check: Option<PiAuthCheckResult>, check_error: Option<String> }`.
  - It does **not** touch `settings.json`, `pi_setup.json` or the adapter lock.
- **Errors:** messages name the path or operation, never the key value. Raw pi stderr goes to the app's stderr only, as in S1.
- **TS:**
  - `PiConnectProviderRequest`, `PiConnectResult` and `ipc.piConnectProvider(req)` in `src/types/ipc.ts`.
  - The browser mock mirrors `piConfigureProvider`'s key branch: it marks the provider configured and returns `check: {status:'ready', …}`. Keys starting with `invalid-` return `invalid`, so UI tests can drive the error path.

### 5.2 `configure_pi_provider_in` — no mismatched default pair

When `req.model` is `None`/blank and `req.provider` differs from the current `defaultProvider`, the function **removes** `defaultModel` from `settings.json` instead of keeping the old provider's model. When the provider is unchanged, today's behaviour stays: the existing model is kept. The UI stops sending `api_key` to `pi_configure_provider`. The field stays accepted for compatibility but is not used by the S3 UI.

### 5.3 Configure no longer waits behind a running turn (S2 leftover)

- **`cmd_pi_configure_provider`** stops calling `state.pi_adapter.lock()`. It only writes files and returns the status.
- **`cmd_pi_send_message`** already holds the lock for its turn. Before sending, if `pi.mode() == "offline"` and `resolve_pi_binary(bin_name)` finds pi, it replaces the adapter with `create_pi_adapter(&bin_name, &state.pi_cancel)` (lazy upgrade).
- `pi_connect_provider`, `pi_logout_provider`, `pi_check_provider` and `pi_get_setup_status` never take the lock.
- Defaults changed during a turn apply to the next turn: the adapter reads `settings.json` per turn (`pi_adapter.rs:402`).

### 5.4 Secrets (non-negotiable, DECISIONS 2026-11-25)

- No DTO returned to the UI contains a key, token or `auth.json` value. `PiConnectResult` reuses `PiSetupStatus` and `PiAuthCheckResult`, which carry no secrets.
- `PiConfigureProviderRequest` gets a manual `Debug` that redacts `api_key` (S3 touches this type; finding §2).
- Tests use obviously fake keys (`sk-test-…`) and isolated temp dirs, never `~/.pi`.
- Tests assert that every returned `Err` and `check_error` string and the `Debug` output do not contain the key.

---

## 6. Edge cases and error states

| Case | Behaviour |
|---|---|
| `pi` binary missing (`pi_available=false`) | Banner `piMissing` at the top of the panel area. Connect still saves the key (`check: None` → `savedUnchecked`). **Sign in** is disabled, with the banner as its description (`aria-describedby`). The catalog is curated, and S2's fallback banner explains it. |
| First run with credentials already present (`provider_ready` true, `first_run_completed` false; replaces the "Use detected" banner) | The provider is in CONNECTED and selected. The default is pre-filled from `active_model`. **Done** is primary and writes `mark_completed: true`. The chat call to action stays until Done. |
| Offline mode (`first_run_completed` true, no provider ready) | No "Use offline" link. Connecting a provider applies the initial-default rule (`provider_ready` was false), which writes `mode: "pi"`. |
| Custom slug equal to a curated id | Selects the curated row. |
| Custom slug invalid | Inline `slugInvalid`; Connect is disabled. The backend validates again. |
| Extra connected provider not in the curated list (from `auth.json`) | Listed under CONNECTED with its slug as label. Methods are unknown, so both Replace key and Sign in again are offered as secondary actions. |
| Empty or whitespace key | Connect is disabled; `Enter` does nothing. |
| Double-click on Connect / Done | Guarded by the busy state. One IPC call only. |
| Dialog closed while Connect is in flight | Not possible: close is disabled while busy (§4.1). |
| Hiding for sign-in while Connect is in flight | Not reachable: Sign in is a different state. |
| Workspace switch while the dialog is open or a sign-in is pending | The dialog closes and the poll stops (§4.2). |
| Configure while a turn is running | Returns immediately (§5.3). The new default applies from the next turn. |
| Sign-in check returns `invalid` (expired or revoked OAuth) | S-ERROR `errInvalid`. The primary becomes **Sign in** again. |
| `pi auth check` IPC fails three times in a row | S-ERROR `errGeneric`, with **Check again** as the primary. |
| User finishes sign-in after the 2 min timeout | **Check again** finds `ready` → S-CONNECTED. |
| Catalog load fails or times out after connect | The panel still shows S-CONNECTED. `pickInitialDefault` falls back to curated, then `null`. The picker shows the S2 fallback banner with Retry. |
| Disconnect the last connected provider | `needs_setup` becomes true. The dialog stays open on S-KEY/S-OAUTH with the note `disconnected`. The chat shows the call to action after the dialog closes. |
| Disconnect when `auth.json` is missing | Backend no-op. The status shows the provider as not connected. |
| Provider connected via env and also in `auth.json` | Shown as S-CONNECTED (auth.json wins in the UI). After Disconnect, `stillViaEnv`. |
| Narrow window (320 px) in pt-BR | §3.5 layout. No horizontal scroll, and no truncated actions. |
| `prefers-reduced-motion` | Spinners and the pill pulse are static; the text still conveys the state. |

---

## 7. Acceptance criteria and test plan

### 7.1 Acceptance criteria

Mapped to the parent spec (AC10–AC13, AC22–AC24). S3-specific criteria are numbered `S3-n`.

| AC | Criterion | How it is verified |
|---|---|---|
| **AC10** | In every panel state (S-KEY, S-OAUTH, S-CONNECTING, S-WAITING, S-TIMEOUT, S-CONNECTED, S-ENV, S-REPLACE, S-CONFIRM, S-DISCONNECTING, S-ERROR), exactly one element with the primary class is rendered in the dialog. `piSetup.saveKeyBtn` and `piSetup.saveConnectBtn` no longer exist. | Table-driven RTL test over the states (state derived from mocked status/store + user events). Assert `container.querySelectorAll('.btn-primary-xs, .btn-danger-xs').length === 1` (whatever primary class is chosen; one shared constant). The i18n test asserts the keys are gone. |
| **AC11** | Disconnect requires confirmation. Cancel and `Esc` in S-CONFIRM make no `piLogoutProvider` call. Confirm makes exactly one call, and the confirmation names the fallback default. | RTL with an `ipc` spy. |
| **AC12** | The key field's placeholder never contains an env var name, for every curated provider. When `env_var_hint` is set, the env var appears in the helper text (`aria-describedby` of the field). | RTL loop over the mock providers. |
| **AC13** | After **Sign in**, the UI flips to S-CONNECTED without a manual click once `piCheckProvider` returns `ready`. It stops at 2 min with S-TIMEOUT. It never runs two checks at once. Cancel and close stop all timers. | Poller unit tests with an injected scheduler and clock. Store/component test with `vi.useFakeTimers()`. No real sleeps. |
| **AC22** | All new `providerDialog.*`, `chat.connectCta.*` and `piSetup.pillWaiting` keys exist in en, pt-BR and zh-CN. Removed keys are gone from all three. | Extend the existing parity test. |
| **AC23** (S3 part) | The dialog at 320 px in pt-BR has no horizontal scroll and no truncated action labels. | Manual check with a screenshot in the PR; not automatable in jsdom. |
| **AC24** (S3 part) | The dialog is fully keyboard operable: `Tab` is trapped; `Esc` closes the innermost layer (picker → confirmation → dialog); focus returns to the opener; the provider list works with ↑/↓/`Enter` from the search field. | RTL role queries and `userEvent.keyboard`. |
| **S3-1** | Opening a workspace with `needs_setup`, toggling the right dock, or a status refresh never opens the dialog. Only the four openers in §4.2 do. | Store tests (replaces the current "opens on first run" assertion in `piSetup.test.ts:26-44`, an intended behaviour change). |
| **S3-2** | Sending while not connected opens the dialog, keeps the draft in the composer and posts no system message. | ChatPanel RTL test. |
| **S3-3** | Picking a default model never changes the selected provider in the list. The picker offers models of connected providers only (`selectableProvider = null`). | RTL. |
| **S3-4** | The first successful Connect with no usable default writes `configure({provider, model: <initial>, mark_completed: true})` once. With a usable default, it writes nothing. | Store test with `ipc` spies. |
| **S3-5** | `pi_configure_provider` returns while another thread holds `pi_adapter` (fake slow turn), within 1 s. After configure, an offline adapter is upgraded at the next send. | Cargo tests in `lib.rs`, same pattern as `open_workspace_does_not_wait_behind_a_running_pi_turn`. |
| **S3-6** | `connect_pi_provider_in` writes the key with mode 0600, and runs the fake pi with `auth check --provider <p> --no-refresh --json` (argv recorded, no `--credentials`). On `invalid` it restores the previous `auth.json` entry byte-for-byte. It doesn't modify `settings.json` or `pi_setup.json`. | Cargo tests with a fake pi script and temp dirs. |
| **S3-7** | No secret leaks: the `Debug` output of both request types, every `Err` string and `check_error` from connect/configure, and the serialized `PiConnectResult` do not contain the test key. The key is never in the Zustand state, `localStorage` or `console` calls during an RTL connect flow. | Cargo + Vitest (spy on `console.*`, inspect `useWorkspaceStore.getState()` and `localStorage`). |
| **S3-8** | `configure` without a model to a different provider removes `defaultModel`. To the same provider it keeps it. | Cargo test. |
| **S3-9** | The title is "Connect an AI provider". No user-facing string in any locale contains "Pi Durable". | i18n test (grep over translation values). |
| **S3-10** | The dialog increments `activeModalCount` while visible and restores it on close or hide. | Store/RTL test. |

### 7.2 Test plan by level

| Level | File (new or extended) | Covers |
|---|---|---|
| Rust unit | `src-tauri/src/sidecar/pi_setup.rs` tests | S3-6, S3-7 (Rust part), S3-8, `Debug` redaction |
| Rust integration (state) | `src-tauri/src/lib.rs` tests | S3-5 (no lock wait, lazy upgrade) |
| TS pure | `src/__tests__/providerDialogLogic.test.ts` | `derivePanelState`, primary-per-state table, list sections, search, sort, slug validation, `pickInitialDefault`, `pickFallbackDefault` |
| TS pure | `src/__tests__/signInPoller.test.ts` | Chained polling, timeout by clock, `checkNow` coalescing, error counting, stop ignoring late results (injected `schedule`/`now`) |
| Store | `src/__tests__/piSetup.test.ts` (update) + `providerDialogStore.test.ts` | S3-1, S3-4, sign-in slice, workspace switch cleanup, `loadModelCatalog` resolving the catalog, disconnect fallback |
| Component | `src/__tests__/modalDialog.test.tsx` | Trap, `Esc` layering, return focus with an unmounted opener, modal count (S3-10) |
| Component | `src/__tests__/providerDialog.test.tsx` (replaces `piSetupWizardModelPicker.test.tsx`; its still-valid picker cases are ported) | AC10–AC13, AC24, S3-3, S3-7 (UI part) |
| Component | `src/__tests__/chatPanelConnect.test.tsx` | S3-2, call to action rendering, pill opens the dialog and shows the waiting label |
| i18n | `src/__tests__/i18nAndMedia.test.ts` (extend) | AC22, S3-9 |
| Manual | PR screenshot | AC23 at 320 px pt-BR. Also check one real OAuth provider end to end, done by the user, because it needs real auth. |

Canonical commands to run before handoff:
- `npx vitest run`
- `npx tsc --noEmit`
- `cargo test --manifest-path src-tauri/Cargo.toml`
- `cargo test --manifest-path src-tauri/Cargo.toml --features desktop`
- `cargo clippy` (no new warnings; `cargo fmt --check` already fails repo-wide, so don't reformat unrelated code).

---

## 8. Decisions (settled by the user on 2026-11-26)

All four recommendations were accepted. They are binding for S3.

1. **Sign-in vs the modal.** `pi auth login` runs in the bottom terminal, which a modal backdrop blocks. While waiting for sign-in, the dialog is **hidden** and the header pill shows "Waiting for sign-in…". The dialog re-opens on success. On the 2-minute timeout, it re-opens in the timeout state. S4 removes the header pill, so S4 must move this indicator.
2. **The dialog can be closed on first run.** ✕ and `Esc` always close. "Use offline for now" stays as the explicit first-run opt-out. This **supersedes** parent spec §4.7 ("`Esc` closes when not on first run"), because the dialog no longer opens automatically and the chat call to action stays available after closing.
3. **Connect does not validate the key online.** `pi auth check` doesn't contact the provider, so a mistyped key reads as Connected until the first message fails. This is accepted for S3: no network calls happen without an explicit, clearly labelled action. Recovery relies on S6's error card with **Reconnect**. An optional "Test connection" action may come in a later slice.
4. **The first Connect writes the default immediately, but only when there is no usable default** (§4.3 step 5). Then the chat is usable even if the user closes without Done. When a usable default already exists, Done saves the default-model choice, as in parent §4.7.

Record decisions 1, 2 and 4 in `docs/DECISIONS.md` during implementation, together with the `pi_connect_provider` entry (§9, last step).

---

## 9. Suggested TDD order (small steps, no code)

Each step writes failing tests first, then the minimum code, then runs the affected suite.

1. **Rust — redaction.**
   - Test: `format!("{:?}", PiConfigureProviderRequest{api_key: Some("sk-test-x")…})` doesn't contain `sk-test-x`.
   - Implement a manual `Debug`.
2. **Rust — default pair.**
   - Test S3-8.
   - Change `configure_pi_provider_in` to clear `defaultModel` when the provider changes without a model.
3. **Rust — `connect_pi_provider_in`.**
   - Tests with a fake pi that records argv and answers `ready` / `invalid` / garbage, plus no pi: S3-6, S3-7 (Rust).
   - Implement the function, the DTOs in `types.rs` and the wrapper.
4. **Rust — lock leftover.**
   - Test S3-5 (configure returns while a fake turn holds the lock; offline adapter upgraded at the next send).
   - Remove the lock from configure; add the lazy upgrade to send.
   - Register `pi_connect_provider` in `lib.rs`.
5. **TS IPC.**
   - Test `ipc.piConnectProvider` in the browser mock (`ready`, `invalid-` key → `invalid`, mock never persists the key).
   - Add the types and the method.
6. **Pure logic — `providerDialogLogic.ts`.**
   - Tests: list sections, sort and search (reusing `normalizeSearchText`/`fuzzyMatch`), slug validation, `derivePanelState` and primary per state, `pickInitialDefault`, `pickFallbackDefault`.
7. **Pure logic — `signInPoller.ts`.**
   - Tests with a fake scheduler and clock: interval, no overlap, timeout by clock, `checkNow`, error threshold, `stop` ignoring late results.
8. **Store.**
   - Tests: the `providerDialog` slice; no auto-open (rewrite `piSetup.test.ts` first-run case, S3-1); `connectPiProvider` + awaited catalog + initial default (S3-4); disconnect fallback; sign-in slice wiring the poller (fake timers); workspace switch cleanup; `loadModelCatalog` resolves the catalog.
   - Remove `piSetupOpen`.
9. **`ModalDialog`.**
   - Tests: trap, `Esc` on the element with stopPropagation, busy blocks `Esc`, return focus with fallback, modal count (S3-10).
10. **`ProviderDialog`.**
    - Tests per state: AC10 table, AC12, AC11, S3-3, AC13 (fake timers), Done semantics, first-run offline link, pi-missing banner, S3-7 UI part.
    - Build it from the logic modules and the S2 `ModelPicker`.
    - Port the valid cases from `piSetupWizardModelPicker.test.tsx`, then delete `PiSetupWizard.tsx` and its test.
11. **Wiring.**
    - Tests S3-2 and the pill.
    - Render the dialog in `App.tsx`; remove the inline wizard from `ChatPanel`; add the call to action; make the pill open the dialog and show the waiting label; update the Settings button and copy.
12. **i18n.**
    - Extend the parity test (AC22, S3-9).
    - Add the keys and delete the unused `piSetup.*` keys.
13. **CSS and manual checks.**
    - Dialog layout, the 420 px / 320 px wrap rules, danger and ghost-red styles, reduced motion.
    - Manual check at 320 px in pt-BR (AC23), with a screenshot.
14. **Full verification.**
    - Run all canonical commands (§7.2), review the final diff, then an independent review (project convention: Opus) before commit.
    - Record a `docs/DECISIONS.md` entry for `pi_connect_provider` and the lazy adapter upgrade.
