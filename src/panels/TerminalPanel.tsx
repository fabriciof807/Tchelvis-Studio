import React, { memo, useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { ipc, listenEvent, type PtyOutputPayload } from '../types/ipc';

interface TerminalPanelProps {
  visible?: boolean;
}

export const TerminalPanel: React.FC<TerminalPanelProps> = memo(({ visible = true }) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: '"JetBrains Mono", "Fira Code", ui-monospace, monospace',
      theme: {
        background: '#0f1219',
        foreground: '#e2e8f0',
        cursor: '#60a5fa',
      },
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);
    termRef.current = term;
    fitAddonRef.current = fitAddon;

    if (container.clientWidth > 0 && container.clientHeight > 0) {
      fitAddon.fit();
      term.focus();
    }

    // Pass Hub window shortcuts (Ctrl+B, Ctrl+L, Ctrl+J, F5) up to the Hub instead of sending to PTY
    term.attachCustomKeyEventHandler((ev: KeyboardEvent) => {
      if (ev.key === 'F5') {
        return false;
      }
      if (ev.ctrlKey && !ev.altKey && !ev.shiftKey) {
        const lower = ev.key.toLowerCase();
        if (lower === 'b' || lower === 'l' || lower === 'j') {
          return false;
        }
      }
      return true;
    });

    let active = true;
    let unlisten: (() => void) | undefined;
    const earlyChunks: PtyOutputPayload[] = [];

    const startPty = async () => {
      try {
        // Register listener BEFORE spawning so initial shell prompt chunks are never lost
        unlisten = await listenEvent<PtyOutputPayload>('pty://output', (payload) => {
          if (!active) return;
          if (!sessionIdRef.current) {
            earlyChunks.push(payload);
            return;
          }
          if (payload.session_id === sessionIdRef.current) {
            term.write(payload.data);
          }
        });

        if (!active) {
          unlisten?.();
          return;
        }

        const sid = await ipc.ptySpawn(term.cols || 80, term.rows || 24);
        if (!active) {
          void ipc.ptyKill(sid);
          return;
        }
        sessionIdRef.current = sid;

        for (const chunk of earlyChunks) {
          if (chunk.session_id === sid) {
            term.write(chunk.data);
          }
        }
        earlyChunks.length = 0;
      } catch (err) {
        term.writeln(`\r\n[Erro ao iniciar PTY: ${err instanceof Error ? err.message : String(err)}]`);
      }
    };

    void startPty();

    const dataDisposable = term.onData((data) => {
      if (sessionIdRef.current) {
        void ipc.ptyWrite(sessionIdRef.current, data);
      }
    });

    let resizeRaf: number | null = null;
    const resizeObserver = new ResizeObserver(() => {
      if (resizeRaf !== null) {
        window.cancelAnimationFrame(resizeRaf);
      }
      resizeRaf = window.requestAnimationFrame(() => {
        resizeRaf = null;
        if (!active || !container || container.clientWidth === 0 || container.clientHeight === 0) {
          return;
        }
        fitAddon.fit();
        if (sessionIdRef.current && term.cols > 0 && term.rows > 0) {
          void ipc.ptyResize(sessionIdRef.current, term.cols, term.rows);
        }
      });
    });
    resizeObserver.observe(container);

    return () => {
      active = false;
      if (resizeRaf !== null) {
        window.cancelAnimationFrame(resizeRaf);
      }
      resizeObserver.disconnect();
      dataDisposable.dispose();
      unlisten?.();
      if (sessionIdRef.current) {
        void ipc.ptyKill(sessionIdRef.current);
        sessionIdRef.current = null;
      }
      termRef.current = null;
      fitAddonRef.current = null;
      term.dispose();
    };
  }, []);

  useEffect(() => {
    if (!visible) return;
    const raf = window.requestAnimationFrame(() => {
      const container = containerRef.current;
      const fitAddon = fitAddonRef.current;
      const term = termRef.current;
      if (!container || !fitAddon || !term) return;
      if (container.clientWidth > 0 && container.clientHeight > 0) {
        fitAddon.fit();
        if (sessionIdRef.current && term.cols > 0 && term.rows > 0) {
          void ipc.ptyResize(sessionIdRef.current, term.cols, term.rows);
        }
        term.focus();
      }
    });
    return () => window.cancelAnimationFrame(raf);
  }, [visible]);

  return (
    <div
      ref={containerRef}
      className="terminal-container"
      onMouseDown={() => termRef.current?.focus()}
    />
  );
});

TerminalPanel.displayName = 'TerminalPanel';
