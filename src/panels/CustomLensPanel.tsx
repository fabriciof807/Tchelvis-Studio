import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { ipc, listenEvent, type FsChangedPayload } from '../types/ipc';
import { useWorkspaceStore } from '../store/workspaceStore';

export const MAX_LENS_READ_BYTES = 1024 * 1024; // 1 MiB UTF-8 limit
export const LENS_CSP_META =
  '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; img-src \'self\' data: asset:;">';

export interface CustomLensPanelParams {
  lensId: string;
  title?: string;
}

export interface LensBridgeRequest {
  id: string | number;
  method: 'hub:readFile' | 'hub:listFiles' | string;
  params?: Record<string, unknown>;
}

export interface LensBridgeResponse {
  id: string | number;
  method: string;
  result?: unknown;
  error?: string;
}

export function injectLensCsp(rawHtml: string): string {
  if (/<head[^>]*>/i.test(rawHtml)) {
    return rawHtml.replace(/<head[^>]*>/i, (match) => `${match}\n  ${LENS_CSP_META}`);
  }
  return `<!doctype html><html><head>${LENS_CSP_META}</head><body>${rawHtml}</body></html>`;
}

export function validateSafeRelPath(relPath: unknown): string {
  if (typeof relPath !== 'string' || relPath.trim() === '') {
    throw new Error('Caminho inválido ou vazio.');
  }
  if (relPath.includes('\0') || relPath.includes('\\') || /^[a-zA-Z]:/.test(relPath)) {
    throw new Error('Caminho rejeitado: caracteres ou prefixo não permitidos.');
  }
  if (relPath.startsWith('/')) {
    throw new Error('Caminho absoluto não permitido.');
  }
  const segments = relPath.split('/');
  if (segments.some((seg) => seg === '..' || seg === '.')) {
    throw new Error('Path traversal rejeitado.');
  }
  return relPath;
}

export async function processLensBridgeRequest(
  req: LensBridgeRequest,
  deps: {
    readFile: (relPath: string) => Promise<string>;
    listFiles: () => Promise<string[]>;
  }
): Promise<LensBridgeResponse> {
  try {
    if (req.method === 'hub:listFiles') {
      const files = await deps.listFiles();
      return { id: req.id, method: req.method, result: files };
    }
    if (req.method === 'hub:readFile') {
      const safePath = validateSafeRelPath(req.params?.rel_path ?? req.params?.path);
      const content = await deps.readFile(safePath);
      const byteLength = new TextEncoder().encode(content).byteLength;
      if (byteLength > MAX_LENS_READ_BYTES) {
        return {
          id: req.id,
          method: req.method,
          error: `Arquivo excede o limite de 1 MiB (${byteLength} bytes).`,
        };
      }
      return { id: req.id, method: req.method, result: { rel_path: safePath, content } };
    }
    return {
      id: req.id,
      method: req.method,
      error: `Método não suportado pela ponte read-only: ${req.method}`,
    };
  } catch (err) {
    return {
      id: req.id,
      method: req.method,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function createLensMessageHandler(
  getIframeWindow: () => Window | null | undefined,
  deps: {
    readFile: (relPath: string) => Promise<string>;
    listFiles: () => Promise<string[]>;
  }
): (event: MessageEvent) => Promise<void> {
  return async (event: MessageEvent) => {
    const iframeWin = getIframeWindow();
    if (!iframeWin || event.source !== iframeWin) {
      // Strictly reject any message whose source is not the sandboxed iframe's contentWindow
      return;
    }
    const data = event.data as Partial<LensBridgeRequest> | null;
    if (!data || typeof data !== 'object' || data.id === undefined || typeof data.method !== 'string') {
      return;
    }

    const response = await processLensBridgeRequest(
      { id: data.id, method: data.method, params: data.params },
      deps
    );
    iframeWin.postMessage(response, '*');
  };
}

export const CustomLensPanel: React.FC<IDockviewPanelProps<CustomLensPanelParams>> = ({
  params,
}) => {
  const lensId = params.lensId;
  const fileTree = useWorkspaceStore((s) => s.fileTree);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [rawHtml, setRawHtml] = useState<string>('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setErrorMsg(null);
    void ipc
      .readLensHtml(lensId)
      .then((html) => {
        if (active) setRawHtml(html);
      })
      .catch((err) => {
        if (active) setErrorMsg(err instanceof Error ? err.message : String(err));
      });
    return () => {
      active = false;
    };
  }, [lensId]);

  const sandboxedSrcDoc = useMemo(() => (rawHtml ? injectLensCsp(rawHtml) : ''), [rawHtml]);

  useEffect(() => {
    const flattenPaths = () => {
      const out: string[] = [];
      const walk = (nodes: typeof fileTree) => {
        for (const n of nodes) {
          if (n.is_dir && n.children) walk(n.children);
          else if (!n.is_dir) out.push(n.rel_path);
        }
      };
      walk(fileTree);
      return out;
    };

    const handler = createLensMessageHandler(
      () => iframeRef.current?.contentWindow,
      {
        readFile: async (relPath) => {
          const res = await ipc.readMarkdownFile(relPath);
          return res.content;
        },
        listFiles: async () => flattenPaths(),
      }
    );

    const onMessage = (ev: MessageEvent) => {
      void handler(ev);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [fileTree]);

  // Forward file change notifications to the sandboxed lens
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listenEvent<FsChangedPayload>('fs://changed', (payload) => {
      iframeRef.current?.contentWindow?.postMessage(
        {
          id: `event-${Date.now()}`,
          method: 'hub:filesChanged',
          result: payload,
        },
        '*'
      );
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  return (
    <div className="panel-shell">
      <div className="panel-toolbar">
        <div className="panel-toolbar-left">
          <span className="file-badge">Lente: {params.title ?? lensId}</span>
          <span className="sandbox-badge">sandbox: allow-scripts (sem rede)</span>
        </div>
      </div>
      {errorMsg ? (
        <div className="banner-error">{errorMsg}</div>
      ) : (
        <iframe
          ref={iframeRef}
          title={`lens-${lensId}`}
          sandbox="allow-scripts"
          srcDoc={sandboxedSrcDoc}
          className="lens-iframe"
        />
      )}
    </div>
  );
};
