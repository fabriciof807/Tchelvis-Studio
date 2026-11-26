import { describe, expect, it } from 'vitest';
import type { PiModelCatalog, PiModelInfo, PiProviderCatalogEntry, PiSetupStatus } from '../types/ipc';
import {
  DANGER_PRIMARY_CLASS,
  PRIMARY_CLASS,
  SLUG_RE,
  buildProviderList,
  buildProviderRows,
  connectedProviderIds,
  derivePanelState,
  initialSelection,
  isValidSlug,
  pickFallbackDefault,
  pickInitialDefault,
  primaryFor,
  type PanelState,
  type PrimaryAction,
  type ProviderRow,
} from '../components/providerDialog/providerDialogLogic';

function entry(id: string, label: string, extra: Partial<PiProviderCatalogEntry> = {}): PiProviderCatalogEntry {
  return {
    id,
    label,
    supports_api_key: true,
    supports_oauth: false,
    configured: false,
    auth_type: null,
    env_var_hint: null,
    suggested_models: [],
    ...extra,
  };
}

const CURATED: PiProviderCatalogEntry[] = [
  entry('opencode-go', 'OpenCode Go', {
    supports_oauth: true,
    env_var_hint: 'OPENCODE_API_KEY',
    suggested_models: ['deepseek-v4.1-flash'],
  }),
  entry('openrouter', 'OpenRouter', {
    supports_oauth: true,
    env_var_hint: 'OPENROUTER_API_KEY',
    suggested_models: ['kimi-k3'],
  }),
  entry('openai', 'OpenAI', { env_var_hint: 'OPENAI_API_KEY', suggested_models: ['gpt-5'] }),
  entry('openai-codex', 'OpenAI Codex (ChatGPT OAuth)', {
    supports_api_key: false,
    supports_oauth: true,
    suggested_models: ['gpt-5-codex'],
  }),
  entry('google', 'Google Gemini', { supports_oauth: true, env_var_hint: 'GEMINI_API_KEY' }),
];

function status(extra: Partial<PiSetupStatus> = {}): PiSetupStatus {
  return {
    pi_available: true,
    pi_bin: 'pi',
    first_run_completed: true,
    needs_setup: false,
    active_provider: null,
    active_model: null,
    provider_ready: false,
    configured_providers: [],
    providers: CURATED.map((p) => ({ ...p })),
    available_models: [],
    ...extra,
  };
}

function model(provider: string, id: string): PiModelInfo {
  return {
    provider,
    id,
    name: id,
    reasoning: false,
    image_input: false,
    context_window: null,
    max_output: null,
    cost_in: null,
    cost_out: null,
  };
}

function catalog(...models: PiModelInfo[]): PiModelCatalog {
  return { source: 'pi_rpc', models, fallback_reason: null };
}

function row(id: string, label: string, extra: Partial<ProviderRow> = {}): ProviderRow {
  return {
    id,
    label,
    connected: false,
    kind: null,
    supportsKey: true,
    supportsSignIn: false,
    envVar: null,
    curated: true,
    suggestedModels: [],
    ...extra,
  };
}

function byId(rows: ProviderRow[]): Record<string, ProviderRow> {
  return Object.fromEntries(rows.map((r) => [r.id, r]));
}

describe('SLUG_RE / isValidSlug', () => {
  it('accepts lowercase slugs of 1 to 64 chars', () => {
    expect(isValidSlug('opencode-go')).toBe(true);
    expect(isValidSlug('a')).toBe(true);
    expect(isValidSlug('9x2')).toBe(true);
    expect(isValidSlug('a'.repeat(64))).toBe(true);
    expect(SLUG_RE.test('my-provider')).toBe(true);
  });

  it('rejects empty, long, upper-case and punctuated slugs', () => {
    expect(isValidSlug('')).toBe(false);
    expect(isValidSlug('a'.repeat(65))).toBe(false);
    expect(isValidSlug('Bad Slug')).toBe(false);
    expect(isValidSlug('OpenRouter')).toBe(false);
    expect(isValidSlug('my_provider')).toBe(false);
    expect(isValidSlug('ação')).toBe(false);
    expect(SLUG_RE.test('a/b')).toBe(false);
  });
});

