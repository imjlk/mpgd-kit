import assert from 'node:assert/strict';

import { resolveAitGameIdentity } from './aitIdentity';

const player = await resolveAitGameIdentity(async () => ({
  type: 'HASH',
  hash: 'ait-game-user-hash',
}));

assert.deepEqual(player, {
  ok: true,
  player: {
    playerId: 'ait-game-user-hash',
  },
});

const trimmedPlayer = await resolveAitGameIdentity(async () => ({
  type: 'HASH',
  hash: '  ait-game-user-hash  ',
}));
assert.deepEqual(trimmedPlayer, {
  ok: true,
  player: {
    playerId: 'ait-game-user-hash',
  },
});

const unsupported = await resolveAitGameIdentity(async () => undefined);
assert.deepEqual(unsupported, {
  ok: false,
  error: {
    code: 'AIT_GAME_IDENTITY_UNSUPPORTED',
    message: 'Apps in Toss game identity requires Toss app 5.232.0 or newer.',
    retryable: false,
  },
});

const invalidCategory = await resolveAitGameIdentity(async () => 'INVALID_CATEGORY');
assert.equal(invalidCategory.ok, false);
assert.equal(
  invalidCategory.ok ? undefined : invalidCategory.error.code,
  'AIT_GAME_IDENTITY_INVALID_CATEGORY',
);

const sdkFailure = await resolveAitGameIdentity(async () => 'ERROR');
assert.equal(sdkFailure.ok, false);
assert.equal(sdkFailure.ok ? undefined : sdkFailure.error.retryable, true);

for (const invalidResult of [
  null,
  {},
  { type: 'HASH' },
  { type: 'HASH', hash: '' },
  { type: 'HASH', hash: '   ' },
  { type: 'OTHER', hash: 'ait-game-user-hash' },
]) {
  const invalid = await resolveAitGameIdentity(async () => invalidResult);
  assert.equal(invalid.ok, false);
  assert.equal(
    invalid.ok ? undefined : invalid.error.code,
    'AIT_GAME_IDENTITY_INVALID_RESPONSE',
  );
}

const thrown = await resolveAitGameIdentity(async () => {
  throw new Error('bridge unavailable');
});
assert.deepEqual(thrown, {
  ok: false,
  error: {
    code: 'AIT_GAME_IDENTITY_REQUEST_FAILED',
    message: 'Apps in Toss game identity request failed: bridge unavailable',
    retryable: true,
  },
});

console.log('Apps in Toss game identity tests passed.');
