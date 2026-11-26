import React from 'react';
import { useI18n } from '../../i18n/useI18n';
import {
  DANGER_PRIMARY_CLASS,
  PRIMARY_CLASS,
  type PanelState,
  type ProviderRow,
} from './providerDialogLogic';

const KEY_FIELD_ID = 'provider-dialog-key';
const ENV_HELPER_ID = 'provider-dialog-env-helper';
const SLUG_FIELD_ID = 'provider-dialog-slug';
const SLUG_ERROR_ID = 'provider-dialog-slug-error';
const CONFIRM_TITLE_ID = 'provider-dialog-confirm-title';
const CONFIRM_BODY_ID = 'provider-dialog-confirm-body';

export interface ProviderPanelProps {
  state: PanelState;
  row: ProviderRow;
  /** The "Other provider (slug)…" pseudo row: shows the slug field above the key field. */
  isCustom: boolean;
  slug: string;
  onSlugChange: (value: string) => void;
  slugInvalid: boolean;
  apiKey: string;
  onApiKeyChange: (value: string) => void;
  /** S-WAITING elapsed time, already formatted as m:ss. */
  elapsed: string;
  error: string | null;
  note: string | null;
  /** Id of the pi-missing banner while it is visible; the Sign in button points at it. */
  piMissingId: string | null;
  /** True when a custom slug is empty or invalid: sign-in would send it to the terminal. */
  signInBlocked: boolean;
  /** S-CONFIRM extra line about the default provider, or null when it isn't the default. */
  fallbackLine: string | null;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  keyInputRef: React.RefObject<HTMLInputElement | null>;
  signInButtonRef: React.RefObject<HTMLButtonElement | null>;
  connectDisabled: boolean;
  onConnect: () => void;
  onReplaceKey: () => void;
  onSignIn: () => void;
  onSignInAgain: () => void;
  onUseKey: () => void;
  onUseSignIn: () => void;
  onCheckNow: () => void;
  /** Just hides the modal and reveals the terminal; it must not type the login again. */
  onShowTerminal: () => void;
  /** S-TIMEOUT / S-ERROR: re-runs `pi auth login` and restarts the (auto or manual) poll. */
  onReopenTerminal: () => void;
  onCancelSignIn: () => void;
  onCancelReplace: () => void;
  onDisconnect: () => void;
  onCancelConfirm: () => void;
  onConfirmDisconnect: () => void;
}

/**
 * Presentational provider panel: exactly one branch per `PanelState`, with the single primary
 * action of the dialog (`PRIMARY_CLASS`, or `DANGER_PRIMARY_CLASS` for the disconnect
 * confirmation). S-ERROR is an `error` string rendered on top of the current state.
 */
