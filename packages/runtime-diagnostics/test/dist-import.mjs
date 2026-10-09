import assert from 'node:assert/strict';
import { NamedFrameProfiler as rootProfiler } from '../dist/index.js';
import { NamedFrameProfiler } from '../dist/frame-profiler.js';

assert.equal(rootProfiler, NamedFrameProfiler);
assert.equal(typeof globalThis.window, 'undefined');
assert.equal(typeof globalThis.document, 'undefined');
const profiler = new NamedFrameProfiler(['workMs'], () => 0);
profiler.begin();
profiler.finish();
assert.equal(profiler.snapshot().frames, 1);
console.log('Runtime diagnostics headless dist imports passed.');
