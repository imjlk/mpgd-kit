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

import type { NotificationRemoteDeliveryProvider } from './delivery-provider.js';
import { createNotificationProviderRegistry } from './registry.js';
import { createNotificationService, type NotificationSession } from './service.js';
import { createInMemoryNotificationStore } from './store.js';

/**
 * Runs the RFC's conformance vectors against the production notifications
 * service over the in-memory store, through the runner's `createBackend`.
 * The adapter only translates: sessions and the fake provider's answer queue
 * live here, and every rule is the service's.
 */

/**
 * The vectors live in the checkout, not next to the compiled test: the
 * prepared CI lane runs this entry from its emit root, so the directory is
 * resolved from the source root the runner names, the working directory
 * (the package scripts run from the repository root), or the source tree,
 * as the commerce reconciler's conformance test does.
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

/**
 * Vectors this backend does not run yet, each with the reason. Server
 * reminders and scheduled notice pushes are S2's scheduler; per-send
 * providers need an atomic acceptance reservation the registry refuses to
 * serve without.
 */
const skipped: Readonly<Record<string, string>> = {
  'advertising-notice-variants': 'S2: the scheduler pushes notices',
  'advertising-notices': 'S2: the scheduler pushes notices',
  'per-send-allowance': 'per-send providers are refused by the registry',
  'provider-ambiguous-replay': 'S2: server reminders',
  'reminder-cancel-across-routes': 'S2: server reminders',
  'reminder-server-route': 'S2: server reminders',
};

function createServiceBackend(input: CreateNotificationConformanceBackendInput): NotificationConformanceBackend {
  const { entry, clock } = input;
  const store = createInMemoryNotificationStore();
  const answers: NotificationConformanceProviderResult[] = [];
  const providerCalls: NotificationConformanceProviderCall[] = [];
  const deliveries: NotificationConformanceDelivery[] = [];
  const identities = new Set<string>();
  const listeners = new Set<(session: NotificationConformanceSession) => void>();
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
    registry: createNotificationProviderRegistry(entry === undefined || delivery === undefined
      ? []
      : [{ entry, delivery, targets: ['vector'] }]),
    catalog: {
      defaultLocale: input.defaultLocale,
      ...(input.notices === undefined ? {} : { notices: input.notices }),
      topicsFor: () => input.catalog,
    },
    ...(input.deployment === undefined ? {} : { deployment: input.deployment }),
    resolvePlatformRecipient: ({ player }) => (identities.has(player) ? player : undefined),
    now: () => clock.now(),
    // Deterministic backoff, as the fake backend's.
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
    reminders: [],
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
    session: () => current,
    onAuthenticated(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    authenticate(player) {
      sessions += 1;
      const started = { id: `session-${sessions}`, player, installationId: 'installation-1' };
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
    async recordConsent(consent) {
      await service.recordConsent(sessionOf(requireSession('recordConsent')), consent);
    },
    async listConsent() {
      return service.listConsent(sessionOf(requireSession('listConsent')));
    },
    async registerEndpoint(registration) {
      await service.registerEndpoint(sessionOf(requireSession('registerEndpoint')), { registration });
    },
    async unregisterEndpoint({ provider, player }) {
      if (current === undefined) {
        // The end of the session already unbound what it registered.
        return;
      }
      await service.unregisterEndpoint(sessionOf(current, player), { provider });
    },
    async setReminder() {
      throw new NotificationError('NOTIFICATIONS_TEMPORARILY_UNAVAILABLE', {
        message: 'Server reminders are S2.',
      });
    },
    async cancelReminder() {
      return false;
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
      answers.push(result);
    },
    async runScheduler() {
      const before = new Map(store.inspect().sends.map((send) => [send.key, JSON.stringify(send.rows)]));
      const { results, failed } = await service.dispatchDue({ limit: 1000 });
      assert.equal(failed, 0, 'every due send replays');
      for (const { sendKey, outcome } of results) {
        const send = store.inspect().sends.find((candidate) => candidate.key === sendKey);
        const request = send?.request;
        if (request !== undefined || before.has(sendKey)) {
          const previous = [...deliveries].reverse().find((delivered) => delivered.idempotencyKey === sendKey);
          // As the fake backend: a replay records the send's result when it changed.
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
    createBackend: createServiceBackend,
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
  `notifications service conformance: ${ran} vectors passed, ${Object.keys(skipped).length} left to S2 or refused`,
);