export const ProviderPanel: React.FC<ProviderPanelProps> = (props) => {
  const { t } = useI18n();
  const {
    state,
    row,
    isCustom,
    slug,
    onSlugChange,
    slugInvalid,
    apiKey,
    onApiKeyChange,
    elapsed,
    error,
    note,
    piMissingId,
    fallbackLine,
    headingRef,
    keyInputRef,
    signInButtonRef,
    connectDisabled,
  } = props;

  const statusLine =
    state === 'connected' || state === 'confirm' || state === 'disconnecting'
      ? row.kind === 'signed_in'
        ? t('providerDialog.statusSignedIn', { provider: row.label })
        : t('providerDialog.statusApiKey', { provider: row.label })
      : state === 'env'
        ? t('providerDialog.statusEnv', { provider: row.label, envVar: row.envVar ?? '' })
        : null;

  const headingText = statusLine ?? (isCustom ? t('providerDialog.otherProviderTitle') : row.label);
  const showKeyBlock = state === 'key' || state === 'replace' || state === 'connecting';
  const keyDisabled = state === 'connecting';
  // The env helper is hidden while connecting, so the description must not point at it then.
  const describedBy = row.envVar && !keyDisabled ? ENV_HELPER_ID : undefined;

  return (
    <section className="provider-dialog-panel" aria-label={row.label}>
      <h3 className="provider-dialog-panel-title" data-panel-heading tabIndex={-1} ref={headingRef}>
        {headingText}
      </h3>

      {statusLine && row.kind !== 'env' && (
        <p className="muted-text provider-dialog-panel-sub">{t('providerDialog.storedWhere')}</p>
      )}
      {state === 'env' && (
        <p className="muted-text provider-dialog-panel-sub">
          {t('providerDialog.envDisconnectNote')}
        </p>
      )}

      {error && (
        <div className="banner-error provider-dialog-error" role="alert">
          {error}
        </div>
      )}
      {note && (
        <div className="banner-info provider-dialog-note" role="status">
          {note}
        </div>
      )}

      {isCustom && (showKeyBlock || state === 'oauth') && (
        <div className="provider-dialog-field">
          <label className="provider-dialog-label" htmlFor={SLUG_FIELD_ID}>
            {t('providerDialog.slugLabel')}
          </label>
          <input
            id={SLUG_FIELD_ID}
            type="text"
            className="provider-dialog-input"
            value={slug}
            onChange={(event) => onSlugChange(event.target.value)}
            placeholder={t('providerDialog.slugPlaceholder')}
            autoComplete="off"
            spellCheck={false}
            data-panel-focus
            aria-invalid={slugInvalid || undefined}
            aria-describedby={slugInvalid ? SLUG_ERROR_ID : undefined}
          />
          {slugInvalid && (
            <p id={SLUG_ERROR_ID} className="provider-dialog-helper error" role="alert">
              {t('providerDialog.slugInvalid')}
            </p>
          )}
        </div>
      )}

      {showKeyBlock && (
        <div className="provider-dialog-field">
          <label className="provider-dialog-label" htmlFor={KEY_FIELD_ID}>
            {t('providerDialog.keyLabel')}
          </label>
          <input
            id={KEY_FIELD_ID}
            ref={keyInputRef}
            type="password"
            className="provider-dialog-input"
            value={apiKey}
            onChange={(event) => onApiKeyChange(event.target.value)}
            placeholder={t('providerDialog.keyPlaceholder')}
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="off"
            aria-describedby={describedBy}
            disabled={keyDisabled}
            data-panel-focus
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              if (!connectDisabled) props.onConnect();
            }}
          />
          {row.envVar && !keyDisabled && (
            <p id={ENV_HELPER_ID} className="provider-dialog-helper">
              {t('providerDialog.envHelper', { envVar: row.envVar })}
            </p>
          )}
        </div>
      )}

      {(state === 'oauth' || state === 'signInInvalid') && (
        <p className="muted-text provider-dialog-hint">
          {t('providerDialog.signInHint', { command: `pi auth login ${row.id}` })}
        </p>
      )}

      {(state === 'waiting' || state === 'timeout') && (
        <p className="provider-dialog-status" role="status">
          {state === 'waiting'
            ? t('providerDialog.waiting', { elapsed })
            : t('providerDialog.signInTimeout')}
        </p>
      )}

      {state === 'connecting' && (
        <p className="provider-dialog-status" role="status">
          {t('providerDialog.checking')}
        </p>
      )}

      {state === 'confirm' || state === 'disconnecting' ? (
        <div
          className="provider-dialog-confirm"
          role="alertdialog"
          aria-labelledby={CONFIRM_TITLE_ID}
          aria-describedby={CONFIRM_BODY_ID}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            // The confirmation is an inner layer: `Esc` cancels it and never closes the dialog.
            event.preventDefault();
            event.stopPropagation();
            if (state === 'disconnecting') return;
            props.onCancelConfirm();
          }}
        >
          <h4 id={CONFIRM_TITLE_ID} className="provider-dialog-confirm-title">
            {t('providerDialog.confirmTitle', { provider: row.label })}
          </h4>
          <p id={CONFIRM_BODY_ID}>{t('providerDialog.confirmBody')}</p>
          {fallbackLine && <p>{fallbackLine}</p>}
          <div className="provider-dialog-actions">
            <button
              type="button"
              className="btn-ghost-xs"
              disabled={state === 'disconnecting'}
              onClick={props.onCancelConfirm}
              data-panel-focus
            >
              {t('providerDialog.cancel')}
            </button>
            <button
              type="button"
              className={DANGER_PRIMARY_CLASS}
              disabled={state === 'disconnecting'}
              onClick={props.onConfirmDisconnect}
            >
              {state === 'disconnecting'
                ? t('providerDialog.disconnecting')
                : t('providerDialog.confirmDisconnect')}
            </button>
          </div>
        </div>
      ) : (
        <div className="provider-dialog-actions">
          {state === 'key' && (
            <button
              type="button"
              className={PRIMARY_CLASS}
              disabled={connectDisabled}
              onClick={props.onConnect}
            >
              {t('providerDialog.connect')}
            </button>
          )}

          {state === 'replace' && (
            <button
              type="button"
              className={PRIMARY_CLASS}
              disabled={connectDisabled}
              onClick={props.onConnect}
            >
              {t('providerDialog.saveKey')}
            </button>
          )}

          {state === 'connecting' && (
            <button type="button" className={PRIMARY_CLASS} disabled>
              {t('providerDialog.connecting')}
            </button>
          )}

          {(state === 'oauth' || state === 'signInInvalid') && (
            <button
              type="button"
              ref={signInButtonRef}
              className={PRIMARY_CLASS}
              disabled={piMissingId !== null || props.signInBlocked}
              aria-describedby={piMissingId ?? undefined}
              onClick={props.onSignIn}
              data-panel-focus
            >
              {t('providerDialog.signIn')}
            </button>
          )}

          {state === 'waiting' && (
            <>
              <button type="button" className={PRIMARY_CLASS} disabled>
                {t('providerDialog.waitingBtn')}
              </button>
              <button type="button" className="btn-ghost-xs" onClick={props.onCheckNow}>
                {t('providerDialog.checkNow')}
              </button>
              <button
                type="button"
                className="btn-ghost-xs"
                onClick={props.onShowTerminal}
                data-panel-focus
              >
                {t('providerDialog.showTerminal')}
              </button>
              <button type="button" className="btn-ghost-xs" onClick={props.onCancelSignIn}>
                {t('providerDialog.cancelSignIn')}
              </button>
            </>
          )}

          {state === 'timeout' && (
            <>
              <button
                type="button"
                className={PRIMARY_CLASS}
                onClick={props.onCheckNow}
                data-panel-focus
              >
                {t('providerDialog.checkAgain')}
              </button>
              <button type="button" className="btn-ghost-xs" onClick={props.onReopenTerminal}>
                {t('providerDialog.reopenTerminal')}
              </button>
            </>
          )}

          {state === 'signInError' && (
            <>
              <button
                type="button"
                className={PRIMARY_CLASS}
                onClick={props.onCheckNow}
                data-panel-focus
              >
                {t('providerDialog.checkAgain')}
              </button>
              <button type="button" className="btn-ghost-xs" onClick={props.onReopenTerminal}>
                {t('providerDialog.reopenTerminal')}
              </button>
            </>
          )}

          {(state === 'key' || state === 'timeout') && row.supportsSignIn && (
            <button type="button" className="btn-ghost-xs" onClick={props.onUseSignIn}>
              {t('providerDialog.useSignIn')}
            </button>
          )}

          {(state === 'oauth' || state === 'timeout' || state === 'signInInvalid' || state === 'signInError') &&
            row.supportsKey && (
            <button type="button" className="btn-ghost-xs" onClick={props.onUseKey}>
              {t('providerDialog.useKey')}
            </button>
          )}

          {state === 'replace' && (
            <button type="button" className="btn-ghost-xs" onClick={props.onCancelReplace}>
              {t('providerDialog.cancel')}
            </button>
          )}

          {state === 'env' && (
            <button type="button" className="btn-ghost-xs" onClick={props.onReplaceKey}>
              {t('providerDialog.saveKeyInstead')}
            </button>
          )}

          {state === 'connected' && (
            <>
              {(row.kind === 'api_key' || !row.curated) && (
                <button type="button" className="btn-ghost-xs" onClick={props.onReplaceKey}>
                  {t('providerDialog.replaceKey')}
                </button>
              )}
              {(row.kind === 'signed_in' || !row.curated) && (
                <button type="button" className="btn-ghost-xs" onClick={props.onSignInAgain}>
                  {t('providerDialog.signInAgain')}
                </button>
              )}
              <button
                type="button"
                className="btn-ghost-xs provider-dialog-disconnect"
                onClick={props.onDisconnect}
              >
                {t('providerDialog.disconnect')}
              </button>
            </>
          )}
        </div>
      )}
    </section>
  );
};