describe('primary classes', () => {
  it('exposes one shared primary class and a distinct danger variant', () => {
    expect(PRIMARY_CLASS).toBe('btn-primary-xs');
    expect(DANGER_PRIMARY_CLASS).toBe('btn-danger-xs');
    expect(DANGER_PRIMARY_CLASS).not.toBe(PRIMARY_CLASS);
  });
});

describe('connectedProviderIds', () => {
  it('is configured providers plus the active provider when it is ready', () => {
    expect(
      connectedProviderIds(
        status({ configured_providers: ['opencode-go'], active_provider: 'google', provider_ready: true })
      )
    ).toEqual(['opencode-go', 'google']);
  });

  it('ignores the active provider when it is not ready and dedupes', () => {
    expect(
      connectedProviderIds(status({ configured_providers: ['opencode-go'], active_provider: 'google' }))
    ).toEqual(['opencode-go']);
    expect(
      connectedProviderIds(
        status({ configured_providers: ['opencode-go'], active_provider: 'opencode-go', provider_ready: true })
      )
    ).toEqual(['opencode-go']);
  });
});

describe('buildProviderRows', () => {
  const rows = buildProviderRows(
    status({
      configured_providers: ['zeta-slug', 'opencode-go', 'openrouter', 'deepseek', 'alpha-slug'],
      providers: [
        entry('opencode-go', 'OpenCode Go', {
          configured: true,
          auth_type: 'api_key',
          supports_oauth: true,
          env_var_hint: 'OPENCODE_API_KEY',
        }),
        entry('openrouter', 'OpenRouter', {
          configured: true,
          auth_type: 'oauth',
          supports_oauth: true,
          env_var_hint: 'OPENROUTER_API_KEY',
        }),
        entry('deepseek', 'DeepSeek', { configured: true }),
        entry('openai-codex', 'OpenAI Codex (ChatGPT OAuth)', {
          supports_api_key: false,
          supports_oauth: true,
        }),
        entry('google', 'Google Gemini', { supports_oauth: true, env_var_hint: 'GEMINI_API_KEY' }),
      ],
      active_provider: 'google',
      provider_ready: true,
    })
  );
  const map = byId(rows);

  it('marks configured providers with the connection kind from auth_type', () => {
    expect(map['opencode-go']).toMatchObject({ connected: true, kind: 'api_key', supportsKey: true, curated: true });
    expect(map['openrouter']).toMatchObject({ connected: true, kind: 'signed_in' });
  });

  it('treats an unknown stored auth type as an API key connection', () => {
    expect(map['deepseek']).toMatchObject({ connected: true, kind: 'api_key' });
  });

  it('marks an active provider that is only ready via the environment as env', () => {
    expect(map['google']).toMatchObject({ connected: true, kind: 'env', envVar: 'GEMINI_API_KEY' });
  });

  it('keeps unconnected providers with their advertised methods', () => {
    expect(map['openai-codex']).toMatchObject({
      connected: false,
      kind: null,
      supportsKey: false,
      supportsSignIn: true,
      curated: true,
    });
  });

  it('appends extra configured slugs with the slug as label and both methods', () => {
    expect(map['alpha-slug']).toEqual({
      id: 'alpha-slug',
      label: 'alpha-slug',
      connected: true,
      kind: 'api_key',
      supportsKey: true,
      supportsSignIn: true,
      envVar: null,
      curated: false,
      suggestedModels: [],
    });
    expect(map['zeta-slug']).toMatchObject({ connected: true, curated: false });
    expect(rows.slice(-2).map((r) => r.id)).toEqual(['alpha-slug', 'zeta-slug']);
  });
});

