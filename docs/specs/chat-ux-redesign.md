# Spec: Chat Tab UX Redesign

Status: draft for review · Date: 2026-11-25 · Scope: `ChatPanel`, `PiSetupWizard`, model discovery in `sidecar.rs`

This spec covers three problem areas of the AI Chat tab:

1. Chat panel design.
2. How agent output is presented.
3. Model and provider selection.

It describes what the user sees, decides and feels first. Technical notes are included only where they are needed to make the design implementable. It is a spec only and contains no code.

---

## 1. Problems observed

### 1.1 Evidence from the screenshots

**Screenshot 2 — agent turn ("Duas decisões sua")**

| # | What the user sees | Why it hurts |
|---|---|---|
| P1 | Raw markdown: `## Duas decisões sua`, `**Qual diretório...?**`, backticks shown literally. | The answer is harder to scan than in a terminal. `.chat-msg-text` is `white-space: pre-wrap` plain text, with no markdown rendering. |
| P2 | The agent ends with a question ("Qual dos dois caminhos eu sigo?") and two numbered options. The only way to answer is to type. | This is the most important moment of the turn, and it has no affordance. The user has to re-read and type "1" or paraphrase. |
| P3 | Seven rows below the answer: `bash · error`, `bash · completed` ×5, `memory_read_page · completed`. | The rows carry no information: you can't tell which command ran, what failed or whether it mattered. The rows sit *after* the answer even though they ran *before* it. "error" in the first row alarms the user, but the agent recovered. |
| P4 | Each row has the same weight as the answer, and the list is long. | Tool calls push the answer and the question off screen. In a narrow dock (~370 px), the answer is what the user needs. |

**Screenshot 1 — "Connect Pi Durable Provider" card**

