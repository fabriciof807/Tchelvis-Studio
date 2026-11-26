import React, { useEffect, useId, useMemo, useState } from 'react';
import { useI18n } from '../../i18n/useI18n';
import { buildProviderList, type ProviderRow } from './providerDialogLogic';

/** Pseudo row for "Other provider (slug)…"; always the last option and never filtered out. */
export const OTHER_PROVIDER_ID = '__other__';

export interface ProviderListProps {
  rows: ProviderRow[];
  selectedId: string;
  searchRef: React.RefObject<HTMLInputElement | null>;
  onSelect: (id: string) => void;
  onSelectOther: (slugPrefill: string) => void;
}

/**
 * Combobox + listbox provider picker (§3.2): search over label and slug, CONNECTED / AVAILABLE
 * sections, ↑/↓/`Enter` from the search field, `aria-activedescendant` while focus stays there.
 */
export const ProviderList: React.FC<ProviderListProps> = ({
  rows,
  selectedId,
  searchRef,
  onSelect,
  onSelectOther,
}) => {
  const { t } = useI18n();
  const baseId = useId();
  const listId = `${baseId}-list`;
  const [query, setQuery] = useState('');
  const [activeId, setActiveId] = useState<string | null>(null);

  const view = useMemo(() => buildProviderList(rows, query), [rows, query]);

  const options = useMemo(
    () => [...view.connected, ...view.available].map((row) => row.id).concat(OTHER_PROVIDER_ID),
    [view]
  );
  const indexOf = useMemo(() => new Map(options.map((id, index) => [id, index])), [options]);
  const optionId = (id: string) => `${baseId}-opt-${indexOf.get(id) ?? 0}`;
  const active = activeId && indexOf.has(activeId) ? activeId : selectedId;

  useEffect(() => {
    document.getElementById(optionId(active))?.scrollIntoView?.({ block: 'nearest' });
    // `optionId` is derived from stable ids, so re-running on `active` is enough.
  }, [active]);

  function moveActive(delta: number) {
    if (options.length === 0) return;
    const current = activeId ? options.indexOf(activeId) : options.indexOf(selectedId);
    const next =
      current < 0
        ? delta > 0
          ? 0
          : options.length - 1
        : (current + delta + options.length) % options.length;
    setActiveId(options[next] ?? null);
  }

  function activate(id: string) {
    if (id === OTHER_PROVIDER_ID) onSelectOther(view.otherSlugPrefill ?? '');
    else onSelect(id);
  }

  function onSearchKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        moveActive(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        moveActive(-1);
        break;
      case 'Enter': {
        event.preventDefault();
        // Only the row highlighted from the search results may be activated: `selectedId` can be
        // hidden by the filter, and re-activating it would reset the panel state for no reason.
        if (activeId && indexOf.has(activeId)) activate(activeId);
        break;
      }
      case 'Escape':
        if (query.length === 0) return; // nothing to clear: let the dialog handle `Esc`
        event.preventDefault();
        event.stopPropagation();
        setQuery('');
        setActiveId(null);
        break;
      default:
        break;
    }
  }

  function renderRow(row: ProviderRow) {
    const selected = row.id === selectedId && selectedId !== OTHER_PROVIDER_ID;
    const className = [
      'provider-dialog-option',
      selected ? 'selected' : '',
      row.id === active ? 'active' : '',
    ]
      .filter(Boolean)
      .join(' ');
    const methods = row.connected
      ? row.kind === 'signed_in'
        ? t('providerDialog.kindSignedIn')
        : row.kind === 'env'
          ? t('providerDialog.kindEnv')
          : t('providerDialog.kindApiKey')
      : [
          row.supportsKey ? t('providerDialog.methodKey') : null,
          row.supportsSignIn ? t('providerDialog.methodSignIn') : null,
        ]
          .filter(Boolean)
          .join(' · ');

    return (
      <div
        key={row.id}
        id={optionId(row.id)}
        role="option"
        aria-selected={selected}
        className={className}
        // Keep focus in the search field while clicking; the panel is focused by the dialog.
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => onSelect(row.id)}
      >
        {row.connected && (
          <span className="provider-dialog-dot" aria-hidden="true">
            ●
          </span>
        )}
        <span className="provider-dialog-option-label">{row.label}</span>
        <span className="provider-dialog-option-meta">{methods}</span>
      </div>
    );
  }

  const otherSelected = selectedId === OTHER_PROVIDER_ID;

  return (
    <div className="provider-dialog-list-wrap">
      <input
        ref={searchRef}
        type="text"
        role="combobox"
        aria-expanded="true"
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={active ? optionId(active) : undefined}
        aria-label={t('providerDialog.searchPlaceholder')}
        className="provider-dialog-search"
        placeholder={t('providerDialog.searchPlaceholder')}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={onSearchKeyDown}
        autoComplete="off"
        spellCheck={false}
      />

      <div
        id={listId}
        role="listbox"
        aria-label={t('providerDialog.listLabel')}
        className="provider-dialog-list"
      >
        {view.noMatch && (
          <div className="provider-dialog-empty" role="presentation">
            {t('providerDialog.noMatch', { query: query.trim() })}
          </div>
        )}

        {view.connected.length > 0 && (
          <div
            role="group"
            aria-label={t('providerDialog.sectionConnected')}
            className="provider-dialog-group"
          >
            <div className="provider-dialog-group-label" aria-hidden="true">
              {t('providerDialog.sectionConnected')}
            </div>
            {view.connected.map(renderRow)}
          </div>
        )}

        {view.available.length > 0 && (
          <div
            role="group"
            aria-label={t('providerDialog.sectionAvailable')}
            className="provider-dialog-group"
          >
            <div className="provider-dialog-group-label" aria-hidden="true">
              {t('providerDialog.sectionAvailable')}
            </div>
            {view.available.map(renderRow)}
          </div>
        )}

        <div
          id={optionId(OTHER_PROVIDER_ID)}
          role="option"
          aria-selected={otherSelected}
          className={[
            'provider-dialog-option',
            'other',
            otherSelected ? 'selected' : '',
            OTHER_PROVIDER_ID === active ? 'active' : '',
          ]
            .filter(Boolean)
            .join(' ')}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onSelectOther(view.otherSlugPrefill ?? '')}
        >
          <span className="provider-dialog-option-label">
            {t('providerDialog.otherProvider')}
          </span>
        </div>
      </div>
    </div>
  );
};
