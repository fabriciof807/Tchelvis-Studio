import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';
import { safeConvertFileSrc } from '../types/ipc';

class InlineImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string
  ) {
    super();
  }

  eq(other: InlineImageWidget): boolean {
    return other.src === this.src && other.alt === this.alt;
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'cm-live-image-wrap';
    const img = document.createElement('img');
    img.src = this.src;
    img.alt = this.alt;
    img.className = 'md-preview-img';
    wrap.appendChild(img);
    return wrap;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

class BulletWidget extends WidgetType {
  constructor(readonly checked: boolean | null) {
    super();
  }

  eq(other: BulletWidget): boolean {
    return other.checked === this.checked;
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span');
    if (this.checked === null) {
      span.className = 'cm-live-bullet';
      span.textContent = '•';
    } else {
      span.className = `cm-live-checkbox ${this.checked ? 'checked' : ''}`;
      span.textContent = this.checked ? '☑' : '☐';
    }
    return span;
  }
}

export const OBSIDIAN_IMG_REGEX =
  /!\[\[([^\]|]+?\.(?:png|jpe?g|webp|gif|svg|avif|bmp))(?:\|([^\]]*))?\]\]/gi;
export const MARKDOWN_IMG_REGEX = /!\[([^\]]*)\]\(([^)]+)\)/g;
export const WIKILINK_REGEX = /(?<!!)\[\[([^\]]+)\]\]/g;

export interface ParsedImageEmbed {
  index: number;
  length: number;
  src: string;
  alt: string;
}

export function findImageEmbedsInLine(text: string): ParsedImageEmbed[] {
  const results: ParsedImageEmbed[] = [];
  const mdRegex = new RegExp(MARKDOWN_IMG_REGEX.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = mdRegex.exec(text)) !== null) {
    results.push({ index: m.index, length: m[0].length, alt: m[1] ?? '', src: m[2] ?? '' });
  }
  const obsRegex = new RegExp(OBSIDIAN_IMG_REGEX.source, 'gi');
  while ((m = obsRegex.exec(text)) !== null) {
    results.push({
      index: m.index,
      length: m[0].length,
      src: (m[1] ?? '').trim(),
      alt: (m[2] ?? m[1] ?? '').trim(),
    });
  }
  return results;
}

function resolveImageUrl(rawSrc: string, workspaceRoot?: string): string {
  const trimmed = rawSrc.trim();
  if (
    trimmed.startsWith('http://') ||
    trimmed.startsWith('https://') ||
    trimmed.startsWith('data:') ||
    trimmed.startsWith('blob:')
  ) {
    return trimmed;
  }
  const abs =
    workspaceRoot && !trimmed.startsWith('/')
      ? `${workspaceRoot}/${trimmed.replace(/^\.\//, '')}`
      : trimmed;
  return safeConvertFileSrc(abs);
}

interface DecoItem {
  from: number;
  to: number;
  deco: Decoration;
}

