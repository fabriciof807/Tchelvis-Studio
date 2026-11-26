import { create } from 'zustand';
import {
  getInitialLocale,
  LOCALE_STORAGE_KEY,
  translate,
  type Locale,
} from '../i18n';
import { applyTheme, getInitialTheme, type ThemeId } from '../themes';
import {
  ipc,
  type AmbientEnvelope,
  type FileTreeNode,
  type LensInfo,
  type LoopRunState,
  type OneShotAttachment,
  type PiConfigureProviderRequest,
  type PiConnectResult,
  type PiEventPayload,
  type PiModelCatalog,
  type PiSetupStatus,
  type PiToolCall,
  type PreviewCaptureResult,
  type PreviewStatus,
  type RecentWorkspace,
  type UpdateChannel,
  type WorkspaceInfo,
} from '../types/ipc';
import {
  buildProviderRows,
  connectedProviderIds,
  isValidSlug,
  pickFallbackDefault,
  pickInitialDefault,
  type SignInPhase,
} from '../components/providerDialog/providerDialogLogic';
import {
  createSignInPoller,
  type SignInPollState,
  type SignInPoller,
} from '../components/providerDialog/signInPoller';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  timestamp: string;
  mode?: string;
  tool_calls?: PiToolCall[];
  attachments?: OneShotAttachment[];
}

export interface PanelOpenRequest {
  requestId: string;
  panelType: 'markdown' | 'loops' | 'terminal' | 'lens' | 'media';
  title: string;
  params: Record<string, unknown>;
}

export type LeftSection = 'explorer' | 'loops' | 'lenses';

/** A default change worth reporting; `model` is null when pi will use its own default. */
export interface DefaultChange {
  provider: string;
  model: string | null;
}

/** `starting` means the backend is spawning/healthchecking; the game isn't running yet. */
export type PreviewPhase = 'idle' | 'starting' | 'running' | 'error';

/** Explicit result of a preview action: the caller must not infer it from the phase. */
export type PreviewStartOutcome = 'ok' | 'cancelled' | { error: string };
export type PreviewCaptureOutcome = 'ok' | 'cancelled' | { error: string };

interface WorkspaceState {
  // Workspace & Files
  workspace: WorkspaceInfo | null;
  recentWorkspaces: RecentWorkspace[];
  fileTree: FileTreeNode[];
  openTabs: string[];
  focusedPanel: string | null;
  dirtyFiles: string[];

  // One-shot attachments & captures
  oneShotAttachments: OneShotAttachment[];
  totalCapturesBytes: number;
  capturesQuotaExceeded: boolean;

  // Modals & Drawers
  activeModalCount: number;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  bottomCollapsed: boolean;
  zenMode: boolean;
  activeLeftSection: LeftSection;

  // Loops, Lenses, Preview
  loopRuns: LoopRunState[];
  lenses: LensInfo[];
  previewStatus: PreviewStatus | null;
  previewLightboxOpen: boolean;
  previewPhase: PreviewPhase;
  previewError: string | null;
  /** Last start request, reused by Retry so a staging failure retries the same tree. */
  lastPreviewRequest: { mode: 'main' | 'staging'; worktreePath: string | null } | null;

  piSetupStatus: PiSetupStatus | null;
  /** Last known pi model catalog; kept while a refetch runs (stale-while-revalidate). */
  modelCatalog: PiModelCatalog | null;
  modelCatalogLoading: boolean;
  modelCatalogError: string | null;
  providerDialog: { open: boolean; preselect: string | null; hiddenForSignIn: boolean };
  providerSignIn: {
    provider: string;
    phase: SignInPhase;
    startedAt: number;
    detail: string | null;
    /** True for a re-sign-in: no auto-poll, and restarts keep that mode. */
    manualOnly?: boolean;
  } | null;
  pendingTerminalCommand: string | null;

  // UI Language, Theme & Update Channel
  locale: Locale;
  setLocale: (locale: Locale) => void;
  theme: ThemeId;
  setTheme: (theme: ThemeId) => void;
  updateChannel: UpdateChannel;
  setUpdateChannel: (channel: UpdateChannel) => void;

  // Chat
  chatMessages: ChatMessage[];
  subagentStatuses: Record<string, { status: string; detail?: string }>;
  compactionNotice: string | null;
  isSendingChat: boolean;
  activeTurnId: string | null;

  // Panel open bridge for DockManager
  pendingPanelRequest: PanelOpenRequest | null;

  // Actions
  loadRecentWorkspaces: () => Promise<void>;
  openWorkspace: (path: string) => Promise<void>;
  closeWorkspace: () => void;
  refreshFileTree: () => Promise<void>;
  refreshLenses: () => Promise<void>;
  refreshLoopRuns: () => Promise<void>;

  setFocusedPanel: (panelId: string | null) => void;
  registerOpenTab: (relPath: string) => void;
  unregisterOpenTab: (relPath: string) => void;
  markDirty: (relPath: string, isDirty: boolean) => void;

  addOneShotAttachment: (attachment: OneShotAttachment) => void;
  removeOneShotAttachment: (index: number) => void;
  clearOneShotAttachments: () => void;
  setCaptureQuotaStatus: (totalBytes: number, exceeded: boolean) => void;

  incrementModalCount: () => void;
  decrementModalCount: () => void;

  setActiveLeftSection: (section: LeftSection) => void;
  toggleLeft: () => void;
  toggleRight: () => void;
  toggleBottom: () => void;
  toggleZenMode: () => void;

  requestOpenPanel: (
    panelType: PanelOpenRequest['panelType'],
    title: string,
    params: Record<string, unknown>
  ) => void;
  clearPendingPanelRequest: () => void;

