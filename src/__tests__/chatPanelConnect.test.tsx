import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ipc, resetMockPiSetup, type PiSetupStatus } from '../types/ipc';
import { useWorkspaceStore } from '../store/workspaceStore';
import { ChatPanel } from '../panels/ChatPanel';
import { SettingsModal } from '../components/SettingsModal';
import { translate } from '../i18n';

function resetStore(): void {
  useWorkspaceStore.setState({
    locale: 'en',
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

async function seedStatus(patch: Partial<PiSetupStatus> = {}): Promise<PiSetupStatus> {
  const status = { ...(await ipc.piGetSetupStatus()), ...patch };
  useWorkspaceStore.setState({ piSetupStatus: status });
  return status;
}

function composer(): HTMLTextAreaElement {
  const input = document.querySelector<HTMLTextAreaElement>('.chat-input');
  if (!input) throw new Error('composer not rendered');
  return input;
}

describe('ChatPanel provider dialog wiring (S3-2)', () => {
  beforeEach(() => {
    resetMockPiSetup();
    resetStore();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('sending while not connected opens the dialog, keeps the draft and posts no message', async () => {
    await seedStatus({ needs_setup: true, first_run_completed: false });

    const { container } = render(<ChatPanel />);
    const input = composer();

    fireEvent.change(input, { target: { value: 'hello' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    const state = useWorkspaceStore.getState();
    expect(state.providerDialog.open).toBe(true);
    expect(composer().value).toBe('hello');
    expect(state.chatMessages).toHaveLength(0);
    expect(container.querySelector('.chat-msg')).toBeNull();
  });

  it('shows the not-connected call to action in the transcript area', async () => {
    await seedStatus({ needs_setup: true, first_run_completed: false });

    const { container } = render(<ChatPanel />);

    const cta = container.querySelector('.chat-connect-cta');
    expect(cta).not.toBeNull();
    expect(cta?.textContent).toContain(translate('en', 'chat.connectCta.title'));
    expect(container.querySelector('.chat-empty')).toBeNull();

    fireEvent.click(
      screen.getByRole('button', { name: translate('en', 'chat.connectCta.button') })
    );
    expect(useWorkspaceStore.getState().providerDialog.open).toBe(true);
  });

  it('offers "Use offline for now" only on the first run', async () => {
    await seedStatus({ needs_setup: true, first_run_completed: false });
    const first = render(<ChatPanel />);
    expect(
      screen.getByRole('button', { name: translate('en', 'providerDialog.useOffline') })
    ).toBeTruthy();
    first.unmount();

    await seedStatus({ needs_setup: true, first_run_completed: true, provider_ready: false });
    const { container } = render(<ChatPanel />);
    expect(
      screen.queryByRole('button', { name: translate('en', 'providerDialog.useOffline') })
    ).toBeNull();
    // The CTA itself stays after the first run.
    expect(container.querySelector('.chat-connect-cta')).not.toBeNull();
  });

  it('clicking the pill always opens the dialog and never toggles it closed', async () => {
    await seedStatus({
      needs_setup: false,
      first_run_completed: true,
      provider_ready: true,
      active_provider: 'opencode-go',
      active_model: 'deepseek-v4.1-flash',
      configured_providers: ['opencode-go'],
    });

    const { container } = render(<ChatPanel />);
    const pill = container.querySelector<HTMLButtonElement>('.pi-provider-pill');
    expect(pill).not.toBeNull();

    fireEvent.click(pill as HTMLButtonElement);
    expect(useWorkspaceStore.getState().providerDialog.open).toBe(true);

    fireEvent.click(pill as HTMLButtonElement);
    expect(useWorkspaceStore.getState().providerDialog.open).toBe(true);
  });

  it('shows the sign-in waiting pill while hidden and reveals the dialog on click', async () => {
    await seedStatus({ needs_setup: true, first_run_completed: false });
    useWorkspaceStore.setState({
      providerDialog: { open: false, preselect: null, hiddenForSignIn: true },
      providerSignIn: {
        provider: 'openai-codex',
        phase: 'waiting',
        startedAt: Date.now(),
        detail: null,
      },
    });

    const { container } = render(<ChatPanel />);
    const pill = container.querySelector<HTMLButtonElement>('.pi-provider-pill');
    expect(pill?.textContent).toContain(translate('en', 'piSetup.pillWaiting'));

    fireEvent.click(pill as HTMLButtonElement);
    const state = useWorkspaceStore.getState();
    expect(state.providerDialog.open).toBe(true);
    expect(state.providerDialog.hiddenForSignIn).toBe(false);
    expect(state.providerDialog.preselect).toBe('openai-codex');
  });
});

describe('Settings provider action (S3 wiring)', () => {
  beforeEach(() => {
    resetMockPiSetup();
    resetStore();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('closes Settings and opens the provider dialog without touching the right dock', async () => {
    const onClose = vi.fn();
    render(<SettingsModal open onClose={onClose} />);

    useWorkspaceStore.setState({ rightCollapsed: true });
    fireEvent.click(
      screen.getByRole('button', { name: translate('en', 'piSetup.settingsConfigureBtn') })
    );

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(useWorkspaceStore.getState().providerDialog.open).toBe(true);
    expect(useWorkspaceStore.getState().rightCollapsed).toBe(true);
  });
});
