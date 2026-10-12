import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createNotificationConformanceBackend,
  createNotificationConformanceClock,
  createNotificationConformanceHarness,
  createNotificationConformanceHost,
  createNotificationConformanceRuntime,
  notificationConformanceAgreementSchema,
  notificationConformanceRegistryEntry,
  notificationConformanceSkipReason,
  runNotificationConformanceVector,
  runNotificationConformanceVectors,
  type NotificationConformanceBackendClient,
  type NotificationConformanceHarness,
  type NotificationConformanceRuntimeStorage,
} from './notifications-conformance.js';
import {
  createUnsupportedNotificationCapabilities,
  type NotificationDeliveryProviderEntry,
  type NotificationDeployment,
  type NotificationEvent,
  type NotificationProvider,
  type NotificationTopicDeclaration,
} from './notifications.js';
import {
  assertNotificationConformanceVector,
  type NotificationConformanceHostFixture,
  type NotificationConformanceProfile,
  type NotificationConformanceVector,
} from './notifications-vectors.js';

const vectorsDir = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'docs',
  'specs',
  'notifications',
  'vectors',
);
const vectorFiles = readdirSync(vectorsDir).filter((file) => file.endsWith('.json')).sort();

function readVector(file: string): NotificationConformanceVector {
  return assertNotificationConformanceVector(
    JSON.parse(readFileSync(join(vectorsDir, file), 'utf8')) as unknown,
  );
}

const vectors = vectorFiles.map(readVector);

function vectorNamed(name: string): NotificationConformanceVector {
  const vector = vectors.find((candidate) => candidate.vector === name);
  if (vector === undefined) {
    throw new Error(`Missing vector ${name}.`);
  }
  return vector;
}

const osProfile = vectorNamed('os-permission-granted').profile;
const hostProfile = vectorNamed('host-agreement-recorded').profile;
const perSendProfile = vectorNamed('per-send-allowance').profile;
const optInProfile = vectorNamed('game-rendered-opt-in').profile;
const now = '2026-10-12T03:00:00Z';
const energy: NotificationTopicDeclaration = {
  id: 'energy-full',
  purpose: 'requested',
  channels: ['local', 'remote'],
  route: '/?entry=continue',
  copy: { ko: { title: '에너지 충전 완료', body: '에너지가 가득 찼어요.' } },
  mapping: { channelId: 'reminders' },
};
const challenge: NotificationTopicDeclaration = {
  id: 'rival-challenge',
  purpose: 'service',
  channels: ['remote'],
  route: '/?entry=challenge',
  copy: { ko: { title: '새 도전장', body: '도전장이 왔어요.' } },
  mapping: {
    channelId: 'social',
    templateSetCode: 'fixture-rival-challenge',
    agreement: 'required',
  },
};
/** A host-template service topic whose console template has no agreement statement. */
const receipt: NotificationTopicDeclaration = {
  id: 'purchase-result',
  purpose: 'service',
  channels: ['remote'],
  route: '/?entry=purchases',
  mapping: { templateSetCode: 'fixture-purchase-result', agreement: 'none' },
};
/** A topic for the game-rendered fixture, whose sends need a link. */
const duel: NotificationTopicDeclaration = {
  id: 'rival-challenge',
  purpose: 'service',
  channels: ['remote'],
  route: '/?entry=challenge',
  mapping: { title: 'Duel', body: 'A duel is waiting.', link: 't3_duel' },
};
const noticeTopic: NotificationTopicDeclaration = {
  id: 'consent-notice',
  purpose: 'service',
  channels: ['remote'],
  route: '/settings/notifications',
  copy: { ko: { title: '수신 동의 안내', body: '{{consentDate}}에 동의하셨어요.' } },
  mapping: { channelId: 'reminders' },
};
const weekend: NotificationTopicDeclaration = {
  id: 'weekend-event',
  purpose: 'advertising',
  channels: ['remote'],
  route: '/events/weekend',
  optOutRoute: '/settings/notifications',
  copy: { ko: { title: '주말 이벤트', body: '주말 이벤트가 시작됐어요.' } },
  mapping: { channelId: 'advertising' },
};
const kr: NotificationDeployment = {
  advertisingRules: 'kr',
  advertisingSender: { contact: '080-1234-5678' },
};

interface SetupOptions {
  readonly host?: NotificationConformanceHostFixture;
  readonly deployment?: NotificationDeployment;
  readonly entry?: (entry: NotificationDeliveryProviderEntry) => NotificationDeliveryProviderEntry;
}

/** A fake host, backend, and runtime wired the way the runner wires them. */
function setup(
  profile: NotificationConformanceProfile,
  catalog: readonly NotificationTopicDeclaration[] = [energy, challenge],
  options: SetupOptions = {},
) {
  const clock = createNotificationConformanceClock(now);
  const host = createNotificationConformanceHost({
    profile,
    catalog,
    timeZone: 'Asia/Seoul',
    ...(options.host === undefined ? {} : { host: options.host }),
  });
  const derived = notificationConformanceRegistryEntry({
    provider: profile.provider,
    capabilities: profile.capabilities,
    ...(profile.limits === undefined ? {} : { limits: profile.limits }),
  });
  const entry = derived === undefined || options.entry === undefined
    ? derived
    : options.entry(derived);
  const backend = createNotificationConformanceBackend({
    entry,
    catalog,
    clock,
    ...(options.deployment === undefined ? {} : { deployment: options.deployment }),
    defaultLocale: 'ko',
    defaultPlayer: 'p-1',
    readServerPermission: (input) => host.readServerPermission(input),
  });
  const storage: NotificationConformanceRuntimeStorage = {};
  const createRuntime = (
    provider: NotificationProvider = host.provider,
    client: NotificationConformanceBackendClient = backend,
  ) => createNotificationConformanceRuntime({
    provider,
    backend: client,
    catalog,
    clock,
    timeZone: 'Asia/Seoul',
    defaultLocale: 'ko',
    storage,
    ...(entry === undefined ? {} : { registryEntry: entry }),
  });
  return { clock, host, backend, runtime: createRuntime(), createRuntime, storage, entry };
}

/** A provider whose events the test emits itself. */
function relayed(provider: NotificationProvider): {
  readonly provider: NotificationProvider;
  readonly emit: (event: NotificationEvent) => void;
} {
  const listeners: ((event: NotificationEvent) => void)[] = [];
  return {
    provider: {
      ...provider,
      subscribe: (listener) => {
        listeners.push(listener);
        return () => {};
      },
    },
    emit: (event) => {
      for (const listener of listeners) {
        listener(event);
      }
    },
  };
}

const endpointRows = (backend: ReturnType<typeof setup>['backend']) =>
  backend.endpoints.map((endpoint) => [
    endpoint.installationId,
    endpoint.value,
    endpoint.permission,
    endpoint.player,
    endpoint.status,
  ]);

/** An authenticated OS player with a granted device endpoint. */
async function devicePlayer(
  catalog: readonly NotificationTopicDeclaration[] = [energy, challenge],
  options: SetupOptions = {},
) {
  const context = setup(osProfile, catalog, options);
  await context.runtime.start();
  context.backend.authenticate('p-1');
  context.host.issueEndpoint({ kind: 'fcm-token', value: 'tok-1' });
  context.host.queuePrompt('granted');
  await context.runtime.requestPermission({
    topics: [catalog[0]?.id ?? 'energy-full'],
    gesture: true,
  });
  return context;
}

describe('notifications conformance runner', () => {
  it('passes every RFC vector with the reference runtime and fakes', async () => {
    const results = await runNotificationConformanceVectors(vectors);
    expect(results).toHaveLength(39);
    expect(results.filter((result) => !result.passed).map((result) => ({
      vector: result.vector,
      status: result.status,
      reason: result.reason,
      failures: result.failures,
    }))).toEqual([]);
  });

  it.each(vectorFiles)('%s passes on its own', async (file) => {
    const result = await runNotificationConformanceVector(readVector(file));
    expect(result.failures).toEqual([]);
    expect(result.status).toBe('passed');
  });

  it('reports a deliberately altered expectation with a readable path', async () => {
    const vector = vectorNamed('os-permission-granted');
    const result = await runNotificationConformanceVector({
      ...vector,
      expect: {
        ...vector.expect,
        prompts: 2,
        endpoints: [{ provider: 'fixture.os-fcm', value: 'tok-2', player: 'p-1', status: 'valid' }],
      },
    });
    expect(result).toMatchObject({ status: 'failed', passed: false });
    expect(result.failures).toEqual([
      { path: 'prompts', expected: 2, actual: 1 },
      { path: 'endpoints[0].value', expected: 'tok-2', actual: 'tok-1' },
    ]);
  });

  it('asserts absence with null and compares timestamps as instants', async () => {
    const vector = vectorNamed('advertising-night-window');
    const calls = vector.expect.providerCalls ?? [];
    const altered = (providerCalls: typeof calls) =>
      runNotificationConformanceVector({ ...vector, expect: { ...vector.expect, providerCalls } });
    // The same instant written with an offset matches.
    expect((await altered([
      { ...calls[0], expiresAt: '2026-10-13T21:00:00+09:00' },
      ...calls.slice(1),
    ])).failures).toEqual([]);
    expect((await altered([
      { ...calls[0], expiresAt: null },
      { ...calls[1], expiresAt: '2026-10-14T12:00:00Z' },
    ])).failures).toEqual([
      { path: 'providerCalls[0].expiresAt', expected: 'absent', actual: '2026-10-13T12:00:00Z' },
      { path: 'providerCalls[1].expiresAt', expected: '2026-10-14T12:00:00Z', actual: undefined },
    ]);
  });

  it('fails a vector at the step that reaches an unscripted prompt', async () => {
    const vector = vectorNamed('os-permission-denied-twice');
    const result = await runNotificationConformanceVector({
      ...vector,
      steps: vector.steps.filter((step, index) => !(index === 5 && step.action === 'queuePrompt')),
    });
    expect(result.status).toBe('failed');
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.path).toBe('steps[5]');
    expect(String(result.failures[0]?.actual)).toMatch(/Unscripted prompt for energy-full/u);
  });

  it('fails a step whose expected error does not happen, or has another code', async () => {
    const unsupported = vectorNamed('unsupported-target');
    const returned = await runNotificationConformanceVector({
      ...unsupported,
      steps: unsupported.steps.map((step) =>
        step.actor === 'game' && step.action === 'requestPermission'
          ? { actor: 'game', action: 'requestPermission', input: step.input, throws: { code: 'NOTIFICATIONS_USER_GESTURE_REQUIRED' } }
          : step),
    });
    expect(returned.status).toBe('failed');
    expect(returned.failures).toEqual([
      { path: 'steps[2].throws', expected: { code: 'NOTIFICATIONS_USER_GESTURE_REQUIRED' }, actual: 'returned' },
    ]);
    const reuse = vectorNamed('idempotency-key-reuse');
    const otherCode = await runNotificationConformanceVector({
      ...reuse,
      steps: reuse.steps.map((step) =>
        step.actor === 'backend' && step.action === 'deliver' && step.throws?.code === 'NOTIFICATIONS_INVALID_INPUT'
          ? { ...step, throws: { code: 'NOTIFICATIONS_IDEMPOTENCY_CONFLICT' } }
          : step),
    });
    expect(otherCode.failures).toEqual([
      {
        path: 'steps[8].throws.code',
        expected: 'NOTIFICATIONS_IDEMPOTENCY_CONFLICT',
        actual: 'NOTIFICATIONS_INVALID_INPUT',
      },
    ]);
  });

  it('skips, with a reason, every vector a provider capability set does not satisfy', async () => {
    const results = await runNotificationConformanceVectors(vectors, {
      createProvider: (context) => {
        const host = createNotificationConformanceHost({
          profile: { ...context.profile, capabilities: createUnsupportedNotificationCapabilities() },
          catalog: context.catalog,
        });
        return { provider: host.provider, host };
      },
    });
    expect(results.filter((result) => result.status === 'passed').map((result) => result.vector))
      .toEqual(['unsupported-target']);
    const skipped = results.filter((result) => result.status === 'skipped');
    expect(skipped).toHaveLength(38);
    expect(skipped.every((result) => !result.passed && result.reason !== undefined)).toBe(true);
    const reasonOf = (name: string) => results.find((result) => result.vector === name)?.reason;
    // The unsupported block declares an app-scope OS prompt but no prompt limit.
    expect(reasonOf('os-permission-denied-twice'))
      .toBe('appliesTo permission.promptLimit names no declared capability');
    expect(reasonOf('action-required-login'))
      .toBe('appliesTo permission.prompt equals "game"; the provider declares "os"');
    expect(reasonOf('os-permission-granted'))
      .toBe('appliesTo remote.addressing equals "device"; the provider declares "none"');
    expect(reasonOf('advertising-needs-consent'))
      .toBe('appliesTo remote.purposes includes "advertising"; the provider declares []');
    expect(notificationConformanceSkipReason(
      vectorNamed('open-before-listener'),
      createUnsupportedNotificationCapabilities(),
    )).toBe('appliesTo open equals "payload"; the provider declares "none"');
  });

  it('runs a provider under its own id and evidence schema through createProvider', async () => {
    const renamed = (harness: NotificationConformanceHarness, provider: string, schema?: string) => {
      const inner = harness.provider;
      const wrapped: NotificationProvider = {
        ...inner,
        provider,
        async requestPermission(input) {
          const result = await inner.requestPermission(input);
          return schema === undefined || result.evidence === undefined
            ? result
            : { ...result, evidence: { ...result.evidence, schema } };
        },
        ...(inner.register === undefined
          ? {}
          : {
              async register() {
                const registration = await inner.register?.();
                return registration === null || registration === undefined
                  ? null
                  : { ...registration, provider };
              },
            }),
      };
      return {
        provider: wrapped,
        ...(harness.host === undefined ? {} : { host: harness.host }),
        ...(schema === undefined ? {} : { hostAgreementEvidenceSchema: schema }),
      };
    };
    const fcm = await runNotificationConformanceVector(vectorNamed('endpoint-lifecycle'), {
      createProvider: (context) => renamed(createNotificationConformanceHarness(context), 'fcm'),
    });
    expect(fcm.failures).toEqual([]);
    const agreement = await runNotificationConformanceVector(vectorNamed('host-agreement-recorded'), {
      createProvider: (context) => renamed(
        createNotificationConformanceHarness(context),
        'apps-in-toss',
        'apps-in-toss.notification-agreement.v1',
      ),
    });
    expect(agreement.failures).toEqual([]);
    // Without the declared schema the fixture schema expectation still applies.
    const undeclared = await runNotificationConformanceVector(vectorNamed('host-agreement-recorded'), {
      createProvider: (context) => {
        const harness = renamed(
          createNotificationConformanceHarness(context),
          'apps-in-toss',
          'apps-in-toss.notification-agreement.v1',
        );
        const { hostAgreementEvidenceSchema: _schema, ...withoutSchema } = harness;
        return withoutSchema;
      },
    });
    expect(undeclared.failures[0]).toMatchObject({
      path: 'steps[4].returns.evidence.schema',
      expected: notificationConformanceAgreementSchema,
    });
  });

  it('turns a harness, capability, or deployment failure into a failed result', async () => {
    const vector = vectorNamed('unsupported-target');
    expect(await runNotificationConformanceVector(vector, {
      createProvider: () => {
        throw new Error('no SDK');
      },
    })).toEqual({
      vector: 'unsupported-target',
      status: 'failed',
      passed: false,
      failures: [{ path: 'harness', expected: 'createProvider resolves', actual: 'Error: no SDK' }],
    });
    const broken = await runNotificationConformanceVector(vector, {
      createProvider: (context) => {
        const harness = createNotificationConformanceHarness(context);
        return {
          ...harness,
          provider: {
            ...harness.provider,
            async getCapabilities() {
              throw new Error('bridge down');
            },
          },
        };
      },
    });
    expect(broken.failures).toEqual([
      { path: 'capabilities', expected: 'provider.getCapabilities() resolves', actual: 'Error: bridge down' },
    ]);
    const misconfigured = await runNotificationConformanceVector({
      ...vector,
      deployment: { advertisingRules: 'kr', noticeTopic: 'energy-full' },
    });
    expect(misconfigured.failures).toEqual([{
      path: 'backend',
      expected: 'the deployment is valid',
      actual: "TypeError: The deployment's notice topic energy-full is not a declared service topic.",
    }]);
  });
});

