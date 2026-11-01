import { describe, expect, it, vi } from 'vitest';

import type { BridgeRequest, BridgeResponse } from '@mpgd/bridge';

import type { AitAnalyticsSdk } from './analytics';
import { createAitHostBridge, type AitHostDependencies } from './host';
import { createAitPlatformGateway, createAitSandboxBridge, type GamePlatformBridge } from './index';
import { Analytics as localAnalytics } from './local-mock';

function createSdk(implementations: Partial<AitAnalyticsSdk> = {}) {
  return {
    screen: vi.fn<AitAnalyticsSdk['screen']>(implementations.screen ?? (async () => {})),
    click: vi.fn<AitAnalyticsSdk['click']>(implementations.click ?? (async () => {})),
    impression: vi.fn<AitAnalyticsSdk['impression']>(implementations.impression ?? (async () => {})),
    log: vi.fn<AitAnalyticsSdk['log']>(implementations.log ?? (async () => {})),
  };
}

/** A host bridge whose Toss app is 5.208.0 or later (`modern`) or older. */
function createGateway(sdk: AitAnalyticsSdk, input: { readonly modern: boolean }) {
  const isMinVersionSupported = vi.fn<AitHostDependencies['isMinVersionSupported']>((versions) =>
    versions.android === '5.208.0' && versions.ios === '5.208.0' ? input.modern : true,
  );
  const bridge = createAitHostBridge({ dependencies: { analytics: sdk, isMinVersionSupported } });
  return createAitPlatformGateway({ appVersion: '1.0.0', buildId: 'test', bridge });
}

function hostAnswering(answer: (input: BridgeRequest) => BridgeResponse): GamePlatformBridge {
  return {
    async request(input) {
      return answer(input);
    },
  };
}

