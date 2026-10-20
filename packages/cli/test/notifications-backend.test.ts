import assert from 'node:assert/strict';

import type { StorageAdapter } from '@mpgd/platform';
import { NotificationError, type NotificationCapabilities } from '@mpgd/platform/notifications';
import { createNotificationConformanceHost } from '@mpgd/platform/notifications-conformance';
import type { TargetConfiguredGateway } from '@mpgd/target-config';

import {
  createStarterWorkerNotificationBackend,
  type StarterWorkerNotificationInput,
} from '../templates/notifications-overlay/common/src/platform/notificationBackend.js';

/**
 * The starter's Worker notifications backend: which targets get one, and
 * that the runtime compares its provider with the Worker's registry entry
 * for this target, loaded from `GET /providers`.
 */

const capabilities: NotificationCapabilities = {
  availability: 'available',
  permission: {
    scope: 'app',
    prompt: 'os',
    readable: true,
    serverReadable: false,
    allowance: 'persistent',
    userGesture: false,
    settings: false,
  },
  remote: {
    supported: true,
    purposes: ['service', 'requested', 'advertising'],
    addressing: 'device',
    content: 'free-form',
  },
  local: { supported: false },
  open: 'payload',
};
const fcmEntry = {
  provider: 'fcm',
  purposes: ['service', 'requested', 'advertising'],
  addressing: 'device',
  content: 'free-form',
  permission: { scope: 'app', serverReadable: false, allowance: 'persistent' },
  expiry: true,
  actions: true,
  link: false,
  mappingFields: ['channelId'],
};

function gateway(configTarget: string, target: string = configTarget): TargetConfiguredGateway {
  const values = new Map<string, unknown>();
  const storage: StorageAdapter = {
    async load({ key }) {
      return values.has(key) ? { value: values.get(key) } : null;
    },
    async save({ key, value }) {
      values.set(key, value);
    },
  };
  const host = createNotificationConformanceHost({
    profile: { provider: 'fcm', capabilities },
    catalog: [],
  });
  return {
    target,
    configTarget,
    notificationsV2: host.provider,
    storage,
  } as unknown as TargetConfiguredGateway;
}

const session = {
  current: () => ({ playerId: 'p-1', sessionId: 's-1' }),
  onAuthenticated: () => () => undefined,
  getHeaders: () => ({ authorization: 'Bearer token' }),
};

/** A Worker answering `GET /providers` with `body`, counting every request. */
function worker(providers: (() => unknown) | undefined) {
  const requests: string[] = [];
  return {
    requests,
    fetch: async (url: string) => {
      requests.push(url);
      if (providers === undefined) {
        throw new TypeError('Failed to fetch');
      }
      return { status: 200, text: async () => JSON.stringify(providers()) };
    },
  };
}

