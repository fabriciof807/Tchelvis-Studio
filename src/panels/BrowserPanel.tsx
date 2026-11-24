import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import {
  ipc,
  listenEvent,
  type BrowserBounds,
  type BrowserPanelState,
} from '../types/ipc';
import { useWorkspaceStore } from '../store/workspaceStore';
import { useI18n } from '../i18n/useI18n';
import { AnnotationCanvas } from './AnnotationCanvas';
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CameraIcon,
  ExternalLinkIcon,
  GlobeIcon,
  RefreshIcon,
} from '../components/Icons';

export interface BrowserPanelParams {
  initialUrl?: string;
}

export interface BrowserVisibilityInput {
  isTabActive: boolean;
  activeModalCount: number;
  zenMode: boolean;
  annotating: boolean;
  viewportWidth: number;
  viewportHeight: number;
}

export function computeBrowserChildVisibility(input: BrowserVisibilityInput): boolean {
  if (!input.isTabActive) return false;
  if (input.activeModalCount > 0) return false;
  if (input.zenMode) return false;
  if (input.annotating) return false;
  if (input.viewportWidth < 2 || input.viewportHeight < 2) return false;
  return true;
}

const DEFAULT_URL = 'https://labs.google/fx/tools/flow';

const QUICK_BOOKMARKS = [
  { label: 'Google Flow', url: 'https://labs.google/fx/tools/flow' },
  { label: 'Godot Docs', url: 'https://docs.godotengine.org/en/stable/' },
  { label: 'itch.io', url: 'https://itch.io' },
] as const;

