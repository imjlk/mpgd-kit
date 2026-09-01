import assert from 'node:assert/strict';

import { StarterMiniGameBridgeLifecycle } from './minigameBridgeLifecycle';

const bridge = {};
const scope = { __MPGD_MINIGAME_RUNTIME__: bridge };
const restorationFailure = new Error('global restoration failed');
let disposalCalls = 0;
const lifecycle = new StarterMiniGameBridgeLifecycle(() => {
  disposalCalls += 1;
  throw restorationFailure;
});

assert.throws(
  () => lifecycle.dispose(scope, bridge),
  (error) => error === restorationFailure,
);
assert.equal(scope.__MPGD_MINIGAME_RUNTIME__, undefined);
assert.doesNotThrow(() => lifecycle.dispose(scope, bridge));
assert.equal(disposalCalls, 1);

const activeBridge = {};
const replacementScope = { __MPGD_MINIGAME_RUNTIME__: activeBridge };
const staleLifecycle = new StarterMiniGameBridgeLifecycle(() => undefined);
assert.doesNotThrow(() => staleLifecycle.dispose(replacementScope, bridge));
assert.equal(replacementScope.__MPGD_MINIGAME_RUNTIME__, activeBridge);

console.log('Mini-game bridge lifecycle tests passed.');
