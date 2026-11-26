import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ipc } from '../types/ipc';
import { useWorkspaceStore } from '../store/workspaceStore';
import { ImageViewer } from '../panels/MediaViewerPanel';

const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

const STAGE_W = 800;
const STAGE_H = 600;
const IMAGE_W = 4000;
const IMAGE_H = 1000;

let resizeCallback: ResizeObserverCallback | null = null;

class TestResizeObserver {
  constructor(callback: ResizeObserverCallback) {
    resizeCallback = callback;
  }
  observe() {}
  unobserve() {}
  disconnect() {
    resizeCallback = null;
  }
}

class TestPointerEvent extends MouseEvent {
  pointerId: number;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 0;
  }
}

function setBoxSize(el: Element, w: number, h: number) {
  Object.defineProperty(el, 'clientWidth', { value: w, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: h, configurable: true });
}

function fireResize() {
  act(() => {
    resizeCallback?.([], {} as ResizeObserver);
  });
}

function loadImage(img: HTMLImageElement, w = IMAGE_W, h = IMAGE_H) {
  Object.defineProperty(img, 'naturalWidth', { value: w, configurable: true });
  Object.defineProperty(img, 'naturalHeight', { value: h, configurable: true });
  fireEvent.load(img);
}

function zoomLabel(container: HTMLElement): string {
  const el = container.querySelector('.image-zoom-label');
  return el?.textContent ?? '';
}

async function mount(relPath = 'art/hero.png') {
  const view = render(<ImageViewer relPath={relPath} />);
  const stage = view.container.querySelector('.media-image-stage') as HTMLElement;
  expect(stage).toBeTruthy();
  setBoxSize(stage, STAGE_W, STAGE_H);
  const img = (await screen.findByAltText(relPath)) as HTMLImageElement;
  loadImage(img);
  return { ...view, stage, img };
}

describe('ImageViewer', () => {
  beforeEach(() => {
    useWorkspaceStore.setState({ locale: 'en' });
    vi.spyOn(ipc, 'readBinaryFile').mockResolvedValue(PNG_1X1);
    let urlCount = 0;
    URL.createObjectURL = vi.fn(() => `blob:test-image-${++urlCount}`);
    URL.revokeObjectURL = vi.fn();
    resizeCallback = null;
    vi.stubGlobal('ResizeObserver', TestResizeObserver);
    vi.stubGlobal('PointerEvent', TestPointerEvent);
    Object.defineProperty(Element.prototype, 'setPointerCapture', {
      value: vi.fn(),
      configurable: true,
      writable: true,
    });
    Object.defineProperty(Element.prototype, 'releasePointerCapture', {
      value: vi.fn(),
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    resizeCallback = null;
  });

  it('starts in fit mode with the real fit percentage', async () => {
    const { container } = await mount();
    expect(zoomLabel(container)).toBe('Fit · 20%');
  });

  it('middle-button drag changes the transform', async () => {
    const { container, stage, img } = await mount();
    const before = img.style.transform;
    expect(before).toContain('translate(');

    fireEvent.pointerDown(stage, { button: 1, clientX: 100, clientY: 100 });
    expect(stage.classList.contains('is-panning')).toBe(true);

    fireEvent.pointerMove(stage, { clientX: 150, clientY: 120 });
    fireEvent.pointerUp(stage, { button: 1, clientX: 150, clientY: 120 });

    expect(stage.classList.contains('is-panning')).toBe(false);
    expect(img.style.transform).not.toBe(before);
    expect(img.style.transform).toContain('translate(');
    expect(zoomLabel(container)).toBe('20%');
  });

  it('left-button drag does nothing', async () => {
    const { stage, img } = await mount();
    const before = img.style.transform;

    fireEvent.pointerDown(stage, { button: 0, clientX: 100, clientY: 100 });
    expect(stage.classList.contains('is-panning')).toBe(false);
    fireEvent.pointerMove(stage, { clientX: 150, clientY: 120 });
    fireEvent.pointerUp(stage, { button: 0, clientX: 150, clientY: 120 });

    expect(img.style.transform).toBe(before);
  });

  it('wheel calls preventDefault and zooms', async () => {
    const { container, stage } = await mount();
    expect(zoomLabel(container)).toBe('Fit · 20%');

    const wheel = new WheelEvent('wheel', { deltaY: -100, cancelable: true, bubbles: true });
    act(() => {
      stage.dispatchEvent(wheel);
    });

    expect(wheel.defaultPrevented).toBe(true);
    expect(zoomLabel(container)).not.toBe('Fit · 20%');
    expect(zoomLabel(container)).toBe('24%');
  });

  it('middle mousedown and auxclick defaults are prevented', async () => {
    const { stage } = await mount();

    const down = new MouseEvent('mousedown', { button: 1, bubbles: true, cancelable: true });
    act(() => {
      stage.dispatchEvent(down);
    });
    expect(down.defaultPrevented).toBe(true);

    const aux = new MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true });
    act(() => {
      stage.dispatchEvent(aux);
    });
    expect(aux.defaultPrevented).toBe(true);
  });

  it('+ from fit gives 1.25 × fit', async () => {
    const { container } = await mount();
    fireEvent.click(screen.getByTitle('Zoom in'));
    expect(zoomLabel(container)).toBe('25%');
  });

  it('resize re-fits only in fit mode', async () => {
    const { container, stage } = await mount();
    expect(zoomLabel(container)).toBe('Fit · 20%');

    setBoxSize(stage, 400, 300);
    fireResize();
    expect(zoomLabel(container)).toBe('Fit · 10%');

    const wheel = new WheelEvent('wheel', { deltaY: -100, cancelable: true, bubbles: true });
    act(() => {
      stage.dispatchEvent(wheel);
    });
    const zoomed = zoomLabel(container);
    expect(zoomed).toBe('12%');

    setBoxSize(stage, 200, 150);
    fireResize();
    expect(zoomLabel(container)).toBe(zoomed);
  });

  it('new file resets to fit', async () => {
    const { container, rerender } = await mount();
    fireEvent.click(screen.getByTitle('Zoom in'));
    expect(zoomLabel(container)).toBe('25%');

    rerender(<ImageViewer relPath="art/other.png" />);
    expect(zoomLabel(container)).toBe('Fit');

    const img = (await screen.findByAltText('art/other.png')) as HTMLImageElement;
    loadImage(img);
    expect(zoomLabel(container)).toBe('Fit · 20%');
  });

  it('pixelated at 200%', async () => {
    const { container, img } = await mount();
    fireEvent.click(screen.getByText('1:1'));
    expect(zoomLabel(container)).toBe('100%');
    expect(img.classList.contains('media-image-pixelated')).toBe(false);

    for (let i = 0; i < 4; i += 1) {
      fireEvent.click(screen.getByTitle('Zoom in'));
    }

    expect(Number.parseInt(zoomLabel(container), 10)).toBeGreaterThanOrEqual(200);
    expect(img.classList.contains('media-image-pixelated')).toBe(true);
  });
});
