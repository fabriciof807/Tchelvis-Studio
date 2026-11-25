import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { PiModelCatalog, PiModelInfo } from '../../types/ipc';
import { useI18n } from '../../i18n/useI18n';
import {
  buildPickerView,
  formatContextWindow,
  formatPrice,
  type PickerProvider,
  type PickerRow,
} from './modelPickerLogic';

export interface ModelSelection {
  provider: string;
  id: string;
}

export interface ModelPickerProps {
  catalog: PiModelCatalog | null;
  loading: boolean;
  /** Last catalog load error, if any. */
  error?: string | null;
  providers: PickerProvider[];
  /** Providers with usable credentials. With a `pi_rpc` catalog, every provider in it also counts as connected. */
  connectedProviders: string[];
  /** Provider being configured; its suggestions stay selectable before it connects. */
  selectableProvider?: string | null;
  value: ModelSelection | null;
  /** `provider` is null for a custom model id typed by the user. */
  onChange: (selection: { provider: string | null; id: string }) => void;
  onRetry: () => void;
  onConnectProvider: (providerId: string) => void;
  /** Id of the visible label element for the field. */
  labelId?: string;
}

type ActionableRow = Exclude<PickerRow, { kind: 'model'; disabled: true }>;

function isActionable(row: PickerRow): row is ActionableRow {
  return row.kind !== 'model' || !row.disabled;
}

/**
 * Model picker in field mode: a trigger showing the chosen model that opens a searchable,
 * grouped listbox (combobox pattern with aria-activedescendant). Compact mode comes with S4.
 */
