import { describe, expect, it } from 'vitest';

import type { BridgeResponse } from '@mpgd/bridge';
import { runShareLinkConformance } from '@mpgd/platform/share-link-conformance';

import { createDevvitPlatformGateway, createDevvitSandboxBridge, type DevvitBridge } from './index';

describe('Devvit share links', () => {
  it('hands the server bridge only links the ShareIntent contract accepts, normalized', async () => {
    const handed: (string | null)[] = [];
    const bridge: DevvitBridge = {
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
    const gateway = createDevvitPlatformGateway({
      appVersion: '1.0.0',
      buildId: 'share-links',
      bridge,
    });
    const share = gateway.sharing?.share?.bind(gateway.sharing);

    if (share === undefined) {
      throw new Error('The gateway offers no share.');
    }

    await expect(runShareLinkConformance({
      name: 'devvit',
      share,
      sharedResult: { status: 'shared', completion: 'presented' },
      host: {
        handedLinks: () => handed,
        expectedLink: (link) => link,
      },
    })).resolves.toMatchObject({ name: 'devvit' });
  });

  it('lets only an accepted link reach the sandbox bridge, which still answers unavailable', async () => {
    const sandbox = createDevvitSandboxBridge();
    const reached: unknown[] = [];
    const gateway = createDevvitPlatformGateway({
      appVersion: '1.0.0',
      buildId: 'share-links',
      bridge: {
        request(input) {
          if (input.method === 'share.share') {
            reached.push((input.payload as { readonly deepLink?: unknown }).deepLink);
          }

          return sandbox.request(input);
        },
      },
    });
    const intent = { kind: 'invite', title: 'Join', text: 'Join me' } as const;

    for (const deepLink of ['//evil.example/daily', '/levels/../daily']) {
      await expect(gateway.sharing?.share?.({ ...intent, deepLink }))
        .resolves.toEqual({ status: 'unavailable' });
    }

    expect(reached).toEqual(['/daily']);
  });
});
