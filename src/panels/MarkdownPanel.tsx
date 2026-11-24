import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, keymap, highlightActiveLine } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { autocompletion, type CompletionContext } from '@codemirror/autocomplete';
import type { IDockviewPanelProps } from 'dockview-react';
import {
  ipc,
  listenEvent,
  type FsChangedPayload,
} from '../types/ipc';
import { useWorkspaceStore } from '../store/workspaceStore';
import { useI18n } from '../i18n/useI18n';
import {
  buildMarkdownIndex,
  getWikilinkCompletions,
  resolveWikilink,
} from './markdownIndex';
import { createMarkdownLivePreviewExtension } from './markdownLivePreview';

export interface MarkdownPanelParams {
  relPath: string;
}

const editorTheme = EditorView.theme(
  {
    '&': {
      height: '100%',
      backgroundColor: '#11141d',
      color: '#e2e8f0',
      fontSize: '14.5px',
      fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    },
    '.cm-scroller': {
      overflow: 'auto',
    },
    '.cm-content': {
      maxWidth: '820px',
      margin: '0 auto',
      padding: '24px 28px 64px',
      lineHeight: '1.7',
      caretColor: '#60a5fa',
    },
    '.cm-line': {
      padding: '1px 0',
    },
    '.cm-activeLine': {
      backgroundColor: 'rgba(59, 130, 246, 0.06)',
      borderRadius: '4px',
    },
    '.cm-cursor': {
      borderLeftColor: '#60a5fa',
      borderLeftWidth: '2px',
    },
    '.cm-tooltip.cm-tooltip-autocomplete': {
      backgroundColor: '#1c202b',
      border: '1px solid #334155',
      color: '#e2e8f0',
    },
  },
  { dark: true }
);

