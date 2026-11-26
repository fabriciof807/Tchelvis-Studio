import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PreviewLightbox } from '../panels/PreviewLightbox';
import { useWorkspaceStore } from '../store/workspaceStore';
import { ipc, mockPreviewStatus } from '../types/ipc';

function resetPreviewState(): void {
  useWorkspaceStore.setState({
    locale: 'en',
    activeModalCount: 0,
    previewStatus: null,
    previewLightboxOpen: true,
    previewPhase: 'idle',
    previewError: null,
    lastPreviewRequest: null,
  });
}

describe('PreviewLightbox phases', () => {
  beforeEach(() => {
    resetPreviewState();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('shows the starting engine, the last log line and Cancel', () => {
    useWorkspaceStore.setState({
      previewPhase: 'starting',
      previewStatus: mockPreviewStatus({
        engine: 'godot',
        mode: 'main',
        pid: 321,
        logs: ['[godot] importing assets', '[godot] opening project'],
      }),
    });

    render(<PreviewLightbox />);

    expect(screen.getAllByText('Starting godot preview…').length).toBeGreaterThan(0);
    expect(document.querySelector('.preview-starting-label')?.textContent).toBe(
      'Starting godot preview…'
    );
    expect(screen.getByText('[godot] opening project')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
    expect(document.querySelector('.preview-spinner')).toBeTruthy();
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('falls back to a generic starting label when the engine is unknown', () => {
    useWorkspaceStore.setState({ previewPhase: 'starting', previewStatus: null });

    render(<PreviewLightbox />);

    expect(screen.getAllByText('Starting preview…').length).toBeGreaterThan(0);
    expect(document.querySelector('.preview-starting-label')?.textContent).toBe(
      'Starting preview…'
    );
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
  });

  it('renders the running web game in a sandboxed iframe', () => {
    useWorkspaceStore.setState({
      previewPhase: 'running',
      previewStatus: mockPreviewStatus({
        running: true,
        mode: 'main',
        engine: 'web',
        url: 'http://127.0.0.1:5173/',
        pid: 4242,
        can_capture: true,
      }),
    });

    render(<PreviewLightbox />);

    const iframe = document.querySelector('iframe');
    expect(iframe).toBeTruthy();
    expect(iframe?.getAttribute('src')).toBe('http://127.0.0.1:5173/');
    expect(iframe?.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin allow-pointer-lock');
    expect(iframe?.getAttribute('allow')).toBe('fullscreen; gamepad; autoplay');
    expect(screen.getByRole('button', { name: 'Capture Frame + Log' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Stop Preview' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
  });

  it('renders a compact, non-modal bar for a running godot preview', () => {
    useWorkspaceStore.setState({
      previewPhase: 'running',
      previewStatus: mockPreviewStatus({
        running: true,
        mode: 'main',
        engine: 'godot',
        pid: 4242,
        can_capture: true,
      }),
    });

    render(<PreviewLightbox />);

    expect(document.querySelector('.lightbox-backdrop')).toBeNull();
    expect(screen.getByText('godot · PID 4242')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Focus game' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Capture Frame + Log' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Stop Preview' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
    expect(useWorkspaceStore.getState().activeModalCount).toBe(0);
  });

  it('closes the godot bar with its close button without stopping the preview', () => {
    useWorkspaceStore.setState({
      previewPhase: 'running',
      previewStatus: mockPreviewStatus({
        running: true,
        mode: 'main',
        engine: 'godot',
        pid: 4242,
      }),
    });
    const stop = vi.spyOn(ipc, 'previewStop');

    render(<PreviewLightbox />);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(useWorkspaceStore.getState().previewLightboxOpen).toBe(false);
    expect(stop).not.toHaveBeenCalled();
  });

  it('keeps the godot bar when Escape is pressed outside it', () => {
    useWorkspaceStore.setState({
      previewPhase: 'running',
      previewStatus: mockPreviewStatus({
        running: true,
        mode: 'main',
        engine: 'godot',
        pid: 4242,
      }),
    });

    render(<PreviewLightbox />);
    fireEvent.keyDown(window, { key: 'Escape' });

    expect(useWorkspaceStore.getState().previewLightboxOpen).toBe(true);
  });

  it('shows the error message with at most the last 20 log lines and both actions', () => {
    // Retry starts again; the promise stays pending so the overlay doesn't resolve inside the act().
    const start = vi.spyOn(ipc, 'previewStart').mockReturnValue(new Promise(() => {}));
    const logs = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    useWorkspaceStore.setState({
      previewPhase: 'error',
      previewError: 'healthcheck timed out',
      previewStatus: mockPreviewStatus({ logs }),
    });

    render(<PreviewLightbox />);

    expect(screen.getByText('healthcheck timed out')).toBeTruthy();
    const lines = document.querySelectorAll('.preview-log-line');
    expect(lines).toHaveLength(20);
    expect(lines[0].textContent).toBe('line 11');
    expect(lines[19].textContent).toBe('line 30');
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(start.mock.calls[0][0]).toBe('main');
    expect(useWorkspaceStore.getState().previewPhase).toBe('starting');
  });

  it('closes the error state with Close without stopping the preview', () => {
    const stop = vi.spyOn(ipc, 'previewStop');
    useWorkspaceStore.setState({
      previewPhase: 'error',
      previewError: 'healthcheck timed out',
      previewStatus: mockPreviewStatus({ logs: ['line 1'] }),
    });

    render(<PreviewLightbox />);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(useWorkspaceStore.getState().previewLightboxOpen).toBe(false);
    expect(useWorkspaceStore.getState().previewPhase).toBe('error');
    expect(stop).not.toHaveBeenCalled();
  });

  it('closes on Escape without stopping the preview', () => {
    useWorkspaceStore.setState({
      previewPhase: 'running',
      previewStatus: mockPreviewStatus({
        running: true,
        mode: 'main',
        engine: 'godot',
        pid: 4242,
      }),
    });
    const stop = vi.spyOn(ipc, 'previewStop');

    render(<PreviewLightbox />);
    const bar = document.querySelector('.preview-godot-bar');
    expect(bar).toBeTruthy();
    fireEvent.keyDown(bar as HTMLElement, { key: 'Escape' });

    expect(useWorkspaceStore.getState().previewLightboxOpen).toBe(false);
    expect(stop).not.toHaveBeenCalled();
  });

  it('polls the preview status every 500 ms while starting and stops on unmount', async () => {
    vi.useFakeTimers();
    useWorkspaceStore.setState({
      previewPhase: 'starting',
      previewStatus: mockPreviewStatus({ engine: 'web', pid: 90 }),
    });
    const status = vi
      .spyOn(ipc, 'previewStatus')
      .mockResolvedValue(mockPreviewStatus({ engine: 'web', pid: 90 }));

    const { unmount } = render(<PreviewLightbox />);
    expect(status).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(status).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(status).toHaveBeenCalledTimes(2);

    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(status).toHaveBeenCalledTimes(2);
  });
});
