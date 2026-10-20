import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  listNotificationNotices,
  NotificationError,
  type NotificationDeliveryOutcome,
} from '@mpgd/platform/notifications';
import {
  notificationConformanceLeaseSeconds,
  runNotificationConformanceVector,
  type CreateNotificationConformanceBackendInput,
  type NotificationConformanceBackend,
  type NotificationConformanceDelivery,
  type NotificationConformanceProviderCall,
  type NotificationConformanceProviderResult,
  type NotificationConformanceSession,
} from '@mpgd/platform/notifications-conformance';
import {
  assertNotificationConformanceVector,
  type NotificationConformanceVector,
} from '@mpgd/platform/notifications-vectors';

import {
  createGameServicesNotificationsClient,
  gameServicesNotificationsRoutePrefix,
  type GameServicesNotificationSession,
  type GameServicesNotificationsFetch,
} from './client.js';
import type { NotificationRemoteDeliveryProvider } from './delivery-provider.js';
import { createNotificationProviderRegistry } from './registry.js';
import {
  createNotificationService,
  NotificationConsentRateLimitError,
  type NotificationService,
  type NotificationSession,
} from './service.js';
import { createInMemoryNotificationStore } from './store.js';

/**
 * Runs the RFC's conformance vectors with the production runtime calling the
 * production service through the game-services notifications client over
 * HTTP: every runtime backend call is a `fetch` of a Worker route, answered
 * by an in-process copy of the Worker's session routes (authentication from
 * the `Authorization` header, the route table, and the status mapping of
 * `apps/game-services-worker/src/notificationsHandler.ts`) over the service
 * and the in-memory store. The game-services Worker's own tests run the
 * runtime through this client against the real handler.
 */

function resolveVectorsDir(): string {
  const relative = join('docs', 'specs', 'notifications', 'vectors');
  const candidates = [
    process.env.MPGD_TOOLS_EMIT_SOURCE_ROOT,
    process.cwd(),
    join(import.meta.dirname, '..', '..', '..', '..'),
  ];
  for (const root of candidates) {
    if (root !== undefined && root.length > 0 && existsSync(join(root, relative))) {
      return join(root, relative);
    }
  }
  throw new Error(`Cannot locate ${relative} from ${candidates.join(', ')}.`);
}

const vectorsDir = resolveVectorsDir();
const vectors: NotificationConformanceVector[] = readdirSync(vectorsDir)
  .filter((file) => file.endsWith('.json'))
  .sort()
  .map((file) => assertNotificationConformanceVector(
    JSON.parse(readFileSync(join(vectorsDir, file), 'utf8')) as unknown,
  ));

/** As for the service: per-send providers are refused by the registry. */
const skipped: Readonly<Record<string, string>> = {
  'per-send-allowance': 'per-send providers are refused by the registry',
};

/**
 * The Worker's session routes in process: the session comes from the
 * `Authorization` header alone, and every answer and error status is the
 * Worker's.
 */
function createWorkerRoutes(
  service: NotificationService,
  sessions: ReadonlyMap<string, NotificationSession>,
): GameServicesNotificationsFetch {
  const json = (body: unknown, status: number, headers: Record<string, string> = {}) => ({
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    text: async () => JSON.stringify(body),
  });
  return async (url, init) => {
    const route = new URL(url).pathname.slice(gameServicesNotificationsRoutePrefix.length);
    if (route === '/providers') {
      return json({ protocolVersion: '2.0.0-draft.1', ...service.providers() }, 200);
    }
    const authorization = init.headers['authorization'];
    const session = authorization === undefined ? undefined : sessions.get(authorization);
    if (session === undefined) {
      return json({ error: 'UNAUTHORIZED' }, 401);
    }
    const body = init.body === undefined
      ? {}
      : JSON.parse(init.body) as Readonly<Record<string, unknown>>;
    try {
      switch (`${init.method} ${route}`) {
        case 'GET /consent':
          return json({ records: await service.listConsent(session) }, 200);
        case 'POST /consent':
          return json({ record: await service.recordConsent(session, body['record']) }, 200);
        case 'POST /endpoints':
          await service.registerEndpoint(session, {
            registration: body['registration'],
            ...(body['target'] === undefined ? {} : { target: body['target'] as string }),
          });
          return json({}, 200);
        case 'POST /endpoints/unregister':
          await service.unregisterEndpoint(
            session,
            body['provider'] === undefined ? {} : { provider: body['provider'] as string },
          );
          return json({}, 200);
        case 'GET /notices':
          return json({ notices: await service.listNotices(session) }, 200);
        case 'POST /notices/shown':
          await service.recordNoticeShown(
            session,
            body['notice'],
            body['channel'] === undefined ? {} : { channel: body['channel'] as 'in-game' },
          );
          return json({}, 200);
        case 'POST /reminders':
          return json(await service.setReminder(session, body['reminder']), 200);
        case 'POST /reminders/cancel':
          return json(await service.cancelReminder(session, { key: body['key'] }), 200);
        default:
          return json({ error: 'UNKNOWN_ENDPOINT' }, 404);
      }
    } catch (error) {
      if (error instanceof NotificationError) {
        const throttled = error instanceof NotificationConsentRateLimitError;
        const status = throttled
          ? 429
          : error.code === 'NOTIFICATIONS_INVALID_INPUT'
            ? 400
            : error.code === 'NOTIFICATIONS_IDEMPOTENCY_CONFLICT'
              ? 409
              : error.code === 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE'
                ? 503
                : 500;
        return json(
          { error: error.code, ...(status < 500 ? { message: error.message } : {}) },
          status,
          error.retryable ? { 'retry-after': String(throttled ? error.retryAfterSeconds : 5) } : {},
        );
      }
      return json({ error: 'INTERNAL_ERROR' }, 500);
    }
  };
}

