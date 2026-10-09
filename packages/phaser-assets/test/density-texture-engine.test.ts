import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type Phaser from 'phaser';
import { expect, it, vi } from 'vitest';
import {
  generateDensityAwareTexture,
  normalizeTextureResolution,
  readDensityAwareTextureMetrics,
} from '../src/density-texture.js';

const require = createRequire(import.meta.url);
interface Source {
  width: number;
  height: number;
  resolution: number;
  isPowerOf2?: boolean;
}
interface BaseFrame {
  cutWidth: number;
  cutHeight: number;
  source: Source;
  customData: Record<string, unknown>;
  data: { sourceSize: { w: number; h: number }; spriteSourceSize: { w: number; h: number }; radius: number };
  setSize(width: number, height: number): void;
}
interface CanvasProbe {
  canvas: { width: number; height: number };
  width: number;
  height: number;
  _source: Source;
  frames: { __BASE: BaseFrame };
  context: { clearRect: (x: number, y: number, width: number, height: number) => void };
  refresh(): void;
  setSize(width: number, height: number): CanvasProbe;
  clear(x: number, y: number, width: number, height: number, update: boolean): CanvasProbe;
  get(): BaseFrame;
}
// Exercise the pinned engine's actual sizing/rendering methods without a GPU or DOM.
const CanvasTexture = require(
  fileURLToPath(new URL('../node_modules/phaser/src/textures/CanvasTexture.js', import.meta.url)),
) as {
  prototype: Pick<CanvasProbe, 'setSize' | 'clear'>;
};
interface RenderProbe {
  frameWidth: number;
  frameHeight: number;
  onRunBegin(): void;
  onRunEnd(): void;
}
const TexturerImage = require(
  fileURLToPath(
    new URL(
      '../node_modules/phaser/src/renderer/webgl/renderNodes/texturer/TexturerImage.js',
      import.meta.url,
    ),
  ),
) as {
  prototype: { run(this: RenderProbe, context: object, image: { frame: BaseFrame; isCropped: false }): void };
};

it.each([[1, 1, 1.5], [48, 72, 1.28], [5, 3, 1.9], [2, 4, .2]])(
  'preserves engine-rendered logical geometry for %s × %s at %s requested density',
  (width, height, resolution) => {
    const f = fixture();
    generateDensityAwareTexture(f.scene, f.graphics, 'sample.texture', width, height, resolution);
    const renderer: RenderProbe = { frameWidth: 0, frameHeight: 0, onRunBegin() {}, onRunEnd() {} };
    TexturerImage.prototype.run.call(renderer, {}, { frame: f.frame, isCropped: false });
    expect(renderer.frameWidth).toBeCloseTo(width, 12);
    expect(renderer.frameHeight).toBeCloseTo(height, 12);
    expect(f.frame.data.sourceSize).toEqual({ w: width, h: height });
    expect(f.graphics.setScale).toHaveBeenLastCalledWith(1, 1);
  },
);

it('regenerates an owned canvas in place using the real engine resizer and clears old pixels', () => {
  const f = fixture();
  generateDensityAwareTexture(f.scene, f.graphics, 'sample.texture', 48, 72, 1);
  const existingFrame = f.frame;
  generateDensityAwareTexture(f.scene, f.graphics, 'sample.texture', 48, 72, 2);
  expect(f.texture.canvas).toEqual({ width: 96, height: 144 });
  expect(f.frame).toBe(existingFrame);
  expect(f.frame.cutWidth).toBe(96);
  expect(f.frame.cutHeight).toBe(144);
  expect(f.texture.context.clearRect).toHaveBeenCalledWith(0, 0, 96, 144);
  expect(readDensityAwareTextureMetrics(f.scene, 'sample.texture')?.resolution).toBe(2);
});

it('rejects an occupied unowned texture before scaling or drawing', () => {
  const f = fixture();
  f.occupy();
  expect(() => generateDensityAwareTexture(f.scene, f.graphics, 'sample.texture', 48, 72, 2)).toThrow(
    /unowned/u,
  );
  expect(f.graphics.generateTexture).not.toHaveBeenCalled();
  expect(f.graphics.setScale).not.toHaveBeenCalled();
});

it('rejects nonuniform existing pixels before changing frame metadata', () => {
  const f = fixture();
  f.occupy();
  f.frame.cutWidth = 61;
  f.frame.cutHeight = 92;
  expect(() => normalizeTextureResolution(f.scene, 'sample.texture', 48, 72, 1.28)).toThrow(
    /uniform/u,
  );
  expect(f.frame.source.resolution).toBe(1);
  expect(f.frame.customData).toEqual({});
});

function fixture() {
  let exists = false;
  const source: Source = { width: 1, height: 1, resolution: 1 };
  const frame: BaseFrame = {
    cutWidth: 1,
    cutHeight: 1,
    source,
    customData: {},
    data: { sourceSize: { w: 1, h: 1 }, spriteSourceSize: { w: 1, h: 1 }, radius: 1 },
    setSize(width, height) {
      this.cutWidth = width;
      this.cutHeight = height;
    },
  };
  const texture: CanvasProbe = {
    width: 1,
    height: 1,
    canvas: { width: 1, height: 1 },
    _source: source,
    frames: { __BASE: frame },
    context: { clearRect: vi.fn() },
    refresh: vi.fn(),
    setSize(width, height) {
      CanvasTexture.prototype.setSize.call(this, width, height);
      return this;
    },
    clear(x, y, width, height, update) {
      CanvasTexture.prototype.clear.call(this, x, y, width, height, update);
      return this;
    },
    get: () => frame,
  };
  const graphics = {
    scaleX: 1,
    scaleY: 1,
    setScale: vi.fn(),
    generateTexture: vi.fn((_key: string, width: number, height: number) => {
      if (!exists) {
        texture.setSize(width, height);
        exists = true;
      }
    }),
  };
  const scene = {
    textures: { exists: () => exists, get: () => texture },
  } as unknown as Phaser.Scene;
  return {
    scene,
    graphics: graphics as typeof graphics & Phaser.GameObjects.Graphics,
    frame,
    texture,
    occupy: () => {
      exists = true;
    },
  };
}
