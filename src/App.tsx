import React, { useEffect, useState } from 'react';
import { listenEvent, type FsChangedPayload, type PiEventPayload } from './types/ipc';
import { useWorkspaceStore } from './store/workspaceStore';
import { DockManager } from './docking/DockManager';

export const App: React.FC = () => {
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

  const [manualPath, setManualPath] = useState('/home/ubuntu/projetos/forja-cinza');
  const [openError, setOpenError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);

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
      if (payload.rel_path.startsWith('.hub/views/')) {
        void refreshLenses();
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
        requestOpenPanel('markdown', title, { relPath: payload.path });
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

  if (!workspace) {
    return (
      <div className="welcome-screen">
        <div className="welcome-card">
          <div className="welcome-header">
            <span className="brand-mark">GAME DEV HUB</span>
            <h1>Estúdio Local-First de Game Design &amp; Orquestração</h1>
            <p className="muted-text">
              Selecione um projeto recente ou informe o caminho de um diretório para abrir ou
              inicializar um workspace.
            </p>
          </div>

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
              placeholder="/caminho/para/meu-jogo"
            />
            <button type="submit" className="btn-primary-md" disabled={opening}>
              {opening ? 'Abrindo...' : 'Abrir / Novo Diretório'}
            </button>
          </form>

          {openError && <div className="banner-error">{openError}</div>}

          <div className="recent-section">
            <h2>Projetos Recentes</h2>
            {recentWorkspaces.length === 0 ? (
              <p className="muted-text">Nenhum projeto recente registrado.</p>
            ) : (
              <div className="recent-list">
                {recentWorkspaces.map((item) => (
                  <button
                    key={item.path}
                    type="button"
                    className="recent-item"
                    onClick={() => void handleOpenPath(item.path)}
                  >
                    <div>
                      <div className="recent-name">{item.name}</div>
                      <div className="recent-path">{item.path}</div>
                    </div>
                    <span className="recent-date">
                      {new Date(item.last_opened).toLocaleDateString('pt-BR')}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return <DockManager />;
};

export default App;