describe('notifications reference runtime: permission and records', () => {
  it('answers action-required without a prompt or a stored reminder until the player acts', async () => {
    const { host, backend, runtime } = setup(optInProfile, [duel], { host: { actionRequired: true } });
    await runtime.start();
    expect((await host.provider.getCapabilities()).availability).toBe('action-required');
    await expect(runtime.requestPermission({ topics: ['rival-challenge'], gesture: false }))
      .rejects.toMatchObject({ code: 'NOTIFICATIONS_USER_GESTURE_REQUIRED' });
    expect(await runtime.requestPermission({ topics: ['rival-challenge'], gesture: true })).toMatchObject({
      outcomes: { 'rival-challenge': 'action-required' },
      requiredAction: 'login',
    });
    expect(await runtime.reminders.set({ key: 'k', topic: 'rival-challenge', fireAt: now }))
      .toEqual({ route: 'remote', status: 'action-required' });
    expect(await runtime.reminders.cancel({ key: 'k' })).toEqual({ route: 'remote', status: 'action-required' });
    expect(await runtime.openSettings()).toBe('unavailable');
    expect(host.prompts).toBe(0);
    expect(backend.reminders).toEqual([]);
    host.completeAction();
    backend.authenticate('p-1');
    host.queuePrompt('granted');
    expect(await runtime.requestPermission({ topics: ['rival-challenge'], gesture: true }))
      .toMatchObject({ outcomes: { 'rival-challenge': 'granted' } });
    expect(host.prompts).toBe(1);
  });

  it('reads a game-rendered consent as prompt until a decision is recorded, then denied', async () => {
    const { host, backend, runtime } = setup(optInProfile, [duel]);
    backend.authenticate('p-1');
    expect(await runtime.getPermission({ topics: ['rival-challenge'] })).toMatchObject({ app: 'prompt' });
    host.queuePrompt('denied');
    expect(await runtime.requestPermission({ topics: ['rival-challenge'], gesture: true })).toMatchObject({
      outcomes: { 'rival-challenge': 'denied' },
      snapshot: { app: 'denied' },
    });
    expect(await runtime.getPermission({ topics: ['rival-challenge'] })).toMatchObject({ app: 'denied' });
    expect(backend.consent.map((record) => [record.kind, record.state, record.source])).toEqual([
      ['delivery-permission', 'denied', 'client-report'],
    ]);
    // Other providers do not withdraw consent in the game.
    await expect(setup(osProfile).runtime.revokePermission({ topics: ['energy-full'] }))
      .rejects.toMatchObject({ code: 'NOTIFICATIONS_UNSUPPORTED' });
  });

  it('keeps only the latest record per kind and scope until a player authenticates', async () => {
    const { host, backend, runtime } = setup(optInProfile, [duel]);
    await runtime.start();
    host.queuePrompt('granted');
    await runtime.requestPermission({ topics: ['rival-challenge'], gesture: true });
    await runtime.revokePermission({ topics: ['rival-challenge'] });
    expect(backend.consent).toEqual([]);
    backend.authenticate('p-1');
    await runtime.runUntilIdle();
    expect(backend.consent.map((record) => [record.player, record.kind, record.state, record.source])).toEqual([
      ['p-1', 'delivery-permission', 'denied', 'player'],
    ]);
  });

  it('records every accepted prompt on a per-send provider', async () => {
    const { host, backend, runtime } = setup(perSendProfile);
    backend.authenticate('p-1');
    host.queuePrompt('granted');
    host.queuePrompt('already-granted');
    await runtime.requestPermission({ topics: ['rival-challenge'], gesture: true });
    await runtime.requestPermission({ topics: ['rival-challenge'], gesture: true });
    expect(backend.consent.map((record) => [record.kind, record.topic, record.state])).toEqual([
      ['host-agreement', 'rival-challenge', 'granted'],
      ['host-agreement', 'rival-challenge', 'granted'],
    ]);
    expect((await backend.deliver({ topic: 'rival-challenge', idempotencyKey: 'a' })).status).toBe('delivered');
    expect((await backend.deliver({ topic: 'rival-challenge', idempotencyKey: 'b' })).status).toBe('delivered');
    expect(await backend.deliver({ topic: 'rival-challenge', idempotencyKey: 'c' }))
      .toEqual({ status: 'suppressed', reason: 'allowance-exhausted' });
  });

  it('answers reads without a backend and refuses invalid input', async () => {
    const { runtime } = setup(hostProfile);
    expect(await runtime.getPermission({ topics: ['energy-full'] })).toEqual({
      topics: { 'energy-full': 'unknown' },
      sources: { 'energy-full': 'host' },
    });
    for (const call of [
      () => runtime.requestPermission({ topics: [], gesture: true }),
      () => runtime.setAdvertisingConsent({ textVersion: 'v1' }),
      () => runtime.setAdvertisingConsent({ advertising: 'granted', textVersion: ' ' }),
      () => runtime.setTopicPreference({ topic: 'undeclared', enabled: true }),
      () => runtime.reminders.set({ key: 'k', topic: 'energy-full', fireAt: '2026-10-12T06:00:00' }),
      () => runtime.reminders.set({ key: '', topic: 'energy-full', fireAt: now }),
      () => runtime.reminders.cancel({ key: 'a\u0000b' }),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: 'NOTIFICATIONS_INVALID_INPUT' });
    }
  });

  it('makes every call configuration-required when the provider disagrees with its registry entry', async () => {
    const { runtime } = setup(osProfile, [energy], {
      entry: (entry) => ({ ...entry, purposes: ['service'] }),
    });
    await runtime.start();
    await expect(runtime.getPermission({ topics: ['energy-full'] }))
      .rejects.toMatchObject({ code: 'NOTIFICATIONS_CONFIGURATION_REQUIRED' });
    await expect(runtime.reminders.set({ key: 'k', topic: 'energy-full', fireAt: now }))
      .rejects.toMatchObject({ code: 'NOTIFICATIONS_CONFIGURATION_REQUIRED' });
    // Signing out still unbinds.
    await expect(runtime.unregister()).resolves.toBeUndefined();
  });

  it('buffers provider events for the game and records a changed permission once', async () => {
    const { host, backend, runtime, createRuntime } = setup(optInProfile, [duel]);
    backend.authenticate('p-1');
    await runtime.start();
    host.tap({ channel: 'remote', route: '/?entry=challenge' });
    const first: NotificationEvent[] = [];
    const second: NotificationEvent[] = [];
    runtime.subscribe((event) => first.push(event));
    runtime.subscribe((event) => second.push(event));
    expect(first).toEqual([{ type: 'opened', channel: 'remote', source: 'warm', route: '/?entry=challenge' }]);
    expect(second).toEqual([]);
    const relay = relayed(host.provider);
    const listening = createRuntime(relay.provider);
    await listening.start();
    const changed: NotificationEvent = { type: 'permission-changed', snapshot: { app: 'blocked', topics: {} } };
    relay.emit(changed);
    relay.emit(changed);
    await listening.runUntilIdle();
    expect(backend.consent.map((record) => [record.kind, record.state])).toEqual([
      ['delivery-permission', 'blocked'],
    ]);
  });

  it('surfaces a failed background read on runUntilIdle, once', async () => {
    const { host, backend, createRuntime } = setup(optInProfile, [duel]);
    backend.authenticate('p-1');
    const relay = relayed(host.provider);
    const failing = createRuntime(relay.provider, {
      ...backend,
      async listConsent() {
        throw new Error('records unavailable');
      },
    });
    await failing.start();
    relay.emit({ type: 'permission-changed', snapshot: { app: 'granted', topics: {} } });
    await expect(failing.runUntilIdle()).rejects.toThrow(/records unavailable/u);
    await expect(failing.runUntilIdle()).resolves.toBeUndefined();
  });

  it('isolates a throwing game listener from the runtime and the other listeners', async () => {
    const { host, backend, runtime } = setup(osProfile);
    await runtime.start();
    backend.authenticate('p-1');
    const seen: string[] = [];
    runtime.subscribe(() => {
      throw new Error('listener bug');
    });
    runtime.subscribe((event) => seen.push(event.type));
    host.issueEndpoint({ kind: 'fcm-token', value: 'tok-1' });
    await expect(runtime.runUntilIdle()).rejects.toThrow(/listener bug/u);
    // The rotated address still reached the backend, and the second listener the event.
    expect(seen).toEqual(['endpoint-changed']);
    expect(backend.endpoints.map((endpoint) => endpoint.value)).toEqual(['tok-1']);
    // Buffered events all reach the first listener once, even when it throws on the first.
    const late = setup(osProfile);
    await late.runtime.start();
    late.host.tap({ channel: 'local', route: '/?entry=continue' });
    late.host.tap({ channel: 'local', route: '/?entry=shop' });
    const routes: (string | undefined)[] = [];
    late.runtime.subscribe((event) => {
      routes.push(event.type === 'opened' ? event.route : event.type);
      throw new Error('drain bug');
    });
    expect(routes).toEqual(['/?entry=continue', '/?entry=shop']);
    await expect(late.runtime.runUntilIdle()).rejects.toThrow(/drain bug/u);
  });

  it('keeps an unwritten record for the player it was observed for', async () => {
    const { host, backend, createRuntime } = setup(optInProfile, [duel]);
    let offline = false;
    const runtime = createRuntime(host.provider, {
      ...backend,
      async recordConsent(record) {
        if (offline) {
          offline = false;
          throw new Error('offline');
        }
        await backend.recordConsent(record);
      },
    });
    await runtime.start();
    backend.authenticate('p-1');
    offline = true;
    host.queuePrompt('granted');
    // The host has answered, so the answer is returned although the record is not written.
    expect(await runtime.requestPermission({ topics: ['rival-challenge'], gesture: true }))
      .toMatchObject({ outcomes: { 'rival-challenge': 'granted' } });
    await expect(runtime.runUntilIdle()).rejects.toThrow(/offline/u);
    expect(backend.consent).toEqual([]);
    // Another player signs in on the device: p-1's record is not written as theirs.
    backend.authenticate('p-2');
    await runtime.getPermission({ topics: ['rival-challenge'] });
    expect(backend.consent.map((record) => [record.player, record.kind, record.state])).toEqual([
      ['p-2', 'delivery-permission', 'granted'],
    ]);
    backend.authenticate('p-1');
    await runtime.runUntilIdle();
    expect(backend.consent.map((record) => record.player)).toEqual(['p-2', 'p-1']);
  });

  it('records a permission change for the player signed in when it arrived', async () => {
    const { host, backend, createRuntime } = setup(optInProfile, [duel]);
    const relay = relayed(host.provider);
    const runtime = createRuntime(relay.provider);
    await runtime.start();
    backend.authenticate('p-1');
    relay.emit({ type: 'permission-changed', snapshot: { app: 'denied', topics: {} } });
    // Another player signs in before the record is written.
    backend.authenticate('p-2');
    await runtime.runUntilIdle();
    expect(backend.consent).toEqual([]);
    backend.authenticate('p-1');
    await runtime.runUntilIdle();
    expect(backend.consent.map((record) => [record.player, record.kind, record.state])).toEqual([
      ['p-1', 'delivery-permission', 'denied'],
    ]);
  });
});

