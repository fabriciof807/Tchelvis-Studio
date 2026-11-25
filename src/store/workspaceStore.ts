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
  type PiEventPayload,
  type PiSetupStatus,
  type PiToolCall,
  type PreviewStatus,
  type RecentWorkspace,
  type UpdateChannel,
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

  piSetupStatus: PiSetupStatus | null;
  piSetupOpen: boolean;
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

  startPreview: (mode: 'main' | 'staging', worktreePath?: string) => Promise<void>;
  stopPreview: () => Promise<void>;
  capturePreviewFrame: () => Promise<void>;
  setPreviewLightboxOpen: (open: boolean) => void;

  refreshPiSetupStatus: () => Promise<PiSetupStatus | null>;
  setPiSetupOpen: (open: boolean) => void;
  configurePiProvider: (req: PiConfigureProviderRequest) => Promise<PiSetupStatus>;
  logoutPiProvider: (provider: string) => Promise<PiSetupStatus>;
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

  piSetupStatus: null,
  piSetupOpen: false,
  pendingTerminalCommand: null,

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
      piSetupOpen: piSetup?.needs_setup === true,
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
        piSetupOpen:
          !rightCollapsed && state.piSetupStatus?.needs_setup ? true : state.piSetupOpen,
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
      const hint = translate(get().locale, 'piSetup.chatBlockedHint');
      set((s) => ({
        isSendingChat: false,
        piSetupOpen: true,
        chatMessages: [
          ...s.chatMessages,
          {
            id: `sys-pi-setup-${Date.now()}`,
            role: 'system',
            text: hint,
            timestamp: new Date().toISOString(),
          },
        ],
      }));
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

  refreshPiSetupStatus: async () => {
    try {
      const status = await ipc.piGetSetupStatus();
      set((s) => ({
        piSetupStatus: status,
        piSetupOpen: status.needs_setup ? s.piSetupOpen : false,
      }));
      return status;
    } catch {
      return null;
    }
  },

  setPiSetupOpen: (open) => set({ piSetupOpen: open }),

  configurePiProvider: async (req) => {
    const status = await ipc.piConfigureProvider(req);
    set({
      piSetupStatus: status,
      piSetupOpen: status.needs_setup,
    });
    return status;
  },

  logoutPiProvider: async (provider) => {
    const status = await ipc.piLogoutProvider(provider);
    set({
      piSetupStatus: status,
    });
    return status;
  },

  skipPiSetup: async () => {
    const status = await ipc.piConfigureProvider({
      provider: 'offline',
      mark_completed: true,
    });
    set({
      piSetupStatus: status,
      piSetupOpen: false,
    });
    return status;
  },

  launchPiInteractiveLogin: (provider) => {
    const clean = provider.trim();
    if (!clean) return;
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
}));
