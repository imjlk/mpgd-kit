import assert from 'node:assert/strict';

import { shareIntent, type AitShareDependencies } from './aitBridge';

const sharePayload = {
  text: 'Try today\'s challenge.',
  deepLink: 'intoss://mpgd-kit/daily',
  previewImageUrl: 'https://game.example/daily.png',
};
const abortError = { name: 'AbortError' };

const cancelledWhileCreatingLink = await shareIntent(sharePayload, {
  async getTossShareLink() {
    throw abortError;
  },
  async share() {
    throw new Error('share should not run after link cancellation');
  },
});
assert.deepEqual(cancelledWhileCreatingLink, { status: 'cancelled' });

const cancelledWhileSharing = await shareIntent(sharePayload, {
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

console.log('Apps in Toss bridge tests passed.');
