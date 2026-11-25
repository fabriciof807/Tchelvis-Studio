import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { PiModelCatalog, PiModelInfo } from '../types/ipc';
import { useWorkspaceStore } from '../store/workspaceStore';
import { ModelPicker, type ModelPickerProps } from '../components/modelPicker/ModelPicker';
import type { PickerProvider } from '../components/modelPicker/modelPickerLogic';

function model(provider: string, id: string, name: string, extra: Partial<PiModelInfo> = {}): PiModelInfo {
  return {
    provider,
    id,
    name,
    reasoning: false,
    image_input: false,
    context_window: null,
    max_output: null,
    cost_in: null,
    cost_out: null,
    ...extra,
  };
}

const CATALOG: PiModelCatalog = {
  source: 'pi_rpc',
  fallback_reason: null,
  models: [
    model('opencode-go', 'deepseek-v4.1-flash', 'DeepSeek V4.1 Flash', {
      reasoning: true,
      image_input: true,
      context_window: 1_000_000,
      cost_in: 0.1,
      cost_out: 0.5,
    }),
    model('opencode-go', 'glm-5.3', 'GLM 5.3', { cost_in: 0, cost_out: 0 }),
    model('opencode-go', 'kimi-k3.1-pro', 'Kimi K3.1 Pro'),
    model('opencode-go', 'minimax-m3', 'MiniMax M3'),
    model('openrouter', 'moonshot/kimi-k3', 'Kimi K3'),
  ],
};

const PROVIDERS: PickerProvider[] = [
  { id: 'opencode-go', label: 'OpenCode Go', suggested_models: [] },
  { id: 'openrouter', label: 'OpenRouter', suggested_models: [] },
  { id: 'anthropic', label: 'Anthropic (Claude)', suggested_models: ['claude-haiku-5-5', 'claude-sonnet-5-5'] },
];

function renderPicker(overrides: Partial<ModelPickerProps> = {}) {
  const props: ModelPickerProps = {
    catalog: CATALOG,
    loading: false,
    providers: PROVIDERS,
    connectedProviders: [],
    value: { provider: 'opencode-go', id: 'deepseek-v4.1-flash' },
    onChange: vi.fn(),
    onRetry: vi.fn(),
    onConnectProvider: vi.fn(),
    ...overrides,
  };
  render(<ModelPicker {...props} />);
  return props;
}

function openPicker() {
  fireEvent.click(screen.getByRole('button', { name: /DeepSeek V4.1 Flash|Choose a model/ }));
  return screen.getByRole('combobox');
}

describe('ModelPicker (field mode)', () => {
  beforeEach(() => {
    useWorkspaceStore.setState({ locale: 'en' });
  });
  afterEach(() => cleanup());

  it('shows the current model on the trigger and lists every model grouped by provider with counts', () => {
    renderPicker();
    openPicker();
    const listbox = screen.getByRole('listbox');
    const groups = within(listbox).getAllByRole('group');
    expect(groups.map((g) => g.getAttribute('aria-label'))).toEqual([
      'OpenCode Go · 4 models',
      'OpenRouter · 1 model',
      'Not connected',
    ]);
    expect(within(groups[0]).getAllByRole('option')).toHaveLength(4);
    expect(screen.getByText('5 of 5')).toBeTruthy();
  });

  it('renders badges with text alternatives and omits free/unknown prices', () => {
    renderPicker();
    openPicker();
    const deepseek = screen.getByRole('option', { name: /DeepSeek V4.1 Flash/ });
    expect(deepseek.getAttribute('aria-selected')).toBe('true');
    expect(within(deepseek).getByRole('img', { name: 'reasoning' })).toBeTruthy();
    expect(within(deepseek).getByRole('img', { name: 'accepts images' })).toBeTruthy();
    expect(within(deepseek).getByText('1M')).toBeTruthy();
    expect(within(deepseek).getByText('$0.1/0.5')).toBeTruthy();
    const glm = screen.getByRole('option', { name: /GLM 5.3/ });
    expect(within(glm).queryByText(/\$/)).toBeNull();
  });

  it('filters by fuzzy search and selects with the keyboard', () => {
    const props = renderPicker();
    const search = openPicker();
    fireEvent.change(search, { target: { value: 'kimi' } });
    const options = screen.getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual([
      expect.stringContaining('Kimi K3.1 Pro'),
      expect.stringContaining('Kimi K3'),
    ]);
    expect(screen.getByText('2 of 5')).toBeTruthy();

    expect(search.getAttribute('aria-activedescendant')).toBe(options[0].id);
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    expect(search.getAttribute('aria-activedescendant')).toBe(options[1].id);
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(props.onChange).toHaveBeenCalledWith({ provider: 'openrouter', id: 'moonshot/kimi-k3' });
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('offers a custom model id when nothing matches', () => {
    const props = renderPicker();
    const search = openPicker();
    fireEvent.change(search, { target: { value: 'my-local-model' } });
    const custom = screen.getByRole('option', { name: 'Use "my-local-model" as a custom model id' });
    fireEvent.click(custom);
    expect(props.onChange).toHaveBeenCalledWith({ provider: null, id: 'my-local-model' });
  });

  it('shows unconnected providers disabled with a Connect action', () => {
    const props = renderPicker();
    openPicker();
    const haiku = screen.getByRole('option', { name: /claude-haiku-5-5/ });
    expect(haiku.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(haiku);
    expect(props.onChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('option', { name: /Anthropic \(Claude\).*2 suggested.*Connect/ }));
    expect(props.onConnectProvider).toHaveBeenCalledWith('anthropic');
  });

  it('warns when showing a fallback catalog and retries on request', () => {
    const props = renderPicker({
      catalog: { ...CATALOG, source: 'models_store', fallback_reason: 'timeout' },
      connectedProviders: ['opencode-go'],
    });
    expect(screen.getByText("Showing suggested models — couldn't read pi's catalog")).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(props.onRetry).toHaveBeenCalled();
  });

  it('offers Retry when the catalog could not be loaded at all', () => {
    const props = renderPicker({ catalog: null, error: 'invoke failed' });
    expect(screen.getByText("Showing suggested models — couldn't read pi's catalog")).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(props.onRetry).toHaveBeenCalled();
  });

  it('shows only the loading message during the first load', () => {
    renderPicker({ catalog: null, loading: true, value: null });
    openPicker();
    expect(screen.getByText('Loading models…')).toBeTruthy();
    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });

  it('keeps focus on the trigger when Tab closes the list', () => {
    renderPicker();
    const search = openPicker();
    fireEvent.keyDown(search, { key: 'Tab' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /DeepSeek V4.1 Flash/ }));
  });

  it('gives distinct option ids to ids that differ only in punctuation', () => {
    renderPicker({
      catalog: {
        source: 'pi_rpc',
        fallback_reason: null,
        models: [model('p', 'glm-5.3', 'A'), model('p', 'glm-5_3', 'B')],
      },
      value: null,
    });
    openPicker();
    const ids = screen.getAllByRole('option').map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('asks to connect a provider when nothing is connected', () => {
    renderPicker({
      catalog: { source: 'curated', fallback_reason: 'no models', models: [] },
      value: null,
    });
    expect(screen.getByText('Connect a provider to see all its models.')).toBeTruthy();
    expect(screen.queryByText(/couldn't read/)).toBeNull();
  });

  it('closes on Escape and returns focus to the trigger', () => {
    renderPicker();
    const search = openPicker();
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /DeepSeek V4.1 Flash/ }));
  });
});
