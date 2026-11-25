import { describe, expect, it } from 'vitest';
import type { PiModelInfo } from '../types/ipc';
import {
  buildPickerView,
  formatContextWindow,
  formatPrice,
  fuzzyMatch,
  normalizeSearchText,
  type PickerProvider,
} from '../components/modelPicker/modelPickerLogic';

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

const MODELS: PiModelInfo[] = [
  model('opencode-go', 'deepseek-v4.1-flash', 'DeepSeek V4.1 Flash'),
  model('opencode-go', 'glm-5.3', 'GLM 5.3'),
  model('opencode-go', 'kimi-k3.1-pro', 'Kimi K3.1 Pro'),
  model('opencode-go', 'minimax-m3', 'MiniMax M3'),
  model('openrouter', 'moonshot/kimi-k3', 'Kimi K3'),
];

const PROVIDERS: PickerProvider[] = [
  { id: 'opencode-go', label: 'OpenCode Go', suggested_models: ['deepseek-v4.1-flash'] },
  { id: 'openrouter', label: 'OpenRouter', suggested_models: [] },
  { id: 'anthropic', label: 'Anthropic (Claude)', suggested_models: ['claude-haiku-5-5', 'claude-sonnet-5-5'] },
];

const CONNECTED = ['opencode-go', 'openrouter'];

function modelIds(view: ReturnType<typeof buildPickerView>): string[] {
  return view.sections.flatMap((s) =>
    s.rows.flatMap((r) => (r.kind === 'model' ? [`${r.model.provider}/${r.model.id}`] : []))
  );
}

describe('normalizeSearchText', () => {
  it('lowercases and strips diacritics', () => {
    expect(normalizeSearchText('Ação Rápida')).toBe('acao rapida');
  });
});

describe('fuzzyMatch', () => {
  it('matches substrings and returns highlighted indices', () => {
    expect(fuzzyMatch('kimi', 'Kimi K3.1 Pro')).toEqual([0, 1, 2, 3]);
  });

  it('matches subsequences case- and diacritic-insensitively', () => {
    expect(fuzzyMatch('dsf', 'DeepSeek Flash')).not.toBeNull();
    expect(fuzzyMatch('ACAO', 'ação')).toEqual([0, 1, 2, 3]);
  });

  it('returns null when the letters are not present in order', () => {
    expect(fuzzyMatch('kimi', 'MiniMax M3')).toBeNull();
  });
});

describe('buildPickerView', () => {
  it('groups every connected model by provider, sorted by label, with counts', () => {
    const view = buildPickerView({ models: MODELS, providers: PROVIDERS, connectedProviders: CONNECTED, query: '' });
    const providerSections = view.sections.filter((s) => s.kind === 'provider');
    expect(providerSections.map((s) => [s.label, s.count])).toEqual([
      ['OpenCode Go', 4],
      ['OpenRouter', 1],
    ]);
    expect(view.totalCount).toBe(5);
    expect(view.matchCount).toBe(5);
  });

  it('typing "kimi" keeps only models whose name, id or provider match', () => {
    const view = buildPickerView({ models: MODELS, providers: PROVIDERS, connectedProviders: CONNECTED, query: 'kimi' });
    expect(modelIds(view)).toEqual(['opencode-go/kimi-k3.1-pro', 'openrouter/moonshot/kimi-k3']);
    expect(view.matchCount).toBe(2);
    expect(view.totalCount).toBe(5);
    expect(view.sections.some((s) => s.kind === 'custom')).toBe(false);
  });

  it('matches on provider label as well', () => {
    const view = buildPickerView({ models: MODELS, providers: PROVIDERS, connectedProviders: CONNECTED, query: 'openrouter' });
    expect(modelIds(view)).toEqual(['openrouter/moonshot/kimi-k3']);
  });

  it('lists unconnected curated providers with a Connect row and disabled suggestions', () => {
    const view = buildPickerView({ models: MODELS, providers: PROVIDERS, connectedProviders: CONNECTED, query: '' });
    const notConnected = view.sections.find((s) => s.kind === 'notConnected');
    expect(notConnected).toBeDefined();
    const [connectRow, ...rest] = notConnected!.rows;
    expect(connectRow).toMatchObject({ kind: 'connect', providerId: 'anthropic', suggestedCount: 2 });
    expect(rest.map((r) => (r.kind === 'model' ? [r.model.id, r.disabled] : null))).toEqual([
      ['claude-haiku-5-5', true],
      ['claude-sonnet-5-5', true],
    ]);
  });

  it('keeps suggestions of the provider being configured selectable', () => {
    const view = buildPickerView({
      models: [],
      providers: PROVIDERS,
      connectedProviders: [],
      selectableProvider: 'anthropic',
      query: '',
    });
    const anthropic = view.sections.find((s) => s.kind === 'provider' && s.providerId === 'anthropic');
    expect(anthropic?.rows.every((r) => r.kind === 'model' && !r.disabled)).toBe(true);
    expect(view.sections.find((s) => s.kind === 'notConnected')?.rows.some(
      (r) => r.kind === 'connect' && r.providerId === 'anthropic'
    )).toBe(false);
  });

  it('offers a custom model id row when nothing selectable matches', () => {
    const view = buildPickerView({ models: MODELS, providers: PROVIDERS, connectedProviders: CONNECTED, query: 'my-local-model' });
    expect(view.matchCount).toBe(0);
    const custom = view.sections.find((s) => s.kind === 'custom');
    expect(custom?.rows).toEqual([{ kind: 'custom', key: 'custom', text: 'my-local-model' }]);
  });

  it('still offers a custom id when the query only loosely matches existing models', () => {
    // "kimi-k31" is a subsequence of "kimi-k3.1-pro" but not a real id in the catalog.
    const view = buildPickerView({ models: MODELS, providers: PROVIDERS, connectedProviders: CONNECTED, query: 'kimi-k31' });
    expect(view.sections.at(-1)?.rows).toEqual([{ kind: 'custom', key: 'custom', text: 'kimi-k31' }]);
  });

  it('does not offer a custom row for an empty query', () => {
    const view = buildPickerView({ models: [], providers: [], connectedProviders: [], query: '   ' });
    expect(view.sections).toEqual([]);
  });
});

describe('badge formatting', () => {
  it('formats context windows compactly per locale', () => {
    expect(formatContextWindow('en', 1_000_000)).toBe('1M');
    expect(formatContextWindow('en', 262_144)).toBe('262K');
    expect(formatContextWindow('en', 1_048_576)).toBe('1M');
    expect(formatContextWindow('en', 1_500_000)).toBe('1.5M');
    expect(formatContextWindow('en', null)).toBeNull();
  });

  it('formats prices and omits zero or unknown costs', () => {
    expect(formatPrice(0.1, 0.5)).toBe('$0.1/0.5');
    expect(formatPrice(0, 0)).toBeNull();
    expect(formatPrice(null, 2)).toBeNull();
  });
});
