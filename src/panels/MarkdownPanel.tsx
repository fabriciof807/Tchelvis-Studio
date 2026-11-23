import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { autocompletion, type CompletionContext } from '@codemirror/autocomplete';
import type { IDockviewPanelProps } from 'dockview-react';
import {
  ipc,
  listenEvent,
  safeConvertFileSrc,
  type FsChangedPayload,
} from '../types/ipc';
import { useWorkspaceStore } from '../store/workspaceStore';
import {
  buildMarkdownIndex,
  getWikilinkCompletions,
  resolveWikilink,
} from './markdownIndex';

type ViewMode = 'editor' | 'split' | 'preview';

export interface MarkdownPanelParams {
  relPath: string;
}

const editorTheme = EditorView.theme(
  {
    '&': {
      height: '100%',
      backgroundColor: '#13161f',
      color: '#e2e8f0',
      fontSize: '13.5px',
      fontFamily: '"JetBrains Mono", "Fira Code", ui-monospace, monospace',
    },
    '.cm-content': {
      padding: '14px 16px',
      caretColor: '#60a5fa',
    },
    '.cm-gutters': {
      backgroundColor: '#10131b',
      color: '#64748b',
      borderRight: '1px solid #232836',
    },
    '.cm-activeLine': {
      backgroundColor: '#1b2030',
    },
    '.cm-cursor': {
      borderLeftColor: '#60a5fa',
    },
    '.cm-tooltip.cm-tooltip-autocomplete': {
      backgroundColor: '#1c202b',
      border: '1px solid #334155',
      color: '#e2e8f0',
    },
  },
  { dark: true }
);

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderMarkdownPreview(
  source: string,
  workspaceRoot: string | undefined
): string {
  const lines = source.split('\n');
  const htmlParts: string[] = [];
  let inCodeBlock = false;
  let inList = false;

  const closeList = () => {
    if (inList) {
      htmlParts.push('</ul>');
      inList = false;
    }
  };

  const formatInline = (text: string): string => {
    let out = escapeHtml(text);
    // Images: ![alt](src)
    out = out.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt, src) => {
      const trimmedSrc = String(src).trim();
      const resolvedSrc =
        trimmedSrc.startsWith('http://') ||
        trimmedSrc.startsWith('https://') ||
        trimmedSrc.startsWith('data:')
          ? trimmedSrc
          : safeConvertFileSrc(
              workspaceRoot && !trimmedSrc.startsWith('/')
                ? `${workspaceRoot}/${trimmedSrc.replace(/^\.\//, '')}`
                : trimmedSrc
            );
      return `<img src="${escapeHtml(resolvedSrc)}" alt="${escapeHtml(
        String(alt)
      )}" class="md-preview-img" />`;
    });
    // Links: [label](url)
    out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, url) => {
      return `<a href="${escapeHtml(String(url))}" target="_blank" rel="noreferrer" class="md-ext-link">${label}</a>`;
    });
    // Wikilinks: [[target]] or [[target|alias]]
    out = out.replace(/\[\[([^\]]+)\]\]/g, (_m, inner) => {
      const parts = String(inner).split('|');
      const target = parts[0]?.trim() ?? '';
      const label = (parts[1] ?? parts[0] ?? '').trim();
      return `<button type="button" class="md-wikilink" data-wikilink="${escapeHtml(
        target
      )}">[[${escapeHtml(label)}]]</button>`;
    });
    // Inline code
    out = out.replace(/`([^`]+)`/g, '<code class="md-inline-code">$1</code>');
    // Bold & italic
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    return out;
  };

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      closeList();
      if (!inCodeBlock) {
        inCodeBlock = true;
        htmlParts.push('<pre class="md-code-block"><code>');
      } else {
        inCodeBlock = false;
        htmlParts.push('</code></pre>');
      }
      continue;
    }

    if (inCodeBlock) {
      htmlParts.push(`${escapeHtml(line)}\n`);
      continue;
    }

    const headingMatch = /^(#{1,6})\s+(.*)$/.exec(line);
    if (headingMatch) {
      closeList();
      const level = headingMatch[1].length;
      htmlParts.push(`<h${level} class="md-h${level}">${formatInline(headingMatch[2])}</h${level}>`);
      continue;
    }

    const listMatch = /^\s*[-*]\s+(.*)$/.exec(line);
    if (listMatch) {
      if (!inList) {
        htmlParts.push('<ul class="md-list">');
        inList = true;
      }
      htmlParts.push(`<li>${formatInline(listMatch[1])}</li>`);
      continue;
    }

    closeList();
    if (line.trim() === '') {
      htmlParts.push('<div class="md-spacer"></div>');
    } else {
      htmlParts.push(`<p class="md-p">${formatInline(line)}</p>`);
    }
  }

  closeList();
  if (inCodeBlock) {
    htmlParts.push('</code></pre>');
  }
  return htmlParts.join('\n');
}

export const MarkdownPanel: React.FC<IDockviewPanelProps<MarkdownPanelParams>> = ({
  params,
}) => {
  const relPath = params.relPath;
  const fileTree = useWorkspaceStore((s) => s.fileTree);
  const workspace = useWorkspaceStore((s) => s.workspace);
  const markDirty = useWorkspaceStore((s) => s.markDirty);
  const registerOpenTab = useWorkspaceStore((s) => s.registerOpenTab);
  const unregisterOpenTab = useWorkspaceStore((s) => s.unregisterOpenTab);
  const requestOpenPanel = useWorkspaceStore((s) => s.requestOpenPanel);
  const refreshFileTree = useWorkspaceStore((s) => s.refreshFileTree);

  const [viewMode, setViewMode] = useState<ViewMode>('split');
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

  // Listen to external FS changes
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listenEvent<FsChangedPayload>('fs://changed', (payload) => {
      if (payload.rel_path !== relPath) return;
      if (payload.sha256 && payload.sha256 === savedSha256Ref.current) {
        // Echo suppression
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

  // Initialize CodeMirror editor
  useEffect(() => {
    if (!editorContainerRef.current || viewMode === 'preview') return;
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
        lineNumbers(),
        highlightActiveLine(),
        markdown(),
        editorTheme,
        EditorView.lineWrapping,
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
  }, [viewMode, relPath]);

  const handleWikilinkClick = useCallback(
    (rawTarget: string) => {
      setCollisionChoices(null);
      setMissingTarget(null);
      const resolution = resolveWikilink(markdownIndex, rawTarget, relPath);
      if (resolution.status === 'resolved') {
        const title = resolution.relPath.split('/').pop() ?? resolution.relPath;
        requestOpenPanel('markdown', title, { relPath: resolution.relPath });
      } else if (resolution.status === 'collision') {
        setCollisionChoices(resolution.matches);
      } else {
        setMissingTarget(resolution.suggestedRelPath);
      }
    },
    [markdownIndex, relPath, requestOpenPanel]
  );

  const handleCreateMissingNote = useCallback(async () => {
    if (!missingTarget) return;
    const title = missingTarget.split('/').pop()?.replace(/\.md$/i, '') ?? 'Nova Nota';
    await ipc.writeMarkdownFile(missingTarget, `# ${title}\n\n`);
    await refreshFileTree();
    setMissingTarget(null);
    requestOpenPanel('markdown', `${title}.md`, { relPath: missingTarget });
  }, [missingTarget, refreshFileTree, requestOpenPanel]);

  const previewHtml = useMemo(
    () => renderMarkdownPreview(content, workspace?.root_path),
    [content, workspace?.root_path]
  );

  const handlePreviewClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const btn = target.closest<HTMLElement>('[data-wikilink]');
    if (btn) {
      const linkTarget = btn.getAttribute('data-wikilink');
      if (linkTarget) {
        handleWikilinkClick(linkTarget);
      }
    }
  };

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
          <div className="segmented-control">
            {(['editor', 'split', 'preview'] as ViewMode[]).map((mode) => (
              <button
                key={mode}
                type="button"
                className={viewMode === mode ? 'seg-btn active' : 'seg-btn'}
                onClick={() => setViewMode(mode)}
              >
                {mode === 'editor' ? 'Editor' : mode === 'split' ? 'Split' : 'Preview'}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="btn-primary-sm"
            disabled={!isDirty}
            onClick={() => void handleSave()}
            title="Salvar (Ctrl+S)"
          >
            Salvar
          </button>
        </div>
      </div>

      {externalConflict && (
        <div className="banner-warning">
          <span>Este arquivo foi alterado no disco enquanto você possui edições não salvas.</span>
          <div className="banner-actions">
            <button type="button" className="btn-warn-sm" onClick={() => void loadFromDisk()}>
              Recarregar do disco
            </button>
            <button
              type="button"
              className="btn-ghost-sm"
              onClick={() => setExternalConflict(false)}
            >
              Manter meu buffer
            </button>
          </div>
        </div>
      )}

      {collisionChoices && (
        <div className="banner-info">
          <span>Múltiplas notas encontradas para este wikilink:</span>
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
              Fechar
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
              Cancelar
            </button>
          </div>
        </div>
      )}

      {errorMsg && <div className="banner-error">{errorMsg}</div>}

      {isLoading ? (
        <div className="panel-empty">Carregando {relPath}...</div>
      ) : (
        <div className={`markdown-body mode-${viewMode}`}>
          {viewMode !== 'preview' && (
            <div ref={editorContainerRef} className="markdown-editor-pane" />
          )}
          {viewMode !== 'editor' && (
            <div
              className="markdown-preview-pane"
              onClick={handlePreviewClick}
              dangerouslySetInnerHTML={{ __html: previewHtml }}
            />
          )}
        </div>
      )}
    </div>
  );
};
