import assert from 'node:assert/strict';
import { resolveRenderBackingSize } from '../dist/resolution.js';
import { resolveRenderDensity } from '../dist/render-density.js';
import { generateDensityAwareTexture } from '../dist/density-texture.js';

assert.equal(typeof globalThis.document, 'undefined');
assert.equal(typeof generateDensityAwareTexture, 'function');
const result = resolveRenderBackingSize(
  { width: 100, height: 100 },
  { width: 100, height: 100, devicePixelRatio: 2 },
  { id: 'sample', label: 'Sample', maxBackingPixels: 100, maxDevicePixelRatio: 2,
    maxRasterScale: 2, hudHz: 30 },
);
assert.equal(result.width * result.height, 100);
assert.equal(resolveRenderDensity({ width: 100, height: 100, devicePixelRatio: 2 },
  { maximumBackingPixels: 40_000, maximumDensity: 2 }), 2);
console.log('Render resolution headless dist imports passed.');