describe('buildProviderList', () => {
  const rows = buildProviderRows(
    status({
      configured_providers: ['zeta-slug', 'openai', 'opencode-go', 'alpha-slug'],
      providers: CURATED.map((p) =>
        p.id === 'openai' || p.id === 'opencode-go' ? { ...p, configured: true } : p
      ),
    })
  );

  it('sorts connected curated first then extras alphabetically, available in curated order', () => {
    const list = buildProviderList(rows, '');
    expect(list.connected.map((r) => r.id)).toEqual(['opencode-go', 'openai', 'alpha-slug', 'zeta-slug']);
    expect(list.available.map((r) => r.id)).toEqual(['openrouter', 'openai-codex', 'google']);
    expect(list.noMatch).toBe(false);
    expect(list.otherSlugPrefill).toBeNull();
  });

  it('filters both sections over label and slug', () => {
    const list = buildProviderList(rows, 'codex');
    expect(list.connected).toEqual([]);
    expect(list.available.map((r) => r.id)).toEqual(['openai-codex']);
    expect(list.noMatch).toBe(false);

    expect(buildProviderList(rows, 'zeta').connected.map((r) => r.id)).toEqual(['zeta-slug']);
  });

  it('matches case- and diacritic-insensitively', () => {
    const accented = [row('acao', 'Ação Rápida'), row('openrouter', 'OpenRouter')];
    expect(buildProviderList(accented, 'ACAO').available.map((r) => r.id)).toEqual(['acao']);
    expect(buildProviderList(accented, 'rapida').available.map((r) => r.id)).toEqual(['acao']);
    expect(buildProviderList(accented, 'AÇÃO').available.map((r) => r.id)).toEqual(['acao']);
  });

  it('reports no match and prefills the slug only when the query is a valid slug', () => {
    const accented = [row('acao', 'Ação Rápida'), row('openrouter', 'OpenRouter')];
    const none = buildProviderList(accented, '  my-provider ');
    expect(none.connected).toEqual([]);
    expect(none.available).toEqual([]);
    expect(none.noMatch).toBe(true);
    expect(none.otherSlugPrefill).toBe('my-provider');

    const invalid = buildProviderList(accented, 'ZZZ');
    expect(invalid.noMatch).toBe(true);
    expect(invalid.otherSlugPrefill).toBeNull();
  });

  it('does not report no match for an empty query', () => {
    const list = buildProviderList([], '   ');
    expect(list.noMatch).toBe(false);
    expect(list.otherSlugPrefill).toBeNull();
  });
});

describe('initialSelection', () => {
  it('prefers the preselect', () => {
    expect(initialSelection(status({ configured_providers: ['opencode-go'] }), 'google')).toBe('google');
  });

  it('falls back to the active provider when it is connected', () => {
    expect(
      initialSelection(
        status({
          configured_providers: ['opencode-go', 'openrouter'],
          active_provider: 'openrouter',
          provider_ready: true,
        }),
        null
      )
    ).toBe('openrouter');
  });

  it('falls back to the first connected provider in curated order', () => {
    expect(
      initialSelection(
        status({ configured_providers: ['openai', 'opencode-go'], active_provider: 'google' }),
        null
      )
    ).toBe('opencode-go');
  });

  it('falls back to the first curated provider when nothing is connected', () => {
    expect(initialSelection(status(), null)).toBe('opencode-go');
  });
});

