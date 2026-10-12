import { describe, expect, it } from 'vitest';

import { PlatformOperationError, readPlatformOperationFailure } from './index.js';
import {
  assertLocalNotificationRequest,
  assertLocalScheduleResult,
  assertNotificationBridgeCancelLocalResult,
  assertNotificationBridgeGetCapabilitiesPayload,
  assertNotificationBridgeGetCapabilitiesResult,
  assertNotificationBridgeListLocalResult,
  assertNotificationBridgeOpenSettingsResult,
  assertNotificationBridgeRegisterResult,
  assertNotificationBridgeRequestPermissionPayload,
  assertNotificationBridgeRevokePermissionPayload,
  assertNotificationCapabilities,
  assertNotificationConsentRecord,
  assertNotificationDeliveryProviderEntry,
  assertNotificationDeployment,
  assertNotificationEndpointRegistration,
  assertNotificationEvent,
  assertNotificationEventEnvelope,
  assertNotificationNotice,
  assertNotificationPermissionResult,
  assertNotificationPermissionSnapshot,
  assertNotificationTopicDefinition,
  createUnsupportedNotificationCapabilities,
  isNotificationCapabilities,
  isNotificationErrorCode,
  isNotificationEvent,
  notificationBridgeMethods,
  NotificationError,
  notificationErrorCodes,
  notificationsProtocol,
  notificationsProtocolVersion,
  referenceNotificationProviders,
  toNotificationSubscriptionAdapter,
  toNotificationSubscriptionResult,
  toNotificationSubscriptionStatus,
  type NotificationCapabilities,
  type NotificationPermissionResult,
  type NotificationPermissionSnapshot,
  type NotificationRuntime,
  type NotificationRuntimePermissionSnapshot,
} from './notifications.js';

const osCapabilities: NotificationCapabilities = {
  availability: 'available',
  permission: {
    scope: 'app',
    prompt: 'os',
    readable: true,
    serverReadable: false,
    allowance: 'persistent',
    userGesture: false,
    settings: true,
  },
  remote: {
    supported: true,
    purposes: ['service', 'requested', 'advertising'],
    addressing: 'device',
    content: 'free-form',
  },
  local: { supported: true, maxPending: 64 },
  open: 'payload',
};

