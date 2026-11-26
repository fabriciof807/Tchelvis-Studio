import React, { useEffect } from 'react';
import { useWorkspaceStore } from '../store/workspaceStore';
import { useI18n } from '../i18n/useI18n';

const ERROR_LOG_LINES = 20;

export const PreviewLightbox: React.FC = () => {
  const { t } = useI18n();
  const previewLightboxOpen = useWorkspaceStore((s) => s.previewLightboxOpen);
  const previewPhase = useWorkspaceStore((s) => s.previewPhase);
  const previewStatus = useWorkspaceStore((s) => s.previewStatus);
  const previewError = useWorkspaceStore((s) => s.previewError);
  const setPreviewLightboxOpen = useWorkspaceStore((s) => s.setPreviewLightboxOpen);
  const retryPreview = useWorkspaceStore((s) => s.retryPreview);
  const cancelPreviewStart = useWorkspaceStore((s) => s.cancelPreviewStart);
  const refreshPreviewStatus = useWorkspaceStore((s) => s.refreshPreviewStatus);
  const focusPreview = useWorkspaceStore((s) => s.focusPreview);
  const stopPreview = useWorkspaceStore((s) => s.stopPreview);
  const capturePreviewFrame = useWorkspaceStore((s) => s.capturePreviewFrame);
  const incrementModalCount = useWorkspaceStore((s) => s.incrementModalCount);
  const decrementModalCount = useWorkspaceStore((s) => s.decrementModalCount);

  const isStarting = previewPhase === 'starting';
  const isRunning = previewPhase === 'running';
  // A Godot preview lives in its own native window, so the Hub only shows a compact bar.
  const isGodotBar = isRunning && previewStatus?.engine === 'godot';

  useEffect(() => {
    // The Godot bar is non-modal: Esc only closes it when focus is inside the bar, so Esc in the
    // terminal/vim does not hide it. Modal states keep the window-level shortcut.
    if (!previewLightboxOpen || isGodotBar) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Closing the overlay never stops the game.
        setPreviewLightboxOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [previewLightboxOpen, isGodotBar, setPreviewLightboxOpen]);

  // Only modal states count as modals; the Godot bar must leave the Hub usable.
  useEffect(() => {
    if (!previewLightboxOpen || isGodotBar) return;
    incrementModalCount();
    return () => {
      decrementModalCount();
    };
  }, [previewLightboxOpen, isGodotBar, incrementModalCount, decrementModalCount]);

  // While starting, poll the cheap status read for logs and the ready transition.
  useEffect(() => {
    if (!previewLightboxOpen || !isStarting) return;
    const id = window.setInterval(() => {
      void refreshPreviewStatus();
    }, 500);
    return () => window.clearInterval(id);
  }, [previewLightboxOpen, isStarting, refreshPreviewStatus]);

  if (!previewLightboxOpen || previewPhase === 'idle') return null;

  const previewUrl = previewStatus?.url ?? null;
  const lastLog = previewStatus?.logs?.[previewStatus.logs.length - 1];
  const startingLabel = previewStatus?.engine
    ? t('preview.startingEngine', { engine: previewStatus.engine })
    : t('preview.starting');

  const handleOpenExternal = () => {
    if (previewUrl) {
      window.open(previewUrl, '_blank', 'noopener,noreferrer');
    }
  };

  if (isGodotBar) {
    return (
      <div
        className="preview-godot-bar"
        role="dialog"
        aria-label={t('preview.ariaLabel')}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            setPreviewLightboxOpen(false);
          }
        }}
      >
        <span className="preview-godot-bar-title">
          {t('preview.engineBar', {
            engine: previewStatus?.engine ?? '',
            pid: previewStatus?.pid ?? '—',
          })}
        </span>
        {previewError && <span className="preview-note">{previewError}</span>}
        <div className="lightbox-actions">
          <button type="button" className="btn-ghost-sm" onClick={() => void focusPreview()}>
            {t('preview.focusGame')}
          </button>
          <button
            type="button"
            className="btn-primary-sm"
            disabled={!previewStatus?.can_capture}
            onClick={() => void capturePreviewFrame()}
          >
            {t('preview.captureFrame')}
          </button>
          <button type="button" className="btn-warn-sm" onClick={() => void stopPreview()}>
            {t('preview.stop')}
          </button>
          <button
            type="button"
            className="btn-ghost-sm"
            aria-label={t('preview.close')}
            title={t('preview.close')}
            onClick={() => setPreviewLightboxOpen(false)}
          >
            ✕
          </button>
        </div>
      </div>
    );
  }

  const title =
    previewPhase === 'error'
      ? t('preview.errorTitle')
      : isStarting
        ? startingLabel
        : `${previewStatus?.engine ?? ''} · ${previewStatus?.mode ?? ''}`;

  return (
    <div
      className="lightbox-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={t('preview.ariaLabel')}
    >
      <div className="lightbox-modal">
        <div className="lightbox-header">
          <div className="lightbox-title-group">
            <span className="lightbox-title">{title}</span>
            {previewStatus?.degraded_reason && (
              <span className="sandbox-badge">{previewStatus.degraded_reason}</span>
            )}
            {isRunning && previewError && <span className="preview-note">{previewError}</span>}
          </div>
          <div className="lightbox-actions">
            {isStarting && (
              <button
                type="button"
                className="btn-warn-sm"
                onClick={() => void cancelPreviewStart()}
              >
                {t('preview.cancel')}
              </button>
            )}
            {isRunning && (
              <>
                <button
                  type="button"
                  className="btn-ghost-sm"
                  onClick={handleOpenExternal}
                  disabled={!previewUrl}
                >
                  {t('preview.openExternal')}
                </button>
                <button
                  type="button"
                  className="btn-primary-sm"
                  disabled={!previewStatus?.can_capture}
                  onClick={() => void capturePreviewFrame()}
                >
                  {t('preview.captureFrame')}
                </button>
                <button type="button" className="btn-warn-sm" onClick={() => void stopPreview()}>
                  {t('preview.stop')}
                </button>
                <button
                  type="button"
                  className="btn-ghost-sm"
                  onClick={() => setPreviewLightboxOpen(false)}
                >
                  {t('preview.close')}
                </button>
              </>
            )}
            {previewPhase === 'error' && (
              <>
                <button
                  type="button"
                  className="btn-primary-sm"
                  onClick={retryPreview}
                >
                  {t('preview.retry')}
                </button>
                <button
                  type="button"
                  className="btn-ghost-sm"
                  onClick={() => setPreviewLightboxOpen(false)}
                >
                  {t('preview.close')}
                </button>
              </>
            )}
          </div>
        </div>
        {isStarting && (
          <div className="preview-starting">
            <div className="preview-spinner" role="status" aria-label={startingLabel} />
            <p className="preview-starting-label">{startingLabel}</p>
            <p className="muted-text">{lastLog ?? t('preview.waitingUrl')}</p>
          </div>
        )}
        {previewPhase === 'error' && (
          <div className="preview-error">
            <p className="preview-error-message">{previewError ?? t('preview.errorTitle')}</p>
            <div className="preview-error-log">
              {(previewStatus?.logs ?? []).slice(-ERROR_LOG_LINES).map((line, index) => (
                <div className="preview-log-line" key={`${index}-${line}`}>
                  {line}
                </div>
              ))}
            </div>
          </div>
        )}
        {isRunning && (
          <div className="lightbox-viewport-16-9">
            {previewUrl ? (
              <iframe
                title="game-preview"
                src={previewUrl}
                className="lightbox-iframe"
                sandbox="allow-scripts allow-same-origin allow-pointer-lock"
                allow="fullscreen; gamepad; autoplay"
              />
            ) : (
              <div className="lightbox-placeholder">
                <p className="muted-text">{lastLog ?? t('preview.waitingUrl')}</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
