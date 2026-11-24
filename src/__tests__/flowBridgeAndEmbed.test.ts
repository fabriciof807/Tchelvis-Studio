import { describe, expect, it } from 'vitest';
import {
  findImageEmbedsInLine,
  WIKILINK_REGEX,
} from '../panels/markdownLivePreview';
import { ipc } from '../types/ipc';
import { useWorkspaceStore } from '../store/workspaceStore';

describe('markdownLivePreview image embeds vs wikilinks', () => {
  it('parses both ![alt](path) and ![[path.png]] without matching ![[...]] as wikilink', () => {
    const line =
      'Ref: ![ferreiro](world/personagens/img/ferreiro.png) e ![[world/personagens/img/espada.png|Espada]] e [[01-visao-geral]]';

    const embeds = findImageEmbedsInLine(line);
    expect(embeds).toHaveLength(2);
    expect(embeds[0]).toMatchObject({
      src: 'world/personagens/img/ferreiro.png',
      alt: 'ferreiro',
    });
    expect(embeds[1]).toMatchObject({
      src: 'world/personagens/img/espada.png',
      alt: 'Espada',
    });

    const wikiMatches = Array.from(line.matchAll(new RegExp(WIKILINK_REGEX.source, 'g'))).map(
      (m) => m[1]
    );
    expect(wikiMatches).toEqual(['01-visao-geral']);
  });
});

describe('flow bridge IPC and /flow chat command', () => {
  it('dispatches mock flow generation and /flow command in workspaceStore', async () => {
    const direct = await ipc.dispatchFlowGeneration({
      prompt: 'A pixel art dwarven forge',
      save_path: 'world/img/forge.png',
      aspect_ratio: '16:9',
    });
    expect(direct.status).toBe('OK');
    expect(direct.saved_path).toBe('world/img/forge.png');
    expect(direct.markdown_embed).toBe('![forge](world/img/forge.png)');
    expect(direct.obsidian_embed).toBe('![[world/img/forge.png]]');

    useWorkspaceStore.setState({ chatMessages: [] });
    await useWorkspaceStore
      .getState()
      .sendChatMessage('/flow world/img/knight.png armored knight concept');

    const msgs = useWorkspaceStore.getState().chatMessages;
    expect(msgs.length).toBeGreaterThanOrEqual(2);
    const last = msgs[msgs.length - 1];
    expect(last.role).toBe('assistant');
    expect(last.tool_calls?.[0]?.name).toBe('generate_flow_reference');
    expect(last.tool_calls?.[0]?.status).toBe('completed');
    expect(last.text).toContain('world/img/knight.png');
  });
});
