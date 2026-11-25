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
  role?: string | null;
  model?: string | null;
  cycle?: number | null;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'error' | 'cancelled' | string;
  started_at?: string | null;
  finished_at?: string | null;
  duration_ms?: number | null;
  verdict?: string | null;
  summary?: string | null;
}

export interface LoopRunState {
  run_id: string;
  workflow: string;
  title: string;
  status:
    | 'queued'
    | 'queued-offline'
    | 'running'
    | 'completed'
    | 'failed'
    | 'error'
    | 'cancelled'
    | 'stopped'
    | string;
  raw_status?: string | null;
  branch?: string | null;
  worktree_path?: string | null;
  current_stage?: string | null;
  current_cycle?: number | null;
  max_cycles?: number | null;
  created_at: string;
  updated_at: string;
  stages: LoopStage[];
  files?: string[];
  summary?: string | null;
  error?: string | null;
  engine_pid?: number | null;
}

export interface LoopWorkflowInfo {
  name: string;
  source: string;
  description: string;
}

export interface LoopCheckResult {
  ok: boolean;
  tchelvis_available: boolean;
  auto_approve_enabled?: boolean | null;
  workflow: string;
  output: string;
}

export interface DispatchLoopOptions {
  use_overrides?: string[];
  max_cycles?: number | null;
  from_head?: boolean;
}

