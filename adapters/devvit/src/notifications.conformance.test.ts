import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { BridgeRequest, BridgeResponse } from '@mpgd/bridge';
import {
  createNotificationProviderRegistry,
  createNotificationService,
  type NotificationRemoteDeliveryProvider,
  type NotificationSession,
} from '@mpgd/game-services/notifications';
import type {
  NotificationDeliveryOutcome,
  NotificationProvider,
} from '@mpgd/platform/notifications';
import {
  notificationConformanceLeaseSeconds,
  NotificationConformanceScriptError,
  notificationConformanceSkipReason,
  runNotificationConformanceVectors,
  type CreateNotificationConformanceBackendInput,
  type NotificationConformanceBackend,
  type NotificationConformanceContext,
  type NotificationConformanceDelivery,
  type NotificationConformanceHarness,
  type NotificationConformanceProviderCall,
  type NotificationConformanceSession,
} from '@mpgd/platform/notifications-conformance';
import {
  assertNotificationConformanceVector,
  type NotificationConformanceVector,
} from '@mpgd/platform/notifications-vectors';

import { createFakeNotificationRedis } from '../test/fake-notification-redis.js';
import {
  createFakeDevvitNotifications,
  type FakeDevvitNotifications,
} from '../test/fake-devvit-notifications.js';
import { createDevvitPlatformGateway } from './index.js';
import { createDevvitNotificationsBackendClient } from './notifications-backend-client.js';
import { createDevvitBridgeNotificationProvider } from './notifications-client.js';
import {
  createDevvitNotificationCapabilities,
  devvitUserIdPattern,
} from './notifications-contract.js';
import { createDevvitNotificationsBackendBridgeHandler } from './server/notifications-backend-bridge.js';
import { createDevvitNotificationsV2BridgeHandler } from './server/notifications-bridge.js';
import { createDevvitNotificationDeliveryProvider } from './server/notifications-delivery.js';
import { createDevvitRedisNotificationStore } from './server/redis-notification-store.js';

/**
 * The Devvit provider against the RFC's conformance vectors: the webview
 * provider over the server bridge handler, which opts the request's user in
 * and out on a fake Devvit plugin, directly and through the gateway; once
 * with the runner's fake backend and once with the notifications service
 * the Devvit server runs (`@mpgd/game-services/notifications` over the Redis
 * store, with the Devvit delivery provider over the same fake plugin);
 * and once more with the runtime reaching that service through the webview
 * backend client and the server's backend bridge handler (DV1), where the
 * player is the request's Reddit user.
 */

/** The vectors live in the checkout; resolve them as the game-services conformance test does. */
function resolveVectorsDir(): string {
  const relative = join('docs', 'specs', 'notifications', 'vectors');
  const candidates = [
    process.env.MPGD_TOOLS_EMIT_SOURCE_ROOT,
    process.cwd(),
    join(process.cwd(), '..', '..'),
    join(import.meta.dirname, '..', '..', '..'),
  ];
  for (const root of candidates) {
    if (root !== undefined && root.length > 0 && existsSync(join(root, relative))) {
      return join(root, relative);
    }
  }
  throw new Error(`Cannot locate ${relative} from ${candidates.join(', ')}.`);
}

const vectorsDir = resolveVectorsDir();
const vectors: readonly NotificationConformanceVector[] = readdirSync(vectorsDir)
  .filter((file) => file.endsWith('.json'))
  .sort()
  .map((file) => assertNotificationConformanceVector(
    JSON.parse(readFileSync(join(vectorsDir, file), 'utf8')) as unknown,
  ));

/** The vectors the Devvit profile satisfies; every other vector is skipped by its `appliesTo`. */
const devvitVectors = [
  'action-required-login',
  'game-rendered-opt-in-again',
  'game-rendered-opt-in',
  'game-rendered-opt-out',
  'host-link-required',
  'provider-daily-limit',
  'quiet-hours-player-zone',
];

/** A vector's player as a Reddit user id (`p-1` is `t2_p1`). */
function userOf(player: string): `t2_${string}` {
  return `t2_${player.replace(/[^A-Za-z0-9]/gu, '')}`;
}

type Transport = 'bridge' | 'gateway';

