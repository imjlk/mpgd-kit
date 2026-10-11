import type { StorePurchase } from '@mpgd/platform/commerce';

import type { BridgeEvent, BridgeRequest, BridgeResponse } from './index';

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
] as const satisfies readonly BridgeEvent[];

export const invalidBridgeEvents: readonly unknown[] = [
  { ...validBridgeEvents[0], protocol: 'mpgd.commerce.v1' },
  { ...validBridgeEvents[0], sequence: -1 },
  { ...validBridgeEvents[0], sequence: 1.5 },
  { ...validBridgeEvents[0], event: { type: 'purchaseUpdated' } },
  { ...validBridgeEvents[0], event: { type: 'unknownEvent', purchase: commerceV2Purchase } },
  { ...validBridgeEvents[0], extra: true },
  { protocol: 'mpgd.commerce.v2', sequence: 0 },
  null,
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