function input(overrides: Partial<StarterWorkerNotificationInput> & { readonly logged?: unknown[] } = {}): StarterWorkerNotificationInput {
  const logged = overrides.logged ?? [];
  return {
    baseUrl: 'https://services.example',
    mode: 'development',
    session,
    topics: [],
    defaultLocale: 'ko',
    log: (message) => logged.push(message),
    ...overrides,
  };
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const originalError = console.error;
console.error = () => undefined;
try {
  // Reddit's backend is its Devvit server: no Worker runtime, even with a URL and a session.
  {
    const { fetch, requests } = worker(() => ({
      protocolVersion: '2.0.0-draft.1',
      providers: [],
      targets: {},
    }));
    assert.equal(
      createStarterWorkerNotificationBackend(gateway('reddit'), input({ fetch })),
      undefined,
    );
    // Another Devvit config target of the same game.
    assert.equal(
      createStarterWorkerNotificationBackend(gateway('reddit-staging', 'reddit'), input({ fetch })),
      undefined,
    );
    assert.deepEqual(requests, []);
  }

  // Without a session: no backend, and a message saying why.
  {
    const logged: unknown[] = [];
    assert.equal(
      createStarterWorkerNotificationBackend(
        gateway('android'),
        input({ session: undefined, logged }),
      ),
      undefined,
    );
    assert.equal(logged.length, 1);
    assert.match(String(logged[0]), /setStarterServerSession/u);
  }

  // Without a URL, or a production URL the commerce rule refuses: no backend.
  {
    assert.equal(
      createStarterWorkerNotificationBackend(gateway('android'), input({ baseUrl: undefined })),
      undefined,
    );
    const logged: unknown[] = [];
    assert.equal(
      createStarterWorkerNotificationBackend(
        gateway('android'),
        input({ baseUrl: 'https://10.0.0.5', mode: 'production', logged }),
      ),
      undefined,
    );
    assert.match(String(logged[0]), /public https URL/u);
  }

  // Android: the runtime loads the Worker's entry for its target and compares the provider with it.
  {
    const { fetch, requests } = worker(() => ({
      protocolVersion: '2.0.0-draft.1',
      providers: [{ ...fcmEntry, addressing: 'platform-user' }],
      targets: { android: 'fcm', ios: 'fcm' },
    }));
    const backend = createStarterWorkerNotificationBackend(gateway('android'), input({ fetch }));
    assert.ok(backend !== undefined);
    await settle();
    assert.deepEqual(requests, ['https://services.example/game-services/notifications/providers']);
    await assert.rejects(
      backend.runtime.getPermission({ topics: ['daily-ready'] }),
      (error: unknown) => error instanceof NotificationError && error.code === 'NOTIFICATIONS_CONFIGURATION_REQUIRED',
    );
  }
  {
    const { fetch } = worker(() => ({
      protocolVersion: '2.0.0-draft.1',
      providers: [fcmEntry],
      targets: { android: 'fcm', ios: 'fcm' },
    }));
    const backend = createStarterWorkerNotificationBackend(gateway('android'), input({ fetch }));
    assert.ok(backend !== undefined);
    await settle();
    await backend.runtime.getPermission({ topics: ['daily-ready'] });
  }

  // The entry is the one the target names, not the first one listed.
  {
    const { fetch } = worker(() => ({
      protocolVersion: '2.0.0-draft.1',
      providers: [
        fcmEntry,
        { ...fcmEntry, provider: 'ait-functional', addressing: 'platform-user' },
      ],
      targets: { android: 'fcm', ait: 'ait-functional' },
    }));
    const android = createStarterWorkerNotificationBackend(gateway('android'), input({ fetch }));
    const ait = createStarterWorkerNotificationBackend(gateway('ait'), input({ fetch }));
    assert.ok(android !== undefined && ait !== undefined);
    await settle();
    await android.runtime.getPermission({ topics: ['daily-ready'] });
    await assert.rejects(
      ait.runtime.getPermission({ topics: ['daily-ready'] }),
      (error: unknown) => error instanceof NotificationError && error.code === 'NOTIFICATIONS_CONFIGURATION_REQUIRED',
    );
  }

  // A target the Worker does not serve: no entry, and the runtime runs without the check.
  {
    const { fetch } = worker(() => ({
      protocolVersion: '2.0.0-draft.1',
      providers: [fcmEntry],
      targets: {},
    }));
    const backend = createStarterWorkerNotificationBackend(gateway('ios'), input({ fetch }));
    assert.ok(backend !== undefined);
    await settle();
    await backend.runtime.getPermission({ topics: ['daily-ready'] });
  }

  // A Worker it cannot reach: the runtime runs without the comparison, and the failure is logged.
  {
    const reported: unknown[] = [];
    console.error = (...args: unknown[]) => reported.push(args);
    const { fetch, requests } = worker(undefined);
    const backend = createStarterWorkerNotificationBackend(gateway('ios'), input({ fetch }));
    assert.ok(backend !== undefined);
    await settle();
    assert.equal(requests.length, 1);
    assert.equal(reported.length, 1);
    await backend.runtime.getPermission({ topics: ['daily-ready'] });
    console.error = () => undefined;
  }
} finally {
  console.error = originalError;
}

console.info('Starter Worker notifications backend checks passed.');
