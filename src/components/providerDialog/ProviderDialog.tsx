import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../i18n/useI18n';
import { useWorkspaceStore, type DefaultChange } from '../../store/workspaceStore';
import { CloseIcon } from '../Icons';
import { ModalDialog } from '../ModalDialog';
import { ModelPicker } from '../modelPicker/ModelPicker';
import {
  PRIMARY_CLASS,
  buildProviderRows,
  connectedProviderIds,
  derivePanelState,
  initialSelection,
  isValidSlug,
  pickFallbackDefault,
  primaryFor,
  type PanelIntent,
  type PanelState,
  type ProviderRow,
} from './providerDialogLogic';
import { OTHER_PROVIDER_ID, ProviderList } from './ProviderList';
import { ProviderPanel } from './ProviderPanel';

const TITLE_ID = 'provider-dialog-title';
const SUBTITLE_ID = 'provider-dialog-subtitle';
const DEFAULT_MODEL_LABEL_ID = 'provider-dialog-default-model';
const PI_MISSING_ID = 'provider-dialog-pi-missing';

/** Local request phase, on top of what the store's sign-in slice knows. */
type Busy = 'connecting' | 'disconnecting' | 'saving' | null;

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function errorDetail(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * App-level "Connect an AI provider" modal (`docs/specs/s3-provider-dialog.md`).
 * Renders nothing unless the store says it is open and not hidden for sign-in; the API key
 * lives only in this subtree's state, so closing the dialog always clears it.
 */
export const ProviderDialog: React.FC = () => {
  const open = useWorkspaceStore((s) => s.providerDialog.open);
  const hiddenForSignIn = useWorkspaceStore((s) => s.providerDialog.hiddenForSignIn);

  if (!open || hiddenForSignIn) return null;
  return <ProviderDialogBody />;
};

const ProviderDialogBody: React.FC = () => {
  const { t } = useI18n();

  const status = useWorkspaceStore((s) => s.piSetupStatus);
  const preselect = useWorkspaceStore((s) => s.providerDialog.preselect);
  const signIn = useWorkspaceStore((s) => s.providerSignIn);
  const modelCatalog = useWorkspaceStore((s) => s.modelCatalog);
  const modelCatalogLoading = useWorkspaceStore((s) => s.modelCatalogLoading);
  const modelCatalogError = useWorkspaceStore((s) => s.modelCatalogError);
  const loadModelCatalog = useWorkspaceStore((s) => s.loadModelCatalog);
  const closeProviderDialog = useWorkspaceStore((s) => s.closeProviderDialog);
  const connectPiProvider = useWorkspaceStore((s) => s.connectPiProvider);
  const disconnectPiProvider = useWorkspaceStore((s) => s.disconnectPiProvider);
  const startProviderSignIn = useWorkspaceStore((s) => s.startProviderSignIn);
  const checkProviderSignInNow = useWorkspaceStore((s) => s.checkProviderSignInNow);
  const cancelProviderSignIn = useWorkspaceStore((s) => s.cancelProviderSignIn);
  const hideProviderDialogForSignIn = useWorkspaceStore((s) => s.hideProviderDialogForSignIn);
  const skipPiSetup = useWorkspaceStore((s) => s.skipPiSetup);
  const saveDefaultModel = useWorkspaceStore((s) => s.saveDefaultModel);

  const rows = useMemo(() => (status ? buildProviderRows(status) : []), [status]);

  const preselectAtMount = useRef(preselect);
  const [selectedId, setSelectedId] = useState<string>(() => {
    if (!status) return OTHER_PROVIDER_ID;
    if (preselect && rows.some((row) => row.id === preselect)) return preselect;
    if (preselect) return OTHER_PROVIDER_ID;
    return initialSelection(status, null);
  });
  const [customSlug, setCustomSlug] = useState(() =>
    preselect && !rows.some((row) => row.id === preselect) ? preselect : ''
  );
  const [intent, setIntent] = useState<PanelIntent>('default');
  const [busy, setBusy] = useState<Busy>(null);
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [stagedDefault, setStagedDefault] = useState<{ provider: string; id: string } | null>(
    null
  );
  const [focusNonce, setFocusNonce] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);

  const busyRef = useRef(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const keyInputRef = useRef<HTMLInputElement>(null);
  const signInButtonRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const initialFocusRef = useRef<HTMLElement | null>(null);
  const lastPreselect = useRef(preselect);
  const previousPanel = useRef<PanelState | null>(null);

  const trimmedSlug = customSlug.trim();
  const isOther = selectedId === OTHER_PROVIDER_ID;
  const slugInvalid = isOther && trimmedSlug.length > 0 && !isValidSlug(trimmedSlug);
  const signInBlocked = isOther && !isValidSlug(trimmedSlug);

  const customRow: ProviderRow = useMemo(
    () => ({
      id: trimmedSlug,
      label: t('providerDialog.otherProviderTitle'),
      connected: false,
      kind: null,
      supportsKey: true,
      supportsSignIn: true,
      envVar: null,
      curated: false,
      suggestedModels: [],
    }),
    [t, trimmedSlug]
  );

  const row: ProviderRow | null = isOther
    ? customRow
    : rows.find((candidate) => candidate.id === selectedId) ?? rows[0] ?? null;

  const panelState: PanelState | null = row
    ? derivePanelState({
        row,
        intent,
        signIn: signIn ? { provider: signIn.provider, phase: signIn.phase } : null,
        busy: busy === 'saving' ? null : busy,
      })
    : null;

  // §6: a poll that finished in `invalid`/`error` leaves the sign-in detail in the store; the
  // panel keeps it visible when the user reveals the hidden dialog.
  const signInError =
    signIn && row && signIn.provider === row.id
      ? signIn.phase === 'invalid'
        ? t('providerDialog.errInvalid', { reason: signIn.detail ?? 'invalid' })
        : signIn.phase === 'error'
          ? t('providerDialog.errGeneric', { detail: signIn.detail ?? '' })
          : null
      : null;
  const visibleError = error ?? signInError;

  const primary = panelState ? primaryFor(panelState) : null;
  const doneIsPrimary = primary === 'done';
  const isBusy = busy !== null;
  const piMissingId = status && !status.pi_available ? PI_MISSING_ID : null;

  const connected = status ? connectedProviderIds(status) : [];
  const pickerValue =
    stagedDefault ??
    (status?.active_provider && status.active_model
      ? { provider: status.active_provider, id: status.active_model }
      : null);

  const connectDisabled =
    !row || !row.supportsKey || apiKey.trim().length === 0 || (isOther && !isValidSlug(trimmedSlug));

  const fallbackLine = useMemo(() => {
    if (!row || !status || status.active_provider !== row.id) return null;
    const fallback = pickFallbackDefault(row.id, rows, modelCatalog);
    if (!fallback) return t('providerDialog.confirmDefaultNone');
    const label =
      rows.find((candidate) => candidate.id === fallback.provider)?.label ?? fallback.provider;
    const model = fallback.model ? `${fallback.model} · ${label}` : label;
    return t('providerDialog.confirmDefaultFallback', { model });
  }, [modelCatalog, row, rows, status, t]);

  // §4.7: the catalog loads on open only when there is none yet. A dialog opened before the
  // first status read fetches it instead of rendering nothing.
  useEffect(() => {
    const state = useWorkspaceStore.getState();
    if (state.piSetupStatus === null) void state.refreshPiSetupStatus();
    if (state.modelCatalog === null) void state.loadModelCatalog();
  }, []);

  // §3.3: initial focus depends on how the dialog was opened, not on the first tabbable.
  useEffect(() => {
    const usingPreselect = preselectAtMount.current !== null;
    if (usingPreselect && (panelState === 'connected' || panelState === 'env')) {
      initialFocusRef.current = headingRef.current;
    } else if (usingPreselect && (panelState === 'key' || panelState === 'replace')) {
      initialFocusRef.current = keyInputRef.current ?? headingRef.current;
    } else if (
      usingPreselect &&
      (panelState === 'oauth' || panelState === 'timeout' || panelState === 'signInInvalid')
    ) {
      initialFocusRef.current = signInButtonRef.current ?? headingRef.current;
    } else if (usingPreselect && panelState === 'signInError') {
      initialFocusRef.current = headingRef.current;
    } else {
      initialFocusRef.current = searchRef.current ?? headingRef.current;
    }
    // Mount-only: later focus moves are explicit (row selection, connect success).
  }, []);

  useEffect(() => {
    if (focusNonce === 0) return;
    focusFirstInPanel();
  }, [focusNonce]);

  useEffect(() => {
    const previous = previousPanel.current;
    previousPanel.current = panelState;
    if (previous === null || previous === panelState) return;
    if (panelState === 'connected' || panelState === 'env') headingRef.current?.focus();
  }, [panelState]);

  // S-WAITING elapsed m:ss; the poller owns no UI timer.
  useEffect(() => {
    if (panelState !== 'waiting') return;
    const startedAt = useWorkspaceStore.getState().providerSignIn?.startedAt ?? Date.now();
    setElapsedMs(Date.now() - startedAt);
    const handle = setInterval(() => {
      setElapsedMs(Date.now() - startedAt);
    }, 1000);
    return () => clearInterval(handle);
  }, [panelState, signIn?.startedAt]);

  // A newer preselect while the dialog is already open (e.g. Settings then picker) moves the row.
  useEffect(() => {
    if (preselect === lastPreselect.current) return;
    lastPreselect.current = preselect;
    if (!preselect) return;
    if (rows.some((row) => row.id === preselect)) {
      setSelectedId(preselect);
      setCustomSlug('');
    } else {
      setSelectedId(OTHER_PROVIDER_ID);
      setCustomSlug(preselect);
    }
    setApiKey('');
    setError(null);
    setIntent('default');
  }, [preselect, rows]);

  // A custom slug that later becomes a real row resolves to that row: sign-in reopens the dialog
  // with the slug as preselect before `refreshPiSetupStatus` has added it, so on mount it is still
  // the "Other" pseudo row and only `rows` changes when the refresh lands.
  useEffect(() => {
    if (!isOther || !trimmedSlug) return;
    if (!rows.some((candidate) => candidate.id === trimmedSlug)) return;
    setSelectedId(trimmedSlug);
    setCustomSlug('');
  }, [isOther, rows, trimmedSlug]);

  // Disconnecting a non-curated provider removes its row: keep the selection meaningful by
  // switching to Other with that slug instead of silently showing the first curated provider.
  useEffect(() => {
    if (selectedId === OTHER_PROVIDER_ID) return;
    if (rows.some((candidate) => candidate.id === selectedId)) return;
    setSelectedId(OTHER_PROVIDER_ID);
    setCustomSlug(selectedId);
    setApiKey('');
    setError(null);
    setIntent('default');
  }, [rows, selectedId]);

  /** N3: the provider is part of the note even when pi will choose the model. */
  function describeDefaultChange(change: DefaultChange): string {
    const current = useWorkspaceStore.getState().piSetupStatus;
    const freshRows = current ? buildProviderRows(current) : rows;
    const label =
      freshRows.find((candidate) => candidate.id === change.provider)?.label ?? change.provider;
    return change.model ? `${change.model} · ${label}` : label;
  }

  function focusFirstInPanel() {
    const heading = headingRef.current;
    const target = heading?.parentElement?.querySelector<HTMLElement>('[data-panel-focus]');
    (target ?? heading)?.focus();
  }

  function selectRow(id: string) {
    if (signIn && signIn.phase === 'waiting' && signIn.provider !== id) {
      // Only one sign-in poll at a time: changing provider stops it without asking anything.
      cancelProviderSignIn();
    }
    setSelectedId(id);
    setApiKey('');
    setError(null);
    setNote(null);
    setIntent('default');
    setFocusNonce((nonce) => nonce + 1);
  }

  function selectOther(slugPrefill: string) {
    if (signIn && signIn.phase === 'waiting') cancelProviderSignIn();
    setCustomSlug(slugPrefill);
    setSelectedId(OTHER_PROVIDER_ID);
    setApiKey('');
    setError(null);
    setNote(null);
    setIntent('default');
    setFocusNonce((nonce) => nonce + 1);
  }

  function handleSlugChange(value: string) {
    const candidate = value.trim();
    if (candidate && rows.some((row) => row.id === candidate)) {
      // A slug equal to a curated id selects that curated row instead of a custom one.
      selectRow(candidate);
      setCustomSlug('');
      return;
    }
    setCustomSlug(value);
  }

  function handleClose() {
    setApiKey('');
    closeProviderDialog();
  }

  /**
   * Switching to a key or to a fresh sign-in must drop a finished sign-in (`timeout`/`invalid`/
   * `error`), otherwise `derivePanelState` keeps returning the S-ERROR state and its banner.
   * A `waiting` poll is left alone here: switching intent never stops a live poll.
   */
  function cancelFinishedSignIn() {
    if (signIn && row && signIn.provider === row.id && signIn.phase !== 'waiting') {
      cancelProviderSignIn();
    }
  }

  /** §4.3 step 3: a successful custom-slug connect selects the row the refreshed status added. */
  function resolveCustomRow(provider: string) {
    const fresh = useWorkspaceStore.getState().piSetupStatus;
    const freshRows = fresh ? buildProviderRows(fresh) : [];
    if (!freshRows.some((candidate) => candidate.id === provider)) return;
    setSelectedId(provider);
    setCustomSlug('');
  }

  /** §4.3: save the key, then react to `ready` / `invalid` / `not_ready` / pi missing. */
  async function runConnect(): Promise<boolean> {
    if (!row) return false;
    const provider = row.id;
    const key = apiKey.trim();
    if (!provider || !key || (isOther && !isValidSlug(provider))) return false;

    setBusy('connecting');
    setError(null);
    setNote(null);
    try {
      const { result, defaultChangedTo } = await connectPiProvider(provider, key);
      const check = result.check;
      const defaultNote = defaultChangedTo
        ? t('providerDialog.defaultChanged', { model: describeDefaultChange(defaultChangedTo) })
        : null;
      const notes = (...parts: Array<string | null>): string | null =>
        parts.filter(Boolean).join(' ') || null;
      const providerLabel = (() => {
        const current = useWorkspaceStore.getState().piSetupStatus;
        const freshRows = current ? buildProviderRows(current) : rows;
        return freshRows.find((candidate) => candidate.id === provider)?.label ?? provider;
      })();

      // N5: the backend keeps the key on `not_ready` and on `check_error`, so both are
      // connected with a warning. The key field is cleared in every one of those outcomes.
      if (result.check_error !== null) {
        setApiKey('');
        setIntent('default');
        if (isOther) resolveCustomRow(provider);
        setNote(notes(t('providerDialog.savedUnchecked'), defaultNote));
        return true;
      }
      if (check === null) {
        setApiKey('');
        setIntent('default');
        if (isOther) resolveCustomRow(provider);
        setNote(notes(t('providerDialog.savedUnchecked'), defaultNote));
        return true;
      }
      if (check.status === 'ready' || check.status === 'not_ready') {
        setApiKey('');
        setIntent('default');
        if (isOther) resolveCustomRow(provider);
        setNote(
          notes(
            check.status === 'not_ready'
              ? t('providerDialog.errNotReady', {
                  provider: providerLabel,
                  reason: check.reason ?? check.status,
                })
              : null,
            defaultNote
          )
        );
        return true;
      }
      if (check.status === 'invalid') {
        setError(
          t('providerDialog.errInvalid', { reason: check.reason ?? check.status })
        );
        return false;
      }
      setError(
        t('providerDialog.errNotReady', {
          provider: providerLabel,
          reason: check.reason ?? check.status,
        })
      );
      return false;
    } catch (err) {
      setError(t('providerDialog.errGeneric', { detail: errorDetail(err) }));
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function handleConnect() {
    if (busyRef.current || connectDisabled) return;
    busyRef.current = true;
    try {
      await runConnect();
    } finally {
      busyRef.current = false;
    }
  }

  async function handleDone() {
    if (busyRef.current || !row) return;
    busyRef.current = true;
    try {
      if ((panelState === 'key' || panelState === 'replace') && apiKey.trim().length > 0) {
        // Footer rule 1: a typed, unsaved key is connected before leaving, and a failure keeps
        // the dialog open with the key still in the field.
        const ok = await runConnect();
        if (!ok) return;
      }

      const current = useWorkspaceStore.getState().piSetupStatus;
      const staged = stagedDefault;
      // N6: an env-only provider can have no `active_model`; Done still completes the setup and
      // lets `saveDefaultModel` fall back to `active_provider` with a null model.
      const firstRunDefault =
        staged === null &&
        current !== null &&
        !current.first_run_completed &&
        current.active_provider !== null;
      const changed =
        staged !== null &&
        current !== null &&
        (!current.first_run_completed ||
          staged.provider !== current.active_provider ||
          staged.id !== current.active_model);

      if (staged !== null && changed) {
        setBusy('saving');
        await saveDefaultModel(staged, true);
      } else if (firstRunDefault && current) {
        const selection =
          current.active_model !== null
            ? { provider: current.active_provider as string, id: current.active_model }
            : null;
        setBusy('saving');
        await saveDefaultModel(selection, true);
      }

      handleClose();
    } catch (err) {
      setError(t('providerDialog.errGeneric', { detail: errorDetail(err) }));
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  }

  async function handleUseOffline() {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      await skipPiSetup();
    } catch (err) {
      setError(t('providerDialog.errGeneric', { detail: errorDetail(err) }));
    } finally {
      busyRef.current = false;
    }
  }

  function handleStartSignIn() {
    if (!row || busyRef.current || signInBlocked) return;
    setError(null);
    setIntent('useSignIn');
    startRowSignIn();
  }

  /**
   * An already-connected provider is a re-sign-in: the old credential still answers `ready`, so
   * the flow stays manual (I3). The sign-in state keeps that mode when the login is restarted.
   */
  function startRowSignIn() {
    if (!row) return;
    const manual =
      row.connected || (signIn?.provider === row.id && signIn.manualOnly === true);
    startProviderSignIn(
      row.id,
      manual ? { manualOnly: true, refetchCatalogOnReady: true } : undefined
    );
  }

  function handleReopenTerminal() {
    if (!row || busyRef.current || signInBlocked) return;
    setError(null);
    setIntent('useSignIn');
    startRowSignIn();
  }

  function handleSignInAgain() {
    if (!row || busyRef.current || signInBlocked) return;
    setError(null);
    // The provider set is unchanged, but the model set can depend on the plan (§4.7): the store
    // refetches the catalog when the poll confirms the new login, not now (the key is still old).
    startProviderSignIn(row.id, { refetchCatalogOnReady: true, manualOnly: true });
  }

  async function handleConfirmDisconnect() {
    if (!row || busyRef.current) return;
    busyRef.current = true;
    setBusy('disconnecting');
    setError(null);
    try {
      const { defaultChangedTo, stillViaEnv } = await disconnectPiProvider(row.id);
      setIntent('default');
      const baseNote = stillViaEnv
        ? t('providerDialog.stillViaEnv', {
            provider: row.label,
            envVar: row.envVar ?? '',
          })
        : t('providerDialog.disconnected', { provider: row.label });
      // §4.5: both facts matter, so the default-changed line is added on top of the base note.
      setNote(
        defaultChangedTo
          ? `${baseNote} ${t('providerDialog.defaultChanged', {
              model: describeDefaultChange(defaultChangedTo),
            })}`
          : baseNote
      );
    } catch (err) {
      // Keep the confirmation box open so Disconnect can be retried.
      setError(t('providerDialog.errGeneric', { detail: errorDetail(err) }));
    } finally {
      setBusy(null);
      busyRef.current = false;
    }
  }

  function handleModelChange(selection: { provider: string | null; id: string }) {
    if (!selection.provider) return;
    setStagedDefault({ provider: selection.provider, id: selection.id });
  }

  function handlePickerConnect(providerId: string) {
    if (rows.some((row) => row.id === providerId)) selectRow(providerId);
    else selectOther(providerId);
  }

  if (!status || !row || !panelState) return null;

  return (
    <ModalDialog
      titleId={TITLE_ID}
      descriptionId={SUBTITLE_ID}
      onClose={handleClose}
      busy={isBusy}
      initialFocus={initialFocusRef}
      className="provider-dialog"
    >
      <div className="provider-dialog-header">
        <div className="provider-dialog-heading-group">
          <h2 id={TITLE_ID} className="provider-dialog-title">
            {t('providerDialog.title')}
          </h2>
          <p id={SUBTITLE_ID} className="provider-dialog-subtitle">
            {t('providerDialog.subtitle')}
          </p>
        </div>
        <button
          type="button"
          className="btn-icon-xs"
          aria-label={t('providerDialog.close')}
          title={t('providerDialog.close')}
          disabled={isBusy}
          onClick={handleClose}
        >
          <CloseIcon size={13} />
        </button>
      </div>

      <div className="provider-dialog-body">
        {piMissingId && (
          <div id={PI_MISSING_ID} className="banner-warning">
            {t('providerDialog.piMissing')}
          </div>
        )}

        <ProviderList
          rows={rows}
          selectedId={selectedId}
          searchRef={searchRef}
          onSelect={selectRow}
          onSelectOther={selectOther}
        />

        <ProviderPanel
          state={panelState}
          row={row}
          isCustom={isOther}
          slug={customSlug}
          onSlugChange={handleSlugChange}
          slugInvalid={slugInvalid}
          apiKey={apiKey}
          onApiKeyChange={setApiKey}
          elapsed={formatElapsed(elapsedMs)}
          error={visibleError}
          note={note}
          piMissingId={piMissingId}
          signInBlocked={signInBlocked}
          fallbackLine={fallbackLine}
          headingRef={headingRef}
          keyInputRef={keyInputRef}
          signInButtonRef={signInButtonRef}
          connectDisabled={connectDisabled}
          onConnect={() => void handleConnect()}
          onReplaceKey={() => {
            setError(null);
            setNote(null);
            setIntent('replace');
          }}
          onSignIn={handleStartSignIn}
          onSignInAgain={handleSignInAgain}
          onUseKey={() => {
            cancelFinishedSignIn();
            setError(null);
            setIntent('useKey');
          }}
          onUseSignIn={() => {
            cancelFinishedSignIn();
            setError(null);
            setIntent('useSignIn');
          }}
          onCheckNow={() => {
            setError(null);
            setIntent('default');
            checkProviderSignInNow();
          }}
          onShowTerminal={hideProviderDialogForSignIn}
          onReopenTerminal={handleReopenTerminal}
          onCancelSignIn={() => {
            cancelProviderSignIn();
            setIntent('useSignIn');
          }}
          onCancelReplace={() => {
            setError(null);
            setIntent('default');
          }}
          onDisconnect={() => {
            setError(null);
            setIntent('confirm');
          }}
          onCancelConfirm={() => {
            setError(null);
            setIntent('default');
          }}
          onConfirmDisconnect={() => void handleConfirmDisconnect()}
        />

        <div className="provider-dialog-default-model">
          <span id={DEFAULT_MODEL_LABEL_ID} className="provider-dialog-label">
            {t('providerDialog.defaultModelLabel')}
          </span>
          {connected.length > 0 ? (
            <ModelPicker
              labelId={DEFAULT_MODEL_LABEL_ID}
              catalog={modelCatalog}
              loading={modelCatalogLoading}
              error={modelCatalogError}
              providers={status.providers}
              connectedProviders={connected}
              selectableProvider={null}
              value={pickerValue}
              onChange={handleModelChange}
              onRetry={() => void loadModelCatalog()}
              onConnectProvider={handlePickerConnect}
            />
          ) : (
            <button
              type="button"
              className="model-picker-trigger placeholder"
              disabled
              aria-describedby={DEFAULT_MODEL_LABEL_ID}
            >
              <span className="model-picker-trigger-text">
                {t('providerDialog.defaultModelLocked')}
              </span>
              <span className="model-picker-caret" aria-hidden="true">
                ▾
              </span>
            </button>
          )}
        </div>
      </div>

      <div className="provider-dialog-footer">
        {!status.first_run_completed && (
          <button
            type="button"
            className="btn-ghost-xs"
            disabled={isBusy}
            onClick={() => void handleUseOffline()}
          >
            {t('providerDialog.useOffline')}
          </button>
        )}
        <span className="provider-dialog-footer-spacer" />
        <button
          type="button"
          className={doneIsPrimary ? PRIMARY_CLASS : 'btn-ghost-xs'}
          disabled={isBusy}
          onClick={() => void handleDone()}
        >
          {busy === 'saving' ? t('providerDialog.saving') : t('providerDialog.done')}
        </button>
      </div>
    </ModalDialog>
  );
};