describe('notifications reference runtime: registrations and endpoints', () => {
  it('keeps one endpoint per installation with the latest address and permission', async () => {
    const { host, backend, runtime } = setup(osProfile);
    const events: NotificationEvent[] = [];
    await runtime.start();
    runtime.subscribe((event) => events.push(event));
    backend.authenticate('p-1');
    host.issueEndpoint({ kind: 'fcm-token', value: 'tok-1' });
    await runtime.runUntilIdle();
    // Registered before any prompt, with the permission the device reports.
    expect(endpointRows(backend)).toEqual([['installation-1', 'tok-1', 'prompt', 'p-1', 'valid']]);
    host.queuePrompt('granted');
    await runtime.requestPermission({ topics: ['energy-full'], gesture: true });
    expect(endpointRows(backend)).toEqual([['installation-1', 'tok-1', 'granted', 'p-1', 'valid']]);
    host.issueEndpoint({ kind: 'fcm-token', value: 'tok-2' });
    await runtime.runUntilIdle();
    expect(events.map((event) => event.type)).toEqual(['endpoint-changed', 'endpoint-changed']);
    expect(endpointRows(backend)).toEqual([['installation-1', 'tok-2', 'granted', 'p-1', 'valid']]);
    // A permission the player turns off in settings reaches the endpoint on the next read.
    host.setPermission('denied');
    await runtime.getPermission({ topics: ['energy-full'] });
    expect(endpointRows(backend)).toEqual([['installation-1', 'tok-2', 'denied', 'p-1', 'valid']]);
    expect(await backend.deliver({ topic: 'rival-challenge', idempotencyKey: 'off' }))
      .toEqual({ status: 'suppressed', reason: 'permission-denied' });
    // Device permission lives on the endpoint: no record was written.
    expect(backend.consent).toEqual([]);
  });

  it('skips an identical registration for 7 days, except on register(), and persists it across restarts', async () => {
    const { host, backend, createRuntime, clock } = setup(osProfile);
    let sent = 0;
    const client: NotificationConformanceBackendClient = {
      ...backend,
      async registerEndpoint(registration) {
        sent += 1;
        await backend.registerEndpoint(registration);
      },
    };
    const runtime = createRuntime(host.provider, client);
    await runtime.start();
    backend.authenticate('p-1');
    host.issueEndpoint({ kind: 'fcm-token', value: 'tok-1' });
    await runtime.runUntilIdle();
    expect(sent).toBe(1);
    host.issueEndpoint({ kind: 'fcm-token', value: 'tok-1' });
    await runtime.runUntilIdle();
    expect(sent).toBe(1);
    await runtime.register();
    expect(sent).toBe(2);
    // A restart keeps the acknowledged registration, so the same one is skipped again.
    runtime.stop();
    host.restart();
    const restarted = createRuntime(host.provider, client);
    await restarted.start();
    host.issueEndpoint({ kind: 'fcm-token', value: 'tok-1' });
    await restarted.runUntilIdle();
    expect(sent).toBe(2);
    clock.advance(7 * 24 * 60 * 60);
    host.issueEndpoint({ kind: 'fcm-token', value: 'tok-1' });
    await restarted.runUntilIdle();
    expect(sent).toBe(3);
    // A new session always sends.
    backend.authenticate('p-1');
    await restarted.runUntilIdle();
    expect(sent).toBe(4);
  });

  it('sends a registration made before authentication when a player authenticates', async () => {
    const { host, backend, runtime } = setup(osProfile);
    await runtime.start();
    host.issueEndpoint({ kind: 'fcm-token', value: 'tok-1' });
    await runtime.register();
    await runtime.runUntilIdle();
    expect(backend.endpoints).toEqual([]);
    backend.authenticate('p-1');
    await runtime.runUntilIdle();
    expect(backend.endpoints.map((endpoint) => [endpoint.value, endpoint.player])).toEqual([['tok-1', 'p-1']]);
    // Another account on the same installation takes the endpoint over.
    backend.authenticate('p-2');
    await runtime.runUntilIdle();
    expect(backend.endpoints.map((endpoint) => [endpoint.value, endpoint.player])).toEqual([['tok-1', 'p-2']]);
  });

  it('unbinds the installation at logout so later sends find no endpoint', async () => {
    const { host, backend, runtime } = setup(osProfile);
    await runtime.start();
    backend.authenticate('p-1');
    host.issueEndpoint({ kind: 'fcm-token', value: 'tok-1' });
    host.queuePrompt('granted');
    await runtime.requestPermission({ topics: ['rival-challenge'], gesture: true });
    expect(backend.endpoints).toHaveLength(1);
    await runtime.unregister();
    expect(backend.endpoints).toEqual([]);
    expect(await backend.deliver({ topic: 'rival-challenge', idempotencyKey: 'after-logout' }))
      .toEqual({ status: 'unavailable', reason: 'no-endpoint' });
    // Neither a changed permission nor a token refresh binds the installation again.
    host.setPermission('denied');
    await runtime.getPermission({ topics: ['rival-challenge'] });
    host.issueEndpoint({ kind: 'fcm-token', value: 'tok-2' });
    await runtime.runUntilIdle();
    expect(backend.endpoints).toEqual([]);
    // register(), or the next authentication, does.
    await runtime.register();
    expect(backend.endpoints.map((endpoint) => [endpoint.value, endpoint.permission, endpoint.player]))
      .toEqual([['tok-2', 'denied', 'p-1']]);
    await runtime.unregister();
    backend.authenticate('p-2');
    await runtime.runUntilIdle();
    expect(backend.endpoints.map((endpoint) => [endpoint.value, endpoint.player])).toEqual([['tok-2', 'p-2']]);
    // A provider without device addressing has nothing to unbind, and neither
    // does a runtime without an authenticated player.
    await expect(setup(hostProfile).runtime.unregister()).resolves.toBeUndefined();
    await expect(setup(osProfile).runtime.unregister()).resolves.toBeUndefined();
  });

  it('unbinds the player who signed out, even when the next one authenticates first', async () => {
    const { host, backend, runtime } = setup(osProfile);
    await runtime.start();
    backend.authenticate('p-1');
    host.issueEndpoint({ kind: 'fcm-token', value: 'tok-1' });
    host.queuePrompt('granted');
    await runtime.requestPermission({ topics: ['energy-full'], gesture: true });
    const signingOut = runtime.unregister();
    backend.authenticate('p-2');
    await signingOut;
    await runtime.runUntilIdle();
    expect(backend.endpoints.map((endpoint) => [endpoint.value, endpoint.player])).toEqual([['tok-1', 'p-2']]);
  });

  it('unbinds only what the ended session registered, and treats a stale endpoint as missing', async () => {
    const { host, backend, runtime, clock } = setup(osProfile);
    await runtime.start();
    backend.authenticate('p-1');
    host.issueEndpoint({ kind: 'fcm-token', value: 'tok-1' });
    await runtime.runUntilIdle();
    backend.registerInstallation({
      installationId: 'installation-2',
      kind: 'fcm-token',
      value: 'tok-2',
      permission: 'granted',
    });
    backend.revokeSession();
    expect(endpointRows(backend)).toEqual([['installation-2', 'tok-2', 'granted', 'p-1', 'valid']]);
    expect(backend.session()).toBeUndefined();
    expect((await backend.deliver({ topic: 'rival-challenge', idempotencyKey: 'fresh' })).status)
      .toBe('delivered');
    clock.advance(60 * 24 * 60 * 60);
    expect(await backend.deliver({ topic: 'rival-challenge', idempotencyKey: 'stale' }))
      .toEqual({ status: 'unavailable', reason: 'no-endpoint' });
  });

  it('keeps an address on one installation, drops an unknown zone, and keeps a dead address dead', async () => {
    const { backend } = setup(osProfile);
    backend.authenticate('p-1');
    await backend.registerEndpoint({
      provider: osProfile.provider,
      address: { kind: 'fcm-token', value: 'tok-1', permission: 'granted' },
      timeZone: 'Mars/Olympus_Mons',
    });
    expect(backend.endpoints[0]?.timeZone).toBeUndefined();
    // Another installation presenting the same address takes it over.
    const install = (value: string) => backend.registerInstallation({
      installationId: 'installation-2',
      kind: 'fcm-token',
      value,
      permission: 'granted',
    });
    install('tok-1');
    expect(endpointRows(backend)).toEqual([['installation-2', 'tok-1', 'granted', 'p-1', 'valid']]);
    backend.queueProviderResult({ status: 'unregistered' });
    expect(await backend.deliver({ topic: 'rival-challenge', idempotencyKey: 'dead' }))
      .toEqual({ status: 'unavailable', reason: 'endpoint-invalid' });
    // Reporting the dead address again does not revive it; a new address does.
    install('tok-1');
    expect(backend.endpoints[0]?.status).toBe('invalid');
    install('tok-2');
    expect(backend.endpoints[0]).toMatchObject({ value: 'tok-2', status: 'valid' });
    await expect(backend.registerEndpoint({ provider: 'other', address: { kind: 'platform-user' } }))
      .rejects.toMatchObject({ code: 'NOTIFICATIONS_INVALID_INPUT' });
  });
});

