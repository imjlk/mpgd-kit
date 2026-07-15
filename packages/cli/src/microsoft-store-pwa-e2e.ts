import { createHash } from 'node:crypto';

export const microsoftStorePwaCacheSchema = 'microsoft-store-offline-v1' as const;

export interface MicrosoftStorePwaReleaseEvidence {
  readonly schemaVersion: 1;
  readonly cacheSchema: typeof microsoftStorePwaCacheSchema;
  readonly pwaId: string;
  readonly appVersion: string;
  readonly buildId: string;
  readonly sourceGitSha: string;
  readonly kitGitSha: string;
  readonly configTarget: 'microsoft-store';
  readonly revision: string;
  readonly cachePrefix: string;
  readonly cacheNamePattern: string;
  readonly precacheUrls: readonly string[];
}

/**
 * The minimal Playwright-compatible page surface used by the PWA helpers.
 * Consumers keep Playwright and browser credentials in their own harness.
 */
export interface MicrosoftStorePwaBrowserPage {
  evaluate<TResult>(pageFunction: () => TResult | Promise<TResult>): Promise<TResult>;
  evaluate<TResult, TArgument>(
    pageFunction: (argument: TArgument) => TResult | Promise<TResult>,
    argument: TArgument,
  ): Promise<TResult>;
}

export interface MicrosoftStorePwaCachedIndexObservation {
  readonly referencesReleaseA: boolean;
  readonly referencesReleaseB: boolean;
}

export interface MicrosoftStorePwaCacheTransitionObservation {
  readonly registrationScope: string;
  readonly scopedCacheNames: {
    readonly a: string;
    readonly b: string;
  };
  readonly cacheNames: readonly string[];
  readonly cachedReleaseBIndex: MicrosoftStorePwaCachedIndexObservation;
}

export interface InspectMicrosoftStorePwaCacheTransitionInput<
  TPage extends MicrosoftStorePwaBrowserPage = MicrosoftStorePwaBrowserPage,
> {
  readonly page: TPage;
  readonly releaseA: MicrosoftStorePwaReleaseEvidence;
  readonly releaseB: MicrosoftStorePwaReleaseEvidence;
  readonly releaseAIndexMarker: string;
  readonly releaseBIndexMarker: string;
  readonly releaseBIndexRequestCount: number;
  readonly preservedCacheNames?: readonly string[];
}

export interface AssertMicrosoftStorePwaCacheTransitionInput
  extends MicrosoftStorePwaCacheTransitionObservation {
  readonly releaseA: MicrosoftStorePwaReleaseEvidence;
  readonly releaseB: MicrosoftStorePwaReleaseEvidence;
  readonly releaseBIndexRequestCount: number;
  readonly preservedCacheNames?: readonly string[];
}

export interface MicrosoftStorePwaCacheTransitionEvidence
  extends MicrosoftStorePwaCacheTransitionObservation {
  readonly checks: {
    readonly releaseBActivated: true;
    readonly releaseACacheRemoved: true;
    readonly preservedCachesRetained: true;
    readonly releaseBIndexCached: true;
    readonly staleReleaseAIndexExcluded: true;
    readonly releaseBInstallBypassedHttpCache: true;
  };
}

export async function readMicrosoftStorePwaBrowserReleaseEvidence<
  TPage extends MicrosoftStorePwaBrowserPage,
>(
  page: TPage,
  releaseUrl?: string,
): Promise<MicrosoftStorePwaReleaseEvidence> {
  const explicitReleaseUrl = releaseUrl === undefined
    ? undefined
    : requireNonEmptyString(releaseUrl, 'PWA release evidence URL');
  const input = await page.evaluate(async (browserInput) => {
    let requestedUrl = browserInput.releaseUrl;

    if (requestedUrl === undefined) {
      const browser = globalThis as unknown as {
        readonly navigator: {
          readonly serviceWorker: {
            getRegistration(clientURL?: string): Promise<{
              readonly scope: string;
            } | undefined>;
          };
        };
      };
      const registration = await browser.navigator.serviceWorker.getRegistration();

      if (registration === undefined) {
        throw new Error('Missing service worker registration before reading release evidence.');
      }

      requestedUrl = new URL('./pwa-release.json', registration.scope).href;
    }

    const response = await fetch(requestedUrl);

    if (!response.ok) {
      throw new Error(`Failed to read PWA release evidence: ${String(response.status)}.`);
    }

    return response.json() as Promise<unknown>;
  }, { releaseUrl: explicitReleaseUrl });

  return assertMicrosoftStorePwaReleaseEvidence(input);
}

