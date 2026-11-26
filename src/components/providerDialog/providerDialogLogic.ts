import type { PiModelCatalog, PiProviderCatalogEntry, PiSetupStatus } from '../../types/ipc';
import { fuzzyMatch, normalizeSearchText } from '../modelPicker/modelPickerLogic';

/** Mirrors `validate_provider_slug` in the Rust sidecar. */
export const SLUG_RE = /^[a-z0-9-]{1,64}$/;

/** The single primary class of the dialog, and its danger variant (AC10 counts both). */
export const PRIMARY_CLASS = 'btn-primary-xs';
export const DANGER_PRIMARY_CLASS = 'btn-danger-xs';

export type ConnectionKind = 'api_key' | 'signed_in' | 'env';

export interface ProviderRow {
  id: string;
  label: string;
  connected: boolean;
  /** How it is connected; null when it is not. */
  kind: ConnectionKind | null;
  supportsKey: boolean;
  supportsSignIn: boolean;
  envVar: string | null;
  /** False for a connected slug that is not in the curated catalog. */
  curated: boolean;
  /** Curated model suggestions, used to pick a fallback default (§4.5). */
  suggestedModels: string[];
}

export interface ProviderListView {
  connected: ProviderRow[];
  available: ProviderRow[];
  noMatch: boolean;
  /** The query as a slug, when nothing matched and the query is a valid slug. */
  otherSlugPrefill: string | null;
}

export type PanelIntent = 'default' | 'useKey' | 'useSignIn' | 'replace' | 'confirm';

export type PanelState =
  | 'key'
  | 'oauth'
  | 'connecting'
  | 'waiting'
  | 'timeout'
  | 'connected'
  | 'env'
  | 'replace'
  | 'confirm'
  | 'disconnecting'
  | 'signInInvalid'
  | 'signInError';

export type PrimaryAction = 'connect' | 'signIn' | 'busy' | 'checkAgain' | 'saveKey' | 'disconnect' | 'done';

export type SignInPhase = 'waiting' | 'timeout' | 'invalid' | 'error';

export function isValidSlug(slug: string): boolean {
  return SLUG_RE.test(slug);
}

/** Configured providers plus the active provider when pi reports it as ready. */
export function connectedProviderIds(status: PiSetupStatus): string[] {
  const ids = [...status.configured_providers];
  if (status.provider_ready && status.active_provider && !ids.includes(status.active_provider)) {
    ids.push(status.active_provider);
  }
  return ids;
}

function kindFromAuthType(authType: string | null): ConnectionKind {
  return authType === 'oauth' ? 'signed_in' : 'api_key';
}

/**
 * One row per curated provider, in catalog order, plus the connected slugs the catalog doesn't
 * know (appended alphabetically with the slug as label, per §3.2 and §6).
 */
export function buildProviderRows(status: PiSetupStatus): ProviderRow[] {
  const configured = new Set(status.configured_providers);
  const rows: ProviderRow[] = [];
  const known = new Set<string>();

  for (const entry of status.providers) {
    known.add(entry.id);
    rows.push(rowFor(entry, configured, status));
  }

  const extras = Array.from(configured)
    .filter((id) => !known.has(id))
    .sort((a, b) => a.localeCompare(b));
  for (const id of extras) {
    rows.push({
      id,
      label: id,
      connected: true,
      kind: 'api_key',
      supportsKey: true,
      supportsSignIn: true,
      envVar: null,
      curated: false,
      suggestedModels: [],
    });
  }

  return rows;
}

function rowFor(entry: PiProviderCatalogEntry, configured: Set<string>, status: PiSetupStatus): ProviderRow {
  const isConfigured = configured.has(entry.id) || entry.configured;
  const readyViaEnv =
    !isConfigured && entry.id === status.active_provider && status.provider_ready;
  return {
    id: entry.id,
    label: entry.label,
    connected: isConfigured || readyViaEnv,
    kind: isConfigured ? kindFromAuthType(entry.auth_type) : readyViaEnv ? 'env' : null,
    supportsKey: entry.supports_api_key,
    supportsSignIn: entry.supports_oauth,
    envVar: entry.env_var_hint,
    curated: true,
    suggestedModels: entry.suggested_models,
  };
}

function matchesQuery(row: ProviderRow, tokens: string[]): boolean {
  return tokens.every((token) => fuzzyMatch(token, row.label) !== null || fuzzyMatch(token, row.id) !== null);
}