describe('notifications fake backend: sends and the ledger', () => {
  it('binds a key to its request and refuses reserved prefixes and invalid data', async () => {
    const { backend } = await devicePlayer();
    const send = { topic: 'rival-challenge', idempotencyKey: 'k-1', data: { challengeId: 'c-1' } } as const;
    expect((await backend.deliver(send)).status).toBe('delivered');
    for (const reuse of [{ ...send, data: { challengeId: 'c-2' } }, { ...send, locale: 'en' }, { ...send, link: 't3_x' }]) {
      await expect(backend.deliver(reuse)).rejects.toMatchObject({ code: 'NOTIFICATIONS_IDEMPOTENCY_CONFLICT' });
    }
    for (const invalid of [
      { ...send, idempotencyKey: 'notice:p-1:consent-result:x' },
      { ...send, idempotencyKey: 'x'.repeat(2049) },
      { ...send, idempotencyKey: 'k-2', templateData: { rival: Number.POSITIVE_INFINITY } },
      { ...send, idempotencyKey: 'k-2', data: { count: 1 } as unknown as Record<string, string> },
    ]) {
      await expect(backend.deliver(invalid)).rejects.toMatchObject({ code: 'NOTIFICATIONS_INVALID_INPUT' });
    }
    expect(await backend.deliver(send)).toEqual({ status: 'delivered', alreadyProcessed: true });
    // A send for a provider the backend does not have finds no recipient, and is not stored.
    expect(await backend.deliver({ ...send, idempotencyKey: 'k-3', provider: 'other' }))
      .toEqual({ status: 'unavailable', reason: 'no-endpoint' });
    expect(backend.deliveries.map((delivery) => [delivery.idempotencyKey, delivery.status])).toEqual([
      ['k-1', 'delivered'],
      ['k-1', 'delivered'],
      ['k-3', 'unavailable'],
    ]);
  });

  it('answers in-flight while another send holds the key', async () => {
    const { host, backend, runtime } = setup(optInProfile, [duel]);
    backend.authenticate('p-1');
    host.queuePrompt('granted');
    await runtime.requestPermission({ topics: ['rival-challenge'], gesture: true });
    // The server-readable send awaits the host read, so the second send finds the claim.
    const [first, second] = await Promise.all([
      backend.deliver({ topic: 'rival-challenge', idempotencyKey: 'k-1' }),
      backend.deliver({ topic: 'rival-challenge', idempotencyKey: 'k-1' }),
    ]);
    expect(first).toEqual({ status: 'delivered', alreadyProcessed: false });
    expect(second).toEqual({ status: 'in-flight' });
    expect(await backend.deliver({ topic: 'rival-challenge', idempotencyKey: 'k-1' }))
      .toEqual({ status: 'delivered', alreadyProcessed: true });
    expect(backend.providerCalls.map((call) => [call.idempotencyKey, call.link])).toEqual([['k-1', 't3_duel']]);
  });

  it('fans out to every granted installation under derived keys and ranks the result', async () => {
    const { backend } = await devicePlayer();
    backend.registerInstallation({ installationId: 'b/2', kind: 'fcm-token', value: 'tok-2', permission: 'blocked' });
    backend.registerInstallation({ installationId: 'c', kind: 'fcm-token', value: 'tok-3', permission: 'granted' });
    // A dead endpoint outranks a refused one when nothing was delivered.
    backend.queueProviderResult({ status: 'unregistered' });
    backend.queueProviderResult({ status: 'unregistered' });
    expect(await backend.deliver({ topic: 'rival-challenge', idempotencyKey: 'f-1' }))
      .toEqual({ status: 'unavailable', reason: 'endpoint-invalid' });
    expect(backend.providerCalls.map((call) => [call.idempotencyKey, call.address])).toEqual([
      ['f-1:c', 'tok-3'],
      ['f-1:installation-1', 'tok-1'],
    ]);
    // Only the blocked installation is left: the gate refuses it.
    expect(await backend.deliver({ topic: 'rival-challenge', idempotencyKey: 'f-2' }))
      .toEqual({ status: 'suppressed', reason: 'permission-denied' });
    backend.registerInstallation({ installationId: 'd', kind: 'fcm-token', value: 'tok-4', permission: 'granted' });
    backend.registerInstallation({ installationId: 'e', kind: 'fcm-token', value: 'tok-5', permission: 'granted' });
    backend.queueProviderResult({ status: 'rate-limited', retryAfterSeconds: 30 });
    backend.queueProviderResult({ status: 'rate-limited', retryAfterSeconds: 10 });
    // Waiting outranks a refusal, and the earliest wait is the send's `until`.
    expect(await backend.deliver({ topic: 'rival-challenge', idempotencyKey: 'f-3' }))
      .toEqual({ status: 'deferred', reason: 'provider-rate-limited', until: '2026-10-12T03:00:10Z' });
    expect(backend.providerCalls.slice(2).map((call) => call.idempotencyKey)).toEqual(['f-3:d', 'f-3:e']);
  });

  it('keeps an ambiguous claim for the lease: the direct caller replays a platform send, the scheduler a device one', async () => {
    const platform = setup(hostProfile, [receipt]);
    platform.backend.authenticate('p-1');
    platform.backend.queueProviderResult({ status: 'ambiguous' });
    const send = { topic: 'purchase-result', idempotencyKey: 'a-1' } as const;
    expect(await platform.backend.deliver(send)).toEqual({ status: 'in-flight' });
    expect(await platform.backend.deliver(send)).toEqual({ status: 'in-flight' });
    platform.clock.advance(300);
    // The scheduler leaves a direct caller's claim to that caller.
    await platform.backend.runScheduler();
    expect(platform.backend.providerCalls).toHaveLength(1);
    expect(await platform.backend.deliver(send)).toEqual({ status: 'delivered', alreadyProcessed: false });
    expect(platform.backend.providerCalls).toHaveLength(2);
    expect(platform.backend.deliveries.map((delivery) => delivery.status))
      .toEqual(['in-flight', 'in-flight', 'delivered']);

    const device = await devicePlayer();
    device.backend.queueProviderResult({ status: 'ambiguous' });
    expect(await device.backend.deliver({ topic: 'rival-challenge', idempotencyKey: 'a-2' }))
      .toEqual({ status: 'in-flight' });
    device.clock.advance(299);
    await device.backend.runScheduler();
    expect(device.backend.providerCalls).toHaveLength(1);
    device.clock.advance(1);
    await device.backend.runScheduler();
    expect(device.backend.providerCalls).toHaveLength(2);
    expect(await device.backend.deliver({ topic: 'rival-challenge', idempotencyKey: 'a-2' }))
      .toEqual({ status: 'delivered', alreadyProcessed: true });
  });

  it('defers a rate-limited send, backs off, and gives up after a day', async () => {
    const { clock, backend } = await devicePlayer();
    backend.queueProviderResult({ status: 'rate-limited' });
    const deferred = { status: 'deferred', reason: 'provider-rate-limited', until: '2026-10-12T03:01:00Z' };
    expect(await backend.deliver({ topic: 'rival-challenge', idempotencyKey: 'r-1' })).toEqual(deferred);
    // A retry while the send waits answers the waiting result without the gate.
    expect(await backend.deliver({ topic: 'rival-challenge', idempotencyKey: 'r-1' })).toEqual(deferred);
    clock.advance(59);
    await backend.runScheduler();
    expect(backend.providerCalls).toHaveLength(1);
    clock.advance(1);
    backend.queueProviderResult({ status: 'rate-limited', retryAfterSeconds: 5 });
    await backend.runScheduler();
    // Later deferrals double the first delay, whatever the provider names.
    expect(await backend.deliver({ topic: 'rival-challenge', idempotencyKey: 'r-1' }))
      .toEqual({ ...deferred, until: '2026-10-12T03:03:00Z' });
    clock.set('2026-10-13T03:00:00Z');
    backend.queueProviderResult({ status: 'rate-limited' });
    await backend.runScheduler();
    expect(backend.deliveries.map((delivery) => [delivery.status, 'reason' in delivery ? delivery.reason : '']))
      .toEqual([
        ['deferred', 'provider-rate-limited'],
        ['deferred', 'provider-rate-limited'],
        ['deferred', 'provider-rate-limited'],
        ['deferred', 'provider-rate-limited'],
        ['unavailable', 'provider-rate-limited'],
      ]);
    // Not stored: a retry is evaluated again.
    expect((await backend.deliver({ topic: 'rival-challenge', idempotencyKey: 'r-1' })).status).toBe('delivered');
  });

  it('does not store a rejection, and records the recipient agreement a provider says is missing', async () => {
    const { host, backend, runtime } = setup(hostProfile, [challenge]);
    backend.authenticate('p-1');
    host.queuePrompt('granted');
    await runtime.requestPermission({ topics: ['rival-challenge'], gesture: true });
    backend.queueProviderResult({ status: 'rejected', reason: 'configuration' });
    expect(await backend.deliver({ topic: 'rival-challenge', idempotencyKey: 'j-1' }))
      .toEqual({ status: 'unavailable', reason: 'provider-rejected' });
    expect((await backend.deliver({ topic: 'rival-challenge', idempotencyKey: 'j-1' })).status).toBe('delivered');
    backend.queueProviderResult({ status: 'rejected', reason: 'agreement' });
    expect(await backend.deliver({ topic: 'rival-challenge', idempotencyKey: 'j-2' }))
      .toEqual({ status: 'unavailable', reason: 'provider-rejected' });
    expect(backend.consent.map((record) => [record.kind, record.state, record.source])).toEqual([
      ['host-agreement', 'granted', 'client-report'],
      ['host-agreement', 'denied', 'provider'],
    ]);
  });

  it('keeps a delivered key for 30 days', async () => {
    const { clock, backend } = await devicePlayer();
    const send = { topic: 'rival-challenge', idempotencyKey: 'old' } as const;
    await backend.deliver(send);
    clock.advance(30 * 24 * 60 * 60 - 1);
    expect(await backend.deliver(send)).toEqual({ status: 'delivered', alreadyProcessed: true });
    clock.advance(1);
    // The runtime refreshes its registration within 60 days; this one stays fresh enough.
    expect(await backend.deliver(send)).toEqual({ status: 'delivered', alreadyProcessed: false });
  });
});