describe('notifications contract', () => {
  it('names the draft protocol and the bridge methods', () => {
    expect(notificationsProtocol).toBe('mpgd.notifications.v2');
    expect(notificationsProtocolVersion).toBe('2.0.0-draft.1');
    expect(notificationBridgeMethods).toEqual([
      'notifications.v2.getCapabilities',
      'notifications.v2.getPermission',
      'notifications.v2.requestPermission',
      'notifications.v2.revokePermission',
      'notifications.v2.register',
      'notifications.v2.scheduleLocal',
      'notifications.v2.cancelLocal',
      'notifications.v2.listLocal',
      'notifications.v2.openSettings',
    ]);
    expect(Object.isFrozen(notificationBridgeMethods)).toBe(true);
  });

  it('validates capabilities strictly and returns a fresh unsupported block', () => {
    expect(assertNotificationCapabilities(osCapabilities)).toEqual(osCapabilities);
    expect(isNotificationCapabilities({ ...osCapabilities, extra: true })).toBe(false);
    expect(isNotificationCapabilities({
      ...osCapabilities,
      permission: { ...osCapabilities.permission, maxTopicsPerPrompt: 0 },
    })).toBe(false);
    expect(isNotificationCapabilities({
      ...osCapabilities,
      remote: { ...osCapabilities.remote, purposes: ['marketing'] },
    })).toBe(false);
    // Local reminders are always inexact: the capability carries no timing.
    expect(isNotificationCapabilities({ ...osCapabilities, local: { supported: true, timing: 'exact' } }))
      .toBe(false);
    // `addressing: 'none'` exactly when remote delivery is not supported.
    for (const remote of [
      { ...osCapabilities.remote, addressing: 'none' },
      { ...osCapabilities.remote, supported: false },
    ] as const) {
      expect(isNotificationCapabilities({ ...osCapabilities, remote })).toBe(false);
      expect(() => assertNotificationCapabilities({ ...osCapabilities, remote }))
        .toThrow(/addressing 'none' exactly when remote.supported is false/u);
    }
    const unsupported = createUnsupportedNotificationCapabilities();
    expect(assertNotificationCapabilities(unsupported).availability).toBe('unsupported');
    expect(createUnsupportedNotificationCapabilities()).not.toBe(unsupported);
    expect(unsupported.remote).toEqual({
      supported: false,
      purposes: [],
      addressing: 'none',
      content: 'free-form',
    });
    expect(unsupported.local).toEqual({ supported: false });
  });

  it('validates every bridge-facing payload and rejects unknown keys', () => {
    const snapshot: NotificationPermissionSnapshot = {
      app: 'action-required',
      topics: { 'energy-full': 'action-required' },
      requiredAction: 'login',
    };
    const result: NotificationPermissionResult = {
      snapshot,
      outcomes: { 'energy-full': 'action-required' },
      requiredAction: 'host-settings',
      evidence: { schema: 'apps-in-toss.notification-agreement.v1', payload: { templateCode: 'x' } },
    };
    expect(assertNotificationPermissionSnapshot(snapshot)).toEqual(snapshot);
    expect(() => assertNotificationPermissionSnapshot({ topics: { a: 'maybe' } })).toThrow();
    expect(() => assertNotificationPermissionSnapshot({ topics: {}, requiredAction: 'reboot' })).toThrow();
    expect(assertNotificationPermissionResult(result)).toEqual(result);
    expect(() => assertNotificationPermissionResult({ ...result, outcomes: { a: 'ok' } })).toThrow();
    const device = { kind: 'fcm-token', value: 'token', environment: 'sandbox', permission: 'granted' } as const;
    expect(assertNotificationEndpointRegistration({
      provider: 'fcm',
      address: device,
      locale: 'ko',
      timeZone: 'Asia/Seoul',
    }).provider).toBe('fcm');
    expect(assertNotificationEndpointRegistration({
      provider: 'devvit',
      address: { kind: 'platform-user' },
      timeZone: 'America/New_York',
    }).address.kind).toBe('platform-user');
    expect(() => assertNotificationEndpointRegistration({
      provider: 'fcm',
      address: { ...device, value: '' },
    })).toThrow();
    // The installation is the authenticated session's, never a registration field.
    expect(() => assertNotificationEndpointRegistration({
      provider: 'fcm',
      address: { ...device, installationId: 'installation-1' },
    })).toThrow();
    const { permission: _permission, ...withoutPermission } = device;
    expect(() => assertNotificationEndpointRegistration({ provider: 'fcm', address: withoutPermission }))
      .toThrow();
    expect(() => assertNotificationEndpointRegistration({
      provider: 'fcm',
      address: { ...device, permission: 'maybe' },
    })).toThrow();
    expect(() => assertNotificationEndpointRegistration({ provider: '', address: { kind: 'platform-user' } }))
      .toThrow();
    // Quiet hours read the zone, so `Intl` must know it.
    expect(() => assertNotificationEndpointRegistration({
      provider: 'devvit',
      address: { kind: 'platform-user' },
      timeZone: 'Mars/Olympus_Mons',
    })).toThrow(/Unknown time zone/u);
    const request = {
      key: 'energy',
      topic: 'energy-full',
      fireAt: '2026-10-12T06:00:00Z',
      title: 'Energy full',
      body: 'Your energy is full.',
      route: '/?entry=continue',
    };
    expect(assertLocalNotificationRequest(request)).toEqual(request);
    expect(() => assertLocalNotificationRequest({ ...request, fireAt: 'later' })).toThrow();
    expect(() => assertLocalNotificationRequest({ ...request, key: '' })).toThrow();
    // The route a local notification opens stays on the game's origin.
    expect(() => assertLocalNotificationRequest({ ...request, route: '/%2e//evil.example/x' }))
      .toThrow(/not root-relative/u);
    expect(() => assertLocalNotificationRequest({ ...request, optOutRoute: '/settings' })).toThrow();
    expect(assertLocalScheduleResult({ status: 'capacity-exceeded' }).status).toBe('capacity-exceeded');
    expect(() => assertLocalScheduleResult({ status: 'queued' })).toThrow();
    expect(assertNotificationBridgeRequestPermissionPayload({ topics: ['a'] })).toEqual({ topics: ['a'] });
    expect(() => assertNotificationBridgeRequestPermissionPayload({ topics: [] })).toThrow();
    expect(assertNotificationBridgeRevokePermissionPayload({ topics: ['a'] })).toEqual({ topics: ['a'] });
    expect(assertNotificationBridgeGetCapabilitiesPayload({ protocol: notificationsProtocol }))
      .toEqual({ protocol: notificationsProtocol });
    expect(() => assertNotificationBridgeGetCapabilitiesPayload({ protocol: 'mpgd.commerce.v2' })).toThrow();
    expect(assertNotificationBridgeGetCapabilitiesResult({
      protocolVersion: notificationsProtocolVersion,
      provider: 'fcm',
      capabilities: osCapabilities,
    }).provider).toBe('fcm');
    expect(assertNotificationBridgeRegisterResult({ registration: null })).toEqual({ registration: null });
    expect(assertNotificationBridgeCancelLocalResult({ cancelled: true })).toEqual({ cancelled: true });
    expect(assertNotificationBridgeListLocalResult({
      pending: [{ key: 'energy', topic: 'energy-full', fireAt: '2026-10-12T06:00:00Z' }],
    }).pending).toHaveLength(1);
    expect(assertNotificationBridgeOpenSettingsResult({ status: 'opened' })).toEqual({ status: 'opened' });
    expect(() => assertNotificationBridgeOpenSettingsResult({ status: 'closed' })).toThrow();
  });

  it('validates events and the bridge event envelope', () => {
    const opened = {
      type: 'opened',
      channel: 'remote',
      source: 'cold',
      topic: 'rival-challenge',
      route: '/?entry=challenge',
      data: { challengeId: 'c-1' },
      referrer: 'push',
    } as const;
    expect(assertNotificationEvent(opened)).toEqual(opened);
    expect(isNotificationEvent({ ...opened, data: { count: 1 } })).toBe(false);
    expect(isNotificationEvent({ type: 'permission-changed', snapshot: { topics: {} } })).toBe(true);
    expect(assertNotificationEventEnvelope({ protocol: notificationsProtocol, sequence: 0, event: opened }).sequence)
      .toBe(0);
    expect(() => assertNotificationEventEnvelope({ protocol: notificationsProtocol, sequence: -1, event: opened }))
      .toThrow();
  });

  it('validates consent records per kind', () => {
    const consent = {
      kind: 'advertising',
      state: 'granted',
      source: 'player',
      at: '2026-10-12T03:00:00Z',
      textVersion: 'ad-consent-v1',
    } as const;
    expect(assertNotificationConsentRecord(consent)).toEqual(consent);
    for (const state of ['prompt', 'unknown', 'action-required', 'unsupported']) {
      expect(() => assertNotificationConsentRecord({ ...consent, state }), state).toThrow();
    }
    expect(() => assertNotificationConsentRecord({ ...consent, at: 'today' })).toThrow();
    const { textVersion: _textVersion, ...withoutText } = consent;
    expect(() => assertNotificationConsentRecord(withoutText)).toThrow();
    const agreement = {
      kind: 'host-agreement',
      topic: 'energy-full',
      state: 'denied',
      source: 'provider',
      at: '2026-10-12T03:00:00Z',
    } as const;
    expect(assertNotificationConsentRecord(agreement)).toEqual(agreement);
    // A provider answers for an agreement, never for device permission; a player
    // revokes device permission, but never writes an agreement.
    expect(() => assertNotificationConsentRecord({ ...agreement, source: 'player' })).toThrow();
    const permission = {
      kind: 'delivery-permission',
      state: 'denied',
      source: 'player',
      at: '2026-10-12T03:00:00Z',
    } as const;
    expect(assertNotificationConsentRecord(permission)).toEqual(permission);
    expect(() => assertNotificationConsentRecord({ ...permission, source: 'provider' })).toThrow();
    expect(() => assertNotificationConsentRecord({ ...permission, topic: 'energy-full' })).toThrow();
    expect(() => assertNotificationConsentRecord({
      kind: 'topic-preference',
      topic: 'energy-full',
      state: 'denied',
      source: 'player',
      at: '2026-10-12T03:00:00Z',
    })).toThrow();
  });

  it('validates notices, registry entries, deployments, and topic definitions', () => {
    const notice = {
      kind: 'reconfirmation',
      record: { kind: 'advertising', state: 'granted', at: '2026-10-12T03:00:00Z', textVersion: 'ad-v1' },
      dueBy: '2028-10-11',
    } as const;
    expect(assertNotificationNotice(notice)).toEqual(notice);
    expect(() => assertNotificationNotice({ ...notice, dueBy: '2028-10-11T00:00:00Z' })).toThrow();
    expect(() => assertNotificationNotice({ ...notice, record: { ...notice.record, kind: 'topic-preference' } }))
      .toThrow();
    const { mapping: _mapping, ...entry } = referenceNotificationProviders['apps-in-toss'];
    expect(assertNotificationDeliveryProviderEntry(entry)).toEqual(entry);
    expect(() => assertNotificationDeliveryProviderEntry({ ...entry, addressing: 'none' })).toThrow();
    expect(() => assertNotificationDeliveryProviderEntry({ ...entry, limits: [{ count: 0, windowSeconds: 60 }] }))
      .toThrow();
    expect(assertNotificationDeployment({
      advertisingRules: 'kr',
      advertisingSender: { contact: '080-1234-5678' },
      noticeTopic: 'consent-notice',
    }).advertisingRules).toBe('kr');
    expect(() => assertNotificationDeployment({ advertisingRules: 'eu' })).toThrow();
    expect(() => assertNotificationDeployment({ timeZone: 'Mars/Olympus_Mons' })).toThrow(/Unknown time zone/u);
    expect(() => assertNotificationDeployment({ advertisingSender: { name: 'Studio' } })).toThrow();
    const topic = {
      id: 'energy-full',
      purpose: 'requested',
      channels: ['local', 'remote'],
      route: '/?entry=continue',
      quietHours: { start: '22:00', end: '08:00' },
      deferrable: false,
    } as const;
    expect(assertNotificationTopicDefinition(topic)).toEqual(topic);
    expect(() => assertNotificationTopicDefinition({ ...topic, quietHours: { start: '7:00', end: '08:00' } }))
      .toThrow();
    expect(() => assertNotificationTopicDefinition({ ...topic, channels: [] })).toThrow();
    expect(() => assertNotificationTopicDefinition({ ...topic, route: '//evil.example' }))
      .toThrow(/root-relative/u);
  });
});

