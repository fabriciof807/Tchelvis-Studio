# Registro de Decisões Arquiteturais (`DECISIONS.md`)

## 2026-11-23 — Sistema de Arquivos como Fonte Única da Verdade
- **Decisão:** Armazenar todos os documentos de projeto (`brainstorm/`, `world/`, `gdd/`), metadados (`.hub/project.json`) e estado de layout (`.hub/layout.json`) em arquivos Markdown + YAML/JSON comuns, sem SQLite ou Postgres.
- **Racional:** Preservar interoperabilidade direta com Git, Obsidian e VS Code sem sincronização bidirecional.

## 2026-11-23 — Corte do `BrowserPanel` na v0.x (`ACT-01`)
- **Decisão:** Remover `BrowserPanel` (child WebView nativa + canvas de anotação embutido) do escopo v0.x e movê-lo para `ROADMAP.md` como recurso futuro.
- **Racional:** Evitar a complexidade de *z-order/airspace* do GTK/WebKitGTK e limitações de WebGL2/WebGPU na v0.x. A captura visual na v0.3 usa navegador externo + colagem de imagem da área de transferência / arquivo diretamente em `one_shot_attachments`.

## 2026-11-23 — Fronteira de Adaptadores para `tchelvis loop` e `dpi-backend` (`ACT-03`)
- **Decisão:** Como `tchelvis loop` ainda está em desenvolvimento, isolar a comunicação em traits de adaptador (`TchelvisAdapter`, `PiSidecarAdapter`) com fallback local/mock quando os binários não estiverem presentes no `$PATH`.
- **Racional:** Permite desenvolver, testar e validar toda a arquitetura do Hub agora sem bloquear na estabilização final do `tchelvis loop`.

## 2026-11-23 — Desacoplamento de `git_ops.rs` e `compositor.rs` de `preview.rs` (`ACT-02`)
- **Decisão:** Extrair operações Git (`git_ops.rs`) e integração Hyprland/`grim` (`compositor.rs` via `CompositorAdapter`) de `preview.rs`.
- **Racional:** Manter `preview.rs` focado apenas em processos locais de preview, corrigir o uso de sockets Hyprland (`.socket.sock` para comandos, `.socket2.sock` somente leitura para eventos) e garantir modo degradado sem Hyprland.

## 2026-11-23 — Separação de Feature Cargo `desktop` vs. Core Testável (`default`)
- **Decisão:** Configurar `src-tauri/Cargo.toml` com `default = []` (toda a lógica de domínio, IPC handlers, PTY, watcher, Git, compositor e testes) e `desktop = ["dep:tauri", "dep:tauri-plugin-fs", "dep:tauri-build"]`.
- **Racional:** Permite compilar e executar toda a suíte `cargo test` em ambientes Linux headless sem exigir headers de desenvolvimento GTK/WebKit2GTK instalados, mantendo a integração completa Tauri v2 na feature `desktop`.

## 2026-11-25 — Integração Real com `tchelvis loop` CLI e `state.json` v1
- **Decisão:** Conectar o backend (`fs_watcher.rs`, `sidecar.rs`, `git_ops.rs`, `lib.rs`) e o frontend (`ipc.ts`, `LoopsPanel.tsx`, `workspaceStore.ts`) ao formato real do `tchelvis loop` (`state.json` `schema_version: 1`, `executions`, `report.md`, branches `loop/<workflow>-<run_id>` sem worktree persistente) e aos subcomandos CLI reais (`loop list`, `loop check`, `loop run <workflow> --input-file <abs>`, `loop stop <run_id>`), preservando fallback offline/legacy e mocks Vitest/navegador.
- **Racional:** Alinha os DTOs Rust/TypeScript em `snake_case`, suporta integração *branch-only* com fallback para a branch atual quando `default_branch` não existe (ex.: `master`), renderiza `report.md` em HTML seguro dentro do iframe sandboxed e mantém a detecção imediata de erros de inicialização via `.launch.log`.

## 2026-11-25 — Setup de Provedor no Primeiro Uso para Pi Durable (`pi`)
- **Decisão:** Conectar `ProcessPiAdapter` ao binário real `pi` (`@earendil-works/pi-coding-agent` via `pi --mode json --no-themes --no-approve --session-dir <ws>/.hub/pi-session [--continue]`), substituir o fallback padrão `dpi-backend` por `pi` (mantendo fallback de resolução para `dpi-backend` -> `pi`), e implementar o fluxo de configuração de provedor no primeiro uso (`PiSetupWizard`, pill de status no `ChatPanel`, seção em `SettingsModal` e login OAuth interativo via `TerminalPanel`).
- **Racional:** Chaves de API são gravadas de forma atômica em `~/.pi/agent/auth.json` (`0600`) sem nunca expor segredos nos DTOs nem vazar valores em logs/testes; chaves existentes de `~/.pi/agent/settings.json` são preservadas; fluxos OAuth rodam em TTY real no terminal integrado via `pi auth login <provider>`; e o usuário pode optar explicitamente pelo modo offline sem ser incomodado a cada inicialização.

## 2026-11-25 — Comandos Pi fora da thread principal e descoberta de modelos via RPC
- **Decisão:** Os comandos Tauri do Pi (`pi_send_message`, `pi_get_setup_status`, `pi_check_provider`, `pi_configure_provider`, `pi_logout_provider` e o novo `pi_list_models`) passam a ser `async` e executam o trabalho bloqueante em `tauri::async_runtime::spawn_blocking` (`on_worker` em `lib.rs`). A lista de modelos vem de `pi --mode rpc --no-session --offline --no-approve` com `{"type":"get_available_models"}` (timeout de 10 s, extensões habilitadas), com fallback para `~/.pi/agent/models-store.json` (parser corrigido para o formato `{provider: {models: [...]}}` do pi 1.5.x) e depois para as sugestões curadas; o DTO `PiModelCatalog` informa a `source` usada e o `fallback_reason`. `sidecar.rs` foi dividido em `sidecar/{pi_setup,pi_adapter,lens,tchelvis}.rs` sem mudança de comportamento.
- **Racional:** Comandos síncronos do Tauri v2 rodam inline na thread do IPC (principal), congelando a janela durante um turno de até 180 s. O parser antigo do `models-store.json` não reconhecia o formato real e a UI mostrava só 3 modelos curados em vez dos 33–34 disponíveis. O DTO `PiModelInfo` copia apenas campos de uma allow-list (nunca `baseUrl`, headers ou chaves). Spec: `docs/specs/chat-ux-redesign.md` (slices S0 e S1). Como um turno segura o lock de `pi_adapter` por até 180 s, `AppState` guarda um `PiCancelToken` compartilhado com o adaptador: `open_workspace`, `restart_app` e o `Drop` chamam `AppState::shutdown_pi`, que cancela o turno antes de pegar o lock (sem isso a troca de workspace travaria a janela durante um turno). O runner de subprocessos usado por `pi auth check` e `pi_list_models` roda o comando em um process group próprio, limita o tempo total (incluindo a leitura dos pipes) e mata o grupo inteiro no timeout; o stderr bruto do `pi` vai só para o stderr do app, nunca para a UI.