describe('notifications fake backend: the scheduler and reminders', () => {
  it('replays a deferred send into a new deferral and keeps one stored entry', async () => {
    const { clock, host, backend, runtime } = setup(
      osProfile,
      [{ ...weekend, quietHours: { start: '20:00', end: '22:00' } }],
      { deployment: kr },
    );
    await runtime.start();
    backend.authenticate('p-1');
    host.issueEndpoint({ kind: 'fcm-token', value: 'tok-1' });
    host.queuePrompt('granted');
    await runtime.requestPermission({ topics: ['weekend-event'], gesture: true });
    await runtime.setAdvertisingConsent({ advertising: 'granted', textVersion: 'ad-consent-v1' });
    clock.set('2026-10-12T11:30:00Z'); // 20:30 KST: quiet hours
    expect(await backend.deliver({ topic: 'weekend-event', idempotencyKey: 'w-1' }))
      .toEqual({ status: 'deferred', reason: 'quiet-hours', until: '2026-10-12T13:00:00Z' });
    clock.set('2026-10-12T13:00:00Z'); // 22:00 KST: the night window holds it next
    await backend.runScheduler();
    expect(await backend.deliver({ topic: 'weekend-event', idempotencyKey: 'w-1' }))
      .toEqual({ status: 'deferred', reason: 'night-window', until: '2026-10-12T23:00:00Z' });
    clock.set('2026-10-12T23:00:00Z');
    await backend.runScheduler();
    expect(backend.deliveries.map((delivery) => [delivery.status, 'reason' in delivery ? delivery.reason : '']))
      .toEqual([
        ['deferred', 'quiet-hours'],
        ['deferred', 'night-window'],
        ['deferred', 'night-window'],
        ['delivered', ''],
      ]);
    expect(backend.providerCalls.map((call) => call.expiresAt)).toEqual(['2026-10-13T12:00:00Z']);
  });

  it('replays a due deferred send once when schedulers overlap', async () => {
    const { clock, host, backend, runtime } = setup(optInProfile, [duel]);
    backend.authenticate('p-1');
    host.queuePrompt('granted');
    await runtime.requestPermission({ topics: ['rival-challenge'], gesture: true });
    backend.queueProviderResult({ status: 'rate-limited' });
    expect(await backend.deliver({ topic: 'rival-challenge', idempotencyKey: 'k-1' }))
      .toMatchObject({ status: 'deferred', reason: 'provider-rate-limited' });
    clock.advance(60);
    // The server-readable send awaits the host read, so both schedulers see the due entry.
    await Promise.all([backend.runScheduler(), backend.runScheduler()]);
    expect(backend.providerCalls).toHaveLength(2);
    expect(backend.deliveries.map((delivery) => delivery.status)).toEqual(['deferred', 'delivered']);
  });

  it('sends a due reminder once when schedulers overlap, and retries a failed host read of any class', async () => {
    const clock = createNotificationConformanceClock(now);
    let reads = 0;
    const backend = createNotificationConformanceBackend({
      entry: notificationConformanceRegistryEntry({ provider: optInProfile.provider, capabilities: optInProfile.capabilities }),
      catalog: [duel],
      clock,
      defaultLocale: 'ko',
      defaultPlayer: 'p-1',
      async readServerPermission(): Promise<'granted'> {
        reads += 1;
        if (reads === 2) {
          // A fetch runtime reports a network failure as a TypeError.
          throw new TypeError('fetch failed');
        }
        return 'granted';
      },
    });
    backend.authenticate('p-1');
    expect(await backend.setReminder({ key: 'k', topic: 'rival-challenge', fireAt: now })).toBe('scheduled');
    // A failed read is not a caller error: the reminder stays for the next run.
    await expect(backend.runScheduler()).rejects.toThrow(/could not answer the send-time permission read/u);
    expect(backend.reminders).toHaveLength(1);
    await Promise.all([backend.runScheduler(), backend.runScheduler()]);
    expect(backend.providerCalls.map((call) => call.idempotencyKey))
      .toEqual(['reminder:p-1:k:2026-10-12T03:00:00Z']);
    expect(backend.deliveries.map((delivery) => delivery.status)).toEqual(['delivered']);
    expect(backend.reminders).toEqual([]);
  });

  it('checks a server reminder against gate steps 3 to 5 when it is set, and stores nothing on failure', async () => {
    const { host, backend, runtime } = setup(hostProfile, [energy, receipt]);
    backend.authenticate('p-1');
    expect(await backend.setReminder({ key: 'k', topic: 'purchase-result', fireAt: now })).toBe('scheduled');
    expect(await backend.setReminder({ key: 'k', topic: 'purchase-result', fireAt: now })).toBe('replaced');
    await expect(backend.setReminder({ key: 'k', topic: 'purchase-result', fireAt: now, templateData: { a: 'b' } }))
      .rejects.toMatchObject({ code: 'NOTIFICATIONS_INVALID_INPUT' });
    // The runtime refuses template data on a host-template provider before it reaches the backend.
    await expect(runtime.reminders.set({ key: 'k', topic: 'purchase-result', fireAt: now, templateData: { a: 'b' } }))
      .rejects.toMatchObject({ code: 'NOTIFICATIONS_INVALID_INPUT' });
    expect(await runtime.reminders.set({ key: 'e', topic: 'energy-full', fireAt: now }))
      .toEqual({ route: 'remote', status: 'permission-required' });
    host.queuePrompt('granted');
    await runtime.requestPermission({ topics: ['energy-full'], gesture: true });
    await runtime.setTopicPreference({ topic: 'energy-full', enabled: false });
    expect(await runtime.reminders.set({ key: 'e', topic: 'energy-full', fireAt: now }))
      .toEqual({ route: 'remote', status: 'preference-off' });
    expect(backend.reminders.map((reminder) => reminder.key)).toEqual(['k']);
  });

  it('drops a reminder whose send cannot be made instead of failing every run', async () => {
    const templated = { ...duel, mapping: { title: 'Duel', body: '{{rival}} wants a duel.', link: 't3_x' } };
    const { host, backend, runtime } = setup(optInProfile, [templated]);
    backend.authenticate('p-1');
    host.queuePrompt('granted');
    await runtime.requestPermission({ topics: ['rival-challenge'], gesture: true });
    // A key that cannot key a send is refused when it is set.
    await expect(backend.setReminder({ key: '\uD800', topic: 'rival-challenge', fireAt: now }))
      .rejects.toMatchObject({ code: 'NOTIFICATIONS_INVALID_INPUT' });
    expect(backend.reminders).toEqual([]);
    // No template data for {{rival}}: the scheduler cannot render the send.
    await backend.setReminder({ key: 'k', topic: 'rival-challenge', fireAt: now });
    await expect(backend.runScheduler()).rejects.toThrow(/could not process 1 item/u);
    expect(backend.reminders).toEqual([]);
    await expect(backend.runScheduler()).resolves.toBeUndefined();
    expect(backend.providerCalls).toEqual([]);
  });

  it('abandons a scheduled send whose reminder is cancelled while it waits', async () => {
    const clock = createNotificationConformanceClock(now);
    let reads = 0;
    let answer: ((state: 'granted') => void) | undefined;
    const backend = createNotificationConformanceBackend({
      entry: notificationConformanceRegistryEntry({ provider: optInProfile.provider, capabilities: optInProfile.capabilities }),
      catalog: [duel],
      clock,
      defaultLocale: 'ko',
      defaultPlayer: 'p-1',
      readServerPermission: () => {
        reads += 1;
        return reads === 1
          ? 'granted'
          : new Promise<'granted'>((resolve) => {
            answer = resolve;
          });
      },
    });
    backend.authenticate('p-1');
    await backend.setReminder({ key: 'k', topic: 'rival-challenge', fireAt: now });
    const running = backend.runScheduler();
    // The send now waits for the server-readable permission read.
    expect(await backend.cancelReminder({ key: 'k' })).toBe(true);
    answer?.('granted');
    await running;
    expect(backend.providerCalls).toEqual([]);
    expect(backend.deliveries).toEqual([]);
    expect(backend.reminders).toEqual([]);
  });

  it('cancels a server reminder whose send waits as deferred', async () => {
    const quiet = { ...challenge, quietHours: { start: '11:00', end: '13:00' } };
    const { clock, host, backend, runtime } = setup(osProfile, [energy, quiet]);
    await runtime.start();
    backend.authenticate('p-1');
    host.issueEndpoint({ kind: 'fcm-token', value: 'tok-1' });
    host.queuePrompt('granted');
    await runtime.requestPermission({ topics: ['rival-challenge'], gesture: true });
    expect(await runtime.reminders.set({ key: 'q', topic: 'rival-challenge', fireAt: now }))
      .toEqual({ route: 'remote', status: 'scheduled' });
    await backend.runScheduler();
    expect(backend.deliveries.map((delivery) => delivery.status)).toEqual(['deferred']);
    expect(backend.reminders).toEqual([]);
    expect(await runtime.reminders.cancel({ key: 'q' })).toEqual({ route: 'remote', status: 'cancelled' });
    clock.set('2026-10-12T05:00:00Z');
    await backend.runScheduler();
    expect(backend.providerCalls).toEqual([]);
  });

  it('drops a deferred send that cannot be made when it is replayed', async () => {
    const templated = {
      ...challenge,
      quietHours: { start: '11:00', end: '13:00' },
      copy: { ko: { title: '도전', body: '{{rival}}님의 도전장이에요.' } },
    };
    const { clock, host, backend, runtime } = setup(osProfile, [energy, templated]);
    await runtime.start();
    backend.authenticate('p-1');
    host.issueEndpoint({ kind: 'fcm-token', value: 'tok-1' });
    host.queuePrompt('granted');
    await runtime.requestPermission({ topics: ['rival-challenge'], gesture: true });
    // Quiet hours defer the send before its content is rendered.
    expect(await backend.deliver({ topic: 'rival-challenge', idempotencyKey: 'd-1' }))
      .toMatchObject({ status: 'deferred', reason: 'quiet-hours' });
    clock.set('2026-10-12T04:00:00Z');
    await expect(backend.runScheduler()).rejects.toThrow(/could not process 1 item/u);
    await expect(backend.runScheduler()).resolves.toBeUndefined();
    expect(backend.providerCalls).toEqual([]);
    // Delivered directly, the same missing value is the caller's error.
    await expect(backend.deliver({ topic: 'rival-challenge', idempotencyKey: 'd-2' }))
      .rejects.toMatchObject({ code: 'NOTIFICATIONS_INVALID_INPUT' });
  });

  it('dispatches due rows within the registry rate, oldest first', async () => {
    const { clock, backend } = setup(hostProfile, [receipt], {
      entry: (entry) => ({ ...entry, rate: { count: 1, windowSeconds: 60 } }),
    });
    backend.authenticate('p-1');
    await backend.setReminder({ key: 'late', topic: 'purchase-result', fireAt: now });
    await backend.setReminder({ key: 'early', topic: 'purchase-result', fireAt: '2026-10-12T02:59:00Z' });
    await backend.runScheduler();
    expect(backend.providerCalls.map((call) => call.idempotencyKey))
      .toEqual(['reminder:p-1:early:2026-10-12T02:59:00Z']);
    expect(backend.reminders.map((reminder) => reminder.key)).toEqual(['late']);
    clock.advance(60);
    await backend.runScheduler();
    expect(backend.reminders).toEqual([]);
    expect(backend.providerCalls).toHaveLength(2);
  });

  it('sends unrecorded notices through the notice topic and records them; re-confirmation repeats', async () => {
    const { clock, host, backend, runtime } = setup(osProfile, [weekend, noticeTopic], {
      deployment: { ...kr, noticeTopic: 'consent-notice' },
    });
    await runtime.start();
    backend.authenticate('p-1');
    host.issueEndpoint({ kind: 'fcm-token', value: 'tok-1' });
    host.queuePrompt('granted');
    await runtime.requestPermission({ topics: ['consent-notice'], gesture: true });
    await runtime.setAdvertisingConsent({ advertising: 'granted', textVersion: 'ad-v1' });
    clock.set('2026-10-18T14:59:59Z'); // 23:59:59 KST, the day before the send window opens
    await backend.runScheduler();
    expect(backend.providerCalls).toEqual([]);
    clock.set('2026-10-18T15:00:00Z');
    await backend.runScheduler();
    expect(backend.providerCalls.map((call) => [call.sendKey, call.topic, call.content.body])).toEqual([
      ['notice:p-1:consent-result:advertising:2026-10-12T03:00:00Z:2026-10-26', 'consent-notice', '2026-10-12에 동의하셨어요.'],
    ]);
    expect(backend.noticesGiven.map((given) => [given.kind, given.record, given.dueBy, given.channel])).toEqual([
      ['consent-result', { kind: 'advertising', at: '2026-10-12T03:00:00Z' }, '2026-10-26', 'push'],
    ]);
    // Each later run finds it recorded.
    await backend.runScheduler();
    expect(backend.providerCalls).toHaveLength(1);
    // Two years on, the first re-confirmation goes out; the next one is not listed before its own window.
    for (const [at, dueBy] of [
      ['2028-10-04T03:00:00Z', '2028-10-11'],
      ['2030-10-04T03:00:00Z', '2030-10-11'],
    ] as const) {
      clock.set(at);
      await runtime.register();
      expect(await runtime.notices.list()).toEqual([expect.objectContaining({ kind: 'reconfirmation', dueBy })]);
      await backend.runScheduler();
      expect(await runtime.notices.list()).toEqual([]);
    }
    // Each notice of the series has its own key.
    expect(backend.providerCalls.map((call) => call.sendKey)).toEqual([
      'notice:p-1:consent-result:advertising:2026-10-12T03:00:00Z:2026-10-26',
      'notice:p-1:reconfirmation:advertising:2026-10-12T03:00:00Z:2028-10-11',
      'notice:p-1:reconfirmation:advertising:2026-10-12T03:00:00Z:2030-10-11',
    ]);
    expect(backend.noticesGiven.map((given) => [given.kind, given.dueBy, given.channel])).toEqual([
      ['consent-result', '2026-10-26', 'push'],
      ['reconfirmation', '2028-10-11', 'push'],
      ['reconfirmation', '2030-10-11', 'push'],
    ]);
    // The game showing a pushed notice again changes nothing.
    await runtime.notices.recordShown({
      kind: 'reconfirmation',
      record: { kind: 'advertising', at: '2026-10-12T12:00:00+09:00' },
      dueBy: '2030-10-11',
    });
    expect(backend.noticesGiven).toHaveLength(3);
    clock.set('2032-08-11T15:00:00Z');
    expect(await runtime.notices.list())
      .toEqual([expect.objectContaining({ kind: 'reconfirmation', dueBy: '2032-10-11' })]);
  });

  it('records a notice only while it is listed, so a late retry never skips the next re-confirmation', async () => {
    const { clock, host, backend, createRuntime } = setup(osProfile, [weekend, noticeTopic], {
      deployment: { ...kr, noticeTopic: 'consent-notice' },
    });
    // What the runtime sends the backend.
    const forwarded: unknown[] = [];
    const runtime = createRuntime(host.provider, {
      ...backend,
      async recordNotice(input) {
        forwarded.push(input);
        await backend.recordNotice(input);
      },
    });
    backend.authenticate('p-1');
    await runtime.setAdvertisingConsent({ advertising: 'granted', textVersion: 'ad-v1' });
    await runtime.notices.recordShown({
      kind: 'consent-result',
      record: { kind: 'advertising', at: now },
      dueBy: '2026-10-26',
    });
    const first = {
      kind: 'reconfirmation',
      record: { kind: 'advertising', at: '2026-10-12T12:00:00+09:00' },
      dueBy: '2028-10-11',
    } as const;
    // Not listed yet: recording it early changes nothing.
    await runtime.notices.recordShown(first);
    expect(backend.noticesGiven).toHaveLength(1);
    // Shown after its due date, it is recorded once; the backend gets the record time in the canonical form.
    clock.set('2028-10-20T03:00:00Z');
    expect(await runtime.notices.list()).toEqual([expect.objectContaining({ kind: 'reconfirmation', dueBy: '2028-10-11' })]);
    await runtime.notices.recordShown(first);
    expect(forwarded.at(-1)).toEqual({
      kind: 'reconfirmation',
      record: { kind: 'advertising', at: '2026-10-12T03:00:00Z' },
      dueBy: '2028-10-11',
      channel: 'in-game',
    });
    // A retry on a later day changes nothing: the next re-confirmation keeps its place.
    clock.set('2028-10-25T03:00:00Z');
    await runtime.notices.recordShown(first);
    expect(backend.noticesGiven.map((given) => [given.kind, given.dueBy, given.channel])).toEqual([
      ['consent-result', '2026-10-26', 'in-game'],
      ['reconfirmation', '2028-10-11', 'in-game'],
    ]);
    expect(await runtime.notices.list()).toEqual([]);
    clock.set('2030-08-11T15:00:00Z');
    const listed = (await runtime.notices.list())[0];
    if (listed === undefined) {
      throw new Error('The re-confirmation due 2030-10-11 is listed from 2030-08-12 KST.');
    }
    expect(listed).toMatchObject({ kind: 'reconfirmation', dueBy: '2030-10-11', record: { state: 'granted' } });
    // An unknown notice changes nothing; malformed input throws, with an
    // unknown key at the top level or inside `record` in either form.
    await runtime.notices.recordShown({ ...first, record: { kind: 'night', at: now }, dueBy: '2030-10-11' });
    expect(backend.noticesGiven).toHaveLength(2);
    for (const malformed of [
      { ...listed, shown: true },
      { ...listed, record: { ...listed.record, note: 'shown' } },
      { ...first, shown: true },
      { ...first, record: { ...first.record, note: 'shown' } },
      { ...first, dueBy: '2030-02-30' },
      { ...first, record: { kind: 'advertising', at: '2026-10-12T03:00:00' } },
      { kind: 'reconfirmation', recordAt: now },
    ]) {
      await expect(runtime.notices.recordShown(malformed as typeof first), JSON.stringify(malformed))
        .rejects.toMatchObject({ code: 'NOTIFICATIONS_INVALID_INPUT' });
    }
    expect(backend.noticesGiven).toHaveLength(2);
    // The listed notice passed as is is recorded, and the backend gets only its name.
    await runtime.notices.recordShown(listed);
    expect(forwarded.at(-1)).toEqual({
      kind: 'reconfirmation',
      record: { kind: 'advertising', at: now },
      dueBy: '2030-10-11',
      channel: 'in-game',
    });
    expect(backend.noticesGiven.map((given) => [given.kind, given.dueBy, given.channel])).toEqual([
      ['consent-result', '2026-10-26', 'in-game'],
      ['reconfirmation', '2028-10-11', 'in-game'],
      ['reconfirmation', '2030-10-11', 'in-game'],
    ]);
    expect(await runtime.notices.list()).toEqual([]);
  });

  it('lists no notices without the Korean rules', async () => {
    const { backend, runtime } = setup(osProfile, [weekend], { deployment: { advertisingRules: 'none' } });
    backend.authenticate('p-1');
    await runtime.setAdvertisingConsent({ advertising: 'granted', night: 'withdrawn', textVersion: 'ad-v1' });
    expect(backend.consent.map((record) => [record.kind, record.state])).toEqual([
      ['advertising', 'granted'],
      ['night', 'withdrawn'],
    ]);
    expect(await runtime.notices.list()).toEqual([]);
    expect(backend.notices).toEqual([]);
  });
});

