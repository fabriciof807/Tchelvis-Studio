# Tchelvis Studio (Game Dev Hub)

**Estúdio desktop *local-first* para Game Design, Worldbuilding e Orquestração de Agentes de IA.**

Construído com **Tauri v2 (Rust + WebKitGTK)**, **React 19**, **TypeScript**, **Dockview**, **CodeMirror 6**, **xterm.js** e **Three.js**, o Tchelvis Studio reúne documentação em Markdown, chat assistido, geração de referências visuais, visualização de assets 2D/3D, terminal embutido e monitoramento de loops automatizados em um único workspace sobre arquivos locais.

---

## Casos de Uso

- **Pré-produção criativa, GDD e Worldbuilding:** Escreva documentos de design (`gdd/`, `world/`, `brainstorm/`) com *Live Preview* editável estilo Obsidian, `[[wikilinks]]` clicáveis com autocomplete e resolução de colisões.
- **Desenvolvimento assistido por agentes com Firewall de Contexto:** Converse no painel de **Chat** enviando automaticamente contexto do arquivo focado, abas abertas, arquivos não salvos (`dirty_files`) e capturas de tela coladas com `Ctrl+V` (*one-shot attachments*), enquanto tarefas longas de código rodam isoladas em *git worktrees* via `tchelvis`.
- **Geração de referências visuais direto no projeto:** Use o comando `/flow <caminho.png> <prompt>` ou a tool `generate_flow_reference` para gerar imagens via **Google Flow** (com sessão autenticada persistente em WebView dedicada) ou fallback via **Gemini Image API** (`GEMINI_API_KEY`), salvando e exibindo imediatamente no documento (`![[imagem.png]]` ou `![alt](imagem.png)`).
- **Inspeção rápida de assets 2D e modelos 3D:** Clique em imagens (`.png`, `.jpg`, `.webp`, `.svg`, etc.) ou modelos 3D (`.glb`, `.gltf`, `.obj`, `.stl`, `.fbx`) no explorador de arquivos para abrir o visualizador integrado com zoom/fundo xadrez ou órbita 3D, grade e wireframe.
- **Preview de protótipos Godot 4 e Web/Three.js:** Inicie servidores Vite em portas dinâmicas (`F5`) com lightbox 16:9 e botão para navegador externo, ou rode builds *staging* do Godot 4 com cache CoW (`cp --reflink=auto`), integração opcional com Hyprland/`grim` e merge seguro de *worktrees*.

---

## Diferenciais

- **100% Local-First (Zero Banco Proprietário):** Todo o conteúdo fica em arquivos comuns Markdown, JSON e TOML compatíveis com Git, Obsidian e VS Code.
- **Live Preview Único Estilo Obsidian:** Edite diretamente sobre o documento renderizado (títulos, negrito, itálico, código, citações, listas, imagens inline e wikilinks); a sintaxe aparece apenas na linha onde está o cursor.
- **Visualizador Integrado de Imagens e Modelos 3D:** Inspecione sprites, concept art e malhas 3D direto pelo explorador sem abrir ferramentas externas.
- **Terminal PTY Nativo + Zen Mode Instantâneo:** Terminal real (`$SHELL` via `portable-pty`) com repasse de atalhos (`Ctrl+B`, `Ctrl+L`, `Ctrl+J`, `F5`) que permanece vivo ao entrar/sair do Zen Mode, além de painéis laterais e inferior redimensionáveis arrastando as bordas.
- **Lentes Read-Only em Sandbox:** Visualizações customizadas (`.hub/views/*.html`) isoladas em `<iframe sandbox="allow-scripts">` com CSP sem rede e ponte `postMessage` validada.
- **Temas & Multi-Idioma:** 4 temas embutidos (**Tokyo Night**, **Gruvbox**, **Kanagawa**, **GitHub Dark**) e suporte a **Português (Brasil)**, **English** e **简体中文** com detecção automática do idioma do sistema na primeira execução.
- **Dois Canais de Atualização (CI/CD):**
  - **Stable (`0.x.0`):** Releases testadas e consolidadas (`v0.4.0`, `v0.5.0`, etc.).
  - **Nightly (`0.x.x`):** Builds contínuas *bleeding edge* com as últimas correções e recursos.

---

## Como Instalar (Linux / Arch / EndeavourOS)

### Canal Stable (`0.x.0` — Recomendado)
```bash
curl -fsSL https://raw.githubusercontent.com/fabriciof807/Tchelvis-Studio/stable/install.sh | bash
```

### Canal Nightly (`0.x.x` — Bleeding Edge)
```bash
curl -fsSL https://raw.githubusercontent.com/fabriciof807/Tchelvis-Studio/nightly/install.sh | bash -s -- --channel nightly
```

O instalador `install.sh`:
1. Instala dependências de runtime necessárias no Arch/EndeavourOS via `pacman` (`webkit2gtk-4.1`, `gtk3`, `dbus`, `libayatana-appindicator`, `librsvg`, `xdotool`).
2. Baixa a release pré-compilada pelo CI/CD do GitHub (com verificação `SHA256SUMS.txt`) e instala o binário em `~/.local/bin/game-hub`.
3. Se ainda não houver release pré-compilada para o canal ou se `--from-source` for passado, clona em `~/.local/share/game-hub` e compila localmente (`npm ci && npm run build` + `cargo build --release --features desktop,custom-protocol`).
4. Copia configurações padrão para `~/.config/game-hub/` e cria o atalho `~/.local/share/applications/game-hub.desktop`.

> **Dica:** Certifique-se de que `~/.local/bin` está no seu `PATH`. Depois, basta executar `game-hub` ou abrir **Game Dev Hub** no launcher do sistema.

### Instalação Manual (Desenvolvimento)
```bash
git clone https://github.com/fabriciof807/Tchelvis-Studio.git
cd Tchelvis-Studio
npm ci
npm run build
cargo build --manifest-path src-tauri/Cargo.toml --release --features desktop,custom-protocol
```

---

## Como Atualizar

Dentro do próprio aplicativo:
1. Abra **Configurações** (ícone de engrenagem na barra lateral, na barra superior ou na tela inicial).
2. Escolha o canal desejado (**Stable** ou **Nightly**).
3. Clique em **Procurar Atualizações** para ver a versão remota e o changelog desde a sua versão atual.
4. Clique em **Atualizar Agora** e depois em **Reiniciar Agora** (com confirmação).

Ou pelo terminal executando novamente o comando `curl` de instalação acima.

---

## Como Remover (Desinstalar)

Para remover completamente o aplicativo, atalhos, cache de instalação e configurações globais:

```bash
rm -f ~/.local/bin/game-hub
rm -f ~/.local/share/applications/game-hub.desktop
rm -rf ~/.local/share/game-hub
rm -rf ~/.config/game-hub
rm -rf ~/.local/state/game-hub
```

*(Os arquivos dos seus projetos/workspaces permanecem intactos nas respectivas pastas.)*

---

## Atalhos Padrão

| Atalho | Ação |
| :--- | :--- |
| `Ctrl+B` | Recolher / expandir painel esquerdo (Explorador, Loops, Lentes) |
| `Ctrl+L` | Recolher / expandir Chat |
| `Ctrl+J` | Recolher / expandir Terminal inferior |
| `F5` | Abrir / focar Preview do projeto |
| `Ctrl+S` | Salvar documento Markdown ativo |
| `Ctrl+V` (no Chat) | Colar captura de imagem da área de transferência como anexo *one-shot* |

---

## Licença

Consulte o repositório para informações de licenciamento e contribuições.
