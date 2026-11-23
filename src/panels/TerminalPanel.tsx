import React, { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { ipc, listenEvent, type PtyOutputPayload } from '../types/ipc';

export const TerminalPanel: React.FC = () => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sessionIdRef = useRef<string | null>(null);

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
    fitAddon.fit();

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

    void listenEvent<PtyOutputPayload>('pty://output', (payload) => {
      if (payload.session_id === sessionIdRef.current) {
        term.write(payload.data);
      }
    }).then((fn) => {
      unlisten = fn;
    });

    void ipc
      .ptySpawn(term.cols || 80, term.rows || 24)
      .then((sid) => {
        if (!active) {
          void ipc.ptyKill(sid);
          return;
        }
        sessionIdRef.current = sid;
      })
      .catch((err) => {
        term.writeln(`\r\n[Erro ao iniciar PTY: ${err instanceof Error ? err.message : String(err)}]`);
      });

    const dataDisposable = term.onData((data) => {
      if (sessionIdRef.current) {
        void ipc.ptyWrite(sessionIdRef.current, data);
      }
    });

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      if (sessionIdRef.current && term.cols > 0 && term.rows > 0) {
        void ipc.ptyResize(sessionIdRef.current, term.cols, term.rows);
      }
    });
    resizeObserver.observe(container);

    return () => {
      active = false;
      resizeObserver.disconnect();
      dataDisposable.dispose();
      unlisten?.();
      if (sessionIdRef.current) {
        void ipc.ptyKill(sessionIdRef.current);
        sessionIdRef.current = null;
      }
      term.dispose();
    };
  }, []);

  return <div ref={containerRef} className="terminal-container" />;
};
