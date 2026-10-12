import { describe, expect, it } from 'vitest';

import {
  bridgeStorageLoadProtocol,
  type BridgeEvent,
  type BridgeRequest,
  type BridgeResponse,
} from '@mpgd/bridge';
import { createUnsupportedCapabilities, PlatformOperationError } from '@mpgd/platform';
import { createUnsupportedCommerceCapabilities } from '@mpgd/platform/commerce';

import { createCapacitorPlatformGateway, type NativeBridge } from './index';

describe('adapter-capacitor', () => {
  it('accepts a bridge with an optional event subscription without using it', async () => {
    const requests: BridgeRequest[] = [];
    let subscriptions = 0;
    const bridge: NativeBridge = {
      async request(input) {
        requests.push(input);
        return { id: input.id, ok: true, data: [] } satisfies BridgeResponse;
      },
      subscribe(_listener: (event: BridgeEvent) => void) {
        subscriptions += 1;
        return () => undefined;
      },
    };

    const gateway = createCapacitorPlatformGateway({
      target: 'ios',
      appVersion: '1.2.3',
      buildId: 'build-ios',
      bridge,
    });

    await expect(gateway.identity.getPlayer()).resolves.toEqual([]);
    expect(requests.map((request) => request.method)).toEqual(['identity.getPlayer']);
    // The event surface is declared for commerce providers; nothing else subscribes.
    expect(subscriptions).toBe(0);
  });

  it('sends typed requests through the native Capacitor bridge', async () => {
    const requests: BridgeRequest[] = [];
    const bridge: NativeBridge = {
      async request(input) {
        requests.push(input);

        return {
          id: input.id,
          ok: true,
          data: { status: 'unavailable', rewardGranted: false },
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
      gateway.ads.showRewarded({ placementId: 'CONTINUE', idempotencyKey: 'reward-1' }),
    ).resolves.toEqual({ status: 'unavailable', rewardGranted: false });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: 'ads.showRewarded',
      payload: {
        placementId: 'CONTINUE',
        idempotencyKey: 'reward-1',
      },
      meta: {
        target: 'android',
        appVersion: '1.2.3',
        buildId: 'build-android',
      },
    });
  });

  it('distinguishes a stored top-level JSON null from a missing native value', async () => {
    const bridge: NativeBridge = {
      async request(input) {
        if (input.method === 'storage.load') {
          const payload = input.payload as { readonly key?: string };
          return {
            id: input.id,
            ok: true,
            data:
              payload.key === 'nullable-save:v1'
                ? { __mpgdBridgeProtocol: bridgeStorageLoadProtocol, found: true, value: null }
                : { __mpgdBridgeProtocol: bridgeStorageLoadProtocol, found: false },
          } satisfies BridgeResponse;
        }

        return {
          id: input.id,
          ok: true,
          data: {},
        } satisfies BridgeResponse;
      },
    };
    const gateway = createCapacitorPlatformGateway({
      target: 'android',
      appVersion: '1.2.3',
      buildId: 'build-android',
      bridge,
    });

    await expect(gateway.storage.load({ key: 'nullable-save:v1' })).resolves.toEqual({
      value: null,
    });
    await expect(gateway.storage.load({ key: 'missing:v1' })).resolves.toBeNull();
  });

  it('preserves native bridge failure codes and retryability', async () => {
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

    await expect(gateway.identity.getPlayer()).rejects.toMatchObject({
      name: 'PlatformOperationError',
      code: 'STORE_UNAVAILABLE',
      message: 'Store unavailable.',
      retryable: true,
    } satisfies Partial<PlatformOperationError>);
  });

  it.each([
    { name: 'mismatched ID', response: { id: 'other', ok: true, data: [] } },
    { name: 'missing success data', response: { ok: true } },
    {
      name: 'malformed error',
      response: { ok: false, error: { code: 'NATIVE_IAP_UNAVAILABLE', message: 'Unavailable.' } },
    },
  ])('rejects a $name rather than trusting malformed native data', async ({ response }) => {
    const bridge: NativeBridge = {
      async request(input) {
        return { id: input.id, ...response } as BridgeResponse;
      },
    };
    const gateway = createCapacitorPlatformGateway({
      target: 'android',
      appVersion: '1.2.3',
      buildId: 'build-android',
      bridge,
    });

    await expect(gateway.identity.getPlayer()).rejects.toMatchObject({
      name: 'PlatformOperationError',
      code: 'NATIVE_BRIDGE_INVALID_RESPONSE',
      retryable: false,
    });
  });

  it('reports the unsupported commerce block and no commerce provider without one', async () => {
    const requests: BridgeRequest[] = [];
    const gateway = createCapacitorPlatformGateway({
      target: 'android',
      appVersion: '1.2.3',
      buildId: 'build-android',
      bridge: {
        async request(input) {
          requests.push(input);
          return { id: input.id, ok: true, data: createUnsupportedCapabilities() };
        },
      },
    });

    expect(gateway.commerce).toBeUndefined();
    expect('commerce' in gateway).toBe(false);
    const capabilities = await gateway.getCapabilities();
    expect(capabilities.commerce).toEqual(createUnsupportedCommerceCapabilities());
    // Every read is a fresh object.
    expect((await gateway.getCapabilities()).commerce).not.toBe(capabilities.commerce);
    expect(requests.every((request) => request.method === 'runtime.getCapabilities')).toBe(true);
  });

  it('strips retired boolean flags and replaces a missing or invalid native commerce block', async () => {
    const natives: readonly unknown[] = [
      null,
      { ...createUnsupportedCapabilities(), nativeIap: true, subscriptionIap: true },
      {
        ...createUnsupportedCapabilities(),
        nativeIap: true,
        commerce: { availability: 'available', purchase: { consumable: 'yes' } },
      },
      Object.fromEntries(
        Object.entries(createUnsupportedCapabilities()).filter(([key]) => key !== 'commerce'),
      ),
    ];
    for (const native of natives) {
      const gateway = createCapacitorPlatformGateway({
        target: 'ios',
        appVersion: '1.2.3',
        buildId: 'build-ios',
        bridge: {
          async request(input) {
            return { id: input.id, ok: true, data: native } satisfies BridgeResponse;
          },
        },
      });

      const capabilities = await gateway.getCapabilities();
      expect(Object.hasOwn(capabilities, 'nativeIap')).toBe(false);
      expect(Object.hasOwn(capabilities, 'subscriptionIap')).toBe(false);
      expect(Object.hasOwn(capabilities.providerAvailability ?? {}, 'nativeIap')).toBe(false);
      expect(capabilities.commerce).toEqual(createUnsupportedCommerceCapabilities());
    }
  });

  it('exposes no v1 commerce surface or renamed gateway property', async () => {
    const requests: BridgeRequest[] = [];
    const gateway = createCapacitorPlatformGateway({
      target: 'android',
      appVersion: '1.2.3',
      buildId: 'build-android',
      bridge: {
        async request(input) {
          requests.push(input);
          return { id: input.id, ok: true, data: null };
        },
      },
    });

    // The gateway has no v1 commerce surface: the retired names are not reachable.
    expect(Object.keys(gateway)).not.toContain('commerceV2');
    expect(gateway.commerce).toBeUndefined();
    expect(requests).toEqual([]);
  });

  it('delegates shared launch, identity, share, and notification flows', async () => {
    const methods: string[] = [];
    const bridge: NativeBridge = {
      async request(input) {
        methods.push(input.method);

        const dataByMethod: Partial<Record<typeof input.method, unknown>> = {
          'identity.getSession': {
            identityLevel: 'platform-anonymous',
            playerId: 'android-local-player',
            trustLevel: 'local',
          },
          'presentation.getLaunchIntent': { entry: 'home' },
          'presentation.requestGameSurface': 'already-fullscreen',
          'share.share': { status: 'unavailable' },
          'share.readInboundShare': null,
          'notifications.getStatus': 'configuration-required',
          'notifications.requestSubscription': 'unavailable',
        };

        return {
          id: input.id,
          ok: true,
          data: dataByMethod[input.method],
        } satisfies BridgeResponse;
      },
    };
    const gateway = createCapacitorPlatformGateway({
      target: 'android',
      appVersion: '1.2.3',
      buildId: 'build-android',
      bridge,
    });

    await expect(gateway.identity.getSession?.()).resolves.toMatchObject({
      identityLevel: 'platform-anonymous',
      trustLevel: 'local',
    });
    await expect(gateway.presentation?.getLaunchIntent()).resolves.toEqual({ entry: 'home' });
    await expect(
      gateway.presentation?.requestGameSurface({ entry: 'daily' }),
    ).resolves.toBe('already-fullscreen');
    await expect(
      gateway.sharing?.share?.({
        kind: 'invite',
        title: 'Invite',
        text: 'Play with me',
        deepLink: 'mpgd://invite',
      }),
    ).resolves.toEqual({ status: 'unavailable' });
    await expect(gateway.sharing?.readInboundShare?.()).resolves.toBeNull();
    await expect(gateway.notifications?.getStatus('daily-ready')).resolves.toBe(
      'configuration-required',
    );
    await expect(
      gateway.notifications?.requestSubscription('daily-ready'),
    ).resolves.toBe('unavailable');
    expect(methods).toEqual([
      'identity.getSession',
      'presentation.getLaunchIntent',
      'presentation.requestGameSurface',
      'share.share',
      'share.readInboundShare',
      'notifications.getStatus',
      'notifications.requestSubscription',
    ]);
  });
});
