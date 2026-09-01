import assert from 'node:assert/strict';

import {
  classifyMiniGameRequestUrl,
  MiniGameRuntimeError,
  miniGamePhaserCanvasRenderer,
} from '../dist/index.js';

assert.equal(typeof MiniGameRuntimeError, 'function');
assert.equal(miniGamePhaserCanvasRenderer, 1);
assert.deepEqual(classifyMiniGameRequestUrl('assets/game.json'), {
  kind: 'local',
  path: 'assets/game.json',
});
