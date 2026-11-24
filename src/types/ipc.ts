import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

// ============================================================================
// Shared IPC Types (100% snake_case matching Rust backend)
// ============================================================================

export interface ProjectConfig {
  schema_version: number;
  engine: 'godot' | 'web' | string;
  game_dir: string;
  default_branch: string;
}

export interface OrphanWorktree {
  run_id: string;
  branch: string;
  path: string;
}

export interface LoopStage {
  name: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | string;
  started_at?: string | null;
  finished_at?: string | null;
  summary?: string | null;
}

export interface LoopRunState {
  run_id: string;
  workflow: string;
  title: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'stopped' | string;
  branch?: string | null;
  worktree_path?: string | null;
  created_at: string;
  updated_at: string;
  stages: LoopStage[];
  summary?: string | null;
  error?: string | null;
}

export interface WorkspaceInfo {
  root_path: string;
  name: string;
  is_uninitialized: boolean;
  project_config: ProjectConfig | null;
  orphan_worktrees: OrphanWorktree[];
  offline_completed_runs: LoopRunState[];
}

export interface RecentWorkspace {
  path: string;
  name: string;
  last_opened: string;
}

export interface FileTreeNode {
  name: string;
  rel_path: string;
  is_dir: boolean;
  children?: FileTreeNode[];
}

export interface MarkdownFileContent {
  rel_path: string;
  content: string;
  sha256: string;
}

export interface WriteMarkdownAck {
  rel_path: string;
  sha256: string;
}

export interface OneShotAttachment {
  type: 'annotated_capture' | 'clipboard_image' | 'file_image' | 'staging_capture' | string;
  source_url?: string | null;
  image_path: string;
  user_note?: string | null;
}

export interface ActiveContext {
  focused_panel: string | null;
  open_tabs: string[];
  dirty_files: string[];
  latest_loop: {
    run_id: string;
    status: string;
    title: string;
  } | null;
}

export interface AmbientEnvelope {
  user_message: string;
  active_context: ActiveContext;
  one_shot_attachments: OneShotAttachment[];
}

export interface PiToolCall {
  id: string;
  name: string;
  arguments_json: string;
  result_json?: string | null;
  status: 'running' | 'completed' | 'error' | string;
}

export interface PiTurnAck {
  turn_id: string;
  mode: 'live' | 'offline_fallback' | string;
  reply_text: string;
  tool_calls: PiToolCall[];
}

export interface SaveCaptureResult {
  rel_path: string;
  total_captures_bytes: number;
  quota_exceeded: boolean;
}

export type UpdateChannel = 'stable' | 'nightly';

export interface UpdateCheckResult {
  channel: UpdateChannel | string;
  source: 'github-release' | 'git-branch' | string;
  repo_dir: string;
  branch: string;
  release_tag?: string | null;
  current_commit: string;
  remote_commit: string;
  commits_behind: number;
  update_available: boolean;
  has_prebuilt_asset: boolean;
  changelog: string[];
}

export interface UpdateApplyResult {
  channel: UpdateChannel | string;
  source: 'github-release' | 'git-branch' | string;
  updated: boolean;
  new_commit: string;
  release_tag?: string | null;
  message: string;
  changelog: string[];
  output_log: string;
}

export interface LensInfo {
  lens_id: string;
  title: string;
  rel_path: string;
}

export interface PreviewStatus {
  running: boolean;
  mode: 'main' | 'staging' | string;
  engine: 'web' | 'godot' | string;
  url?: string | null;
  pid?: number | null;
  worktree_path?: string | null;
  compositor_available: boolean;
  can_capture: boolean;
  degraded_reason?: string | null;
  logs: string[];
}

export interface PreviewCaptureResult {
  image_path: string;
  log_tail: string[];
}

export interface GitMergeCheckResult {
  can_merge_cleanly: boolean;
  dirty_files: string[];
  colliding_files: string[];
  requires_stash: boolean;
}