describe('notifications reference runtime: local reminders', () => {
  it('keeps the nearest local reminders within maxPending', async () => {
    const profile = {
      ...osProfile,
      capabilities: { ...osProfile.capabilities, local: { supported: true, maxPending: 1 } },
    } satisfies NotificationConformanceProfile;
    const catalog = [energy, { ...energy, id: 'energy-half' }];
    const { host, backend, runtime } = setup(profile, catalog);
    backend.authenticate('p-1');
    host.queuePrompt('granted');
    await runtime.requestPermission({ topics: ['energy-full'], gesture: true });
    await runtime.setTopicPreference({ topic: 'energy-full', enabled: true });
    await runtime.setTopicPreference({ topic: 'energy-half', enabled: true });
    expect(await runtime.reminders.set({ key: 'a', topic: 'energy-full', fireAt: '2026-10-12T06:00:00Z' }))
      .toEqual({ route: 'local', status: 'scheduled' });
    expect(await runtime.reminders.set({ key: 'b', topic: 'energy-half', fireAt: '2026-10-12T07:00:00Z' }))
      .toEqual({ route: 'local', status: 'capacity-exceeded' });
    expect(await runtime.reminders.set({ key: 'c', topic: 'energy-half', fireAt: '2026-10-12T05:00:00Z' }))
      .toEqual({ route: 'local', status: 'scheduled' });
    expect(host.localOperations).toEqual([
      { op: 'schedule', key: 'a', topic: 'energy-full', fireAt: '2026-10-12T06:00:00Z', exact: false },
      { op: 'cancel', key: 'a', topic: 'energy-full' },
      { op: 'schedule', key: 'c', topic: 'energy-half', fireAt: '2026-10-12T05:00:00Z', exact: false },
    ]);
    expect(await runtime.reminders.cancel({ key: 'missing' })).toEqual({ route: 'none', status: 'cancelled' });
  });

  it('caps local reminders per topic per day, moves them out of quiet hours, and refuses one without copy', async () => {
    const quiet = { ...energy, quietHours: { start: '13:00', end: '16:00' }, frequency: { maxPerDay: 1 } };
    const { host, backend, runtime } = setup(osProfile, [quiet, { ...challenge, channels: ['local'], copy: {} }]);
    backend.authenticate('p-1');
    host.queuePrompt('granted');
    await runtime.requestPermission({ topics: ['energy-full'], gesture: true });
    await runtime.setTopicPreference({ topic: 'energy-full', enabled: true });
    expect(await runtime.reminders.set({ key: 'e', topic: 'energy-full', fireAt: '2026-10-12T05:00:00Z' }))
      .toEqual({ route: 'local', status: 'scheduled' });
    expect(host.localPending).toEqual([{ key: 'e', topic: 'energy-full', fireAt: '2026-10-12T07:00:00Z' }]);
    expect(await runtime.reminders.set({ key: 'f', topic: 'energy-full', fireAt: '2026-10-12T09:00:00Z' }))
      .toEqual({ route: 'local', status: 'frequency-capped' });
    // Replacing a reminder does not count it against itself.
    expect(await runtime.reminders.set({ key: 'e', topic: 'energy-full', fireAt: '2026-10-12T09:00:00Z' }))
      .toEqual({ route: 'local', status: 'replaced' });
    expect(await runtime.reminders.set({ key: 'r', topic: 'rival-challenge', fireAt: now }))
      .toEqual({ route: 'local', status: 'unavailable' });
    expect(await runtime.reminders.set({ key: 'x', topic: 'unknown', fireAt: now }))
      .toEqual({ route: 'none', status: 'unavailable' });
  });

  it('names one reminder per key across both routes', async () => {
    const daily = { ...energy, id: 'daily-puzzle', channels: ['remote'] } as const;
    const { host, backend, runtime } = setup(osProfile, [energy, daily]);
    await runtime.start();
    backend.authenticate('p-1');
    host.issueEndpoint({ kind: 'fcm-token', value: 'tok-1' });
    host.queuePrompt('granted');
    await runtime.requestPermission({ topics: ['energy-full'], gesture: true });
    await runtime.setTopicPreference({ topic: 'energy-full', enabled: true });
    await runtime.setTopicPreference({ topic: 'daily-puzzle', enabled: true });
    expect(await runtime.reminders.set({ key: 'k', topic: 'daily-puzzle', fireAt: '2026-10-12T06:00:00Z' }))
      .toEqual({ route: 'remote', status: 'scheduled' });
    expect(await runtime.reminders.set({ key: 'k', topic: 'energy-full', fireAt: '2026-10-12T06:00:00Z' }))
      .toEqual({ route: 'local', status: 'scheduled' });
    expect(backend.reminders).toEqual([]);
    expect(await runtime.reminders.set({ key: 'k', topic: 'daily-puzzle', fireAt: '2026-10-12T07:00:00Z' }))
      .toEqual({ route: 'remote', status: 'scheduled' });
    expect(host.localPending).toEqual([]);
    expect(host.localOperations.map((operation) => operation.op)).toEqual(['schedule', 'cancel']);
    expect(backend.reminders.map((reminder) => [reminder.key, reminder.topic])).toEqual([['k', 'daily-puzzle']]);
  });

  it('cancels every pending local reminder once the device permission stops being granted', async () => {
    const { host, backend, runtime } = setup(osProfile);
    backend.authenticate('p-1');
    host.queuePrompt('granted');
    await runtime.requestPermission({ topics: ['energy-full'], gesture: true });
    await runtime.setTopicPreference({ topic: 'energy-full', enabled: true });
    await runtime.reminders.set({ key: 'a', topic: 'energy-full', fireAt: '2026-10-12T06:00:00Z' });
    await runtime.reminders.set({ key: 'b', topic: 'energy-full', fireAt: '2026-10-12T07:00:00Z' });
    expect(host.localPending).toHaveLength(2);
    host.setPermission('denied');
    await runtime.getPermission({ topics: ['energy-full'] });
    expect(host.localPending).toEqual([]);
    expect(host.localOperations.filter((operation) => operation.op === 'cancel').map((operation) => operation.key))
      .toEqual(['a', 'b']);
  });

  it('reconciles pending local reminders with a preference changed on another device', async () => {
    const { host, backend, runtime, createRuntime } = setup(osProfile);
    backend.authenticate('p-1');
    host.queuePrompt('granted');
    await runtime.requestPermission({ topics: ['energy-full'], gesture: true });
    await runtime.setTopicPreference({ topic: 'energy-full', enabled: true });
    await runtime.reminders.set({ key: 'a', topic: 'energy-full', fireAt: '2026-10-12T06:00:00Z' });
    // Another device turns the topic off; this one learns it at its next start.
    await backend.recordConsent({
      kind: 'topic-preference',
      topic: 'energy-full',
      state: 'withdrawn',
      source: 'player',
      at: now,
    });
    expect(host.localPending).toHaveLength(1);
    runtime.stop();
    host.restart();
    await createRuntime().start();
    expect(host.localPending).toEqual([]);
  });

  it('cancels pending local reminders whose topic an app update took off the local route', async () => {
    const daily = { ...energy, id: 'daily-puzzle' };
    const chest = { ...energy, id: 'chest-ready', channels: ['local'] } as const;
    const { clock, host, backend, runtime, storage, entry } = setup(osProfile, [energy, daily, chest]);
    backend.authenticate('p-1');
    host.queuePrompt('granted');
    await runtime.requestPermission({ topics: ['energy-full'], gesture: true });
    for (const topic of ['energy-full', 'daily-puzzle', 'chest-ready']) {
      await runtime.setTopicPreference({ topic, enabled: true });
    }
    await runtime.reminders.set({ key: 'a', topic: 'energy-full', fireAt: '2026-10-12T06:00:00Z' });
    await runtime.reminders.set({ key: 'b', topic: 'daily-puzzle', fireAt: '2026-10-12T07:00:00Z' });
    await runtime.reminders.set({ key: 'c', topic: 'chest-ready', fireAt: '2026-10-12T08:00:00Z' });
    expect(host.localPending.map((pending) => pending.key)).toEqual(['a', 'b', 'c']);
    // The update removes energy-full and leaves daily-puzzle remote only. The
    // backend is down at start, so only the catalog decides.
    runtime.stop();
    host.restart();
    const updated = createNotificationConformanceRuntime({
      provider: host.provider,
      backend: {
        ...backend,
        async listConsent() {
          throw new Error('backend down');
        },
      },
      catalog: [{ ...daily, channels: ['remote'] }, chest],
      clock,
      timeZone: 'Asia/Seoul',
      defaultLocale: 'ko',
      storage,
      ...(entry === undefined ? {} : { registryEntry: entry }),
    });
    await updated.start();
    await expect(updated.runUntilIdle()).rejects.toThrow(/backend down/u);
    expect(host.localPending.map((pending) => pending.key)).toEqual(['c']);
    expect(host.localOperations.filter((operation) => operation.op === 'cancel').map((operation) => operation.key))
      .toEqual(['a', 'b']);
  });

  it('still reconciles the other reminders when the host cannot cancel one whose topic was removed', async () => {
    const daily = { ...energy, id: 'daily-puzzle' };
    const chest = { ...energy, id: 'chest-ready' };
    const { clock, host, backend, runtime, storage, entry } = setup(osProfile, [energy, daily, chest]);
    backend.authenticate('p-1');
    host.queuePrompt('granted');
    await runtime.requestPermission({ topics: ['energy-full'], gesture: true });
    for (const topic of ['energy-full', 'daily-puzzle', 'chest-ready']) {
      await runtime.setTopicPreference({ topic, enabled: true });
    }
    await runtime.reminders.set({ key: 'a', topic: 'energy-full', fireAt: '2026-10-12T06:00:00Z' });
    await runtime.reminders.set({ key: 'b', topic: 'daily-puzzle', fireAt: '2026-10-12T07:00:00Z' });
    await runtime.reminders.set({ key: 'c', topic: 'chest-ready', fireAt: '2026-10-12T08:00:00Z' });
    // Another device turns daily-puzzle off: only the backend's record knows.
    await backend.recordConsent({
      kind: 'topic-preference',
      topic: 'daily-puzzle',
      state: 'withdrawn',
      source: 'player',
      at: now,
    });
    runtime.stop();
    host.restart();
    // An app update removed energy-full, and the host refuses any batch with its reminder.
    const batches: (readonly string[])[] = [];
    const updatedRuntime = (client: NotificationConformanceBackendClient = backend) =>
      createNotificationConformanceRuntime({
        provider: {
          ...host.provider,
          async cancelLocal(input) {
            batches.push(input.keys);
            if (input.keys.includes('a')) {
              throw new Error('the host cannot cancel a');
            }
            await host.provider.cancelLocal?.(input);
          },
        },
        backend: client,
        catalog: [daily, chest],
        clock,
        timeZone: 'Asia/Seoul',
        defaultLocale: 'ko',
        storage,
        ...(entry === undefined ? {} : { registryEntry: entry }),
      });
    const updated = updatedRuntime();
    await updated.start();
    await expect(updated.runUntilIdle()).rejects.toThrow(/the host cannot cancel a/u);
    // The second sweep ran without trying `a` again.
    expect(batches).toEqual([['a'], ['b']]);
    expect(host.localPending.map((pending) => pending.key)).toEqual(['a', 'c']);
    // When the second sweep fails too, both errors surface, the first sweep's first.
    updated.stop();
    host.restart();
    const offline = updatedRuntime({
      ...backend,
      async listConsent() {
        throw new Error('backend down');
      },
    });
    await offline.start();
    const failure: unknown = await offline.runUntilIdle().then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors.map((error: unknown) => String(error))).toEqual([
      'Error: the host cannot cancel a',
      'Error: backend down',
    ]);
    expect(host.localPending.map((pending) => pending.key)).toEqual(['a', 'c']);
  });

  it('cancels the reminders it scheduled when the provider cannot list them', async () => {
    const { host, backend, createRuntime } = setup(osProfile);
    const { listLocal: _listLocal, ...unlisted } = host.provider;
    const runtime = createRuntime(unlisted);
    backend.authenticate('p-1');
    host.queuePrompt('granted');
    await runtime.requestPermission({ topics: ['energy-full'], gesture: true });
    await runtime.setTopicPreference({ topic: 'energy-full', enabled: true });
    await runtime.reminders.set({ key: 'a', topic: 'energy-full', fireAt: '2026-10-12T06:00:00Z' });
    await runtime.setTopicPreference({ topic: 'energy-full', enabled: false });
    expect(host.localPending).toEqual([]);
  });

  it('records a withdrawal before cancelling, even when cancelling fails', async () => {
    const { host, backend, createRuntime } = setup(osProfile);
    const runtime = createRuntime({
      ...host.provider,
      async listLocal() {
        throw new Error('list failed');
      },
    });
    backend.authenticate('p-1');
    await expect(runtime.setTopicPreference({ topic: 'energy-full', enabled: false }))
      .rejects.toThrow(/list failed/u);
    expect(backend.consent.map((record) => [record.kind, record.state])).toEqual([
      ['topic-preference', 'withdrawn'],
    ]);
  });

  it('cancels a local reminder that was being set when the topic was turned off', async () => {
    const { host, backend, createRuntime } = setup(osProfile);
    let paused = false;
    let release: (() => void) | undefined;
    let reached: (() => void) | undefined;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const runtime = createRuntime({
      ...host.provider,
      async getPermission(input) {
        if (paused) {
          reached?.();
          await hold;
        }
        return host.provider.getPermission(input);
      },
    });
    backend.authenticate('p-1');
    host.queuePrompt('granted');
    await runtime.requestPermission({ topics: ['energy-full'], gesture: true });
    await runtime.setTopicPreference({ topic: 'energy-full', enabled: true });
    paused = true;
    // The reminder reads consent (still granted), then waits on the permission read...
    const setting = runtime.reminders.set({ key: 'a', topic: 'energy-full', fireAt: '2026-10-12T06:00:00Z' });
    await waiting;
    // ...while the topic is turned off, so it schedules on the old answer.
    const turningOff = runtime.setTopicPreference({ topic: 'energy-full', enabled: false });
    release?.();
    expect(await setting).toEqual({ route: 'local', status: 'scheduled' });
    await turningOff;
    expect(host.localPending).toEqual([]);
  });

  it('reads local quiet hours in the deployment zone when the registered zone is unknown', async () => {
    const quiet = { ...energy, quietHours: { start: '13:00', end: '16:00' } };
    const { host, backend, createRuntime } = setup(osProfile, [quiet]);
    const runtime = createRuntime({
      ...host.provider,
      async register() {
        const registration = await host.provider.register?.();
        return registration === null || registration === undefined
          ? null
          : { ...registration, timeZone: 'Mars/Olympus_Mons' };
      },
    });
    backend.authenticate('p-1');
    host.issueEndpoint({ kind: 'fcm-token', value: 'tok-1' });
    host.queuePrompt('granted');
    await runtime.requestPermission({ topics: ['energy-full'], gesture: true });
    await runtime.setTopicPreference({ topic: 'energy-full', enabled: true });
    // 14:00 KST is inside the topic's quiet hours in the deployment zone.
    expect(await runtime.reminders.set({ key: 'e', topic: 'energy-full', fireAt: '2026-10-12T05:00:00Z' }))
      .toEqual({ route: 'local', status: 'scheduled' });
    expect(host.localPending).toEqual([{ key: 'e', topic: 'energy-full', fireAt: '2026-10-12T07:00:00Z' }]);
  });

  it('cancels local reminders when a permission-changed event reports a revocation', async () => {
    const { host, backend, createRuntime } = setup(osProfile);
    const relay = relayed(host.provider);
    const runtime = createRuntime(relay.provider);
    await runtime.start();
    backend.authenticate('p-1');
    host.queuePrompt('granted');
    await runtime.requestPermission({ topics: ['energy-full'], gesture: true });
    await runtime.setTopicPreference({ topic: 'energy-full', enabled: true });
    await runtime.reminders.set({ key: 'a', topic: 'energy-full', fireAt: '2026-10-12T06:00:00Z' });
    expect(host.localPending).toHaveLength(1);
    relay.emit({ type: 'permission-changed', snapshot: { app: 'blocked', topics: {} } });
    await runtime.runUntilIdle();
    expect(host.localPending).toEqual([]);
  });
});