  sendChatMessage: (userMessage: string) => Promise<void>;
  handlePiEvent: (event: PiEventPayload) => void;

  startPreview: (
    mode: 'main' | 'staging',
    worktreePath?: string
  ) => Promise<PreviewStartOutcome>;
  retryPreview: () => void;
  cancelPreviewStart: () => Promise<void>;
  refreshPreviewStatus: () => Promise<void>;
  focusPreview: () => Promise<void>;
  handlePreviewHotkey: () => void;
  stopPreview: () => Promise<void>;
  capturePreviewFrame: () => Promise<PreviewCaptureOutcome>;
  setPreviewLightboxOpen: (open: boolean) => void;

  refreshPiSetupStatus: () => Promise<PiSetupStatus | null>;
  openProviderDialog: (provider?: string) => void;
  closeProviderDialog: () => void;
  connectPiProvider: (
    provider: string,
    apiKey: string
  ) => Promise<{ result: PiConnectResult; defaultChangedTo: DefaultChange | null }>;
  /**
   * `refetchCatalogOnReady` is set by "Sign in again": the model set can depend on the plan.
   * `manualOnly` disables the auto-poll and timeout: the user confirms the new login manually.
   */
  startProviderSignIn: (
    provider: string,
    options?: { refetchCatalogOnReady?: boolean; manualOnly?: boolean }
  ) => void;
  checkProviderSignInNow: () => void;
  cancelProviderSignIn: () => void;
  revealProviderDialog: () => void;
  /** Hides the modal so the terminal is usable, without typing anything into it. */
  hideProviderDialogForSignIn: () => void;
  disconnectPiProvider: (
    provider: string
  ) => Promise<{ defaultChangedTo: DefaultChange | null; stillViaEnv: boolean }>;
  saveDefaultModel: (
    selection: { provider: string; id: string } | null,
    markCompleted: boolean
  ) => Promise<void>;
  configurePiProvider: (req: PiConfigureProviderRequest) => Promise<PiSetupStatus>;
  logoutPiProvider: (provider: string) => Promise<PiSetupStatus>;
  loadModelCatalog: () => Promise<PiModelCatalog | null>;
  skipPiSetup: () => Promise<PiSetupStatus>;
  launchPiInteractiveLogin: (provider: string) => void;
  consumePendingTerminalCommand: () => string | null;
}

const UPDATE_CHANNEL_KEY = 'game-hub:update-channel';

function getInitialUpdateChannel(): UpdateChannel {
  if (typeof window !== 'undefined') {
    try {
      const saved = window.localStorage.getItem(UPDATE_CHANNEL_KEY);
      if (saved === 'nightly' || saved === 'stable') return saved;
    } catch {
      // ignore storage errors
    }
  }
  return 'stable';
}

function parseFlowSlashCommand(
  trimmed: string
): { save_path: string; prompt: string; aspect_ratio?: string } | null {
  if (!trimmed.startsWith('/flow ')) return null;
  const rest = trimmed.slice(6).trim();
  if (!rest) return null;

  const firstSpace = rest.indexOf(' ');
  const firstToken = firstSpace >= 0 ? rest.slice(0, firstSpace) : rest;
  const isImagePath = /\.(png|jpe?g|webp)$/i.test(firstToken) && firstSpace > 0;

  if (isImagePath) {
    return {
      save_path: firstToken,
      prompt: rest.slice(firstSpace + 1).trim(),
    };
  }
  return {
    save_path: `brainstorm/img/flow-${Date.now()}.png`,
    prompt: rest,
  };
}

function parseLoopSlashCommand(trimmed: string): { title: string; prompt: string } | null {
  if (!trimmed.startsWith('/loop ')) return null;
  const rest = trimmed.slice(6).trim();
  if (!rest) return null;
  const firstLine = rest.split('\n')[0]?.trim() ?? rest;
  const title = firstLine.length > 64 ? `${firstLine.slice(0, 61)}...` : firstLine;
  return { title, prompt: rest };
}

function computeZenMode(left: boolean, right: boolean, bottom: boolean): boolean {
  return left && right && bottom;
}

function sameMembers(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((x) => set.has(x));
}

/** Only the newest catalog request may write its result, so a slow older one can't overwrite it. */
let modelCatalogRequest = 0;

/** Bumped by cancel/stop so a late start result can't resurrect a cancelled preview. */
let previewStartGeneration = 0;

/** One sign-in poll at a time; the session token invalidates results from a stopped poll. */
let signInPoller: SignInPoller | null = null;
let signInSession = 0;
/** Set by "Sign in again": the provider set is unchanged, but the plan can change the models. */
let signInRefetchCatalogOnReady = false;
/** "Sign in again" on an already-connected provider: no auto-poll, no timeout. */
let signInManualOnly = false;

const CLOSED_PROVIDER_DIALOG = { open: false, preselect: null, hiddenForSignIn: false } as const;