export interface WorkspaceInfo {
  root_path: string;
  name: string;
  is_uninitialized: boolean;
  project_config: ProjectConfig | null;
  orphan_worktrees: string[];
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

export interface PiProviderCatalogEntry {
  id: string;
  label: string;
  supports_api_key: boolean;
  supports_oauth: boolean;
  configured: boolean;
  auth_type: string | null;
  env_var_hint: string | null;
  suggested_models: string[];
}

export interface PiSetupStatus {
  pi_available: boolean;
  pi_bin: string | null;
  first_run_completed: boolean;
  needs_setup: boolean;
  active_provider: string | null;
  active_model: string | null;
  provider_ready: boolean;
  configured_providers: string[];
  providers: PiProviderCatalogEntry[];
  available_models: string[];
}

/** One model pi can use. Never carries base URLs, headers or credentials. */
export interface PiModelInfo {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  image_input: boolean;
  context_window: number | null;
  max_output: number | null;
  /** USD per million input tokens. */
  cost_in: number | null;
  /** USD per million output tokens. */
  cost_out: number | null;
}

export interface PiModelCatalog {
  source: 'pi_rpc' | 'models_store' | 'curated' | string;
  models: PiModelInfo[];
  /** Why `pi_rpc` was not used; null when it was. */
  fallback_reason: string | null;
}

export interface PiConfigureProviderRequest {
  provider: string;
  model?: string | null;
  api_key?: string | null;
  mark_completed: boolean;
}

export interface PiAuthCheckResult {
  status: string;
  provider: string;
  auth_type: string | null;
  reason: string | null;
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

export interface FlowGenerationRequest {
  prompt: string;
  save_path: string;
  aspect_ratio?: string | null;
  timeout_secs?: number | null;
}

export interface FlowGenerationResult {
  job_id: string;
  status: string;
  saved_path: string;
  byte_size: number;
  sha256: string;
  markdown_embed: string;
  obsidian_embed: string;
  backend_used: string;
}

export interface FlowBridgeCallbackPayload {
  job_id: string;
  token?: string | null;
  status: string;
  image_base64?: string | null;
  image_bytes?: number[] | null;
  mime_type?: string | null;
  error?: string | null;
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

export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserPanelState {
  initialized: boolean;
  url: string;
  title: string;
  visible: boolean;
  loading: boolean;
  bounds: BrowserBounds;
  can_go_back: boolean;
  can_go_forward: boolean;
}

export interface BrowserSnapshotResult {
  data_url?: string | null;
  width: number;
  height: number;
  backend: string;
  fallback_reason?: string | null;
}

export interface GitMergeCheckResult {
  can_merge?: boolean;
  can_merge_cleanly: boolean;
  dirty_files: string[];
  colliding_files: string[];
  conflicting_dirty_files?: string[];
  requires_stash: boolean;
  worktree_path?: string | null;
  branch?: string;
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

const mockWorkflows: LoopWorkflowInfo[] = [
  {
    name: 'fast-worker-reviewer',
    source: 'preset',
    description: 'Implementa e revisa em ciclo rápido',
  },
  {
    name: 'designer-worker-reviewer',
    source: 'preset',
    description: 'Projeta a solução, implementa e revisa antes de aprovar',
  },
  {
    name: 'worker-reviewer-critic',
    source: 'preset',
    description: 'Implementa, revisa e audita antes de aprovar',
  },
  {
    name: 'planner-worker-tester-critic',
    source: 'preset',
    description: 'Planeja, implementa, testa e audita antes de aprovar',
  },
];

const mockLoopRuns: LoopRunState[] = [
  {
    run_id: 'run-20261123-01',
    workflow: 'fast-worker-reviewer',
    title: 'Implementar barra de calor no HUD',
    status: 'completed',
    raw_status: 'PASS',
    branch: 'loop/fast-worker-reviewer-run-20261123-01',
    worktree_path: null,
    current_stage: 'review',
    current_cycle: 1,
    max_cycles: 3,
    created_at: '2026-11-23T18:10:00Z',
    updated_at: '2026-11-23T18:22:00Z',
    stages: [
      {
        name: 'implement',
        role: 'worker',
        model: 'pi:opencode-go/deepseek-v4.1-flash',
        cycle: 1,
        status: 'completed',
        duration_ms: 10400,
        summary: 'Shader + HUD criados',
      },
      {
        name: 'review',
        role: 'reviewer',
        model: 'pi:opencode-go/hy4-flash-free',
        cycle: 1,
        status: 'completed',
        duration_ms: 8200,
        verdict: 'PASS',
        summary: '12/12 testes passaram',
      },
    ],
    files: ['src/hud/heat_bar.gd', 'tests/test_heat_bar.gd'],
    summary: 'Barra de calor integrada ao HUD com transição térmica.',
  },
];

let mockLayoutJson: string | null = null;
const mockPresets = new Map<string, string>();
let mockPreviewRunning = false;
let mockPtyCounter = 0;

const FORBIDDEN_BROWSER_SCHEMES = [
  'file:',
  'javascript:',
  'data:',
  'vbscript:',
  'tauri:',
  'ipc:',
  'asset:',
  'blob:',
  'about:',
];

export function isAllowedBrowserUrl(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  const lower = trimmed.toLowerCase();
  if (!lower.startsWith('http://') && !lower.startsWith('https://')) {
    return false;
  }
  if (/[\s\x00-\x1f\x7f]/.test(trimmed)) {
    return false;
  }
  const rest = trimmed.slice(trimmed.indexOf('://') + 3);
  const host = rest.split(/[/?#]/)[0];
  return host.length > 0;
}

export function normalizeAndValidateBrowserUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('URL must not be empty');
  }
  const lower = trimmed.toLowerCase();
  for (const scheme of FORBIDDEN_BROWSER_SCHEMES) {
    if (lower.startsWith(scheme)) {
      throw new Error(`blocked URL scheme in '${trimmed}' (only http:// and https:// are allowed)`);
    }
  }
  let candidate = trimmed;
  if (!lower.startsWith('http://') && !lower.startsWith('https://')) {
    if (trimmed.includes('://')) {
      throw new Error(`blocked URL scheme in '${trimmed}' (only http:// and https:// are allowed)`);
    }
    if (lower.startsWith('localhost') || lower.startsWith('127.0.0.1')) {
      candidate = `http://${trimmed}`;
    } else {
      candidate = `https://${trimmed}`;
    }
  }
  if (!isAllowedBrowserUrl(candidate)) {
    throw new Error(`invalid browser URL: '${trimmed}'`);
  }
  return candidate;
}

const MOCK_1X1_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

const mockBrowserHistory: string[] = [];
let mockBrowserHistoryIndex = 0;
let mockBrowserState: BrowserPanelState = {
  initialized: false,
  url: 'https://labs.google/fx/tools/flow',
  title: 'Browser',
  visible: false,
  loading: false,
  bounds: { x: 0, y: 0, width: 800, height: 600 },
  can_go_back: false,
  can_go_forward: false,
};

function syncMockBrowserHistoryFlags(): BrowserPanelState {
  mockBrowserState = {
    ...mockBrowserState,
    can_go_back: mockBrowserHistoryIndex > 0,
    can_go_forward: mockBrowserHistoryIndex + 1 < mockBrowserHistory.length,
  };
  return { ...mockBrowserState, bounds: { ...mockBrowserState.bounds } };
}

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

