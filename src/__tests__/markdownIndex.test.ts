import { describe, expect, it } from 'vitest';
import {
  buildMarkdownIndex,
  getWikilinkCompletions,
  resolveWikilink,
} from '../panels/markdownIndex';
import type { FileTreeNode } from '../types/ipc';

const sampleTree: FileTreeNode[] = [
  {
    name: 'gdd',
    rel_path: 'gdd',
    is_dir: true,
    children: [
      { name: '01-visao-geral.md', rel_path: 'gdd/01-visao-geral.md', is_dir: false },
      { name: 'entrada.md', rel_path: 'gdd/entrada.md', is_dir: false },
    ],
  },
  {
    name: 'world',
    rel_path: 'world',
    is_dir: true,
    children: [
      {
        name: 'locais',
        rel_path: 'world/locais',
        is_dir: true,
        children: [
          { name: 'entrada.md', rel_path: 'world/locais/entrada.md', is_dir: false },
          { name: 'forja-cinza.md', rel_path: 'world/locais/forja-cinza.md', is_dir: false },
        ],
      },
    ],
  },
];

describe('markdownIndex', () => {
  it('resolves unique filename match across workspace', () => {
    const index = buildMarkdownIndex(sampleTree);
    const res = resolveWikilink(index, 'forja-cinza', 'gdd/01-visao-geral.md');
    expect(res).toEqual({ status: 'resolved', relPath: 'world/locais/forja-cinza.md' });
  });

  it('resolves relative path match from current file directory', () => {
    const index = buildMarkdownIndex(sampleTree);
    const res = resolveWikilink(index, './entrada', 'gdd/01-visao-geral.md');
    expect(res).toEqual({ status: 'resolved', relPath: 'gdd/entrada.md' });
  });

  it('returns collision list when multiple files share a basename', () => {
    const index = buildMarkdownIndex(sampleTree);
    const res = resolveWikilink(index, 'entrada', 'world/locais/forja-cinza.md');
    // Note: in world/locais/, ./entrada resolves relative to current directory first,
    // so test from root or gdd/01-visao-geral.md? Wait: gdd/01-visao-geral.md also has gdd/entrada.md.
    // From a file in another folder, e.g. brainstorm/00-inbox.md, [[entrada]] collides!
    const resFromOtherDir = resolveWikilink(index, 'entrada', 'brainstorm/00-inbox.md');
    expect(resFromOtherDir).toEqual({
      status: 'collision',
      matches: ['gdd/entrada.md', 'world/locais/entrada.md'],
    });
    expect(res.status).toBe('resolved');
  });

  it('resolves explicit path even when basename collides', () => {
    const index = buildMarkdownIndex(sampleTree);
    const res = resolveWikilink(index, 'world/locais/entrada|Entrada da Caverna');
    expect(res).toEqual({ status: 'resolved', relPath: 'world/locais/entrada.md' });
  });

  it('returns missing status with suggested path for nonexistent note', () => {
    const index = buildMarkdownIndex(sampleTree);
    const res = resolveWikilink(index, 'nova-mecanica', 'gdd/01-visao-geral.md');
    expect(res).toEqual({
      status: 'missing',
      suggestedRelPath: 'gdd/nova-mecanica.md',
    });
  });

  it('provides disambiguated completions for colliding filenames', () => {
    const index = buildMarkdownIndex(sampleTree);
    const completions = getWikilinkCompletions(index, 'entrada');
    expect(completions.map((c) => c.apply)).toEqual(['gdd/entrada', 'world/locais/entrada']);
  });
});