describe('NotificationError', () => {
  it('is a platform operation failure with a normalized code', () => {
    const gesture = new NotificationError('NOTIFICATIONS_USER_GESTURE_REQUIRED');
    expect(gesture).toBeInstanceOf(PlatformOperationError);
    expect(gesture.retryable).toBe(false);
    expect(gesture.message).toBe('Notifications operation failed: NOTIFICATIONS_USER_GESTURE_REQUIRED.');
    expect(readPlatformOperationFailure(gesture)).toEqual({
      code: 'NOTIFICATIONS_USER_GESTURE_REQUIRED',
      retryable: false,
    });
    expect(new NotificationError('NOTIFICATIONS_TEMPORARILY_UNAVAILABLE').retryable).toBe(true);
    expect(new NotificationError('NOTIFICATIONS_V2_UNAVAILABLE').retryable).toBe(false);
    const cause = new Error('host');
    expect(new NotificationError('NOTIFICATIONS_UNSUPPORTED', { cause, message: 'no' }).cause).toBe(cause);
    // The host's own code is kept verbatim.
    const configuration = new NotificationError('NOTIFICATIONS_CONFIGURATION_REQUIRED', { hostCode: '4100' });
    expect(configuration.hostCode).toBe('4100');
    expect(new NotificationError('NOTIFICATIONS_INVALID_INPUT').hostCode).toBeUndefined();
    expect(notificationErrorCodes).toContain('NOTIFICATIONS_INVALID_INPUT');
    expect(notificationErrorCodes).toContain('NOTIFICATIONS_IDEMPOTENCY_CONFLICT');
    expect(notificationErrorCodes.every(isNotificationErrorCode)).toBe(true);
    expect(isNotificationErrorCode('COMMERCE_V2_UNAVAILABLE')).toBe(false);
  });
});

