[English](README.md) | [Português (Brasil)](README.pt-BR.md) | **简体中文**

# Tchelvis Studio (Game Dev Hub)

**本地优先（Local-First）的游戏设计、世界观构建与 AI 智能体编排桌面工作室。**

基于 **Tauri v2 (Rust + WebKitGTK)**、**React 19**、**TypeScript**、**Dockview**、**CodeMirror 6**、**xterm.js** 与 **Three.js** 构建，Tchelvis Studio 将 Markdown 文档编辑、智能对话、视觉参考图生成、2D/3D 资源预览、内置终端以及自动化循环任务监控整合在一个直接面向本地文件的工作区中。

---

## 核心使用场景

- **创意前期制作、GDD 与世界观构建：** 在 `gdd/`、`world/`、`brainstorm/` 中撰写设计文档，支持类 Obsidian 的可编辑实时预览（*Live Preview*）、可点击 `[[wikilinks]]` 自动补全及同名冲突选择。
- **带上下文防火墙的智能体协同开发：** 在 **Chat** 面板中对话时，自动附带当前聚焦面板、已打开标签页、未保存文件（`dirty_files`）以及通过 `Ctrl+V` 粘贴的一次性截图附件（*one-shot attachments*）；长时间代码任务则通过 `tchelvis` 在独立的 *git worktree* 中隔离运行。
- **在项目中直接生成视觉参考图：** 使用 `/flow <路径.png> <提示词>` 命令或 `generate_flow_reference` 工具，通过 **Google Flow**（使用持久化 WebView 窗口保留已登录的 Google 会话）或 **Gemini Image API**（`GEMINI_API_KEY`）回退方案生成图片并保存至项目目录，直接在文档中预览（`![[image.png]]` 或 `![alt](image.png)`）。
- **快速查看 2D 图片与 3D 模型资源：** 在文件浏览器中点击图片（`.png`、`.jpg`、`.webp`、`.svg` 等）或 3D 模型（`.glb`、`.gltf`、`.obj`、`.stl`、`.fbx`），即可打开内置预览器（支持缩放/棋盘透明背景，以及 3D 轨道旋转、网格与线框模式）。
- **Godot 4 与 Web/Three.js 原型预览：** 按 `F5` 在动态端口启动 Vite 预览（16:9 弹窗并支持在外部浏览器打开），或使用 CoW 缓存（`cp --reflink=auto`）启动 Godot 4 *staging* 预览，配合可选的 Hyprland/`grim` 集成与安全的 Git worktree 合并。

---

## 核心优势

- **100% 本地优先（无专有数据库）：** 所有内容均以普通 Markdown、JSON 和 TOML 文件存储，天然兼容 Git、Obsidian 与 VS Code。
- **类 Obsidian 单一实时预览视图：** 直接在渲染后的文档上编辑（标题、粗体、斜体、行内代码、引用、列表、内嵌图片与双链），仅在光标所在行显示原始 Markdown 语法。
- **内置图片与 3D 模型预览器：** 无需切换外部软件，直接在文件浏览器中检查贴图、概念图与 3D 网格。
- **原生 PTY 终端 + 瞬时专注模式（Zen Mode）：** 基于 `portable-pty` 的真实 `$SHELL` 终端，支持快捷键透传（`Ctrl+B`、`Ctrl+L`、`Ctrl+J`、`F5`），切换 Zen Mode 时不销毁终端会话；支持拖动边缘自由调整各面板尺寸。
- **沙箱化只读视图（Lenses）：** 自定义 HTML 视图（`.hub/views/*.html`）运行在禁用网络访问的 `<iframe sandbox="allow-scripts">` 中，并通过经过校验的 `postMessage` 桥接读取工作区数据。
- **主题与多语言支持：** 内置 4 套主题（**Tokyo Night**、**Gruvbox**、**Kanagawa**、**GitHub Dark**），支持 **English**、**Português (Brasil)** 和 **简体中文**，首次启动自动匹配系统语言。
- **双更新通道（CI/CD）：**
  - **Stable (`0.x.0`)：** 经过完整测试验证的稳定版本（`v0.4.0`、`v0.5.0` 等）。
  - **Nightly (`0.x.x`)：** 包含最新修复与功能的前沿持续构建版本（Bleeding Edge）。

---

## 安装指南（Linux / Arch / EndeavourOS）

### Stable 通道（`0.x.0` — 推荐）
```bash
curl -fsSL https://raw.githubusercontent.com/fabriciof807/Tchelvis-Studio/stable/install.sh | bash
```

### Nightly 通道（`0.x.x` — 前沿版）
```bash
curl -fsSL https://raw.githubusercontent.com/fabriciof807/Tchelvis-Studio/nightly/install.sh | bash -s -- --channel nightly
```

`install.sh` 安装脚本会自动完成：
1. 通过 `pacman` 安装 Arch/EndeavourOS 所需的系统运行时依赖（`webkit2gtk-4.1`、`gtk3`、`dbus`、`libayatana-appindicator`、`librsvg`、`xdotool`）。
2. 从 GitHub CI/CD Release 下载预编译二进制包（校验 `SHA256SUMS.txt`）并安装至 `~/.local/bin/game-hub`。
3. 若对应通道暂无预编译版本或指定了 `--from-source`，则克隆源码至 `~/.local/share/game-hub` 并在本地编译（`npm ci && npm run build` + `cargo build --release --features desktop,custom-protocol`）。
4. 复制默认配置至 `~/.config/game-hub/` 并创建桌面启动快捷方式 `~/.local/share/applications/game-hub.desktop`。

> **提示：** 请确保 `~/.local/bin` 已加入 `PATH` 环境变量。之后在终端运行 `game-hub` 或从系统启动器打开 **Game Dev Hub** 即可。

### 手动编译安装（开发模式）
```bash
git clone https://github.com/fabriciof807/Tchelvis-Studio.git
cd Tchelvis-Studio
npm ci
npm run build
cargo build --manifest-path src-tauri/Cargo.toml --release --features desktop,custom-protocol
```

---

## 更新方式

在应用内部更新：
1. 打开 **设置（Settings）**（点击侧边栏、顶部栏或欢迎页的齿轮图标）。
2. 选择更新通道（**Stable** 或 **Nightly**）。
3. 点击 **检查更新（Check for Updates）** 查看远程版本及自当前版本以来的变更日志。
4. 点击 **立即更新（Update Now）**，完成后点击 **立即重启（Restart Now）** 并确认即可。

也可以直接在终端重新运行上方的 `curl` 安装命令。

---

## 卸载（完全移除）

如需完全移除应用、桌面快捷方式、本地安装缓存及全局配置：

```bash
rm -f ~/.local/bin/game-hub
rm -f ~/.local/share/applications/game-hub.desktop
rm -rf ~/.local/share/game-hub
rm -rf ~/.config/game-hub
rm -rf ~/.local/state/game-hub
```

*（您的游戏项目与工作区文件会保留在原目录中，不会被删除。）*

---

## 默认快捷键

| 快捷键 | 功能 |
| :--- | :--- |
| `Ctrl+B` | 折叠 / 展开左侧面板（文件浏览器、循环任务、视图） |
| `Ctrl+L` | 折叠 / 展开 Chat 面板 |
| `Ctrl+J` | 折叠 / 展开底部终端 |
| `F5` | 打开 / 聚焦项目预览 |
| `Ctrl+S` | 保存当前 Markdown 文档 |
| `Ctrl+V`（在 Chat 中） | 粘贴剪贴板截图作为一次性附件 |

---

## 许可证

请参阅仓库中的许可证与贡献说明。
