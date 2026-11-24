import React, { useEffect, useState } from 'react';
import {
  ipc,
  type UpdateApplyResult,
  type UpdateChannel,
  type UpdateCheckResult,
} from '../types/ipc';
import { useWorkspaceStore } from '../store/workspaceStore';
import { LOCALE_OPTIONS, type Locale } from '../i18n';
import { useI18n } from '../i18n/useI18n';
import { THEME_OPTIONS } from '../themes';
import {
  AlertCircleIcon,
  CheckCircleIcon,
  CloseIcon,
  DownloadIcon,
  GlobeIcon,
  PaletteIcon,
  RefreshIcon,
  SettingsIcon,
} from './Icons';

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({ open, onClose }) => {
  const { locale, setLocale, t } = useI18n();
  const incrementModalCount = useWorkspaceStore((s) => s.incrementModalCount);
  const decrementModalCount = useWorkspaceStore((s) => s.decrementModalCount);
  const updateChannel = useWorkspaceStore((s) => s.updateChannel);
  const setUpdateChannel = useWorkspaceStore((s) => s.setUpdateChannel);
  const theme = useWorkspaceStore((s) => s.theme);
  const setTheme = useWorkspaceStore((s) => s.setTheme);

  const [checking, setChecking] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [confirmingRestart, setConfirmingRestart] = useState(false);
  const [checkResult, setCheckResult] = useState<UpdateCheckResult | null>(null);
  const [applyResult, setApplyResult] = useState<UpdateApplyResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    incrementModalCount();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      decrementModalCount();
    };
  }, [open, onClose, incrementModalCount, decrementModalCount]);

  if (!open) return null;

  const runCheckForChannel = async (channel: UpdateChannel) => {
    setChecking(true);
    setError(null);
    setApplyResult(null);
    setConfirmingRestart(false);
    try {
      const res = await ipc.checkForUpdates(channel);
      setCheckResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setChecking(false);
    }
  };

  const handleSelectChannel = (channel: UpdateChannel) => {
    setUpdateChannel(channel);
    setCheckResult(null);
    setApplyResult(null);
    setConfirmingRestart(false);
    setError(null);
    void runCheckForChannel(channel);
  };

  const handleCheckUpdates = () => runCheckForChannel(updateChannel);

  const handleApplyUpdate = async () => {
    setUpdating(true);
    setError(null);
    setConfirmingRestart(false);
    try {
      const res = await ipc.applyUpdate(updateChannel);
      setApplyResult(res);
      if (res.updated) {
        const refreshed = await ipc.checkForUpdates(updateChannel).catch(() => null);
        if (refreshed) setCheckResult(refreshed);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUpdating(false);
    }
  };

  const handleConfirmRestart = async () => {
    try {
      await ipc.restartApp();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setConfirmingRestart(false);
    }
  };

  return (
    <div className="lightbox-backdrop" onClick={onClose}>
      <div
        className="settings-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t('settings.title')}
      >
        <div className="lightbox-header">
          <div className="lightbox-title-group">
            <SettingsIcon size={16} />
            <span className="lightbox-title">{t('settings.title')}</span>
            <span className="sandbox-badge">v0.4.0</span>
          </div>
          <button
            type="button"
            className="btn-icon-xs"
            onClick={onClose}
            title={t('settings.close')}
            aria-label={t('settings.close')}
          >
            <CloseIcon size={15} />
          </button>
        </div>

        <div className="settings-body">
          {/* Theme Section */}
          <section className="settings-section">
            <div>
              <h3 className="inline-icon-text">
                <PaletteIcon size={15} />
                <span>{t('settings.themeTitle')}</span>
              </h3>
              <p className="muted-text">{t('settings.themeDesc')}</p>
            </div>
            <div className="theme-grid">
              {THEME_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  className={`theme-card ${theme === opt.id ? 'active' : ''}`}
                  onClick={() => setTheme(opt.id)}
                >
                  <span className="theme-swatches" aria-hidden="true">
                    {opt.swatches.map((hex, i) => (
                      <span key={i} className="theme-swatch" style={{ backgroundColor: hex }} />
                    ))}
                  </span>
                  <span className="theme-name">{opt.name}</span>
                </button>
              ))}
            </div>
          </section>

          {/* Language Section */}
          <section className="settings-section">
            <div className="settings-lang-row">
              <div>
                <h3 className="inline-icon-text">
                  <GlobeIcon size={15} />
                  <span>{t('settings.languageTitle')}</span>
                </h3>
                <p className="muted-text">{t('settings.languageDesc')}</p>
              </div>
              <select
                className="select-sm"
                aria-label={t('settings.languageLabel')}
                value={locale}
                onChange={(e) => setLocale(e.target.value as Locale)}
              >
                {LOCALE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          </section>

          {/* Updates Section */}
          <section className="settings-section">
            <div className="settings-section-header">
              <div>
                <h3>{t('settings.updatesTitle')}</h3>
                <p className="muted-text">{t('settings.updatesDesc')}</p>
              </div>

              <div className="channel-selector-block">
                <div className="channel-selector-row">
                  <span className="muted-text">{t('settings.channelLabel')}</span>
                  <div className="segmented-control">
                    <button
                      type="button"
                      className={updateChannel === 'stable' ? 'seg-btn active' : 'seg-btn'}
                      onClick={() => handleSelectChannel('stable')}
                      disabled={checking || updating}
                    >
                      {t('settings.channelStable')}
                    </button>
                    <button
                      type="button"
                      className={updateChannel === 'nightly' ? 'seg-btn active' : 'seg-btn'}
                      onClick={() => handleSelectChannel('nightly')}
                      disabled={checking || updating}
                    >
                      {t('settings.channelNightly')}
                    </button>
                  </div>
                </div>
                <p className="muted-text">
                  {updateChannel === 'stable'
                    ? t('settings.channelStableDesc')
                    : t('settings.channelNightlyDesc')}
                </p>
              </div>

              <div className="settings-actions-row">
                <button
                  type="button"
                  className="btn-ghost-sm inline-icon-btn"
                  onClick={() => void handleCheckUpdates()}
                  disabled={checking || updating}
                >
                  <RefreshIcon size={13} className={checking ? 'spin' : undefined} />
                  <span>{checking ? t('settings.checking') : t('settings.checkUpdates')}</span>
                </button>
                <button
                  type="button"
                  className="btn-primary-sm inline-icon-btn"
                  onClick={() => void handleApplyUpdate()}
                  disabled={
                    checking || updating || (checkResult !== null && !checkResult.update_available)
                  }
                >
                  <DownloadIcon size={13} />
                  <span>{updating ? t('settings.updating') : t('settings.applyUpdate')}</span>
                </button>
              </div>
            </div>

            {error && (
              <div className="banner-error settings-banner">
                <span className="inline-icon-text">
                  <AlertCircleIcon size={14} />
                  <span>{error}</span>
                </span>
              </div>
            )}

            {checkResult && (
              <div className="update-status-card">
                <div className="update-meta-grid">
                  <span className="sandbox-badge">
                    {checkResult.channel.toUpperCase()} ·{' '}
                    {checkResult.source === 'github-release'
                      ? t('settings.sourceRelease')
                      : t('settings.sourceGit')}
                  </span>
                  {checkResult.release_tag && (
                    <div>
                      <span className="muted-text">Tag:</span>{' '}
                      <code>{checkResult.release_tag}</code>
                    </div>
                  )}
                  <div>
                    <span className="muted-text">{t('settings.branch')}</span>{' '}
                    <code>{checkResult.branch}</code>
                  </div>
                  <div>
                    <span className="muted-text">{t('settings.local')}</span>{' '}
                    <code>{checkResult.current_commit}</code>
                  </div>
                  <div>
                    <span className="muted-text">{t('settings.remote')}</span>{' '}
                    <code>{checkResult.remote_commit}</code>
                  </div>
                </div>
                <div className="muted-text">
                  {t('settings.repo')} <code>{checkResult.repo_dir}</code>
                </div>

                {checkResult.update_available ? (
                  <div className="update-available-box">
                    <div className="inline-icon-text">
                      <DownloadIcon size={14} />
                      <strong>
                        {t('settings.updatesAvailable', { count: checkResult.commits_behind })}
                      </strong>
                    </div>
                    <ul className="update-changelog">
                      {checkResult.changelog.map((line, i) => (
                        <li key={i}>
                          <code>{line}</code>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <div className="update-uptodate-box inline-icon-text">
                    <CheckCircleIcon size={14} />
                    <span>{t('settings.upToDate')}</span>
                  </div>
                )}
              </div>
            )}

            {applyResult && (
              <div className="update-apply-box">
                <div className="update-apply-header">
                  <div className="inline-icon-text">
                    <CheckCircleIcon size={14} />
                    <span>{applyResult.message}</span>
                  </div>
                  {applyResult.updated && !confirmingRestart && (
                    <button
                      type="button"
                      className="btn-primary-sm inline-icon-btn"
                      onClick={() => setConfirmingRestart(true)}
                    >
                      <RefreshIcon size={13} />
                      <span>{t('settings.restartNow')}</span>
                    </button>
                  )}
                </div>

                {applyResult.updated && confirmingRestart && (
                  <div className="restart-confirm-box">
                    <span>{t('settings.restartConfirmPrompt')}</span>
                    <div className="banner-actions">
                      <button
                        type="button"
                        className="btn-primary-sm"
                        onClick={() => void handleConfirmRestart()}
                      >
                        {t('settings.restartConfirmBtn')}
                      </button>
                      <button
                        type="button"
                        className="btn-ghost-sm"
                        onClick={() => setConfirmingRestart(false)}
                      >
                        {t('settings.restartCancelBtn')}
                      </button>
                    </div>
                  </div>
                )}

                {applyResult.changelog.length > 0 && (
                  <div className="update-applied-changelog">
                    <strong>{t('settings.appliedChanges')}</strong>
                    <ul className="update-changelog">
                      {applyResult.changelog.map((line, i) => (
                        <li key={i}>
                          <code>{line}</code>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {applyResult.output_log && (
                  <details className="update-log-details">
                    <summary>{t('settings.viewLog')}</summary>
                    <pre className="update-log-pre">{applyResult.output_log}</pre>
                  </details>
                )}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
};
