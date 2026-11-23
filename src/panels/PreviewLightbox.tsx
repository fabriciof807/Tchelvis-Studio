import React, { useEffect } from 'react';
import { useWorkspaceStore } from '../store/workspaceStore';

export const PreviewLightbox: React.FC = () => {
  const previewLightboxOpen = useWorkspaceStore((s) => s.previewLightboxOpen);
  const previewStatus = useWorkspaceStore((s) => s.previewStatus);
  const setPreviewLightboxOpen = useWorkspaceStore((s) => s.setPreviewLightboxOpen);
  const stopPreview = useWorkspaceStore((s) => s.stopPreview);
  const capturePreviewFrame = useWorkspaceStore((s) => s.capturePreviewFrame);
  const incrementModalCount = useWorkspaceStore((s) => s.incrementModalCount);
  const decrementModalCount = useWorkspaceStore((s) => s.decrementModalCount);

  useEffect(() => {
    if (!previewLightboxOpen) return;
    incrementModalCount();
    return () => {
      decrementModalCount();
    };
  }, [previewLightboxOpen, incrementModalCount, decrementModalCount]);

  if (!previewLightboxOpen || !previewStatus) return null;

  const previewUrl = previewStatus.url ?? 'about:blank';

  const handleOpenExternal = () => {
    if (previewUrl && previewUrl !== 'about:blank') {
      window.open(previewUrl, '_blank', 'noopener,noreferrer');
    }
  };

  return (
    <div
      className="lightbox-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Preview do Jogo"
    >
      <div className="lightbox-modal">
        <div className="lightbox-header">
          <div className="lightbox-title-group">
            <span className="lightbox-title">
              Preview ({previewStatus.engine} · {previewStatus.mode})
            </span>
            {previewStatus.degraded_reason && (
              <span className="sandbox-badge">{previewStatus.degraded_reason}</span>
            )}
          </div>
          <div className="lightbox-actions">
            <button
              type="button"
              className="btn-ghost-sm"
              onClick={handleOpenExternal}
              disabled={!previewStatus.url || previewStatus.url === 'about:blank'}
            >
              Abrir no Navegador Externo
            </button>
            <button
              type="button"
              className="btn-primary-sm"
              disabled={!previewStatus.can_capture}
              onClick={() => void capturePreviewFrame()}
            >
              Capturar Frame + Log
            </button>
            <button
              type="button"
              className="btn-warn-sm"
              onClick={() => void stopPreview()}
            >
              Parar Preview
            </button>
            <button
              type="button"
              className="btn-ghost-sm"
              onClick={() => setPreviewLightboxOpen(false)}
            >
              Fechar
            </button>
          </div>
        </div>
        <div className="lightbox-viewport-16-9">
          {previewStatus.url && previewStatus.url !== 'about:blank' ? (
            <iframe
              title="game-preview"
              src={previewUrl}
              className="lightbox-iframe"
            />
          ) : (
            <div className="lightbox-placeholder">
              <p>Preview ativo em modo {previewStatus.mode}.</p>
              <p className="muted-text">
                {previewStatus.logs[previewStatus.logs.length - 1] ?? 'Aguardando URL do servidor...'}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