export const BrowserPanel: React.FC<IDockviewPanelProps<BrowserPanelParams>> = (props) => {
  const { t } = useI18n();
  const viewportRef = useRef<HTMLDivElement | null>(null);

  const activeModalCount = useWorkspaceStore((s) => s.activeModalCount);
  const zenMode = useWorkspaceStore((s) => s.zenMode);
  const leftCollapsed = useWorkspaceStore((s) => s.leftCollapsed);
  const rightCollapsed = useWorkspaceStore((s) => s.rightCollapsed);
  const bottomCollapsed = useWorkspaceStore((s) => s.bottomCollapsed);

  const initialUrl = props.params?.initialUrl || DEFAULT_URL;

  const [isTabActive, setIsTabActive] = useState<boolean>(() => props.api?.isActive ?? true);
  const [currentUrl, setCurrentUrl] = useState<string>(initialUrl);
  const [urlInput, setUrlInput] = useState<string>(initialUrl);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [canGoBack, setCanGoBack] = useState<boolean>(false);
  const [canGoForward, setCanGoForward] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(false);

  const [viewportBounds, setViewportBounds] = useState<BrowserBounds>({
    x: 0,
    y: 0,
    width: 800,
    height: 600,
  });

  const [annotating, setAnnotating] = useState<boolean>(false);
  const [snapshotDataUrl, setSnapshotDataUrl] = useState<string | null>(null);

  const applyBrowserState = useCallback((state: BrowserPanelState) => {
    setCurrentUrl(state.url);
    setUrlInput(state.url);
    setCanGoBack(state.can_go_back);
    setCanGoForward(state.can_go_forward);
    setLoading(state.loading);
  }, []);

  const measureAndSyncBounds = useCallback((): BrowserBounds | null => {
    const el = viewportRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const nextBounds: BrowserBounds = {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.max(1, Math.round(rect.width)),
      height: Math.max(1, Math.round(rect.height)),
    };
    setViewportBounds(nextBounds);
    void ipc.browserSyncBounds(nextBounds);
    return nextBounds;
  }, []);

  // 1. Monitor Dockview tab active state
  useEffect(() => {
    if (!props.api) return;
    setIsTabActive(props.api.isActive);
    const disposable = props.api.onDidActiveChange((ev) => {
      setIsTabActive(ev.isActive);
    });
    return () => {
      disposable.dispose();
    };
  }, [props.api]);

  // 2. Initial navigation + Rust browser://state event subscription
  useEffect(() => {
    let mounted = true;
    const measured = measureAndSyncBounds() ?? undefined;
    void ipc
      .browserNavigate(initialUrl, measured)
      .then((state) => {
        if (mounted) {
          applyBrowserState(state);
          setUrlError(null);
        }
      })
      .catch((err) => {
        if (mounted) {
          setUrlError(err instanceof Error ? err.message : String(err));
        }
      });

    let unlisten: (() => void) | null = null;
    void listenEvent<BrowserPanelState>('browser://state', (nextState) => {
      if (mounted) {
        applyBrowserState(nextState);
      }
    }).then((fn) => {
      if (mounted) {
        unlisten = fn;
      } else {
        fn();
      }
    });

    return () => {
      mounted = false;
      if (unlisten) unlisten();
      void ipc.browserSetVisible(false);
    };
  }, [initialUrl, applyBrowserState, measureAndSyncBounds]);

  // 3. ResizeObserver + window.resize + drawer collapses
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;

    const rafId = window.requestAnimationFrame(() => {
      measureAndSyncBounds();
    });

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => {
        measureAndSyncBounds();
      });
      observer.observe(el);
    }

    const onWindowResize = () => {
      measureAndSyncBounds();
    };
    window.addEventListener('resize', onWindowResize);

    return () => {
      window.cancelAnimationFrame(rafId);
      observer?.disconnect();
      window.removeEventListener('resize', onWindowResize);
    };
  }, [leftCollapsed, rightCollapsed, bottomCollapsed, measureAndSyncBounds]);

  // 4. Airspace / Z-Order visibility management
  const shouldBeVisible = computeBrowserChildVisibility({
    isTabActive,
    activeModalCount,
    zenMode,
    annotating,
    viewportWidth: viewportBounds.width,
    viewportHeight: viewportBounds.height,
  });

  useEffect(() => {
    void ipc.browserSetVisible(shouldBeVisible);
  }, [shouldBeVisible]);

  const handleNavigate = useCallback(
    async (rawUrl: string) => {
      setUrlError(null);
      try {
        const bounds = measureAndSyncBounds() ?? viewportBounds;
        const state = await ipc.browserNavigate(rawUrl, bounds);
        applyBrowserState(state);
      } catch (err) {
        setUrlError(err instanceof Error ? err.message : String(err));
      }
    },
    [applyBrowserState, measureAndSyncBounds, viewportBounds]
  );

  const handleStartAnnotation = useCallback(async () => {
    const bounds = measureAndSyncBounds() ?? viewportBounds;
    try {
      const snap = await ipc.browserCaptureSnapshot(bounds);
      setSnapshotDataUrl(snap.data_url ?? null);
    } catch {
      setSnapshotDataUrl(null);
    }
    setAnnotating(true);
  }, [measureAndSyncBounds, viewportBounds]);

  // 5. Alt+D keyboard shortcut to freeze & annotate
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.altKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'd') {
        if (!isTabActive) return;
        e.preventDefault();
        if (annotating) {
          setAnnotating(false);
        } else {
          void handleStartAnnotation();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isTabActive, annotating, handleStartAnnotation]);

  const handleGoBack = async () => {
    try {
      const state = await ipc.browserGoBack();
      applyBrowserState(state);
    } catch (err) {
      setUrlError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleGoForward = async () => {
    try {
      const state = await ipc.browserGoForward();
      applyBrowserState(state);
    } catch (err) {
      setUrlError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleReload = async () => {
    try {
      const state = await ipc.browserReload();
      applyBrowserState(state);
    } catch (err) {
      setUrlError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleOpenExternal = () => {
    window.open(currentUrl, '_blank', 'noopener,noreferrer');
  };

  return (
    <div className="browser-panel">
      <div className="browser-toolbar">
        <div className="browser-nav-buttons">
          <button
            type="button"
            className="btn-icon-xs"
            onClick={() => void handleGoBack()}
            disabled={!canGoBack || annotating}
            title={t('browser.back')}
            aria-label={t('browser.back')}
          >
            <ArrowLeftIcon size={14} />
          </button>
          <button
            type="button"
            className="btn-icon-xs"
            onClick={() => void handleGoForward()}
            disabled={!canGoForward || annotating}
            title={t('browser.forward')}
            aria-label={t('browser.forward')}
          >
            <ArrowRightIcon size={14} />
          </button>
          <button
            type="button"
            className={`btn-icon-xs ${loading ? 'spinning' : ''}`}
            onClick={() => void handleReload()}
            disabled={annotating}
            title={t('browser.reload')}
            aria-label={t('browser.reload')}
          >
            <RefreshIcon size={14} />
          </button>
        </div>

        <form
          className="browser-url-form"
          onSubmit={(e) => {
            e.preventDefault();
            void handleNavigate(urlInput);
          }}
        >
          <GlobeIcon size={13} className="browser-url-icon" />
          <input
            type="text"
            className="browser-url-bar"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            placeholder={t('browser.urlPlaceholder')}
            disabled={annotating}
          />
          <button type="submit" className="btn-secondary browser-go-btn" disabled={annotating}>
            {t('browser.go')}
          </button>
        </form>

        <div className="browser-bookmarks">
          {QUICK_BOOKMARKS.map((bm) => (
            <button
              key={bm.url}
              type="button"
              className={`browser-bookmark-pill ${currentUrl.startsWith(bm.url) ? 'active' : ''}`}
              onClick={() => void handleNavigate(bm.url)}
              disabled={annotating}
            >
              {bm.label}
            </button>
          ))}
        </div>

        <span className="browser-security-badge">{t('browser.securityBadge')}</span>

        <button
          type="button"
          className={`btn-primary browser-annotate-btn ${annotating ? 'active' : ''}`}
          onClick={() => {
            if (annotating) {
              setAnnotating(false);
            } else {
              void handleStartAnnotation();
            }
          }}
          title={t('browser.annotateTooltip')}
        >
          <CameraIcon size={14} />
          <span>{t('browser.annotate')}</span>
        </button>

        <button
          type="button"
          className="btn-icon-xs"
          onClick={handleOpenExternal}
          title={t('browser.openExternal')}
          aria-label={t('browser.openExternal')}
        >
          <ExternalLinkIcon size={14} />
        </button>
      </div>

      {urlError && <div className="browser-error-banner">{urlError}</div>}

      <div ref={viewportRef} className="browser-viewport-container">
        {annotating ? (
          <AnnotationCanvas
            snapshotDataUrl={snapshotDataUrl}
            sourceUrl={currentUrl}
            width={viewportBounds.width}
            height={viewportBounds.height}
            onCancel={() => setAnnotating(false)}
            onSentToChat={() => setAnnotating(false)}
          />
        ) : !shouldBeVisible ? (
          <div className="browser-airspace-placeholder">
            <GlobeIcon size={24} />
            <p>{t('browser.hiddenByAirspace')}</p>
          </div>
        ) : (
          <div className="browser-live-placeholder">
            <GlobeIcon size={20} />
            <span>
              {t('browser.liveViewportHint', {
                width: viewportBounds.width,
                height: viewportBounds.height,
              })}
            </span>
            <code>{currentUrl}</code>
          </div>
        )}
      </div>
    </div>
  );
};
