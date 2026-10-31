import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { StorageAdapter } from '@mpgd/platform';
import { NotificationError, type NotificationCapabilities } from '@mpgd/platform/notifications';
import { createNotificationConformanceHost } from '@mpgd/platform/notifications-conformance';
import type { TargetConfiguredGateway } from '@mpgd/target-config';

import {
  createGuestServerSession,
  createGuestSessionCoordinator,
  type GuestSessionBackend,
} from '@mpgd/game-services';

import {
  createStarterHostedNotificationBackend,
  createStarterWorkerNotificationBackend,
  resolveStarterHostedNotificationBackend,
  setStarterHostedNotificationBackend,
  type StarterWorkerNotificationInput,
  type StarterWorkerSession,
} from '../templates/notifications-overlay/common/src/platform/notificationBackend.js';
import {
  createStarterServerSessionSlot,
  resolveStarterDevelopmentServerSession,
} from '../templates/phaser-game/src/platform/developmentServerSession.js';

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
  // The shipped composition resolves a hosted /api before the public-HTTPS check,
  // including credentialed requests, but does not infer an origin for native apps.
  {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'location');
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: { origin: 'https://game.example.com' },
    });
    try {
      const requests: string[] = [];
      const backend = createStarterWorkerNotificationBackend(
        gateway('play-web', 'browser'),
        input({
          baseUrl: '/api',
          mode: 'production',
          fetch: async (url, init) => {
            requests.push(url);
            if (url.endsWith('/providers')) {
              return {
                status: 200,
                text: async () =>
                  JSON.stringify({ protocolVersion: '2.0.0-draft.1', providers: [], targets: {} }),
              };
            }
            assert.equal(init.headers['authorization'], 'Bearer token');
            return { status: 200, text: async () => JSON.stringify({ records: [] }) };
          },
        }),
      );
      assert.ok(backend);
      assert.deepEqual(await backend.listConsent(), []);
      await settle();
      assert.ok(requests.length >= 2);
      assert.ok(
        requests.every((url) =>
          url.startsWith('https://game.example.com/api/game-services/notifications/'),
        ),
      );
      assert.equal(
        createStarterWorkerNotificationBackend(
          gateway('android'),
          input({ baseUrl: '/api', mode: 'production' }),
        ),
        undefined,
      );
      // An http page origin resolves to an http URL, which production refuses before any request.
      Object.defineProperty(globalThis, 'location', {
        configurable: true,
        value: { origin: 'http://game.example.com' },
      });
      const httpRequests: string[] = [];
      assert.equal(
        createStarterWorkerNotificationBackend(
          gateway('play-web', 'browser'),
          input({
            baseUrl: '/api',
            mode: 'production',
            fetch: async (url) => {
              httpRequests.push(url);
              return { status: 500, text: async () => '' };
            },
          }),
        ),
        undefined,
      );
      await settle();
      assert.deepEqual(httpRequests, []);
    } finally {
      if (previous === undefined) {
        Reflect.deleteProperty(globalThis, 'location');
      } else {
        Object.defineProperty(globalThis, 'location', previous);
      }
    }
  }
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

  // Reddit: the runtime over the backend the Devvit server hosts, set by the gateway builder.
  {
    const listed: string[] = [];
    const hosted = {
      session: () => undefined,
      onAuthenticated: () => () => undefined,
      recordConsent: async () => undefined,
      listConsent: async () => {
        listed.push('listConsent');
        return [];
      },
      registerEndpoint: async () => undefined,
      unregisterEndpoint: async () => undefined,
      setReminder: async () => 'scheduled' as const,
      cancelReminder: async () => false,
      listNotices: async () => [],
      recordNotice: async () => undefined,
    };
    assert.equal(resolveStarterHostedNotificationBackend('reddit'), undefined);
    let created = 0;
    setStarterHostedNotificationBackend('reddit', () => {
      created += 1;
      return hosted;
    });
    // Created on first use, once, and only for the config target that set it.
    assert.equal(created, 0);
    assert.equal(resolveStarterHostedNotificationBackend('android'), undefined);
    assert.equal(resolveStarterHostedNotificationBackend('reddit'), hosted);
    assert.equal(resolveStarterHostedNotificationBackend('reddit'), hosted);
    assert.equal(created, 1);
    const hostedInput = { backend: hosted, topics: [], defaultLocale: 'ko', log: () => undefined };
    const backend = createStarterHostedNotificationBackend(gateway('reddit'), hostedInput);
    assert.ok(backend !== undefined);
    assert.deepEqual(await backend.listConsent(), []);
    assert.deepEqual(listed, ['listConsent']);
    // No backend set, or no provider exposed (a gated beta Reddit has not approved): no runtime.
    assert.equal(
      createStarterHostedNotificationBackend(gateway('reddit'), {
        ...hostedInput,
        backend: undefined,
      }),
      undefined,
    );
    assert.equal(
      createStarterHostedNotificationBackend(
        { ...gateway('reddit'), notificationsV2: undefined } as unknown as TargetConfiguredGateway,
        hostedInput,
      ),
      undefined,
    );
    // A factory that throws turns notifications off once, without throwing into the game.
    let throws = 0;
    setStarterHostedNotificationBackend('reddit', () => {
      throws += 1;
      throw new Error('bad options');
    });
    assert.equal(resolveStarterHostedNotificationBackend('reddit'), undefined);
    assert.equal(resolveStarterHostedNotificationBackend('reddit'), undefined);
    assert.equal(throws, 1);
    // A new factory starts afresh.
    setStarterHostedNotificationBackend('reddit', () => hosted);
    assert.equal(resolveStarterHostedNotificationBackend('reddit'), hosted);
    setStarterHostedNotificationBackend('reddit', undefined);
    assert.equal(resolveStarterHostedNotificationBackend('reddit'), undefined);
    await settle();
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
    // The only entry listed would not match, so a fallback to it would fail the read below.
    const { fetch, requests } = worker(() => ({
      protocolVersion: '2.0.0-draft.1',
      providers: [{ ...fcmEntry, addressing: 'platform-user' }],
      targets: {},
    }));
    const backend = createStarterWorkerNotificationBackend(gateway('ios'), input({ fetch }));
    assert.ok(backend !== undefined);
    await settle();
    assert.equal(requests.length, 1);
    await settle();
    await backend.runtime.getPermission({ topics: ['daily-ready'] });
  }

  // An entry the game cannot read is left out: the others still load, and the
  // target whose entry was left out reports it and runs without the comparison.
  {
    const reported: unknown[] = [];
    console.error = (...args: unknown[]) => reported.push(args);
    const { fetch } = worker(() => ({
      protocolVersion: '2.0.0-draft.1',
      providers: [
        { ...fcmEntry, provider: 'ait-functional', purposes: 'service' },
        { ...fcmEntry, addressing: 'platform-user' },
      ],
      targets: { android: 'fcm', ait: 'ait-functional' },
    }));
    const android = createStarterWorkerNotificationBackend(gateway('android'), input({ fetch }));
    const ait = createStarterWorkerNotificationBackend(gateway('ait'), input({ fetch }));
    assert.ok(android !== undefined && ait !== undefined);
    await settle();
    await settle();
    // Android's readable entry disagrees with its provider: the check ran.
    await assert.rejects(
      android.runtime.getPermission({ topics: ['daily-ready'] }),
      (error: unknown) => error instanceof NotificationError && error.code === 'NOTIFICATIONS_CONFIGURATION_REQUIRED',
    );
    // AIT's entry was left out: reported once, and the runtime runs unchecked.
    await ait.runtime.getPermission({ topics: ['daily-ready'] });
    // (This fake Worker answers every route with the registry, so the consent read fails too.)
    const leftOut = reported.filter((entry) =>
      /names provider/u.test(String((entry as unknown[])[1])),
    );
    assert.equal(leftOut.length, 1);
    assert.match(String((leftOut[0] as unknown[])[1]), /names provider ait-functional for ait/u);
    console.error = () => undefined;
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
  // The session slot behind serverSession.ts: the game's own session wins, and
  // a change after a reader kept the old session warns.
  {
    type Session = { readonly name: string };
    const slotWith = (development: Session | undefined) => {
      const warnings: string[] = [];
      let developmentReads = 0;
      const slot = createStarterServerSessionSlot<Session>({
        development: () => {
          developmentReads += 1;
          return development;
        },
        warn: (message) => warnings.push(message),
      });
      return { slot, warnings, reads: () => developmentReads };
    };
    const dev = { name: 'dev' };
    const own = { name: 'own' };
    // Without a development session: nothing until the game sets one.
    {
      const { slot, warnings, reads } = slotWith(undefined);
      assert.equal(slot.resolve(), undefined);
      assert.equal(slot.resolve(), undefined);
      assert.equal(reads(), 1);
      slot.set(own);
      assert.equal(slot.resolve({ once: true }), own);
      slot.set(own);
      assert.deepEqual(warnings, []);
      // A change after the commerce client read the session warns.
      slot.set({ name: 'other' });
      assert.equal(warnings.length, 1);
      assert.match(warnings[0] ?? '', /after the commerce client was created/u);
    }
    // A development session is handed out until the game sets its own, even `undefined`.
    {
      const { slot, warnings } = slotWith(dev);
      assert.equal(slot.resolve(), dev);
      slot.set(own);
      assert.equal(slot.resolve(), own);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0] ?? '', /after the development session/u);
      slot.set(undefined);
      assert.equal(
        slot.resolve(),
        undefined,
        'a cleared session never falls back to the development one',
      );
      assert.equal(warnings.length, 1, 'only the first call after the hand-out warns');
    }
    // Clearing the session after the development one was handed out warns too: its readers keep it.
    {
      const { slot, warnings } = slotWith(dev);
      assert.equal(slot.resolve(), dev);
      slot.set(undefined);
      assert.equal(slot.resolve(), undefined);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0] ?? '', /after the development session/u);
    }
    // The commerce client (the `once` reader) never gets the development session: it keeps the
    // game's own session, or none, while notifications get the development one.
    {
      const { slot, warnings } = slotWith(dev);
      assert.equal(slot.resolve({ once: true }), undefined);
      assert.equal(slot.resolve(), dev);
      assert.equal(slot.resolve({ once: true }), undefined);
      // The game's session, once set, is everyone's; both readers kept something else, so both warn.
      slot.set(own);
      assert.equal(slot.resolve({ once: true }), own);
      assert.equal(slot.resolve(), own);
      assert.equal(warnings.length, 2);
      assert.match(warnings[0] ?? '', /after the development session/u);
      assert.match(warnings[1] ?? '', /after the commerce client was created/u);
    }
    // A game that sets its session first never sees the development one, or a warning.
    {
      const { slot, warnings, reads } = slotWith(dev);
      slot.set(undefined);
      assert.equal(slot.resolve({ once: true }), undefined);
      slot.set(own);
      assert.equal(reads(), 0);
      assert.match(warnings[0] ?? '', /after the commerce client was created/u);
    }
  }

  // serverSession.ts reads the development session only on the dev server, with the build's mode.
  {
    const source = readFileSync(
      fileURLToPath(
        new URL('../templates/phaser-game/src/platform/serverSession.ts', import.meta.url),
      ),
      'utf8',
    );
    assert.match(source, /import\.meta\.env\.DEV\s*\?\s*resolveStarterDevelopmentServerSession\(/u);
    assert.match(source, /mode: import\.meta\.env\.MODE,/u);
    assert.match(source, /value: import\.meta\.env\.VITE_MPGD_DEV_NOTIFICATION_SESSION,/u);
    // The commerce client reads as the `once` reader, which never gets the development session.
    const commerce = readFileSync(
      fileURLToPath(
        new URL('../templates/phaser-game/src/platform/gameServices.ts', import.meta.url),
      ),
      'utf8',
    );
    assert.match(commerce, /resolveStarterServerSession\(\{ once: true \}\)/u);
  }

  // The guest-session adapter is the starter's server session as it stands.
  {
    const guestBackend: GuestSessionBackend = {
      issueGuest: async () => {
        throw new Error('not called');
      },
      refresh: async () => {
        throw new Error('not called');
      },
      revoke: async () => undefined,
      bindAccount: async () => ({ status: 'conflict' }),
    };
    const guest: StarterWorkerSession = createGuestServerSession(
      createGuestSessionCoordinator({
        backend: guestBackend,
        credentials: {
          load: async () => null,
          save: async () => undefined,
          remove: async () => undefined,
        },
        installationId: 'install-1',
      }),
    );
    assert.equal(guest.current(), undefined);
  }

  // The development session: only on the dev server, outside production, with a valid value.
  {
    const originalWarn = console.warn;
    const warned: unknown[] = [];
    console.warn = (...args: unknown[]) => warned.push(args);
    const errors: unknown[] = [];
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      const resolve = (dev: boolean, mode: string, value: string | undefined) =>
        resolveStarterDevelopmentServerSession({ dev, mode, value });
      assert.equal(resolve(false, 'development', 'player-1'), undefined);
      assert.equal(resolve(true, 'development', undefined), undefined);
      assert.equal(resolve(true, 'development', '  '), undefined);
      assert.equal(warned.length + errors.length, 0);
      // Any mode but development is off; an id the Worker would refuse is ignored with a reason.
      assert.equal(resolve(true, 'production', 'player-1'), undefined);
      assert.equal(errors.length, 0);
      assert.equal(resolve(true, 'development', 'player 1'), undefined);
      assert.equal(resolve(true, 'development', 'player-1.device-1.extra'), undefined);
      assert.equal(errors.length, 2);
      assert.equal(warned.length, 0);
      const defaulted = resolve(true, 'development', 'player-1');
      assert.deepEqual(defaulted?.current(), {
        playerId: 'player-1',
        sessionId: 'dev-dev-installation',
      });
      // Only the development mode: a staging build run with NODE_ENV=development has `dev` set too.
      assert.equal(resolve(true, 'staging', 'player-1'), undefined);
      const named = resolve(true, 'development', ' player-2.device-2 ');
      assert.ok(named !== undefined);
      assert.deepEqual(named.current(), { playerId: 'player-2', sessionId: 'dev-device-2' });
      assert.deepEqual(await named.getHeaders(), {
        authorization: 'Bearer mpgd-dev.player-2.dev-device-2.device-2',
      });
      assert.equal(warned.length, 2);

      // The starter's Worker backend sends its header on the session routes.
      const authorizations: (string | undefined)[] = [];
      const backend = createStarterWorkerNotificationBackend(
        gateway('android'),
        input({
          baseUrl: 'http://localhost:8787',
          session: named,
          fetch: async (url, init) => {
            authorizations.push(init.headers['authorization']);
            return url.endsWith('/providers')
              ? {
                  status: 200,
                  text: async () =>
                    JSON.stringify({
                      protocolVersion: '2.0.0-draft.1',
                      providers: [fcmEntry],
                      targets: { android: 'fcm' },
                    }),
                }
              : { status: 200, text: async () => JSON.stringify({ records: [] }) };
          },
        }),
      );
      assert.ok(backend !== undefined);
      assert.deepEqual(await backend.listConsent(), []);
      assert.ok(authorizations.includes('Bearer mpgd-dev.player-2.dev-device-2.device-2'));
    } finally {
      console.warn = originalWarn;
      console.error = () => undefined;
    }
  }
} finally {
  console.error = originalError;
}

console.info('Starter Worker and hosted notifications backend checks passed.');
