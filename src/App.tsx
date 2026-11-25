import React, { useEffect, useState } from 'react';
import { ipc, listenEvent, type FsChangedPayload, type PiEventPayload } from './types/ipc';
import { useWorkspaceStore } from './store/workspaceStore';
import { useI18n } from './i18n/useI18n';
import { DockManager } from './docking/DockManager';
import { SettingsModal } from './components/SettingsModal';
import { getMediaKind } from './panels/mediaUtils';
import { FolderIcon, FolderSearchIcon, SettingsIcon } from './components/Icons';

export const App: React.FC = () => {
  const { locale, t } = useI18n();
  const workspace = useWorkspaceStore((s) => s.workspace);
  const recentWorkspaces = useWorkspaceStore((s) => s.recentWorkspaces);
  const loadRecentWorkspaces = useWorkspaceStore((s) => s.loadRecentWorkspaces);
  const openWorkspace = useWorkspaceStore((s) => s.openWorkspace);
  const toggleLeft = useWorkspaceStore((s) => s.toggleLeft);
  const toggleRight = useWorkspaceStore((s) => s.toggleRight);
  const toggleBottom = useWorkspaceStore((s) => s.toggleBottom);
  const startPreview = useWorkspaceStore((s) => s.startPreview);
  const setPreviewLightboxOpen = useWorkspaceStore((s) => s.setPreviewLightboxOpen);
  const handlePiEvent = useWorkspaceStore((s) => s.handlePiEvent);
  const refreshLoopRuns = useWorkspaceStore((s) => s.refreshLoopRuns);
  const refreshFileTree = useWorkspaceStore((s) => s.refreshFileTree);
  const refreshLenses = useWorkspaceStore((s) => s.refreshLenses);
  const requestOpenPanel = useWorkspaceStore((s) => s.requestOpenPanel);

  const [manualPath, setManualPath] = useState('');
  const [openError, setOpenError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    void loadRecentWorkspaces();
  }, [loadRecentWorkspaces]);

  // Window-scoped keyboard shortcuts (Ctrl+B, Ctrl+L, Ctrl+J, F5)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!useWorkspaceStore.getState().workspace) return;

      if (e.key === 'F5') {
        e.preventDefault();
        const status = useWorkspaceStore.getState().previewStatus;
        if (status?.running) {
          setPreviewLightboxOpen(true);
        } else {
          void startPreview('main');
        }
        return;
      }

      if (e.ctrlKey && !e.altKey && !e.shiftKey) {
        const key = e.key.toLowerCase();
        if (key === 'b') {
          e.preventDefault();
          toggleLeft();
        } else if (key === 'l') {
          e.preventDefault();
          toggleRight();
        } else if (key === 'j') {
          e.preventDefault();
          toggleBottom();
        }
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [toggleLeft, toggleRight, toggleBottom, startPreview, setPreviewLightboxOpen]);

  // Global Tauri / Mock event subscriptions
  useEffect(() => {
    if (!workspace) return;

    const unlisteners: Array<() => void> = [];

    void listenEvent<PiEventPayload>('pi://event', (payload) => {
      handlePiEvent(payload);
    }).then((fn) => unlisteners.push(fn));

    void listenEvent('loops://updated', () => {
      void refreshLoopRuns();
    }).then((fn) => unlisteners.push(fn));

    void listenEvent<FsChangedPayload>('fs://changed', (payload) => {
      if (payload.kind === 'create' || payload.kind === 'remove') {
        void refreshFileTree();
      }
      if (payload.rel_path?.startsWith('.hub/views/')) {
        void refreshLenses();
      }
      if (payload.rel_path?.startsWith('.loops/')) {
        void refreshLoopRuns();
      }
    }).then((fn) => unlisteners.push(fn));

    void listenEvent<{ path: string; panel_type?: string }>('hub://ui_open', (payload) => {
      const pType =
        payload.panel_type === 'loops' ||
        payload.panel_type === 'terminal' ||
        payload.panel_type === 'lens'
          ? payload.panel_type
          : 'markdown';
      const title = payload.path.split('/').pop() ?? payload.path;
      if (pType === 'lens') {
        requestOpenPanel('lens', title, { lensId: payload.path, title });
      } else if (pType === 'loops') {
        requestOpenPanel('loops', 'Loops', { runId: payload.path });
      } else if (pType === 'terminal') {
        requestOpenPanel('terminal', 'Terminal', {});
      } else {
        const mediaKind = getMediaKind(payload.path);
        if (mediaKind) {
          requestOpenPanel('media', title, { relPath: payload.path, mediaKind });
        } else {
          requestOpenPanel('markdown', title, { relPath: payload.path });
        }
      }
    }).then((fn) => unlisteners.push(fn));

    return () => {
      for (const fn of unlisteners) fn();
    };
  }, [
    workspace,
    handlePiEvent,
    refreshLoopRuns,
    refreshFileTree,
    refreshLenses,
    requestOpenPanel,
  ]);

  const handleOpenPath = async (targetPath: string) => {
    const trimmed = targetPath.trim();
    if (!trimmed) return;
    setOpening(true);
    setOpenError(null);
    try {
      await openWorkspace(trimmed);
    } catch (err) {
      setOpenError(err instanceof Error ? err.message : String(err));
    } finally {
      setOpening(false);
    }
  };

  const handlePickFolder = async () => {
    setOpenError(null);
    try {
      const selected = await ipc.pickWorkspaceDirectory();
      if (selected) {
        setManualPath(selected);
        await handleOpenPath(selected);
      }
    } catch (err) {
      setOpenError(err instanceof Error ? err.message : String(err));
    }
  };

  if (!workspace) {
    return (
      <div className="welcome-screen">
        <div className="welcome-card">
          <div className="welcome-header">
            <div className="welcome-top-row">
              <span className="brand-mark">GAME DEV HUB</span>
              <button
                type="button"
                className="btn-ghost-sm inline-icon-btn"
                onClick={() => setSettingsOpen(true)}
                title={t('app.settingsTooltip')}
              >
                <SettingsIcon size={14} />
                <span>{t('app.settings')}</span>
              </button>
            </div>
            <h1>{t('app.subtitle')}</h1>
            <p className="muted-text">{t('app.welcomeDesc')}</p>
          </div>

          <div className="welcome-picker-row">
            <button
              type="button"
              className="btn-primary-md inline-icon-btn"
              onClick={() => void handlePickFolder()}
              disabled={opening}
            >
              <FolderSearchIcon size={16} />
              <span>{opening ? t('app.opening') : t('app.pickFolder')}</span>
            </button>

            <form
              className="welcome-open-form"
              onSubmit={(e) => {
                e.preventDefault();
                void handleOpenPath(manualPath);
              }}
            >
              <input
                type="text"
                className="welcome-input"
                value={manualPath}
                onChange={(e) => setManualPath(e.target.value)}
                placeholder={t('app.pathPlaceholder')}
              />
              <button
                type="submit"
                className="btn-ghost-sm"
                disabled={opening || !manualPath.trim()}
              >
                {t('app.open')}
              </button>
            </form>
          </div>

          {openError && <div className="banner-error">{openError}</div>}

          <div className="recent-section">
            <h2>{t('app.recentProjects')}</h2>
            {recentWorkspaces.length === 0 ? (
              <p className="muted-text">{t('app.noRecentProjects')}</p>
            ) : (
              <div className="recent-list">
                {recentWorkspaces.map((item) => (
                  <button
                    key={item.path}
                    type="button"
                    className="recent-item"
                    onClick={() => void handleOpenPath(item.path)}
                  >
                    <div className="recent-item-left">
                      <FolderIcon size={16} className="recent-folder-icon" />
                      <div>
                        <div className="recent-name">{item.name}</div>
                        <div className="recent-path">{item.path}</div>
                      </div>
                    </div>
                    <span className="recent-date">
                      {new Date(item.last_opened).toLocaleDateString(locale)}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      </div>
    );
  }

  return <DockManager />;
};

export default App;