export interface GitMergeResult {
  merged: boolean;
  stashed: boolean;
  message: string;
}

// ============================================================================
// Tauri Events
// ============================================================================

export type PiEventPayload =
  | { kind: 'message_delta'; turn_id: string; delta: string }
  | { kind: 'tool_call'; turn_id: string; tool_call: PiToolCall }
  | { kind: 'tool_result'; turn_id: string; tool_id: string; result_json: string; status: string }
  | { kind: 'subagent_status'; subagent: string; status: 'idle' | 'running' | 'done' | 'error'; detail?: string }
  | { kind: 'compaction_notice'; message: string };

export interface PtyOutputPayload {
  session_id: string;
  data: string;
}

export interface FsChangedPayload {
  rel_path: string;
  kind: 'create' | 'modify' | 'remove' | string;
  sha256?: string | null;
}

// ============================================================================
// Environment Detection & Safe Helpers
// ============================================================================

export function isTauriEnv(): boolean {
  return (
    typeof window !== 'undefined' &&
    Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__)
  );
}

export function safeConvertFileSrc(filePath: string): string {
  if (isTauriEnv()) {
    return convertFileSrc(filePath);
  }
  return filePath;
}

// Simple in-memory event bus for browser / Vitest fallback
type EventListener<T = unknown> = (payload: T) => void;
const mockListeners = new Map<string, Set<EventListener>>();

export function emitMockEvent<T>(eventName: string, payload: T): void {
  const set = mockListeners.get(eventName);
  if (!set) return;
  for (const fn of set) {
    fn(payload);
  }
}

export async function listenEvent<T>(
  eventName: string,
  handler: (payload: T) => void
): Promise<UnlistenFn> {
  if (isTauriEnv()) {
    return listen<T>(eventName, (event) => handler(event.payload));
  }
  let set = mockListeners.get(eventName);
  if (!set) {
    set = new Set();
    mockListeners.set(eventName, set);
  }
  const wrapped = handler as EventListener;
  set.add(wrapped);
  return () => {
    set?.delete(wrapped);
  };
}

// ============================================================================
// Mock State for Browser Dev & Vitest
// ============================================================================

const mockFiles = new Map<string, string>([
  [
    'gdd/01-visao-geral.md',
    `# Visão Geral — Projeto Forja Cinza\n\nUm roguelike tático de exploração em cavernas vulcânicas.\n\nVeja também: [[02-core-loop]] e [[forja-cinza]].\n`,
  ],
  [
    'gdd/02-core-loop.md',
    `# Core Loop\n\n1. Coletar minério térmico\n2. Forjar módulos no acampamento\n3. Enfrentar guardiões antes do superaquecimento\n\nVoltar para [[01-visao-geral]].\n`,
  ],
  [
    'world/faccoes/forja-cinza.md',
    `# Facção: Forja Cinza\n\nMestres ferreiros que controlam os dutos de magma.\n\nRelacionado: [[01-visao-geral]].\n`,
  ],
  [
    'brainstorm/00-inbox.md',
    `# Inbox de Brainstorm\n\n- Ideia: barra de calor curva que muda para laranja acima de 80%.\n- Testar [[mecanica-inexistente]] para criar nota.\n`,
  ],
]);