export async function requestMicrosoftStorePwaBrowserUpdate<
  TPage extends MicrosoftStorePwaBrowserPage,
>(page: TPage): Promise<void> {
  await page.evaluate(async () => {
    const browser = globalThis as unknown as {
      readonly navigator: {
        readonly serviceWorker: {
          getRegistration(clientURL?: string): Promise<{
            update(): Promise<unknown>;
          } | undefined>;
        };
      };
    };
    const registration = await browser.navigator.serviceWorker.getRegistration();

    if (registration === undefined) {
      throw new Error('Missing service worker registration before update.');
    }

    await registration.update();
  });
}

export async function inspectMicrosoftStorePwaBrowserCacheTransition<
  TPage extends MicrosoftStorePwaBrowserPage,
>(
  input: InspectMicrosoftStorePwaCacheTransitionInput<TPage>,
): Promise<MicrosoftStorePwaCacheTransitionEvidence> {
  const releaseA = assertMicrosoftStorePwaReleaseEvidence(input.releaseA);
  const releaseB = assertMicrosoftStorePwaReleaseEvidence(input.releaseB);
  const releaseAIndexMarker = requireNonEmptyString(
    input.releaseAIndexMarker,
    'release A index marker',
  );
  const releaseBIndexMarker = requireNonEmptyString(
    input.releaseBIndexMarker,
    'release B index marker',
  );
  const observation = await input.page.evaluate(async (browserInput) => {
    const browser = globalThis as unknown as {
      readonly caches: {
        keys(): Promise<string[]>;
        open(name: string): Promise<{
          match(url: string): Promise<{
            text(): Promise<string>;
          } | undefined>;
        }>;
      };
      readonly navigator: {
        readonly serviceWorker: {
          readonly ready: Promise<{ readonly scope: string }>;
        };
      };
    };
    const registration = await browser.navigator.serviceWorker.ready;
    const encodedScope = encodeURIComponent(registration.scope);
    const scopedCacheNames = {
      a: browserInput.releaseACacheNamePattern.replace('{scope}', encodedScope),
      b: browserInput.releaseBCacheNamePattern.replace('{scope}', encodedScope),
    };
    const cacheNames = await browser.caches.keys();
    const releaseBCache = await browser.caches.open(scopedCacheNames.b);
    const cachedIndexUrl = new URL('./index.html', registration.scope).href;
    const cachedIndexResponse = await releaseBCache.match(cachedIndexUrl);

    if (cachedIndexResponse === undefined) {
      throw new Error('Release B cache is missing index.html.');
    }

    const cachedIndex = await cachedIndexResponse.text();

    return {
      registrationScope: registration.scope,
      scopedCacheNames,
      cacheNames,
      cachedReleaseBIndex: {
        referencesReleaseA: cachedIndex.includes(browserInput.releaseAIndexMarker),
        referencesReleaseB: cachedIndex.includes(browserInput.releaseBIndexMarker),
      },
    };
  }, {
    releaseACacheNamePattern: releaseA.cacheNamePattern,
    releaseBCacheNamePattern: releaseB.cacheNamePattern,
    releaseAIndexMarker,
    releaseBIndexMarker,
  });

  return assertMicrosoftStorePwaCacheTransition({
    releaseA,
    releaseB,
    releaseBIndexRequestCount: input.releaseBIndexRequestCount,
    ...(input.preservedCacheNames === undefined
      ? {}
      : { preservedCacheNames: input.preservedCacheNames }),
    ...observation,
  });
}