/** Splits rows into the CONNECTED / AVAILABLE sections, filtered by `query` (§3.2). */
export function buildProviderList(rows: ProviderRow[], query: string): ProviderListView {
  const tokens = normalizeSearchText(query).split(/\s+/).filter(Boolean);
  const visible = tokens.length === 0 ? rows.slice() : rows.filter((row) => matchesQuery(row, tokens));

  const connected = [
    ...visible.filter((row) => row.connected && row.curated),
    ...visible
      .filter((row) => row.connected && !row.curated)
      .sort((a, b) => a.id.localeCompare(b.id)),
  ];
  const available = visible.filter((row) => !row.connected);

  const trimmed = query.trim();
  const noMatch = trimmed.length > 0 && connected.length === 0 && available.length === 0;

  return {
    connected,
    available,
    noMatch,
    otherSlugPrefill: noMatch && isValidSlug(trimmed) ? trimmed : null,
  };
}

/** Preselect wins, else the active provider, else the first connected one, else the first curated (§3.3). */
export function initialSelection(status: PiSetupStatus, preselect: string | null): string {
  if (preselect) return preselect;
  const connected = connectedProviderIds(status);
  if (status.active_provider && connected.includes(status.active_provider)) return status.active_provider;
  if (connected.length > 0) return firstInCatalogOrder(connected, status.providers);
  return status.providers[0]?.id ?? '';
}

function firstInCatalogOrder(ids: string[], providers: PiProviderCatalogEntry[]): string {
  for (const entry of providers) {
    if (ids.includes(entry.id)) return entry.id;
  }
  return ids[0];
}

/**
 * One panel state per selected provider (§3.4). S-ERROR is not a state: it is an error string
 * rendered on top of the state this function returns.
 */
export function derivePanelState(input: {
  row: ProviderRow;
  intent: PanelIntent;
  signIn: { provider: string; phase: SignInPhase } | null;
  busy: 'connecting' | 'disconnecting' | null;
}): PanelState {
  const { row, intent, signIn, busy } = input;
  if (busy) return busy;

  if (signIn && signIn.provider === row.id) {
    if (signIn.phase === 'waiting') return 'waiting';
    if (signIn.phase === 'timeout') return 'timeout';
    if (signIn.phase === 'invalid') return 'signInInvalid';
    if (signIn.phase === 'error') return 'signInError';
  }

  if (row.connected) {
    if (intent === 'confirm') return 'confirm';
    if (intent === 'replace') return 'replace';
    return row.kind === 'env' ? 'env' : 'connected';
  }

  if (intent === 'useSignIn' && row.supportsSignIn) return 'oauth';
  if (intent === 'useKey' && row.supportsKey) return 'key';
  if (!row.supportsKey && row.supportsSignIn) return 'oauth';
  return 'key';
}

/** The only primary action of the dialog for a panel state; footer Done is primary just for connected/env. */
export function primaryFor(state: PanelState): PrimaryAction {
  switch (state) {
    case 'key':
      return 'connect';
    case 'oauth':
      return 'signIn';
    case 'timeout':
    case 'signInError':
      return 'checkAgain';
    case 'signInInvalid':
      return 'signIn';
    case 'connected':
    case 'env':
      return 'done';
    case 'replace':
      return 'saveKey';
    case 'confirm':
      return 'disconnect';
    case 'connecting':
    case 'waiting':
    case 'disconnecting':
      return 'busy';
  }
}

/**
 * §4.3 step 5: the provider's first curated suggestion when the catalog knows it, else the
 * provider's first catalog model, else the first curated suggestion, else null.
 */
export function pickInitialDefault(
  catalog: PiModelCatalog | null,
  provider: string,
  curated: string[]
): string | null {
  const providerModels = catalog?.models.filter((m) => m.provider === provider) ?? [];
  const firstCurated = curated[0] ?? null;
  if (firstCurated !== null && providerModels.some((m) => m.id === firstCurated)) return firstCurated;
  if (providerModels.length > 0) return providerModels[0].id;
  return firstCurated;
}

/**
 * §4.5 step 1: the default falls back to the next connected provider in list order after the
 * target (wrapping around), with its initial model, or null when no other provider is connected.
 */
export function pickFallbackDefault(
  target: string,
  rows: ProviderRow[],
  catalog: PiModelCatalog | null
): { provider: string; model: string | null } | null {
  const at = rows.findIndex((row) => row.id === target);
  const ordered = at >= 0 ? [...rows.slice(at + 1), ...rows.slice(0, at)] : rows;
  const fallback = ordered.find((row) => row.connected && row.id !== target);
  if (!fallback) return null;
  return {
    provider: fallback.id,
    model: pickInitialDefault(catalog, fallback.id, fallback.suggestedModels),
  };
}
