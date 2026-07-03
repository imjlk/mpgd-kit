import { describe, expect, it } from 'vitest';

import type { BridgeRequest, BridgeResponse } from '@mpgd/bridge-protocol';

import { createAitPlatformGateway, type GamePlatformBridge } from './index';

describe('adapter-ait', () => {
  it('sends platform requests through the installed AIT bridge', async () => {
    const requests: BridgeRequest[] = [];
    const bridge: GamePlatformBridge = {
      async request(input) {
        requests.push(input);

        return {
          id: input.id,
          ok: true,
          data: {
            playerId: 'ait-player',
            displayName: 'AIT Player',
          },
        } satisfies BridgeResponse;
      },
    };

    const gateway = createAitPlatformGateway({
      appVersion: '1.2.3',
      buildId: 'build-ait',
      bridge,
    });

    await expect(gateway.identity.getPlayer()).resolves.toEqual({
      playerId: 'ait-player',
      displayName: 'AIT Player',
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: 'identity.getPlayer',
      payload: {},
      meta: {
        target: 'ait',
        appVersion: '1.2.3',
        buildId: 'build-ait',
      },
    });
  });

  it('throws bridge errors as JavaScript errors', async () => {
    const bridge: GamePlatformBridge = {
      async request(input) {
        return {
          id: input.id,
          ok: false,
          error: {
            code: 'UNSUPPORTED_METHOD',
            message: 'Unsupported method.',
            retryable: false,
          },
        };
      },
    };

    const gateway = createAitPlatformGateway({
      appVersion: '1.2.3',
      buildId: 'build-ait',
      bridge,
    });

    await expect(gateway.getCapabilities()).rejects.toThrow('Unsupported method.');
  });
});