const mockLenses = new Map<string, { info: LensInfo; html: string }>([
  [
    'combat-telemetry',
    {
      info: {
        lens_id: 'combat-telemetry',
        title: 'Telemetria de Combate',
        rel_path: '.hub/views/combat-telemetry.html',
      },
      html: `<!doctype html>
<html>
<head><meta charset="utf-8"><style>
body { font-family: system-ui, sans-serif; background: #14161c; color: #e2e8f0; margin: 0; padding: 16px; }
.card { background: #1e222d; border: 1px solid #2d3343; border-radius: 8px; padding: 12px; margin-bottom: 12px; }
h2 { margin: 0 0 8px; font-size: 14px; color: #60a5fa; }
pre { font-size: 12px; color: #94a3b8; white-space: pre-wrap; }
</style></head>
<body>
  <div class="card">
    <h2>Lente Read-Only: Telemetria do Workspace</h2>
    <p id="status">Solicitando arquivos via postMessage...</p>
    <pre id="output"></pre>
  </div>
  <script>
    window.addEventListener('message', (ev) => {
      if (ev.data && ev.data.id === 'req-list') {
        document.getElementById('status').textContent = 'Arquivos recebidos com segurança via bridge:';
        document.getElementById('output').textContent = JSON.stringify(ev.data.result || ev.data.error, null, 2);
      }
    });
    window.parent.postMessage({ id: 'req-list', method: 'hub:listFiles', params: {} }, '*');
  </script>
</body>
</html>`,
    },
  ],
]);

const mockLoopRuns: LoopRunState[] = [
  {
    run_id: 'run-20261123-01',
    workflow: 'feature-loop',
    title: 'Implementar barra de calor no HUD',
    status: 'completed',
    branch: 'loop/heat-bar',
    worktree_path: '/tmp/mock-game/.loops/worktrees/run-20261123-01',
    created_at: '2026-11-23T18:10:00Z',
    updated_at: '2026-11-23T18:22:00Z',
    stages: [
      { name: 'spec-check', status: 'completed', summary: 'Spec validada' },
      { name: 'implement', status: 'completed', summary: 'Shader + HUD criados' },
      { name: 'test', status: 'completed', summary: '12/12 testes passaram' },
    ],
    summary: 'Barra de calor integrada ao HUD com transição térmica.',
  },
];

let mockLayoutJson: string | null = null;
const mockPresets = new Map<string, string>();
let mockPreviewRunning = false;
let mockPtyCounter = 0;

