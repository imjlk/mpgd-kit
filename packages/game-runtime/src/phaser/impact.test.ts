import type Phaser from 'phaser';
import { describe, expect, it, vi } from 'vitest';

import { createImpactContact, type ImpactFeedbackRecipe } from '../impact/index.js';
import { PhaserImpactFeedbackPool } from './impact.js';

class FakeGameObject {
  active = true;
  readonly alphaValues: number[] = [];
  destroyed = false;
  readonly frames: string[] = [];
  setActiveCalls = 0;
  setAlphaCalls = 0;
  setDisplaySizeCalls = 0;
  setFillStyleCalls = 0;
  setPositionCalls = 0;
  setRadiusCalls = 0;
  setRotationCalls = 0;
  setStrokeStyleCalls = 0;
  setVisibleCalls = 0;
  visible = true;

  destroy(): void {
    this.destroyed = true;
  }

  setActive(value: boolean): this {
    this.setActiveCalls += 1;
    this.active = value;
    return this;
  }

  setAlpha(value: number): this {
    this.setAlphaCalls += 1;
    this.alphaValues.push(value);
    return this;
  }

  setDepth(_value: number): this {
    return this;
  }

  setDisplaySize(_width: number, _height: number): this {
    this.setDisplaySizeCalls += 1;
    return this;
  }

  setFillStyle(_color: number, _alpha?: number): this {
    this.setFillStyleCalls += 1;
    return this;
  }

  setPosition(_x: number, _y: number): this {
    this.setPositionCalls += 1;
    return this;
  }

  setRadius(_radius: number): this {
    this.setRadiusCalls += 1;
    return this;
  }

  setRotation(_rotation: number): this {
    this.setRotationCalls += 1;
    return this;
  }

  setFrame(frame: string): this {
    this.frames.push(frame);
    return this;
  }

  setStrokeStyle(_lineWidth: number, _color: number, _alpha?: number): this {
    this.setStrokeStyleCalls += 1;
    return this;
  }

  setVisible(value: boolean): this {
    this.setVisibleCalls += 1;
    this.visible = value;
    return this;
  }
}

class FakeGraphics extends FakeGameObject {
  readonly points: Array<readonly [string, number, number]> = [];
  beginPathCalls = 0;
  clearCalls = 0;
  lineToCalls = 0;
  readonly lineStyles: Array<{ alpha: number; color: number; width: number }> = [];
  moveToCalls = 0;
  strokePathCalls = 0;

  beginPath(): this {
    this.beginPathCalls += 1;
    return this;
  }

  clear(): this {
    this.clearCalls += 1;
    this.points.length = 0;
    return this;
  }

  lineStyle(width: number, color: number, alpha: number): this {
    this.lineStyles.push({ alpha, color, width });
    return this;
  }

  lineTo(x: number, y: number): this {
    this.lineToCalls += 1;
    this.points.push(['line', x, y]);
    return this;
  }

  moveTo(x: number, y: number): this {
    this.moveToCalls += 1;
    this.points.push(['move', x, y]);
    return this;
  }

  strokePath(): this {
    this.strokePathCalls += 1;
    return this;
  }
}

const recipe: ImpactFeedbackRecipe = {
  durationMs: 100,
  id: 'test',
  ring: { color: 0xffffff, endRadius: 18, startRadius: 4 },
  sparks: {
    color: 0xffc857,
    count: 2,
    endDistance: 24,
    length: 8,
    spreadRadians: Math.PI,
    width: 2,
  },
};