function buildLiveDecorations(view: EditorView, workspaceRoot?: string): DecorationSet {
  const doc = view.state.doc;
  const activeLines = new Set<number>();
  for (const range of view.state.selection.ranges) {
    const startLine = doc.lineAt(range.from).number;
    const endLine = doc.lineAt(range.to).number;
    for (let ln = startLine; ln <= endLine; ln += 1) {
      activeLines.add(ln);
    }
  }

  const items: DecoItem[] = [];
  let inCodeBlock = false;

  // Track code block state up to visible start
  const firstVisible = view.visibleRanges[0]?.from ?? 0;
  const firstLineNum = doc.lineAt(firstVisible).number;
  for (let ln = 1; ln < firstLineNum; ln += 1) {
    const text = doc.line(ln).text;
    if (text.trimStart().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
    }
  }

  const seenLines = new Set<number>();

  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = doc.lineAt(pos);
      if (seenLines.has(line.number)) {
        pos = line.to + 1;
        continue;
      }
      seenLines.add(line.number);

      const text = line.text;
      const isCursorLine = activeLines.has(line.number);

      if (text.trimStart().startsWith('```')) {
        inCodeBlock = !inCodeBlock;
        items.push({
          from: line.from,
          to: line.from,
          deco: Decoration.line({ class: 'cm-live-codeblock cm-live-fence' }),
        });
        pos = line.to + 1;
        continue;
      }

      if (inCodeBlock) {
        items.push({
          from: line.from,
          to: line.from,
          deco: Decoration.line({ class: 'cm-live-codeblock' }),
        });
        pos = line.to + 1;
        continue;
      }

      // Headings (# to ######)
      const headingMatch = /^(#{1,6})\s+/.exec(text);
      if (headingMatch) {
        const level = headingMatch[1].length;
        items.push({
          from: line.from,
          to: line.from,
          deco: Decoration.line({ class: `cm-live-h${level}` }),
        });
        if (!isCursorLine) {
          items.push({
            from: line.from,
            to: line.from + headingMatch[0].length,
            deco: Decoration.replace({}),
          });
        } else {
          items.push({
            from: line.from,
            to: line.from + headingMatch[0].length,
            deco: Decoration.mark({ class: 'cm-live-syntax' }),
          });
        }
      }

      // Blockquote
      const quoteMatch = /^>\s?/.exec(text);
      if (quoteMatch) {
        items.push({
          from: line.from,
          to: line.from,
          deco: Decoration.line({ class: 'cm-live-quote' }),
        });
        if (!isCursorLine) {
          items.push({
            from: line.from,
            to: line.from + quoteMatch[0].length,
            deco: Decoration.replace({}),
          });
        }
      }

      // Horizontal rule
      if (/^(\s*)(---|\*\*\*|___)\s*$/.test(text) && !isCursorLine) {
        items.push({
          from: line.from,
          to: line.from,
          deco: Decoration.line({ class: 'cm-live-hr-line' }),
        });
        items.push({
          from: line.from,
          to: line.to,
          deco: Decoration.mark({ class: 'cm-live-syntax' }),
        });
      }

      // Task checkbox or unordered bullet
      const taskMatch = /^(\s*)-\s\[([ xX])\]\s/.exec(text);
      if (taskMatch && !isCursorLine) {
        const prefixStart = line.from + taskMatch[1].length;
        const prefixEnd = line.from + taskMatch[0].length - 1;
        items.push({
          from: prefixStart,
          to: prefixEnd,
          deco: Decoration.replace({
            widget: new BulletWidget(taskMatch[2].toLowerCase() === 'x'),
          }),
        });
      } else {
        const bulletMatch = /^(\s*)[-*]\s/.exec(text);
        if (bulletMatch && !isCursorLine && !headingMatch) {
          const prefixStart = line.from + bulletMatch[1].length;
          const prefixEnd = line.from + bulletMatch[0].length - 1;
          items.push({
            from: prefixStart,
            to: prefixEnd,
            deco: Decoration.replace({ widget: new BulletWidget(null) }),
          });
        }
      }

      // Inline image widgets: ![alt](src) and Obsidian ![[path.png|alt]]
      for (const embed of findImageEmbedsInLine(text)) {
        const mFrom = line.from + embed.index;
        const mTo = mFrom + embed.length;
        const resolved = resolveImageUrl(embed.src, workspaceRoot);
        if (!isCursorLine) {
          items.push({
            from: mFrom,
            to: mTo,
            deco: Decoration.replace({
              widget: new InlineImageWidget(resolved, embed.alt),
            }),
          });
        }
      }

      if (!isCursorLine) {
        // Bold **text**
        const boldRegex = /\*\*([^*]+)\*\*/g;
        let m: RegExpExecArray | null;
        while ((m = boldRegex.exec(text)) !== null) {
          const start = line.from + m.index;
          const end = start + m[0].length;
          items.push({ from: start, to: start + 2, deco: Decoration.replace({}) });
          items.push({
            from: start + 2,
            to: end - 2,
            deco: Decoration.mark({ class: 'cm-live-bold' }),
          });
          items.push({ from: end - 2, to: end, deco: Decoration.replace({}) });
        }

        // Italic *text*
        const italicRegex = /(?<!\*)\*([^*]+)\*(?!\*)/g;
        while ((m = italicRegex.exec(text)) !== null) {
          const start = line.from + m.index;
          const end = start + m[0].length;
          items.push({ from: start, to: start + 1, deco: Decoration.replace({}) });
          items.push({
            from: start + 1,
            to: end - 1,
            deco: Decoration.mark({ class: 'cm-live-italic' }),
          });
          items.push({ from: end - 1, to: end, deco: Decoration.replace({}) });
        }

        // Strikethrough ~~text~~
        const strikeRegex = /~~([^~]+)~~/g;
        while ((m = strikeRegex.exec(text)) !== null) {
          const start = line.from + m.index;
          const end = start + m[0].length;
          items.push({ from: start, to: start + 2, deco: Decoration.replace({}) });
          items.push({
            from: start + 2,
            to: end - 2,
            deco: Decoration.mark({ class: 'cm-live-strike' }),
          });
          items.push({ from: end - 2, to: end, deco: Decoration.replace({}) });
        }

        // Inline `code`
        const codeRegex = /`([^`]+)`/g;
        while ((m = codeRegex.exec(text)) !== null) {
          const start = line.from + m.index;
          const end = start + m[0].length;
          items.push({ from: start, to: start + 1, deco: Decoration.replace({}) });
          items.push({
            from: start + 1,
            to: end - 1,
            deco: Decoration.mark({ class: 'cm-live-code' }),
          });
          items.push({ from: end - 1, to: end, deco: Decoration.replace({}) });
        }

        // Wikilinks [[target]] or [[target|alias]] (negative lookbehind avoids ![[...]])
        const wikiRegex = new RegExp(WIKILINK_REGEX.source, 'g');
        while ((m = wikiRegex.exec(text)) !== null) {
          const start = line.from + m.index;
          const end = start + m[0].length;
          const inner = m[1];
          const parts = inner.split('|');
          const target = (parts[0] ?? '').trim();
          const hasAlias = parts.length > 1;
          const aliasOffset = hasAlias ? parts[0].length + 1 : 0;

          items.push({
            from: start,
            to: start + 2 + aliasOffset,
            deco: Decoration.replace({}),
          });
          items.push({
            from: start + 2 + aliasOffset,
            to: end - 2,
            deco: Decoration.mark({
              class: 'cm-live-wikilink',
              attributes: { 'data-wikilink': target },
            }),
          });
          items.push({ from: end - 2, to: end, deco: Decoration.replace({}) });
        }
      }

      pos = line.to + 1;
    }
  }

  // RangeSetBuilder requires ascending `from` (and `to` for same `from`, with line decos first)
  items.sort((a, b) => a.from - b.from || a.to - b.to);

  const builder = new RangeSetBuilder<Decoration>();
  let lastFrom = -1;
  let lastTo = -1;
  for (const item of items) {
    // Avoid overlapping replace decorations that could violate CodeMirror invariants
    if (item.from < lastTo && item.from !== item.to && lastFrom !== lastTo) {
      continue;
    }
    builder.add(item.from, item.to, item.deco);
    if (item.from !== item.to) {
      lastFrom = item.from;
      lastTo = item.to;
    }
  }
  return builder.finish();
}

export function createMarkdownLivePreviewExtension(
  getWorkspaceRoot: () => string | undefined,
  onWikilinkClick: (target: string) => void
) {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = buildLiveDecorations(view, getWorkspaceRoot());
      }
      update(update: ViewUpdate) {
        if (update.docChanged || update.selectionSet || update.viewportChanged) {
          this.decorations = buildLiveDecorations(update.view, getWorkspaceRoot());
        }
      }
    },
    {
      decorations: (v) => v.decorations,
    }
  );

  const clickHandler = EditorView.domEventHandlers({
    mousedown(event) {
      const target = event.target as HTMLElement | null;
      const wikiEl = target?.closest<HTMLElement>('[data-wikilink]');
      if (wikiEl) {
        const linkTarget = wikiEl.getAttribute('data-wikilink');
        if (linkTarget) {
          event.preventDefault();
          onWikilinkClick(linkTarget);
          return true;
        }
      }
      return false;
    },
  });

  return [plugin, clickHandler];
}