describe('notifications reference runtime and fakes: attribution, failures, and bounds', () => {
  it('records a player action only for an authenticated player', async () => {
    const { backend, runtime } = setup(osProfile, [energy, weekend], { deployment: kr });
    await runtime.start();
    await expect(runtime.setTopicPreference({ topic: 'energy-full', enabled: true }))
      .rejects.toMatchObject({ code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE' });
    await expect(runtime.setAdvertisingConsent({ advertising: 'granted', textVersion: 'ad-v1' }))
      .rejects.toMatchObject({ code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE' });
    // Nothing waits to be written for whoever signs in next.
    backend.authenticate('someone-else');
    await runtime.runUntilIdle();
    expect(backend.consent).toEqual([]);
  });

  it('records an answer for the player who opened the prompt, even after an account switch', async () => {
    const agreement = { ...energy, mapping: { templateSetCode: 'energy', agreement: 'required' } };
    const { host, backend, createRuntime } = setup(hostProfile, [agreement]);
    let release: (() => void) | undefined;
    const sheetOpen = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runtime = createRuntime({
      ...host.provider,
      async requestPermission(input) {
        await sheetOpen;
        return host.provider.requestPermission(input);
      },
    });
    await runtime.start();
    backend.authenticate('p-1');
    host.queuePrompt('granted');
    const asking = runtime.requestPermission({ topics: ['energy-full'], gesture: true });
    // Another player signs in while the agreement sheet is open.
    backend.authenticate('p-2');
    release?.();
    expect(await asking).toMatchObject({ outcomes: { 'energy-full': 'granted' } });
    await runtime.runUntilIdle();
    expect(backend.consent).toEqual([]);
    backend.authenticate('p-1');
    await runtime.runUntilIdle();
    expect(backend.consent.map((record) => [record.player, record.kind, record.state])).toEqual([
      ['p-1', 'host-agreement', 'granted'],
      ['p-1', 'topic-preference', 'granted'],
    ]);
  });

  it('retries a host read that fails with any error class and keeps the waiting send', async () => {
    const clock = createNotificationConformanceClock(now);
    let failing = false;
    const backend = createNotificationConformanceBackend({
      entry: notificationConformanceRegistryEntry({
        provider: optInProfile.provider,
        capabilities: optInProfile.capabilities,
      }),
      catalog: [duel],
      clock,
      defaultLocale: 'ko',
      defaultPlayer: 'p-1',
      readServerPermission: () => {
        if (failing) {
          throw new TypeError('fetch failed');
        }
        return 'granted';
      },
    });
    backend.authenticate('p-1');
    backend.queueProviderResult({ status: 'rate-limited' });
    const send = { topic: 'rival-challenge', idempotencyKey: 'k' } as const;
    expect(await backend.deliver(send)).toMatchObject({ status: 'deferred' });
    clock.advance(60);
    failing = true;
    await expect(backend.runScheduler()).rejects.toThrow(/could not answer the send-time permission read/u);
    // The waiting send keeps its stored answer, and a new send is retryable.
    expect(await backend.deliver(send)).toMatchObject({ status: 'deferred' });
    await expect(backend.deliver({ ...send, idempotencyKey: 'k-2' }))
      .rejects.toMatchObject({ code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE', retryable: true });
    failing = false;
    await backend.runScheduler();
    expect(await backend.deliver(send)).toEqual({ status: 'delivered', alreadyProcessed: true });
  });

  it('keeps the notices of records written in one call apart, and records a notice only while listed', async () => {
    const { clock, host, backend, runtime } = setup(osProfile, [weekend, noticeTopic], {
      deployment: { ...kr, noticeTopic: 'consent-notice' },
    });
    await runtime.start();
    backend.authenticate('p-1');
    host.issueEndpoint({ kind: 'fcm-token', value: 'tok-1' });
    host.queuePrompt('granted');
    await runtime.requestPermission({ topics: ['consent-notice'], gesture: true });
    await runtime.setAdvertisingConsent({ advertising: 'granted', night: 'granted', textVersion: 'ad-v1' });
    // Each record has its own time, and each notice names its record's kind too.
    expect(backend.consent.map((record) => record.at)).toEqual([now, '2026-10-12T03:00:00.001Z']);
    const advertisingResult = {
      kind: 'consent-result',
      record: { kind: 'advertising', at: now },
      dueBy: '2026-10-26',
    } as const;
    await runtime.notices.recordShown(advertisingResult);
    // A retried call records nothing more, and neither does a name whose
    // record time was cut to seconds: it matches no listed notice.
    await runtime.notices.recordShown(advertisingResult);
    await runtime.notices.recordShown({ ...advertisingResult, record: { kind: 'night', at: now } });
    expect(backend.noticesGiven).toHaveLength(1);
    expect((await runtime.notices.list()).map((notice) => [notice.kind, notice.record.kind, notice.dueBy]))
      .toEqual([['consent-result', 'night', '2026-10-26']]);
    clock.set('2026-10-18T15:00:00Z');
    await backend.runScheduler();
    expect(backend.providerCalls.map((call) => call.sendKey))
      .toEqual(['notice:p-1:consent-result:night:2026-10-12T03:00:00.001Z:2026-10-26']);
  });

  it('fails a notice the notice topic cannot render once, and leaves it owed in the game', async () => {
    const broken = { ...noticeTopic, copy: { ko: { title: '안내', body: '{{playerName}}님, {{consentDate}}' } } };
    const { clock, host, backend, runtime } = setup(osProfile, [weekend, broken], {
      deployment: { ...kr, noticeTopic: 'consent-notice' },
    });
    await runtime.start();
    backend.authenticate('p-1');
    host.issueEndpoint({ kind: 'fcm-token', value: 'tok-1' });
    host.queuePrompt('granted');
    await runtime.requestPermission({ topics: ['consent-notice'], gesture: true });
    await runtime.setAdvertisingConsent({ advertising: 'granted', textVersion: 'ad-v1' });
    clock.set('2026-10-19T03:00:00Z');
    await expect(backend.runScheduler()).rejects.toThrow(/could not process 1 item/u);
    await expect(backend.runScheduler()).resolves.toBeUndefined();
    expect(backend.providerCalls).toEqual([]);
    expect(await runtime.notices.list()).toContainEqual(expect.objectContaining({ kind: 'consent-result' }));
  });

  it('starts and answers reads while the backend is down', async () => {
    const { host, backend, createRuntime } = setup(osProfile);
    backend.authenticate('p-1');
    const healthy = createRuntime();
    host.queuePrompt('granted');
    await healthy.requestPermission({ topics: ['energy-full'], gesture: true });
    await healthy.setTopicPreference({ topic: 'energy-full', enabled: true });
    await healthy.reminders.set({ key: 'a', topic: 'energy-full', fireAt: '2026-10-12T06:00:00Z' });
    const down = createRuntime(host.provider, {
      ...backend,
      async listConsent() {
        throw new Error('backend down');
      },
    });
    await expect(down.start()).resolves.toBeUndefined();
    expect(await down.getPermission({ topics: ['energy-full'] })).toMatchObject({ app: 'granted' });
    await expect(down.runUntilIdle()).rejects.toThrow(/backend down/u);
    expect(host.localPending).toHaveLength(1);
  });

  it('drops a record the backend would refuse, so later records are still written', async () => {
    const { host, backend, createRuntime } = setup(hostProfile, [challenge]);
    const runtime = createRuntime({
      ...host.provider,
      async requestPermission(input) {
        const result = await host.provider.requestPermission(input);
        // A provider bug: evidence whose payload is not flat.
        return { ...result, evidence: { schema: 'broken', payload: { nested: { a: 1 } } } as never };
      },
    });
    backend.authenticate('p-1');
    host.queuePrompt('granted');
    expect(await runtime.requestPermission({ topics: ['rival-challenge'], gesture: true }))
      .toMatchObject({ outcomes: { 'rival-challenge': 'granted' } });
    await expect(runtime.runUntilIdle()).rejects.toThrow();
    await runtime.setTopicPreference({ topic: 'rival-challenge', enabled: false });
    expect(backend.consent.map((record) => [record.kind, record.state])).toEqual([
      ['topic-preference', 'withdrawn'],
    ]);
  });

  it('never defers a rate-limited send past a day after the first answer', async () => {
    const { clock, backend } = await devicePlayer();
    backend.queueProviderResult({ status: 'rate-limited', retryAfterSeconds: 3600 });
    await backend.deliver({ topic: 'rival-challenge', idempotencyKey: 'c-1' });
    for (let run = 0; run < 8; run += 1) {
      const latest = backend.deliveries.at(-1);
      if (latest?.status !== 'deferred') {
        break;
      }
      clock.set(latest.until);
      backend.queueProviderResult({ status: 'rate-limited' });
      await backend.runScheduler();
    }
    expect(backend.deliveries.map((delivery) =>
      delivery.status === 'deferred'
        ? delivery.until
        : `${delivery.status}: ${'reason' in delivery ? delivery.reason : ''}`))
      .toEqual([
        '2026-10-12T04:00:00Z',
        '2026-10-12T06:00:00Z',
        '2026-10-12T10:00:00Z',
        '2026-10-12T18:00:00Z',
        '2026-10-13T03:00:00Z',
        'unavailable: provider-rate-limited',
      ]);
  });

  it('refuses deployment settings with an unknown zone', () => {
    expect(() => createNotificationConformanceBackend({
      entry: undefined,
      catalog: [],
      clock: createNotificationConformanceClock(now),
      deployment: { timeZone: 'Mars/Olympus_Mons' },
      defaultLocale: 'ko',
      defaultPlayer: 'p-1',
    })).toThrow(/Unknown time zone/u);
  });

  it('keeps a cold-start open when more events arrive than the buffer holds', async () => {
    const { host, runtime } = setup(osProfile);
    host.tap({ channel: 'remote', route: '/?entry=cold' });
    await runtime.start();
    for (let index = 0; index < 70; index += 1) {
      host.issueEndpoint({ kind: 'fcm-token', value: `tok-${index}` });
    }
    const events: NotificationEvent[] = [];
    runtime.subscribe((event) => events.push(event));
    expect(events).toHaveLength(64);
    expect(events[0]).toMatchObject({ type: 'opened', source: 'cold', route: '/?entry=cold' });
    expect(events.at(-1)).toMatchObject({ type: 'endpoint-changed' });
  });

  it("sends a platform user's changed zone that the provider announces", async () => {
    const quietDuel = { ...duel, quietHours: { start: '22:00', end: '08:00' } };
    const { host, backend, createRuntime } = setup(optInProfile, [quietDuel]);
    const relay = relayed(host.provider);
    const runtime = createRuntime(relay.provider);
    await runtime.start();
    backend.authenticate('p-1');
    host.queuePrompt('granted');
    await runtime.requestPermission({ topics: ['rival-challenge'], gesture: true });
    await runtime.runUntilIdle();
    // 12:00 in Seoul: no quiet hours.
    expect((await backend.deliver({ topic: 'rival-challenge', idempotencyKey: 'seoul' })).status)
      .toBe('delivered');
    relay.emit({
      type: 'endpoint-changed',
      registration: {
        provider: optInProfile.provider,
        address: { kind: 'platform-user' },
        timeZone: 'America/New_York',
      },
    });
    await runtime.runUntilIdle();
    // 23:00 in New York: the quiet hours hold the send there.
    expect(await backend.deliver({ topic: 'rival-challenge', idempotencyKey: 'new-york' }))
      .toMatchObject({ status: 'deferred', reason: 'quiet-hours' });
  });
});

describe('notifications reference runtime and fakes: series and ownership', () => {
  it('does not send a notice again that the game gave while its push waited', async () => {
    const { clock, host, backend, runtime } = setup(osProfile, [weekend, noticeTopic], {
      deployment: { ...kr, noticeTopic: 'consent-notice' },
    });
    await runtime.start();
    backend.authenticate('p-1');
    host.issueEndpoint({ kind: 'fcm-token', value: 'tok-1' });
    host.queuePrompt('granted');
    await runtime.requestPermission({ topics: ['consent-notice'], gesture: true });
    await runtime.setAdvertisingConsent({ advertising: 'granted', textVersion: 'ad-v1' });
    clock.set('2026-10-19T03:00:00Z');
    backend.queueProviderResult({ status: 'rate-limited', retryAfterSeconds: 3600 });
    await backend.runScheduler();
    expect(backend.deliveries.map((delivery) => delivery.status)).toEqual(['deferred']);
    // The game shows the notice while the push waits.
    await runtime.notices.recordShown({
      kind: 'consent-result',
      record: { kind: 'advertising', at: now },
      dueBy: '2026-10-26',
    });
    clock.advance(3600);
    await backend.runScheduler();
    expect(backend.providerCalls).toHaveLength(1);
    expect(backend.noticesGiven.map((given) => [given.kind, given.channel])).toEqual([
      ['consent-result', 'in-game'],
    ]);
  });

  it('stops showing a turned-off topic before the player signs in', async () => {
    const { host, backend, runtime } = setup(osProfile);
    backend.authenticate('p-1');
    host.queuePrompt('granted');
    await runtime.requestPermission({ topics: ['energy-full'], gesture: true });
    await runtime.setTopicPreference({ topic: 'energy-full', enabled: true });
    await runtime.reminders.set({ key: 'a', topic: 'energy-full', fireAt: '2026-10-12T06:00:00Z' });
    backend.revokeSession();
    await expect(runtime.setTopicPreference({ topic: 'energy-full', enabled: false }))
      .rejects.toMatchObject({ code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE' });
    expect(host.localPending).toEqual([]);
  });

  it('keeps a server reminder with the player who set it', async () => {
    const { host, backend, createRuntime } = setup(hostProfile, [receipt]);
    let release: (() => void) | undefined;
    const reading = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runtime = createRuntime({
      ...host.provider,
      async getCapabilities() {
        await reading;
        return host.provider.getCapabilities();
      },
    });
    backend.authenticate('p-1');
    const setting = runtime.reminders.set({ key: 'r', topic: 'purchase-result', fireAt: now });
    backend.authenticate('p-2');
    release?.();
    await expect(setting).rejects.toMatchObject({ code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE' });
    expect(backend.reminders).toEqual([]);
  });

  it('refuses an advertising server reminder without the deployment rules', async () => {
    const { backend } = await devicePlayer([weekend]);
    await expect(backend.setReminder({ key: 'ad', topic: 'weekend-event', fireAt: now }))
      .rejects.toMatchObject({ code: 'NOTIFICATIONS_INVALID_INPUT' });
    expect(backend.reminders).toEqual([]);
  });

  it('fails, rather than rejects, a vector whose clock cannot start', async () => {
    const vector = vectorNamed('unsupported-target');
    const broken = { ...vector, context: { ...vector.context, now: '2026-02-31T00:00:00Z' } };
    expect(() => assertNotificationConformanceVector(broken)).toThrow(/Invalid ISO-8601/u);
    const result = await runNotificationConformanceVector(broken);
    expect(result).toMatchObject({ status: 'failed', failures: [{ path: 'context.now' }] });
  });
});
