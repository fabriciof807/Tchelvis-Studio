import { describe, expect, it, vi } from 'vitest';
import {
  ipc,
  isAllowedBrowserUrl,
  normalizeAndValidateBrowserUrl,
} from '../types/ipc';
import { computeBrowserChildVisibility } from '../panels/BrowserPanel';
import {
  FALLBACK_PNG_BASE64,
  extractPngBase64FromCanvas,
  sendAnnotatedCaptureToChat,
} from '../panels/AnnotationCanvas';
import { useWorkspaceStore } from '../store/workspaceStore';
import { translate } from '../i18n';

describe('BrowserPanel URL Security & IPC Mock', () => {
  it('allows http/https and normalizes bare domains', () => {
    expect(isAllowedBrowserUrl('https://labs.google/fx/tools/flow')).toBe(true);
    expect(isAllowedBrowserUrl('http://localhost:5173')).toBe(true);
    expect(normalizeAndValidateBrowserUrl('labs.google/fx/tools/flow')).toBe(
      'https://labs.google/fx/tools/flow'
    );
    expect(normalizeAndValidateBrowserUrl('localhost:5173')).toBe('http://localhost:5173');
  });

  it('rejects forbidden schemes such as file://, javascript:, data:, tauri://, ipc://, about:', async () => {
    const dangerous = [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'tauri://localhost',
      'ipc://internal',
      'about:blank',
      '',
    ];
    for (const url of dangerous) {
      expect(isAllowedBrowserUrl(url)).toBe(false);
      await expect(ipc.browserNavigate(url)).rejects.toThrow();
    }
  });

  it('supports Back/Forward navigation and snapshot capture hiding visibility', async () => {
    const first = await ipc.browserNavigate('https://labs.google/fx/tools/flow', {
      x: 10,
      y: 20,
      width: 900,
      height: 600,
    });
    expect(first.initialized).toBe(true);
    expect(first.url).toBe('https://labs.google/fx/tools/flow');

    const second = await ipc.browserNavigate('https://docs.godotengine.org/en/stable/');
    expect(second.url).toBe('https://docs.godotengine.org/en/stable/');
    expect(second.can_go_back).toBe(true);
    expect(second.can_go_forward).toBe(false);

    const back = await ipc.browserGoBack();
    expect(back.url).toBe('https://labs.google/fx/tools/flow');
    expect(back.can_go_forward).toBe(true);

    const fwd = await ipc.browserGoForward();
    expect(fwd.url).toBe('https://docs.godotengine.org/en/stable/');

    const snap = await ipc.browserCaptureSnapshot({ x: 10, y: 20, width: 900, height: 600 });
    expect(snap.backend).toBe('mock_grim');
    expect(snap.data_url).toContain('data:image/png;base64,');

    const afterSnap = await ipc.browserGetState();
    expect(afterSnap.visible).toBe(false);
  });
});

describe('computeBrowserChildVisibility (Airspace / Z-Order)', () => {
  const baseInput = {
    isTabActive: true,
    activeModalCount: 0,
    zenMode: false,
    annotating: false,
    viewportWidth: 800,
    viewportHeight: 600,
  };

  it('returns true only when tab is active, no modals, not zen, not annotating, and sized >= 2x2', () => {
    expect(computeBrowserChildVisibility(baseInput)).toBe(true);
  });

  it('returns false when a modal is open, Zen Mode is active, tab is inactive, annotating, or too small', () => {
    expect(computeBrowserChildVisibility({ ...baseInput, activeModalCount: 1 })).toBe(false);
    expect(computeBrowserChildVisibility({ ...baseInput, zenMode: true })).toBe(false);
    expect(computeBrowserChildVisibility({ ...baseInput, isTabActive: false })).toBe(false);
    expect(computeBrowserChildVisibility({ ...baseInput, annotating: true })).toBe(false);
    expect(computeBrowserChildVisibility({ ...baseInput, viewportWidth: 1 })).toBe(false);
    expect(computeBrowserChildVisibility({ ...baseInput, viewportHeight: 0 })).toBe(false);
  });
});

describe('AnnotationCanvas -> Send to Chat Pipeline', () => {
  it('saves annotated PNG capture, appends oneShotAttachment, and opens Chat drawer', async () => {
    useWorkspaceStore.setState({
      oneShotAttachments: [],
      rightCollapsed: true,
      zenMode: true,
    });

    const saveSpy = vi.spyOn(ipc, 'saveCapture');
    const onSentToChat = vi.fn();

    // Verify fallback PNG extraction when canvas is null or returns empty data URL
    expect(extractPngBase64FromCanvas(null)).toBe(FALLBACK_PNG_BASE64);

    const relPath = await sendAnnotatedCaptureToChat({
      canvas: null,
      sourceUrl: 'https://labs.google/fx/tools/flow',
      userNote: 'Destacar iluminação lateral na cena',
      defaultNotePrefix: 'Captura anotada do BrowserPanel',
      onSentToChat,
    });

    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(relPath).toMatch(/^\.hub\/captures\/annotated-\d+\.png$/);

    const state = useWorkspaceStore.getState();
    expect(state.rightCollapsed).toBe(false);
    expect(state.zenMode).toBe(false);
    expect(state.oneShotAttachments).toHaveLength(1);
    expect(state.oneShotAttachments[0]).toEqual({
      type: 'annotated_capture',
      source_url: 'https://labs.google/fx/tools/flow',
      image_path: relPath,
      user_note: 'Destacar iluminação lateral na cena',
    });
    expect(onSentToChat).toHaveBeenCalledTimes(1);

    saveSpy.mockRestore();
  });

  it('provides BrowserPanel & Annotation i18n keys in pt-BR, en, and zh-CN', () => {
    expect(translate('pt-BR', 'browser.sendToChat')).toBe('Enviar para o Chat');
    expect(translate('en', 'browser.sendToChat')).toBe('Send to Chat');
    expect(translate('zh-CN', 'browser.sendToChat')).toBe('发送到 Chat');
    expect(translate('pt-BR', 'activity.browser')).toBe('Navegador de Referências & Anotação');
    expect(translate('en', 'activity.browser')).toBe('Reference Browser & Annotation');
    expect(translate('zh-CN', 'activity.browser')).toBe('参考浏览器与标注');
  });
});
