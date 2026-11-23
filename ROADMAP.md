# Roadmap — Game Dev Hub

## Milestones Ativos (v0.1 – v0.4)

### v0.1 — Núcleo, Docking, Markdown & Terminal
- Setup do projeto Tauri v2 + React/TypeScript/Vite (`dockview-react`, `@codemirror/*`, `@xterm/xterm`, `zustand`).
- `workspace.rs`: abertura/troca de projetos, lock de instância única por workspace (`.hub/hub.lock`), `recent.json`, validação canônica contra *path traversal* e escopos separados (`FsScope` + `asset://`).
- `fs_watcher.rs`: observação de arquivos com filtros de ruído, debounce e supressão de eco por SHA-256.
- `MarkdownPanel.tsx` + `markdownIndex.ts`: editor `@codemirror/*` com `[[wikilinks]]`, preview com imagens locais via `asset://`, rastreamento de buffers *dirty* e banner de conflito externo.
- `TerminalPanel.tsx` + `pty.rs`: terminal embutido via `portable-pty` com repasse de atalhos do Hub.

### v0.2 — Sidecar Persistente (`Pi Durable`), Skill Inicial & Lentes
- `sidecar.rs` (`PiSidecarAdapter`): ciclo de vida de process group, socket autenticado em `$XDG_RUNTIME_DIR/game-hub/<pid>.sock`, envio de `AmbientEnvelope` (`dirty_files`, `one_shot_attachments`) e fallback offline quando `dpi-backend` não estiver no `$PATH`.
- `ChatPanel.tsx`: stream de chat, badges de subagentes, blocos recolhíveis de tool calls e chips *one-shot*.
- `CustomLensPanel.tsx`: renderização de `.hub/views/<lens_id>.html` em `<iframe sandbox="allow-scripts">` com CSP restritiva e ponte `postMessage` read-only validada por `event.source`.
- `defaults/`: `config.toml`, `hyprland-rules.example.conf` e skill `init-game-project`.

### v0.3 — Captura Visual via Clipboard e Arquivos
- Fluxo de captura via navegador externo + screenshot do SO / colagem da área de transferência (`Ctrl+V`) ou seleção de arquivo direto nos `one_shot_attachments` do `ChatPanel.tsx`.
- Armazenamento em `.hub/captures/` com monitoramento de cota de 200 MiB.

### v0.4 — Loops (`Tchelvis-Supervisor`), Preview Flutuante & Git Ops
- `LoopsPanel.tsx` + `TchelvisAdapter`: leitura atômica/cache de `.loops/runs/*/state.json`, reconciliação offline via `.hub-notified` e visualização sandboxed de `report.html`.
- `preview.rs`: servidor Vite dinâmico (porta TCP livre + healthcheck HTTP) com `PreviewLightbox.tsx` (16:9, fallback navegador externo) e launcher Godot 4 CLI com cache CoW (`cp --reflink=auto`).
- `compositor.rs`: `CompositorAdapter` com backend opcional Hyprland (`.socket.sock` + `.socket2.sock` + `grim -g` com escala HiDPI) e modo degradado sem Hyprland.
- `git_ops.rs`: verificação de colisões com working tree suja, `git stash` opcional, merge na `default_branch`, limpeza e listagem de worktrees órfãos.

---

## Marcos Futuros (Pós-v0.4)

### 1. Integração ao Vivo com `tchelvis loop` e `dpi-backend`
- Conectar `TchelvisAdapter` e `PiSidecarAdapter` aos binários finais de produção assim que o `tchelvis loop` concluir seu desenvolvimento, validando flags exatas de CLI, `--run-id` e schema final de `state.json`.

### 2. Browser Integrado + Canvas de Rabisco (`BrowserPanel`)
- Avaliar e implementar `BrowserPanel` com *child WebView* nativa (`unstable` no Tauri v2), sincronização de geometria (`ResizeObserver` + `activeModalCount`) e canvas de anotação congelada (`tldraw`/`Excalidraw`) sobre snapshot WebKitGTK/`grim`.
