import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkspaceStore } from '../store/workspaceStore';
import { ipc } from '../types/ipc';

describe('workspaceStore', () => {
  beforeEach(() => {
    useWorkspaceStore.setState({
      workspace: null,
      fileTree: [],
      openTabs: [],
      focusedPanel: 'md:gdd/01-visao-geral.md',
      dirtyFiles: [],
      oneShotAttachments: [],
      activeModalCount: 0,
      leftCollapsed: false,
      rightCollapsed: false,
      bottomCollapsed: false,
      zenMode: false,
      chatMessages: [],
      isSendingChat: false,
    });
  });

  it('consumes oneShotAttachments atomically when sending a chat message', async () => {
    const spy = vi.spyOn(ipc, 'piSendMessage').mockResolvedValueOnce({
      turn_id: 'turn-1',
      mode: 'offline_fallback',
      reply_text: 'Ok!',
      tool_calls: [],
    });

    const store = useWorkspaceStore.getState();
    store.markDirty('gdd/01-visao-geral.md', true);
    store.registerOpenTab('gdd/01-visao-geral.md');
    store.addOneShotAttachment({
      type: 'clipboard_image',
      image_path: '.hub/captures/cap-1.png',
      user_note: 'HUD barra de calor',
    });

    expect(useWorkspaceStore.getState().oneShotAttachments).toHaveLength(1);

    const sendPromise = useWorkspaceStore.getState().sendChatMessage('Conectar barra de calor');
    // Immediately cleared before async resolution
    expect(useWorkspaceStore.getState().oneShotAttachments).toHaveLength(0);

    await sendPromise;

    expect(spy).toHaveBeenCalledTimes(1);
    const envelope = spy.mock.calls[0][0];
    expect(envelope.active_context.dirty_files).toEqual(['gdd/01-visao-geral.md']);
    expect(envelope.one_shot_attachments).toHaveLength(1);
    expect(envelope.one_shot_attachments[0].image_path).toBe('.hub/captures/cap-1.png');

    spy.mockRestore();
  });

  it('activates zenMode when all drawers are collapsed', () => {
    const store = useWorkspaceStore.getState();
    store.toggleLeft();
    expect(useWorkspaceStore.getState().zenMode).toBe(false);
    store.toggleRight();
    expect(useWorkspaceStore.getState().zenMode).toBe(false);
    store.toggleBottom();
    expect(useWorkspaceStore.getState().zenMode).toBe(true);
  });

  it('tracks activeModalCount safely without going negative', () => {
    const store = useWorkspaceStore.getState();
    store.incrementModalCount();
    store.incrementModalCount();
    expect(useWorkspaceStore.getState().activeModalCount).toBe(2);
    store.decrementModalCount();
    store.decrementModalCount();
    store.decrementModalCount();
    expect(useWorkspaceStore.getState().activeModalCount).toBe(0);
  });
});
