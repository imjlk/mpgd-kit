import type { StorePurchase } from '@mpgd/platform/commerce';
import type { NotificationCapabilities } from '@mpgd/platform/notifications';

import type {
  BridgeEvent,
  BridgeNotificationsV2Method,
  BridgeNotificationsV2Payload,
  BridgeNotificationsV2Result,
  BridgeRequest,
  BridgeResponse,
} from './index';

export const validBridgeRequest: BridgeRequest = {
  id: 'bridge-request-1',
  method: 'runtime.getCapabilities',
  payload: {},
  meta: {
    target: 'android',
    appVersion: '1.0.0',
    buildId: 'build-1',
    sentAt: '2026-07-03T00:00:00.000Z',
  },
};

export const validNewBridgeRequests = [
  createBridgeRequest('identity.getSession'),
  createBridgeRequest('identity.requestUpgrade'),
  createBridgeRequest('presentation.getLaunchIntent'),
  createBridgeRequest('presentation.requestGameSurface'),
  createBridgeRequest('share.share'),
  createBridgeRequest('share.readInboundShare'),
  createBridgeRequest('notifications.getStatus'),
  createBridgeRequest('notifications.requestSubscription'),
] satisfies readonly BridgeRequest[];

const commerceV2Purchase: StorePurchase = {
  store: 'google-play',
  transactionId: 'GPA.0000-0000-0000-00000',
  storeSku: 'coins_100',
  logicalId: 'COINS_100',
  quantity: 1,
  state: 'purchased',
  purchasedAt: '2026-10-11T00:00:00.000Z',
  token: 'play-token-1',
  evidence: {
    schema: 'google-play.product-purchase.v2',
    payload: { purchaseToken: 'play-token-1' },
  },
};

/** One request per commerce v2 method, each carrying its RFC payload shape. */
export const validCommerceV2BridgeRequests = [
  createBridgeRequest('commerce.v2.getCapabilities', { protocol: 'mpgd.commerce.v2' }),
  createBridgeRequest('commerce.v2.fetchProducts', { logicalIds: ['COINS_100'], type: 'in-app' }),
  createBridgeRequest('commerce.v2.requestPurchase', {
    logicalId: 'COINS_100',
    idempotencyKey: 'purchase-1',
    source: 'shop',
  }),
  createBridgeRequest('commerce.v2.getAvailablePurchases', { includePending: true }),
  createBridgeRequest('commerce.v2.finishTransaction', {
    transactionId: commerceV2Purchase.transactionId,
    ledgerEntryId: 'ledger-1',
    isConsumable: true,
  }),
  createBridgeRequest('commerce.v2.restorePurchases', { protocol: 'mpgd.commerce.v2' }),
] satisfies readonly BridgeRequest[];

export const validCommerceV2BridgeResponses = [
  {
    id: 'bridge-request-commerce.v2.requestPurchase',
    ok: true,
    data: { outcome: 'launched' },
  },
  {
    id: 'bridge-request-commerce.v2.getAvailablePurchases',
    ok: true,
    data: { purchases: [commerceV2Purchase] },
  },
  {
    id: 'bridge-request-commerce.v2.finishTransaction',
    ok: true,
    data: { finished: true },
  },
] satisfies readonly BridgeResponse[];

