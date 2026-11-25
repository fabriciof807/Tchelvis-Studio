import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ipc, resetMockPiSetup } from '../types/ipc';
import { useWorkspaceStore } from '../store/workspaceStore';
import { PiSetupWizard } from '../components/PiSetupWizard';

describe('PiSetupWizard default model field', () => {
  beforeEach(async () => {
    resetMockPiSetup();
    useWorkspaceStore.setState({
      locale: 'en',
      piSetupStatus: await ipc.piGetSetupStatus(),
      modelCatalog: null,
      modelCatalogLoading: false,
      modelCatalogError: null,
    });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('replaces the datalist with the model picker and saves the chosen model', async () => {
    const configure = vi.spyOn(ipc, 'piConfigureProvider');
    const { container } = render(<PiSetupWizard />);
    expect(container.querySelector('datalist')).toBeNull();
    await waitFor(() => expect(useWorkspaceStore.getState().modelCatalog).not.toBeNull());

    fireEvent.click(screen.getByRole('button', { name: /Default model/i }));
    fireEvent.click(screen.getByRole('option', { name: /hy4-flash-free/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save & Connect Chat' }));

    await waitFor(() =>
      expect(configure).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'opencode-go', model: 'hy4-flash-free' })
      )
    );
  });

  it("picking another connected provider's model selects that provider", async () => {
    const status = useWorkspaceStore.getState().piSetupStatus!;
    useWorkspaceStore.setState({ piSetupStatus: { ...status, configured_providers: ['opencode-go', 'openrouter'] } });
    render(<PiSetupWizard />);
    await waitFor(() => expect(useWorkspaceStore.getState().modelCatalog).not.toBeNull());

    fireEvent.click(screen.getByRole('button', { name: /Default model/i }));
    fireEvent.click(screen.getByRole('option', { name: /deepseek\/deepseek-chat/ }));

    expect((screen.getByLabelText('Provider') as HTMLSelectElement).value).toBe('openrouter');
    expect(screen.getByRole('button', { name: /Default model/i }).textContent).toContain('deepseek/deepseek-chat');
  });

  it('Connect ▸ on another provider selects it in the wizard', async () => {
    render(<PiSetupWizard />);
    await waitFor(() => expect(useWorkspaceStore.getState().modelCatalog).not.toBeNull());

    fireEvent.click(screen.getByRole('button', { name: /Default model/i }));
    fireEvent.click(screen.getByRole('option', { name: /OpenRouter.*Connect/ }));

    expect((screen.getByLabelText('Provider') as HTMLSelectElement).value).toBe('openrouter');
  });
});
