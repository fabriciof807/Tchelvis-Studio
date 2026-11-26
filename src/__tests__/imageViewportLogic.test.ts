import { describe, expect, it } from 'vitest';
import {
  BUTTON_STEP,
  MAX_SCALE,
  MIN_SCALE,
  PAN_MARGIN,
  clampScale,
  fitTransform,
  formatZoomLabel,
  isPixelated,
  oneToOne,
  panBy,
  wheelFactor,
  zoomAt,
} from '../panels/imageViewport';
import type { Point, ViewState, ViewportBounds } from '../panels/imageViewport';

const bounds = (stageW: number, stageH: number, imgW: number, imgH: number): ViewportBounds => ({
  stage: { w: stageW, h: stageH },
  image: { w: imgW, h: imgH },
});

const view = (scale: number, mode: 'fit' | 'free'): ViewState => ({ scale, x: 0, y: 0, mode });

const stageCentre = (b: ViewportBounds): Point => ({ x: b.stage.w / 2, y: b.stage.h / 2 });

/** How many pixels of the displayed image are inside the stage, per axis. */
const visibleSpan = (pos: number, stageSize: number, displayed: number): number =>
  Math.min(pos + displayed, stageSize) - Math.max(pos, 0);

describe('imageViewport', () => {
  it('exposes the global scale and step constants', () => {
    expect(MIN_SCALE).toBe(0.05);
    expect(MAX_SCALE).toBe(32);
    expect(BUTTON_STEP).toBe(1.25);
    expect(PAN_MARGIN).toBe(48);
  });

  it('clampScale clamps to the global bounds', () => {
    expect(clampScale(1000)).toBe(MAX_SCALE);
    expect(clampScale(0)).toBe(MIN_SCALE);
    expect(clampScale(-3)).toBe(MIN_SCALE);
    expect(clampScale(0.5)).toBe(0.5);
  });

  it('fitTransform scales landscape images down and centres them', () => {
    const state = fitTransform(bounds(800, 600, 4000, 1000));
    expect(state.scale).toBeCloseTo(0.2, 10);
    expect(state.x).toBeCloseTo(0, 10);
    expect(state.y).toBeCloseTo(200, 10);
    expect(state.mode).toBe('fit');
  });

  it('fitTransform scales portrait images down and centres them', () => {
    const state = fitTransform(bounds(800, 600, 1000, 4000));
    expect(state.scale).toBeCloseTo(0.15, 10);
    expect(state.x).toBeCloseTo(325, 10);
    expect(state.y).toBeCloseTo(0, 10);
    expect(state.mode).toBe('fit');
  });

  it('fitTransform never upscales small images', () => {
    const state = fitTransform(bounds(800, 600, 32, 32));
    expect(state.scale).toBe(1);
    expect(state.x).toBeCloseTo(384, 10);
    expect(state.y).toBeCloseTo(284, 10);
    expect(state.mode).toBe('fit');
  });

  it('fitTransform with zero stage returns scale 1 at origin', () => {
    const state = fitTransform(bounds(0, 0, 4000, 1000));
    expect(Number.isFinite(state.scale)).toBe(true);
    expect(Number.isFinite(state.x)).toBe(true);
    expect(Number.isFinite(state.y)).toBe(true);
    expect(state.scale).toBe(1);
    expect(state.x).toBe(0);
    expect(state.y).toBe(0);
  });

  it('fitTransform with an unmeasured image returns finite numbers', () => {
    const state = fitTransform({ stage: { w: 800, h: 600 }, image: { w: 0, h: 0 } });
    expect(state.scale).toBe(1);
    expect(Number.isFinite(state.x)).toBe(true);
    expect(Number.isFinite(state.y)).toBe(true);
  });

  it('zoomAt keeps the image point under the anchor fixed', () => {
    const b = bounds(800, 600, 4000, 1000);
    const states: ViewState[] = [
      fitTransform(b),
      { scale: 0.5, x: -100, y: -50, mode: 'free' },
      { scale: 2, x: 12.5, y: -300, mode: 'free' },
    ];
    const anchors: Point[] = [
      { x: 0, y: 0 },
      { x: 400, y: 300 },
      { x: 123, y: 456 },
    ];
    const factors = [1.25, 0.8, 1.1];
    for (const state of states) {
      for (const anchor of anchors) {
        for (const factor of factors) {
          const beforeX = (anchor.x - state.x) / state.scale;
          const beforeY = (anchor.y - state.y) / state.scale;
          const next = zoomAt(state, factor, anchor, b);
          const afterX = (anchor.x - next.x) / next.scale;
          const afterY = (anchor.y - next.y) / next.scale;
          expect(Math.abs(afterX - beforeX)).toBeLessThanOrEqual(0.5);
          expect(Math.abs(afterY - beforeY)).toBeLessThanOrEqual(0.5);
          expect(next.mode).toBe('free');
        }
      }
    }
  });

  it('zoomAt clamps the scale to 5%-3200%', () => {
    const b = bounds(800, 600, 4000, 1000);
    const state = fitTransform(b);
    expect(zoomAt(state, 1000, stageCentre(b), b).scale).toBe(MAX_SCALE);
    expect(zoomAt(state, 0.0001, stageCentre(b), b).scale).toBe(MIN_SCALE);
  });

  it('leaving fit with the zoom-in button multiplies the fit scale', () => {
    const b = bounds(800, 600, 4000, 1000);
    const next = zoomAt(fitTransform(b), BUTTON_STEP, stageCentre(b), b);
    expect(next.scale).toBeCloseTo(0.2 * 1.25, 10);
    expect(next.mode).toBe('free');
  });

  it('panBy clamps so exactly PAN_MARGIN px of the image stays on stage', () => {
    const b = bounds(800, 600, 4000, 1000);
    const fit = fitTransform(b);
    const displayedW = b.image.w * fit.scale;
    const displayedH = b.image.h * fit.scale;

    const left = panBy(fit, -100000, 0, b);
    expect(visibleSpan(left.x, b.stage.w, displayedW)).toBeCloseTo(PAN_MARGIN, 10);
    const right = panBy(fit, 100000, 0, b);
    expect(visibleSpan(right.x, b.stage.w, displayedW)).toBeCloseTo(PAN_MARGIN, 10);
    const up = panBy(fit, 0, -100000, b);
    expect(visibleSpan(up.y, b.stage.h, displayedH)).toBeCloseTo(PAN_MARGIN, 10);
    const down = panBy(fit, 0, 100000, b);
    expect(visibleSpan(down.y, b.stage.h, displayedH)).toBeCloseTo(PAN_MARGIN, 10);
  });

  it('panBy keeps a 16px image reachable', () => {
    const b = bounds(800, 600, 16, 16);
    const fit = fitTransform(b);
    expect(fit.scale).toBe(1);

    const leftUp = panBy(fit, -100000, -100000, b);
    expect(leftUp.x).toBe(0);
    expect(leftUp.y).toBe(0);
    expect(visibleSpan(leftUp.x, b.stage.w, 16)).toBe(16);
    expect(visibleSpan(leftUp.y, b.stage.h, 16)).toBe(16);

    const rightDown = panBy(fit, 100000, 100000, b);
    expect(rightDown.x).toBe(b.stage.w - 16);
    expect(rightDown.y).toBe(b.stage.h - 16);
    expect(visibleSpan(rightDown.x, b.stage.w, 16)).toBe(16);
    expect(visibleSpan(rightDown.y, b.stage.h, 16)).toBe(16);
  });

  it('panBy switches from fit to free', () => {
    const b = bounds(800, 600, 4000, 1000);
    const next = panBy(fitTransform(b), -20, -10, b);
    expect(next.mode).toBe('free');
    expect(next.scale).toBeCloseTo(0.2, 10);
    expect(next.x).toBeCloseTo(-20, 10);
    expect(next.y).toBeCloseTo(190, 10);
  });

  it('oneToOne goes to 100% keeping the stage-centre image point', () => {
    const b = bounds(800, 600, 4000, 1000);
    const fit = fitTransform(b);
    const anchor = stageCentre(b);
    const beforeX = (anchor.x - fit.x) / fit.scale;
    const beforeY = (anchor.y - fit.y) / fit.scale;

    const next = oneToOne(fit, b);
    expect(next.scale).toBe(1);
    expect(next.mode).toBe('free');
    expect(next.x + beforeX).toBeCloseTo(anchor.x, 6);
    expect(next.y + beforeY).toBeCloseTo(anchor.y, 6);
  });

  it('wheelFactor zooms in on negative deltas and out on positive ones', () => {
    expect(wheelFactor(-100, 0)).toBeGreaterThan(1);
    expect(wheelFactor(100, 0)).toBeLessThan(1);
    expect(wheelFactor(-100, 0) * wheelFactor(100, 0)).toBeCloseTo(1, 10);
    expect(wheelFactor(0, 0)).toBe(1);
  });

  it('wheelFactor treats line deltas as 40px', () => {
    expect(wheelFactor(-3, 1)).toBeCloseTo(wheelFactor(-120, 0), 10);
  });

  it('wheelFactor clamps a page delta', () => {
    expect(wheelFactor(-1, 2)).toBeLessThanOrEqual(2);
    expect(wheelFactor(1, 2)).toBeGreaterThanOrEqual(0.5);
    expect(wheelFactor(-100000, 0)).toBeLessThanOrEqual(2);
    expect(wheelFactor(100000, 0)).toBeGreaterThanOrEqual(0.5);
  });

  it('isPixelated only at 200% and above', () => {
    expect(isPixelated(1.99)).toBe(false);
    expect(isPixelated(2)).toBe(true);
  });

  it('formatZoomLabel shows fit mode and real percentages', () => {
    expect(formatZoomLabel(view(0.25, 'fit'), 'Fit')).toBe('Fit · 25%');
    expect(formatZoomLabel(view(2.5, 'free'), 'Fit')).toBe('250%');
    expect(formatZoomLabel(view(0.05, 'free'), 'Fit')).toBe('5%');
  });
});
