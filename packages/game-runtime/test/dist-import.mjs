import assert from 'node:assert/strict';

import { createGameExecutionController } from '@mpgd/game-runtime';
import { bindGameLifecycle } from '@mpgd/game-runtime/platform';
import { createGameUiBridge } from '@mpgd/game-runtime/ui';

assert.equal(typeof globalThis.document, 'undefined');
assert.equal(typeof globalThis.Phaser, 'undefined');
const runtime = createGameExecutionController();
const block = runtime.acquireBlock({ reason: 'headless', channels: ['simulation'] });
assert.equal(runtime.getSnapshot().blocked.simulation, true);
block.release();
assert.equal(runtime.getSnapshot().blocked.simulation, false);
runtime.destroy();
const bridge = createGameUiBridge({ initialSnapshot: 0 });
const screen = bridge.createScope();
screen.setSnapshot(1);
screen.dispose();
assert.equal(screen.setSnapshot(2), false);
assert.equal(bridge.getSnapshot(), 1);
bridge.destroy();
const lifecycleRuntime = createGameExecutionController();
const lifecycle = bindGameLifecycle({
  controller: lifecycleRuntime,
  initialState: 'unknown',
  source: { onPause: () => () => {}, onResume: () => () => {} },
});
assert.equal(lifecycleRuntime.getSnapshot().blocked.simulation, true);
lifecycle.dispose();
assert.equal(lifecycleRuntime.getSnapshot().blocked.simulation, false);
lifecycleRuntime.destroy();
console.log('game-runtime compiled ESM import passed');

const { createGameActionCoordinator } = await import('@mpgd/game-runtime/actions');
const actionRuntime = createGameExecutionController();
const coordinator = createGameActionCoordinator({
  execution: actionRuntime,
  client: {
    purchase: async () => ({ status: 'cancelled', purchase: { status: 'cancelled', entitlementIds: [] } }),
    claimRewardedAd: async () => ({ status: 'skipped', reward: { status: 'skipped', rewardGranted: false } }),
  },
});
const owner = coordinator.createPurchaseController();
assert.equal((await owner.execute({ productId: 'fixture', source: 'shop', idempotencyKey: 'fixture' })).status, 'cancelled');
assert.equal(actionRuntime.getSnapshot().blocks.length, 0);
coordinator.dispose();
console.log('Actions compiled ESM imports and executes without DOM, Phaser or loading game-services runtime');
