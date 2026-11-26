import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ipc, resetMockPiSetup } from '../types/ipc';
import { useWorkspaceStore } from '../store/workspaceStore';

describe('Pi Durable first-run provider setup', () => {
  beforeEach(() => {
    resetMockPiSetup();
    useWorkspaceStore.setState({
      workspace: null,
      openTabs: [],
      dirtyFiles: [],
      oneShotAttachments: [],
      chatMessages: [],
      piSetupStatus: null,
      providerDialog: { open: false, preselect: null, hiddenForSignIn: false },
      providerSignIn: null,
      modelCatalog: null,
      modelCatalogLoading: false,
      modelCatalogError: null,
      pendingTerminalCommand: null,
      bottomCollapsed: true,
      rightCollapsed: false,
      isSendingChat: false,
    });
  });

  it('never opens the provider dialog automatically on first run (S3-1)', async () => {
    await useWorkspaceStore.getState().openWorkspace('/tmp/mock-game');

    const afterOpen = useWorkspaceStore.getState();
    expect(afterOpen.piSetupStatus?.first_run_completed).toBe(false);
    expect(afterOpen.piSetupStatus?.needs_setup).toBe(true);
    expect(afterOpen.providerDialog.open).toBe(false);

    useWorkspaceStore.getState().toggleRight();
    expect(useWorkspaceStore.getState().providerDialog.open).toBe(false);

    await useWorkspaceStore.getState().refreshPiSetupStatus();
    expect(useWorkspaceStore.getState().providerDialog.open).toBe(false);

    await useWorkspaceStore.getState().configurePiProvider({
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-4.5',
      api_key: 'sk-test-mock-123',
      mark_completed: true,
    });
    expect(useWorkspaceStore.getState().providerDialog.open).toBe(false);
  });

  it('a blocked sendChatMessage opens the dialog without posting a system message', async () => {
    await useWorkspaceStore.getState().openWorkspace('/tmp/mock-game');

    await useWorkspaceStore.getState().sendChatMessage('Olá Pi');
    const afterBlockedChat = useWorkspaceStore.getState();
    expect(afterBlockedChat.isSendingChat).toBe(false);
    expect(afterBlockedChat.providerDialog.open).toBe(true);
    expect(
      afterBlockedChat.chatMessages.some((m) => m.role === 'system')
    ).toBe(false);
    expect(
      afterBlockedChat.chatMessages.some((m) => m.role === 'assistant')
    ).toBe(false);
  });

  it('configurePiProvider enables chat and clears needs_setup & closes the dialog', async () => {
    await useWorkspaceStore.getState().openWorkspace('/tmp/mock-game');

    const status = await useWorkspaceStore.getState().configurePiProvider({
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-4.5',
      api_key: 'sk-test-mock-123',
      mark_completed: true,
    });

    expect(status.provider_ready).toBe(true);
    expect(status.needs_setup).toBe(false);
    expect(status.active_provider).toBe('openrouter');
    expect(status.active_model).toBe('anthropic/claude-sonnet-4.5');

    const st = useWorkspaceStore.getState();
    expect(st.providerDialog.open).toBe(false);

    await useWorkspaceStore.getState().sendChatMessage('Criar GDD');
    const afterChat = useWorkspaceStore.getState();
    expect(afterChat.chatMessages.some((m) => m.role === 'assistant')).toBe(true);
  });

  it('launchPiInteractiveLogin opens bottom terminal and queues pi auth login command', () => {
    useWorkspaceStore.getState().launchPiInteractiveLogin('opencode-go');
    const st = useWorkspaceStore.getState();
    expect(st.bottomCollapsed).toBe(false);
    expect(st.pendingTerminalCommand).toBe('pi auth login opencode-go\r');

    const consumed = useWorkspaceStore.getState().consumePendingTerminalCommand();
    expect(consumed).toBe('pi auth login opencode-go\r');
    expect(useWorkspaceStore.getState().pendingTerminalCommand).toBeNull();
  });

  it('skipPiSetup marks first run completed in offline mode without nagging', async () => {
    await useWorkspaceStore.getState().openWorkspace('/tmp/mock-game');
    const status = await useWorkspaceStore.getState().skipPiSetup();
    expect(status.first_run_completed).toBe(true);
    expect(status.needs_setup).toBe(false);
    expect(status.provider_ready).toBe(false);
    expect(useWorkspaceStore.getState().providerDialog.open).toBe(false);
  });

  it('piListModels falls back to curated suggestions until a provider is connected, then lists its models', async () => {
    const before = await ipc.piListModels();
    expect(before.source).toBe('curated');
    expect(before.fallback_reason).not.toBeNull();
    expect(
      before.models.some((m) => m.provider === 'opencode-go' && m.id === 'deepseek-v4.1-flash')
    ).toBe(true);
    for (const m of before.models) {
      expect(Object.keys(m).sort()).toEqual(
        [
          'context_window',
          'cost_in',
          'cost_out',
          'id',
          'image_input',
          'max_output',
          'name',
          'provider',
          'reasoning',
        ]
      );
    }

    await ipc.piConfigureProvider({
      provider: 'openrouter',
      api_key: 'sk-test-mock-123',
      mark_completed: true,
    });
    const after = await ipc.piListModels();
    expect(after.source).toBe('pi_rpc');
    expect(after.fallback_reason).toBeNull();
    expect(after.models.length).toBeGreaterThan(0);
    expect(after.models.every((m) => m.provider === 'openrouter')).toBe(true);
  });
  it('loadModelCatalog stores the catalog and refetches it after connecting or disconnecting', async () => {
    await useWorkspaceStore.getState().loadModelCatalog();
    let st = useWorkspaceStore.getState();
    expect(st.modelCatalog?.source).toBe('curated');
    expect(st.modelCatalogLoading).toBe(false);

    await useWorkspaceStore.getState().configurePiProvider({
      provider: 'opencode-go',
      api_key: 'sk-test-mock-123',
      mark_completed: true,
    });
    await vi.waitFor(() => expect(useWorkspaceStore.getState().modelCatalog?.source).toBe('pi_rpc'));
    st = useWorkspaceStore.getState();
    expect(st.modelCatalog?.models.every((m) => m.provider === 'opencode-go')).toBe(true);

    await useWorkspaceStore.getState().logoutPiProvider('opencode-go');
    await vi.waitFor(() => expect(useWorkspaceStore.getState().modelCatalog?.source).toBe('curated'));
  });

  it('refetches the catalog when a status refresh reports a newly connected provider (OAuth verify)', async () => {
    await useWorkspaceStore.getState().refreshPiSetupStatus();
    await useWorkspaceStore.getState().loadModelCatalog();
    const spy = vi.spyOn(ipc, 'piListModels');

    await useWorkspaceStore.getState().refreshPiSetupStatus();
    expect(spy).not.toHaveBeenCalled();

    const status = await ipc.piGetSetupStatus();
    vi.spyOn(ipc, 'piGetSetupStatus').mockResolvedValueOnce({
      ...status,
      configured_providers: ['opencode-go'],
    });
    await useWorkspaceStore.getState().refreshPiSetupStatus();
    expect(spy).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });

  it('keeps the previous catalog visible while revalidating and reports failures', async () => {
    await useWorkspaceStore.getState().loadModelCatalog();
    const previous = useWorkspaceStore.getState().modelCatalog;

    const spy = vi.spyOn(ipc, 'piListModels').mockRejectedValueOnce(new Error('boom'));
    const pending = useWorkspaceStore.getState().loadModelCatalog();
    expect(useWorkspaceStore.getState().modelCatalogLoading).toBe(true);
    expect(useWorkspaceStore.getState().modelCatalog).toBe(previous);
    await pending;

    const st = useWorkspaceStore.getState();
    expect(st.modelCatalogLoading).toBe(false);
    expect(st.modelCatalog).toBe(previous);
    expect(st.modelCatalogError).toBe('boom');
    spy.mockRestore();
  });
});