export const useWorkspaceStore = create<WorkspaceState>((set, get) => {
  function stopSignInPoll(): void {
    signInSession += 1;
    signInRefetchCatalogOnReady = false;
    signInManualOnly = false;
    if (signInPoller) {
      signInPoller.stop();
      signInPoller = null;
    }
  }

  /**
   * §4.3 step 5: the first successful Connect (or sign-in) writes a default only when there is no
   * usable one, so chat works even if the user closes the dialog right away.
   */
  async function applyInitialDefaultIfNeeded(provider: string): Promise<DefaultChange | null> {
    const status = get().piSetupStatus;
    if (!status) return null;
    const connected = connectedProviderIds(status);
    const usableDefault =
      status.provider_ready &&
      status.first_run_completed &&
      status.active_provider !== null &&
      connected.includes(status.active_provider);
    if (usableDefault) return null;

    const row = buildProviderRows(status).find((candidate) => candidate.id === provider);
    const model = pickInitialDefault(get().modelCatalog, provider, row?.suggestedModels ?? []);
    await get().configurePiProvider({ provider, model, mark_completed: true });
    // The provider still changed even when the initial model is null (a custom slug with no
    // curated suggestion), so the note must keep both halves.
    return { provider, model };
  }

  async function finishSignInReady(provider: string, session: number): Promise<void> {
    const refetchCatalog = signInRefetchCatalogOnReady;
    signInRefetchCatalogOnReady = false;
    signInManualOnly = false;
    set({
      providerSignIn: null,
      providerDialog: { open: true, preselect: provider, hiddenForSignIn: false },
    });
    await get().refreshPiSetupStatus();
    if (session !== signInSession) return;
    // §4.7: on a re-sign-in the members of `configured_providers` don't change, so
    // `refreshPiSetupStatus` won't refetch; the catalog must be reloaded once the login is ready.
    if (refetchCatalog) void get().loadModelCatalog();
    await applyInitialDefaultIfNeeded(provider);
  }

  function handleSignInPollState(
    provider: string,
    state: SignInPollState,
    session: number
  ): void {
    if (session !== signInSession) return;
    signInPoller = null;
    if (state.kind === 'ready') {
      void finishSignInReady(provider, session);
      return;
    }
    if (state.kind === 'waiting') return;
    const startedAt = get().providerSignIn?.startedAt ?? Date.now();
    set({
      providerSignIn: {
        provider,
        phase: state.kind,
        startedAt,
        detail:
          state.kind === 'invalid'
            ? state.reason
            : state.kind === 'error'
              ? state.detail
              : null,
        manualOnly: false,
      },
    });
  }

  function beginSignInPoll(provider: string, refetchCatalogOnReady = false): void {
    stopSignInPoll();
    signInRefetchCatalogOnReady = refetchCatalogOnReady;
    signInManualOnly = false;
    const session = signInSession;
    set({
      providerSignIn: { provider, phase: 'waiting', startedAt: Date.now(), detail: null, manualOnly: false },
    });
    const poller = createSignInPoller<ReturnType<typeof setTimeout>>({
      provider,
      check: (target) => ipc.piCheckProvider(target),
      schedule: (fn, ms) => setTimeout(fn, ms),
      cancel: (handle) => clearTimeout(handle),
      now: () => Date.now(),
      onState: (state) => handleSignInPollState(provider, state, session),
    });
    signInPoller = poller;
    poller.start();
  }

  function beginManualSignIn(provider: string, refetchCatalogOnReady = false): void {
    stopSignInPoll();
    signInRefetchCatalogOnReady = refetchCatalogOnReady;
    signInManualOnly = true;
    set({
      providerSignIn: { provider, phase: 'waiting', startedAt: Date.now(), detail: null, manualOnly: true },
    });
  }

  /** S-TIMEOUT / S-ERROR "Check again": one check now, then a fresh poll if it isn't ready yet. */
  async function runSingleSignInCheck(provider: string): Promise<void> {
    const session = signInSession;
    const refetchCatalogOnReady = signInRefetchCatalogOnReady;
    const manualOnly = signInManualOnly;
    try {
      const check = await ipc.piCheckProvider(provider);
      if (session !== signInSession) return;
      if (check.status === 'ready') {
        await finishSignInReady(provider, session);
        return;
      }
      if (check.status === 'invalid') {
        set({
          providerSignIn: {
            provider,
            phase: 'invalid',
            startedAt: get().providerSignIn?.startedAt ?? Date.now(),
            detail: check.reason ?? null,
            manualOnly,
          },
        });
        return;
      }
    } catch (err) {
      if (session !== signInSession) return;
      if (manualOnly) {
        set({
          providerSignIn: {
            provider,
            phase: 'error',
            startedAt: get().providerSignIn?.startedAt ?? Date.now(),
            detail: err instanceof Error ? err.message : String(err),
            manualOnly: true,
          },
        });
        return;
      }
    }
    if (session !== signInSession) return;
    if (manualOnly) {
      // "Sign in again" never auto-polls or times out: stay in S-WAITING until the user asks
      // for another manual check.
      const current = get().providerSignIn;
      if (current && current.phase !== 'waiting') {
        set({ providerSignIn: { ...current, phase: 'waiting', detail: null } });
      }
      return;
    }
    beginSignInPoll(provider, refetchCatalogOnReady);
  }

  return {
  workspace: null,
  recentWorkspaces: [],
  fileTree: [],
  openTabs: [],
  focusedPanel: null,
  dirtyFiles: [],

  oneShotAttachments: [],
  totalCapturesBytes: 0,
  capturesQuotaExceeded: false,

  activeModalCount: 0,
  leftCollapsed: false,
  rightCollapsed: false,
  bottomCollapsed: false,
  zenMode: false,
  activeLeftSection: 'explorer',

  loopRuns: [],
  lenses: [],
  previewStatus: null,
  previewLightboxOpen: false,
  previewPhase: 'idle',
  previewError: null,
  lastPreviewRequest: null,

  piSetupStatus: null,
  providerDialog: { ...CLOSED_PROVIDER_DIALOG },
  providerSignIn: null,
  pendingTerminalCommand: null,
  modelCatalog: null,
  modelCatalogLoading: false,
  modelCatalogError: null,

  locale: getInitialLocale(),
  setLocale: (locale) => {
    try {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    } catch {
      // ignore storage errors
    }
    set({ locale });
  },
  theme: getInitialTheme(),
  setTheme: (theme) => {
    applyTheme(theme);
    set({ theme });
  },
  updateChannel: getInitialUpdateChannel(),
  setUpdateChannel: (updateChannel) => {
    try {
      window.localStorage.setItem(UPDATE_CHANNEL_KEY, updateChannel);
    } catch {
      // ignore storage errors
    }
    set({ updateChannel });
  },

  chatMessages: [],
  subagentStatuses: {},
  compactionNotice: null,
  isSendingChat: false,
  activeTurnId: null,

  pendingPanelRequest: null,

  loadRecentWorkspaces: async () => {
    try {
      const recent = await ipc.listRecentWorkspaces();
      set({ recentWorkspaces: recent });
    } catch (err) {
      console.error('Erro ao carregar workspaces recentes:', err);
    }
  },

  openWorkspace: async (path: string) => {
    // A workspace switch resets the chat underneath, so the dialog and any sign-in poll go away.
    stopSignInPoll();
    set({ providerDialog: { ...CLOSED_PROVIDER_DIALOG }, providerSignIn: null });
    const info = await ipc.openWorkspace(path);
    set({
      workspace: info,
      openTabs: [],
      dirtyFiles: [],
      oneShotAttachments: [],
      chatMessages: [],
      subagentStatuses: {},
      compactionNotice: null,
      previewStatus: null,
      previewLightboxOpen: false,
      previewPhase: 'idle',
      previewError: null,
      lastPreviewRequest: null,
    });

    const [tree, lenses, runs, piSetup] = await Promise.all([
      ipc.getWorkspaceTree().catch(() => []),
      ipc.listLenses().catch(() => []),
      ipc.listLoopRuns().catch(() => []),
      ipc.piGetSetupStatus().catch(() => null),
    ]);

    const systemNotes: ChatMessage[] = [];
    if (info.is_uninitialized) {
      systemNotes.push({
        id: `sys-init-${Date.now()}`,
        role: 'system',
        text: 'Diretório não inicializado detectado. Skill `init-game-project` pronta para estruturar o projeto (escolha engine: godot ou web).',
        timestamp: new Date().toISOString(),
      });
    }
    if (info.offline_completed_runs.length > 0) {
      systemNotes.push({
        id: `sys-offline-${Date.now()}`,
        role: 'system',
        text: `${info.offline_completed_runs.length} loop(s) concluído(s) enquanto o Hub estava fechado: ${info.offline_completed_runs
          .map((r) => `${r.title} (${r.status})`)
          .join(', ')}.`,
        timestamp: new Date().toISOString(),
      });
    }

    set({
      fileTree: tree,
      lenses,
      loopRuns: runs,
      chatMessages: systemNotes,
      piSetupStatus: piSetup,
    });
  },

  closeWorkspace: () => {
    stopSignInPoll();
    set({
      providerDialog: { ...CLOSED_PROVIDER_DIALOG },
      providerSignIn: null,
      workspace: null,
      fileTree: [],
      openTabs: [],
      dirtyFiles: [],
      oneShotAttachments: [],
      chatMessages: [],
      lenses: [],
      loopRuns: [],
      previewStatus: null,
      previewLightboxOpen: false,
      previewPhase: 'idle',
      previewError: null,
      lastPreviewRequest: null,
    });
  },

  refreshFileTree: async () => {
    const tree = await ipc.getWorkspaceTree();
    set({ fileTree: tree });
  },

  refreshLenses: async () => {
    const lenses = await ipc.listLenses();
    set({ lenses });
  },

  refreshLoopRuns: async () => {
    const loopRuns = await ipc.listLoopRuns();
    set({ loopRuns });
  },

  setFocusedPanel: (panelId) => set({ focusedPanel: panelId }),

  registerOpenTab: (relPath) =>
    set((state) => ({
      openTabs: state.openTabs.includes(relPath) ? state.openTabs : [...state.openTabs, relPath],
    })),

  unregisterOpenTab: (relPath) =>
    set((state) => ({
      openTabs: state.openTabs.filter((t) => t !== relPath),
      dirtyFiles: state.dirtyFiles.filter((f) => f !== relPath),
    })),

  markDirty: (relPath, isDirty) =>
    set((state) => {
      const exists = state.dirtyFiles.includes(relPath);
      if (isDirty && !exists) {
        return { dirtyFiles: [...state.dirtyFiles, relPath] };
      }
      if (!isDirty && exists) {
        return { dirtyFiles: state.dirtyFiles.filter((f) => f !== relPath) };
      }
      return state;
    }),

  addOneShotAttachment: (attachment) =>
    set((state) => ({
      oneShotAttachments: [...state.oneShotAttachments, attachment],
    })),

  removeOneShotAttachment: (index) =>
    set((state) => ({
      oneShotAttachments: state.oneShotAttachments.filter((_, idx) => idx !== index),
    })),

  clearOneShotAttachments: () => set({ oneShotAttachments: [] }),

  setCaptureQuotaStatus: (totalBytes, exceeded) =>
    set({ totalCapturesBytes: totalBytes, capturesQuotaExceeded: exceeded }),

  incrementModalCount: () =>
    set((state) => ({ activeModalCount: state.activeModalCount + 1 })),

  decrementModalCount: () =>
    set((state) => ({ activeModalCount: Math.max(0, state.activeModalCount - 1) })),

  setActiveLeftSection: (section) =>
    set({ activeLeftSection: section, leftCollapsed: false, zenMode: false }),

  toggleLeft: () =>
    set((state) => {
      const leftCollapsed = !state.leftCollapsed;
      return {
        leftCollapsed,
        zenMode: computeZenMode(leftCollapsed, state.rightCollapsed, state.bottomCollapsed),
      };
    }),

  toggleRight: () =>
    set((state) => {
      const rightCollapsed = !state.rightCollapsed;
      return {
        rightCollapsed,
        zenMode: computeZenMode(state.leftCollapsed, rightCollapsed, state.bottomCollapsed),
      };
    }),

  toggleBottom: () =>
    set((state) => {
      const bottomCollapsed = !state.bottomCollapsed;
      return {
        bottomCollapsed,
        zenMode: computeZenMode(state.leftCollapsed, state.rightCollapsed, bottomCollapsed),
      };
    }),

  toggleZenMode: () =>
    set((state) => {
      const nextZen = !state.zenMode;
      return {
        zenMode: nextZen,
        leftCollapsed: nextZen,
        rightCollapsed: nextZen,
        bottomCollapsed: nextZen,
      };
    }),

  requestOpenPanel: (panelType, title, params) =>
    set({
      pendingPanelRequest: {
        requestId: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        panelType,
        title,
        params,
      },
    }),

  clearPendingPanelRequest: () => set({ pendingPanelRequest: null }),

  sendChatMessage: async (userMessage: string) => {
    const trimmed = userMessage.trim();
    if (!trimmed && get().oneShotAttachments.length === 0) return;

    // Atomically consume one_shot_attachments before async IPC call
    const state = get();
    const attachmentsToSend = [...state.oneShotAttachments];
    const latestRun = state.loopRuns[0]
      ? {
          run_id: state.loopRuns[0].run_id,
          status: state.loopRuns[0].status,
          title: state.loopRuns[0].title,
        }
      : null;

    const envelope: AmbientEnvelope = {
      user_message: trimmed,
      active_context: {
        focused_panel: state.focusedPanel,
        open_tabs: [...state.openTabs],
        dirty_files: [...state.dirtyFiles],
        latest_loop: latestRun,
      },
      one_shot_attachments: attachmentsToSend,
    };

    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      text: trimmed,
      timestamp: new Date().toISOString(),
      attachments: attachmentsToSend,
    };

    set((s) => ({
      oneShotAttachments: [],
      isSendingChat: true,
      chatMessages: [...s.chatMessages, userMsg],
    }));

    const flowCmd = parseFlowSlashCommand(trimmed);
    if (flowCmd) {
      const turnId = `flow-turn-${Date.now()}`;
      const toolId = `flow-tool-${Date.now()}`;
      const runningTool: PiToolCall = {
        id: toolId,
        name: 'generate_flow_reference',
        arguments_json: JSON.stringify(flowCmd, null, 2),
        status: 'running',
      };
      set((s) => ({
        chatMessages: [
          ...s.chatMessages,
          {
            id: turnId,
            role: 'assistant',
            text: `Gerando referência em \`${flowCmd.save_path}\`...`,
            timestamp: new Date().toISOString(),
            tool_calls: [runningTool],
          },
        ],
      }));

      try {
        const res = await ipc.dispatchFlowGeneration(flowCmd);
        await get().refreshFileTree().catch(() => {});
        set((s) => ({
          isSendingChat: false,
          chatMessages: s.chatMessages.map((m) =>
            m.id === turnId
              ? {
                  ...m,
                  text: `Imagem salva em \`${res.saved_path}\` (${res.byte_size} bytes via ${res.backend_used}).\n\nEmbeds:\n- \`${res.markdown_embed}\`\n- \`${res.obsidian_embed}\``,
                  tool_calls: [
                    {
                      ...runningTool,
                      status: 'completed',
                      result_json: JSON.stringify(res, null, 2),
                    },
                  ],
                }
              : m
          ),
        }));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        set((s) => ({
          isSendingChat: false,
          chatMessages: s.chatMessages.map((m) =>
            m.id === turnId
              ? {
                  ...m,
                  text: `Falha ao gerar imagem via Flow: ${msg}`,
                  tool_calls: [
                    {
                      ...runningTool,
                      status: 'error',
                      result_json: msg,
                    },
                  ],
                }
              : m
          ),
        }));
      }
      return;
    }

    const loopCmd = parseLoopSlashCommand(trimmed);
    if (loopCmd) {
      const turnId = `loop-turn-${Date.now()}`;
      const toolId = `loop-tool-${Date.now()}`;
      const dispatchArgs = {
        workflow: 'fast-worker-reviewer',
        title: loopCmd.title,
        spec_markdown: loopCmd.prompt,
        options: {
          from_head: true,
          max_cycles: 3,
          use_overrides: [
            'implement=pi:opencode-go/deepseek-v4.1-flash',
            'review=pi:opencode-go/hy4-flash-free',
          ],
        },
      };
      const runningTool: PiToolCall = {
        id: toolId,
        name: 'dispatch_tchelvis_loop',
        arguments_json: JSON.stringify(dispatchArgs, null, 2),
        status: 'running',
      };
      set((s) => ({
        chatMessages: [
          ...s.chatMessages,
          {
            id: turnId,
            role: 'assistant',
            text: `Iniciando loop \`${dispatchArgs.workflow}\`...`,
            timestamp: new Date().toISOString(),
            tool_calls: [runningTool],
          },
        ],
      }));

      try {
        const run = await ipc.dispatchLoop(
          dispatchArgs.workflow,
          dispatchArgs.title,
          dispatchArgs.spec_markdown,
          dispatchArgs.options
        );
        await get().refreshLoopRuns().catch(() => {});
        get().requestOpenPanel('loops', 'Loops', { runId: run.run_id });
        set((s) => ({
          isSendingChat: false,
          chatMessages: s.chatMessages.map((m) =>
            m.id === turnId
              ? {
                  ...m,
                  text: `Loop \`${run.run_id}\` iniciado (${run.workflow} · status: ${run.status}${run.branch ? ` · branch: \`${run.branch}\`` : ''}).`,
                  tool_calls: [
                    {
                      ...runningTool,
                      status: 'completed',
                      result_json: JSON.stringify(run, null, 2),
                    },
                  ],
                }
              : m
          ),
        }));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        set((s) => ({
          isSendingChat: false,
          chatMessages: s.chatMessages.map((m) =>
            m.id === turnId
              ? {
                  ...m,
                  text: `Falha ao iniciar loop: ${msg}`,
                  tool_calls: [
                    {
                      ...runningTool,
                      status: 'error',
                      result_json: msg,
                    },
                  ],
                }
              : m
          ),
        }));
      }
      return;
    }

    if (get().piSetupStatus?.needs_setup) {
      // Defensive guard for callers other than ChatPanel: no system message, just open the dialog.
      set({ isSendingChat: false });
      get().openProviderDialog();
      return;
    }

    try {
      const ack = await ipc.piSendMessage(envelope);
      const assistantMsg: ChatMessage = {
        id: ack.turn_id,
        role: 'assistant',
        text: ack.reply_text,
        timestamp: new Date().toISOString(),
        mode: ack.mode,
        tool_calls: ack.tool_calls,
      };
      set((s) => {
        // Avoid duplicating if streaming already created this turn_id
        const existingIdx = s.chatMessages.findIndex((m) => m.id === ack.turn_id);
        if (existingIdx >= 0) {
          const updated = [...s.chatMessages];
          updated[existingIdx] = {
            ...updated[existingIdx],
            text: ack.reply_text || updated[existingIdx].text,
            mode: ack.mode,
            tool_calls:
              ack.tool_calls.length > 0 ? ack.tool_calls : updated[existingIdx].tool_calls,
          };
          return { chatMessages: updated, isSendingChat: false, activeTurnId: null };
        }
        return {
          chatMessages: [...s.chatMessages, assistantMsg],
          isSendingChat: false,
          activeTurnId: null,
        };
      });
    } catch (err) {
      const errorMsg: ChatMessage = {
        id: `err-${Date.now()}`,
        role: 'system',
        text: translate(get().locale, 'chat.sendError', {
          error: err instanceof Error ? err.message : String(err),
        }),
        timestamp: new Date().toISOString(),
      };
      set((s) => ({
        chatMessages: [...s.chatMessages, errorMsg],
        isSendingChat: false,
        activeTurnId: null,
      }));
    }
  },

  handlePiEvent: (event: PiEventPayload) => {
    if (event.kind === 'message_delta') {
      set((state) => {
        const idx = state.chatMessages.findIndex((m) => m.id === event.turn_id);
        if (idx >= 0) {
          const updated = [...state.chatMessages];
          updated[idx] = { ...updated[idx], text: updated[idx].text + event.delta };
          return { chatMessages: updated, activeTurnId: event.turn_id };
        }
        return {
          activeTurnId: event.turn_id,
          chatMessages: [
            ...state.chatMessages,
            {
              id: event.turn_id,
              role: 'assistant',
              text: event.delta,
              timestamp: new Date().toISOString(),
            },
          ],
        };
      });
    } else if (event.kind === 'tool_call') {
      set((state) => {
        const idx = state.chatMessages.findIndex((m) => m.id === event.turn_id);
        if (idx < 0) {
          return {
            chatMessages: [
              ...state.chatMessages,
              {
                id: event.turn_id,
                role: 'assistant',
                text: '',
                timestamp: new Date().toISOString(),
                tool_calls: [event.tool_call],
              },
            ],
          };
        }
        const updated = [...state.chatMessages];
        const existingCalls = updated[idx].tool_calls ?? [];
        updated[idx] = { ...updated[idx], tool_calls: [...existingCalls, event.tool_call] };
        return { chatMessages: updated };
      });
    } else if (event.kind === 'tool_result') {
      set((state) => {
        const idx = state.chatMessages.findIndex((m) => m.id === event.turn_id);
        if (idx < 0) return state;
        const updated = [...state.chatMessages];
        const calls = (updated[idx].tool_calls ?? []).map((tc) =>
          tc.id === event.tool_id
            ? { ...tc, result_json: event.result_json, status: event.status }
            : tc
        );
        updated[idx] = { ...updated[idx], tool_calls: calls };
        return { chatMessages: updated };
      });
    } else if (event.kind === 'subagent_status') {
      set((state) => ({
        subagentStatuses: {
          ...state.subagentStatuses,
          [event.subagent]: { status: event.status, detail: event.detail },
        },
      }));
    } else if (event.kind === 'compaction_notice') {
      set({ compactionNotice: event.message });
    }
  },

  startPreview: async (mode, worktreePath) => {
    const generation = ++previewStartGeneration;
    // The overlay opens straight away so the starting state (spinner, logs, Cancel) is visible.
    set({
      lastPreviewRequest: { mode, worktreePath: worktreePath ?? null },
      previewPhase: 'starting',
      previewError: null,
      previewLightboxOpen: true,
    });
    try {
      const status = await ipc.previewStart(mode, worktreePath);
      if (generation !== previewStartGeneration) return 'cancelled';
      set({
        previewStatus: status,
        previewPhase: status.running ? 'running' : 'starting',
        previewLightboxOpen: true,
      });
      return 'ok';
    } catch (err) {
      if (generation !== previewStartGeneration) return 'cancelled';
      // The backend keeps the failed start's log tail, so fetch it for the error state.
      let status: PreviewStatus | null = null;
      try {
        status = await ipc.previewStatus();
      } catch {
        status = null;
      }
      if (generation !== previewStartGeneration) return 'cancelled';
      set({
        previewStatus: status,
        previewPhase: 'error',
        previewError: err instanceof Error ? err.message : String(err),
        previewLightboxOpen: true,
      });
      return { error: err instanceof Error ? err.message : String(err) };
    }
  },

  /** Reuses the last request, so Retry after a staging failure starts staging again. */
  retryPreview: () => {
    const request = get().lastPreviewRequest;
    void get().startPreview(
      request?.mode ?? 'main',
      request?.worktreePath ?? undefined
    );
  },

  cancelPreviewStart: async () => {
    // Invalidate the in-flight start before stopping, so its result can't reopen anything.
    previewStartGeneration += 1;
    set({
      previewStatus: null,
      previewPhase: 'idle',
      previewError: null,
      previewLightboxOpen: false,
    });
    try {
      await ipc.previewStop();
    } catch {
      // Cancelling a start that never spawned is fine.
    }
  },

  refreshPreviewStatus: async () => {
    if (get().previewPhase !== 'starting') return;
    const generation = previewStartGeneration;
    let status: PreviewStatus;
    try {
      status = await ipc.previewStatus();
    } catch {
      return;
    }
    if (generation !== previewStartGeneration) return;
    set({
      previewStatus: status,
      previewPhase: status.running ? 'running' : 'starting',
    });
  },

  focusPreview: async () => {
    try {
      await ipc.previewFocus();
      set({ previewError: null });
    } catch {
      // Without Hyprland the compositor can't focus the window; the bar shows a note.
      set({ previewError: translate(get().locale, 'preview.focusUnsupported') });
    }
  },

  handlePreviewHotkey: () => {
    const state = get();
    // A second F5 while starting must not spawn again; it only brings the starting overlay back.
    if (state.previewPhase === 'starting') {
      set({ previewLightboxOpen: true });
      return;
    }
    if (state.previewPhase === 'running' || state.previewStatus?.running) {
      set({ previewLightboxOpen: true });
      // Confirm the backend still owns a process: closing the game window must let F5 restart.
      const generation = previewStartGeneration;
      void (async () => {
        let status: PreviewStatus;
        try {
          status = await ipc.previewStatus();
        } catch {
          // An IPC failure means "unknown", not "exited": never start a second process on top
          // of a preview that may still be alive. Keep the focus/reopen behaviour instead.
          if (generation !== previewStartGeneration) return;
          if (get().previewStatus?.engine === 'godot') void get().focusPreview();
          return;
        }
        if (generation !== previewStartGeneration) return;
        if (status.running) {
          set({ previewStatus: status, previewPhase: 'running' });
          if (status.engine === 'godot') void get().focusPreview();
          return;
        }
        // The process exited while the store still said running: restart the same tree.
        const request = get().lastPreviewRequest;
        set({ previewStatus: status, previewPhase: 'idle', previewError: null });
        void get().startPreview(request?.mode ?? 'main', request?.worktreePath ?? undefined);
      })();
      return;
    }
    void state.startPreview('main');
  },

  stopPreview: async () => {
    previewStartGeneration += 1;
    try {
      await ipc.previewStop();
    } catch {
      // The process may already be gone; the UI still has to leave the running state.
    }
    set({
      previewStatus: null,
      previewPhase: 'idle',
      previewError: null,
      previewLightboxOpen: false,
    });
  },

  capturePreviewFrame: async () => {
    let res: PreviewCaptureResult;
    try {
      res = await ipc.previewCapture();
    } catch (err) {
      // Never reject: the buttons call this with `void`. The overlay shows previewError as a note.
      const error = err instanceof Error ? err.message : String(err);
      set({ previewError: error });
      return { error };
    }
    if (!res.image_path) {
      // Capture can fail without throwing (no compositor, no window) and the backend can leave
      // `error` null: it is still a failure, never a silent success.
      const error = res.error ?? translate(get().locale, 'preview.captureError');
      set({ previewError: error });
      return { error };
    }
    set({ previewError: null });
    get().addOneShotAttachment({
      type: 'staging_capture',
      image_path: res.image_path,
      user_note: res.log_tail.slice(-5).join('\n'),
    });
    return 'ok';
  },

  setPreviewLightboxOpen: (open) => set({ previewLightboxOpen: open }),

  refreshPiSetupStatus: async () => {
    try {
      const status = await ipc.piGetSetupStatus();
      const previous = get().piSetupStatus?.configured_providers ?? null;
      set({ piSetupStatus: status });
      // A provider connected outside configure (e.g. OAuth in the terminal + Verify) changes pi's catalog.
      if (previous !== null && !sameMembers(previous, status.configured_providers)) {
        void get().loadModelCatalog();
      }
      return status;
    } catch {
      return null;
    }
  },

  openProviderDialog: (provider) =>
    set({
      providerDialog: { open: true, preselect: provider ?? null, hiddenForSignIn: false },
    }),

  closeProviderDialog: () => {
    // Closing the visible dialog always drops the sign-in slice: `waiting` stops its poll, and a
    // finished phase (`timeout`/`invalid`/`error`) must not come back on the next open.
    stopSignInPoll();
    set({ providerSignIn: null, providerDialog: { ...CLOSED_PROVIDER_DIALOG } });
  },

  connectPiProvider: async (provider, apiKey) => {
    const result = await ipc.piConnectProvider({ provider, api_key: apiKey });
    set({ piSetupStatus: result.status });
    let defaultChangedTo: DefaultChange | null = null;
    // The backend keeps the key on `not_ready` and on `check_error`, so both are connected with a
    // warning; only `invalid` is rolled back and skips the default rule.
    const keyKept =
      result.check === null ||
      result.check_error !== null ||
      result.check.status === 'ready' ||
      result.check.status === 'not_ready';
    if (keyKept) {
      // pi lists only connected providers, so the catalog (and the initial default) depends on it.
      await get().loadModelCatalog();
      defaultChangedTo = await applyInitialDefaultIfNeeded(provider);
    }
    return { result, defaultChangedTo };
  },

  startProviderSignIn: (provider, options) => {
    const slug = provider.trim();
    // The slug is typed into a shell (`pi auth login <slug>`) and polled: never accept free text.
    if (!isValidSlug(slug)) return;
    get().launchPiInteractiveLogin(slug);
    set((state) => ({
      providerDialog: { ...state.providerDialog, hiddenForSignIn: true },
    }));
    if (options?.manualOnly === true) {
      beginManualSignIn(slug, options.refetchCatalogOnReady === true);
      return;
    }
    beginSignInPoll(slug, options?.refetchCatalogOnReady === true);
  },

  checkProviderSignInNow: () => {
    if (signInPoller) {
      signInPoller.checkNow();
      return;
    }
    const signIn = get().providerSignIn;
    if (signIn) void runSingleSignInCheck(signIn.provider);
  },

  cancelProviderSignIn: () => {
    stopSignInPoll();
    set({ providerSignIn: null });
  },

  revealProviderDialog: () =>
    set((state) => ({
      providerDialog: {
        open: true,
        preselect: state.providerSignIn?.provider ?? state.providerDialog.preselect,
        hiddenForSignIn: false,
      },
    })),

  hideProviderDialogForSignIn: () =>
    set((state) => ({
      providerDialog: { ...state.providerDialog, hiddenForSignIn: true },
      bottomCollapsed: false,
      zenMode: computeZenMode(state.leftCollapsed, state.rightCollapsed, false),
    })),

  disconnectPiProvider: async (provider) => {
    const wasDefault = get().piSetupStatus?.active_provider === provider;
    const status = await ipc.piLogoutProvider(provider);
    set({ piSetupStatus: status });
    const catalog = await get().loadModelCatalog();

    let defaultChangedTo: DefaultChange | null = null;
    if (wasDefault) {
      const fallback = pickFallbackDefault(provider, buildProviderRows(status), catalog);
      if (fallback) {
        const next = await ipc.piConfigureProvider({
          provider: fallback.provider,
          model: fallback.model,
          mark_completed: false,
        });
        set({ piSetupStatus: next });
        defaultChangedTo = { provider: fallback.provider, model: fallback.model };
      }
    }

    // A provider with an env hint can stay usable after logout; check only in that case (§4.5).
    let stillViaEnv = false;
    const row = buildProviderRows(status).find((candidate) => candidate.id === provider);
    if (row?.envVar) {
      try {
        const check = await ipc.piCheckProvider(provider);
        stillViaEnv = check.status === 'ready';
      } catch {
        stillViaEnv = false;
      }
    }

    return { defaultChangedTo, stillViaEnv };
  },

  saveDefaultModel: async (selection, markCompleted) => {
    const provider = selection?.provider ?? get().piSetupStatus?.active_provider ?? null;
    if (!provider) return;
    await get().configurePiProvider({
      provider,
      model: selection?.id ?? null,
      mark_completed: markCompleted,
    });
  },

  configurePiProvider: async (req) => {
    const status = await ipc.piConfigureProvider(req);
    set({ piSetupStatus: status });
    void get().loadModelCatalog();
    return status;
  },

  logoutPiProvider: async (provider) => {
    const status = await ipc.piLogoutProvider(provider);
    set({
      piSetupStatus: status,
    });
    void get().loadModelCatalog();
    return status;
  },

  loadModelCatalog: async () => {
    const request = ++modelCatalogRequest;
    set({ modelCatalogLoading: true, modelCatalogError: null });
    try {
      const catalog = await ipc.piListModels();
      if (request !== modelCatalogRequest) return null;
      set({ modelCatalog: catalog, modelCatalogLoading: false });
      return catalog;
    } catch (err) {
      if (request !== modelCatalogRequest) return null;
      set({
        modelCatalogLoading: false,
        modelCatalogError: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  },

  skipPiSetup: async () => {
    const status = await ipc.piConfigureProvider({
      provider: 'offline',
      mark_completed: true,
    });
    set({
      piSetupStatus: status,
      providerDialog: { ...CLOSED_PROVIDER_DIALOG },
    });
    return status;
  },

  launchPiInteractiveLogin: (provider) => {
    const clean = provider.trim();
    // This text is typed into the user's shell, so only a valid provider slug may pass.
    if (!isValidSlug(clean)) return;
    set((state) => ({
      bottomCollapsed: false,
      zenMode: computeZenMode(state.leftCollapsed, state.rightCollapsed, false),
      pendingTerminalCommand: `pi auth login ${clean}\r`,
    }));
  },

  consumePendingTerminalCommand: () => {
    const cmd = get().pendingTerminalCommand;
    if (cmd !== null) {
      set({ pendingTerminalCommand: null });
    }
    return cmd;
  },
  };
});