export const ModelPicker: React.FC<ModelPickerProps> = ({
  catalog,
  loading,
  error = null,
  providers,
  connectedProviders,
  selectableProvider,
  value,
  onChange,
  onRetry,
  onConnectProvider,
  labelId,
}) => {
  const { t, tp, locale } = useI18n();
  const baseId = useId();
  const listId = `${baseId}-list`;
  const valueId = `${baseId}-value`;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const models = catalog?.models ?? [];
  const connected = useMemo(() => {
    const set = new Set(connectedProviders);
    if (catalog?.source === 'pi_rpc') {
      for (const m of catalog.models) set.add(m.provider);
    }
    return Array.from(set);
  }, [catalog, connectedProviders]);

  const view = useMemo(
    () => buildPickerView({ models, providers, connectedProviders: connected, selectableProvider, query }),
    [models, providers, connected, selectableProvider, query]
  );

  // Index-based DOM ids: model ids may contain any character, and sanitizing them can collide.
  const optionIndex = useMemo(() => {
    const map = new Map<string, number>();
    view.sections.forEach((s) => s.rows.forEach((r) => map.set(r.key, map.size)));
    return map;
  }, [view]);

  const actionable = useMemo(
    () => view.sections.flatMap((s) => s.rows.filter(isActionable)),
    [view]
  );

  const valueKey = value ? `${value.provider}/${value.id}` : null;

  // Keep the active option valid as the list changes: prefer the current value, else the first option.
  useEffect(() => {
    if (!open) return;
    setActiveKey((prev) => {
      if (prev && actionable.some((r) => r.key === prev)) return prev;
      if (!query && valueKey && actionable.some((r) => r.key === valueKey)) return valueKey;
      return actionable[0]?.key ?? null;
    });
  }, [open, actionable, query, valueKey]);

  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();
    const onPointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) close(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  useEffect(() => {
    if (!open || !activeKey) return;
    const el = document.getElementById(optionId(activeKey));
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [open, activeKey]);

  function optionId(key: string) {
    return `${baseId}-opt-${optionIndex.get(key) ?? 'none'}`;
  }

  function close(restoreFocus: boolean) {
    setOpen(false);
    setQuery('');
    setActiveKey(null);
    if (restoreFocus) triggerRef.current?.focus();
  }

  function activate(row: PickerRow) {
    if (!isActionable(row)) return;
    if (row.kind === 'model') onChange({ provider: row.model.provider, id: row.model.id });
    else if (row.kind === 'custom') onChange({ provider: null, id: row.text });
    else onConnectProvider(row.providerId);
    close(true);
  }

  function moveActive(delta: number) {
    if (actionable.length === 0) return;
    const current = actionable.findIndex((r) => r.key === activeKey);
    const next = current < 0 ? 0 : (current + delta + actionable.length) % actionable.length;
    setActiveKey(actionable[next].key);
  }

  function onSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        moveActive(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        moveActive(-1);
        break;
      case 'Enter': {
        e.preventDefault();
        const row = actionable.find((r) => r.key === activeKey);
        if (row) activate(row);
        break;
      }
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        close(true);
        break;
      case 'Tab':
        // Park focus on the trigger before the search field unmounts, so Tab continues from there.
        close(true);
        break;
    }
  }

  const selectedModel = value
    ? models.find((m) => m.provider === value.provider && m.id === value.id) ?? null
    : null;
  const providerLabel = (id: string) => providers.find((p) => p.id === id)?.label ?? id;
  const triggerText = value?.id
    ? `${selectedModel?.name || value.id} · ${providerLabel(value.provider)}`
    : t('modelPicker.placeholder');

  const showConnectHint = catalog !== null && connected.length === 0;
  const showFallback =
    (catalog === null && Boolean(error)) ||
    (catalog !== null && !showConnectHint && catalog.source !== 'pi_rpc');
  const firstLoad = catalog === null && loading;

  return (
    <div className="model-picker" ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        className={`model-picker-trigger${value?.id ? '' : ' placeholder'}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-labelledby={labelId ? `${labelId} ${valueId}` : undefined}
        title={value?.id ? `${value.provider}/${value.id}` : undefined}
        onClick={() => (open ? close(true) : setOpen(true))}
      >
        <span id={valueId} className="model-picker-trigger-text">
          {triggerText}
        </span>
        <span className="model-picker-caret" aria-hidden="true">
          ▾
        </span>
      </button>

      {showConnectHint && <div className="model-picker-hint">{t('modelPicker.connectHint')}</div>}
      {showFallback && (
        <div className="model-picker-fallback" role="status">
          <span>{t('modelPicker.fallbackBanner')}</span>
          <button type="button" className="btn-ghost-xs" disabled={loading} onClick={onRetry}>
            {t('modelPicker.retry')}
          </button>
        </div>
      )}

      {open && (
        <div className="model-picker-panel">
          <div className="model-picker-search-row">
            <input
              ref={searchRef}
              type="text"
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={activeKey ? optionId(activeKey) : undefined}
              aria-label={t('modelPicker.searchLabel')}
              className="model-picker-search"
              placeholder={t('modelPicker.searchPlaceholder')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onSearchKeyDown}
              autoComplete="off"
              spellCheck={false}
            />
            <span className="model-picker-count" aria-live="polite">
              {t('modelPicker.matchCount', { n: view.matchCount, m: view.totalCount })}
            </span>
          </div>

          <div id={listId} role="listbox" aria-label={t('modelPicker.listLabel')} className="model-picker-list">
            {catalog === null && loading && (
              <div className="model-picker-empty" role="presentation">
                {t('modelPicker.loading')}
              </div>
            )}
            {catalog !== null && view.sections.length === 0 && (
              <div className="model-picker-empty" role="presentation">
                {t('modelPicker.noResults')}
              </div>
            )}
            {!firstLoad && view.sections.map((section) => {
              const label =
                section.kind === 'provider'
                  ? `${section.label} · ${tp('modelPicker.modelCount', section.count)}`
                  : section.kind === 'notConnected'
                    ? t('modelPicker.notConnected')
                    : undefined;
              const rows = section.rows.map((row) => (
                <PickerOption
                  key={row.key}
                  id={optionId(row.key)}
                  row={row}
                  active={row.key === activeKey}
                  selected={row.key === valueKey}
                  locale={locale}
                  onActivate={activate}
                  onHover={(key) => setActiveKey(key)}
                />
              ));
              if (!label) return <React.Fragment key={section.key}>{rows}</React.Fragment>;
              return (
                <div key={section.key} role="group" aria-label={label} className="model-picker-group">
                  <div className="model-picker-group-label" aria-hidden="true">
                    {label}
                  </div>
                  {rows}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};

interface PickerOptionProps {
  id: string;
  row: PickerRow;
  active: boolean;
  selected: boolean;
  locale: string;
  onActivate: (row: PickerRow) => void;
  onHover: (key: string) => void;
}

const PickerOption: React.FC<PickerOptionProps> = ({ id, row, active, selected, locale, onActivate, onHover }) => {
  const { t, tp } = useI18n();
  const disabled = row.kind === 'model' && row.disabled;
  const className = [
    'model-picker-option',
    `kind-${row.kind}`,
    active ? 'active' : '',
    disabled ? 'disabled' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      id={id}
      role="option"
      aria-selected={selected}
      aria-disabled={disabled || undefined}
      className={className}
      title={row.kind === 'model' ? `${row.model.provider}/${row.model.id}` : undefined}
      // Keep focus in the search field while clicking an option.
      onMouseDown={(e) => e.preventDefault()}
      onMouseMove={() => !disabled && !active && onHover(row.key)}
      onClick={() => onActivate(row)}
    >
      {row.kind === 'model' && (
        <>
          <span className="model-picker-check" aria-hidden="true">
            {selected ? '✓' : ''}
          </span>
          <span className="model-picker-name">
            <Highlighted text={row.model.name || row.model.id} indices={row.nameMatches} />
          </span>
          <ModelBadges model={row.model} locale={locale} />
        </>
      )}
      {row.kind === 'connect' && (
        <>
          <span className="model-picker-name">
            {row.label} · {tp('modelPicker.suggestedCount', row.suggestedCount)}
          </span>
          <span className="model-picker-connect">{t('modelPicker.connect')}</span>
        </>
      )}
      {row.kind === 'custom' && (
        <span className="model-picker-name">{t('modelPicker.customId', { text: row.text })}</span>
      )}
    </div>
  );
};

const Highlighted: React.FC<{ text: string; indices: number[] }> = ({ text, indices }) => {
  if (indices.length === 0) return <>{text}</>;
  const marked = new Set(indices);
  const parts: React.ReactNode[] = [];
  let i = 0;
  while (i < text.length) {
    const isMarked = marked.has(i);
    let j = i;
    while (j < text.length && marked.has(j) === isMarked) j += 1;
    const chunk = text.slice(i, j);
    parts.push(isMarked ? <mark key={i}>{chunk}</mark> : chunk);
    i = j;
  }
  return <>{parts}</>;
};

const ModelBadges: React.FC<{ model: PiModelInfo; locale: string }> = ({ model, locale }) => {
  const { t } = useI18n();
  const context = formatContextWindow(locale, model.context_window);
  const contextLong =
    model.context_window != null && model.context_window > 0
      ? new Intl.NumberFormat(locale, { notation: 'compact', compactDisplay: 'long' }).format(model.context_window)
      : null;
  const price = formatPrice(model.cost_in, model.cost_out);
  return (
    <span className="model-picker-badges">
      {model.reasoning && (
        <span role="img" aria-label={t('modelPicker.badgeReasoning')} title={t('modelPicker.badgeReasoning')}>
          🧠
        </span>
      )}
      {model.image_input && (
        <span role="img" aria-label={t('modelPicker.badgeImage')} title={t('modelPicker.badgeImage')}>
          🖼
        </span>
      )}
      {context && (
        <MetaBadge text={context} description={t('modelPicker.badgeContext', { size: contextLong ?? context })} />
      )}
      {price && <MetaBadge text={price} description={t('modelPicker.badgePrice', { price })} />}
    </span>
  );
};

/** Short visible text with a spoken description for screen readers. */
const MetaBadge: React.FC<{ text: string; description: string }> = ({ text, description }) => (
  <span className="model-picker-meta" title={description}>
    <span aria-hidden="true">{text}</span>
    <span className="sr-only">{description}</span>
  </span>
);
