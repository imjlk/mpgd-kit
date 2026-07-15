import assert from 'node:assert/strict';

import {
  assertMicrosoftStorePwaCacheTransition,
  assertMicrosoftStorePwaReleaseEvidence,
  inspectMicrosoftStorePwaBrowserCacheTransition,
  readMicrosoftStorePwaBrowserReleaseEvidence,
  requestMicrosoftStorePwaBrowserUpdate,
  resolveMicrosoftStorePwaScopedCacheName,
  type MicrosoftStorePwaBrowserPage,
  type MicrosoftStorePwaCacheTransitionObservation,
  type MicrosoftStorePwaReleaseEvidence,
} from '../../packages/cli/src/index';

const releaseA = createReleaseEvidence('release-a', '1111111111111111');
const releaseB = createReleaseEvidence('release-b', '2222222222222222');
const registrationScope = 'http://127.0.0.1:5192/game/';
const scopedCacheNames = {
  a: resolveMicrosoftStorePwaScopedCacheName(releaseA, registrationScope),
  b: resolveMicrosoftStorePwaScopedCacheName(releaseB, registrationScope),
};
const unrelatedCache = 'unrelated-cache';
const observation = {
  registrationScope,
  scopedCacheNames,
  cacheNames: [scopedCacheNames.b, unrelatedCache],
  cachedReleaseBIndex: {
    referencesReleaseA: false,
    referencesReleaseB: true,
  },
};

class FakeBrowserPage implements MicrosoftStorePwaBrowserPage {
  updateRequests = 0;

  constructor(
    private readonly release: MicrosoftStorePwaReleaseEvidence,
    private readonly observation: MicrosoftStorePwaCacheTransitionObservation,
  ) {}

  evaluate<TResult>(pageFunction: () => TResult | Promise<TResult>): Promise<TResult>;
  evaluate<TResult, TArgument>(
    pageFunction: (argument: TArgument) => TResult | Promise<TResult>,
    argument: TArgument,
  ): Promise<TResult>;
  async evaluate<TResult, TArgument>(
    _pageFunction: (() => TResult | Promise<TResult>)
      | ((argument: TArgument) => TResult | Promise<TResult>),
    argument?: TArgument,
  ): Promise<TResult> {
    if (argument === undefined) {
      this.updateRequests += 1;
      return undefined as TResult;
    }

    if (
      typeof argument === 'object'
      && argument !== null
      && 'releaseUrl' in argument
    ) {
      return this.release as TResult;
    }

    return this.observation as TResult;
  }
}

assert.equal(
  scopedCacheNames.a,
  `${releaseA.cachePrefix}${encodeURIComponent(registrationScope)}-${releaseA.revision}`,
);
assert.deepEqual(
  assertMicrosoftStorePwaReleaseEvidence({
    ...releaseA,
    pwaId: ` ${releaseA.pwaId} `,
    appVersion: ` ${releaseA.appVersion} `,
  }),
  releaseA,
);
assert.throws(
  () => assertMicrosoftStorePwaReleaseEvidence({
    ...releaseA,
    sourceGitSha: '1234567',
  }),
  /full 40-character lowercase Git SHA/u,
);
assert.throws(
  () => assertMicrosoftStorePwaReleaseEvidence({
    ...releaseA,
    precacheUrls: ['./assets/game.release-a.js?stale'],
  }),
  /Unsafe PWA precache URL/u,
);
assert.throws(
  () => assertMicrosoftStorePwaReleaseEvidence({
    ...releaseA,
    precacheUrls: ['./%2e%2e/escape.js'],
  }),
  /Unsafe PWA precache URL/u,
);
assert.throws(
  () => assertMicrosoftStorePwaReleaseEvidence({
    ...releaseA,
    sourceGitSha: 'ABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCD',
  }),
  /full 40-character lowercase Git SHA/u,
);
assert.deepEqual(assertMicrosoftStorePwaCacheTransition({
  releaseA,
  releaseB,
  releaseBIndexRequestCount: 1,
  preservedCacheNames: [unrelatedCache],
  ...observation,
}).checks, {
  releaseBActivated: true,
  releaseACacheRemoved: true,
  preservedCachesRetained: true,
  releaseBIndexCached: true,
  staleReleaseAIndexExcluded: true,
  releaseBInstallBypassedHttpCache: true,
});

const page = new FakeBrowserPage(releaseB, observation);

assert.deepEqual(await readMicrosoftStorePwaBrowserReleaseEvidence(page), releaseB);
await requestMicrosoftStorePwaBrowserUpdate(page);
assert.equal(page.updateRequests, 1);
assert.deepEqual((await inspectMicrosoftStorePwaBrowserCacheTransition({
  page,
  releaseA,
  releaseB,
  releaseAIndexMarker: './assets/game.release-a.js',
  releaseBIndexMarker: './assets/game.release-b.js',
  releaseBIndexRequestCount: 1,
  preservedCacheNames: [unrelatedCache],
})).scopedCacheNames, scopedCacheNames);

assert.throws(
  () => assertMicrosoftStorePwaCacheTransition({
    releaseA,
    releaseB,
    releaseBIndexRequestCount: 1,
    ...observation,
    cacheNames: [scopedCacheNames.a, scopedCacheNames.b, unrelatedCache],
  }),
  /Release A cache must be deleted/u,
);
assert.throws(
  () => assertMicrosoftStorePwaCacheTransition({
    releaseA,
    releaseB,
    releaseBIndexRequestCount: 0,
    ...observation,
  }),
  /must request index\.html/u,
);
assert.throws(
  () => resolveMicrosoftStorePwaScopedCacheName(releaseA, 'file:///game/'),
  /must use HTTP or HTTPS/u,
);

console.log('Microsoft Store PWA browser E2E helpers smoke passed.');

function createReleaseEvidence(
  buildId: string,
  revision: string,
): MicrosoftStorePwaReleaseEvidence {
  const cachePrefix = 'mpgd-pwa-3805aa42c363-';

  return {
    schemaVersion: 1,
    cacheSchema: 'microsoft-store-offline-v1',
    pwaId: './fixture-game',
    appVersion: '1.0.0',
    buildId,
    sourceGitSha: '1234567890abcdef1234567890abcdef12345678',
    kitGitSha: '876543210fedcba9876543210fedcba987654321',
    configTarget: 'microsoft-store',
    revision,
    cachePrefix,
    cacheNamePattern: `${cachePrefix}{scope}-${revision}`,
    precacheUrls: [
      `./assets/game.${buildId}.js`,
      './index.html',
      './pwa-release.json',
    ],
  };
}