describe('toNotificationSubscriptionAdapter', () => {
  type V1Runtime = Pick<NotificationRuntime, 'getPermission' | 'requestPermission'>;

  function fakeRuntime(options: {
    readonly snapshot?: NotificationRuntimePermissionSnapshot;
    readonly result?: NotificationPermissionResult;
    readonly readError?: unknown;
    readonly requestError?: unknown;
  } = {}): V1Runtime & { readonly requests: { topics: readonly string[]; gesture: boolean }[] } {
    const requests: { topics: readonly string[]; gesture: boolean }[] = [];
    return {
      requests,
      async getPermission() {
        if (options.readError !== undefined) {
          throw options.readError;
        }
        return options.snapshot ?? { app: 'prompt', topics: {}, sources: {} };
      },
      async requestPermission(input) {
        requests.push({ topics: [...input.topics], gesture: input.gesture });
        if (options.requestError !== undefined) {
          throw options.requestError;
        }
        return options.result ?? { snapshot: { app: 'granted', topics: {} }, outcomes: { 'daily-ready': 'granted' } };
      },
    };
  }
  const catalog = [{ id: 'daily-ready' }];

  it('reads the runtime state, records included, as a v1 status', async () => {
    expect(await toNotificationSubscriptionAdapter(fakeRuntime(), catalog).getStatus('daily-ready'))
      .toBe('not-subscribed');
    // An unreadable host answered by a granted record reads subscribed.
    expect(await toNotificationSubscriptionAdapter(
      fakeRuntime({ snapshot: { topics: { 'daily-ready': 'granted' }, sources: { 'daily-ready': 'record' } } }),
      catalog,
    ).getStatus('daily-ready')).toBe('subscribed');
    expect(await toNotificationSubscriptionAdapter(fakeRuntime(), catalog).getStatus('streak-at-risk'))
      .toBe('configuration-required');
    expect(await toNotificationSubscriptionAdapter(
      fakeRuntime({ snapshot: { app: 'unsupported', topics: {}, sources: {} } }),
      catalog,
    ).getStatus('daily-ready')).toBe('unsupported');
    expect(await toNotificationSubscriptionAdapter(
      fakeRuntime({ readError: new NotificationError('NOTIFICATIONS_CONFIGURATION_REQUIRED') }),
      catalog,
    ).getStatus('daily-ready')).toBe('configuration-required');
    await expect(toNotificationSubscriptionAdapter(
      fakeRuntime({ readError: new NotificationError('NOTIFICATIONS_TEMPORARILY_UNAVAILABLE') }),
      catalog,
    ).getStatus('daily-ready')).rejects.toMatchObject({ code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE' });
  });

  it('asks the runtime inside a gesture for declared topics and maps the outcome', async () => {
    const runtime = fakeRuntime();
    expect(await toNotificationSubscriptionAdapter(runtime, catalog).requestSubscription('daily-ready'))
      .toBe('subscribed');
    expect(runtime.requests).toEqual([{ topics: ['daily-ready'], gesture: true }]);
    expect(await toNotificationSubscriptionAdapter(runtime, catalog).requestSubscription('friend-challenge'))
      .toBe('unavailable');
    expect(runtime.requests).toHaveLength(1);
    const denied = fakeRuntime({
      result: { snapshot: { app: 'blocked', topics: {} }, outcomes: { 'daily-ready': 'denied' } },
    });
    expect(await toNotificationSubscriptionAdapter(denied, catalog).requestSubscription('daily-ready'))
      .toBe('rejected');
    const missing = fakeRuntime({ result: { snapshot: { topics: {} }, outcomes: {} } });
    expect(await toNotificationSubscriptionAdapter(missing, catalog).requestSubscription('daily-ready'))
      .toBe('unavailable');
    // Any thrown error answers unavailable.
    const failing = fakeRuntime({ requestError: new NotificationError('NOTIFICATIONS_HOST_VERSION_UNSUPPORTED') });
    expect(await toNotificationSubscriptionAdapter(failing, catalog).requestSubscription('daily-ready'))
      .toBe('unavailable');
  });

  it('maps every v2 state and outcome', () => {
    expect([
      'granted',
      'prompt',
      'prompt-with-rationale',
      'denied',
      'blocked',
      'unknown',
      'action-required',
      'unsupported',
    ].map((state) => toNotificationSubscriptionStatus(state as never))).toEqual([
      'subscribed',
      'not-subscribed',
      'not-subscribed',
      'not-subscribed',
      'not-subscribed',
      'not-subscribed',
      'not-subscribed',
      'unsupported',
    ]);
    expect([
      'granted',
      'already-granted',
      'denied',
      'blocked',
      'dismissed',
      'action-required',
      'unavailable',
      undefined,
    ].map((outcome) => toNotificationSubscriptionResult(outcome as never))).toEqual([
      'subscribed',
      'subscribed',
      'rejected',
      'rejected',
      'unavailable',
      'unavailable',
      'unavailable',
      'unavailable',
    ]);
  });
});