describe('derivePanelState', () => {
  const keyRow = row('openai', 'OpenAI', { envVar: 'OPENAI_API_KEY', suggestedModels: ['gpt-5'] });
  const oauthOnly = row('openai-codex', 'OpenAI Codex (ChatGPT OAuth)', {
    supportsKey: false,
    supportsSignIn: true,
  });
  const bothMethods = row('opencode-go', 'OpenCode Go', { supportsSignIn: true });
  const connectedRow = row('opencode-go', 'OpenCode Go', { connected: true, kind: 'api_key', supportsSignIn: true });
  const envRow = row('google', 'Google Gemini', { connected: true, kind: 'env', envVar: 'GEMINI_API_KEY' });

  const cases: Array<[string, Parameters<typeof derivePanelState>[0], PanelState]> = [
    ['busy connecting wins', { row: connectedRow, intent: 'confirm', signIn: null, busy: 'connecting' }, 'connecting'],
    ['busy disconnecting wins', { row: keyRow, intent: 'default', signIn: null, busy: 'disconnecting' }, 'disconnecting'],
    [
      'waiting sign-in for this provider',
      { row: oauthOnly, intent: 'default', signIn: { provider: 'openai-codex', phase: 'waiting' }, busy: null },
      'waiting',
    ],
    [
      'timed out sign-in for this provider',
      { row: oauthOnly, intent: 'default', signIn: { provider: 'openai-codex', phase: 'timeout' }, busy: null },
      'timeout',
    ],
    [
      'sign-in for another provider is ignored',
      { row: keyRow, intent: 'default', signIn: { provider: 'openai-codex', phase: 'waiting' }, busy: null },
      'key',
    ],
    [
      'invalid sign-in stays visible as S-ERROR with Sign in as primary',
      { row: oauthOnly, intent: 'default', signIn: { provider: 'openai-codex', phase: 'invalid' }, busy: null },
      'signInInvalid',
    ],
    [
      'rejected checks stay visible as S-ERROR with Check again as primary',
      { row: oauthOnly, intent: 'default', signIn: { provider: 'openai-codex', phase: 'error' }, busy: null },
      'signInError',
    ],
    [
      'invalid sign-in on an already connected provider still shows the error',
      { row: connectedRow, intent: 'default', signIn: { provider: 'opencode-go', phase: 'invalid' }, busy: null },
      'signInInvalid',
    ],
    ['connected with confirm', { row: connectedRow, intent: 'confirm', signIn: null, busy: null }, 'confirm'],
    ['connected with replace', { row: connectedRow, intent: 'replace', signIn: null, busy: null }, 'replace'],
    ['connected default', { row: connectedRow, intent: 'default', signIn: null, busy: null }, 'connected'],
    ['env default', { row: envRow, intent: 'default', signIn: null, busy: null }, 'env'],
    ['env replace', { row: envRow, intent: 'replace', signIn: null, busy: null }, 'replace'],
    ['custom intent on a connected row is ignored', { row: connectedRow, intent: 'useKey', signIn: null, busy: null }, 'connected'],
    ['oauth only provider defaults to oauth', { row: oauthOnly, intent: 'default', signIn: null, busy: null }, 'oauth'],
    ['use sign in on a key provider', { row: bothMethods, intent: 'useSignIn', signIn: null, busy: null }, 'oauth'],
    [
      'use key on an oauth-only provider falls back to oauth',
      { row: oauthOnly, intent: 'useKey', signIn: null, busy: null },
      'oauth',
    ],
    ['key provider defaults to key', { row: keyRow, intent: 'default', signIn: null, busy: null }, 'key'],
    ['use key keeps key', { row: bothMethods, intent: 'useKey', signIn: null, busy: null }, 'key'],
    ['default with both methods picks the key', { row: bothMethods, intent: 'default', signIn: null, busy: null }, 'key'],
    ['confirm on an unconnected row is ignored', { row: keyRow, intent: 'confirm', signIn: null, busy: null }, 'key'],
  ];

  it.each(cases)('%s', (_name, input, expected) => {
    expect(derivePanelState(input)).toBe(expected);
  });
});

