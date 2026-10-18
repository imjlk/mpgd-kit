import { describe, expect, it } from 'vitest';

import { createUnsupportedNotificationCapabilities } from '@mpgd/platform/notifications';

import { unsupportedNotificationCapabilities } from './notifications-unsupported.js';

describe('unsupportedNotificationCapabilities', () => {
  it('equals the platform block, which the gateway must not load', () => {
    expect(unsupportedNotificationCapabilities()).toEqual(
      createUnsupportedNotificationCapabilities(),
    );
    expect(unsupportedNotificationCapabilities()).not.toBe(unsupportedNotificationCapabilities());
  });
});
