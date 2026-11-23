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
