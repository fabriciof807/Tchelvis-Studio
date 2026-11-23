import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import {
  DockviewReact,
  type DockviewApi,
  type DockviewReadyEvent,
} from 'dockview-react';
import 'dockview-react/dist/styles/dockview.css';
import { ipc, type FileTreeNode } from '../types/ipc';
import { useWorkspaceStore } from '../store/workspaceStore';
import { PANEL_COMPONENTS } from './panelRegistry';
import { PresetsBar } from './PresetsBar';
import { ChatPanel } from '../panels/ChatPanel';
import { TerminalPanel } from '../panels/TerminalPanel';
import { PreviewLightbox } from '../panels/PreviewLightbox';
import { SettingsModal } from '../components/SettingsModal';
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CloseIcon,
  FileTextIcon,
  FolderIcon,
  LayersIcon,
  MessageSquareIcon,
  PlayIcon,
  RefreshIcon,
  RepeatIcon,
  SettingsIcon,
  TerminalIcon,
} from '../components/Icons';

const DRAWER_SIZES_KEY = 'game-hub:drawer-sizes';

interface DrawerSizes {
  left: number;
  right: number;
  bottom: number;
}

const DEFAULT_DRAWER_SIZES: DrawerSizes = { left: 240, right: 340, bottom: 220 };

function loadDrawerSizes(): DrawerSizes {
  try {
    const raw = window.localStorage.getItem(DRAWER_SIZES_KEY);
    if (!raw) return DEFAULT_DRAWER_SIZES;
    const parsed = JSON.parse(raw) as Partial<DrawerSizes>;
    return {
      left: typeof parsed.left === 'number' ? clamp(parsed.left, 160, 520) : 240,
      right: typeof parsed.right === 'number' ? clamp(parsed.right, 240, 680) : 340,
      bottom: typeof parsed.bottom === 'number' ? clamp(parsed.bottom, 100, 600) : 220,
    };
  } catch {
    return DEFAULT_DRAWER_SIZES;
  }
}

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

