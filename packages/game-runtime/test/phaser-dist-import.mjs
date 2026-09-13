import assert from 'node:assert/strict';

import { bindPhaserGameScene } from '@mpgd/game-runtime/phaser';

assert.equal(typeof globalThis.document, 'undefined');
assert.equal(typeof bindPhaserGameScene, 'function');
console.log('Phaser binding compiled ESM imports without booting Phaser');