/** The Devvit server, its plugin, and the webview provider over it, for one vector. */
function createDevvitHarness(
  context: NotificationConformanceContext,
  transport: Transport,
  plugins: Map<NotificationConformanceVector, FakeDevvitNotifications>,
): NotificationConformanceHarness {
  const user = userOf(context.player);
  const plugin = createFakeDevvitNotifications(
    context.vector.host?.actionRequired === true ? {} : { currentUserId: user },
  );
  plugins.set(context.vector, plugin);
  const queued: string[] = [];
  plugin.beforeOptIn = () => {
    if (queued.shift() === undefined) {
      throw new NotificationConformanceScriptError(
        'Unscripted opt-in: queue a host.queuePrompt result first.',
      );
    }
  };
  const topics = context.catalog.filter((topic) => topic.mapping !== undefined).map(
    (topic) => topic.id,
  );
  const handler = createDevvitNotificationsV2BridgeHandler({
    notifications: plugin,
    currentUserId: () => plugin.currentUserId,
    topics,
  });
  const serve = async (request: BridgeRequest): Promise<BridgeResponse> => handler.request(request);
  const build = (): NotificationProvider => {
    if (transport === 'bridge') {
      return createDevvitBridgeNotificationProvider({
        timeZone: () => context.timeZone,
        async request(method, payload) {
          const response = await serve({
            id: 'r',
            method,
            payload,
            meta: { target: 'reddit', appVersion: '1', buildId: 'test', sentAt: '2026-10-19T00:00:00Z' },
          });
          if (!response.ok) {
            throw Object.assign(new Error(response.error.message), response.error);
          }
          return response.data;
        },
      });
    }
    const gateway = createDevvitPlatformGateway({
      appVersion: '1.0.0',
      buildId: 'test',
      bridge: { request: serve },
      notifications: {
        topics,
        timeZone: () => context.timeZone,
        load: () => import('./notifications-client.js'),
      },
    });
    if (gateway.notificationsV2 === undefined) {
      throw new Error('The Devvit gateway did not expose notificationsV2.');
    }
    return gateway.notificationsV2;
  };
  let provider = build();
  const unscriptable = (what: string): never => {
    throw new NotificationConformanceScriptError(`The Devvit host cannot script ${what}.`);
  };
  return {
    provider: {
      get provider() {
        return provider.provider;
      },
      getCapabilities: () => provider.getCapabilities(),
      getPermission: (request) => provider.getPermission(request),
      requestPermission: (request) => provider.requestPermission(request),
      revokePermission: (request) => provider.revokePermission?.(request) ?? unscriptable('a revocation'),
      register: () => provider.register?.() ?? Promise.resolve(null),
      subscribe: (listener) => provider.subscribe(listener),
    },
    host: {
      get prompts() {
        return plugin.optInCalls;
      },
      localOperations: [],
      localPending: [],
      queuePrompt(result) {
        if (result !== 'granted' && result !== 'already-granted') {
          unscriptable(`a ${result} prompt: the game's own toggle decides before it asks to opt in`);
        }
        queued.push(result);
      },
      setPermission(state) {
        // An opt-in or opt-out made elsewhere, such as in Reddit settings.
        if (state === 'granted') {
          plugin.optedIn.add(user);
        } else {
          plugin.optedIn.delete(user);
        }
      },
      issueEndpoint: () => unscriptable('a device endpoint: recipients are Reddit users'),
      completeAction() {
        plugin.currentUserId = user;
      },
      tap: () => unscriptable('an open: a notification opens its post, which the game routes'),
      restart() {
        provider = build();
      },
      readServerPermission: ({ player }) =>
        (plugin.optedIn.has(userOf(player)) ? 'granted' : 'prompt'),
    },
  };
}

/**
 * The notifications service the Devvit server runs, over the Redis store
 * and the Devvit delivery provider, as the vector's backend. Only the
 * translation lives here, as in the game-services conformance test.
 */
