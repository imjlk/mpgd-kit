import { describe, expect, it } from 'vitest';

import type { ShareAdapter, ShareIntent, ShareResult } from './index.js';
import { rootRelativeRouteVectors, shareLinkVectors } from './route-vectors.js';
import { readShareIntent, withShareIntentCheck } from './routes.js';
import {
  runShareLinkConformance,
  type ShareLinkConformanceFixture,
} from './share-link-conformance.js';

const intent = { kind: 'invite', title: 'Join', text: 'Join me' } as const;
const presented: ShareResult = { status: 'shared', completion: 'presented' };

function recordingAdapter(mapLink: (link: string) => string = (link) => link): {
  readonly handed: string[];
  readonly sharing: ShareAdapter;
} {
  const handed: string[] = [];

  return {
    handed,
    sharing: {
      async share(shareIntent) {
        handed.push(mapLink(shareIntent.deepLink));
        return presented;
      },
      async readInboundShare() {
        return { puzzleId: 'daily-1' };
      },
    },
  };
}

function shareOf(sharing: ShareAdapter): (shareIntent: ShareIntent) => Promise<ShareResult> {
  const { share } = sharing;

  if (share === undefined) {
    throw new Error('The adapter offers no share.');
  }

  return (shareIntent) => share.call(sharing, shareIntent);
}

function fixtureFor(sharing: ShareAdapter, handed: readonly string[]): ShareLinkConformanceFixture {
  return {
    name: 'test adapter',
    share: shareOf(sharing),
    sharedResult: presented,
    host: {
      handedLinks: () => handed,
      expectedLink: (link) => link,
    },
  };
}

describe('share intents', () => {
  it('reads an intent with its deep link normalized and keeps the rest', () => {
    expect(readShareIntent({ ...intent, deepLink: '/levels/../daily', payload: { puzzleId: 'p' } }))
      .toEqual({ ...intent, deepLink: '/daily', payload: { puzzleId: 'p' } });
    expect(readShareIntent({ text: 'Join me', deepLink: 'HTTPS://Game.Example' }))
      .toEqual({ text: 'Join me', deepLink: 'https://game.example/' });
  });

  it('refuses intents without a string text or a deep link the route rule accepts', () => {
    for (const candidate of [
      null,
      undefined,
      '/daily',
      [],
      {},
      { text: 'Join me' },
      { text: 1, deepLink: '/daily' },
      { text: 'Join me', deepLink: '//evil.example/daily' },
      { text: 'Join me', deepLink: './daily' },
    ]) {
      expect(readShareIntent(candidate), JSON.stringify(candidate)).toBeUndefined();
    }
  });

  it('answers unavailable before the adapter sees a refused intent and forwards the normalized link', async () => {
    const { handed, sharing } = recordingAdapter();
    const checked = withShareIntentCheck(sharing);

    await expect(checked.share?.({ ...intent, deepLink: '/%2F%2Fevil.example/daily' }))
      .resolves.toEqual({ status: 'unavailable' });
    await expect(checked.share?.({ ...intent, deepLink: '/levels/../daily' }))
      .resolves.toEqual(presented);
    expect(handed).toEqual(['/daily']);
    await expect(checked.readInboundShare?.()).resolves.toEqual({ puzzleId: 'daily-1' });
  });

  it('adds nothing to an adapter without share or inbound share', () => {
    expect(withShareIntentCheck({})).toEqual({});
    expect(Object.keys(withShareIntentCheck({ readInboundShare: async () => null })))
      .toEqual(['readInboundShare']);
  });
});

describe('share link conformance', () => {
  it('passes an adapter behind withShareIntentCheck', async () => {
    const { handed, sharing } = recordingAdapter();
    const report = await runShareLinkConformance(fixtureFor(withShareIntentCheck(sharing), handed));

    expect(report.name).toBe('test adapter');
    expect(report.shared)
      .toBe(rootRelativeRouteVectors.normalized.length + shareLinkVectors.normalized.length);
    expect(report.refused)
      .toBeGreaterThan(rootRelativeRouteVectors.rejected.length + shareLinkVectors.rejected.length);
  });

  it('fails an adapter that hands every link to its host', async () => {
    const { handed, sharing } = recordingAdapter();
    const run = runShareLinkConformance(fixtureFor(sharing, handed));

    await expect(run).rejects.toThrow('test adapter: share link conformance failed');
    await expect(run).rejects.toThrow(
      '"//evil.example/daily": answered {"status":"shared","completion":"presented"} instead of unavailable',
    );
    await expect(run).rejects.toThrow('"//evil.example/daily": reached the host');
    await expect(run).rejects.toThrow('a null intent: share rejected instead of answering');
  });

  it('fails an adapter that hands its host another link than the one it accepted', async () => {
    const { handed, sharing } = recordingAdapter((link) => link.toUpperCase());

    await expect(runShareLinkConformance(fixtureFor(withShareIntentCheck(sharing), handed)))
      .rejects.toThrow('"/daily": the host was handed ["/DAILY"] instead of ["/daily"]');
  });

  it('fails an adapter whose share rejects instead of answering', async () => {
    await expect(runShareLinkConformance({
      name: 'throwing adapter',
      async share() {
        throw new Error('bridge down');
      },
      sharedResult: presented,
    })).rejects.toThrow('share rejected instead of answering (bridge down)');
  });

  it('checks the answers alone for a host it cannot observe', async () => {
    const { sharing } = recordingAdapter();

    await expect(runShareLinkConformance({
      name: 'sandbox',
      share: shareOf(withShareIntentCheck(sharing)),
      sharedResult: presented,
    })).resolves.toMatchObject({ name: 'sandbox' });
    await expect(runShareLinkConformance({
      name: 'sandbox',
      share: shareOf(withShareIntentCheck(sharing)),
      sharedResult: { status: 'shared' },
    })).rejects.toThrow(
      '"/daily": answered {"status":"shared","completion":"presented"} instead of {"status":"shared"}',
    );
  });
});