/** In-memory Storage: under Node 26 + jsdom the global `localStorage` is undefined in tests. */
function createMemoryStorage(): Storage & { snapshot: () => Record<string, string> } {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => {
      data.delete(k);
    },
    setItem: (k, v) => {
      data.set(k, String(v));
    },
    snapshot: () => Object.fromEntries(data),
  };
}

describe('piConnectProvider mock', () => {
  let storage: ReturnType<typeof createMemoryStorage>;

  beforeEach(() => {
    storage = createMemoryStorage();
    vi.stubGlobal('localStorage', storage);
    resetMockPiSetup();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('marks the provider connected when the key is accepted', async () => {
    const result = await ipc.piConnectProvider({
      provider: 'openrouter',
      api_key: 'sk-test-ok',
    });

    expect(result.check?.status).toBe('ready');
    expect(result.check?.provider).toBe('openrouter');
    expect(result.check_error).toBeNull();
    expect(result.status.configured_providers).toContain('openrouter');
  });

  it('returns invalid and leaves the provider disconnected when the key is rejected', async () => {
    const result = await ipc.piConnectProvider({
      provider: 'openrouter',
      api_key: 'invalid-x',
    });

    expect(result.check?.status).toBe('invalid');
    expect(result.status.configured_providers).not.toContain('openrouter');
  });

  it('never persists the key in localStorage', async () => {
    await ipc.piConnectProvider({ provider: 'openrouter', api_key: 'sk-test-ok' });
    await ipc.piConnectProvider({ provider: 'openai', api_key: 'invalid-x' });

    const stored = JSON.stringify(storage.snapshot());
    expect(stored).toContain('configured_providers');
    expect(stored).not.toContain('sk-test-ok');
    expect(stored).not.toContain('invalid-x');
  });
});
