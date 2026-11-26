import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkspaceStore } from '../store/workspaceStore';
import { ipc, mockPreviewStatus, type PreviewStatus } from '../types/ipc';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function runningWeb(): PreviewStatus {
  return mockPreviewStatus({
    running: true,
    mode: 'main',
    engine: 'web',
    url: 'http://127.0.0.1:5173/',
    pid: 4242,
  });
}

function resetPreviewState(): void {
  useWorkspaceStore.setState({
    locale: 'en',
    activeModalCount: 0,
    previewStatus: null,
    previewLightboxOpen: false,
    previewPhase: 'idle',
    previewError: null,
    lastPreviewRequest: null,
  });
}

describe('preview store phases', () => {
  beforeEach(() => {
    resetPreviewState();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('startPreview opens the overlay as starting, then turns running', async () => {
    const pending = deferred<PreviewStatus>();
    const spy = vi.spyOn(ipc, 'previewStart').mockReturnValueOnce(pending.promise);

    const promise = useWorkspaceStore.getState().startPreview('main');

    // Both happen synchronously, before the backend answers.
    expect(useWorkspaceStore.getState().previewPhase).toBe('starting');
    expect(useWorkspaceStore.getState().previewLightboxOpen).toBe(true);
    expect(spy.mock.calls[0][0]).toBe('main');

    const status = runningWeb();
    pending.resolve(status);
    await expect(promise).resolves.toBe('ok');

    expect(useWorkspaceStore.getState().previewPhase).toBe('running');
    expect(useWorkspaceStore.getState().previewStatus).toEqual(status);
  });

  it('startPreview keeps the starting phase while the backend has a pid but is not ready', async () => {
    vi.spyOn(ipc, 'previewStart').mockResolvedValueOnce(
      mockPreviewStatus({ running: false, mode: 'main', engine: 'web', pid: 5151 })
    );

    await useWorkspaceStore.getState().startPreview('main');

    const state = useWorkspaceStore.getState();
    expect(state.previewPhase).toBe('starting');
    expect(state.previewStatus?.pid).toBe(5151);
    expect(state.previewLightboxOpen).toBe(true);
  });

  it('startPreview turns a rejection into the error phase and never rejects', async () => {
    vi.spyOn(ipc, 'previewStart').mockRejectedValueOnce(new Error('healthcheck timed out'));
    const logs = ['[preview] boot', '[preview] healthcheck timed out'];
    const statusSpy = vi
      .spyOn(ipc, 'previewStatus')
      .mockResolvedValueOnce(mockPreviewStatus({ logs }));

    await expect(useWorkspaceStore.getState().startPreview('main')).resolves.toEqual({
      error: 'healthcheck timed out',
    });

    const state = useWorkspaceStore.getState();
    expect(state.previewPhase).toBe('error');
    expect(state.previewError).toBe('healthcheck timed out');
    expect(state.previewStatus?.logs).toEqual(logs);
    expect(state.previewLightboxOpen).toBe(true);
    expect(statusSpy).toHaveBeenCalledTimes(1);
  });

  it('handlePreviewHotkey starts main once and ignores repeats while starting', async () => {
    const pending = deferred<PreviewStatus>();
    const start = vi.spyOn(ipc, 'previewStart').mockReturnValue(pending.promise);

    useWorkspaceStore.getState().handlePreviewHotkey();
    useWorkspaceStore.getState().handlePreviewHotkey();

    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0][0]).toBe('main');

    pending.resolve(runningWeb());
    await pending.promise;
    await Promise.resolve();
  });

  it('handlePreviewHotkey reopens a running web preview without starting again', async () => {
    const status = runningWeb();
    useWorkspaceStore.setState({
      previewPhase: 'running',
      previewStatus: status,
      previewLightboxOpen: false,
    });
    const start = vi.spyOn(ipc, 'previewStart');
    const focus = vi.spyOn(ipc, 'previewFocus');
    const statusSpy = vi.spyOn(ipc, 'previewStatus').mockResolvedValueOnce(status);

    useWorkspaceStore.getState().handlePreviewHotkey();

    expect(useWorkspaceStore.getState().previewLightboxOpen).toBe(true);
    await vi.waitFor(() => expect(statusSpy).toHaveBeenCalledTimes(1));
    expect(start).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
  });

  it('handlePreviewHotkey focuses a running godot preview and never starts it', async () => {
    const godot = mockPreviewStatus({
      running: true,
      mode: 'main',
      engine: 'godot',
      pid: 777,
    });
    useWorkspaceStore.setState({
      previewPhase: 'running',
      previewStatus: godot,
    });
    const start = vi.spyOn(ipc, 'previewStart');
    const focus = vi.spyOn(ipc, 'previewFocus').mockResolvedValueOnce(undefined);
    vi.spyOn(ipc, 'previewStatus').mockResolvedValueOnce(godot);

    useWorkspaceStore.getState().handlePreviewHotkey();

    await vi.waitFor(() => expect(focus).toHaveBeenCalledTimes(1));
    expect(start).not.toHaveBeenCalled();
  });

  it('handlePreviewHotkey starts again when the refreshed status shows the process exited', async () => {
    useWorkspaceStore.setState({
      previewPhase: 'running',
      previewStatus: runningWeb(),
      previewLightboxOpen: false,
    });
    vi.spyOn(ipc, 'previewStatus').mockResolvedValueOnce(mockPreviewStatus({}));
    const start = vi.spyOn(ipc, 'previewStart').mockResolvedValueOnce(runningWeb());

    useWorkspaceStore.getState().handlePreviewHotkey();

    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    expect(start.mock.calls[0][0]).toBe('main');
    await vi.waitFor(() =>
      expect(useWorkspaceStore.getState().previewPhase).toBe('running')
    );
  });

  it('handlePreviewHotkey restarts the last staging request after the process exited', async () => {
    useWorkspaceStore.setState({
      previewPhase: 'running',
      previewStatus: mockPreviewStatus({
        running: true,
        mode: 'staging',
        engine: 'web',
        worktree_path: '/tmp/wt',
      }),
      lastPreviewRequest: { mode: 'staging', worktreePath: '/tmp/wt' },
      previewLightboxOpen: false,
    });
    vi.spyOn(ipc, 'previewStatus').mockResolvedValueOnce(mockPreviewStatus({}));
    const start = vi.spyOn(ipc, 'previewStart').mockResolvedValueOnce(
      mockPreviewStatus({
        running: true,
        mode: 'staging',
        engine: 'web',
        worktree_path: '/tmp/wt',
      })
    );

    useWorkspaceStore.getState().handlePreviewHotkey();

    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    expect(start.mock.calls[0]).toEqual(['staging', '/tmp/wt']);
  });

  it('handlePreviewHotkey treats a previewStatus IPC error as unknown and never starts', async () => {
    useWorkspaceStore.setState({
      previewPhase: 'running',
      previewStatus: runningWeb(),
      previewLightboxOpen: false,
    });
    const statusSpy = vi.spyOn(ipc, 'previewStatus').mockRejectedValueOnce(new Error('ipc down'));
    const start = vi.spyOn(ipc, 'previewStart');

    useWorkspaceStore.getState().handlePreviewHotkey();

    expect(useWorkspaceStore.getState().previewLightboxOpen).toBe(true);
    await vi.waitFor(() => expect(statusSpy).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(start).not.toHaveBeenCalled();
    expect(useWorkspaceStore.getState().previewPhase).toBe('running');
  });

  it('handlePreviewHotkey keeps focusing a running godot preview when the status IPC fails', async () => {
    const godot = mockPreviewStatus({
      running: true,
      mode: 'main',
      engine: 'godot',
      pid: 777,
    });
    useWorkspaceStore.setState({
      previewPhase: 'running',
      previewStatus: godot,
      previewLightboxOpen: false,
    });
    vi.spyOn(ipc, 'previewStatus').mockRejectedValueOnce(new Error('ipc down'));
    const focus = vi.spyOn(ipc, 'previewFocus').mockResolvedValueOnce(undefined);
    const start = vi.spyOn(ipc, 'previewStart');

    useWorkspaceStore.getState().handlePreviewHotkey();

    await vi.waitFor(() => expect(focus).toHaveBeenCalledTimes(1));
    expect(start).not.toHaveBeenCalled();
    expect(useWorkspaceStore.getState().previewPhase).toBe('running');
  });

  it('refreshPreviewStatus promotes a starting preview to running', async () => {
    useWorkspaceStore.setState({ previewPhase: 'starting' });
    const status = runningWeb();
    const spy = vi.spyOn(ipc, 'previewStatus').mockResolvedValueOnce(status);

    await useWorkspaceStore.getState().refreshPreviewStatus();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(useWorkspaceStore.getState().previewPhase).toBe('running');
    expect(useWorkspaceStore.getState().previewStatus).toEqual(status);
  });

  it('refreshPreviewStatus keeps waiting when the preview is not ready yet', async () => {
    useWorkspaceStore.setState({ previewPhase: 'starting' });
    vi.spyOn(ipc, 'previewStatus').mockResolvedValueOnce(
      mockPreviewStatus({ running: false, mode: 'main', engine: 'web', pid: 8080 })
    );

    await useWorkspaceStore.getState().refreshPreviewStatus();

    expect(useWorkspaceStore.getState().previewPhase).toBe('starting');
  });

  it('cancelPreviewStart stops the backend, resets the phase and ignores a late start result', async () => {
    const pending = deferred<PreviewStatus>();
    vi.spyOn(ipc, 'previewStart').mockReturnValueOnce(pending.promise);
    const stop = vi.spyOn(ipc, 'previewStop').mockResolvedValue(undefined);

    const starting = useWorkspaceStore.getState().startPreview('main');
    await useWorkspaceStore.getState().cancelPreviewStart();

    expect(stop).toHaveBeenCalledTimes(1);
    expect(useWorkspaceStore.getState().previewPhase).toBe('idle');
    expect(useWorkspaceStore.getState().previewLightboxOpen).toBe(false);

    pending.resolve(runningWeb());
    await expect(starting).resolves.toBe('cancelled');

    const state = useWorkspaceStore.getState();
    expect(state.previewPhase).toBe('idle');
    expect(state.previewLightboxOpen).toBe(false);
    expect(state.previewStatus).toBeNull();
  });

  it('cancelPreviewStart also ignores a late start rejection', async () => {
    const pending = deferred<PreviewStatus>();
    vi.spyOn(ipc, 'previewStart').mockReturnValueOnce(pending.promise);
    vi.spyOn(ipc, 'previewStop').mockResolvedValue(undefined);

    const starting = useWorkspaceStore.getState().startPreview('main');
    await useWorkspaceStore.getState().cancelPreviewStart();

    pending.reject(new Error('cancelled while starting'));
    await expect(starting).resolves.toBe('cancelled');

    expect(useWorkspaceStore.getState().previewPhase).toBe('idle');
    expect(useWorkspaceStore.getState().previewError).toBeNull();
  });

  it('handlePreviewHotkey reopens the starting overlay after Esc without starting again', () => {
    useWorkspaceStore.setState({ previewPhase: 'starting', previewLightboxOpen: false });
    const start = vi.spyOn(ipc, 'previewStart');

    useWorkspaceStore.getState().handlePreviewHotkey();

    expect(useWorkspaceStore.getState().previewLightboxOpen).toBe(true);
    expect(start).not.toHaveBeenCalled();
  });

  it('capturePreviewFrame never rejects and surfaces the failure', async () => {
    useWorkspaceStore.setState({ previewPhase: 'running', previewStatus: runningWeb() });
    vi.spyOn(ipc, 'previewCapture').mockRejectedValue(new Error('no window'));

    await expect(useWorkspaceStore.getState().capturePreviewFrame()).resolves.toEqual({
      error: 'no window',
    });
    expect(useWorkspaceStore.getState().previewError).toContain('no window');
    expect(useWorkspaceStore.getState().previewPhase).toBe('running');
  });

  it('capturePreviewFrame surfaces a backend capture error', async () => {
    useWorkspaceStore.setState({ previewPhase: 'running', previewStatus: runningWeb() });
    vi.spyOn(ipc, 'previewCapture').mockResolvedValue({
      image_path: null,
      log_tail: [],
      error: 'grim not found',
    });

    await expect(useWorkspaceStore.getState().capturePreviewFrame()).resolves.toEqual({
      error: 'grim not found',
    });
    expect(useWorkspaceStore.getState().previewError).toBe('grim not found');
  });

  it('capturePreviewFrame reports a failure when there is no image and no backend error', async () => {
    useWorkspaceStore.setState({ previewPhase: 'running', previewStatus: runningWeb() });
    vi.spyOn(ipc, 'previewCapture').mockResolvedValue({
      image_path: null,
      log_tail: [],
      error: null,
    });

    await expect(useWorkspaceStore.getState().capturePreviewFrame()).resolves.toEqual({
      error: 'Frame capture failed',
    });
    expect(useWorkspaceStore.getState().previewError).toBe('Frame capture failed');
    expect(useWorkspaceStore.getState().oneShotAttachments).toHaveLength(0);
  });

  it('stopPreview resets the phase to idle', async () => {
    useWorkspaceStore.setState({
      previewPhase: 'running',
      previewStatus: runningWeb(),
      previewLightboxOpen: true,
    });
    vi.spyOn(ipc, 'previewStop').mockResolvedValue(undefined);

    await useWorkspaceStore.getState().stopPreview();

    const state = useWorkspaceStore.getState();
    expect(state.previewPhase).toBe('idle');
    expect(state.previewStatus).toBeNull();
    expect(state.previewLightboxOpen).toBe(false);
  });

  it('retryPreview reuses the failed staging request instead of starting main', async () => {
    const start = vi
      .spyOn(ipc, 'previewStart')
      .mockRejectedValueOnce(new Error('godot crashed'))
      .mockResolvedValueOnce(
        mockPreviewStatus({ running: true, mode: 'staging', engine: 'godot', pid: 88 })
      );
    vi.spyOn(ipc, 'previewStatus').mockResolvedValueOnce(mockPreviewStatus({ logs: [] }));

    await useWorkspaceStore.getState().startPreview('staging', '/tmp/wt');
    expect(useWorkspaceStore.getState().lastPreviewRequest).toEqual({
      mode: 'staging',
      worktreePath: '/tmp/wt',
    });

    useWorkspaceStore.getState().retryPreview();

    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(2));
    expect(start.mock.calls[1]).toEqual(['staging', '/tmp/wt']);
  });
});
