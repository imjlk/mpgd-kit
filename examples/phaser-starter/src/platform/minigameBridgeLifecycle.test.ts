import assert from 'node:assert/strict';

import {
  requireStarterMiniGameRuntimeAssetOrigins,
  runStarterMiniGameBootstrapStep,
  StarterMiniGameBridgeLifecycle,
} from './minigameBridgeLifecycle';

const expectedOrigins = ['https://assets.example.test'];
const metadataScope = {};
Object.defineProperty(metadataScope, '__MPGD_MINIGAME_RUNTIME_ASSET_ORIGINS__', {
  configurable: false,
  enumerable: false,
  writable: false,
  value: Object.freeze([...expectedOrigins]),
});
assert.deepEqual(
  requireStarterMiniGameRuntimeAssetOrigins(metadataScope, expectedOrigins),
  expectedOrigins,
);
assert.throws(
  () => requireStarterMiniGameRuntimeAssetOrigins(metadataScope, []),
  /differs from target configuration/u,
);
assert.throws(
  () => requireStarterMiniGameRuntimeAssetOrigins(
    { __MPGD_MINIGAME_RUNTIME_ASSET_ORIGINS__: [...expectedOrigins] },
    expectedOrigins,
  ),
  /unavailable or mutable/u,
);

const constructionFailure = new Error('Phaser construction failed');
const constructionCleanupFailure = new Error('runtime cleanup failed');
let constructionCleanupCalls = 0;
const reportedConstructionCleanupErrors: unknown[] = [];
assert.throws(
  () => runStarterMiniGameBootstrapStep({
    run() {
      throw constructionFailure;
    },
    cleanup() {
      constructionCleanupCalls += 1;
      throw constructionCleanupFailure;
    },
    reportCleanupError(error) {
      reportedConstructionCleanupErrors.push(error);
    },
  }),
  (error) => error === constructionFailure,
);
assert.equal(constructionCleanupCalls, 1);
assert.deepEqual(reportedConstructionCleanupErrors, [constructionCleanupFailure]);

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
