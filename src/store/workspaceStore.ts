import { create } from 'zustand';
import {
  getInitialLocale,
  LOCALE_STORAGE_KEY,
  translate,
  type Locale,
} from '../i18n';
import {
  ipc,
  type AmbientEnvelope,
  type FileTreeNode,
  type LensInfo,
  type LoopRunState,
  type OneShotAttachment,
  type PiEventPayload,
  type PiToolCall,
  type PreviewStatus,
  type RecentWorkspace,
  type WorkspaceInfo,
} from '../types/ipc';

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

  // UI Language
  locale: Locale;
  setLocale: (locale: Locale) => void;

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

  startPreview: (mode: 'main' | 'staging', worktreePath?: string) => Promise<void>;
  stopPreview: () => Promise<void>;
  capturePreviewFrame: () => Promise<void>;
  setPreviewLightboxOpen: (open: boolean) => void;
}

function computeZenMode(left: boolean, right: boolean, bottom: boolean): boolean {
  return left && right && bottom;
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
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

  locale: getInitialLocale(),
  setLocale: (locale) => {
    try {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    } catch {
      // ignore storage errors
    }
    set({ locale });
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
    });

    const [tree, lenses, runs] = await Promise.all([
      ipc.getWorkspaceTree().catch(() => []),
      ipc.listLenses().catch(() => []),
      ipc.listLoopRuns().catch(() => []),
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
    });
  },

  closeWorkspace: () => {
    set({
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
    const status = await ipc.previewStart(mode, worktreePath);
    set({
      previewStatus: status,
      previewLightboxOpen: status.engine === 'web' && status.running,
    });
  },

  stopPreview: async () => {
    await ipc.previewStop();
    set({ previewStatus: null, previewLightboxOpen: false });
  },

  capturePreviewFrame: async () => {
    const res = await ipc.previewCapture();
    get().addOneShotAttachment({
      type: 'staging_capture',
      image_path: res.image_path,
      user_note: res.log_tail.slice(-5).join('\n'),
    });
  },

  setPreviewLightboxOpen: (open) => set({ previewLightboxOpen: open }),
}));