| # | What the user sees | Why it hurts |
|---|---|---|
| P5 | Two primary-looking buttons: **Save Key & Connect** next to the key field, and **Save & Connect Chat** in the footer. | Both are `type="submit"` on the same `<form>` and run the same `handleSaveKeyAndConnect` (`PiSetupWizard.tsx`). The user has to guess the difference, and there isn't one. |
| P6 | **Disconnect** wraps onto its own row in red, next to non-destructive actions. | It's a destructive action placed next to "Save", with no confirmation. It also isn't clear *what* it disconnects (the provider's stored credential, removed from `auth.json`). |
| P7 | "OpenCode Go (Configured)" in the dropdown, plus the badges `API Key`, `OAuth` and `Configured (api_key)`. | The same status is shown twice. Capability badges read like buttons. |
| P8 | The API key field shows `OPENCODE_API_KEY ...` in grey. | The env var hint is the placeholder, so it looks like a key is already filled in. |
| P9 | **DEFAULT MODEL** is a free-text box holding `deepseek-v4.1-flash`. | There's no visible list and no metadata. The user reports they "can only see some of the provider's models" (root cause in §6). |
| P10 | "Pi Durable" in the title. | This is internal product jargon. The user wants to "connect an AI provider". |

### 1.2 Evidence from the code

| # | Finding | Location |
|---|---|---|
| C1 | **The model list is the 3 curated suggestions, not the provider's catalog.** `collect_models_from_store` expects `models-store.json` to be either `{ "<provider>": [ ... ] }` or `{ "models": [ {provider, id} ] }`. The real file written by pi 1.5.2 is `{ "<provider>": { "models": [ {id, name, ...} ], "etag", "lastModified", "checkedAt" } }`. Neither branch matches, so it returns `[]` and `available_models` falls back to `CURATED_PROVIDERS.suggested_models`. On this machine, 3 of the 34 models are visible. | `sidecar.rs` `collect_models_from_store` (~L317), `get_pi_setup_status_in` (~L516) |
| C2 | The model field is a native `<input list>` + `<datalist>`. The datalist filters by the current input value, so with `deepseek-v4.1-flash` pre-filled, most options are hidden. WebKitGTK support for datalist is also limited. Both make the list look partial even when data exists. | `PiSetupWizard.tsx` model field |
| C3 | `available_models` is computed only for the **active** provider. `modelOptions` merges it with the **selected** provider's suggestions. If you pick a different provider in the dropdown, models from both providers are mixed. | `PiSetupWizard.tsx` `modelOptions`; `sidecar.rs` ~L516 |
| C4 | The model is global. `ProcessPiAdapter` passes `--provider/--model` from `~/.pi/agent/settings.json` on every turn, and changing it means reopening the setup card. There's no per-conversation choice. Pi itself records model changes in the session, but our explicit flags override that. | `sidecar.rs` `send_message` (~L1147) |
| C5 | **Turns don't stream.** `pi_send_message` blocks until pi exits (timeout 180 s) and parses stdout at the end. `App.tsx` listens for `pi://event` (`message_delta`, `tool_call`, ...), but the Rust side never emits it. The user sees "Sending..." for up to 3 minutes. | `sidecar.rs` ~L1240; `lib.rs` `cmd_pi_send_message` |
| C6 | `pi_send_message` is a **synchronous** `#[tauri::command]` (not `async`). In Tauri v2, sync commands run on the main thread, so a long turn is likely to freeze the window and queue other IPC. The adapter mutex is also held for the whole turn, so a future "Stop" command couldn't get the lock. *Verify before slice S0.* | `lib.rs` ~L786, ~L286 |
| C7 | **Narration text is lost and the order is flattened.** `parse_pi_jsonl_output` keeps only the **last** assistant `message_end` text and collects tool calls into a separate flat list. Text the agent wrote between tool calls ("Vou verificar a pasta...") disappears, and every tool call renders after the answer. | `sidecar.rs` ~L987 |
| C8 | Tool rows show only `name` + `status`. Pi's events carry `args` (for example `{command: "ls -la"}`), `durationMs` and `partialResult`, but none of these is summarized. | `ChatPanel.tsx` tool list; pi `docs/json.md` |
| C9 | If an assistant message ends with `stopReason: "error"`, the parser returns `Err`. All tool calls from that turn are dropped, and the user gets a single system string "Erro ao enviar mensagem no Chat: ...". | `sidecar.rs` ~L1101 |
| C10 | The transcript isn't persisted. `openWorkspace` resets `chatMessages`, but pi continues the same session (`--continue`). After a restart the chat looks empty, yet the agent "remembers". | `workspaceStore.ts` ~L270 |
| C11 | Hardcoded Portuguese strings in the store and panel (system notes, Flow/Loop turn texts, `'Falha ao ler imagem'`, `'Captura colada'`) skip i18n. | `workspaceStore.ts` ~L286-305, ~L494-560; `ChatPanel.tsx` |
| C12 | The setup card is rendered *inline* at the top of the chat panel. It pushes the transcript down and auto-opens on every `needs_setup`. | `ChatPanel.tsx`; `workspaceStore.ts` ~L410 |

### 1.3 What pi can actually provide (verified, read-only)

- `pi --offline --list-models` lists **34** models for `opencode-go` (only providers with usable auth). It prints a table with no JSON flag.
- `pi --mode rpc --no-session --offline` followed by `{"type":"get_available_models"}` on stdin returns **34** full `Model` objects as JSON: `id, name, provider, reasoning, input[] ("image"), contextWindow, maxTokens, cost{input,output,...}`. The process exits cleanly on stdin EOF. This is the most reliable discovery source.
- `pi update --models` refreshes catalogs. It uses the network, so it may only run on an explicit user action.
- JSON mode emits `turn_start/turn_end`, `message_update` (`text_delta`, `thinking_delta`, `toolcall_start`), `tool_execution_start/update/end` (with `args`, `partialResult`, `durationMs`), `compaction_start/end` and `agent_settled`. This is everything needed for live, ordered rendering.
- Pi sessions record model and thinking-level changes, and `--thinking <level>` exists.

---

## 2. Goals and non-goals

**Goals**

- G1 — The user can read the agent's answer at a glance. The answer is primary; the work log is secondary and collapsed by default.
- G2 — When the agent asks a question with options, the user can answer with one click or one key.
- G3 — The user sees progress while the agent works and can stop it.
- G4 — The user sees **all** models their connected providers offer, can search them, and can switch models from the chat without opening setup.
- G5 — Setup has one obvious primary action per state, clear connected/unconnected status, and a safe, explicit Disconnect.
- G6 — Failures explain what happened and offer a next step (Retry, Switch model, Reconnect).
- G7 — Works at 320–480 px dock width, keyboard-only, in en / pt-BR / zh-CN.

**Non-goals**

- No new theming system. The redesign uses the existing dark tokens (`--hub-*`).
- No multi-conversation history browser in this spec. A "New conversation" action is in scope, a session list is not (see Open questions).
- No change to Loop/Flow slash-command semantics. Only how their turns render changes.
- No secrets in DTOs, events, logs or the model cache, ever (DECISIONS 2026-11-25).
- The app makes no network calls by itself. Catalog refresh happens only when the user clicks **Refresh**.

---

## 3. User journeys

### J1 — First run (no provider)

1. The user opens a workspace. The Chat panel shows the **empty state** (§4.5) with a single call to action: **Connect an AI provider**. The transcript isn't pushed down, and the setup card no longer auto-expands inline.
2. Clicking it opens the **Connect provider** dialog (§4.7). The user sees a searchable provider list. Each provider shows a status ("Connected" or nothing) and its sign-in methods.
3. They pick *OpenCode Go*, paste a key and press **Connect**. Inline feedback reads "Checking..." and then "Connected ✓".
4. The **Model** section unlocks right away and lists all 34 models, grouped and searchable. The current default is pre-selected.
5. **Done** closes the dialog. The composer shows the model chip `DeepSeek V4.1 Flash ▾`. The user types their first message.
6. Alternative: **Use offline for now** is a quiet link, shown only on first run. The composer then shows a persistent offline notice with a **Connect** link.

*Feels like:* one decision per step, and no guessing which button "really" saves.

### J2 — Daily chat

1. The user types and presses Enter. Their message appears right away. Below it, a **live status line** reads `● Working · running $ npm test · 12s` with a **Stop** button. The Send button turns into Stop.
2. As the agent narrates and runs tools, the **activity group** grows with humanized rows, collapsed into one line by default once there are more than 3 rows.
3. When the turn ends, the activity group collapses to a one-line summary: `▸ Worked 42s · 6 commands · read 1 file · 1 failed (recovered)`. The **final answer** renders below it as formatted markdown.
4. The user can expand the summary to audit what happened, then open a row to see the command and its output.

### J3 — Switch model mid-conversation

1. The user clicks the model chip in the composer, or presses `Ctrl+Shift+M`. A popover opens above the composer with the search field focused.
2. They type `kimi` and see `Kimi K3`, `Kimi K3.1 Pro` and `Kimi K2.7 Code`, with badges (🧠 reasoning, 🖼 images, 1M ctx, $/M).
3. They press Enter. The chip updates, and a thin divider appears in the transcript: `Switched to Kimi K3.1 Pro · opencode-go`.
4. The next turn uses that model. The global default is unchanged unless they choose **Set as default** (star menu or `Ctrl+Enter` in the picker).
5. If a one-shot image is attached and the model doesn't accept images, the chip turns amber with the tooltip "This model can't see images. The attachment will be sent as a file path only."

### J4 — The agent asks a question

1. The final answer ends with a question and a numbered list (screenshot 2).
2. Below the answer, a **choice card** appears: two buttons labelled with the bold lead of each option ("Qual diretório você estava rodando?", "Investir em arte real de ambiente?"), plus **Other...**.
3. Clicking an option puts `1 — Qual diretório você estava rodando?` into the composer, focuses it and leaves the text editable. Pressing Enter sends it. Keys `1`–`9` pick an option while the card has focus.
4. After the user replies, the card becomes read-only and shows the chosen option as selected.
5. If the agent used the structured `ask_user` tool (§5.4, later slice), clicking sends the choice right away, because the options are explicit.

### J5 — A tool fails / the turn fails

- **Tool fails, agent recovers** (screenshot 2): the summary shows `1 failed (recovered)` in amber, not red, and doesn't auto-expand. The failed row is marked ✕ with its stderr tail visible when expanded.
- **Turn fails** (provider error, auth expired, timeout, pi crash): an **error card** takes the assistant's slot and keeps the partial activity. Its title is human ("The model provider rejected the request"), with the technical detail collapsible and actions **Retry**, **Switch model** and, for auth errors, **Reconnect provider**.
- **Stopped by the user**: a neutral card `Stopped after 18s` keeps the partial activity, with a **Retry** action.

---

## 4. Design

The layout targets a vertical dock of 320–480 px. All measurements are guidelines. Use existing tokens: `--hub-border`, surface `rgba(16,20,31,.45)`, and status colours green/amber/red. ASCII mockups use `▸` for a collapsed item, `▾` for an expanded one and `●` for a status dot.

### 4.1 Panel anatomy

```
┌──────────────────────────────────────────┐
│ Chat                       ⋯  [+ New]    │  header: title, overflow menu, new conversation
│ ● 2 subagents running  ▸                 │  subagent strip, only when relevant (4.6)
├──────────────────────────────────────────┤
│                                          │
│  transcript (role="log")                 │
│                                          │
│                                          │
├──────────────────────────────────────────┤
│ ● Working · $ npm test · 12s     [Stop]  │  live status line, only during a turn
├──────────────────────────────────────────┤
│ [🖼 capture-1712.png ✕]                   │  one-shot chips
│ ┌──────────────────────────────────────┐ │
│ │ Message Chat…                        │ │  autosize textarea, 1 to 8 lines
│ └──────────────────────────────────────┘ │
│ [DeepSeek V4.1 Flash ▾] 📎  ctx: 2 unsaved  [Send ⏎] │  composer footer
└──────────────────────────────────────────┘
```

- The header loses the provider pill. Connection status now lives in the model chip, the single place where provider and model are shown. The overflow menu `⋯` holds **Provider settings...**, **Copy transcript** and **Clear view**.
- **+ New** starts a new pi session (new `--session-id`). It asks for confirmation only if a turn is running.
- `dirtyFiles` moves from the header to the composer footer as a context hint, `ctx: 2 unsaved`. Its tooltip lists the files and the focused panel. This tells the user what the agent will see *before* they send.

### 4.2 Message rendering and hierarchy

```
                               You · 14:02
              ┌────────────────────────────┐
              │ o que falta pra arte do    │   user: right-aligned bubble,
              │ cenário ficar pronta?      │   max 85% width, subtle fill
              └────────────────────────────┘

 ✦ DeepSeek V4.1 Flash · 14:03                assistant: full width, no bubble
 ▸ Worked 42s · 6 commands · 1 file · 1 failed (recovered)

 Duas decisões suas                           h2 rendered as 14px bold
 1. Qual diretório você estava rodando?       real list, bold, inline code
    Se era o `Godot/auto_battler_xianxia`…
 2. Investir em arte real de ambiente?
    O pipeline (Blender → recorte → …)
 Qual dos dois caminhos eu sigo?

 ┌ Choose a reply ───────────────────────┐   choice card (4.4)
 │ [1  Qual diretório você estava…    ]  │
 │ [2  Investir em arte real de amb…  ]  │
 │ [   Other…                          ]  │
 └────────────────────────────────────────┘
                                   ⧉ copy
```

- **User**: right-aligned bubble with the attachment thumbnails *inside* it. Thumbnails replace the path chips; clicking one opens the media viewer.
- **Assistant**: no bubble, full width. Meta line: `✦ <model display name> · time`. This shows which model answered, which matters after a mid-conversation switch. Offline replies show `offline` in this line.
- **System** notices (setup hints, offline loops completed, compaction, model switch) render as **centred dividers** in a muted colour, not as chat bubbles.
- **Markdown rendering for assistant text**: headings scale down (h1/h2 become 14 px bold, h3 becomes 13 px semi-bold). Also supported: lists, bold/italic, inline code, fenced code blocks with a language label and a **Copy** button, tables (scroll horizontally inside the block, never the page), links and blockquotes. Rendering builds React elements from a parsed AST, with **no `innerHTML`**. Raw HTML in agent output is shown as text.
- **Workspace paths** in inline code or text that resolve inside the workspace (`docs/gdd.md`, `assets/bg.png`) become links that open the matching panel (Markdown / Media). Paths outside the workspace stay plain text.
- Message actions (Copy, and Retry for the last turn) appear on hover or focus at the bottom-right. They're always reachable by keyboard.
- Density: 12 px gap between messages, 6 px between activity rows. Body text uses the current chat font size. Activity rows are 1 px smaller and muted.

### 4.3 Agent output: activity group (tool calls)

A turn is an **ordered list of blocks**: narration text, tool calls, thinking, and then the final answer. The final answer is the text after the last tool call. Everything before it goes into the **activity group**, which renders *above* the answer in the order it happened.

**Collapsed (default after the turn ends):**

```
 ▸ Worked 42s · 6 commands · read 1 file · 1 failed (recovered)
```

**Expanded:**

```
 ▾ Worked 42s · 6 commands · read 1 file · 1 failed (recovered)
   │ Vou checar onde estão os assets.                  narration, muted italic
   │ ✕ $ ls Godot/auto_battler_xianxia/art     0.1s    failed, red ✕, amber text
   │ ✓ $ ls ~/Repos/auto-battler-assets        0.1s
   │ ▸ ✓ Ran 3 commands                        1.4s    consecutive same-kind rows grouped
   │ ✓ Memory · read page "pipeline-arte"      0.3s
   │ ✓ $ git -C ~/Repos/auto-battler-assets log -5  0.2s
```

**A single row expanded:**

```
   │ ▾ ✕ $ ls Godot/auto_battler_xianxia/art   0.1s
   │   ┌────────────────────────────────────────────┐
   │   │ $ ls Godot/auto_battler_xianxia/art        │  full command, monospace
   │   │ ls: cannot access '…': No such file or dir │  output: last 12 lines,
   │   │                                [Copy] [All]│  "Show all 214 lines"
   │   └────────────────────────────────────────────┘
```

Rules:

1. **Humanized label per tool kind.** It is derived from `args`, never from the bare tool name. The default table is below. Unknown tools show `name` plus the first string argument, truncated.

   | Tool | Row label | Expanded |
   |---|---|---|
   | `bash` | `$ <first line of command>` (ellipsis at row width) | full command, output tail, exit status |
   | `read` | `Read <path>` | path (link), line range |
   | `edit` / `write` | `Edited <path>` / `Created <path>` (+N −M when available) | diff or content preview (first 20 lines) |
   | `grep` / `find` / `ls` | `Searched "<pattern>"` / `Listed <dir>` | matches count, output tail |
   | `memory_*` | `Memory · <verb> <title>` | args + result |
   | `generate_flow_reference` | `Generated image <save_path>` | thumbnail + embeds |
   | `dispatch_tchelvis_loop` | `Started loop <workflow>` | run id (link opens Loops panel) |

2. **Status is an icon, not a word**: spinner while running, ✓ when done, ✕ on failure. Each row shows its duration (`durationMs`) on the right, in tabular numerals.
3. **Grouping.** If there are 3 or more consecutive rows of the same kind, they collapse into `Ran N commands` / `Read N files`. A failed row is never merged into a group; it stays visible as its own row.
4. **Summary line** counts by category, in this order: commands, files read, files changed, other. It ends with failures. A failure is *recovered* when the turn still produced a final answer without `stopReason: error`; this is shown in amber. If the turn failed, it is shown in red and the group auto-expands.
5. **Default expansion.** While running, the group is expanded and shows the last 3 rows. When the turn finishes, it collapses. The user's manual expand/collapse is remembered per turn for the session.
6. **Files changed** get a footer under the answer: `Changed 2 files: docs/gdd.md, assets/palette.json` with links. This is the most useful "result" of a coding turn, and it shouldn't be buried in the log.
7. **Thinking blocks**, when the model emits them, render as one muted row `Thought for 6s ▸` inside the activity group. They are collapsed and never auto-expanded.

### 4.4 Questions and choices

**Detection (v1, heuristic, language-agnostic):** the final answer qualifies when

- (a) its last non-empty paragraph ends with `?` or the full-width `？`, and
- (b) it contains one ordered or bulleted list of 2–6 items, in the last 60% of the text.

Each item's label is its leading bold span if present, otherwise its first sentence (max 80 chars). If detection is uncertain (for example, two lists), no card is shown. A missed card costs the user nothing; a wrong card is noise.

**Card behaviour:**

- The buttons stack vertically (the dock is narrow). Each shows its number badge and label, and the full item is in the tooltip.
- Clicking an option **prefills** the composer with `<n> — <label>`, focuses it and puts the caret at the end, so the user can add detail. It doesn't send directly in v1, because the heuristic could be wrong.
- **Other...** focuses an empty composer.
- With the card focused, keys `1`–`9` select an option and `Esc` returns to the composer. Within the card, arrow keys move focus.
- Once the user sends any message, the card turns read-only. If the reply started with `<n> —`, the chosen option is highlighted.

**v2, structured (slice S9):** a Hub tool `ask_user({question, options[{id,label,detail}], allow_free_text})` is injected through the existing `GAME_HUB_TOOLS_JSON` mechanism. Its card **sends on click**, and the result goes back to the agent as the next prompt. The heuristic card stays as a fallback for agents that don't use the tool.

### 4.5 States

| State | What the user sees |
|---|---|
| **Empty, connected** | Centred: "Ask about your GDD, world or code" + 3 starter chips ("Summarize the open document", "What changed since my last commit?", "/loop …") + the hint "Ctrl+V pastes a screenshot". The model chip is visible in the composer. |
| **Empty, not connected** | Centred card: "Connect an AI provider to start" + **Connect** (primary) + "Use offline for now" (link, first run only). The composer stays enabled; sending opens the same card instead of posting a system error. |
| **Offline mode** | A persistent strip above the composer: "Offline mode — replies are local placeholders. **Connect**". The model chip reads `Offline`. |
| **pi binary missing** | Strip: "The `pi` CLI wasn't found. Install it or set its path in Settings → Pi." (link to the Settings section). The model chip is disabled. |
| **Restored session** (C10) | The transcript starts with a divider: "Continuing previous session · earlier messages aren't shown here · **Start new**". |
| **Running** | The live status line (§4.1) shows the current action (`$ cmd`, `Reading <path>`, `Thinking`, `Writing answer`) and elapsed time. The composer stays editable, Send becomes **Stop**, and the draft is kept. |
| **Long run** | After 60 s the status line adds "· still working". At 150 s it warns "Will time out in 30s". |
| **Stopped** | Neutral card "Stopped after 18s" + **Retry**, with the partial activity kept. |
| **Turn error** | Error card (§3 J5). It maps known reasons to human titles: auth (`401`, `not_ready`) → "Your <provider> credential isn't valid anymore"; rate limit (`429`) → "Rate-limited by <provider>, try again in a moment"; model not found → "<model> isn't available on <provider>"; timeout → "The agent didn't finish within 3 minutes"; otherwise → "Something went wrong". The raw text is always available under **Details**. |
| **Upload error / quota exceeded** | An inline message under the composer chips, not a top banner. Quota includes a **Manage captures** link. |
| **Compaction** | A divider in the transcript at the point it happened: "Context compacted — earlier turns were summarized (150k → 32k tokens)". The sticky banner is removed. |

### 4.6 Subagent badges

- The strip under the header is shown **only while at least one subagent is running**, or for 10 s after the last one finishes.
- It's collapsed into one line: `● 2 running · 1 done ▸`. Expanding it shows chips `● reviewer — running` with the detail in a tooltip or on expand. Status dots: running = animated amber (static under `prefers-reduced-motion`), done = green, error = red.
- An errored subagent keeps the strip visible until the user dismisses it.

### 4.7 Provider connection dialog (replaces the inline setup card)

This is a modal dialog (focus-trapped, `Esc` closes when not on first run), opened from: the empty state, the model chip's "Connect more providers...", the header `⋯` menu, and Settings → Pi.

```
┌ Connect an AI provider ─────────────────────── ✕ ┐
│ 🔍 Search providers                               │
│ CONNECTED                                         │
│ ● OpenCode Go           API key     Manage ▸      │  ← selected
│ AVAILABLE                                         │
│   Anthropic (Claude)    Key · Sign-in             │
│   OpenRouter            Key · Sign-in             │
│   OpenAI                Key                       │
│   …                                               │
│   Other provider (slug)…                          │
├───────────────────────────────────────────────────┤
│ OpenCode Go · Connected with API key ✓            │
│ Key is stored by pi in ~/.pi/agent/auth.json      │
│ [Replace key]                     [Disconnect…]   │  destructive, right, ghost-red
│                                                   │
│ Default model for new conversations               │
│ [ DeepSeek V4.1 Flash · opencode-go         ▾ ]   │  opens the ModelPicker (4.8)
├───────────────────────────────────────────────────┤
│ Use offline for now (first run only)      [Done]  │
└───────────────────────────────────────────────────┘
```

**The selected provider panel has three exclusive states, each with one primary action:**

| Provider state | Panel content | Primary action |
|---|---|---|
| Not connected, key method | Key field (placeholder "Paste your API key"). The helper text below reads "Or set `OPENCODE_API_KEY` in your environment" (fixes P8). If OAuth is also supported, a link reads "Sign in with browser instead". | **Connect** |
| Not connected, OAuth only | "Sign-in runs in the built-in terminal (`pi auth login <provider>`)." | **Sign in** opens the terminal. The dialog then **polls `pi auth check` every 3 s for up to 2 min** and shows "Waiting for sign-in...". A manual "I've signed in — check now" link stays as a fallback. |
| Connected | Status line + **Replace key** (key method) or **Sign in again** (OAuth) + **Disconnect...** | (none in the panel; the footer has **Done**) |

- **Connect** validates with `pi auth check` before reporting success. Feedback stays inline under the field: `Checking...` → `Connected ✓`, or a human-readable error. On success the key field clears and collapses.
- **Disconnect...** opens a confirmation: "Disconnect OpenCode Go? This removes its stored credential from pi. Environment variables are not affected." with **Cancel** / **Disconnect**. If it was the active provider, the chat falls back to the next connected provider, or to the not-connected state.
- **Footer:** a single **Done**, which saves the default-model choice if it changed. There's no second "Save & Connect" button. Credentials are saved by **Connect**; Done only saves the model and closes. If Done is pressed while a key is typed but not yet connected, the dialog runs Connect first. "Use offline for now" is a footer-left link, shown on first run only.
- Capability badges become plain text in the list (`Key · Sign-in`) instead of pill-shaped "buttons" (fixes P7). "Configured" appears only once, as the CONNECTED section.
- The title changes to **Connect an AI provider**. The subtitle reads "Chat uses the pi agent. Keys stay on this machine." (fixes P10).

### 4.8 Model picker (shared component)

One component is used in two places:

- **compact** mode, as a popover from the composer model chip, and
- **field** mode, inside the provider dialog for the default model.

```
┌───────────────────────────────────────────┐
│ 🔍 Search models…                 ⟳ 2h ago │  ⟳ = Refresh catalog (network, explicit)
│ ★ FAVORITES                               │
│   DeepSeek V4.1 Flash   🧠🖼  1M   $0.1/0.5 │
│ RECENT                                    │
│   Kimi K3.1 Pro         🧠🖼  1M   $0.6/2.5 │
│ OPENCODE GO · 34 models                   │
│ ✓ DeepSeek V4.1 Flash   🧠🖼  1M   $0.1/0.5 │  ✓ = current for this conversation
│   GLM 5.3               🧠    1M   …       │
│   …                                       │
│ NOT CONNECTED                             │
│   Anthropic · 2 suggested   Connect ▸     │
├───────────────────────────────────────────┤
│ Thinking: [off][low][med][high]           │  only if the selected model has reasoning
│ ↵ use here · Ctrl+↵ set as default · ☆ fav│
└───────────────────────────────────────────┘
```

- **Search**: fuzzy match over `name`, `id` and `provider`, case- and diacritic-insensitive. Matches are highlighted. The search field shows `N of M`.
- **Rows** show the display `name` (falling back to `id`), with the `id` in a muted tooltip, plus badges:
  - 🧠 reasoning (`reasoning: true`)
  - 🖼 image input (`input` includes `image`)
  - context window (`1M`, `262K`)
  - price `$in/$out` per 1M tokens. The price is omitted when the cost is 0 or unknown; it isn't shown as "$0".
- **Sections:**
  - **Favorites**: at most 10, toggled with ☆ on hover or with `Ctrl+D`.
  - **Recent**: the last 5 used, excluding favorites.
  - **One section per connected provider**, with a count. Sections are collapsible and sorted by provider label.
  - **Not connected**: one line per curated provider with **Connect ▸**, which opens the provider dialog preselected. Its suggested models are visible but disabled.
- **Actions:**
  - `Enter` or click uses the model *for this conversation* (§5.3).
  - `Ctrl+Enter` or "Set as default" also writes the global default (pi `settings.json`).
  - In field mode, `Enter` sets the default.
- **Custom model id**: if the search text matches no model, the last row reads `Use "<text>" as a custom model id`. This keeps today's free-text escape hatch for models missing from the catalog.
- **Thinking level**: a segmented control shown only for reasoning models, passed to pi as `--thinking`. It is stored per conversation together with the model.
- **Catalog freshness**: "Updated 2h ago · ⟳". Refresh runs `pi update --models` (network) and then re-lists. While it runs, the existing list stays usable and a spinner replaces ⟳.
- **Composer chip** shows `<display name> ▾` and is truncated with an ellipsis. Its tooltip reads `<provider>/<id> · thinking: <level>`. Its state colours:

  | Chip | Meaning |
  |---|---|
  | normal | ready |
  | amber | the model doesn't fit the pending input (image) |
  | red-outlined "Reconnect" | the provider credential is invalid |
  | `Offline` | offline mode |

---

## 5. Data and behaviour notes (implementation-facing, minimal)

### 5.1 Turn representation (fixes C7, C8, C9)

`ChatMessage` gains an ordered `blocks` array, replacing the separate `text` + `tool_calls` for pi turns. `text`/`tool_calls` are kept as a read-only fallback for Flow/Loop turns until those migrate. Block kinds:

- `text {content}`
- `thinking {content, duration_ms}`
- `tool {id, name, args (parsed JSON), status, duration_ms, output_tail (string, capped ~16 KB), output_truncated: bool, is_error}`

The turn also carries `model {provider, id, display_name}`, `outcome: completed | stopped | failed {reason_code, detail}` and `started_at/ended_at`. The parser must:

- keep every assistant text segment in order;
- keep tool calls and their results when `stopReason: error` happens, and surface the outcome as `failed` instead of dropping the turn;
- read `durationMs` and `args` from `tool_execution_*`.

Tool output is capped before it crosses IPC. The full output stays in the pi session file.

### 5.2 Streaming and stop (fixes C5, C6)

- `pi_send_message` becomes an **async / worker-thread** command, so the main thread isn't blocked during a turn.
- The adapter emits `pi://event` per JSONL line as it reads stdout: `turn_started`, `block_started`, `text_delta`, `tool_started`, `tool_updated`, `tool_finished`, `turn_finished`, `compaction`. It reuses and extends the existing `PiEventPayload` union, and the store's `handlePiEvent` already models deltas.
- A new `pi_cancel_turn` command kills the process group. The child handle or pid must be reachable **without** taking the adapter lock that the running turn holds; for example, store an `Arc<Mutex<Option<pid>>>` next to the adapter.
- Event payloads must never include env, API keys or `auth.json` content. Tool args can contain user-typed secrets (for example a `curl -H` header); this risk already exists in the session file. The UI shows args as-is, but the output tail is the only thing persisted in the transcript cache.

### 5.3 Model selection data flow (fixes C1–C4)

```
              ┌──────────────── user clicks ⟳ ────────────────┐
              ▼                                               │
  pi update --models (network, explicit only)                 │
              │                                               │
  pi_list_models ──► 1. pi --mode rpc --no-session --offline  │
   (Rust, async,        stdin: {"type":"get_available_models"}│
    10s timeout)        → Model[] (all configured providers)  │
                     2. fallback: models-store.json, parser   │
                        fixed for {prov:{models:[…]}}         │
                     3. fallback: CURATED suggested_models    │
              │                                               │
              ▼                                               │
  PiModelCatalog { source, fetched_at, models: PiModelInfo[] } ┘
     PiModelInfo { provider, id, name, reasoning, image_input,
                   context_window, max_output, cost_in, cost_out }
     (no baseUrl, headers or credentials)
              │
              ├─► in-memory store slice `modelCatalog` (refetched after
              │   configure/logout/refresh; stale-while-revalidate)
              ▼
  ModelPicker ──use here──► <workspace>/.hub/chat.json
                            { provider, model, thinking }   (per workspace/conversation)
              └─set default─► ~/.pi/agent/settings.json defaultProvider/defaultModel (existing writer)
  favorites/recents ───────► ~/.config/game-hub/pi_models.json { favorites[], recents[] }

  send_message: model = chat.json ?? settings.json defaults  → --provider/--model/--thinking
```

- **Root-cause fix, smallest version:** correct `collect_models_from_store` for the real shape. That alone takes the list from 3 to 33 models offline. Add a fixture test using the real schema (structure only, no secrets).
- **Preferred source:** the RPC `get_available_models` call, which returns 34 models with metadata and includes extension-registered and `models.json` providers. Decide on `--no-extensions` (see Open questions).
- `get_pi_setup_status` stops building `available_models` and stops calling `pi auth check` synchronously on every status read. The picker reads `pi_list_models` instead.
- When the conversation model is set, pi's own session records it as well. Passing it explicitly every turn keeps the UI as the source of truth.
- Loop slash-command overrides (`implement=pi:opencode-go/deepseek-v4.1-flash`, hardcoded in the store) are out of scope. They are flagged so a later change can reuse the picker.

### 5.4 Choices

Phase 1 needs no backend change: detection runs on the final text block in the frontend, as a pure function with unit tests. Phase 2 adds the `ask_user` tool definition next to `flow_tool_definition` / `loop_tool_definition`.

---

## 6. Root cause: "I can only see some of the provider's models"

There are three compounding causes, ordered by impact:

1. **Parser/schema mismatch (C1).** On this machine, `~/.pi/agent/models-store.json` holds 33 `opencode-go` models under `{"opencode-go":{"models":[…]}}`. `collect_models_from_store` looks for `obj["opencode-go"]` as an *array* or for a top-level `models` array, so it finds nothing. The UI therefore only receives the 3 curated `suggested_models` (`deepseek-v4.1-flash`, `hy4-flash-free`, `claude-haiku-5-5`), compared with the 34 that `pi --list-models` reports.
2. **Datalist filtering (C2).** Even the 3 suggestions mostly don't show, because the datalist filters by the pre-filled value. In WebKitGTK the dropdown may not render at all.
3. **Active vs selected provider (C3).** After switching providers in the dropdown, the list mixes the previous provider's models with the new provider's suggestions.

Also, `pi` only lists models for providers with usable auth. Unconnected providers can only show curated suggestions until the user connects them. The picker says so explicitly ("Connect to see all models").

---

## 7. i18n and accessibility

**i18n**

- Every new string goes in `src/i18n/index.ts` for `en`, `pt-BR` and `zh-CN`, under the namespaces `chat.*`, `chat.activity.*`, `chat.choice.*`, `chat.error.*`, `modelPicker.*` and `providerDialog.*`. Strings that were hardcoded (C11) move there too.
- **Plurals**: counts ("6 commands", "1 failed") use `Intl.PluralRules(locale)` with `_one`/`_other` keys instead of the current `arquivo(s)` pattern. zh-CN uses `_other` only.
- **Durations and numbers**: `Intl.NumberFormat` / `Intl.RelativeTimeFormat` with the active locale ("2h ago" / "há 2 h" / "2小时前"). Compact context sizes (`1M`, `262K`) use `Intl.NumberFormat({notation:'compact'})`.
- **Not translated**: model names and ids, provider labels, tool names, commands, paths and agent text.
- **Choice detection is language-agnostic.** It works on structure, `?` and `？`, not on words.
- **Layout**: no fixed-width buttons. pt-BR strings run about 30% longer, so test the narrowest dock at 320 px in pt-BR. Ellipsis plus a tooltip is fine for labels; it isn't acceptable for actions.

**Accessibility and keyboard**

| Key / element | Behaviour |
|---|---|
| `Enter` / `Shift+Enter` | Send / newline (unchanged). |
| `Ctrl+L` | Toggle the Chat drawer (unchanged). Focus lands in the composer. |
| `Ctrl+Shift+M` | Open the model picker from anywhere in the Chat panel. |
| `Esc` | Closes the innermost popover or dialog. With nothing open and a turn running, the **first** `Esc` focuses **Stop** and the second activates it, so a single stray keypress can't cancel. |
| `Alt+↑` from the composer | Move focus to the last assistant message. `↑/↓` then moves between messages, and `Enter` toggles the activity group. |
| `1`–`9` | Pick an option on a focused choice card. |
| Transcript | `role="log"`, `aria-live="polite"`. Announce only `turn_finished` ("Answer ready" + the first sentence) and errors, never per-delta updates. |
| Live status line | `role="status"`. |
| Activity summary / rows | `<button aria-expanded>`. Status icons carry `aria-label` ("failed", "completed"). The ✓/✕ glyphs are supplemented by colour *and* shape. |
| Model picker | Combobox + listbox pattern with `aria-activedescendant`. Sections are `group` elements with labels. Badges have text alternatives ("reasoning", "accepts images", "context 1 million tokens"). |
| Provider dialog | `role="dialog"`, `aria-modal`, focus trap, initial focus on search (or on the key field when a provider is preselected). |
| Motion | Spinners and pulsing dots respect `prefers-reduced-motion`. |
| Contrast | Amber and red text on the dark surface must meet WCAG AA (4.5:1) for text. |

---

## 8. Acceptance criteria (verifiable)

**Model discovery**

- [ ] AC1 — A fixture `models-store.json` with the shape `{"opencode-go":{"models":[33 entries]}}` makes the fallback discovery return 33 opencode-go models (Rust unit test).
- [ ] AC2 — With a fake `pi` binary that answers `get_available_models` with N models, `pi_list_models` returns N `PiModelInfo` items with `source: "pi_rpc"`, and no field contains `baseUrl`, `key`, `access` or `refresh` (Rust test with a fake binary, like the existing `process_pi_adapter_*` tests).
- [ ] AC3 — If pi RPC times out (>10 s) or fails, the catalog falls back to models-store, then to curated, and reports the `source` used. The UI shows "Showing suggested models — couldn't read pi's catalog" with a Retry link.

**Model picker**

- [ ] AC4 — The picker lists every model of every connected provider, grouped by provider with counts. Typing `kimi` shows only models whose name, id or provider fuzzy-matches (Vitest + Testing Library, mocked catalog).
- [ ] AC5 — Selecting a model with Enter writes `.hub/chat.json` and leaves `~/.pi/agent/settings.json` unchanged. `Ctrl+Enter` writes both (mock IPC assertions).
- [ ] AC6 — The next `pi_send_message` after a switch passes the selected `--provider/--model` (and `--thinking` when set). This is asserted through the fake pi binary's recorded argv.
- [ ] AC7 — Switching the model inserts one "Switched to ..." divider. This divider is not sent to the agent.
- [ ] AC8 — Favorites and recents persist across app restarts and never exceed 10 / 5 entries.
- [ ] AC9 — A search text with no match offers "Use "<text>" as a custom model id", and selecting it works.

**Provider dialog**

- [ ] AC10 — In every provider state, exactly one primary button is visible. The strings `piSetup.saveKeyBtn` and `piSetup.saveConnectBtn` no longer both render.
- [ ] AC11 — Disconnect requires confirmation. Cancel leaves `auth.json` untouched (mock).
- [ ] AC12 — The API key field's placeholder never contains an env var name. The env var appears only in the helper text.
- [ ] AC13 — The OAuth flow polls `piCheckProvider` and flips to Connected without a manual click (fake timers, no real sleeps).

**Agent output**

- [ ] AC14 — Given a recorded pi JSONL fixture (narration → bash error → 5 tools → final text), the parsed turn has blocks in the original order, the narration preserved, `duration_ms` filled and outcome `completed`.
- [ ] AC15 — The rendered turn shows the summary `Worked … · … commands · 1 failed (recovered)`, collapsed, *above* the formatted answer. Expanding it shows `$ <command>` labels, not `bash`.
- [ ] AC16 — A fixture whose final message has `stopReason: error` renders an error card that keeps the activity rows and offers Retry and Switch model.
- [ ] AC17 — Assistant markdown renders headings, lists, bold and inline/fenced code. A `<script>` or `<img onerror>` in agent text renders as literal text (XSS test).
- [ ] AC18 — The screenshot-2 text yields a choice card with 2 options plus Other. Clicking option 1 prefills `1 — Qual diretório você estava rodando?` into the composer without sending. Text with no trailing question, or with two lists, yields no card (pure-function unit tests).

**Running state**

- [ ] AC19 — While a turn runs, other IPC calls (for example `get_workspace_tree`) return without waiting for the turn (integration test or manual check with a slow fake pi).
- [ ] AC20 — Stop terminates the fake pi process group within 1 s and renders "Stopped after Ns" with the partial activity kept.
- [ ] AC21 — `text_delta` events update the transcript incrementally. The live status line shows the current tool label.

**i18n and accessibility**

- [ ] AC22 — All new UI strings exist in en, pt-BR and zh-CN. The existing i18n test is extended to check key parity. No Portuguese literal remains in `workspaceStore.ts` user-facing strings.
- [ ] AC23 — The panel is usable at 320 px width in pt-BR with no horizontal scroll (manual check, with a screenshot attached to the PR).
- [ ] AC24 — The picker and the dialog are fully operable by keyboard. The transcript announces only finished turns (Testing Library role queries).

---

## 9. Open questions

1. **Extensions in model discovery.** `--no-extensions` makes `pi_list_models` faster and side-effect-free, but it hides models registered by extensions (for example a custom provider). Recommendation: allow extensions, use `--no-approve --offline --no-session`, and keep the 10 s timeout. *Needs decision.*
2. **Conversation scope.** Today there is one pi session per workspace (`--continue`). Is "conversation" equal to workspace (store `.hub/chat.json`), or should **+ New** create a named session with its own model (`--session-id`)? Recommendation: one active conversation per workspace, **+ New** rotates the session, with no history browser for now.
3. **Is `.hub/chat.json` committed?** `.hub/` already holds `project.json`/`layout.json`. A per-user model choice may not belong in Git. Alternative: `.hub/local/` (git-ignored) or the Hub config dir keyed by workspace path. *Needs decision.*
4. **Transcript persistence (C10).** Should the visible transcript be restored from the pi session (`get_messages` via RPC, or the session JSONL) on reopen? It is valuable but enlarges scope. Recommendation: a follow-up slice; S8 only adds the "Continuing previous session" divider.
5. **Moving to `pi --mode rpc` as a long-lived process.** This would also enable `steer`/`follow_up` (typing while the agent works), `set_model` without a restart, and `abort`. It is a bigger change than per-turn JSON mode, and there's a trade-off against DECISIONS ACT-03 (adapter boundary). Recommendation: keep JSON mode now, and design `PiSidecarAdapter` events so RPC can replace it later.
6. **Pricing display.** Prices come from pi's catalog and can be wrong for subscription plans (OpenCode Go). Should we show prices at all, or hide them behind a setting?
7. **Choice prefill vs send.** v1 prefills. Validate with the user whether one-click send is preferred for the heuristic card.
8. **Thinking level.** It is exposed only in the picker footer. Is that enough, or does it deserve a separate chip?

---

## 10. Suggested implementation slices (small, ordered, no code)

Each slice is a mergeable PR with its own tests (TDD per project rules), and is useful on its own.

| # | Slice | User-visible result | Depends on |
|---|---|---|---|
| S0 | **Verify and fix main-thread blocking (C6).** Make `pi_send_message` (and `pi_get_setup_status`, which shells out to `pi auth check`) async or worker-thread commands. Move the child pid out of the adapter lock. | The app stays responsive during a turn. | — |
| S1 | **Fix model discovery.** Correct the `collect_models_from_store` parser with a fixture test. Add `pi_list_models` using RPC `get_available_models` with fallbacks and the `PiModelInfo` DTO. Add the mock in `ipc.ts`. | (Backend) 34 models instead of 3. | — |
| S2 | **ModelPicker component (field mode)** replaces the `<input list>`/`<datalist>` in the setup card. Search, grouping, badges and custom id. | The setup card shows every model. | S1 |
| S3 | **Provider dialog cleanup.** Modal dialog, a single primary action per state, Disconnect with confirmation, env var as helper text, OAuth auto-poll, title and copy changes, no inline auto-open. | Fixes P5–P10. | S2 |
| S4 | **Per-conversation model.** Composer model chip + compact picker + `.hub/chat.json` + favorites/recents + adapter `--model/--thinking` override + switch divider. Remove the header pill. | Switch models from the chat. | S1, S2, decision Q3 |
| S5 | **Safe markdown rendering** of assistant text (AST to React, no innerHTML), with code copy and workspace path links. | Fixes P1. | — |
| S6 | **Ordered turn blocks.** Parser keeps narration/tool order, `durationMs` and `args`, and keeps partial activity on error. `ChatMessage.blocks`. Activity group UI with humanized rows, grouping, a summary line and a files-changed footer. Error card with actions. | Fixes P3/P4 and C7–C9. | S5 helps |
| S7 | **Streaming and Stop.** Emit `pi://event` per JSONL line. Add the live status line, Stop / `pi_cancel_turn` and the stopped state. | Live progress, cancellable turns. | S0, S6 |
| S8 | **States and polish.** Empty states with starter chips, offline strip, pi-missing strip, compaction divider, subagent strip, "Continuing previous session" divider, **+ New**, composer context hint. Move hardcoded PT strings to i18n with plural rules. | Fixes C10 (partially), C11 and C12. | S6 |
| S9 | **Choices.** v1 is a heuristic choice card (pure function + UI). v2 is the `ask_user` Hub tool with send-on-click. | Fixes P2. | S5 (v1), S7 (v2) |

S1 → S2 → S3 alone resolve the user's model complaint quickly. S5 + S6 resolve the "wall of output" complaint. S0 should go first if verification confirms the freeze.