const FileTreeItem: React.FC<{
  node: FileTreeNode;
  depth: number;
  onOpenFile: (relPath: string, name: string) => void;
}> = memo(({ node, depth, onOpenFile }) => {
  const [expanded, setExpanded] = useState(depth < 1);
  const isDirty = useWorkspaceStore((s) => !node.is_dir && s.dirtyFiles.includes(node.rel_path));

  if (node.is_dir) {
    return (
      <div className="tree-node-group">
        <button
          type="button"
          className="tree-row tree-dir"
          style={{ paddingLeft: `${8 + depth * 12}px` }}
          onClick={() => setExpanded((e) => !e)}
        >
          <span className="tree-caret">
            {expanded ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
          </span>
          <span className="tree-label">{node.name}</span>
        </button>
        {expanded &&
          node.children?.map((child) => (
            <FileTreeItem
              key={child.rel_path}
              node={child}
              depth={depth + 1}
              onOpenFile={onOpenFile}
            />
          ))}
      </div>
    );
  }

  return (
    <button
      type="button"
      className="tree-row tree-file"
      style={{ paddingLeft: `${18 + depth * 12}px` }}
      onClick={() => onOpenFile(node.rel_path, node.name)}
      title={node.rel_path}
    >
      <FileTextIcon size={13} className="tree-file-icon" />
      <span className="tree-label">{node.name}</span>
      {isDirty && <span className="tree-dirty-dot" title="Não salvo" />}
    </button>
  );
});

FileTreeItem.displayName = 'FileTreeItem';

export const DockManager: React.FC = () => {
  const fileTree = useWorkspaceStore((s) => s.fileTree);
  const loopRuns = useWorkspaceStore((s) => s.loopRuns);
  const lenses = useWorkspaceStore((s) => s.lenses);
  const leftCollapsed = useWorkspaceStore((s) => s.leftCollapsed);
  const rightCollapsed = useWorkspaceStore((s) => s.rightCollapsed);
  const bottomCollapsed = useWorkspaceStore((s) => s.bottomCollapsed);
  const activeLeftSection = useWorkspaceStore((s) => s.activeLeftSection);
  const pendingPanelRequest = useWorkspaceStore((s) => s.pendingPanelRequest);
  const previewStatus = useWorkspaceStore((s) => s.previewStatus);

  const setActiveLeftSection = useWorkspaceStore((s) => s.setActiveLeftSection);
  const toggleLeft = useWorkspaceStore((s) => s.toggleLeft);
  const toggleRight = useWorkspaceStore((s) => s.toggleRight);
  const toggleBottom = useWorkspaceStore((s) => s.toggleBottom);
  const setFocusedPanel = useWorkspaceStore((s) => s.setFocusedPanel);
  const requestOpenPanel = useWorkspaceStore((s) => s.requestOpenPanel);
  const clearPendingPanelRequest = useWorkspaceStore((s) => s.clearPendingPanelRequest);
  const startPreview = useWorkspaceStore((s) => s.startPreview);
  const setPreviewLightboxOpen = useWorkspaceStore((s) => s.setPreviewLightboxOpen);
  const refreshFileTree = useWorkspaceStore((s) => s.refreshFileTree);

  const [settingsOpen, setSettingsOpen] = useState(false);

  const hubRootRef = useRef<HTMLDivElement | null>(null);
  const sizesRef = useRef<DrawerSizes>(loadDrawerSizes());
  const dockApiRef = useRef<DockviewApi | null>(null);
  const saveTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const root = hubRootRef.current;
    if (!root) return;
    root.style.setProperty('--left-drawer-width', `${sizesRef.current.left}px`);
    root.style.setProperty('--right-drawer-width', `${sizesRef.current.right}px`);
    root.style.setProperty('--bottom-drawer-height', `${sizesRef.current.bottom}px`);
  }, []);

  const startResize = useCallback(
    (which: 'left' | 'right' | 'bottom', e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      const target = e.currentTarget;
      target.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const startY = e.clientY;
      const initial = { ...sizesRef.current };

      document.body.classList.add('is-resizing');
      document.body.dataset.resizeAxis = which === 'bottom' ? 'y' : 'x';

      let rafId: number | null = null;
      let latestSize = initial[which];

      const applySize = (nextSize: number) => {
        latestSize = nextSize;
        sizesRef.current[which] = nextSize;
        if (rafId !== null) return;
        rafId = window.requestAnimationFrame(() => {
          rafId = null;
          const root = hubRootRef.current;
          if (!root) return;
          if (which === 'left') {
            root.style.setProperty('--left-drawer-width', `${latestSize}px`);
          } else if (which === 'right') {
            root.style.setProperty('--right-drawer-width', `${latestSize}px`);
          } else {
            root.style.setProperty('--bottom-drawer-height', `${latestSize}px`);
          }
        });
      };

      const onMove = (ev: PointerEvent) => {
        if (which === 'left') {
          applySize(clamp(initial.left + (ev.clientX - startX), 160, 520));
        } else if (which === 'right') {
          applySize(clamp(initial.right - (ev.clientX - startX), 240, 680));
        } else {
          applySize(clamp(initial.bottom - (ev.clientY - startY), 100, 600));
        }
      };

      const onUp = () => {
        if (rafId !== null) {
          window.cancelAnimationFrame(rafId);
        }
        document.body.classList.remove('is-resizing');
        delete document.body.dataset.resizeAxis;
        target.removeEventListener('pointermove', onMove);
        target.removeEventListener('pointerup', onUp);
        target.removeEventListener('pointercancel', onUp);
        try {
          window.localStorage.setItem(DRAWER_SIZES_KEY, JSON.stringify(sizesRef.current));
        } catch {
          // ignore storage errors
        }
      };

      target.addEventListener('pointermove', onMove);
      target.addEventListener('pointerup', onUp);
      target.addEventListener('pointercancel', onUp);
    },
    []
  );

  const openDefaultPanels = useCallback((api: DockviewApi) => {
    const firstMd = fileTree
      .flatMap((n) => (n.is_dir ? n.children ?? [] : [n]))
      .find((n) => !n.is_dir && n.rel_path.endsWith('.md'));

    if (firstMd) {
      api.addPanel({
        id: `md:${firstMd.rel_path}`,
        component: 'markdown',
        title: firstMd.name,
        params: { relPath: firstMd.rel_path },
      });
    } else {
      api.addPanel({
        id: 'loops:main',
        component: 'loops',
        title: 'Loops (Tchelvis)',
        params: {},
      });
    }
  }, [fileTree]);

  const scheduleSaveLayout = useCallback((api: DockviewApi) => {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = window.setTimeout(() => {
      try {
        const json = JSON.stringify(api.toJSON());
        void ipc.saveLayout(json);
      } catch (err) {
        console.error('Erro ao salvar layout:', err);
      }
    }, 350);
  }, []);

  const handleReady = async (event: DockviewReadyEvent) => {
    const api = event.api;
    dockApiRef.current = api;

    api.onDidActivePanelChange((panel) => {
      setFocusedPanel(panel ? panel.id : null);
    });

    api.onDidLayoutChange(() => {
      scheduleSaveLayout(api);
    });

    try {
      const saved = await ipc.loadLayout();
      if (saved) {
        api.fromJSON(JSON.parse(saved));
        return;
      }
    } catch (err) {
      console.warn('Layout salvo inválido, restaurando padrão:', err);
    }
    openDefaultPanels(api);
  };

  // Handle panel open requests from store (wikilinks, explorer, loops, lenses, ui_open)
  useEffect(() => {
    if (!pendingPanelRequest || !dockApiRef.current) return;
    const api = dockApiRef.current;
    const { panelType, title, params } = pendingPanelRequest;

    let panelId = `${panelType}:default`;
    if (panelType === 'markdown' && typeof params.relPath === 'string') {
      panelId = `md:${params.relPath}`;
    } else if (panelType === 'lens' && typeof params.lensId === 'string') {
      panelId = `lens:${params.lensId}`;
    } else if (panelType === 'loops') {
      panelId = 'loops:main';
    } else if (panelType === 'terminal') {
      panelId = 'terminal:main';
    }

    const existing = api.getPanel(panelId);
    if (existing) {
      existing.api.setActive();
      if (panelType === 'loops' && params.runId) {
        existing.api.updateParameters(params);
      }
    } else {
      api.addPanel({
        id: panelId,
        component: panelType,
        title,
        params,
      });
    }

    clearPendingPanelRequest();
  }, [pendingPanelRequest, clearPendingPanelRequest]);

  const handleOpenFile = useCallback(
    (relPath: string, name: string) => {
      requestOpenPanel('markdown', name, { relPath });
    },
    [requestOpenPanel]
  );

  const handleApplyPresetLayout = (layoutJson: string) => {
    if (!dockApiRef.current) return;
    try {
      dockApiRef.current.fromJSON(JSON.parse(layoutJson));
    } catch (err) {
      console.error('Erro ao aplicar preset:', err);
    }
  };

  const handleResetDefaultLayout = () => {
    if (!dockApiRef.current) return;
    dockApiRef.current.clear();
    openDefaultPanels(dockApiRef.current);
  };

  const handleActivityClick = (section: 'explorer' | 'loops' | 'lenses') => {
    if (!leftCollapsed && activeLeftSection === section) {
      toggleLeft();
    } else {
      setActiveLeftSection(section);
    }
  };

  return (
    <div ref={hubRootRef} className="hub-root">
      <PresetsBar
        onApplyPresetLayout={handleApplyPresetLayout}
        onResetDefaultLayout={handleResetDefaultLayout}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <div className="hub-workspace-body">
        {/* ~42px Activity Bar */}
        <aside className="activity-bar" aria-label="Barra de Atividades">
          <button
            type="button"
            className={`activity-btn ${!leftCollapsed && activeLeftSection === 'explorer' ? 'active' : ''}`}
            onClick={() => handleActivityClick('explorer')}
            title="Explorador de Arquivos (Ctrl+B)"
          >
            <FolderIcon size={17} />
          </button>
          <button
            type="button"
            className={`activity-btn ${!leftCollapsed && activeLeftSection === 'loops' ? 'active' : ''}`}
            onClick={() => handleActivityClick('loops')}
            title="Loops (Tchelvis-Supervisor)"
          >
            <RepeatIcon size={17} />
          </button>
          <button
            type="button"
            className={`activity-btn ${!leftCollapsed && activeLeftSection === 'lenses' ? 'active' : ''}`}
            onClick={() => handleActivityClick('lenses')}
            title="Lentes Customizadas (.hub/views/)"
          >
            <LayersIcon size={17} />
          </button>

          <div className="activity-spacer" />

          <button
            type="button"
            className={`activity-btn ${previewStatus?.running ? 'active' : ''}`}
            onClick={() =>
              previewStatus?.running
                ? setPreviewLightboxOpen(true)
                : void startPreview('main')
            }
            title="Preview Flutuante (F5)"
          >
            <PlayIcon size={16} />
          </button>
          <button
            type="button"
            className={`activity-btn ${!bottomCollapsed ? 'active' : ''}`}
            onClick={toggleBottom}
            title="Terminal Inferior (Ctrl+J)"
          >
            <TerminalIcon size={16} />
          </button>
          <button
            type="button"
            className={`activity-btn ${!rightCollapsed ? 'active' : ''}`}
            onClick={toggleRight}
            title="Chat Pi Durable (Ctrl+L)"
          >
            <MessageSquareIcon size={16} />
          </button>
          <button
            type="button"
            className="activity-btn"
            onClick={() => setSettingsOpen(true)}
            title="Configurações e Atualizações"
          >
            <SettingsIcon size={16} />
          </button>
        </aside>

        {/* Left Collapsible Drawer (kept mounted for instant Zen Mode) */}
        <aside className={`left-drawer ${leftCollapsed ? 'drawer-collapsed' : ''}`}>
          {activeLeftSection === 'explorer' && (
            <div className="drawer-section">
              <div className="drawer-header">
                <span>EXPLORADOR</span>
                <button
                  type="button"
                  className="btn-icon-xs"
                  onClick={() => void refreshFileTree()}
                  title="Atualizar árvore"
                >
                  <RefreshIcon size={13} />
                </button>
              </div>
              <div className="drawer-scroll">
                {fileTree.length === 0 ? (
                  <div className="drawer-empty">Workspace vazio</div>
                ) : (
                  fileTree.map((node) => (
                    <FileTreeItem
                      key={node.rel_path}
                      node={node}
                      depth={0}
                      onOpenFile={handleOpenFile}
                    />
                  ))
                )}
              </div>
            </div>
          )}

          {activeLeftSection === 'loops' && (
            <div className="drawer-section">
              <div className="drawer-header">
                <span>LOOPS (TCHELVIS)</span>
              </div>
              <div className="drawer-scroll">
                {loopRuns.length === 0 ? (
                  <div className="drawer-empty">Nenhum loop executado.</div>
                ) : (
                  loopRuns.map((run) => (
                    <button
                      key={run.run_id}
                      type="button"
                      className="drawer-list-item"
                      onClick={() =>
                        requestOpenPanel('loops', 'Loops', { runId: run.run_id })
                      }
                    >
                      <div className="drawer-item-title">{run.title}</div>
                      <span className={`loop-status-pill status-${run.status}`}>
                        {run.status}
                      </span>
                    </button>
                  ))
                )}
              </div>
            </div>
          )}

          {activeLeftSection === 'lenses' && (
            <div className="drawer-section">
              <div className="drawer-header">
                <span>LENTES (.hub/views/)</span>
              </div>
              <div className="drawer-scroll">
                {lenses.length === 0 ? (
                  <div className="drawer-empty">Nenhuma lente publicada.</div>
                ) : (
                  lenses.map((lens) => (
                    <button
                      key={lens.lens_id}
                      type="button"
                      className="drawer-list-item"
                      onClick={() =>
                        requestOpenPanel('lens', lens.title, {
                          lensId: lens.lens_id,
                          title: lens.title,
                        })
                      }
                    >
                      <div className="drawer-item-title">{lens.title}</div>
                      <span className="muted-text">{lens.lens_id}</span>
                    </button>
                  ))
                )}
              </div>
            </div>
          )}
        </aside>

        {!leftCollapsed && (
          <div
            className="resize-handle-x"
            onPointerDown={(e) => startResize('left', e)}
            role="separator"
            aria-orientation="vertical"
            title="Arrastar para redimensionar painel esquerdo"
          />
        )}

        {/* Center Dockview Grid + Bottom Terminal Drawer */}
        <div className="center-column">
          <div className="dockview-container">
            <DockviewReact
              className="dockview-theme-abyss"
              components={PANEL_COMPONENTS}
              onReady={(ev) => void handleReady(ev)}
            />
          </div>

          {!bottomCollapsed && (
            <div
              className="resize-handle-y"
              onPointerDown={(e) => startResize('bottom', e)}
              role="separator"
              aria-orientation="horizontal"
              title="Arrastar para redimensionar terminal"
            />
          )}

          <div className={`bottom-drawer ${bottomCollapsed ? 'drawer-collapsed' : ''}`}>
            <div className="drawer-header">
              <span>TERMINAL</span>
              <button
                type="button"
                className="btn-icon-xs"
                onClick={toggleBottom}
                title="Recolher Terminal (Ctrl+J)"
              >
                <CloseIcon size={13} />
              </button>
            </div>
            <div className="bottom-drawer-body">
              <TerminalPanel visible={!bottomCollapsed} />
            </div>
          </div>
        </div>

        {!rightCollapsed && (
          <div
            className="resize-handle-x"
            onPointerDown={(e) => startResize('right', e)}
            role="separator"
            aria-orientation="vertical"
            title="Arrastar para redimensionar chat"
          />
        )}

        {/* Right Collapsible Chat Drawer (kept mounted for instant Zen Mode) */}
        <aside className={`right-drawer ${rightCollapsed ? 'drawer-collapsed' : ''}`}>
          <ChatPanel />
        </aside>
      </div>

      <PreviewLightbox />
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
};
