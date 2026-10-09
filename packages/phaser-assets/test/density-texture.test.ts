import type Phaser from 'phaser';
import { describe, expect, it, vi } from 'vitest';

import {
  generateDensityAwareTexture,
  readDensityAwareTextureMetrics,
} from '../src/density-texture.js';

describe('density-aware Phaser textures', () => {
  it('bakes physical pixels while preserving logical frame geometry', () => {
    const source = { resolution: 1 };
    const frame = {
      cutWidth: 96,
      cutHeight: 144,
      customData: {},
      data: {
        radius: 0,
        sourceSize: { h: 0, w: 0 },
        spriteSourceSize: { h: 0, w: 0 },
      },
      source,
    };
    let exists = false;
    const graphics = {
      scaleX: 1,
      scaleY: 1,
      generateTexture: vi.fn(() => { exists = true; }),
      setScale: vi.fn(() => graphics),
    };
    const scene = {
      textures: {
        exists: vi.fn(() => exists),
        get: vi.fn(() => ({ get: () => frame })),
      },
    };

    generateDensityAwareTexture(
      scene as unknown as Phaser.Scene,
      graphics as unknown as Phaser.GameObjects.Graphics,
      'sample.texture',
      48,
      72,
      2,
    );

    expect(graphics.setScale).toHaveBeenCalledWith(2);
    expect(graphics.generateTexture).toHaveBeenCalledWith('sample.texture', 96, 144);
    expect(source.resolution).toBe(2);
    expect(frame.data.sourceSize).toEqual({ h: 72, w: 48 });
    expect(frame.data.spriteSourceSize).toEqual({ h: 72, w: 48 });
    expect(frame.data.radius).toBeCloseTo(Math.hypot(48, 72) / 2);
    expect(readDensityAwareTextureMetrics(
      scene as unknown as Phaser.Scene,
      'sample.texture',
    )).toEqual({
      key: 'sample.texture',
      logicalHeight: 72,
      logicalWidth: 48,
      pixelHeight: 144,
      pixelWidth: 96,
      resolution: 2,
    });
  });

  it('rejects invalid logical geometry and resolution', () => {
    const scene = {} as Phaser.Scene;
    const graphics = {} as Phaser.GameObjects.Graphics;

    expect(() => generateDensityAwareTexture(
      scene,
      graphics,
      'bad',
      0,
      72,
      2,
    )).toThrow(/logicalWidth/u);
    expect(() => generateDensityAwareTexture(
      scene,
      graphics,
      'bad',
      48,
      72,
      0,
    )).toThrow(/resolution/u);
  });
});

it('restores graphics scale when texture generation fails', () => {
  const failure = new Error('renderer failure');
  const graphics = { scaleX: 2, scaleY: 3, setScale: vi.fn(), generateTexture: () => { throw failure; } };
  expect(() => generateDensityAwareTexture({ textures: { exists: () => false } } as unknown as Phaser.Scene, graphics as unknown as Phaser.GameObjects.Graphics,
    'sample.texture', 48, 72, 2)).toThrow(failure);
  expect(graphics.setScale).toHaveBeenLastCalledWith(2, 3);
});

it('rejects excessive physical pixels before mutating the renderer', () => {
  const graphics = { setScale: vi.fn() };
  expect(() => generateDensityAwareTexture({ textures: { exists: () => false } } as unknown as Phaser.Scene, graphics as unknown as Phaser.GameObjects.Graphics,
    'sample.texture', 10_000, 10_000, 2)).toThrow(/pixel budget/u);
  expect(graphics.setScale).not.toHaveBeenCalled();
});