function createDevvitServiceBackend(
  input: CreateNotificationConformanceBackendInput,
  plugin: FakeDevvitNotifications,
): NotificationConformanceBackend {
  const { entry, clock } = input;
  const store = createDevvitRedisNotificationStore(createFakeNotificationRedis());
  const providerCalls: NotificationConformanceProviderCall[] = [];
  const deliveries: NotificationConformanceDelivery[] = [];
  const identities = new Set<string>();
  const listeners = new Set<(session: NotificationConformanceSession) => void>();
  let current: NotificationConformanceSession | undefined;
  let sessions = 0;
  const devvit = createDevvitNotificationDeliveryProvider({
    notifications: plugin,
    userIdOf: (player) => userOf(player),
  });
  const delivery: NotificationRemoteDeliveryProvider | undefined = entry === undefined
    ? undefined
    : {
        id: entry.provider,
        async send(request) {
          providerCalls.push({
            idempotencyKey: request.idempotencyKey,
            sendKey: request.sendKey,
            provider: request.provider,
            topic: request.topic.id,
            player: request.player,
            ...(request.topic.mapping === undefined ? {} : { mapping: request.topic.mapping }),
            ...(request.link === undefined ? {} : { link: request.link }),
            content: request.content,
            ...(request.templateData === undefined ? {} : { templateData: request.templateData }),
            ...(request.data === undefined ? {} : { data: request.data }),
            at: request.at,
          });
          return devvit.send(request);
        },
        readPermission: (read) =>
          (devvit.readPermission as NonNullable<typeof devvit.readPermission>)(read),
      };
  const service = createNotificationService({
    store,
    registry: createNotificationProviderRegistry(
      entry === undefined || delivery === undefined
        ? []
        : [{ entry, delivery, targets: ['vector'] }],
    ),
    catalog: {
      defaultLocale: input.defaultLocale,
      ...(input.notices === undefined ? {} : { notices: input.notices }),
      topicsFor: () => input.catalog,
    },
    ...(input.deployment === undefined ? {} : { deployment: input.deployment }),
    resolvePlatformRecipient: ({ player }) => (identities.has(player) ? userOf(player) : undefined),
    now: () => clock.now(),
    random: () => 0,
    claimLeaseSeconds: notificationConformanceLeaseSeconds,
  });
  const sessionOf = (session: NotificationConformanceSession, player = session.player): NotificationSession => ({
    player,
    sessionId: session.id,
    installationId: session.installationId,
  });
  const requireSession = (operation: string): NotificationConformanceSession => {
    if (current === undefined) {
      throw new Error(`${operation} needs an authenticated player.`);
    }
    return current;
  };
  const record = (outcome: NotificationDeliveryOutcome, key: string, topic: string, player: string): void => {
    deliveries.push({ ...outcome, idempotencyKey: key, topic, player, at: clock.now() });
  };
  const consent: (Awaited<ReturnType<typeof service.listConsent>>[number] & { player: string })[] = [];

  return {
    entry,
    get consent() {
      return consent;
    },
    endpoints: [],
    get deliveries() {
      return deliveries;
    },
    get providerCalls() {
      return providerCalls;
    },
    reminders: [],
    notices: [],
    noticesGiven: [],
    session: () => current,
    onAuthenticated(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    authenticate(player) {
      sessions += 1;
      const started = { id: `session-${String(sessions)}`, player, installationId: 'installation-1' };
      current = started;
      identities.add(player);
      for (const listener of [...listeners]) {
        listener(started);
      }
      return started;
    },
    async revokeSession() {
      const ended = requireSession('revokeSession');
      current = undefined;
      await service.endSession({ sessionId: ended.id });
    },
    registerInstallation() {
      throw new NotificationConformanceScriptError('Devvit registers no device installation.');
    },
    async recordConsent(input) {
      const session = requireSession('recordConsent');
      const before = (await service.listConsent(sessionOf(session))).length;
      const stored = await service.recordConsent(sessionOf(session), input);
      if ((await service.listConsent(sessionOf(session))).length > before) {
        consent.push({ ...stored, player: session.player });
      }
    },
    async listConsent() {
      return service.listConsent(sessionOf(requireSession('listConsent')));
    },
    async registerEndpoint(registration) {
      await service.registerEndpoint(sessionOf(requireSession('registerEndpoint')), { registration });
    },
    async unregisterEndpoint({ provider, player }) {
      if (current !== undefined) {
        await service.unregisterEndpoint(sessionOf(current, player), { provider });
      }
    },
    async setReminder(reminder) {
      return (await service.setReminder(sessionOf(requireSession('setReminder')), reminder)).status;
    },
    async cancelReminder(request) {
      return (await service.cancelReminder(sessionOf(requireSession('cancelReminder')), request)).cancelled;
    },
    async listNotices() {
      return service.listNotices(sessionOf(requireSession('listNotices')));
    },
    async recordNotice({ channel, ...notice }) {
      if (channel === 'push') {
        throw new Error('Only the backend records a pushed notice.');
      }
      await service.recordNoticeShown(sessionOf(requireSession('recordNotice')), notice, { channel });
    },
    async deliver(request) {
      const player = request.player ?? input.defaultPlayer;
      const outcome = await service.deliver({ ...request, player });
      record(outcome, request.idempotencyKey, request.topic, player);
      return outcome;
    },
    queueProviderResult(result) {
      switch (result.status) {
        case 'accepted':
          plugin.enqueueAnswers.push({ successCount: 1, failureCount: 0, errors: [] });
          return;
        case 'rate-limited':
          plugin.enqueueAnswers.push({
            successCount: 0,
            failureCount: 1,
            errors: [{ userId: undefined, message: 'rate limit exceeded' }],
          });
          return;
        case 'ambiguous':
          plugin.enqueueAnswers.push(() => Promise.reject(new Error('deadline exceeded')));
          return;
        default:
          throw new NotificationConformanceScriptError(`Devvit cannot answer ${result.status}.`);
      }
    },
    async runScheduler() {
      // The Devvit dispatch task's own run, unbounded by time for the vector.
      const { results, failed } = await service.runScheduler({ limit: 1000 });
      expect(failed).toBe(0);
      for (const { sendKey, outcome } of results) {
        const previous = [...deliveries].reverse().find((delivered) => delivered.idempotencyKey === sendKey);
        const { idempotencyKey: _key, topic, player, at: _at, ...last } = previous ?? {
          idempotencyKey: sendKey,
          topic: '',
          player: '',
          at: '',
        };
        if (previous === undefined || JSON.stringify(last) !== JSON.stringify(outcome)) {
          record(outcome, sendKey, topic, player);
        }
      }
    },
  };
}

/**
 * The Devvit server's service as the backend, reached the way a Reddit game
 * reaches it: the runtime calls the webview backend client, which sends
 * `notifications.backend.*` requests to the server's backend bridge handler,
 * which acts for the request's user (`context.userId`, the fake plugin's
 * current user). A vector's player `p-1` is the Reddit user `t2_p1`; the
 * observations name the vector's player again.
 */
function createDevvitClientBackend(
  input: CreateNotificationConformanceBackendInput,
  plugin: FakeDevvitNotifications,
): NotificationConformanceBackend {
  const { entry, clock } = input;
  const store = createDevvitRedisNotificationStore(createFakeNotificationRedis());
  const providerCalls: NotificationConformanceProviderCall[] = [];
  const deliveries: NotificationConformanceDelivery[] = [];
  /** Reddit user id to the vector's player. */
  const players = new Map<string, string>();
  const playerOf = (userId: string): string => players.get(userId) ?? userId;
  const devvit = createDevvitNotificationDeliveryProvider({ notifications: plugin });
  const delivery: NotificationRemoteDeliveryProvider | undefined = entry === undefined
    ? undefined
    : {
        id: entry.provider,
        async send(request) {
          providerCalls.push({
            idempotencyKey: request.idempotencyKey,
            sendKey: request.sendKey,
            provider: request.provider,
            topic: request.topic.id,
            player: playerOf(request.player),
            ...(request.topic.mapping === undefined ? {} : { mapping: request.topic.mapping }),
            ...(request.link === undefined ? {} : { link: request.link }),
            content: request.content,
            ...(request.templateData === undefined ? {} : { templateData: request.templateData }),
            ...(request.data === undefined ? {} : { data: request.data }),
            at: request.at,
          });
          return devvit.send(request);
        },
        readPermission: (read) =>
          (devvit.readPermission as NonNullable<typeof devvit.readPermission>)(read),
      };
  const service = createNotificationService({
    store,
    registry: createNotificationProviderRegistry(
      entry === undefined || delivery === undefined
        ? []
        : [{ entry, delivery, targets: ['vector'] }],
    ),
    catalog: {
      defaultLocale: input.defaultLocale,
      ...(input.notices === undefined ? {} : { notices: input.notices }),
      topicsFor: () => input.catalog,
    },
    ...(input.deployment === undefined ? {} : { deployment: input.deployment }),
    resolvePlatformRecipient: ({ player }) => (devvitUserIdPattern.test(player) ? player : undefined),
    now: () => clock.now(),
    random: () => 0,
    claimLeaseSeconds: notificationConformanceLeaseSeconds,
  });
  const handler = createDevvitNotificationsBackendBridgeHandler({
    service,
    context: () => ({ userId: plugin.currentUserId }),
  });
  const client = createDevvitNotificationsBackendClient({
    async request(method, payload) {
      const response = await handler.request({
        id: 'b',
        method,
        payload,
        meta: { target: 'reddit', appVersion: '1', buildId: 'test', sentAt: '2026-10-24T00:00:00Z' },
      });
      if (!response.ok) {
        throw Object.assign(new Error(response.error.message), response.error);
      }
      return response.data;
    },
  });
  const conformanceSession = (
    session: { readonly id: string; readonly player: string } | undefined,
  ): NotificationConformanceSession | undefined =>
    session === undefined ? undefined : { ...session, installationId: session.id };
  const serverSession = (userId: string): NotificationSession =>
    ({ player: userId, sessionId: `devvit:${userId}`, installationId: `devvit:${userId}` });
  const record = (outcome: NotificationDeliveryOutcome, key: string, topic: string, player: string): void => {
    deliveries.push({ ...outcome, idempotencyKey: key, topic, player, at: clock.now() });
  };
  const consent: (Awaited<ReturnType<typeof service.listConsent>>[number] & { player: string })[] = [];

  return {
    entry,
    get consent() {
      return consent;
    },
    endpoints: [],
    get deliveries() {
      return deliveries;
    },
    get providerCalls() {
      return providerCalls;
    },
    reminders: [],
    notices: [],
    noticesGiven: [],
    session: () => conformanceSession(client.session()),
    onAuthenticated(listener) {
      return client.onAuthenticated((session) => {
        const started = conformanceSession(session);
        if (started !== undefined) {
          listener(started);
        }
      });
    },
    async authenticate(player) {
      const userId = userOf(player);
      players.set(userId, player);
      // Reddit's own login: the request user is now this player, and the client reads it from the server.
      plugin.currentUserId = userId;
      const session = conformanceSession(await client.refreshSession());
      if (session === undefined) {
        throw new Error('The Devvit server answered no session after login.');
      }
      return session;
    },
    async revokeSession() {
      plugin.currentUserId = undefined;
      await client.refreshSession();
    },
    registerInstallation() {
      throw new NotificationConformanceScriptError('Devvit registers no device installation.');
    },
    async recordConsent(input) {
      const userId = client.session()?.player;
      const before = userId === undefined ? 0 : (await service.listConsent(serverSession(userId))).length;
      await client.recordConsent(input);
      if (userId !== undefined) {
        const after = await service.listConsent(serverSession(userId));
        const stored = after.at(-1);
        if (after.length > before && stored !== undefined) {
          consent.push({ ...stored, player: playerOf(userId) });
        }
      }
    },
    listConsent: () => client.listConsent(),
    registerEndpoint: (registration) => client.registerEndpoint(registration),
    unregisterEndpoint: (unbind) => client.unregisterEndpoint(unbind),
    setReminder: (reminder) => client.setReminder(reminder),
    cancelReminder: (request) => client.cancelReminder(request),
    listNotices: () => client.listNotices(),
    async recordNotice({ channel, ...notice }) {
      if (channel !== 'in-game') {
        throw new Error('The game records only notices it showed in the game.');
      }
      await client.recordNotice({ ...notice, channel });
    },
    async deliver(request) {
      const player = request.player ?? input.defaultPlayer;
      const outcome = await service.deliver({ ...request, player: userOf(player) });
      record(outcome, request.idempotencyKey, request.topic, player);
      return outcome;
    },
    queueProviderResult(result) {
      switch (result.status) {
        case 'accepted':
          plugin.enqueueAnswers.push({ successCount: 1, failureCount: 0, errors: [] });
          return;
        case 'rate-limited':
          plugin.enqueueAnswers.push({
            successCount: 0,
            failureCount: 1,
            errors: [{ userId: undefined, message: 'rate limit exceeded' }],
          });
          return;
        case 'ambiguous':
          plugin.enqueueAnswers.push(() => Promise.reject(new Error('deadline exceeded')));
          return;
        default:
          throw new NotificationConformanceScriptError(`Devvit cannot answer ${result.status}.`);
      }
    },
    async runScheduler() {
      const { results, failed } = await service.runScheduler({ limit: 1000 });
      expect(failed).toBe(0);
      for (const { sendKey, outcome } of results) {
        const previous = [...deliveries].reverse().find((delivered) => delivered.idempotencyKey === sendKey);
        const { idempotencyKey: _key, topic, player, at: _at, ...last } = previous ?? {
          idempotencyKey: sendKey,
          topic: '',
          player: '',
          at: '',
        };
        if (previous === undefined || JSON.stringify(last) !== JSON.stringify(outcome)) {
          record(outcome, sendKey, topic, player);
        }
      }
    },
  };
}

describe('Devvit notifications provider conformance', () => {
  it('runs every vector whose appliesTo the Devvit profile satisfies', () => {
    const applicable = vectors
      .filter((vector) =>
        notificationConformanceSkipReason(vector, createDevvitNotificationCapabilities()) === undefined)
      .map((vector) => vector.vector);
    expect(applicable).toEqual(devvitVectors);
  });

  for (const transport of ['bridge', 'gateway'] as const) {
    it(`passes every vector its profile satisfies (${transport}, fake backend)`, async () => {
      const plugins = new Map<NotificationConformanceVector, FakeDevvitNotifications>();
      const results = await runNotificationConformanceVectors(vectors, {
        createProvider: (context) => createDevvitHarness(context, transport, plugins),
      });
      expect(results.filter((result) => result.status === 'failed')).toEqual([]);
      expect(results.filter((result) => result.status === 'passed').map((result) => result.vector))
        .toEqual(devvitVectors);
    });
  }

  it('passes them with the Devvit server service over the Redis store as the backend', async () => {
    const plugins = new Map<NotificationConformanceVector, FakeDevvitNotifications>();
    const results = await runNotificationConformanceVectors(vectors, {
      createProvider: (context) => createDevvitHarness(context, 'gateway', plugins),
      createBackend: (input, context) => {
        const plugin = plugins.get(context.vector);
        if (plugin === undefined) {
          throw new Error('The harness runs before the backend.');
        }
        return createDevvitServiceBackend(input, plugin);
      },
    });
    expect(results.filter((result) => result.status === 'failed')).toEqual([]);
    expect(results.filter((result) => result.status === 'passed').map((result) => result.vector))
      .toEqual(devvitVectors);
    // Every accepted send reached Devvit's enqueue with the filled text and its link.
    for (const plugin of plugins.values()) {
      for (const call of plugin.enqueueCalls) {
        expect(call.link).toMatch(/^t[13]_/u);
        expect(call.title).not.toContain('{{');
        expect(call.data).toEqual({});
      }
    }
  });
  it('passes them with the runtime reaching that service through the webview backend client (DV1)', async () => {
    const plugins = new Map<NotificationConformanceVector, FakeDevvitNotifications>();
    const results = await runNotificationConformanceVectors(vectors, {
      createProvider: (context) => createDevvitHarness(context, 'gateway', plugins),
      createBackend: (input, context) => {
        const plugin = plugins.get(context.vector);
        if (plugin === undefined) {
          throw new Error('The harness runs before the backend.');
        }
        return createDevvitClientBackend(input, plugin);
      },
    });
    expect(results.filter((result) => result.status === 'failed')).toEqual([]);
    expect(results.filter((result) => result.status === 'passed').map((result) => result.vector))
      .toEqual(devvitVectors);
  });
});
