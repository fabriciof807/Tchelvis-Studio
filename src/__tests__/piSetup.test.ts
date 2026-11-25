import { beforeEach, describe, expect, it } from 'vitest';
import { resetMockPiSetup } from '../types/ipc';
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
      piSetupOpen: false,
      pendingTerminalCommand: null,
      bottomCollapsed: true,
      rightCollapsed: false,
      isSendingChat: false,
    });
  });

  it('opens Pi setup wizard on first-run openWorkspace and blocks normal chat until configured', async () => {
    await useWorkspaceStore.getState().openWorkspace('/tmp/mock-game');

    const afterOpen = useWorkspaceStore.getState();
    expect(afterOpen.piSetupStatus?.first_run_completed).toBe(false);
    expect(afterOpen.piSetupStatus?.needs_setup).toBe(true);
    expect(afterOpen.piSetupOpen).toBe(true);

    await useWorkspaceStore.getState().sendChatMessage('Olá Pi');
    const afterBlockedChat = useWorkspaceStore.getState();
    expect(afterBlockedChat.isSendingChat).toBe(false);
    expect(afterBlockedChat.piSetupOpen).toBe(true);
    expect(
      afterBlockedChat.chatMessages.some((m) => m.role === 'system')
    ).toBe(true);
    expect(
      afterBlockedChat.chatMessages.some((m) => m.role === 'assistant')
    ).toBe(false);
  });

  it('configurePiProvider enables chat and clears needs_setup & piSetupOpen', async () => {
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
    expect(st.piSetupOpen).toBe(false);

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
    expect(useWorkspaceStore.getState().piSetupOpen).toBe(false);
  });
});
