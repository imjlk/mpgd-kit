import { describe, expect, it } from 'vitest';

import { runShareLinkConformance } from '@mpgd/platform/share-link-conformance';

import { shareIntent } from './host';
import { createAitPlatformGateway, createAitSandboxBridge } from './index';

/** The `intoss://` link the host shares for a link `normalizeShareLink` accepted. */
function appLink(link: string): string {
  if (link.startsWith('/')) {
    return `intoss://ttokdoku${link}`;
  }

  const { pathname, search, hash } = new URL(link);

  return `intoss://ttokdoku${pathname}${search}${hash}`;
}

describe('Apps in Toss share links', () => {
  it('hands the Toss share link API only app links whose path stays in the mini-app', async () => {
    const handed: string[] = [];

    await expect(runShareLinkConformance({
      name: 'ait:host',
      share: (intent) => shareIntent(intent, {
        appName: 'ttokdoku',
        async getTossShareLink(link) {
          handed.push(link);
          return 'https://toss.im/_ul/share';
        },
        async share() {},
      }),
      sharedResult: { status: 'shared', completion: 'presented' },
      host: {
        handedLinks: () => handed,
        expectedLink: appLink,
      },
    })).resolves.toMatchObject({ name: 'ait:host' });
  });

  it('answers in the sandbox exactly as the host does', async () => {
    const gateway = createAitPlatformGateway({
      appVersion: '1.0.0',
      buildId: 'ait-sandbox',
      fallbackBridge: createAitSandboxBridge({ appName: 'ttokdoku', storage: null }),
    });
    const share = gateway.sharing?.share?.bind(gateway.sharing);

    if (share === undefined) {
      throw new Error('The gateway offers no share.');
    }

    await expect(runShareLinkConformance({
      name: 'ait:sandbox',
      share,
      sharedResult: { status: 'shared', completion: 'presented' },
    })).resolves.toMatchObject({ name: 'ait:sandbox' });
  });
});
