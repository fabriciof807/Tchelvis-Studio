/**
 * Pure viewport maths for the Hub image viewer.
 *
 * The image is drawn with `transform: translate(x, y) scale(s)` and
 * `transform-origin: 0 0`, so `x`/`y` are the image top-left in stage
 * coordinates and one image pixel maps to `s` stage pixels.
 */

export interface Size {
  w: number;
  h: number;
}

export interface Point {
  x: number;
  y: number;
}

/** x,y = image top-left in stage coords; transform = translate(x,y) scale(scale), origin 0 0. */
export interface ViewState {
  scale: number;
  x: number;
  y: number;
  mode: 'fit' | 'free';
}

export interface ViewportBounds {
  stage: Size;
  image: Size;
}

export const MIN_SCALE = 0.05;
export const MAX_SCALE = 32;
export const BUTTON_STEP = 1.25;
export const PAN_MARGIN = 48;

/** Pixels per wheel notch: 100 px * 0.0025 ≈ ×1.19 per notch. */
const WHEEL_K = 0.0025;
const WHEEL_LINE_PX = 40;
const WHEEL_PAGE_PX = 800;
const MIN_WHEEL_FACTOR = 0.5;
const MAX_WHEEL_FACTOR = 2;

const isPositive = (value: number): boolean => Number.isFinite(value) && value > 0;

const isMeasured = (size: Size): boolean => isPositive(size.w) && isPositive(size.h);

const clampAxis = (value: number, lo: number, hi: number): number => {
  if (!Number.isFinite(value)) return lo;
  if (lo > hi) return (lo + hi) / 2;
  return Math.min(hi, Math.max(lo, value));
};

export function clampScale(s: number): number {
  if (!Number.isFinite(s)) return 1;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
}

export function fitTransform(b: ViewportBounds): ViewState {
  const { stage, image } = b;
  if (!isMeasured(stage) || !isMeasured(image)) {
    return { scale: 1, x: 0, y: 0, mode: 'fit' };
  }
  const scale = Math.min(stage.w / image.w, stage.h / image.h, 1);
  return {
    scale,
    x: (stage.w - image.w * scale) / 2,
    y: (stage.h - image.h * scale) / 2,
    mode: 'fit',
  };
}

export function zoomAt(s: ViewState, factor: number, anchor: Point, b: ViewportBounds): ViewState {
  const current = isPositive(s.scale) ? s.scale : 1;
  const scale = clampScale(current * factor);
  const imageX = (anchor.x - s.x) / current;
  const imageY = (anchor.y - s.y) / current;
  return clampPosition(
    {
      scale,
      x: anchor.x - imageX * scale,
      y: anchor.y - imageY * scale,
      mode: 'free',
    },
    b,
  );
}

export function panBy(s: ViewState, dx: number, dy: number, b: ViewportBounds): ViewState {
  return clampPosition({ scale: s.scale, x: s.x + dx, y: s.y + dy, mode: 'free' }, b);
}

export function oneToOne(s: ViewState, b: ViewportBounds): ViewState {
  const current = isPositive(s.scale) ? s.scale : 1;
  const centre = { x: b.stage.w / 2, y: b.stage.h / 2 };
  const imageX = (centre.x - s.x) / current;
  const imageY = (centre.y - s.y) / current;
  return clampPosition(
    { scale: 1, x: centre.x - imageX, y: centre.y - imageY, mode: 'free' },
    b,
  );
}

export function wheelFactor(deltaY: number, deltaMode: number): number {
  const perUnit = deltaMode === 1 ? WHEEL_LINE_PX : deltaMode === 2 ? WHEEL_PAGE_PX : 1;
  const pixels = deltaY * perUnit;
  if (!Number.isFinite(pixels)) return 1;
  const factor = Math.pow(2, -pixels * WHEEL_K);
  return Math.min(MAX_WHEEL_FACTOR, Math.max(MIN_WHEEL_FACTOR, factor));
}

export function isPixelated(scale: number): boolean {
  return Number.isFinite(scale) && scale >= 2;
}

export function formatZoomLabel(s: ViewState, fitLabel: string): string {
  const pct = Number.isFinite(s.scale) ? Math.round(s.scale * 100) : 100;
  return s.mode === 'fit' ? `${fitLabel} · ${pct}%` : `${pct}%`;
}

/**
 * Keeps at least `min(PAN_MARGIN, displayed size)` of the image reachable on
 * each axis, so tiny images stay pannable and large ones cannot be lost.
 */
function clampPosition(s: ViewState, b: ViewportBounds): ViewState {
  const { stage, image } = b;
  if (!isMeasured(stage) || !isMeasured(image) || !isPositive(s.scale)) return s;
  const displayedW = image.w * s.scale;
  const displayedH = image.h * s.scale;
  const marginX = Math.min(PAN_MARGIN, displayedW);
  const marginY = Math.min(PAN_MARGIN, displayedH);
  return {
    ...s,
    x: clampAxis(s.x, marginX - displayedW, stage.w - marginX),
    y: clampAxis(s.y, marginY - displayedH, stage.h - marginY),
  };
}
