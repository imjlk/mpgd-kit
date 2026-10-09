import { describe, expect, it } from 'vitest';
import {
  resolveRenderBackingSize,
  validateRenderQualities,
  type RenderQualityPreset,
} from '../src/resolution.js';

const balanced: RenderQualityPreset = {
  id: 'balanced',
  label: 'Balanced',
  maxBackingPixels: 1_800_000,
  maxDevicePixelRatio: 2,
  maxRasterScale: 1,
  hudHz: 30,
};
const viewport = { width: 1440, height: 900, devicePixelRatio: 2 };

function presets() {
  return { defaultQualityId: 'balanced', qualities: [{ ...balanced }] };
}

describe('external runtime quality validation', () => {
  it('validates and detaches named presets with fractional raster and DPR caps', () => {
    const input = presets();
    input.qualities.push({ ...balanced, id: 'detail', maxRasterScale: 1.5 });
    const validated = validateRenderQualities(input);
    expect(validated).toEqual(input);
    const first = input.qualities[0];
    if (!first) {
      throw new Error('Expected the first quality fixture.');
    }
    first.maxBackingPixels = 100;
    expect(validated.qualities[0]?.maxBackingPixels).toBe(1_800_000);
  });
  it.each<unknown>([null, [], {}, { defaultQualityId: 'missing', qualities: [balanced] }, { ...presets(), unknown: true }])('rejects malformed catalogs %j', (value) => {
    expect(() => validateRenderQualities(value)).toThrow(TypeError);
  });
  it('rejects empty, duplicate, sparse, and excessive preset lists', () => {
    for (const qualities of [[], [balanced, balanced], new Array(1), Array.from({ length: 17 }, () => balanced)]) {
      expect(() => validateRenderQualities({ defaultQualityId: 'balanced', qualities })).toThrow(TypeError);
    }
  });
  it.each([
    { id: 'UPPER' },
    { id: '-bad' },
    { id: 'bad-' },
    { id: 'a'.repeat(65) },
    { label: ' ' },
    { label: 'bad\nlabel' },
    { label: 'a'.repeat(81) },
    { maxBackingPixels: 0 },
    { maxBackingPixels: 1.5 },
    { maxBackingPixels: Infinity },
    { maxBackingPixels: 16_777_217 },
    { maxDevicePixelRatio: 0 },
    { maxDevicePixelRatio: NaN },
    { maxDevicePixelRatio: 9 },
    { maxRasterScale: 0 },
    { maxRasterScale: Infinity },
    { maxRasterScale: 5 },
    { hudHz: 0 },
    { hudHz: 29.97 },
    { hudHz: 121 },
    { unknown: 1 },
  ])('rejects invalid preset metadata %j', (patch) => {
    const quality = { ...balanced, ...patch };
    expect(() => validateRenderQualities({ defaultQualityId: quality.id, qualities: [quality] })).toThrow(TypeError);
  });
});