export function assertMicrosoftStorePwaCacheTransition(
  input: AssertMicrosoftStorePwaCacheTransitionInput,
): MicrosoftStorePwaCacheTransitionEvidence {
  const releaseA = assertMicrosoftStorePwaReleaseEvidence(input.releaseA);
  const releaseB = assertMicrosoftStorePwaReleaseEvidence(input.releaseB);
  const expectedCacheNames = {
    a: resolveMicrosoftStorePwaScopedCacheName(releaseA, input.registrationScope),
    b: resolveMicrosoftStorePwaScopedCacheName(releaseB, input.registrationScope),
  };

  if (releaseA.pwaId !== releaseB.pwaId || releaseA.cachePrefix !== releaseB.cachePrefix) {
    throw new Error('PWA cache transition releases must identify the same application.');
  }

  if (releaseA.buildId === releaseB.buildId || releaseA.revision === releaseB.revision) {
    throw new Error('PWA cache transition releases must use distinct builds and revisions.');
  }

  if (
    input.scopedCacheNames.a !== expectedCacheNames.a
    || input.scopedCacheNames.b !== expectedCacheNames.b
  ) {
    throw new Error('Observed PWA cache names do not match the registration scope.');
  }

  if (!input.cacheNames.includes(expectedCacheNames.b)) {
    throw new Error('Release B cache must exist after activation.');
  }

  if (input.cacheNames.includes(expectedCacheNames.a)) {
    throw new Error('Release A cache must be deleted after release B activates.');
  }

  for (const cacheName of input.preservedCacheNames ?? []) {
    if (!input.cacheNames.includes(requireNonEmptyString(cacheName, 'preserved cache name'))) {
      throw new Error(`Activating release B removed unrelated cache ${cacheName}.`);
    }
  }

  if (!input.cachedReleaseBIndex.referencesReleaseB) {
    throw new Error('Release B cache must contain release B index.html.');
  }

  if (input.cachedReleaseBIndex.referencesReleaseA) {
    throw new Error('Release B cache must not contain release A index.html.');
  }

  if (!Number.isSafeInteger(
    input.releaseBIndexRequestCount,
  ) || input.releaseBIndexRequestCount <= 0) {
    throw new Error('Release B install must request index.html while bypassing the HTTP cache.');
  }

  return {
    registrationScope: requireRegistrationScope(input.registrationScope),
    scopedCacheNames: expectedCacheNames,
    cacheNames: [...input.cacheNames],
    cachedReleaseBIndex: { ...input.cachedReleaseBIndex },
    checks: {
      releaseBActivated: true,
      releaseACacheRemoved: true,
      preservedCachesRetained: true,
      releaseBIndexCached: true,
      staleReleaseAIndexExcluded: true,
      releaseBInstallBypassedHttpCache: true,
    },
  };
}

export function resolveMicrosoftStorePwaScopedCacheName(
  evidenceInput: MicrosoftStorePwaReleaseEvidence,
  registrationScopeInput: string,
): string {
  const evidence = assertMicrosoftStorePwaReleaseEvidence(evidenceInput);
  const registrationScope = requireRegistrationScope(registrationScopeInput);

  return evidence.cacheNamePattern.replace('{scope}', encodeURIComponent(registrationScope));
}

