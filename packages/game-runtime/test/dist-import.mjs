import assert from 'node:assert/strict';

import { createGameExecutionController } from '@mpgd/game-runtime';

assert.equal(typeof globalThis.document, 'undefined');
assert.equal(typeof globalThis.Phaser, 'undefined');
const runtime = createGameExecutionController();
const block = runtime.acquireBlock({ reason: 'headless', channels: ['simulation'] });
assert.equal(runtime.getSnapshot().blocked.simulation, true);
block.release();
assert.equal(runtime.getSnapshot().blocked.simulation, false);
runtime.destroy();
console.log('game-runtime compiled ESM import passed');
