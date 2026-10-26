import assert from 'node:assert/strict';

import {
  createUnavailableCrashReporter,
  installCrashErrorCapture,
  normalizeCrashError,
  redactCrashText,
} from '@mpgd/platform/crash-reporting';

assert.equal(redactCrashText('https://example.com/a?token=1'), 'https://example.com/a?<redacted>');
assert.equal(normalizeCrashError(new TypeError('x')).name, 'TypeError');
const reporter = createUnavailableCrashReporter();
assert.deepEqual(await reporter.getStatus(), { provider: 'none', state: 'unsupported' });
const listeners = [];
const dispose = installCrashErrorCapture({
  reporter,
  target: {
    addEventListener(type, listener) { listeners.push([type, listener]); },
    removeEventListener(type, listener) {
      listeners.splice(listeners.findIndex((entry) => entry[0] === type && entry[1] === listener), 1);
    },
  },
});
assert.equal(listeners.length, 2);
dispose();
assert.equal(listeners.length, 0);
