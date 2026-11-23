import { describe, expect, it, vi } from 'vitest';
import {
  createLensMessageHandler,
  injectLensCsp,
  LENS_CSP_META,
  MAX_LENS_READ_BYTES,
  processLensBridgeRequest,
  validateSafeRelPath,
} from '../panels/CustomLensPanel';

describe('CustomLensPanel security bridge', () => {
  it('injects strict CSP meta tag into HTML head', () => {
    const html = '<html><head><title>Test</title></head><body><h1>Hi</h1></body></html>';
    const injected = injectLensCsp(html);
    expect(injected).toContain(LENS_CSP_META);
  });

  it('rejects path traversal and absolute paths', () => {
    expect(() => validateSafeRelPath('../etc/passwd')).toThrow();
    expect(() => validateSafeRelPath('gdd/../../secret.md')).toThrow();
    expect(() => validateSafeRelPath('/etc/passwd')).toThrow();
    expect(() => validateSafeRelPath('C:\\secret.txt')).toThrow();
    expect(validateSafeRelPath('gdd/01-visao-geral.md')).toBe('gdd/01-visao-geral.md');
  });

  it('rejects hub:readFile payloads exceeding 1 MiB UTF-8 limit', async () => {
    const oversized = 'a'.repeat(MAX_LENS_READ_BYTES + 1);
    const res = await processLensBridgeRequest(
      { id: '1', method: 'hub:readFile', params: { rel_path: 'gdd/big.md' } },
      {
        readFile: async () => oversized,
        listFiles: async () => ['gdd/big.md'],
      }
    );
    expect(res.error).toContain('1 MiB');
    expect(res.result).toBeUndefined();
  });

  it('ignores postMessage events whose source is not iframe.contentWindow', async () => {
    const fakeIframeWindow = { postMessage: vi.fn() } as unknown as Window;
    const rogueSource = { postMessage: vi.fn() } as unknown as Window;
    const readFileSpy = vi.fn(async () => 'ok');
    const listFilesSpy = vi.fn(async () => ['a.md']);

    const handler = createLensMessageHandler(() => fakeIframeWindow, {
      readFile: readFileSpy,
      listFiles: listFilesSpy,
    });

    // Rogue event source must be ignored
    await handler({
      source: rogueSource,
      data: { id: 'req-1', method: 'hub:listFiles' },
    } as unknown as MessageEvent);

    expect(listFilesSpy).not.toHaveBeenCalled();
    expect(fakeIframeWindow.postMessage).not.toHaveBeenCalled();

    // Valid event source must be processed and replied to
    await handler({
      source: fakeIframeWindow,
      data: { id: 'req-2', method: 'hub:listFiles' },
    } as unknown as MessageEvent);

    expect(listFilesSpy).toHaveBeenCalledTimes(1);
    expect(fakeIframeWindow.postMessage).toHaveBeenCalledWith(
      { id: 'req-2', method: 'hub:listFiles', result: ['a.md'] },
      '*'
    );
  });
});
