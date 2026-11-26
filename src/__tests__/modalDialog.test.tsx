import React, { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ModalDialog } from '../components/ModalDialog';
import { useWorkspaceStore } from '../store/workspaceStore';

function dialogElement(): HTMLElement {
  return screen.getByRole('dialog');
}

type DialogProps = Omit<React.ComponentProps<typeof ModalDialog>, 'children'>;

function renderDialog(overrides: Partial<DialogProps> = {}) {
  const onClose = vi.fn();
  const props: DialogProps = {
    titleId: 'test-dialog-title',
    descriptionId: 'test-dialog-description',
    onClose,
    ...overrides,
  };
  const view = render(
    <ModalDialog {...props}>
      <h2 id="test-dialog-title">Title</h2>
      <p id="test-dialog-description">Description</p>
      <button type="button">first</button>
      <button type="button">middle</button>
      <button type="button">last</button>
    </ModalDialog>
  );
  return { ...view, onClose };
}

describe('ModalDialog', () => {
  beforeEach(() => {
    useWorkspaceStore.setState({ activeModalCount: 0 });
    document.body.innerHTML = '';
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('renders an accessible modal dialog into document.body', () => {
    const { container } = renderDialog();

    const dialog = dialogElement();
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-labelledby')).toBe('test-dialog-title');
    expect(dialog.getAttribute('aria-describedby')).toBe('test-dialog-description');
    expect(document.body.contains(dialog)).toBe(true);
    expect(container.contains(dialog)).toBe(false);
  });

  it('omits aria-describedby when no description id is given', () => {
    renderDialog({ descriptionId: undefined });
    expect(dialogElement().hasAttribute('aria-describedby')).toBe(false);
  });

  it('increments activeModalCount on mount and restores it on unmount (S3-10)', () => {
    const before = useWorkspaceStore.getState().activeModalCount;
    const { unmount } = renderDialog();
    expect(useWorkspaceStore.getState().activeModalCount).toBe(before + 1);
    unmount();
    expect(useWorkspaceStore.getState().activeModalCount).toBe(before);
  });

  it('traps Tab on the last tabbable and wraps to the first', () => {
    renderDialog();
    const buttons = screen.getAllByRole('button');
    buttons[buttons.length - 1].focus();
    fireEvent.keyDown(dialogElement(), { key: 'Tab' });
    expect(document.activeElement).toBe(buttons[0]);
  });

  it('traps Shift+Tab on the first tabbable and wraps to the last', () => {
    renderDialog();
    const buttons = screen.getAllByRole('button');
    buttons[0].focus();
    fireEvent.keyDown(dialogElement(), { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(buttons[buttons.length - 1]);
  });

  it('queries tabbables again after the content changes', () => {
    const { rerender } = render(
      <ModalDialog titleId="t" onClose={vi.fn()}>
        <button type="button">first</button>
        <button type="button">last</button>
      </ModalDialog>
    );
    rerender(
      <ModalDialog titleId="t" onClose={vi.fn()}>
        <button type="button">first</button>
        <button type="button">middle</button>
        <button type="button">new last</button>
      </ModalDialog>
    );
    const buttons = screen.getAllByRole('button');
    buttons[buttons.length - 1].focus();
    fireEvent.keyDown(dialogElement(), { key: 'Tab' });
    expect(document.activeElement).toBe(buttons[0]);
  });

  it('pulls focus back inside when it lands outside the dialog', () => {
    renderDialog();
    const outside = document.createElement('button');
    outside.type = 'button';
    outside.textContent = 'outside';
    document.body.appendChild(outside);

    outside.focus();

    expect(document.activeElement).not.toBe(outside);
    expect(dialogElement().contains(document.activeElement)).toBe(true);
  });

  it('closes on Esc and stops the event before window listeners', () => {
    const windowSpy = vi.fn();
    window.addEventListener('keydown', windowSpy);
    try {
      const { onClose } = renderDialog();
      fireEvent.keyDown(dialogElement(), { key: 'Escape' });
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(windowSpy).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', windowSpy);
    }
  });

  it('does nothing on Esc while busy', () => {
    const { onClose } = renderDialog({ busy: true });
    fireEvent.keyDown(dialogElement(), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('does not close when an inner element stops propagation on Esc', () => {
    const onClose = vi.fn();
    render(
      <ModalDialog titleId="t" onClose={onClose}>
        <div onKeyDown={(e) => e.stopPropagation()}>
          <button type="button">inner</button>
        </div>
      </ModalDialog>
    );
    fireEvent.keyDown(screen.getByRole('button', { name: 'inner' }), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('returns focus to the opener on unmount', () => {
    const opener = document.createElement('button');
    opener.type = 'button';
    opener.textContent = 'opener';
    document.body.appendChild(opener);
    opener.focus();

    const { unmount } = renderDialog();
    unmount();

    expect(document.activeElement).toBe(opener);
  });

  it('falls back to the chat composer when the opener was removed', () => {
    const opener = document.createElement('button');
    opener.type = 'button';
    opener.textContent = 'opener';
    document.body.appendChild(opener);
    opener.focus();

    const { unmount } = renderDialog();
    opener.remove();
    const chatInput = document.createElement('textarea');
    chatInput.className = 'chat-input';
    document.body.appendChild(chatInput);

    unmount();

    expect(document.activeElement).toBe(chatInput);
  });

  it('falls back to document.body when neither the opener nor the composer exists', () => {
    const opener = document.createElement('button');
    opener.type = 'button';
    opener.textContent = 'opener';
    document.body.appendChild(opener);
    opener.focus();

    const { unmount } = renderDialog();
    opener.remove();

    unmount();

    expect(document.activeElement).toBe(document.body);
  });

  it('focuses initialFocus after mount (requestAnimationFrame flush)', () => {
    vi.useFakeTimers();
    const target = createRef<HTMLButtonElement>();
    render(
      <ModalDialog titleId="t" onClose={vi.fn()} initialFocus={target}>
        <h2 id="t">Title</h2>
        <button type="button" ref={target}>
          focused target
        </button>
        <button type="button">other</button>
      </ModalDialog>
    );

    expect(document.activeElement).not.toBe(target.current);
    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(document.activeElement).toBe(target.current);
  });

  it('does not close when the backdrop is clicked', () => {
    const { onClose } = renderDialog();
    const backdrop = document.querySelector('.lightbox-backdrop');
    expect(backdrop).toBeTruthy();
    fireEvent.click(backdrop as Element);
    fireEvent.mouseDown(backdrop as Element);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('marks #root inert while mounted and restores it afterwards', () => {
    const root = document.createElement('div');
    root.id = 'root';
    document.body.appendChild(root);

    const { unmount } = renderDialog();
    expect(root.hasAttribute('inert')).toBe(true);

    unmount();
    expect(root.hasAttribute('inert')).toBe(false);
  });
});
