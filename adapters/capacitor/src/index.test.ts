import { describe, expect, it } from 'vitest';

import type { BridgeRequest, BridgeResponse } from '@mpgd/bridge-protocol';

import { createCapacitorPlatformGateway, type NativeBridge } from './index';

describe('adapter-capacitor', () => {
  it('sends typed requests through the native Capacitor bridge', async () => {
    const requests: BridgeRequest[] = [];
    const bridge: NativeBridge = {
      async request(input) {
        requests.push(input);

        return {
          id: input.id,
          ok: true,
          data: {
            status: 'completed',
            transactionId: 'native-transaction-1',
            entitlementIds: ['coins-100'],
          },
        } satisfies BridgeResponse;
      },
    };

    const gateway = createCapacitorPlatformGateway({
      target: 'android',
      appVersion: '1.2.3',
      buildId: 'build-android',
      bridge,
    });

    await expect(
      gateway.commerce.purchase({
        productId: 'COINS_100',
        source: 'shop',
        idempotencyKey: 'purchase-1',
      }),
    ).resolves.toEqual({
      status: 'completed',
      transactionId: 'native-transaction-1',
      entitlementIds: ['coins-100'],
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: 'commerce.purchase',
      payload: {
        productId: 'COINS_100',
        source: 'shop',
        idempotencyKey: 'purchase-1',
      },
      meta: {
        target: 'android',
        appVersion: '1.2.3',
        buildId: 'build-android',
      },
    });
  });

  it('throws native bridge errors as JavaScript errors', async () => {
    const bridge: NativeBridge = {
      async request(input) {
        return {
          id: input.id,
          ok: false,
          error: {
            code: 'STORE_UNAVAILABLE',
            message: 'Store unavailable.',
            retryable: true,
          },
        };
      },
    };

    const gateway = createCapacitorPlatformGateway({
      target: 'ios',
      appVersion: '1.2.3',
      buildId: 'build-ios',
      bridge,
    });

    await expect(gateway.commerce.getProducts()).rejects.toThrow('Store unavailable.');
  });
});
