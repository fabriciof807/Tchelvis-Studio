import React, { useEffect, useMemo, useState } from 'react';
import { ipc } from '../types/ipc';
import { useWorkspaceStore } from '../store/workspaceStore';
import { useI18n } from '../i18n/useI18n';
import { CloseIcon } from './Icons';
import { ModelPicker } from './modelPicker/ModelPicker';

const CUSTOM_PROVIDER_VALUE = '__custom__';

export const PiSetupWizard: React.FC = () => {
  const { t } = useI18n();
  const piSetupStatus = useWorkspaceStore((s) => s.piSetupStatus);
  const configurePiProvider = useWorkspaceStore((s) => s.configurePiProvider);
  const logoutPiProvider = useWorkspaceStore((s) => s.logoutPiProvider);
  const skipPiSetup = useWorkspaceStore((s) => s.skipPiSetup);
  const refreshPiSetupStatus = useWorkspaceStore((s) => s.refreshPiSetupStatus);
  const launchPiInteractiveLogin = useWorkspaceStore((s) => s.launchPiInteractiveLogin);
  const setPiSetupOpen = useWorkspaceStore((s) => s.setPiSetupOpen);
  const modelCatalog = useWorkspaceStore((s) => s.modelCatalog);
  const modelCatalogLoading = useWorkspaceStore((s) => s.modelCatalogLoading);
  const modelCatalogError = useWorkspaceStore((s) => s.modelCatalogError);
  const loadModelCatalog = useWorkspaceStore((s) => s.loadModelCatalog);

  const providers = piSetupStatus?.providers ?? [];
  const defaultProviderId =
    piSetupStatus?.active_provider ?? providers[0]?.id ?? 'opencode-go';

  const [selectedOption, setSelectedOption] = useState<string>(defaultProviderId);
  const [customProvider, setCustomProvider] = useState('');
  const [authTab, setAuthTab] = useState<'api_key' | 'oauth'>('api_key');
  const [apiKey, setApiKey] = useState('');
  const [modelInput, setModelInput] = useState(piSetupStatus?.active_model ?? '');
  const [busy, setBusy] = useState(false);
  const [checkingAuth, setCheckingAuth] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const effectiveProvider =
    selectedOption === CUSTOM_PROVIDER_VALUE ? customProvider.trim() : selectedOption;

  const selectedEntry = useMemo(
    () => providers.find((p) => p.id === effectiveProvider) ?? null,
    [providers, effectiveProvider]
  );

  useEffect(() => {
    if (!piSetupStatus) return;
    if (piSetupStatus.active_provider) {
      const known = piSetupStatus.providers.some((p) => p.id === piSetupStatus.active_provider);
      if (known) {
        setSelectedOption(piSetupStatus.active_provider);
      } else {
        setSelectedOption(CUSTOM_PROVIDER_VALUE);
        setCustomProvider(piSetupStatus.active_provider);
      }
    }
    if (piSetupStatus.active_model) {
      setModelInput(piSetupStatus.active_model);
    }
  }, [piSetupStatus?.active_provider, piSetupStatus?.active_model]);

  useEffect(() => {
    if (!selectedEntry) return;
    if (!selectedEntry.supports_api_key && selectedEntry.supports_oauth) {
      setAuthTab('oauth');
    } else if (selectedEntry.supports_api_key && !selectedEntry.supports_oauth) {
      setAuthTab('api_key');
    }
    if (!modelInput && selectedEntry.suggested_models.length > 0) {
      setModelInput(selectedEntry.suggested_models[0]);
    }
  }, [selectedEntry]);

  useEffect(() => {
    void loadModelCatalog();
  }, [loadModelCatalog]);

  if (!piSetupStatus) return null;

  const handleProviderChange = (val: string) => {
    setSelectedOption(val);
    setFeedback(null);
    if (val !== CUSTOM_PROVIDER_VALUE) {
      const entry = providers.find((p) => p.id === val);
      if (entry && entry.suggested_models.length > 0) {
        setModelInput(entry.suggested_models[0]);
      }
    }
  };

  const handleModelChange = (selection: { provider: string | null; id: string }) => {
    setModelInput(selection.id);
    setFeedback(null);
    // The default model belongs to one provider, so picking another provider's model selects that provider.
    if (selection.provider && selection.provider !== effectiveProvider) {
      if (providers.some((p) => p.id === selection.provider)) {
        setSelectedOption(selection.provider);
      } else {
        setSelectedOption(CUSTOM_PROVIDER_VALUE);
        setCustomProvider(selection.provider);
      }
    }
  };

  const handleConnectProvider = (providerId: string) => {
    if (providers.some((p) => p.id === providerId)) {
      handleProviderChange(providerId);
    } else {
      // Not in the curated list (e.g. found in pi's models store): configure it as a custom slug.
      setSelectedOption(CUSTOM_PROVIDER_VALUE);
      setCustomProvider(providerId);
      setFeedback(null);
    }
  };

  const handleSaveKeyAndConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!effectiveProvider) return;
    setBusy(true);
    setFeedback(null);
    try {
      await configurePiProvider({
        provider: effectiveProvider,
        model: modelInput.trim() || null,
        api_key: apiKey.trim() || null,
        mark_completed: true,
      });
      setApiKey('');
    } catch (err) {
      setFeedback({
        kind: 'err',
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  const handleUseDetected = async () => {
    if (!piSetupStatus.active_provider) return;
    setBusy(true);
    setFeedback(null);
    try {
      await configurePiProvider({
        provider: piSetupStatus.active_provider,
        model: piSetupStatus.active_model ?? (modelInput.trim() || null),
        mark_completed: true,
      });
    } catch (err) {
      setFeedback({
        kind: 'err',
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  const handleVerifyAuth = async () => {
    if (!effectiveProvider) return;
    setCheckingAuth(true);
    setFeedback(null);
    try {
      const res = await ipc.piCheckProvider(effectiveProvider);
      await refreshPiSetupStatus();
      if (res.status === 'ready') {
        setFeedback({
          kind: 'ok',
          text: t('piSetup.authReadyMsg', { provider: effectiveProvider }),
        });
      } else {
        setFeedback({
          kind: 'err',
          text: t('piSetup.authNotReadyMsg', {
            provider: effectiveProvider,
            reason: res.reason ?? 'not_ready',
          }),
        });
      }
    } catch (err) {
      setFeedback({
        kind: 'err',
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setCheckingAuth(false);
    }
  };

  const handleLogout = async () => {
    if (!effectiveProvider) return;
    setBusy(true);
    setFeedback(null);
    try {
      await logoutPiProvider(effectiveProvider);
    } catch (err) {
      setFeedback({
        kind: 'err',
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  const handleSkipOffline = async () => {
    setBusy(true);
    setFeedback(null);
    try {
      await skipPiSetup();
    } catch (err) {
      setFeedback({
        kind: 'err',
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pi-setup-card" role="region" aria-label={t('piSetup.title')}>
      <div className="pi-setup-header">
        <div>
          <div className="pi-setup-title">{t('piSetup.title')}</div>
          <div className="pi-setup-subtitle">{t('piSetup.subtitle')}</div>
        </div>
        {piSetupStatus.first_run_completed && (
          <button
            type="button"
            className="btn-icon-xs"
            onClick={() => setPiSetupOpen(false)}
            title={t('piSetup.closeBtn')}
            aria-label={t('piSetup.closeBtn')}
          >
            <CloseIcon size={13} />
          </button>
        )}
      </div>

      {!piSetupStatus.pi_available && (
        <div className="banner-warning">{t('piSetup.piMissingHint')}</div>
      )}

      {piSetupStatus.provider_ready &&
        !piSetupStatus.first_run_completed &&
        piSetupStatus.active_provider && (
          <div className="pi-setup-detected-banner">
            <span>
              {t('piSetup.readyBanner', { provider: piSetupStatus.active_provider })}
            </span>
            <button
              type="button"
              className="btn-primary-xs"
              disabled={busy}
              onClick={() => void handleUseDetected()}
            >
              {t('piSetup.useDetectedBtn', { provider: piSetupStatus.active_provider })}
            </button>
          </div>
        )}

      <form className="pi-setup-form" onSubmit={(e) => void handleSaveKeyAndConnect(e)}>
        <div className="pi-setup-field">
          <label className="pi-setup-label" htmlFor="pi-provider-select">
            {t('piSetup.providerLabel')}
          </label>
          <select
            id="pi-provider-select"
            className="select-sm pi-setup-select"
            value={selectedOption}
            onChange={(e) => handleProviderChange(e.target.value)}
          >
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
                {p.configured ? ` (${t('piSetup.configuredBadge')})` : ''}
              </option>
            ))}
            <option value={CUSTOM_PROVIDER_VALUE}>{t('piSetup.customProviderOption')}</option>
          </select>

          {selectedOption === CUSTOM_PROVIDER_VALUE && (
            <input
              type="text"
              className="pi-setup-input"
              value={customProvider}
              onChange={(e) => setCustomProvider(e.target.value)}
              placeholder={t('piSetup.customProviderPlaceholder')}
            />
          )}

          {selectedEntry && (
            <div className="pi-setup-badges">
              {selectedEntry.supports_api_key && (
                <span className="pi-capability-badge">API Key</span>
              )}
              {selectedEntry.supports_oauth && (
                <span className="pi-capability-badge">OAuth</span>
              )}
              {selectedEntry.configured && (
                <span className="pi-capability-badge configured">
                  {t('piSetup.configuredBadge')}
                  {selectedEntry.auth_type ? ` (${selectedEntry.auth_type})` : ''}
                </span>
              )}
            </div>
          )}
        </div>

        <div className="pi-auth-tabs" role="tablist">
          {(!selectedEntry || selectedEntry.supports_api_key) && (
            <button
              type="button"
              role="tab"
              aria-selected={authTab === 'api_key'}
              className={`pi-auth-tab ${authTab === 'api_key' ? 'active' : ''}`}
              onClick={() => setAuthTab('api_key')}
            >
              {t('piSetup.authApiKeyTab')}
            </button>
          )}
          {(!selectedEntry || selectedEntry.supports_oauth) && (
            <button
              type="button"
              role="tab"
              aria-selected={authTab === 'oauth'}
              className={`pi-auth-tab ${authTab === 'oauth' ? 'active' : ''}`}
              onClick={() => setAuthTab('oauth')}
            >
              {t('piSetup.authOAuthTab')}
            </button>
          )}
        </div>

        {authTab === 'api_key' ? (
          <div className="pi-setup-field">
            <label className="pi-setup-label" htmlFor="pi-api-key-input">
              {t('piSetup.apiKeyLabel')}
            </label>
            <div className="pi-setup-key-row">
              <input
                id="pi-api-key-input"
                type="password"
                autoComplete="off"
                className="pi-setup-input"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={
                  selectedEntry?.env_var_hint
                    ? `${selectedEntry.env_var_hint} ...`
                    : t('piSetup.apiKeyPlaceholder')
                }
              />
              <button
                type="submit"
                className="btn-primary-xs"
                disabled={busy || !effectiveProvider}
              >
                {t('piSetup.saveKeyBtn')}
              </button>
            </div>
          </div>
        ) : (
          <div className="pi-setup-oauth-box">
            <p className="muted-text">{t('piSetup.oauthHint')}</p>
            <div className="pi-setup-oauth-actions">
              <button
                type="button"
                className="btn-primary-xs"
                disabled={!effectiveProvider}
                onClick={() => launchPiInteractiveLogin(effectiveProvider)}
              >
                {t('piSetup.openTerminalLoginBtn')}
              </button>
              <button
                type="button"
                className="btn-ghost-xs"
                disabled={checkingAuth || !effectiveProvider}
                onClick={() => void handleVerifyAuth()}
              >
                {checkingAuth ? t('piSetup.checking') : t('piSetup.verifyAuthBtn')}
              </button>
            </div>
          </div>
        )}

        <div className="pi-setup-field">
          <span className="pi-setup-label" id="pi-model-label">
            {t('piSetup.modelLabel')}
          </span>
          <ModelPicker
            labelId="pi-model-label"
            catalog={modelCatalog}
            loading={modelCatalogLoading}
            error={modelCatalogError}
            providers={providers}
            connectedProviders={piSetupStatus.configured_providers}
            selectableProvider={effectiveProvider || null}
            value={modelInput.trim() ? { provider: effectiveProvider, id: modelInput.trim() } : null}
            onChange={handleModelChange}
            onRetry={() => void loadModelCatalog()}
            onConnectProvider={handleConnectProvider}
          />
        </div>

        {feedback && (
          <div className={feedback.kind === 'ok' ? 'banner-info' : 'banner-error'}>
            {feedback.text}
          </div>
        )}

        <div className="pi-setup-footer">
          <button
            type="submit"
            className="btn-primary-xs"
            disabled={busy || !effectiveProvider}
          >
            {t('piSetup.saveConnectBtn')}
          </button>
          <button
            type="button"
            className="btn-ghost-xs"
            disabled={busy}
            onClick={() => void handleSkipOffline()}
          >
            {t('piSetup.skipOfflineBtn')}
          </button>
          {selectedEntry?.configured && (
            <button
              type="button"
              className="btn-ghost-xs pi-logout-btn"
              disabled={busy}
              onClick={() => void handleLogout()}
            >
              {t('piSetup.logoutBtn')}
            </button>
          )}
        </div>
      </form>
    </div>
  );
};