describe('Apps in Toss platform analytics', () => {
  it('sends screens through Analytics.screen and other types through Analytics.log on 5.208.0+', async () => {
    const sdk = createSdk();
    const gateway = createGateway(sdk, { modern: true });
    const analytics = gateway.analytics;
    if (analytics === undefined) {
      throw new Error('The AIT gateway must expose analytics.');
    }

    await expect(analytics.getStatus()).resolves.toEqual({
      provider: 'apps-in-toss',
      state: 'available',
      logTypes: ['screen', 'event', 'click', 'impression'],
    });
    await expect(analytics.log({ logName: 'nem_home_screen', logType: 'screen', params: { screen: 'home' } }))
      .resolves.toBe(true);
    await expect(analytics.log({ logName: 'nem_play_clear', logType: 'event', params: { kind: 'daily', stage: 3 } }))
      .resolves.toBe(true);
    await expect(analytics.log({ logName: 'nem_shop_button', logType: 'click' })).resolves.toBe(true);
    await expect(analytics.log({ logName: 'nem_shop_banner', logType: 'impression' })).resolves.toBe(true);

    expect(sdk.screen).toHaveBeenCalledExactlyOnceWith({ log_name: 'nem_home_screen', screen: 'home' });
    expect(sdk.log.mock.calls).toEqual([
      [{ log_name: 'nem_play_clear', log_type: 'event', params: { kind: 'daily', stage: 3 } }],
      [{ log_name: 'nem_shop_button', log_type: 'click', params: {} }],
      [{ log_name: 'nem_shop_banner', log_type: 'impression', params: {} }],
    ]);
    expect(sdk.click).not.toHaveBeenCalled();
    expect(sdk.impression).not.toHaveBeenCalled();
  });

  it('falls back to the legacy loggers before 5.208.0 and drops events', async () => {
    const sdk = createSdk();
    const analytics = createGateway(sdk, { modern: false }).analytics;

    await expect(analytics?.getStatus()).resolves.toEqual({
      provider: 'apps-in-toss',
      state: 'available',
      logTypes: ['screen', 'click', 'impression'],
    });
    await expect(analytics?.log({ logName: 'nem_play_clear', logType: 'event' })).resolves.toBe(false);
    await expect(analytics?.log({ logName: 'nem_shop_button', logType: 'click', params: { slot: 1 } }))
      .resolves.toBe(true);
    await expect(analytics?.log({ logName: 'nem_shop_banner', logType: 'impression' })).resolves.toBe(true);
    await expect(analytics?.log({ logName: 'nem_home_screen', logType: 'screen' })).resolves.toBe(true);

    expect(sdk.log).not.toHaveBeenCalled();
    expect(sdk.click).toHaveBeenCalledExactlyOnceWith({ log_name: 'nem_shop_button', slot: 1 });
    expect(sdk.impression).toHaveBeenCalledExactlyOnceWith({ log_name: 'nem_shop_banner' });
    expect(sdk.screen).toHaveBeenCalledExactlyOnceWith({ log_name: 'nem_home_screen' });
  });

  it('re-validates logs in the host before calling the SDK', async () => {
    const sdk = createSdk();
    const bridge = createAitHostBridge({
      dependencies: { analytics: sdk, isMinVersionSupported: () => true },
    });
    const invalid: readonly unknown[] = [
      undefined,
      { logName: 'nem_play', logType: 'debug' },
      { logName: 'NEM_PLAY', logType: 'event' },
      { logName: 'nem_play', logType: 'event', params: { user_id: 'player-1' } },
      { logName: 'nem_play', logType: 'event', params: { room_id: 'r1' } },
      { logName: 'nem_play', logType: 'event', params: { score: 1200 } },
      { logName: 'nem_play', logType: 'event', params: { nested: { a: 1 } } },
      {
        logName: 'nem_play',
        logType: 'event',
        params: Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`p${index}`, index])),
      },
    ];
    for (const payload of invalid) {
      const response = await bridge.request({
        id: 'analytics-log',
        method: 'analytics.log',
        payload,
        meta: { target: 'ait', appVersion: '1.0.0', buildId: 'test', sentAt: '2026-11-01T00:00:00.000Z' },
      });
      expect(response).toEqual({ id: 'analytics-log', ok: true, data: { sent: false } });
    }
    expect(sdk.log).not.toHaveBeenCalled();
    expect(sdk.screen).not.toHaveBeenCalled();
  });

  it('swallows SDK failures so analytics never affects play', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const throwing = createSdk({
        log: () => {
          throw new Error('native bridge missing');
        },
        screen: () => {
          throw new Error('native bridge missing');
        },
      });
      const analytics = createGateway(throwing, { modern: true }).analytics;
      await expect(analytics?.log({ logName: 'nem_play_clear', logType: 'event' })).resolves.toBe(false);
      await expect(analytics?.log({ logName: 'nem_home_screen', logType: 'screen' })).resolves.toBe(false);

      const rejecting = createSdk({ log: async () => Promise.reject(new Error('offline')) });
      await expect(createGateway(rejecting, { modern: true }).analytics?.log({
        logName: 'nem_play_clear',
        logType: 'event',
      })).resolves.toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('validates on the game side and never sends an invalid log over the bridge', async () => {
    const requests: BridgeRequest[] = [];
    const gateway = createAitPlatformGateway({
      appVersion: '1.0.0',
      buildId: 'test',
      bridge: hostAnswering((input) => {
        requests.push(input);
        return { id: input.id, ok: true, data: { sent: true } };
      }),
    });

    await expect(gateway.analytics?.log({ logName: 'nem_play', logType: 'event', params: { account_id: 'a' } }))
      .resolves.toBe(false);
    expect(requests).toEqual([]);
    await expect(gateway.analytics?.log({ logName: 'nem_play', logType: 'event', params: { kind: 'daily' } }))
      .resolves.toBe(true);
    expect(requests.map((request) => [request.method, request.payload])).toEqual([
      ['analytics.log', { logName: 'nem_play', logType: 'event', params: { kind: 'daily' } }],
    ]);
  });

  it('reads an older host, a failing host, and the sandbox as unsupported', async () => {
    const unsupportedStatus = { provider: 'none', state: 'unsupported', logTypes: [] };
    const olderHost = hostAnswering((input) => ({
      id: input.id,
      ok: false,
      error: { code: 'UNSUPPORTED_METHOD', message: `Unsupported AIT bridge method: ${input.method}`, retryable: false },
    }));
    const failingHost: GamePlatformBridge = {
      async request() {
        throw new Error('bridge torn down');
      },
    };
    const malformedHost = hostAnswering((input) => ({ id: input.id, ok: true, data: { state: 'ready' } }));
    for (const bridge of [olderHost, failingHost, malformedHost, createAitSandboxBridge()]) {
      const gateway = createAitPlatformGateway({ appVersion: '1.0.0', buildId: 'test', bridge });
      await expect(gateway.analytics?.getStatus()).resolves.toEqual(unsupportedStatus);
      await expect(gateway.analytics?.log({ logName: 'nem_play', logType: 'event' })).resolves.toBe(false);
    }
  });

  it('keeps the local SDK mock in parity with the analytics surface', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    try {
      const sdk: AitAnalyticsSdk = localAnalytics;
      await expect(sdk.log({ log_name: 'nem_play', log_type: 'event', params: {} })).resolves.toBeUndefined();
      await expect(sdk.screen({ log_name: 'nem_home_screen' })).resolves.toBeUndefined();
      expect(debug).toHaveBeenCalledTimes(2);
    } finally {
      debug.mockRestore();
    }
  });
});