describe('bounded backing-store resolution', () => {
  it('uses logical coordinates independently of a larger device pixel ratio', () => {
    const layout = { width: 1440, height: 900 };
    expect(resolveRenderBackingSize(layout, viewport, balanced)).toEqual({ ...layout, scaleX: 1, scaleY: 1 });
    expect(layout).toEqual({ width: 1440, height: 900 });
  });
  it('honors both CSS axes, a fractional DPR limit, and the raster scale limit', () => {
    const layout = { width: 1000, height: 1000 };
    const quality = { ...balanced, maxDevicePixelRatio: 1.5, maxRasterScale: 1.5 };
    const size = resolveRenderBackingSize(layout, { width: 1000, height: 400, devicePixelRatio: 3 }, quality);
    expect(size).toEqual({ width: 600, height: 600, scaleX: 0.6, scaleY: 0.6 });
    expect(resolveRenderBackingSize(layout, viewport, { ...quality, maxRasterScale: 0.5 }).width).toBe(500);
  });
  it('respects total pixels when a detail preset exceeds the budget', () => {
    const quality = { ...balanced, maxBackingPixels: 3_000_000, maxRasterScale: 1.5, maxDevicePixelRatio: 3 };
    const result = resolveRenderBackingSize({ width: 3840, height: 2160 }, { width: 3840, height: 2160, devicePixelRatio: 3 }, quality);
    expect(result.width * result.height).toBeLessThanOrEqual(quality.maxBackingPixels);
    expect(Math.abs(result.width - result.height * 3840 / 2160)).toBeLessThan(2);
  });
  it.each([
    { width: 1_000_000_000, height: 1 },
    { width: 1, height: 1_000_000_000 },
    { width: 1_000_000_000, height: 1_000_000_000 },
    { width: 1, height: 1 },
  ])('keeps the budget positive and bounded at extreme dimensions %j', (layout) => {
    for (const budget of [1, 2, 800_000, 1_800_000]) {
      const result = resolveRenderBackingSize(layout, { ...layout, devicePixelRatio: 2 }, { ...balanced, maxBackingPixels: budget });
      expect(Number.isInteger(result.width)).toBe(true);
      expect(Number.isInteger(result.height)).toBe(true);
      expect(result.width).toBeGreaterThanOrEqual(1);
      expect(result.height).toBeGreaterThanOrEqual(1);
      expect(result.width * result.height).toBeLessThanOrEqual(budget);
    }
  });
  it('reports exact scale factors for reversible logical input and render transforms', () => {
    const layout = { width: 1236, height: 857 };
    const result = resolveRenderBackingSize(layout, { width: 413, height: 286, devicePixelRatio: 1.5 }, balanced);
    const point = { x: 523.25, y: 123.75 };
    const backing = { x: point.x * result.scaleX, y: point.y * result.scaleY };
    expect(backing.x / result.scaleX).toBeCloseTo(point.x, 12);
    expect(backing.y / result.scaleY).toBeCloseTo(point.y, 12);
    expect(layout.width * result.scaleX).toBe(result.width);
    expect(layout.height * result.scaleY).toBe(result.height);
    expect(Math.abs(result.scaleX - result.scaleY)).toBeLessThan(1 / layout.width + 1 / layout.height);
  });
  it('holds budgets and per-axis caps over a range of aspect ratios and device sizes', () => {
    for (const width of [1, 37, 375, 1236, 4000, 1_000_000]) {
      for (const height of [1, 41, 667, 900, 3840]) {
        const layout = { width, height };
        const quality = { ...balanced, maxBackingPixels: 800_000, maxRasterScale: 1.5 };
        const result = resolveRenderBackingSize(layout, viewport, quality);
        expect(result.width * result.height).toBeLessThanOrEqual(quality.maxBackingPixels);
        expect(result.width).toBeLessThanOrEqual(Math.max(1, width * quality.maxRasterScale));
        expect(result.height).toBeLessThanOrEqual(Math.max(1, height * quality.maxRasterScale));
        expect(result.width).toBeLessThanOrEqual(viewport.width * 2);
        expect(result.height).toBeLessThanOrEqual(viewport.height * 2);
      }
    }
  });
  it.each([0, -1, NaN, Infinity, 1_000_000_001])('rejects invalid logical or CSS dimensions %s', (width) => {
    expect(() => resolveRenderBackingSize({ width, height: 100 }, viewport, balanced)).toThrow(TypeError);
    expect(() => resolveRenderBackingSize({ width: 100, height: width }, viewport, balanced)).toThrow(TypeError);
    expect(() => resolveRenderBackingSize({ width: 100, height: 100 }, { ...viewport, width }, balanced)).toThrow(TypeError);
  });
  it.each([0, -1, NaN, Infinity, 65])('rejects invalid device pixel ratios %s', (devicePixelRatio) => {
    expect(() => resolveRenderBackingSize({ width: 100, height: 100 }, { ...viewport, devicePixelRatio }, balanced)).toThrow(TypeError);
  });
});
