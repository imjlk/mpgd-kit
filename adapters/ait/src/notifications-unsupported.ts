import type { NotificationCapabilities } from '@mpgd/platform/notifications';

/**
 * `createUnsupportedNotificationCapabilities`, without loading
 * `@mpgd/platform/notifications`; a test keeps the two equal.
 */
export function unsupportedNotificationCapabilities(): NotificationCapabilities {
  return {
    availability: 'unsupported',
    permission: {
      scope: 'app',
      prompt: 'os',
      readable: true,
      serverReadable: false,
      allowance: 'persistent',
      userGesture: false,
      settings: false,
    },
    remote: { supported: false, purposes: [], addressing: 'none', content: 'free-form' },
    local: { supported: false },
    open: 'none',
  };
}
