import assert from 'node:assert/strict';
import { assertLatestDevvitSdk } from './devvit-sdk-check.js';
const entries = ['devvit', '@devvit/web', '@devvit/start'].map((name) => ({
  name,
  declared: '0.15.0',
  installed: '0.15.0',
  latest: '0.15.0',
}));
assert.doesNotThrow(() => assertLatestDevvitSdk(entries));
assert.throws(() => assertLatestDevvitSdk([]), /both/);
for (const changed of [
  { declared: '^0.15.0' },
  { installed: '0.14.1' },
  { latest: '0.16.0' },
  { latest: '0.16.0-next.1' },
  { declared: 'latest' },
]) {
  assert.throws(() =>
    assertLatestDevvitSdk(
      entries.map((entry, index) => index === 1 ? { ...entry, ...changed } : entry),
    ),
  );
}
assert.throws(
  () => assertLatestDevvitSdk(entries.filter((entry) => entry.name !== 'devvit')),
  /both/,
);
console.info('Devvit latest SDK gate tests passed.');

assert.doesNotThrow(() =>
  assertLatestDevvitSdk([
    ...entries,
    {
      name: '@devvit/web',
      declared: '0.14.1',
      installed: '0.15.0',
      latest: '0.15.0',
      source: 'adapter',
    },
  ]),
);
assert.throws(() =>
  assertLatestDevvitSdk([
    ...entries,
    {
      name: '@devvit/web',
      declared: '0.14.1',
      installed: '0.14.1',
      latest: '0.15.0',
      source: 'adapter',
    },
  ]),
);
