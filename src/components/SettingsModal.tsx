import React, { useEffect, useState } from 'react';
import { ipc, type UpdateApplyResult, type UpdateCheckResult } from '../types/ipc';
import { useWorkspaceStore } from '../store/workspaceStore';
import {
  AlertCircleIcon,
  CheckCircleIcon,
  CloseIcon,
  DownloadIcon,
  RefreshIcon,
  SettingsIcon,
} from './Icons';

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({ open, onClose }) => {
  const incrementModalCount = useWorkspaceStore((s) => s.incrementModalCount);
  const decrementModalCount = useWorkspaceStore((s) => s.decrementModalCount);

  const [checking, setChecking] = useState(false);
  const [updating, setUpdating] = useState(false);
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

  const handleCheckUpdates = async () => {
    setChecking(true);
    setError(null);
    setApplyResult(null);
    try {
      const res = await ipc.checkForUpdates();
      setCheckResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setChecking(false);
    }
  };

  const handleApplyUpdate = async () => {
    setUpdating(true);
    setError(null);
    try {
      const res = await ipc.applyUpdate();
      setApplyResult(res);
      if (res.updated) {
        const refreshed = await ipc.checkForUpdates().catch(() => null);
        if (refreshed) setCheckResult(refreshed);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUpdating(false);
    }
  };

  return (
    <div className="lightbox-backdrop" onClick={onClose}>
      <div
        className="settings-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Configurações"
      >
        <div className="lightbox-header">
          <div className="lightbox-title-group">
            <SettingsIcon size={16} />
            <span className="lightbox-title">Configurações</span>
          </div>
          <button
            type="button"
            className="btn-icon-xs"
            onClick={onClose}
            title="Fechar (Esc)"
            aria-label="Fechar configurações"
          >
            <CloseIcon size={15} />
          </button>
        </div>

        <div className="settings-body">
          <section className="settings-section">
            <div className="settings-section-header">
              <div>
                <h3>Atualizações do GitHub</h3>
                <p className="muted-text">
                  Verifica novos commits no repositório remoto e recompila o aplicativo localmente.
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
                  <span>{checking ? 'Verificando...' : 'Procurar Atualizações'}</span>
                </button>
                <button
                  type="button"
                  className="btn-primary-sm inline-icon-btn"
                  onClick={() => void handleApplyUpdate()}
                  disabled={checking || updating || (checkResult !== null && !checkResult.update_available)}
                >
                  <DownloadIcon size={13} />
                  <span>{updating ? 'Atualizando...' : 'Atualizar Agora'}</span>
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
                  <div>
                    <span className="muted-text">Branch:</span> <code>{checkResult.branch}</code>
                  </div>
                  <div>
                    <span className="muted-text">Local:</span> <code>{checkResult.current_commit}</code>
                  </div>
                  <div>
                    <span className="muted-text">Remoto:</span> <code>{checkResult.remote_commit}</code>
                  </div>
                </div>
                <div className="muted-text">
                  Repositório: <code>{checkResult.repo_dir}</code>
                </div>

                {checkResult.update_available ? (
                  <div className="update-available-box">
                    <div className="inline-icon-text">
                      <DownloadIcon size={14} />
                      <strong>
                        {checkResult.commits_behind} atualização(ões) disponível(is):
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
                    <span>Você já está na versão mais recente.</span>
                  </div>
                )}
              </div>
            )}

            {applyResult && (
              <div className="update-apply-box">
                <div className="inline-icon-text">
                  <CheckCircleIcon size={14} />
                  <span>{applyResult.message}</span>
                </div>
                {applyResult.output_log && (
                  <details className="update-log-details">
                    <summary>Ver log da atualização</summary>
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
