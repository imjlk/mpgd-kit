import assert from 'node:assert/strict';

import { installAitBridge, shareIntent, type AitShareDependencies } from './aitBridge';
import type { BridgeResponse } from './bridgeTypes';

const sharePayload = {
  text: 'Try today\'s challenge.',
  deepLink: 'intoss://mpgd-kit/daily',
  previewImageUrl: 'https://game.example/daily.png',
};
const abortError = { name: 'AbortError' };

const cancelledWhileCreatingLink = await shareIntent(sharePayload, {
  appName: 'mpgd-kit',
  async getTossShareLink() {
    throw abortError;
  },
  async share() {
    throw new Error('share should not run after link cancellation');
  },
});
assert.deepEqual(cancelledWhileCreatingLink, { status: 'cancelled' });

const cancelledWhileSharing = await shareIntent(sharePayload, {
  appName: 'mpgd-kit',
  async getTossShareLink() {
    return 'https://toss.im/_ul/daily';
  },
  async share() {
    throw abortError;
  },
});
assert.deepEqual(cancelledWhileSharing, { status: 'cancelled' });

let warningCount = 0;
const originalConsoleWarn = console.warn;

try {
  console.warn = () => {
    warningCount += 1;
  };
  const unavailable = await shareIntent(
    sharePayload,
    {
      appName: 'mpgd-kit',
      async getTossShareLink() {
        throw new Error('bridge unavailable');
      },
      async share() {},
    } satisfies AitShareDependencies,
  );

  assert.deepEqual(unavailable, { status: 'unavailable' });
} finally {
  console.warn = originalConsoleWarn;
}

assert.equal(warningCount, 1, 'ordinary share errors should retain warning behavior');

const generatedPaths: string[] = [];
const sharedFromHttps = await shareIntent(
  {
    ...sharePayload,
    deepLink: 'https://game.example/daily?challengeToken=signed-token#result',
  },
  {
    appName: 'mpgd-kit',
    async getTossShareLink(path) {
      generatedPaths.push(path);
      return 'https://toss.im/_ul/daily';
    },
    async share() {},
  },
);

assert.deepEqual(sharedFromHttps, { status: 'shared' });
assert.deepEqual(generatedPaths, [
  'intoss://mpgd-kit/daily?challengeToken=signed-token#result',
]);

const invalidDeepLink = await shareIntent(
  {
    ...sharePayload,
    deepLink: 'javascript:alert(1)',
  },
  {
    appName: 'mpgd-kit',
    async getTossShareLink() {
      throw new Error('invalid deep links must not reach the Toss link provider');
    },
    async share() {},
  },
);

assert.deepEqual(invalidDeepLink, { status: 'unavailable' });

const protocolRelativeDeepLink = await shareIntent(
  {
    ...sharePayload,
    deepLink: '//other.example/daily',
  },
  {
    appName: 'mpgd-kit',
    async getTossShareLink() {
      throw new Error('protocol-relative links must not reach the Toss link provider');
    },
    async share() {},
  },
);

assert.deepEqual(protocolRelativeDeepLink, { status: 'unavailable' });

const bridgeHost = globalThis as {
  __GAME_PLATFORM_BRIDGE__?: {
    request(input: unknown): Promise<BridgeResponse>;
  };
};
try {
  installAitBridge();
  const installedBridge = bridgeHost.__GAME_PLATFORM_BRIDGE__;

  if (installedBridge === undefined) {
    throw new Error('Expected the Apps in Toss bridge to be installed.');
  }

  const savedValue = {
    progress: { coins: 7 },
    inventory: ['seed'],
  };
  await installedBridge.request({
    id: 'storage-save-1',
    method: 'storage.save',
    payload: { key: 'mutation-isolation:v1', value: savedValue },
    meta: {
      target: 'ait',
      appVersion: '1.0.0',
      buildId: 'ait-bridge-test',
      sentAt: '2026-07-16T00:00:00.000Z',
    },
  });
  savedValue.progress.coins = -1;
  savedValue.inventory.push('mutated-after-save');

  const firstLoad = await installedBridge.request({
    id: 'storage-load-1',
    method: 'storage.load',
    payload: { key: 'mutation-isolation:v1' },
    meta: {
      target: 'ait',
      appVersion: '1.0.0',
      buildId: 'ait-bridge-test',
      sentAt: '2026-07-16T00:00:01.000Z',
    },
  });
  assert(firstLoad.ok, 'Expected the Apps in Toss storage load to succeed.');

  const firstLoadedValue = firstLoad.data as {
    readonly __mpgdBridgeProtocol: 'mpgd.storage.load.v1';
    readonly found: true;
    readonly value: {
      progress: { coins: number };
      inventory: string[];
    };
  };
  assert.deepEqual(firstLoadedValue, {
    __mpgdBridgeProtocol: 'mpgd.storage.load.v1',
    found: true,
    value: {
      progress: { coins: 7 },
      inventory: ['seed'],
    },
  });
  firstLoadedValue.value.progress.coins = -2;
  firstLoadedValue.value.inventory.push('mutated-after-load');

  const secondLoad = await installedBridge.request({
    id: 'storage-load-2',
    method: 'storage.load',
    payload: { key: 'mutation-isolation:v1' },
    meta: {
      target: 'ait',
      appVersion: '1.0.0',
      buildId: 'ait-bridge-test',
      sentAt: '2026-07-16T00:00:02.000Z',
    },
  });
  assert(secondLoad.ok, 'Expected the Apps in Toss storage load to succeed.');
  assert.deepEqual(secondLoad.data, {
    __mpgdBridgeProtocol: 'mpgd.storage.load.v1',
    found: true,
    value: {
      progress: { coins: 7 },
      inventory: ['seed'],
    },
  });
} finally {
  Reflect.deleteProperty(bridgeHost, '__GAME_PLATFORM_BRIDGE__');
}

console.log('Apps in Toss bridge tests passed.');
