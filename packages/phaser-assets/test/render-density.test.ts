import { describe, expect, it, vi } from 'vitest';
import {
  createRenderDensityStore,
  observeDevicePixelRatio,
  resolveRenderDensity,
  toRenderPixels,
} from '../src/render-density.js';
const renderDensityPolicy = { maximumBackingPixels: 3_145_728, maximumDensity: 2 } as const;

describe('render density helpers', () => {
  it('bounds dense backing pixels without changing logical dimensions', () => {
    const density = resolveRenderDensity({
      devicePixelRatio: 3,
      height: 844,
      width: 390,
    }, renderDensityPolicy);

    expect(density).toBe(2);
    expect(toRenderPixels(390, density)).toBe(780);
    expect(toRenderPixels(844, density)).toBe(1_688);

    const largeDensity = resolveRenderDensity({
      devicePixelRatio: 3,
      height: 1_600,
      width: 1_200,
    }, renderDensityPolicy);
    expect(
      toRenderPixels(1_200, largeDensity)
      * toRenderPixels(1_600, largeDensity),
    ).toBeLessThanOrEqual(renderDensityPolicy.maximumBackingPixels);
  });

  it('keeps stable snapshots and increments revisions only for changed inputs', () => {
    const store = createRenderDensityStore({
      devicePixelRatio: 1,
      height: 844,
      width: 390,
    }, renderDensityPolicy);
    const initial = store.getSnapshot();

    expect(store.update({ devicePixelRatio: 1, height: 844, width: 390 })).toBe(initial);
    expect(store.update({ devicePixelRatio: 2, height: 844, width: 390 })).toMatchObject({
      density: 2,
      revision: 1,
    });
  });

  it('re-arms DPR observation and removes the active listener on dispose', () => {
    const queries: FakeResolutionMediaQuery[] = [];
    const source = {
      devicePixelRatio: 1,
      matchMedia: vi.fn((query: string) => {
        const mediaQuery = new FakeResolutionMediaQuery(query);
        queries.push(mediaQuery);
        return mediaQuery;
      }),
    };
    const onChange = vi.fn();
    const dispose = observeDevicePixelRatio(source, onChange);

    source.devicePixelRatio = 2;
    queries[0]?.dispatchChange();
    expect(onChange).toHaveBeenCalledWith(2);
    expect(queries[1]?.query).toBe('(resolution: 2dppx)');

    dispose();
    source.devicePixelRatio = 3;
    queries[1]?.dispatchChange();
    expect(onChange).toHaveBeenCalledOnce();
  });
});

class FakeResolutionMediaQuery {
  private readonly listeners = new Set<() => void>();

  constructor(readonly query: string) {}

  addEventListener(_type: 'change', listener: () => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'change', listener: () => void): void {
    this.listeners.delete(listener);
  }

  dispatchChange(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

it('captures density policy instead of retaining mutable consumer configuration', () => {
  const policy = { maximumBackingPixels: 40_000, maximumDensity: 2 };
  const store = createRenderDensityStore({ width: 100, height: 100, devicePixelRatio: 1 }, policy);
  policy.maximumDensity = 10;
  expect(store.update({ width: 100, height: 100, devicePixelRatio: 4 }).density).toBe(2);
  const before = store.getSnapshot();
  expect(() => store.update({ width: Infinity, height: 100, devicePixelRatio: 2 })).toThrow();
  expect(store.getSnapshot()).toBe(before);
});

it('bounds precision work and never exceeds feasible rounded-pixel budgets', () => {
  for (const width of [1, 3, 100, 375]) {
    for (const height of [1, 100, 844, 10_000]) {
      for (const precision of [0, 2, 6]) {
        const budget = Math.ceil(width * height * 1.8);
        const density = resolveRenderDensity({ width, height, devicePixelRatio: 64 },
          { maximumBackingPixels: budget, maximumDensity: 64, precision });
        expect(toRenderPixels(width, density) * toRenderPixels(height, density)).toBeLessThanOrEqual(budget);
      }
    }
  }
  expect(resolveRenderDensity({ width: 1000, height: 1000, devicePixelRatio: 2 },
    { maximumBackingPixels: 100, maximumDensity: 2 })).toBe(1);
});

it.each([0, .5, NaN, Infinity, 1_000_000_001])('rejects invalid density dimensions %s', (width) => {
  expect(() => resolveRenderDensity({ width, height: 10, devicePixelRatio: 2 }, renderDensityPolicy)).toThrow();
});
