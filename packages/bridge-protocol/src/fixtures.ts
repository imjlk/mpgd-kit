import type { BridgeRequest, BridgeResponse } from './index';

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