function createClientBackend(input: CreateNotificationConformanceBackendInput): NotificationConformanceBackend {
  const { entry, clock } = input;
  const store = createInMemoryNotificationStore();
  const answers: NotificationConformanceProviderResult[] = [];
  const providerCalls: NotificationConformanceProviderCall[] = [];
  const deliveries: NotificationConformanceDelivery[] = [];
  const identities = new Set<string>();
  const sessionListeners = new Set<(session: GameServicesNotificationSession) => void>();
  /** Bearer tokens the in-process Worker accepts, each for one session. */
  const tokens = new Map<string, NotificationSession>();
  let current: NotificationConformanceSession | undefined;
  let sessions = 0;
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
            ...(request.recipient.kind === 'device' ? { address: request.recipient.address.value } : {}),
            ...(request.topic.mapping === undefined ? {} : { mapping: request.topic.mapping }),
            ...(request.link === undefined ? {} : { link: request.link }),
            content: request.content,
            ...(request.expiresAt === undefined ? {} : { expiresAt: request.expiresAt }),
            ...(request.templateData === undefined ? {} : { templateData: request.templateData }),
            ...(request.data === undefined ? {} : { data: request.data }),
            at: request.at,
          });
          return answers.shift() ?? { status: 'accepted' };
        },
        ...(input.readServerPermission === undefined
          ? {}
          : {
              readPermission: async (read: { readonly player: string; readonly topic: string }) =>
                input.readServerPermission?.(read) ?? 'unknown',
            }),
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
    resolvePlatformRecipient: ({ player }) => (identities.has(player) ? player : undefined),
    now: () => clock.now(),
    random: () => 0,
    claimLeaseSeconds: notificationConformanceLeaseSeconds,
  });
  const client = createGameServicesNotificationsClient({
    baseUrl: 'https://game-services.test',
    fetch: createWorkerRoutes(service, tokens),
    identity: {
      current: () => (current === undefined
        ? undefined
        : { playerId: current.player, sessionId: current.id }),
      onAuthenticated(listener) {
        sessionListeners.add(listener);
        return () => {
          sessionListeners.delete(listener);
        };
      },
    },
    getHeaders: () => (current === undefined ? {} : { authorization: `Bearer ${current.id}` }),
  });
  const record = (outcome: NotificationDeliveryOutcome, key: string, topic: string, player: string): void => {
    deliveries.push({ ...outcome, idempotencyKey: key, topic, player, at: clock.now() });
  };
  const rules = input.deployment?.advertisingRules ?? 'none';

  return {
    entry,
    get consent() {
      return store.inspect().consent;
    },
    get endpoints() {
      return store.inspect().endpoints.map((endpoint) => ({
        provider: endpoint.provider,
        kind: endpoint.address.kind,
        value: endpoint.address.value,
        ...(endpoint.address.environment === undefined ? {} : { environment: endpoint.address.environment }),
        installationId: endpoint.installationId,
        permission: endpoint.permission,
        player: endpoint.player,
        status: endpoint.status,
        ...(endpoint.locale === undefined ? {} : { locale: endpoint.locale }),
        ...(endpoint.timeZone === undefined ? {} : { timeZone: endpoint.timeZone }),
        lastRegisteredAt: endpoint.lastRegisteredAt,
        session: endpoint.sessionId,
      }));
    },
    get deliveries() {
      return deliveries;
    },
    get providerCalls() {
      return providerCalls;
    },
    get reminders() {
      return store.inspect().schedule.flatMap((scheduled) =>
        scheduled.item.kind === 'reminder' && scheduled.item.firedAt === undefined
          ? [{
              player: scheduled.player,
              key: scheduled.item.key,
              topic: scheduled.item.topic,
              fireAt: scheduled.item.fireAt,
              ...(scheduled.item.templateData === undefined ? {} : { templateData: scheduled.item.templateData }),
              ...(scheduled.item.link === undefined ? {} : { link: scheduled.item.link }),
            }]
          : []);
    },
    get notices() {
      const state = store.inspect();
      if (rules !== 'kr') {
        return [];
      }
      return [...new Set(state.consent.map((row) => row.player))]
        .flatMap((player) => listNotificationNotices(
          state.consent.filter((row) => row.player === player).map(({ player: _player, ...row }) => row),
          state.noticesGiven.filter((given) => given.player === player),
          clock.now(),
        ).map((notice) => ({ ...notice, player })))
        .sort((left, right) => left.dueBy.localeCompare(right.dueBy) || left.kind.localeCompare(right.kind));
    },
    get noticesGiven() {
      return store.inspect().noticesGiven;
    },
    // The runtime's backend is the HTTP client; the fixture session adds the installation.
    session: () => (client.session() === undefined ? undefined : current),
    onAuthenticated(listener) {
      return client.onAuthenticated(() => {
        if (current !== undefined) {
          listener(current);
        }
      });
    },
    recordConsent: (consent) => client.recordConsent(consent),
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
    authenticate(player) {
      sessions += 1;
      const started = { id: `session-${sessions}`, player, installationId: 'installation-1' };
      current = started;
      identities.add(player);
      tokens.set(`Bearer ${started.id}`, {
        player,
        sessionId: started.id,
        installationId: started.installationId,
      });
      for (const listener of [...sessionListeners]) {
        listener({ playerId: player, sessionId: started.id });
      }
      return started;
    },
    async revokeSession() {
      if (current === undefined) {
        throw new Error('revokeSession needs an authenticated player.');
      }
      const ended = current;
      current = undefined;
      // The token stops authenticating, as the identity Worker's session does.
      tokens.delete(`Bearer ${ended.id}`);
      await service.endSession({ sessionId: ended.id });
    },
    async registerInstallation(installation) {
      if (entry === undefined) {
        throw new Error('backend.registerEndpoint needs a provider with remote delivery.');
      }
      await service.registerEndpoint(
        {
          player: input.defaultPlayer,
          sessionId: `fixture:${installation.installationId}`,
          installationId: installation.installationId,
        },
        {
          registration: {
            provider: entry.provider,
            address: { kind: installation.kind, value: installation.value, permission: installation.permission },
          },
        },
      );
    },
    async deliver(request) {
      const player = request.player ?? input.defaultPlayer;
      const outcome = await service.deliver({ ...request, player });
      record(outcome, request.idempotencyKey, request.topic, player);
      return outcome;
    },
    queueProviderResult(result) {
      answers.push(result);
    },
    async runScheduler() {
      const before = new Map(store.inspect().sends.map((send) => [send.key, JSON.stringify(send.rows)]));
      const { results, failed } = await service.runScheduler({ limit: 1000 });
      assert.equal(failed, 0, 'every due item runs');
      for (const { sendKey, outcome } of results) {
        const send = store.inspect().sends.find((candidate) => candidate.key === sendKey);
        const request = send?.request;
        if (request !== undefined || before.has(sendKey)) {
          const previous = [...deliveries].reverse().find((delivered) => delivered.idempotencyKey === sendKey);
          if (previous === undefined || JSON.stringify(stripMeta(previous)) !== JSON.stringify(outcome)) {
            record(outcome, sendKey, request?.topic ?? previous?.topic ?? '', request?.player ?? previous?.player ?? '');
          }
        }
      }
    },
  };
}

function stripMeta(delivery: NotificationConformanceDelivery): NotificationDeliveryOutcome {
  const { idempotencyKey: _key, topic: _topic, player: _player, at: _at, ...outcome } = delivery;
  return outcome as NotificationDeliveryOutcome;
}

let ran = 0;
for (const vector of vectors) {
  if (skipped[vector.vector] !== undefined) {
    continue;
  }
  const result = await runNotificationConformanceVector(vector, {
    createBackend: createClientBackend,
  });
  assert.ok(
    result.status === 'passed',
    `${vector.vector}: ${JSON.stringify(result.failures, null, 2)}`,
  );
  ran += 1;
}
for (const name of Object.keys(skipped)) {
  assert.ok(
    vectors.some((vector) => vector.vector === name),
    `skip list names a vector that exists: ${name}`,
  );
}
assert.equal(ran, vectors.length - Object.keys(skipped).length);
console.info(
  `notifications client conformance: ${ran} vectors passed through the HTTP client, `
    + `${Object.keys(skipped).length} refused by the registry`,
);