describe('PhaserImpactFeedbackPool', () => {
  it('draws directional, anchored and marked geometry in the same bounded batch and resets on reuse', () => {
    const graphics = new FakeGraphics();
    const circle = vi.fn(() => new FakeGameObject());
    const scene = {
      add: { circle, graphics: () => graphics },
      cameras: { main: { flash: vi.fn() } },
      events: { off: vi.fn(), once: vi.fn() },
    } as unknown as Phaser.Scene;
    const pool = new PhaserImpactFeedbackPool(scene, { capacity: 1 });
    const contact = createImpactContact({ atMs: 0, x: 0, y: 0, normalX: 1, normalY: 0,
      source: { kind: 'projectile' }, target: { kind: 'enemy' } });
    const draw = (shape: 'chevron' | 'bracket' | 'cross' | undefined, endDistance: number) => {
      pool.emit(contact, { id: 'shape', durationMs: 100, sparks: { ...(shape === undefined ? {} : { shape }), color: 0xffffff,
        count: 1, startDistance: 20, endDistance, length: 8, width: 2, spreadRadians: 0 } });
      pool.update(0);
      return graphics.points;
    };
    expect(draw('chevron', 40)).toEqual([['move', 16, 4], ['line', 24, 0], ['line', 16, -4]]);
    expect(draw('chevron', 4)).toEqual([['move', 24, 4], ['line', 16, 0], ['line', 24, -4]]);
    expect(draw('bracket', 20)).toEqual([['move', 24, -4], ['line', 24, 4], ['line', 16, 4]]);
    expect(draw('cross', 20)).toEqual([['move', 16, 0], ['line', 24, 0], ['move', 20, -4], ['line', 20, 4]]);
    pool.update(50);
    expect(graphics.points).toEqual([['move', 16, 0], ['line', 24, 0], ['move', 20, -4], ['line', 20, 4]]);
    expect(graphics.lineStyles.at(-1)?.alpha).toBe(0.25);
    expect(draw(undefined, 40)).toEqual([['move', 16, 0], ['line', 24, 0]]);
    expect(circle).toHaveBeenCalledTimes(1);
    expect(pool.diagnostics()).toMatchObject({ capacity: 1, activeEffects: 1, recycledEffects: 4 });
    pool.clear();
    expect(graphics.visible).toBe(false);
    expect(graphics.points).toEqual([]);
    expect(pool.diagnostics().activeEffects).toBe(0);
  });
  it('reuses raster rings, falls back to shapes and clears every sprite on restart', () => {
    const circles: FakeGameObject[] = [];
    const images: FakeGameObject[] = [];
    const scene = {
      add: {
        circle: () => { const object = new FakeGameObject(); circles.push(object); return object; },
        image: () => { const object = new FakeGameObject(); images.push(object); return object; },
        graphics: () => new FakeGraphics(),
      },
      textures: { get: () => ({ has: (frame: string) => ['strike', 'middle', 'end'].includes(frame) }) },
      cameras: { main: { flash: vi.fn() } },
      events: { off: vi.fn(), once: vi.fn() },
    } as unknown as Phaser.Scene;
    const pool = new PhaserImpactFeedbackPool(scene, {
      capacity: 1, rasterRings: { textureKey: 'art', recipeFrames: { test: 'strike' } },
    });
    const contact = createImpactContact({ atMs: 0, source: { kind: 'projectile' }, target: { kind: 'enemy' }, x: 10, y: 20 });
    pool.emit(contact, recipe);
    expect(images[0]?.visible).toBe(true);
    expect(circles[0]?.visible).toBe(false);
    pool.update(50);
    expect(images[0]?.setDisplaySizeCalls).toBeGreaterThan(1);
    pool.clear();
    expect(images[0]?.visible).toBe(false);
    pool.emit(contact, { ...recipe, id: 'vector-only' });
    expect(circles[0]?.visible).toBe(true);
    expect(images[0]?.visible).toBe(false);
    pool.emit(contact, recipe);
    pool.update(100);
    expect(pool.diagnostics().activeEffects).toBe(0);
    expect(images[0]?.visible).toBe(false);
    expect(images).toHaveLength(1);
    pool.destroy();
    expect(images[0]?.destroyed).toBe(true);
    expect(() => new PhaserImpactFeedbackPool(scene, {
      rasterRings: { textureKey: 'art', recipeFrames: { test: 'missing' } },
    })).toThrow(/Impact art frame/u);
    expect(() => new PhaserImpactFeedbackPool(scene, {
      rasterRings: { textureKey: 'art', recipeFrames: { test: [] } },
    })).toThrow(/sequence is invalid/u);
    const animated = new PhaserImpactFeedbackPool(scene, {
      capacity: 1, rasterRings: { textureKey: 'art', recipeFrames: { test: ['strike', 'middle', 'end'] } },
    });
    animated.emit(contact, recipe);
    animated.update(40);
    animated.update(45);
    animated.update(80);
    expect(images[1]?.frames).toEqual(['strike', 'middle', 'end']);
    animated.clear();
    animated.emit({ ...contact, atMs: 100 }, recipe);
    expect(images[1]?.frames.at(-1)).toBe('strike');
    animated.update(200);
    expect(images[1]?.visible).toBe(false);
    expect(images).toHaveLength(2);
    animated.destroy();
  });
  it('prewarms fixed rings and one spark batch, then recycles without creating game objects', () => {
    const circles: FakeGameObject[] = [];
    const graphics: FakeGraphics[] = [];
    const flash = vi.fn();
    const off = vi.fn();
    const once = vi.fn();
    const scene = {
      add: {
        circle: () => {
          const object = new FakeGameObject();
          circles.push(object);
          return object;
        },
        graphics: () => {
          const object = new FakeGraphics();
          graphics.push(object);
          return object;
        },
      },
      cameras: { main: { flash } },
      events: { off, once },
    } as unknown as Phaser.Scene;
    const pool = new PhaserImpactFeedbackPool(scene, {
      capacity: 2,
      maxSparksPerEffect: 2,
    });
    const impact = createImpactContact({
      atMs: 0,
      source: { kind: 'projectile' },
      target: { kind: 'enemy' },
      x: 10,
      y: 20,
    });

    expect(circles).toHaveLength(2);
    expect(graphics).toHaveLength(1);

    pool.emit(impact, recipe);
    pool.emit(impact, recipe);
    pool.emit(impact, recipe);

    expect(circles).toHaveLength(2);
    expect(graphics).toHaveLength(1);
    expect(pool.diagnostics()).toEqual({
      activeEffects: 2,
      availableEffects: 0,
      capacity: 2,
      emittedEffects: 3,
      peakActiveEffects: 2,
      recycledEffects: 1,
    });

    pool.update(50);
    expect(graphics[0]?.strokePathCalls).toBe(2);
    pool.update(100);
    expect(pool.diagnostics().activeEffects).toBe(0);

    pool.destroy();
    expect([...circles, ...graphics].every((object) => object.destroyed)).toBe(true);
    expect(off).toHaveBeenCalledWith('shutdown', pool.destroy);
    expect(off).toHaveBeenCalledWith('destroy', pool.destroy);
  });

  it('caches spark trigonometry and batches the preserved fade curve by effect', () => {
    const circles: FakeGameObject[] = [];
    const graphics = new FakeGraphics();
    const scene = {
      add: {
        circle: () => {
          const object = new FakeGameObject();
          circles.push(object);
          return object;
        },
        graphics: () => graphics,
      },
      cameras: { main: { flash: vi.fn() } },
      events: { off: vi.fn(), once: vi.fn() },
    } as unknown as Phaser.Scene;
    const pool = new PhaserImpactFeedbackPool(scene, { capacity: 1, maxSparksPerEffect: 2 });
    const impact = createImpactContact({
      atMs: 0,
      normalX: 1,
      normalY: 1,
      source: { kind: 'projectile' },
      target: { kind: 'enemy' },
      x: 10,
      y: 20,
    });
    const atan2 = vi.spyOn(Math, 'atan2');
    const cosine = vi.spyOn(Math, 'cos');
    const sine = vi.spyOn(Math, 'sin');

    pool.emit(impact, recipe);
    const ring = circles[0] as FakeGameObject;
    const staticCalls = {
      ringActive: ring.setActiveCalls,
      ringFill: ring.setFillStyleCalls,
      ringStroke: ring.setStrokeStyleCalls,
      ringVisible: ring.setVisibleCalls,
    };
    const trigonometryCalls = {
      atan2: atan2.mock.calls.length,
      cosine: cosine.mock.calls.length,
      sine: sine.mock.calls.length,
    };

    pool.update(50);

    expect({
      ringActive: ring.setActiveCalls,
      ringFill: ring.setFillStyleCalls,
      ringStroke: ring.setStrokeStyleCalls,
      ringVisible: ring.setVisibleCalls,
    }).toEqual(staticCalls);
    expect({
      atan2: atan2.mock.calls.length,
      cosine: cosine.mock.calls.length,
      sine: sine.mock.calls.length,
    }).toEqual(trigonometryCalls);
    expect(ring.setAlphaCalls).toBe(2);
    expect(ring.setRadiusCalls).toBe(2);
    expect(graphics.lineStyles).toHaveLength(1);
    expect(graphics.lineStyles[0]?.alpha).toBeCloseTo(0.015625);
    expect(graphics.moveToCalls).toBe(2);
    expect(graphics.lineToCalls).toBe(2);
    expect(graphics.strokePathCalls).toBe(1);

    atan2.mockRestore();
    cosine.mockRestore();
    sine.mockRestore();
  });

  it('clears live rings and the shared spark batch while preserving prewarmed slots', () => {
    const circles: FakeGameObject[] = [];
    const graphics = new FakeGraphics();
    const flash = vi.fn();
    const scene = {
      add: {
        circle: () => {
          const object = new FakeGameObject();
          circles.push(object);
          return object;
        },
        graphics: () => graphics,
      },
      cameras: { main: { flash } },
      events: { off: vi.fn(), once: vi.fn() },
    } as unknown as Phaser.Scene;
    const pool = new PhaserImpactFeedbackPool(scene, { capacity: 2, maxSparksPerEffect: 2 });
    const impactAt = (atMs: number) => createImpactContact({
      atMs,
      source: { kind: 'projectile' },
      target: { kind: 'enemy' },
      x: 10,
      y: 20,
    });

    pool.emit(impactAt(4_000), recipe);
    pool.update(4_020);
    expect(pool.diagnostics().activeEffects).toBe(1);
    expect(graphics.visible).toBe(true);
    const sparkClearCallsBeforeReset = graphics.clearCalls;

    pool.clear();

    expect(pool.diagnostics()).toEqual({
      activeEffects: 0,
      availableEffects: 2,
      capacity: 2,
      emittedEffects: 1,
      peakActiveEffects: 1,
      recycledEffects: 0,
    });
    expect(circles.every((circle) => !circle.active && !circle.visible)).toBe(true);
    expect(graphics.active).toBe(false);
    expect(graphics.visible).toBe(false);
    expect(graphics.clearCalls).toBeGreaterThan(sparkClearCallsBeforeReset);
    expect(circles).toHaveLength(2);

    pool.emit(impactAt(0), { ...recipe, flash: { color: 0xffffff, durationMs: 80 } });
    expect(pool.diagnostics()).toEqual({
      activeEffects: 1,
      availableEffects: 1,
      capacity: 2,
      emittedEffects: 2,
      peakActiveEffects: 1,
      recycledEffects: 0,
    });
    expect(flash).toHaveBeenCalledOnce();

    pool.destroy();
    const destroyedDiagnostics = pool.diagnostics();
    expect(() => pool.clear()).not.toThrow();
    expect(pool.diagnostics()).toEqual(destroyedDiagnostics);
  });

  it('removes independently expiring slots from the active update list', () => {
    const scene = {
      add: {
        circle: () => new FakeGameObject(),
        graphics: () => new FakeGraphics(),
      },
      cameras: { main: { flash: vi.fn() } },
      events: { off: vi.fn(), once: vi.fn() },
    } as unknown as Phaser.Scene;
    const pool = new PhaserImpactFeedbackPool(scene, { capacity: 3, maxSparksPerEffect: 0 });
    const impactAt = (atMs: number) =>
      createImpactContact({
        atMs,
        source: { kind: 'projectile' },
        target: { kind: 'enemy' },
        x: 0,
        y: 0,
      });

    pool.emit(impactAt(0), { ...recipe, durationMs: 50 });
    pool.emit(impactAt(0), { ...recipe, durationMs: 100 });
    pool.emit(impactAt(0), { ...recipe, durationMs: 150 });

    pool.update(60);
    expect(pool.diagnostics().activeEffects).toBe(2);
    pool.update(110);
    expect(pool.diagnostics().activeEffects).toBe(1);
    pool.update(160);
    expect(pool.diagnostics()).toMatchObject({ activeEffects: 0, peakActiveEffects: 3 });
  });

  it('hides and restores the shared spark batch when a recycled slot changes recipe shape', () => {
    const graphics = new FakeGraphics();
    const scene = {
      add: {
        circle: () => new FakeGameObject(),
        graphics: () => graphics,
      },
      cameras: { main: { flash: vi.fn() } },
      events: { off: vi.fn(), once: vi.fn() },
    } as unknown as Phaser.Scene;
    const pool = new PhaserImpactFeedbackPool(scene, { capacity: 1, maxSparksPerEffect: 2 });
    const impact = createImpactContact({
      atMs: 0,
      source: { kind: 'projectile' },
      target: { kind: 'enemy' },
      x: 0,
      y: 0,
    });

    pool.emit(impact, recipe);
    pool.update(10);
    expect(graphics.visible).toBe(true);

    pool.emit(impact, {
      durationMs: 100,
      id: 'ring-only',
      ring: { color: 0xffffff, endRadius: 18, startRadius: 4 },
    });
    pool.update(20);
    expect(graphics.active).toBe(false);
    expect(graphics.visible).toBe(false);

    pool.emit(impact, recipe);
    pool.update(30);
    expect(graphics.active).toBe(true);
    expect(graphics.visible).toBe(true);
    expect(pool.diagnostics()).toMatchObject({ activeEffects: 1, recycledEffects: 2 });
  });

  it('throttles overlapping camera flashes by recipe duration', () => {
    const flash = vi.fn();
    const scene = {
      add: {
        circle: () => new FakeGameObject(),
        graphics: () => new FakeGraphics(),
      },
      cameras: { main: { flash } },
      events: { off: vi.fn(), once: vi.fn() },
    } as unknown as Phaser.Scene;
    const pool = new PhaserImpactFeedbackPool(scene, { capacity: 3, maxSparksPerEffect: 0 });
    const flashRecipe: ImpactFeedbackRecipe = {
      durationMs: 100,
      flash: { color: 0xff4020, durationMs: 80 },
      id: 'flash',
    };
    const impactAt = (atMs: number) =>
      createImpactContact({
        atMs,
        source: { kind: 'enemy' },
        target: { kind: 'worker' },
        x: 0,
        y: 0,
      });

    pool.emit(impactAt(100), flashRecipe);
    pool.emit(impactAt(120), flashRecipe);
    pool.emit(impactAt(180), flashRecipe);

    expect(flash).toHaveBeenCalledTimes(2);
  });
});

describe('impact pool bounds', () => {
  it('rejects allocation limits before creating objects', () => {
    const circle = vi.fn(() => new FakeGameObject());
    const scene = { add: { circle, graphics: () => new FakeGraphics() } } as unknown as Phaser.Scene;
    expect(() => new PhaserImpactFeedbackPool(scene, { capacity: 1025 })).toThrow('capacity');
    expect(() => new PhaserImpactFeedbackPool(scene, { maxSparksPerEffect: 65 })).toThrow('maxSparks');
    expect(() => new PhaserImpactFeedbackPool(scene, { rasterRings: { textureKey: 'art',
      recipeFrames: { hit: Array.from({ length: 65 }, () => 'hit') } } })).toThrow('sequence');
    expect(circle).not.toHaveBeenCalled();
  });
});
