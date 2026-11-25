import type { PiModelInfo } from '../../types/ipc';

/** The subset of a curated provider entry the picker needs. */
export interface PickerProvider {
  id: string;
  label: string;
  suggested_models: string[];
}

export type PickerRow =
  | { kind: 'model'; key: string; model: PiModelInfo; disabled: boolean; nameMatches: number[] }
  | { kind: 'connect'; key: string; providerId: string; label: string; suggestedCount: number }
  | { kind: 'custom'; key: string; text: string };

export interface PickerSection {
  key: string;
  kind: 'provider' | 'notConnected' | 'custom';
  /** Set for `provider` sections only. */
  providerId?: string;
  label: string;
  /** Number of models shown in a `provider` section. */
  count: number;
  rows: PickerRow[];
}

export interface PickerView {
  sections: PickerSection[];
  /** Selectable models matching the query. */
  matchCount: number;
  /** All selectable models. */
  totalCount: number;
}

export interface BuildPickerViewInput {
  models: PiModelInfo[];
  providers: PickerProvider[];
  /** Providers with usable credentials; their models are selectable. */
  connectedProviders: string[];
  /** A provider that is not connected yet but whose models may still be chosen (field mode, while configuring it). */
  selectableProvider?: string | null;
  query: string;
}

export function normalizeSearchText(text: string): string {
  return normalizeWithMap(text).normalized;
}

/** Normalizes char by char so every normalized index maps back to the original string. */
function normalizeWithMap(text: string): { normalized: string; origin: number[] } {
  let normalized = '';
  const origin: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const folded = text[i].normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    for (const ch of folded) {
      normalized += ch;
      origin.push(i);
    }
  }
  return { normalized, origin };
}

/**
 * Case- and diacritic-insensitive match of a single token.
 * Prefers a contiguous substring, otherwise accepts the letters in order.
 * Returns the matched indices in `text`, or null when it does not match.
 */
export function fuzzyMatch(query: string, text: string): number[] | null {
  const needle = normalizeSearchText(query).replace(/\s+/g, '');
  if (!needle) return [];
  const { normalized, origin } = normalizeWithMap(text);

  const at = normalized.indexOf(needle);
  if (at >= 0) {
    return uniqueOrigins(origin.slice(at, at + needle.length));
  }

  const hits: number[] = [];
  let from = 0;
  for (const ch of needle) {
    const found = normalized.indexOf(ch, from);
    if (found < 0) return null;
    hits.push(origin[found]);
    from = found + 1;
  }
  return uniqueOrigins(hits);
}

function uniqueOrigins(indices: number[]): number[] {
  return Array.from(new Set(indices)).sort((a, b) => a - b);
}

function tokenize(query: string): string[] {
  return normalizeSearchText(query).split(/\s+/).filter(Boolean);
}

/** Every token must match the name, id, provider id or provider label. Returns name highlights, or null. */
function matchModel(tokens: string[], model: PiModelInfo, providerLabel: string): number[] | null {
  const displayName = model.name || model.id;
  const highlights: number[] = [];
  for (const token of tokens) {
    const inName = fuzzyMatch(token, displayName);
    if (inName) {
      highlights.push(...inName);
      continue;
    }
    const elsewhere = [model.id, model.provider, providerLabel].some((field) => fuzzyMatch(token, field) !== null);
    if (!elsewhere) return null;
  }
  return uniqueOrigins(highlights);
}

/** Every token is a contiguous substring of some field; loose subsequence hits don't count. */
function isStrongMatch(tokens: string[], model: PiModelInfo, providerLabel: string): boolean {
  const fields = [model.name || model.id, model.id, model.provider, providerLabel].map(normalizeSearchText);
  return tokens.every((token) => fields.some((field) => field.includes(token)));
}

function suggestedModelInfo(provider: string, id: string): PiModelInfo {
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

export function buildPickerView(input: BuildPickerViewInput): PickerView {
  const tokens = tokenize(input.query);
  const labels = new Map(input.providers.map((p) => [p.id, p.label]));
  const labelOf = (id: string) => labels.get(id) ?? id;
  const selectable = new Set(input.connectedProviders);
  if (input.selectableProvider) selectable.add(input.selectableProvider);

  // Catalog models first, then curated suggestions for providers the catalog knows nothing about.
  const byProvider = new Map<string, PiModelInfo[]>();
  for (const m of input.models) {
    const list = byProvider.get(m.provider) ?? [];
    list.push(m);
    byProvider.set(m.provider, list);
  }
  for (const p of input.providers) {
    if (!byProvider.has(p.id) && p.suggested_models.length > 0) {
      byProvider.set(p.id, p.suggested_models.map((id) => suggestedModelInfo(p.id, id)));
    }
  }

  const providerIds = Array.from(byProvider.keys()).sort((a, b) =>
    labelOf(a).localeCompare(labelOf(b), undefined, { sensitivity: 'base' })
  );

  const sections: PickerSection[] = [];
  const notConnectedRows: PickerRow[] = [];
  let matchCount = 0;
  let totalCount = 0;
  let strongMatches = 0;

  for (const providerId of providerIds) {
    const label = labelOf(providerId);
    const all = byProvider.get(providerId) ?? [];
    const isSelectable = selectable.has(providerId);
    const rows: PickerRow[] = [];
    for (const m of all) {
      const nameMatches = matchModel(tokens, m, label);
      if (!nameMatches) continue;
      rows.push({
        kind: 'model',
        key: `${providerId}/${m.id}`,
        model: m,
        disabled: !isSelectable,
        nameMatches,
      });
    }

    if (isSelectable) {
      totalCount += all.length;
      matchCount += rows.length;
      for (const row of rows) {
        if (row.kind === 'model' && isStrongMatch(tokens, row.model, label)) strongMatches += 1;
      }
      if (rows.length > 0) {
        sections.push({ key: `provider:${providerId}`, kind: 'provider', providerId, label, count: rows.length, rows });
      }
    } else if (rows.length > 0) {
      // A query matching the provider label matches all of its models, so this also covers provider searches.
      notConnectedRows.push(
        { kind: 'connect', key: `connect:${providerId}`, providerId, label, suggestedCount: all.length },
        ...rows
      );
    }
  }

  if (notConnectedRows.length > 0) {
    sections.push({ key: 'notConnected', kind: 'notConnected', label: '', count: 0, rows: notConnectedRows });
  }

  // Fuzzy subsequence hits are too loose to prove the model exists, so a typed id that isn't
  // literally present keeps the custom-id escape hatch available.
  const customText = input.query.trim();
  if (customText && strongMatches === 0) {
    sections.push({
      key: 'custom',
      kind: 'custom',
      label: '',
      count: 0,
      rows: [{ kind: 'custom', key: 'custom', text: customText }],
    });
  }

  return { sections, matchCount, totalCount };
}

export function formatContextWindow(locale: string, tokens: number | null): string | null {
  if (tokens == null || tokens <= 0) return null;
  // Providers report binary sizes (1_048_576), so round to whole K and one decimal of M.
  const maximumFractionDigits = tokens >= 1_000_000 ? 1 : 0;
  return new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits }).format(tokens);
}

/** `$in/$out` per million tokens; omitted when unknown or free. */
export function formatPrice(costIn: number | null, costOut: number | null): string | null {
  if (costIn == null || costOut == null) return null;
  if (costIn <= 0 && costOut <= 0) return null;
  return `$${trimNumber(costIn)}/${trimNumber(costOut)}`;
}

function trimNumber(n: number): string {
  return String(Number(n.toFixed(4)));
}