  async listLoopWorkflows(): Promise<LoopWorkflowInfo[]> {
    if (isTauriEnv()) {
      return invoke<LoopWorkflowInfo[]>('list_loop_workflows');
    }
    return [...mockWorkflows];
  },

  async checkLoop(workflow: string, useOverrides: string[] = []): Promise<LoopCheckResult> {
    if (isTauriEnv()) {
      return invoke<LoopCheckResult>('check_loop', {
        workflow,
        useOverrides: useOverrides.length > 0 ? useOverrides : null,
      });
    }
    return {
      ok: true,
      tchelvis_available: true,
      auto_approve_enabled: true,
      workflow,
      output: `Workflow '${workflow}' válido (mock). Overrides: ${useOverrides.join(', ') || 'padrão'}.`,
    };
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

  async dispatchLoop(
    workflow: string,
    title: string,
    specMarkdown: string,
    options?: DispatchLoopOptions
  ): Promise<LoopRunState> {
    if (isTauriEnv()) {
      return invoke<LoopRunState>('dispatch_loop', {
        workflow,
        title,
        specMarkdown,
        options: options ?? null,
      });
    }
    const now = new Date().toISOString();
    const runId = `run-${Date.now()}`;
    const firstOverride = options?.use_overrides?.[0]?.split('=')[1] ?? 'pi:opencode-go/deepseek-v4.1-flash';
    const run: LoopRunState = {
      run_id: runId,
      workflow,
      title,
      status: 'running',
      raw_status: 'RUNNING',
      branch: `loop/${workflow}-${runId}`,
      worktree_path: null,
      current_stage: 'implement',
      current_cycle: 1,
      max_cycles: options?.max_cycles ?? 3,
      created_at: now,
      updated_at: now,
      stages: [
        {
          name: 'implement',
          role: 'worker',
          model: firstOverride,
          cycle: 1,
          status: 'running',
        },
      ],
      files: [],
      summary: specMarkdown.slice(0, 120),
    };
    mockLoopRuns.unshift(run);
    return run;
  },

  async stopLoop(runId: string): Promise<void> {
    if (isTauriEnv()) {
      return invoke<void>('stop_loop', { runId });
    }
    const target = mockLoopRuns.find((r) => r.run_id === runId);
    if (target) {
      target.status = 'cancelled';
      target.raw_status = 'CANCELLED';
      target.updated_at = new Date().toISOString();
    }
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
    return {
      can_merge: true,
      can_merge_cleanly: true,
      dirty_files: [],
      colliding_files: [],
      conflicting_dirty_files: [],
      requires_stash: false,
      worktree_path: null,
      branch: `loop/${runId}`,
    };
  },

  async gitMergeWorktree(runId: string, stashDirty: boolean): Promise<GitMergeResult> {
    if (isTauriEnv()) {
      return invoke<GitMergeResult>('git_merge_worktree', { runId, stashDirty });
    }
    return {
      merged: true,
      stashed: stashDirty,
      message: `Loop ${runId} integrado com sucesso (mock).`,
    };
  },

  async gitListOrphanWorktrees(): Promise<string[]> {
    if (isTauriEnv()) {
      return invoke<string[]>('git_list_orphan_worktrees');
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

  async cancelUpdateCheck(): Promise<void> {
    if (isTauriEnv()) {
      await invoke<void>('cancel_update_check');
    }
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

  async dispatchFlowGeneration(req: FlowGenerationRequest): Promise<FlowGenerationResult> {
    if (isTauriEnv()) {
      return invoke<FlowGenerationResult>('dispatch_flow_generation', {
        prompt: req.prompt,
        savePath: req.save_path,
        aspectRatio: req.aspect_ratio ?? null,
        timeoutSecs: req.timeout_secs ?? null,
      });
    }
    const cleanPath = req.save_path.trim() || `brainstorm/img/flow-${Date.now()}.png`;
    const stem = cleanPath.split('/').pop()?.replace(/\.[^.]+$/, '') ?? 'reference';
    mockFiles.set(cleanPath, 'mock-png-bytes');
    return {
      job_id: `mock-flow-${Date.now()}`,
      status: 'OK',
      saved_path: cleanPath,
      byte_size: 1024,
      sha256: computeSimpleHash(cleanPath),
      markdown_embed: `![${stem}](${cleanPath})`,
      obsidian_embed: `![[${cleanPath}]]`,
      backend_used: 'mock_flow_browser',
    };
  },

  async flowBridgeResult(payload: FlowBridgeCallbackPayload): Promise<FlowGenerationResult> {
    if (isTauriEnv()) {
      return invoke<FlowGenerationResult>('flow_bridge_result', {
        jobId: payload.job_id,
        status: payload.status,
        imageBytes: payload.image_bytes ?? null,
        imageBase64: payload.image_base64 ?? null,
        token: payload.token ?? null,
        error: payload.error ?? null,
      });
    }
    return {
      job_id: payload.job_id,
      status: payload.status,
      saved_path: 'brainstorm/img/mock.png',
      byte_size: 128,
      sha256: 'mock',
      markdown_embed: '![mock](brainstorm/img/mock.png)',
      obsidian_embed: '![[brainstorm/img/mock.png]]',
      backend_used: 'mock',
    };
  },

  async openFlowBrowser(): Promise<string> {
    if (isTauriEnv()) {
      return invoke<string>('open_flow_browser');
    }
    return 'https://labs.google/fx/tools/flow';
  },

  async browserNavigate(url: string, bounds?: BrowserBounds): Promise<BrowserPanelState> {
    if (isTauriEnv()) {
      return invoke<BrowserPanelState>('browser_navigate', { url, bounds: bounds ?? null });
    }
    const validUrl = normalizeAndValidateBrowserUrl(url);
    if (bounds) {
      mockBrowserState.bounds = {
        x: bounds.x,
        y: bounds.y,
        width: Math.max(1, bounds.width),
        height: Math.max(1, bounds.height),
      };
    }
    if (!mockBrowserState.initialized) {
      mockBrowserState.initialized = true;
      mockBrowserState.visible = true;
    }
    mockBrowserState.url = validUrl;
    if (mockBrowserHistory.length === 0) {
      mockBrowserHistory.push(validUrl);
      mockBrowserHistoryIndex = 0;
    } else if (mockBrowserHistory[mockBrowserHistoryIndex] !== validUrl) {
      mockBrowserHistory.splice(mockBrowserHistoryIndex + 1);
      mockBrowserHistory.push(validUrl);
      mockBrowserHistoryIndex = mockBrowserHistory.length - 1;
    }
    return syncMockBrowserHistoryFlags();
  },

  async browserSyncBounds(bounds: BrowserBounds): Promise<BrowserPanelState> {
    if (isTauriEnv()) {
      return invoke<BrowserPanelState>('browser_sync_bounds', { bounds });
    }
    mockBrowserState.bounds = {
      x: bounds.x,
      y: bounds.y,
      width: Math.max(1, bounds.width),
      height: Math.max(1, bounds.height),
    };
    return syncMockBrowserHistoryFlags();
  },

  async browserSetVisible(visible: boolean): Promise<BrowserPanelState> {
    if (isTauriEnv()) {
      return invoke<BrowserPanelState>('browser_set_visible', { visible });
    }
    mockBrowserState.visible = visible;
    return syncMockBrowserHistoryFlags();
  },

  async browserGoBack(): Promise<BrowserPanelState> {
    if (isTauriEnv()) {
      return invoke<BrowserPanelState>('browser_go_back');
    }
    if (mockBrowserHistoryIndex > 0) {
      mockBrowserHistoryIndex -= 1;
      mockBrowserState.url = mockBrowserHistory[mockBrowserHistoryIndex];
    }
    return syncMockBrowserHistoryFlags();
  },

  async browserGoForward(): Promise<BrowserPanelState> {
    if (isTauriEnv()) {
      return invoke<BrowserPanelState>('browser_go_forward');
    }
    if (mockBrowserHistoryIndex + 1 < mockBrowserHistory.length) {
      mockBrowserHistoryIndex += 1;
      mockBrowserState.url = mockBrowserHistory[mockBrowserHistoryIndex];
    }
    return syncMockBrowserHistoryFlags();
  },

  async browserReload(): Promise<BrowserPanelState> {
    if (isTauriEnv()) {
      return invoke<BrowserPanelState>('browser_reload');
    }
    return syncMockBrowserHistoryFlags();
  },

  async browserClose(): Promise<BrowserPanelState> {
    if (isTauriEnv()) {
      return invoke<BrowserPanelState>('browser_close');
    }
    mockBrowserState.initialized = false;
    mockBrowserState.visible = false;
    mockBrowserState.loading = false;
    return syncMockBrowserHistoryFlags();
  },

  async browserGetState(): Promise<BrowserPanelState> {
    if (isTauriEnv()) {
      return invoke<BrowserPanelState>('browser_get_state');
    }
    return syncMockBrowserHistoryFlags();
  },

  async browserCaptureSnapshot(bounds?: BrowserBounds): Promise<BrowserSnapshotResult> {
    if (isTauriEnv()) {
      return invoke<BrowserSnapshotResult>('browser_capture_snapshot', {
        bounds: bounds ?? null,
      });
    }
    const target = bounds ?? mockBrowserState.bounds;
    mockBrowserState.visible = false;
    return {
      data_url: MOCK_1X1_PNG_DATA_URL,
      width: Math.max(1, Math.round(target.width)),
      height: Math.max(1, Math.round(target.height)),
      backend: 'mock_grim',
      fallback_reason: null,
    };
  },

  async piGetSetupStatus(): Promise<PiSetupStatus> {
    if (isTauriEnv()) {
      return invoke<PiSetupStatus>('pi_get_setup_status');
    }
    return loadMockPiSetup();
  },

  async piListModels(): Promise<PiModelCatalog> {
    if (isTauriEnv()) {
      return invoke<PiModelCatalog>('pi_list_models');
    }
    return mockPiModelCatalog(loadMockPiSetup());
  },

  async piCheckProvider(provider: string): Promise<PiAuthCheckResult> {
    if (isTauriEnv()) {
      return invoke<PiAuthCheckResult>('pi_check_provider', { provider });
    }
    const status = loadMockPiSetup();
    const entry = status.providers.find((p) => p.id === provider);
    if (entry?.configured) {
      return {
        status: 'ready',
        provider,
        auth_type: entry.auth_type ?? 'api_key',
        reason: null,
      };
    }
    return {
      status: 'not_ready',
      provider,
      auth_type: null,
      reason: 'credentials_not_configured',
    };
  },

  async piConfigureProvider(req: PiConfigureProviderRequest): Promise<PiSetupStatus> {
    if (isTauriEnv()) {
      return invoke<PiSetupStatus>('pi_configure_provider', { req });
    }
    const status = loadMockPiSetup();
    if (req.provider === 'offline' && req.mark_completed) {
      status.first_run_completed = true;
      status.needs_setup = false;
      status.provider_ready = false;
      saveMockPiSetup(status);
      return status;
    }
    const target = status.providers.find((p) => p.id === req.provider);
    const hasKey = Boolean(req.api_key && req.api_key.trim().length > 0);
    if (hasKey) {
      if (target) {
        target.configured = true;
        target.auth_type = 'api_key';
      } else {
        status.providers.push({
          id: req.provider,
          label: req.provider,
          supports_api_key: true,
          supports_oauth: true,
          configured: true,
          auth_type: 'api_key',
          env_var_hint: null,
          suggested_models: [],
        });
      }
      if (!status.configured_providers.includes(req.provider)) {
        status.configured_providers.push(req.provider);
      }
    }
    status.active_provider = req.provider;
    const chosenModel =
      req.model?.trim() || target?.suggested_models[0] || status.active_model || null;
    status.active_model = chosenModel;
    status.available_models = target?.suggested_models ?? (chosenModel ? [chosenModel] : []);
    status.provider_ready = status.configured_providers.includes(req.provider);
    if (req.mark_completed) {
      status.first_run_completed = true;
    }
    status.needs_setup = !status.first_run_completed || !status.provider_ready;
    saveMockPiSetup(status);
    return status;
  },

  async piLogoutProvider(provider: string): Promise<PiSetupStatus> {
    if (isTauriEnv()) {
      return invoke<PiSetupStatus>('pi_logout_provider', { provider });
    }
    const status = loadMockPiSetup();
    status.configured_providers = status.configured_providers.filter((p) => p !== provider);
    const target = status.providers.find((p) => p.id === provider);
    if (target) {
      target.configured = false;
      target.auth_type = null;
    }
    if (status.active_provider === provider) {
      status.provider_ready = false;
      status.needs_setup = true;
    }
    saveMockPiSetup(status);
    return status;
  },
};

const MOCK_PI_SETUP_KEY = 'game-hub:mock-pi-setup';

function defaultMockPiSetup(): PiSetupStatus {
  const providers: PiProviderCatalogEntry[] = [
    {
      id: 'opencode-go',
      label: 'OpenCode Go',
      supports_api_key: true,
      supports_oauth: true,
      configured: false,
      auth_type: null,
      env_var_hint: 'OPENCODE_API_KEY',
      suggested_models: ['deepseek-v4.1-flash', 'hy4-flash-free', 'claude-haiku-5-5'],
    },
    {
      id: 'openrouter',
      label: 'OpenRouter',
      supports_api_key: true,
      supports_oauth: true,
      configured: false,
      auth_type: null,
      env_var_hint: 'OPENROUTER_API_KEY',
      suggested_models: [
        'anthropic/claude-sonnet-4.5',
        'deepseek/deepseek-chat',
        'google/gemini-2.5-flash',
      ],
    },
    {
      id: 'anthropic',
      label: 'Anthropic (Claude)',
      supports_api_key: true,
      supports_oauth: true,
      configured: false,
      auth_type: null,
      env_var_hint: 'ANTHROPIC_API_KEY',
      suggested_models: ['claude-sonnet-4-5', 'claude-haiku-5-5'],
    },
    {
      id: 'openai',
      label: 'OpenAI',
      supports_api_key: true,
      supports_oauth: false,
      configured: false,
      auth_type: null,
      env_var_hint: 'OPENAI_API_KEY',
      suggested_models: ['gpt-5', 'gpt-4.1', 'gpt-4.1-mini'],
    },
    {
      id: 'openai-codex',
      label: 'OpenAI Codex (ChatGPT OAuth)',
      supports_api_key: false,
      supports_oauth: true,
      configured: false,
      auth_type: null,
      env_var_hint: null,
      suggested_models: ['codex-mini-latest', 'gpt-5-codex'],
    },
    {
      id: 'google',
      label: 'Google Gemini',
      supports_api_key: true,
      supports_oauth: true,
      configured: false,
      auth_type: null,
      env_var_hint: 'GEMINI_API_KEY',
      suggested_models: ['gemini-2.5-pro', 'gemini-2.5-flash'],
    },
  ];
  return {
    pi_available: true,
    pi_bin: 'pi',
    first_run_completed: false,
    needs_setup: true,
    active_provider: null,
    active_model: null,
    provider_ready: false,
    configured_providers: [],
    providers,
    available_models: [],
  };
}

function mockModelInfo(provider: string, id: string): PiModelInfo {
  return {
    provider,
    id,
    name: id,
    reasoning: false,
    image_input: false,
    context_window: null,
    max_output: null,
    cost_in: null,
    cost_out: null,
  };
}

/** Mirrors the Rust fallback chain: connected providers answer like pi RPC, otherwise curated suggestions. */
function mockPiModelCatalog(status: PiSetupStatus): PiModelCatalog {
  const connected = status.providers.filter((p) => p.configured);
  if (connected.length > 0) {
    return {
      source: 'pi_rpc',
      models: connected.flatMap((p) => p.suggested_models.map((id) => mockModelInfo(p.id, id))),
      fallback_reason: null,
    };
  }
  return {
    source: 'curated',
    models: status.providers.flatMap((p) => p.suggested_models.map((id) => mockModelInfo(p.id, id))),
    fallback_reason: 'pi reported no models (is a provider connected?)',
  };
}

let inMemoryMockPiSetup: PiSetupStatus | null = null;

function loadMockPiSetup(): PiSetupStatus {
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(MOCK_PI_SETUP_KEY);
      if (raw) {
        return JSON.parse(raw) as PiSetupStatus;
      }
    }
  } catch {
    // ignore storage errors in restricted environments
  }
  if (!inMemoryMockPiSetup) {
    inMemoryMockPiSetup = defaultMockPiSetup();
  }
  return structuredClone(inMemoryMockPiSetup);
}

function saveMockPiSetup(status: PiSetupStatus): void {
  inMemoryMockPiSetup = structuredClone(status);
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(MOCK_PI_SETUP_KEY, JSON.stringify(status));
    }
  } catch {
    // ignore storage errors
  }
}

export function resetMockPiSetup(): void {
  inMemoryMockPiSetup = null;
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(MOCK_PI_SETUP_KEY);
    }
  } catch {
    // ignore storage errors
  }
}
