import type { FileTreeNode } from '../types/ipc';

export type WikilinkResolution =
  | { status: 'resolved'; relPath: string }
  | { status: 'collision'; matches: string[] }
  | { status: 'missing'; suggestedRelPath: string };

export interface MarkdownIndex {
  /** All normalized relative paths of .md files in the workspace */
  allPaths: string[];
  /** Lowercased basename (without .md) -> list of matching relPaths */
  byBasename: Map<string, string[]>;
  /** Lowercased full relPath (without .md) -> exact relPath */
  byNormalizedPath: Map<string, string>;
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/');
}

function stripMdExt(p: string): string {
  return p.toLowerCase().endsWith('.md') ? p.slice(0, -3) : p;
}

function getBasename(relPath: string): string {
  const parts = relPath.split('/');
  return parts[parts.length - 1] ?? relPath;
}

export function flattenMarkdownPaths(tree: FileTreeNode[]): string[] {
  const result: string[] = [];
  const walk = (nodes: FileTreeNode[]) => {
    for (const node of nodes) {
      if (node.is_dir) {
        if (node.children) walk(node.children);
      } else if (node.rel_path.toLowerCase().endsWith('.md')) {
        result.push(normalizePath(node.rel_path));
      }
    }
  };
  walk(tree);
  return result.sort();
}

export function buildMarkdownIndex(tree: FileTreeNode[]): MarkdownIndex {
  const allPaths = flattenMarkdownPaths(tree);
  const byBasename = new Map<string, string[]>();
  const byNormalizedPath = new Map<string, string>();

  for (const relPath of allPaths) {
    const noExt = stripMdExt(relPath).toLowerCase();
    byNormalizedPath.set(noExt, relPath);

    const baseNoExt = stripMdExt(getBasename(relPath)).toLowerCase();
    const existing = byBasename.get(baseNoExt) ?? [];
    existing.push(relPath);
    byBasename.set(baseNoExt, existing);
  }

  return { allPaths, byBasename, byNormalizedPath };
}

function resolveRelativeToCurrent(currentRelPath: string, target: string): string {
  const currentDirParts = normalizePath(currentRelPath).split('/').slice(0, -1);
  const targetParts = normalizePath(target).split('/');
  const combined = [...currentDirParts];
  for (const part of targetParts) {
    if (part === '.' || part === '') continue;
    if (part === '..') {
      combined.pop();
    } else {
      combined.push(part);
    }
  }
  return combined.join('/');
}

/**
 * Resolves a [[wikilink]] target:
 * 1. Exact/relative path match (relative to current file or workspace root)
 * 2. Unique filename match across workspace
 * 3. Collision list if multiple files share the filename
 * 4. Missing note with suggested relative path
 */
export function resolveWikilink(
  index: MarkdownIndex,
  rawTarget: string,
  currentRelPath?: string
): WikilinkResolution {
  // Strip optional alias ([[target|alias]]) and heading ([[target#heading]])
  const targetWithoutAlias = rawTarget.split('|')[0]?.split('#')[0]?.trim() ?? '';
  if (!targetWithoutAlias) {
    return { status: 'missing', suggestedRelPath: 'nota-sem-nome.md' };
  }

  const normalizedTarget = normalizePath(targetWithoutAlias);
  const targetNoExtLower = stripMdExt(normalizedTarget).toLowerCase();

  // 1a. Relative path match from current file's directory
  if (currentRelPath) {
    const relCandidate = resolveRelativeToCurrent(currentRelPath, normalizedTarget);
    const relKey = stripMdExt(relCandidate).toLowerCase();
    const relMatch = index.byNormalizedPath.get(relKey);
    if (relMatch) {
      return { status: 'resolved', relPath: relMatch };
    }
  }

  // 1b. Workspace-root path match
  const rootMatch = index.byNormalizedPath.get(targetNoExtLower);
  if (rootMatch) {
    return { status: 'resolved', relPath: rootMatch };
  }

  // 2 & 3. Filename match (only when target has no slash, or fallback on basename)
  const baseKey = stripMdExt(getBasename(normalizedTarget)).toLowerCase();
  const baseMatches = index.byBasename.get(baseKey);
  if (baseMatches && baseMatches.length === 1) {
    return { status: 'resolved', relPath: baseMatches[0] };
  }
  if (baseMatches && baseMatches.length > 1) {
    return { status: 'collision', matches: [...baseMatches] };
  }

  // 4. Missing note
  const withExt = normalizedTarget.toLowerCase().endsWith('.md')
    ? normalizedTarget
    : `${normalizedTarget}.md`;
  const suggestedRelPath =
    !normalizedTarget.includes('/') && currentRelPath
      ? resolveRelativeToCurrent(currentRelPath, withExt)
      : withExt;

  return { status: 'missing', suggestedRelPath };
}

export function getWikilinkCompletions(
  index: MarkdownIndex,
  prefix: string
): Array<{ label: string; detail: string; apply: string }> {
  const q = prefix.toLowerCase();
  const items: Array<{ label: string; detail: string; apply: string }> = [];

  for (const relPath of index.allPaths) {
    const baseNoExt = stripMdExt(getBasename(relPath));
    const pathNoExt = stripMdExt(relPath);
    if (!q || baseNoExt.toLowerCase().includes(q) || pathNoExt.toLowerCase().includes(q)) {
      const hasCollision = (index.byBasename.get(baseNoExt.toLowerCase())?.length ?? 0) > 1;
      items.push({
        label: hasCollision ? pathNoExt : baseNoExt,
        detail: relPath,
        apply: hasCollision ? pathNoExt : baseNoExt,
      });
    }
  }

  return items;
}