function computeSimpleHash(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function buildMockTree(): FileTreeNode[] {
  const rootMap = new Map<string, FileTreeNode>();
  const ensureDir = (dirPath: string): FileTreeNode => {
    const existing = rootMap.get(dirPath);
    if (existing) return existing;
    const parts = dirPath.split('/');
    const name = parts[parts.length - 1];
    const node: FileTreeNode = { name, rel_path: dirPath, is_dir: true, children: [] };
    rootMap.set(dirPath, node);
    if (parts.length > 1) {
      const parent = ensureDir(parts.slice(0, -1).join('/'));
      parent.children?.push(node);
    }
    return node;
  };

  const topNodes: FileTreeNode[] = [];
  for (const relPath of Array.from(mockFiles.keys()).sort()) {
    const parts = relPath.split('/');
    if (parts.length === 1) {
      topNodes.push({ name: parts[0], rel_path: relPath, is_dir: false });
    } else {
      const dirPath = parts.slice(0, -1).join('/');
      const parent = ensureDir(dirPath);
      parent.children?.push({ name: parts[parts.length - 1], rel_path: relPath, is_dir: false });
    }
  }
  for (const [dirPath, node] of rootMap.entries()) {
    if (!dirPath.includes('/')) {
      topNodes.push(node);
    }
  }
  return topNodes.sort((a, b) => Number(b.is_dir) - Number(a.is_dir) || a.name.localeCompare(b.name));
}

// ============================================================================
// Unified IPC Client
// ============================================================================

export const ipc = {
  async openWorkspace(path: string): Promise<WorkspaceInfo> {
    if (isTauriEnv()) {
      return invoke<WorkspaceInfo>('open_workspace', { path });
    }
    const name = path.split('/').filter(Boolean).pop() || 'meu-jogo';
    return {
      root_path: path,
      name,
      is_uninitialized: false,
      project_config: {
        schema_version: 1,
        engine: 'web',
        game_dir: 'game',
        default_branch: 'main',
      },
      orphan_worktrees: [],
      offline_completed_runs: [],
    };
  },

  async listRecentWorkspaces(): Promise<RecentWorkspace[]> {
    if (isTauriEnv()) {
      return invoke<RecentWorkspace[]>('list_recent_workspaces');
    }
    return [
      {
        path: '/home/ubuntu/projetos/forja-cinza',
        name: 'forja-cinza',
        last_opened: '2026-11-23T20:00:00Z',
      },
      {
        path: '/home/ubuntu/projetos/nebula-drifter',
        name: 'nebula-drifter',
        last_opened: '2026-11-22T15:30:00Z',
      },
    ];
  },

  async getWorkspaceTree(): Promise<FileTreeNode[]> {
    if (isTauriEnv()) {
      return invoke<FileTreeNode[]>('get_workspace_tree');
    }
    return buildMockTree();
  },

  async readMarkdownFile(relPath: string): Promise<MarkdownFileContent> {
    if (isTauriEnv()) {
      return invoke<MarkdownFileContent>('read_markdown_file', { relPath });
    }
    const content = mockFiles.get(relPath);
    if (content === undefined) {
      throw new Error(`Arquivo não encontrado: ${relPath}`);
    }
    return { rel_path: relPath, content, sha256: computeSimpleHash(content) };
  },

  async readBinaryFile(relPath: string): Promise<string> {
    if (isTauriEnv()) {
      return invoke<string>('read_binary_file', { relPath });
    }
    const content = mockFiles.get(relPath);
    if (content !== undefined) {
      return btoa(unescape(encodeURIComponent(content)));
    }
    // 1x1 transparent PNG fallback in mock mode
    return 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  },

  async writeMarkdownFile(relPath: string, content: string): Promise<WriteMarkdownAck> {
    if (isTauriEnv()) {
      return invoke<WriteMarkdownAck>('write_markdown_file', { relPath, content });
    }
    mockFiles.set(relPath, content);
    const sha256 = computeSimpleHash(content);
    emitMockEvent<FsChangedPayload>('fs://changed', { rel_path: relPath, kind: 'modify', sha256 });
    return { rel_path: relPath, sha256 };
  },

  async saveLayout(layoutJson: string): Promise<void> {
    if (isTauriEnv()) {
      return invoke<void>('save_layout', { layoutJson });
    }
    mockLayoutJson = layoutJson;
  },

  async loadLayout(): Promise<string | null> {
    if (isTauriEnv()) {
      return invoke<string | null>('load_layout');
    }
    return mockLayoutJson;
  },

  async listPresets(): Promise<string[]> {
    if (isTauriEnv()) {
      return invoke<string[]>('list_presets');
    }
    return Array.from(mockPresets.keys());
  },

  async loadPreset(name: string): Promise<string> {
    if (isTauriEnv()) {
      return invoke<string>('load_preset', { name });
    }
    return mockPresets.get(name) ?? '';
  },

  async ptySpawn(cols: number, rows: number): Promise<string> {
    if (isTauriEnv()) {
      return invoke<string>('pty_spawn', { cols, rows });
    }
    mockPtyCounter += 1;
    const id = `mock-pty-${mockPtyCounter}`;
    setTimeout(() => {
      emitMockEvent<PtyOutputPayload>('pty://output', {
        session_id: id,
        data: `\r\n\x1b[36m[mock-pty ${cols}x${rows}]\x1b[0m $ `,
      });
    }, 30);
    return id;
  },

  async ptyWrite(sessionId: string, data: string): Promise<void> {
    if (isTauriEnv()) {
      return invoke<void>('pty_write', { sessionId, data });
    }
    const out = data === '\r' ? '\r\n$ ' : data;
    emitMockEvent<PtyOutputPayload>('pty://output', { session_id: sessionId, data: out });
  },

  async ptyResize(sessionId: string, cols: number, rows: number): Promise<void> {
    if (isTauriEnv()) {
      return invoke<void>('pty_resize', { sessionId, cols, rows });
    }
    void sessionId;
    void cols;
    void rows;
  },

  async ptyKill(sessionId: string): Promise<void> {
    if (isTauriEnv()) {
      return invoke<void>('pty_kill', { sessionId });
    }
    void sessionId;
  },

  async piSendMessage(envelope: AmbientEnvelope): Promise<PiTurnAck> {
    if (isTauriEnv()) {
      return invoke<PiTurnAck>('pi_send_message', { envelope });
    }
    const turnId = `turn-${Date.now()}`;
    const attachmentsSummary =
      envelope.one_shot_attachments.length > 0
        ? ` (${envelope.one_shot_attachments.length} anexo(s) one-shot recebido(s))`
        : '';
    const dirtySummary =
      envelope.active_context.dirty_files.length > 0
        ? ` [dirty: ${envelope.active_context.dirty_files.join(', ')}]`
        : '';
    return {
      turn_id: turnId,
      mode: 'offline_fallback',
      reply_text: `[Chat — Offline] Recebi: "${envelope.user_message}"${attachmentsSummary}${dirtySummary}.`,
      tool_calls: [],
    };
  },

  async saveCapture(filename: string, bytesBase64: string): Promise<SaveCaptureResult> {
    if (isTauriEnv()) {
      return invoke<SaveCaptureResult>('save_capture', { filename, bytesBase64 });
    }
    const approxBytes = Math.floor((bytesBase64.length * 3) / 4);
    return {
      rel_path: `.hub/captures/${filename}`,
      total_captures_bytes: approxBytes,
      quota_exceeded: false,
    };
  },

  async listLenses(): Promise<LensInfo[]> {
    if (isTauriEnv()) {
      return invoke<LensInfo[]>('list_lenses');
    }
    return Array.from(mockLenses.values()).map((entry) => entry.info);
  },

  async readLensHtml(lensId: string): Promise<string> {
    if (isTauriEnv()) {
      return invoke<string>('read_lens_html', { lensId });
    }
    const entry = mockLenses.get(lensId);
    if (!entry) {
      throw new Error(`Lente não encontrada: ${lensId}`);
    }
    return entry.html;
  },

  async publishLens(lensId: string, title: string, htmlContent: string): Promise<LensInfo> {
    if (isTauriEnv()) {
      return invoke<LensInfo>('publish_lens', { lensId, title, htmlContent });
    }
    const info: LensInfo = {
      lens_id: lensId,
      title,
      rel_path: `.hub/views/${lensId}.html`,
    };
    mockLenses.set(lensId, { info, html: htmlContent });
    return info;
  },

  async listLoopRuns(): Promise<LoopRunState[]> {
    if (isTauriEnv()) {
      return invoke<LoopRunState[]>('list_loop_runs');
    }
    return [...mockLoopRuns];
  },

  async readLoopReport(runId: string): Promise<string> {
    if (isTauriEnv()) {
      return invoke<string>('read_loop_report', { runId });
    }
    return `<!doctype html><html><body style="background:#14161c;color:#e2e8f0;font-family:sans-serif;padding:16px"><h2>Relatório do Loop: ${runId}</h2><p>Todos os estágios concluídos com sucesso (mock).</p></body></html>`;
  },

  async dispatchLoop(workflow: string, title: string, specMarkdown: string): Promise<LoopRunState> {
    if (isTauriEnv()) {
      return invoke<LoopRunState>('dispatch_loop', { workflow, title, specMarkdown });
    }
    const now = new Date().toISOString();
    const run: LoopRunState = {
      run_id: `run-${Date.now()}`,
      workflow,
      title,
      status: 'running',
      branch: `loop/${workflow}`,
      created_at: now,
      updated_at: now,
      stages: [{ name: 'spec-check', status: 'running' }],
      summary: specMarkdown.slice(0, 120),
    };
    mockLoopRuns.unshift(run);
    return run;
  },

  async previewStart(mode: 'main' | 'staging', worktreePath?: string): Promise<PreviewStatus> {
    if (isTauriEnv()) {
      return invoke<PreviewStatus>('preview_start', { mode, worktreePath });
    }
    mockPreviewRunning = true;
    return {
      running: true,
      mode,
      engine: 'web',
      url: 'about:blank',
      pid: 99999,
      worktree_path: worktreePath ?? null,
      compositor_available: false,
      can_capture: true,
      degraded_reason: 'Modo navegador (mock sem servidor Vite secundário)',
      logs: ['[preview] Servidor mock iniciado em modo ' + mode],
    };
  },

  async previewStop(): Promise<void> {
    if (isTauriEnv()) {
      return invoke<void>('preview_stop');
    }
    mockPreviewRunning = false;
  },

  async previewCapture(): Promise<PreviewCaptureResult> {
    if (isTauriEnv()) {
      return invoke<PreviewCaptureResult>('preview_capture');
    }
    if (!mockPreviewRunning) {
      throw new Error('Preview não está em execução');
    }
    return {
      image_path: `.hub/captures/preview-${Date.now()}.png`,
      log_tail: ['[preview] Frame capturado (mock)'],
    };
  },

  async gitCheckWorktreeMerge(runId: string): Promise<GitMergeCheckResult> {
    if (isTauriEnv()) {
      return invoke<GitMergeCheckResult>('git_check_worktree_merge', { runId });
    }
    void runId;
    return {
      can_merge_cleanly: true,
      dirty_files: [],
      colliding_files: [],
      requires_stash: false,
    };
  },

  async gitMergeWorktree(runId: string, stashDirty: boolean): Promise<GitMergeResult> {
    if (isTauriEnv()) {
      return invoke<GitMergeResult>('git_merge_worktree', { runId, stashDirty });
    }
    return {
      merged: true,
      stashed: stashDirty,
      message: `Worktree ${runId} integrado com sucesso (mock).`,
    };
  },

  async gitListOrphanWorktrees(): Promise<OrphanWorktree[]> {
    if (isTauriEnv()) {
      return invoke<OrphanWorktree[]>('git_list_orphan_worktrees');
    }
    return [];
  },

  async gitCleanupWorktree(runId: string): Promise<void> {
    if (isTauriEnv()) {
      return invoke<void>('git_cleanup_worktree', { runId });
    }
    void runId;
  },

  async pickWorkspaceDirectory(): Promise<string | null> {
    if (isTauriEnv()) {
      return invoke<string | null>('pick_workspace_directory');
    }
    return '/home/ubuntu/projetos/forja-cinza';
  },

  async checkForUpdates(channel: UpdateChannel = 'stable'): Promise<UpdateCheckResult> {
    if (isTauriEnv()) {
      return invoke<UpdateCheckResult>('check_for_updates', { channel });
    }
    return {
      channel,
      source: 'git-branch',
      repo_dir: '~/.local/share/game-hub',
      branch: channel,
      release_tag: null,
      current_commit: 'mock000',
      remote_commit: 'mock000',
      commits_behind: 0,
      update_available: false,
      has_prebuilt_asset: false,
      changelog: [],
    };
  },

  async applyUpdate(channel: UpdateChannel = 'stable'): Promise<UpdateApplyResult> {
    if (isTauriEnv()) {
      return invoke<UpdateApplyResult>('apply_update', { channel });
    }
    return {
      channel,
      source: 'git-branch',
      updated: false,
      new_commit: 'mock000',
      release_tag: null,
      message: 'Modo navegador (mock): atualização via GitHub disponível apenas no app desktop.',
      changelog: [],
      output_log: '',
    };
  },

  async restartApp(): Promise<void> {
    if (isTauriEnv()) {
      return invoke<void>('restart_app');
    }
    window.location.reload();
  },
};