export function assertMicrosoftStorePwaReleaseEvidence(
  input: unknown,
): MicrosoftStorePwaReleaseEvidence {
  assertRecord(input, 'PWA release evidence');

  if (input.schemaVersion !== 1 || input.cacheSchema !== microsoftStorePwaCacheSchema) {
    throw new Error('Unsupported Microsoft Store PWA release evidence schema.');
  }

  if (input.configTarget !== 'microsoft-store') {
    throw new Error('PWA release evidence must target microsoft-store.');
  }

  if (!Array.isArray(input.precacheUrls)) {
    throw new Error('PWA release evidence precacheUrls must be an array.');
  }

  const pwaId = requireGameSpecificPwaId(input.pwaId);
  const revision = requireRevision(input.revision);
  const expectedCachePrefix = `mpgd-pwa-${createHash('sha256')
    .update(pwaId)
    .digest('hex')
    .slice(0, 12)}-`;
  const cachePrefix = requireNonEmptyString(input.cachePrefix, 'PWA cache prefix');
  const cacheNamePattern = requireNonEmptyString(input.cacheNamePattern, 'PWA cache name pattern');
  const precacheUrls = input.precacheUrls.map(assertMicrosoftStorePwaPrecacheUrl);

  if (cachePrefix !== expectedCachePrefix) {
    throw new Error('PWA cache prefix is inconsistent with its application ID.');
  }

  if (cacheNamePattern !== `${cachePrefix}{scope}-${revision}`) {
    throw new Error('PWA cache name pattern is inconsistent.');
  }

  if (
    precacheUrls.length !== new Set(precacheUrls).size
    || precacheUrls.some((url, index) => index > 0 && compareCodeUnits(
      precacheUrls[index - 1] ?? '',
      url,
    ) > 0)
  ) {
    throw new Error('PWA precache URLs must be unique and sorted.');
  }

  return {
    schemaVersion: 1,
    cacheSchema: microsoftStorePwaCacheSchema,
    pwaId,
    appVersion: requireNonEmptyString(input.appVersion, 'PWA app version'),
    buildId: requireNonEmptyString(input.buildId, 'PWA build ID'),
    sourceGitSha: requireGitSha(input.sourceGitSha, 'PWA source Git SHA'),
    kitGitSha: requireGitSha(input.kitGitSha, 'PWA kit Git SHA'),
    configTarget: 'microsoft-store',
    revision,
    cachePrefix,
    cacheNamePattern,
    precacheUrls,
  };
}

export function assertMicrosoftStorePwaPrecacheUrl(input: unknown): string {
  const url = requireNonEmptyString(input, 'PWA precache URL');

  if (
    !url.startsWith('./')
    || url.includes('\\')
    || url.includes('?')
    || url.includes('#')
    || hasDotSegment(url)
  ) {
    throw new Error(`Unsafe PWA precache URL: ${url}`);
  }

  return url;
}

function hasDotSegment(url: string): boolean {
  for (const segment of url.slice(2).split('/')) {
    let decoded: string;

    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return true;
    }

    if (decoded === '.' || decoded === '..') {
      return true;
    }
  }

  return false;
}

function requireGameSpecificPwaId(input: unknown): string {
  const pwaId = requireNonEmptyString(input, 'PWA ID');

  if (pwaId === '.' || pwaId === './' || pwaId === '/') {
    throw new Error('Microsoft Store PWA manifest id must be game-specific.');
  }

  return pwaId;
}

function requireRegistrationScope(input: string): string {
  const scope = requireNonEmptyString(input, 'service worker registration scope');
  let parsed: URL;

  try {
    parsed = new URL(scope);
  } catch {
    throw new Error('Service worker registration scope must be an absolute URL.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Service worker registration scope must use HTTP or HTTPS.');
  }

  return scope;
}

function requireRevision(input: unknown): string {
  const revision = requireNonEmptyString(input, 'PWA revision');

  if (!/^[0-9a-f]{16}$/u.test(revision)) {
    throw new Error('PWA revision must be a 16-character hexadecimal digest.');
  }

  return revision;
}

function requireGitSha(input: unknown, label: string): string {
  const value = requireNonEmptyString(input, label);

  if (!/^[0-9a-f]{40}$/u.test(value)) {
    throw new Error(`${label} must be a full 40-character lowercase Git SHA.`);
  }

  return value;
}

function requireNonEmptyString(input: unknown, label: string): string {
  if (typeof input !== 'string' || input.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }

  return input.trim();
}

function assertRecord(input: unknown, label: string): asserts input is Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error(`${label} must be an object.`);
  }
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
