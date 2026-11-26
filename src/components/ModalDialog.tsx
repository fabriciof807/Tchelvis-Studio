import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useWorkspaceStore } from '../store/workspaceStore';

export interface ModalDialogProps {
  titleId: string;
  descriptionId?: string;
  onClose: () => void;
  /** While busy, `Esc` is a no-op so a half-applied state is never hidden. */
  busy?: boolean;
  initialFocus?: React.RefObject<HTMLElement | null>;
  className?: string;
  children: React.ReactNode;
}

const TABBABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(', ');

/** Queried on every keypress so tabbables that change with the dialog state are handled. */
function tabbables(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(TABBABLE_SELECTOR)).filter(
    (el) => !el.hasAttribute('inert') && el.getAttribute('aria-hidden') !== 'true'
  );
}

/**
 * Modal dialog primitive: portal into `document.body`, focus trap, `Esc` layering,
 * focus return and `activeModalCount` bookkeeping. Background click never closes.
 */
export const ModalDialog: React.FC<ModalDialogProps> = ({
  titleId,
  descriptionId,
  onClose,
  busy = false,
  initialFocus,
  className,
  children,
}) => {
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const busyRef = useRef(busy);
  const initialFocusRef = useRef(initialFocus);
  onCloseRef.current = onClose;
  busyRef.current = busy;
  initialFocusRef.current = initialFocus;

  const incrementModalCount = useWorkspaceStore((s) => s.incrementModalCount);
  const decrementModalCount = useWorkspaceStore((s) => s.decrementModalCount);

  useEffect(() => {
    const opener =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = document.getElementById('root');
    const rootHadInert = root?.hasAttribute('inert') ?? false;
    if (root) root.setAttribute('inert', '');

    incrementModalCount();

    const requestFrame =
      window.requestAnimationFrame ??
      ((cb: FrameRequestCallback) => window.setTimeout(() => cb(Date.now()), 16));
    const cancelFrame =
      window.cancelAnimationFrame ?? ((id: number) => window.clearTimeout(id));

    const frame = requestFrame(() => {
      const target =
        initialFocusRef.current?.current ?? tabbables(dialogRef.current)[0] ?? dialogRef.current;
      target?.focus();
    });

    const handleFocusIn = (event: FocusEvent) => {
      const current = dialogRef.current;
      if (!current) return;
      const target = event.target;
      if (target instanceof Node && current.contains(target)) return;
      (tabbables(current)[0] ?? current).focus();
    };
    document.addEventListener('focusin', handleFocusIn);

    return () => {
      cancelFrame(frame);
      document.removeEventListener('focusin', handleFocusIn);
      decrementModalCount();
      if (root) {
        if (rootHadInert) root.setAttribute('inert', '');
        else root.removeAttribute('inert');
      }

      if (opener && opener.isConnected && opener !== document.body) {
        opener.focus();
        return;
      }
      const chatInput = document.querySelector<HTMLElement>('.chat-input');
      const fallback: HTMLElement = chatInput ?? document.body;
      fallback.focus();
      if (fallback === document.body && document.activeElement !== document.body) {
        // `body` is not focusable in every engine; blur so focus falls back to it.
        const active = document.activeElement;
        if (active instanceof HTMLElement) active.blur();
      }
    };
  }, [incrementModalCount, decrementModalCount]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      event.preventDefault();
      if (busyRef.current) return;
      onCloseRef.current();
      return;
    }

    if (event.key !== 'Tab') return;

    const current = dialogRef.current;
    const list = tabbables(current);
    if (!current) return;
    if (list.length === 0) {
      event.preventDefault();
      current.focus();
      return;
    }

    const active = document.activeElement;
    const first = list[0];
    const last = list[list.length - 1];
    const activeInside = active instanceof Node && current.contains(active);

    if (event.shiftKey) {
      if (!activeInside || active === first || active === current) {
        event.preventDefault();
        last.focus();
      }
      return;
    }
    if (!activeInside || active === last || active === current) {
      event.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div className="lightbox-backdrop">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className={className}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        {children}
      </div>
    </div>,
    document.body
  );
};