describe('primaryFor', () => {
  const cases: Array<[PanelState, PrimaryAction]> = [
    ['key', 'connect'],
    ['oauth', 'signIn'],
    ['connecting', 'busy'],
    ['waiting', 'busy'],
    ['timeout', 'checkAgain'],
    ['signInInvalid', 'signIn'],
    ['signInError', 'checkAgain'],
    ['connected', 'done'],
    ['env', 'done'],
    ['replace', 'saveKey'],
    ['confirm', 'disconnect'],
    ['disconnecting', 'busy'],
  ];

  it.each(cases)('%s -> %s', (state, action) => {
    expect(primaryFor(state)).toBe(action);
  });

  it('uses done only for connected and env', () => {
    expect(cases.filter(([, action]) => action === 'done').map(([state]) => state)).toEqual(['connected', 'env']);
  });
});

describe('pickInitialDefault', () => {
  const CATALOG = catalog(
    model('openrouter', 'kimi-k3'),
    model('opencode-go', 'other-model'),
    model('opencode-go', 'deepseek-v4.1-flash')
  );

  it('prefers the first curated suggestion when the catalog lists it', () => {
    expect(pickInitialDefault(CATALOG, 'opencode-go', ['deepseek-v4.1-flash', 'hy4-flash-free'])).toBe(
      'deepseek-v4.1-flash'
    );
  });

  it('falls back to the first catalog model of the provider, in catalog order', () => {
    expect(pickInitialDefault(CATALOG, 'openrouter', ['gone-model'])).toBe('kimi-k3');
    expect(pickInitialDefault(CATALOG, 'opencode-go', [])).toBe('other-model');
  });

  it('falls back to the first curated suggestion without a catalog', () => {
    expect(pickInitialDefault(null, 'openrouter', ['kimi-k3', 'deepseek/deepseek-chat'])).toBe('kimi-k3');
    expect(pickInitialDefault(catalog(model('openai', 'gpt-5')), 'openrouter', ['kimi-k3'])).toBe('kimi-k3');
  });

  it('returns null when neither the catalog nor the curated list knows a model', () => {
    expect(pickInitialDefault(null, 'mystery', [])).toBeNull();
    expect(pickInitialDefault(catalog(), 'mystery', [])).toBeNull();
  });
});

describe('pickFallbackDefault', () => {
  const rows: ProviderRow[] = [
    row('opencode-go', 'OpenCode Go', {
      connected: true,
      kind: 'api_key',
      suggestedModels: ['deepseek-v4.1-flash'],
    }),
    row('openrouter', 'OpenRouter', { connected: true, kind: 'signed_in', suggestedModels: ['kimi-k3'] }),
    row('openai', 'OpenAI', { suggestedModels: ['gpt-5'] }),
    row('google', 'Google Gemini', { connected: true, kind: 'env', suggestedModels: ['gemini-2.5-pro'] }),
  ];
  const CATALOG = catalog(model('openrouter', 'kimi-k3'));

  it('picks the next connected provider in list order, skipping unconnected rows', () => {
    expect(pickFallbackDefault('opencode-go', rows, CATALOG)).toEqual({ provider: 'openrouter', model: 'kimi-k3' });
    expect(pickFallbackDefault('openrouter', rows, CATALOG)).toEqual({
      provider: 'google',
      model: 'gemini-2.5-pro',
    });
  });

  it('falls back to the curated suggestion when the catalog failed to load', () => {
    expect(pickFallbackDefault('opencode-go', rows, null)).toEqual({ provider: 'openrouter', model: 'kimi-k3' });
  });

  it('writes a null model when the fallback provider has no known model', () => {
    const bare = [row('opencode-go', 'OpenCode Go', { connected: true, kind: 'api_key' }), row('mystery', 'mystery', { connected: true, kind: 'api_key', curated: false })];
    expect(pickFallbackDefault('opencode-go', bare, null)).toEqual({ provider: 'mystery', model: null });
  });

  it('returns null when no other provider is connected', () => {
    expect(pickFallbackDefault('opencode-go', [rows[0], rows[2]], CATALOG)).toBeNull();
    expect(pickFallbackDefault('opencode-go', [], CATALOG)).toBeNull();
  });
});