const notificationsV2Capabilities: NotificationCapabilities = {
  availability: 'available',
  permission: {
    scope: 'app',
    prompt: 'os',
    readable: true,
    serverReadable: false,
    allowance: 'persistent',
    userGesture: false,
    promptLimit: 2,
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

const notificationsV2ProtocolPayload = { protocol: 'mpgd.notifications.v2' } as const;

const scheduleLocalPayload = {
  key: 'energy-full',
  topic: 'energy-full',
  fireAt: '2026-10-13T06:00:00+09:00',
  title: 'Energy is full',
  body: 'Come back and play.',
  route: '/?entry=continue',
} as const;

const getCapabilitiesResult = {
  protocolVersion: '2.0.0-draft.1',
  provider: 'fcm',
  capabilities: notificationsV2Capabilities,
} as const;

/** One method's payload and answer. */
export interface NotificationsV2Exchange<TMethod extends BridgeNotificationsV2Method> {
  readonly method: TMethod;
  readonly payload: BridgeNotificationsV2Payload<TMethod>;
  readonly result: BridgeNotificationsV2Result<TMethod>;
}

function exchange<TMethod extends BridgeNotificationsV2Method>(
  method: TMethod,
  payload: BridgeNotificationsV2Payload<TMethod>,
  result: BridgeNotificationsV2Result<TMethod>,
): NotificationsV2Exchange<TMethod> {
  return { method, payload, result };
}

/** One payload and one answer per notifications v2 method, each in its RFC shape. */
export const validNotificationsV2Exchanges = [
  exchange(
    'notifications.v2.getCapabilities',
    notificationsV2ProtocolPayload,
    getCapabilitiesResult,
  ),
  exchange(
    'notifications.v2.getPermission',
    { topics: ['energy-full', 'friend-challenge'] },
    { app: 'granted', topics: { 'energy-full': 'granted', 'friend-challenge': 'granted' } },
  ),
  exchange(
    'notifications.v2.requestPermission',
    { topics: ['energy-full'] },
    {
      snapshot: { app: 'granted', topics: { 'energy-full': 'granted' } },
      outcomes: { 'energy-full': 'granted' },
    },
  ),
  exchange(
    'notifications.v2.revokePermission',
    { topics: ['energy-full'] },
    {
      snapshot: { app: 'denied', topics: { 'energy-full': 'denied' } },
      outcomes: { 'energy-full': 'denied' },
    },
  ),
  exchange('notifications.v2.register', notificationsV2ProtocolPayload, {
    registration: {
      provider: 'fcm',
      address: {
        kind: 'fcm-token',
        value: 'fcm-token-1',
        environment: 'production',
        permission: 'granted',
      },
      locale: 'ko-KR',
      timeZone: 'Asia/Seoul',
    },
  }),
  exchange('notifications.v2.scheduleLocal', scheduleLocalPayload, { status: 'scheduled' }),
  exchange('notifications.v2.cancelLocal', { keys: ['energy-full'] }, { cancelled: true }),
  exchange('notifications.v2.listLocal', notificationsV2ProtocolPayload, {
    pending: [{ key: 'energy-full', topic: 'energy-full', fireAt: '2026-10-13T06:00:00+09:00' }],
  }),
  exchange('notifications.v2.openSettings', notificationsV2ProtocolPayload, { status: 'opened' }),
] as const;

/** A payload of another method's shape, which every other method must reject. */
export const notificationsV2ScheduleLocalPayload = scheduleLocalPayload;

/** Payloads each method's validator rejects. */
export const invalidNotificationsV2Payloads: Readonly<
  Record<BridgeNotificationsV2Method, readonly unknown[]>
> = {
  'notifications.v2.getCapabilities': [
    {},
    null,
    { protocol: 'mpgd.commerce.v2' },
    { protocol: 'mpgd.notifications.v2', provider: 'fcm' },
  ],
  'notifications.v2.getPermission': [
    {},
    { topics: 'energy-full' },
    { topics: [1] },
    { topics: ['energy-full'], gesture: true },
  ],
  // A request or revocation names at least one topic.
  'notifications.v2.requestPermission': [{ topics: [] }, { topic: 'energy-full' }],
  'notifications.v2.revokePermission': [{ topics: [] }, { topics: ['energy-full'], gesture: true }],
  'notifications.v2.register': [{}, { protocol: 'mpgd.notifications.v2', provider: 'fcm' }],
  'notifications.v2.scheduleLocal': [
    // No offset, and a date that does not exist.
    { ...scheduleLocalPayload, fireAt: '2026-10-13T06:00:00' },
    { ...scheduleLocalPayload, fireAt: '2026-02-30T06:00:00Z' },
    { ...scheduleLocalPayload, key: '' },
    // The route an opened reminder hands the game stays on its origin.
    { ...scheduleLocalPayload, route: '//evil.example/x' },
    // Local reminders are inexact; nothing asks for an exact alarm.
    { ...scheduleLocalPayload, exact: true },
  ],
  'notifications.v2.cancelLocal': [{}, { keys: 'energy-full' }, { keys: [''] }],
  'notifications.v2.listLocal': [{}, { protocol: 'mpgd.notifications.v2', topic: 'energy-full' }],
  'notifications.v2.openSettings': [{}, { protocol: 'mpgd.notifications.v1' }],
};

/** Answers each method's validator rejects. */
export const invalidNotificationsV2Results: Readonly<
  Record<BridgeNotificationsV2Method, readonly unknown[]>
> = {
  'notifications.v2.getCapabilities': [
    { ...getCapabilitiesResult, provider: '' },
    // `addressing: 'none'` exactly when remote delivery is unsupported.
    {
      ...getCapabilitiesResult,
      capabilities: {
        ...notificationsV2Capabilities,
        remote: { ...notificationsV2Capabilities.remote, addressing: 'none' },
      },
    },
    {
      ...getCapabilitiesResult,
      capabilities: { ...notificationsV2Capabilities, local: { supported: true, timing: 'exact' } },
    },
  ],
  'notifications.v2.getPermission': [{ topics: { 'energy-full': 'maybe' } }, { app: 'granted' }],
  'notifications.v2.requestPermission': [
    { snapshot: { topics: {} }, outcomes: { 'energy-full': 'ok' } },
    { outcomes: {} },
  ],
  'notifications.v2.revokePermission': [
    { snapshot: { topics: {} }, outcomes: {}, requiredAction: 'reboot' },
  ],
  'notifications.v2.register': [
    {},
    { registration: { provider: '', address: { kind: 'platform-user' } } },
    // The installation is the authenticated session's, never a registration field.
    {
      registration: {
        provider: 'fcm',
        address: {
          kind: 'fcm-token',
          value: 'fcm-token-1',
          permission: 'granted',
          installationId: 'installation-1',
        },
      },
    },
    // Quiet hours read the zone, so `Intl` must know it.
    {
      registration: {
        provider: 'devvit',
        address: { kind: 'platform-user' },
        timeZone: 'Mars/Olympus_Mons',
      },
    },
  ],
  'notifications.v2.scheduleLocal': [{ status: 'queued' }, { status: 'scheduled', key: 'energy' }],
  'notifications.v2.cancelLocal': [{}, { cancelled: 'yes' }],
  'notifications.v2.listLocal': [
    { pending: [{ key: 'energy-full', topic: 'energy-full', fireAt: '2026-02-30T06:00:00Z' }] },
    { pending: [{ key: 'energy-full', topic: 'energy-full', fireAt: '2026-10-13T06:00:00' }] },
  ],
  'notifications.v2.openSettings': [{ status: 'closed' }, 'opened'],
};

/** One request per notifications v2 method, each carrying its RFC payload shape. */
export const validNotificationsV2BridgeRequests: readonly BridgeRequest[] =
  validNotificationsV2Exchanges.map(({ method, payload }) => createBridgeRequest(method, payload));

export const validBridgeEvents = [
  {
    protocol: 'mpgd.commerce.v2',
    sequence: 0,
    event: { type: 'purchaseUpdated', purchase: commerceV2Purchase },
  },
  {
    protocol: 'mpgd.commerce.v2',
    sequence: 1,
    event: {
      type: 'purchaseError',
      logicalId: 'COINS_100',
      error: { code: 'USER_CANCELLED', retryable: false, storeCode: 'USER_CANCELED' },
    },
  },
  {
    protocol: 'mpgd.commerce.v2',
    sequence: 2,
    event: {
      type: 'subscriptionUpdated',
      subscription: {
        store: 'google-play',
        logicalId: 'membership_plus',
        subscriptionId: 'GPA.0000-0000-0000-00001',
        periodIndex: 0,
        state: 'active',
        startedAt: '2026-10-11T00:00:00.000Z',
        expiresAt: '2026-11-11T00:00:00.000Z',
        autoRenew: true,
      },
    },
  },
  // Notifications v2 events share the channel and count their own sequence.
  {
    protocol: 'mpgd.notifications.v2',
    sequence: 0,
    event: {
      type: 'opened',
      channel: 'remote',
      source: 'cold',
      topic: 'friend-challenge',
      route: '/?entry=friend-challenge',
      data: { challengeId: 'challenge-1' },
      referrer: 'push',
    },
  },
  {
    protocol: 'mpgd.notifications.v2',
    sequence: 1,
    event: { type: 'received', channel: 'local', topic: 'energy-full' },
  },
  {
    protocol: 'mpgd.notifications.v2',
    sequence: 2,
    event: {
      type: 'endpoint-changed',
      registration: {
        provider: 'fcm',
        address: { kind: 'fcm-token', value: 'fcm-token-2', permission: 'granted' },
      },
    },
  },
  {
    protocol: 'mpgd.notifications.v2',
    sequence: 3,
    event: {
      type: 'permission-changed',
      snapshot: { app: 'blocked', topics: { 'energy-full': 'blocked' } },
    },
  },
] as const satisfies readonly BridgeEvent[];

const notificationsV2Opened = validBridgeEvents[3];

export const invalidBridgeEvents: readonly unknown[] = [
  { ...validBridgeEvents[0], protocol: 'mpgd.commerce.v1' },
  { ...validBridgeEvents[0], sequence: -1 },
  { ...validBridgeEvents[0], sequence: 1.5 },
  { ...validBridgeEvents[0], event: { type: 'purchaseUpdated' } },
  { ...validBridgeEvents[0], event: { type: 'unknownEvent', purchase: commerceV2Purchase } },
  { ...validBridgeEvents[0], extra: true },
  { protocol: 'mpgd.commerce.v2', sequence: 0 },
  null,
  // The protocol decides the event shape: neither stream carries the other's events.
  { ...validBridgeEvents[0], protocol: 'mpgd.notifications.v2' },
  { ...notificationsV2Opened, protocol: 'mpgd.commerce.v2' },
  { ...notificationsV2Opened, protocol: 'mpgd.notifications.v1' },
  { ...notificationsV2Opened, sequence: -1 },
  { ...notificationsV2Opened, sequence: 0.5 },
  { ...notificationsV2Opened, extra: true },
  { protocol: 'mpgd.notifications.v2', sequence: 0 },
  // Opened data is routing text only.
  { ...notificationsV2Opened, event: { ...notificationsV2Opened.event, data: { count: 1 } } },
  { ...notificationsV2Opened, event: { type: 'dismissed', channel: 'remote' } },
];

export const validBridgeOkResponse: BridgeResponse<{ readonly nativeAds: boolean }> = {
  id: validBridgeRequest.id,
  ok: true,
  data: {
    nativeAds: true,
  },
};

export const validBridgeErrorResponse: BridgeResponse = {
  id: validBridgeRequest.id,
  ok: false,
  error: {
    code: 'UNSUPPORTED_METHOD',
    message: 'Unsupported bridge method.',
    retryable: false,
  },
};

export const invalidBridgeRequests: readonly unknown[] = [
  {
    ...validBridgeRequest,
    id: 42,
  },
  {
    ...validBridgeRequest,
    method: 'unknown.method',
  },
  {
    ...validBridgeRequest,
    meta: {
      ...validBridgeRequest.meta,
      sentAt: 42,
    },
  },
];

function createBridgeRequest(method: BridgeRequest['method'], payload: unknown = {}): BridgeRequest {
  return {
    ...validBridgeRequest,
    id: `bridge-request-${method}`,
    method,
    payload,
  };
}