export const MarkdownPanel: React.FC<IDockviewPanelProps<MarkdownPanelParams>> = ({
  params,
}) => {
  const relPath = params.relPath;
  const fileTree = useWorkspaceStore((s) => s.fileTree);
  const workspace = useWorkspaceStore((s) => s.workspace);
  const markDirty = useWorkspaceStore((s) => s.markDirty);
  const { t } = useI18n();
  const registerOpenTab = useWorkspaceStore((s) => s.registerOpenTab);
  const unregisterOpenTab = useWorkspaceStore((s) => s.unregisterOpenTab);
  const requestOpenPanel = useWorkspaceStore((s) => s.requestOpenPanel);
  const refreshFileTree = useWorkspaceStore((s) => s.refreshFileTree);

  const [content, setContent] = useState<string>('');
  const [savedContent, setSavedContent] = useState<string>('');
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [externalConflict, setExternalConflict] = useState<boolean>(false);
  const [collisionChoices, setCollisionChoices] = useState<string[] | null>(null);
  const [missingTarget, setMissingTarget] = useState<string | null>(null);

  const editorContainerRef = useRef<HTMLDivElement | null>(null);
  const editorViewRef = useRef<EditorView | null>(null);
  const autocompleteCompartment = useRef(new Compartment());

  const savedSha256Ref = useRef<string>('');
  const savedContentRef = useRef<string>('');
  const currentContentRef = useRef<string>('');
  const isDirtyRef = useRef<boolean>(false);
  const workspaceRootRef = useRef<string | undefined>(workspace?.root_path);
  workspaceRootRef.current = workspace?.root_path;

  const markdownIndex = useMemo(() => buildMarkdownIndex(fileTree), [fileTree]);
  const markdownIndexRef = useRef(markdownIndex);
  markdownIndexRef.current = markdownIndex;

  const isDirty = content !== savedContent;
  isDirtyRef.current = isDirty;

  useEffect(() => {
    registerOpenTab(relPath);
    return () => {
      unregisterOpenTab(relPath);
    };
  }, [relPath, registerOpenTab, unregisterOpenTab]);

  useEffect(() => {
    markDirty(relPath, isDirty);
  }, [relPath, isDirty, markDirty]);

  const loadFromDisk = useCallback(async () => {
    setIsLoading(true);
    setErrorMsg(null);
    try {
      const res = await ipc.readMarkdownFile(relPath);
      savedSha256Ref.current = res.sha256;
      savedContentRef.current = res.content;
      currentContentRef.current = res.content;
      setSavedContent(res.content);
      setContent(res.content);
      setExternalConflict(false);

      if (editorViewRef.current) {
        const view = editorViewRef.current;
        const currentDoc = view.state.doc.toString();
        if (currentDoc !== res.content) {
          view.dispatch({
            changes: { from: 0, to: currentDoc.length, insert: res.content },
          });
        }
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  }, [relPath]);

  useEffect(() => {
    void loadFromDisk();
  }, [loadFromDisk]);

  const handleSave = useCallback(async () => {
    const textToSave = currentContentRef.current;
    try {
      const ack = await ipc.writeMarkdownFile(relPath, textToSave);
      savedSha256Ref.current = ack.sha256;
      savedContentRef.current = textToSave;
      setSavedContent(textToSave);
      setExternalConflict(false);
    } catch (err) {
      setErrorMsg(`Falha ao salvar: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [relPath]);

  const handleSaveRef = useRef(handleSave);
  handleSaveRef.current = handleSave;

  const handleWikilinkClick = useCallback(
    (rawTarget: string) => {
      setCollisionChoices(null);
      setMissingTarget(null);
      const resolution = resolveWikilink(markdownIndexRef.current, rawTarget, relPath);
      if (resolution.status === 'resolved') {
        const title = resolution.relPath.split('/').pop() ?? resolution.relPath;
        requestOpenPanel('markdown', title, { relPath: resolution.relPath });
      } else if (resolution.status === 'collision') {
        setCollisionChoices(resolution.matches);
      } else {
        setMissingTarget(resolution.suggestedRelPath);
      }
    },
    [relPath, requestOpenPanel]
  );

  const handleWikilinkClickRef = useRef(handleWikilinkClick);
  handleWikilinkClickRef.current = handleWikilinkClick;

  // Listen to external FS changes
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listenEvent<FsChangedPayload>('fs://changed', (payload) => {
      if (payload.rel_path !== relPath) return;
      if (payload.sha256 && payload.sha256 === savedSha256Ref.current) {
        return;
      }
      if (!isDirtyRef.current) {
        void loadFromDisk();
      } else {
        setExternalConflict(true);
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, [relPath, loadFromDisk]);

  // Initialize unified Obsidian-style Live Preview CodeMirror editor
  useEffect(() => {
    if (isLoading || !editorContainerRef.current) return;
    if (editorViewRef.current) {
      editorViewRef.current.destroy();
      editorViewRef.current = null;
    }

    const wikilinkCompletionSource = (ctx: CompletionContext) => {
      const match = ctx.matchBefore(/\[\[[^\]]*$/);
      if (!match) return null;
      const query = match.text.slice(2);
      const options = getWikilinkCompletions(markdownIndexRef.current, query).map((item) => ({
        label: item.label,
        detail: item.detail,
        apply: `${item.apply}]]`,
      }));
      return {
        from: match.from + 2,
        options,
      };
    };

    const startState = EditorState.create({
      doc: currentContentRef.current,
      extensions: [
        highlightActiveLine(),
        markdown(),
        editorTheme,
        EditorView.lineWrapping,
        createMarkdownLivePreviewExtension(
          () => workspaceRootRef.current,
          (target) => handleWikilinkClickRef.current(target)
        ),
        autocompleteCompartment.current.of(
          autocompletion({ override: [wikilinkCompletionSource] })
        ),
        keymap.of([
          {
            key: 'Mod-s',
            run: () => {
              void handleSaveRef.current();
              return true;
            },
          },
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            const nextText = update.state.doc.toString();
            currentContentRef.current = nextText;
            setContent(nextText);
          }
        }),
      ],
    });

    const view = new EditorView({
      state: startState,
      parent: editorContainerRef.current,
    });
    editorViewRef.current = view;

    return () => {
      view.destroy();
      editorViewRef.current = null;
    };
  }, [isLoading, relPath]);

  const handleCreateMissingNote = useCallback(async () => {
    if (!missingTarget) return;
    const title = missingTarget.split('/').pop()?.replace(/\.md$/i, '') ?? 'Nova Nota';
    await ipc.writeMarkdownFile(missingTarget, `# ${title}\n\n`);
    await refreshFileTree();
    setMissingTarget(null);
    requestOpenPanel('markdown', `${title}.md`, { relPath: missingTarget });
  }, [missingTarget, refreshFileTree, requestOpenPanel]);

  return (
    <div className="panel-shell">
      <div className="panel-toolbar">
        <div className="panel-toolbar-left">
          <span className="file-badge" title={relPath}>
            {relPath}
          </span>
          {isDirty && <span className="dirty-pill">Modificado</span>}
        </div>
        <div className="panel-toolbar-right">
          <button
            type="button"
            className="btn-primary-sm"
            disabled={!isDirty}
            onClick={() => void handleSave()}
            title={t('md.save')}
          >
            {t('md.save')}
          </button>
        </div>
      </div>

      {externalConflict && (
        <div className="banner-warning">
          <span>{t('md.externalConflict')}</span>
          <div className="banner-actions">
            <button type="button" className="btn-warn-sm" onClick={() => void loadFromDisk()}>
              {t('md.reloadFromDisk')}
            </button>
            <button
              type="button"
              className="btn-ghost-sm"
              onClick={() => setExternalConflict(false)}
            >
              {t('md.keepBuffer')}
            </button>
          </div>
        </div>
      )}

      {collisionChoices && (
        <div className="banner-info">
          <span>{t('md.collisionTitle', { target: '' })}</span>
          <div className="banner-actions">
            {collisionChoices.map((choice) => (
              <button
                key={choice}
                type="button"
                className="btn-ghost-sm"
                onClick={() => {
                  setCollisionChoices(null);
                  requestOpenPanel('markdown', choice.split('/').pop() ?? choice, {
                    relPath: choice,
                  });
                }}
              >
                {choice}
              </button>
            ))}
            <button
              type="button"
              className="btn-ghost-sm"
              onClick={() => setCollisionChoices(null)}
            >
              {t('md.cancel')}
            </button>
          </div>
        </div>
      )}

      {missingTarget && (
        <div className="banner-info">
          <span>
            Nota <code>{missingTarget}</code> ainda não existe.
          </span>
          <div className="banner-actions">
            <button
              type="button"
              className="btn-primary-sm"
              onClick={() => void handleCreateMissingNote()}
            >
              Criar nota
            </button>
            <button
              type="button"
              className="btn-ghost-sm"
              onClick={() => setMissingTarget(null)}
            >
              {t('md.cancel')}
            </button>
          </div>
        </div>
      )}

      {errorMsg && <div className="banner-error">{errorMsg}</div>}

      {isLoading ? (
        <div className="panel-empty">{t('md.loading', { path: relPath })}</div>
      ) : (
        <div className="markdown-body">
          <div ref={editorContainerRef} className="markdown-editor-pane cm-live-preview" />
        </div>
      )}
    </div>
  );
};
