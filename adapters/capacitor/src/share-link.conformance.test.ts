import { describe, expect, it } from 'vitest';

import type { BridgeResponse } from '@mpgd/bridge';
import { runShareLinkConformance } from '@mpgd/platform/share-link-conformance';

import { createCapacitorPlatformGateway, type NativeBridge } from './index';

describe('Capacitor share links', () => {
  for (const target of ['android', 'ios'] as const) {
    it(`hands the ${target} bridge only links the ShareIntent contract accepts, normalized`, async () => {
      const handed: (string | null)[] = [];
      const bridge: NativeBridge = {
        async request(input) {
          if (input.method !== 'share.share') {
            throw new Error(`Unexpected bridge method: ${input.method}`);
          }

          const { deepLink } = input.payload as { readonly deepLink?: unknown };
          handed.push(typeof deepLink === 'string' ? deepLink : null);

          return {
            id: input.id,
            ok: true,
            data: { status: 'shared', completion: 'presented' },
          } satisfies BridgeResponse;
        },
      };
      const gateway = createCapacitorPlatformGateway({
        target,
        appVersion: '1.0.0',
        buildId: `share-links:${target}`,
        bridge,
      });
      const share = gateway.sharing?.share?.bind(gateway.sharing);

      if (share === undefined) {
        throw new Error('The gateway offers no share.');
      }

      await expect(runShareLinkConformance({
        name: `capacitor:${target}`,
        share,
        sharedResult: { status: 'shared', completion: 'presented' },
        host: {
          handedLinks: () => handed,
          expectedLink: (link) => link,
        },
      })).resolves.toMatchObject({ name: `capacitor:${target}` });
    });
  }
});
