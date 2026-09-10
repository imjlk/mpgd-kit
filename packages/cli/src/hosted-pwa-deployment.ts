import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, posix, relative, resolve } from 'node:path';

import { decodeHTMLAttribute } from 'entities';

import {
  cloudflarePagesPathMatches,
  evaluateCloudflarePagesHeader,
  normalizeHeaderDirectiveValue,
  parseCloudflarePagesHeaders,
  parseCloudflarePagesRedirects,
} from './cloudflare-pages-static.js';
import {
  createMicrosoftStorePwaRevision,
  createMicrosoftStorePwaServiceWorker,
  listPrecacheEntries,
  readMicrosoftStorePwaReleaseEvidence,
} from './microsoft-store-pwa-release.js';

/**
 * Read-only verification that a hosted Cloudflare Pages deployment directory
 * serves exactly the files of an already-verified PWA artifact, with routing
 * and cache headers that keep the PWA entry points reachable and fresh.
 *
 * The verifier knows nothing about individual games or workspace layouts: it
 * compares an explicit source artifact directory against an explicit
 * deployment directory under one of the reviewed Pages host profiles.
 */

export const hostedPwaDeploymentHosts = ['cloudflare-pages'] as const;
export type HostedPwaDeploymentHost = (typeof hostedPwaDeploymentHosts)[number];

export const cloudflarePagesDeploymentProfiles = ['api-only', 'api-canonical-index'] as const;
export type CloudflarePagesDeploymentProfile = (typeof cloudflarePagesDeploymentProfiles)[number];

/** Host files that Pages adds around the game artifact. */
const cloudflarePagesHostFileAllowlist = new Set([
  '_worker.js',
  '_headers',
  '_redirects',
  '_routes.json',
  'wrangler.jsonc',
  'legal-site.json',
]);

/** Control artifacts Pages consumes instead of serving to browsers. */
const pagesControlArtifactNames = new Set([
  '_worker.js',
  '_headers',
  '_redirects',
  '_routes.json',
  'wrangler.jsonc',
]);

/** Request paths a redirect may never cover, matched as patterns. */
const protectedPwaMetadataRequestPaths = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/service-worker.js',
  '/pwa-release.json',
] as const;

const freshCacheControl = 'public, max-age=0, must-revalidate';
const noStoreCacheControl = 'no-store, must-revalidate';
const immutableCacheControl = 'public, max-age=31536000, immutable';

const freshCacheControlFiles = new Set([
  '/manifest.webmanifest',
  '/pwa-release.json',
  '/mpgd-effective-target.json',
  '/mpgd-icon-manifest.json',
  '/mpgd-icon-precache.json',
  '/legal-site.json',
  '/game-services-routing.json',
]);

const noStoreCacheControlFiles = new Set(['/service-worker.js']);

const immutableCacheControlDirectories = new Set(['assets']);
const noStoreCacheControlDirectories = new Set(['icons']);

/** Precache URLs the reviewed PWA contract always includes. */
const requiredPrecacheUrls = new Set([
  './index.html',
  './manifest.webmanifest',
  './pwa-release.json',
]);

export interface VerifyHostedPwaDeploymentInput {
  /** Directory of the already-verified source PWA artifact. */
  readonly sourceArtifactRoot: string;
  /** Directory that the host deploys (game files merged with host files). */
  readonly deploymentRoot: string;
  readonly host: HostedPwaDeploymentHost;
  readonly profile: CloudflarePagesDeploymentProfile;
}

export interface HostedPwaDeploymentVerification {
  readonly host: HostedPwaDeploymentHost;
  readonly profile: CloudflarePagesDeploymentProfile;
  readonly sourceArtifactRoot: string;
  readonly deploymentRoot: string;
  readonly appVersion: string;
  readonly buildId: string;
  readonly revision: string;
  readonly verifiedGameFileCount: number;
  readonly hostFileCount: number;
  readonly workerRoutes: {
    readonly include: readonly string[];
    readonly exclude: readonly string[];
  };
}

export function isSupportedHostedPwaProfile(host: string, profile: string): boolean {
  if (!hostedPwaDeploymentHosts.includes(host as HostedPwaDeploymentHost)) {
    return false;
  }

  return cloudflarePagesDeploymentProfiles.includes(profile as CloudflarePagesDeploymentProfile);
}

export function verifyHostedPwaDeployment(
  input: VerifyHostedPwaDeploymentInput,
): HostedPwaDeploymentVerification {
  if (!hostedPwaDeploymentHosts.includes(input.host)) {
    throw new Error(
      `Unsupported hosted PWA deployment host: ${input.host} `
        + `(supported: ${hostedPwaDeploymentHosts.join(', ')}).`,
    );
  }

  if (
    !cloudflarePagesDeploymentProfiles.includes(input.profile as CloudflarePagesDeploymentProfile)
  ) {
    throw new Error(
      `Unsupported Cloudflare Pages host profile: ${input.profile} `
        + `(supported: ${cloudflarePagesDeploymentProfiles.join(', ')}).`,
    );
  }

  const sourceRoot = resolveArtifactDirectory(input.sourceArtifactRoot, 'source PWA artifact');
  const deploymentRoot = resolveArtifactDirectory(input.deploymentRoot, 'deployment');

  if (sourceRoot === deploymentRoot) {
    throw new Error(
      'The source artifact and the deployment directory must be different directories; '
        + 'a self-comparison cannot validate the deployment merge.',
    );
  }

  const sourceFiles = listArtifactFilesStrict(sourceRoot, 'source PWA artifact');
  const deploymentFiles = listArtifactFilesStrict(deploymentRoot, 'deployment');

  const evidence = verifySourceArtifactSelfConsistency(sourceRoot, sourceFiles);
  verifyDeploymentGameFiles(sourceRoot, sourceFiles, deploymentRoot, deploymentFiles);
  const hostFiles = verifyDeploymentFileClassification(
    deploymentFiles,
    sourceFiles,
    deploymentRoot,
    input.profile,
  );
  const referencedDirectoryUrls = verifyIndexReferences(deploymentRoot, deploymentFiles);
  const workerRoutes = verifyCloudflarePagesRoutes(deploymentRoot, input.profile);
  assertNoSourceRoutesShadowed(workerRoutes, sourceFiles, input.profile);
  assertNoLegalRoutesShadowed(workerRoutes, [...readLegalSitePages(deploymentRoot)], input.profile);
  const legalPages = [...readLegalSitePages(deploymentRoot)];
  const declaredLegalDirectories = new Set(
    legalPages.map((page) => page.slice(0, -'index.html'.length)),
  );

  verifyCloudflarePagesHeaders(
    deploymentRoot,
    sourceFiles,
    deploymentFiles,
    declaredLegalDirectories,
  );
  const deploymentLegalPaths = [
    ...[...readLegalSitePages(deploymentRoot)].map(
      (page) => `/${page.slice(0, -'index.html'.length)}`,
    ),
    ...(existsSync(join(deploymentRoot, 'legal-site.json'))
      ? ['/legal-site.json']
      : []),
  ];

  verifyCloudflarePagesRedirects(
    deploymentRoot,
    sourceFiles,
    deploymentLegalPaths,
    referencedDirectoryUrls,
  );

  return {
    host: input.host,
    profile: input.profile,
    sourceArtifactRoot: sourceRoot,
    deploymentRoot,
    appVersion: evidence.appVersion,
    buildId: evidence.buildId,
    revision: evidence.revision,
    verifiedGameFileCount: sourceFiles.length,
    hostFileCount: hostFiles.length,
    workerRoutes,
  };
}

function resolveArtifactDirectory(path: string, label: string): string {
  const resolved = resolve(path);

  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new Error(`The ${label} directory does not exist: ${resolved}`);
  }

  return realpathSync(resolved);
}

export interface ArtifactFile {
  readonly path: string;
  readonly bytes: Buffer;
  readonly sha256: string;
}

/**
 * Enumerate every file under a root with strict safety: symbolic links,
 * non-regular files, and non-portable names are rejected so the deployment
 * comparison cannot be redirected outside the inspected directory.
 */
function listArtifactFilesStrict(root: string, label: string): readonly ArtifactFile[] {
  const files: ArtifactFile[] = [];
  const pendingDirectories: string[] = [root];

  while (pendingDirectories.length > 0) {
    const directory = pendingDirectories.pop();

    if (directory === undefined) {
      throw new Error(`${label} traversal lost its directory.`);
    }

    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);

      if (entry.isSymbolicLink()) {
        throw new Error(`The ${label} must not contain symbolic links: ${absolute}`);
      }

      if (/[\\\t\n\r]/u.test(entry.name)) {
        throw new Error(
          `The ${label} contains a non-portable file name with a backslash or `
            + `URL-stripped control character: ${JSON.stringify(entry.name)}`,
        );
      }

      if (entry.isDirectory()) {
        pendingDirectories.push(absolute);
      } else if (entry.isFile()) {
        const relativePath = posix.normalize(relativePortablePath(root, absolute));

        if (
          relativePath.startsWith('../')
          || relativePath === '..'
          || relativePath.includes('/../')
          || posix.isAbsolute(relativePath)
        ) {
          throw new Error(`The ${label} file escapes its root: ${absolute}`);
        }

        const bytes = readFileSync(absolute);
        files.push({
          path: relativePath,
          bytes,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        });
      } else {
        throw new Error(
          `The ${label} contains an entry that is neither a directory nor a regular `
          + `file: ${absolute}`,
        );
      }
    }
  }

  return files.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
}

function relativePortablePath(root: string, absolute: string): string {
  const rootReal = realpathSync(root);
  const parentReal = realpathSync(dirname(absolute));

  return relative(rootReal, join(parentReal, absolute.slice(dirname(absolute).length)))
    .split('\\')
    .join('/');
}

function verifySourceArtifactSelfConsistency(
  sourceRoot: string,
  sourceFiles: readonly ArtifactFile[],
) {
  const evidencePath = `${sourceRoot}/pwa-release.json`;

  if (!existsSync(evidencePath)) {
    throw new Error('The source PWA artifact is missing pwa-release.json.');
  }

  const evidence = readMicrosoftStorePwaReleaseEvidence(evidencePath);

  for (const reserved of cloudflarePagesHostFileAllowlist) {
    if (sourceFiles.some((file) => file.path === reserved)) {
      throw new Error(
        `The source PWA artifact contains the Pages control file ${reserved}; `
          + 'control files belong to the host deployment, not the game artifact.',
      );
    }
  }

  for (const required of ['index.html', 'manifest.webmanifest', 'service-worker.js']) {
    if (!sourceFiles.some((file) => file.path === required)) {
      throw new Error(`The source PWA artifact is missing ${required}.`);
    }
  }

  const manifest = JSON.parse(
    readFileSync(`${sourceRoot}/manifest.webmanifest`, 'utf8'),
  ) as { readonly id?: unknown };

  if (manifest.id !== evidence.pwaId) {
    throw new Error(
      'The source PWA artifact manifest application id does not match the '
        + 'release evidence; the manifest and pwa-release.json must identify '
        + 'the same application.',
    );
  }

  const precacheEntries = listPrecacheEntries(sourceRoot);
  const enumeratedUrls = [
    ...precacheEntries.map((entry) => entry.url),
    './pwa-release.json',
  ].sort();
  const recordedUrls = [...evidence.precacheUrls].sort();

  if (JSON.stringify(enumeratedUrls) !== JSON.stringify(recordedUrls)) {
    throw new Error(
      'The source PWA artifact precache contract is inconsistent: the recorded '
        + 'pwa-release.json URLs do not match the files actually present in the '
        + 'artifact, so the service worker precache list cannot be trusted.',
    );
  }

  for (const required of requiredPrecacheUrls) {
    if (!evidence.precacheUrls.includes(required)) {
      throw new Error(
        `The source PWA artifact precache contract omits the required URL ${required}.`,
      );
    }
  }

  const sourceWorker = sourceFiles.find((file) => file.path === 'service-worker.js');

  if (
    sourceWorker !== undefined
    && sourceWorker.bytes.toString('utf8') !== createMicrosoftStorePwaServiceWorker(evidence)
  ) {
    throw new Error(
      'The source PWA artifact service worker does not match the release '
        + 'evidence; it must be the deterministic worker generated for the '
        + 'recorded precache contract so its cache identity and precache list '
        + 'cannot drift from pwa-release.json.',
    );
  }

  const recomputedRevision = createMicrosoftStorePwaRevision({
    appVersion: evidence.appVersion,
    buildId: evidence.buildId,
    sourceGitSha: evidence.sourceGitSha,
    kitGitSha: evidence.kitGitSha,
    precacheEntries,
  });

  if (recomputedRevision !== evidence.revision) {
    throw new Error(
      'The source PWA artifact is not self-consistent: the recomputed release revision '
        + `${recomputedRevision} does not match the recorded ${evidence.revision}.`,
    );
  }

  return evidence;
}

function verifyDeploymentGameFiles(
  sourceRoot: string,
  sourceFiles: readonly ArtifactFile[],
  deploymentRoot: string,
  deploymentFiles: readonly ArtifactFile[],
): void {
  const deploymentByPath = new Map(deploymentFiles.map((file) => [file.path, file] as const));

  for (const sourceFile of sourceFiles) {
    const deployed = deploymentByPath.get(sourceFile.path);

    if (deployed === undefined) {
      throw new Error(
        `The deployment is missing game file ${sourceFile.path} `
          + `from the source artifact ${sourceRoot}.`,
      );
    }

    if (deployed.sha256 !== sourceFile.sha256) {
      throw new Error(
        `The deployment game file ${sourceFile.path} does not match the source artifact; `
          + `expected sha256 ${sourceFile.sha256} but found ${deployed.sha256}.`,
      );
    }
  }
}

function verifyDeploymentFileClassification(
  deploymentFiles: readonly ArtifactFile[],
  sourceFiles: readonly ArtifactFile[],
  deploymentRoot: string,
  profile: CloudflarePagesDeploymentProfile,
): readonly string[] {
  const sourcePaths = new Set(sourceFiles.map((file) => file.path));
  const legalPages = readLegalSitePages(deploymentRoot);
  const hostFiles: string[] = [];
  const unexpected: string[] = [];

  for (const file of deploymentFiles) {
    if (sourcePaths.has(file.path)) {
      continue;
    }

    if (cloudflarePagesHostFileAllowlist.has(file.path) || legalPages.has(file.path)) {
      hostFiles.push(file.path);
      continue;
    }

    unexpected.push(file.path);
  }

  if (unexpected.length > 0) {
    throw new Error(
      'The deployment contains files that belong neither to the source artifact nor to '
        + `the recognized Pages host files: ${unexpected.join(', ')}. `
        + 'This usually means files from a different build were mixed into the deployment.',
    );
  }

  // Both reviewed profiles route /api/* through the Pages worker, so a
  // deployment without the worker would verify statically while shipping
  // broken API routes.
  if (!hostFiles.includes('_worker.js')) {
    throw new Error(
      `The deployment is missing _worker.js; the reviewed ${profile} profile `
        + 'routes /api/* through the Pages worker.',
    );
  }

  return hostFiles;
}

function readLegalSitePages(deploymentRoot: string): Set<string> {
  const manifestPath = `${deploymentRoot}/legal-site.json`;

  if (!existsSync(manifestPath)) {
    return new Set();
  }

  const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
  const pages = new Set<string>();

  if (
    typeof parsed !== 'object'
    || parsed === null
    || !Array.isArray((parsed as Record<string, unknown>).pages)
  ) {
    throw new Error('The deployment legal-site.json must declare a pages array.');
  }

  for (const page of (parsed as { pages: readonly unknown[] }).pages) {
    if (typeof page !== 'object' || page === null) {
      throw new Error('The deployment legal-site.json page entries must be objects.');
    }

    const path = (page as Record<string, unknown>).path;

    const canonicalPath = typeof path === 'string'
      && path.startsWith('/')
      && path.endsWith('/')
      && path !== '/'
      && path
        .slice(1, -1)
        .split('/')
        .every((segment) => /^[A-Za-z0-9_-]+$/u.test(segment));

    if (!canonicalPath) {
      throw new Error(
        'The deployment legal-site.json page paths must be canonical slash-delimited '
          + `URL pathnames without queries, fragments, dot segments, or escapes: ${String(path)}`,
      );
    }

    const relativePage = `${path.slice(1)}index.html`;
    const distance = relative(deploymentRoot, resolve(deploymentRoot, relativePage));

    if (distance === '' || distance.startsWith('..') || posix.isAbsolute(distance)) {
      throw new Error(
        `The deployment legal-site.json page path escapes the deployment root: ${path}`,
      );
    }

    pages.add(relativePage);
  }

  for (const page of pages) {
    const pageFile = join(deploymentRoot, page);

    if (!existsSync(pageFile) || !statSync(pageFile).isFile()) {
      throw new Error(
        'The deployment legal-site.json declares a page that is not present as a '
          + `regular file: ${page}`,
      );
    }
  }

  return pages;
}

function verifyIndexReferences(
  deploymentRoot: string,
  deploymentFiles: readonly ArtifactFile[],
): readonly string[] {
  const index = deploymentFiles.find((file) => file.path === 'index.html');

  if (index === undefined) {
    throw new Error('The deployment is missing index.html.');
  }

  const html = stripNonMarkupRanges(index.bytes.toString('utf8'));

  if (/<base\b/iu.test(html)) {
    throw new Error(
      'The deployment index.html declares a base element; reference resolution '
        + 'against a non-root document base is unsupported by this verifier.',
    );
  }
  const deploymentPaths = new Set(deploymentFiles.map((file) => file.path));
  const referenced = new Set<string>();
  const referencedDirectoryUrls = new Set<string>();

  const references: string[] = [];

  // Attributes only exist on start tags; scanning raw text would treat prose
  // like `Set href="..."` as a reference. Extract within element start tags,
  // with object data URLs and srcset candidates handled per tag.
  const startTagPattern = /<([A-Za-z][^\s/>]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/gu;

  for (const tag of html.matchAll(startTagPattern)) {
    const tagName = (tag[1] ?? '').toLowerCase();
    const attributes = tag[2] ?? '';
    const resourceNames
      = tagName === 'object' ? ['href', 'src', 'poster', 'data'] : ['href', 'src', 'poster'];

    for (const name of resourceNames) {
      for (const match of attributes.matchAll(
        new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]+)"|'([^']+)'|([^\\s>]+))`, 'giu'),
      )) {
        references.push(match[1] ?? match[2] ?? match[3] ?? '');
      }
    }

    if (!/(?:^|\s)srcset\s*=/iu.test(attributes)) {
      continue;
    }

    const srcset = attributes.match(/(?:^|\s)srcset\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/iu);
    const candidates = srcset?.[1] ?? srcset?.[2] ?? srcset?.[3] ?? '';

    // WHATWG srcset tokenizing: whitespace-split tokens alternate between a
    // candidate URL and its descriptors; a numeric single-token value like
    // srcset="404" stays a URL, while densities after a URL are skipped.
    let holdingUrl = false;

    for (const token of candidates.split(/\s+/u)) {
      for (const piece of token.split(/(?<=\d[xw]),/u)) {
        const trimmed = piece.replace(/^[,]+|[,]+$/gu, '');

        if (trimmed.length === 0) {
          continue;
        }

        const isDescriptor = /^[\d.]+[wx]?$/u.test(trimmed);

        if (holdingUrl && isDescriptor) {
          continue;
        }

        references.push(trimmed);
        holdingUrl = !isDescriptor;
      }

      if (/^[\d.]+[wx],?$/u.test(token)) {
        holdingUrl = false;
      }
    }
  }

  for (const rawReference of references) {
    const reference = decodeHtmlReferences(rawReference);
    const schemeSeparated = /^([a-z][a-z0-9+.-]*):/iu.exec(reference);

    if (
      reference.length === 0
      || reference.startsWith('#')
      || reference.startsWith('//')
      || reference.startsWith('data:')
      || (schemeSeparated !== null && schemeSeparated[1] !== undefined)
    ) {
      continue;
    }

    const withoutQuery = reference.split(/[?#]/u)[0] ?? reference;

    if (withoutQuery.length === 0) {
      continue;
    }

    let normalized = posix.normalize(
      withoutQuery.startsWith('/') ? withoutQuery.slice(1) : `./${withoutQuery}`,
    );

    try {
      normalized = normalized
        .split('/')
        .map((segment) => decodeURIComponent(segment))
        .join('/');
    } catch {
      throw new Error(
        `The deployment index.html references a malformed percent-encoded URL: ${reference}`,
      );
    }

    if (normalized.startsWith('../') || normalized === '..' || posix.isAbsolute(normalized)) {
      throw new Error(
        `The deployment index.html references a path outside the artifact root: ${reference}`,
      );
    }

    // Track the concrete directory request URL before resolving it to the
    // index document, so redirect protection sees the URL browsers request.
    if (normalized.endsWith('/')) {
      referencedDirectoryUrls.add(`/${normalized.slice(0, -1)}/`);
    } else if (normalized === '.') {
      referencedDirectoryUrls.add('/');
    }

    // Directory URLs resolve to their index document, matching how Pages
    // serves '/' and '/legal/' from index.html files.
    if (normalized === '.' || normalized.endsWith('/')) {
      normalized = `${normalized === '.' ? '' : normalized}index.html`;
    }

    referenced.add(normalized);
  }

  for (const reference of [...referenced].sort()) {
    if (pagesControlArtifactNames.has(reference)) {
      throw new Error(
        `The deployment index.html references the Pages control file ${reference}; `
          + 'control artifacts are consumed by the host, not served to browsers.',
      );
    }

    if (!deploymentPaths.has(reference)) {
      throw new Error(
        `The deployment index.html references a missing file: ${reference} `
          + `(resolved under ${deploymentRoot}).`,
      );
    }
  }

  return [...referencedDirectoryUrls];
}

/**
 * Decode attribute values with standards-compliant HTML semantics using the
 * package's existing entities dependency (named references, numeric
 * references, and U+FFFD replacement for invalid code points).
 */
function decodeHtmlReferences(text: string): string {
  return decodeHTMLAttribute(text);
}

/** Drop comments, script bodies, and style bodies from HTML before scanning. */
function stripNonMarkupRanges(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/gu, '')
    .replace(/<script\b((?:"[^"]*"|'[^']*'|[^>"'])*)>[\s\S]*?<\/script>/giu, '<script$1></script>')
    .replace(/<style\b((?:"[^"]*"|'[^']*'|[^>"'])*)>[\s\S]*?<\/style>/giu, '<style$1></style>');
}

function verifyCloudflarePagesRoutes(
  deploymentRoot: string,
  profile: CloudflarePagesDeploymentProfile,
): {
  readonly include: readonly string[];
  readonly exclude: readonly string[];
} {
  const routesPath = `${deploymentRoot}/_routes.json`;

  if (!existsSync(routesPath)) {
    throw new Error('The deployment is missing _routes.json.');
  }

  const routes = JSON.parse(readFileSync(routesPath, 'utf8')) as unknown;

  if (typeof routes !== 'object' || routes === null) {
    throw new Error('The deployment _routes.json must be an object.');
  }

  const record = routes as Record<string, unknown>;
  const include = record.include;
  const exclude = record.exclude;

  if (record.version !== 1 || !Array.isArray(include) || !Array.isArray(exclude)) {
    throw new Error(
      'The deployment _routes.json must declare version 1 with include and exclude arrays.',
    );
  }

  const expectedInclude = profile === 'api-canonical-index'
    ? ['/api/*', '/index.html']
    : ['/api/*'];
  const actual = {
    version: 1,
    include: [...include],
    exclude: [...exclude],
  };
  const expected = {
    version: 1,
    include: expectedInclude,
    exclude: [],
  };

  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `The deployment _routes.json does not match the reviewed ${profile} profile. `
        + `Expected ${JSON.stringify(expected)} but found ${JSON.stringify(actual)}. `
        + 'Broader worker routes are rejected because they silently bypass the '
        + 'static PWA serving this verification guarantees.',
    );
  }

  return {
    include: actual.include.map(String),
    exclude: actual.exclude.map(String),
  };
}

function assertNoSourceRoutesShadowed(
  routes: { readonly include: readonly string[] },
  sourceFiles: readonly ArtifactFile[],
  profile: CloudflarePagesDeploymentProfile,
): void {
  // The api-canonical-index profile deliberately routes /index.html through
  // the worker, whose reviewed handler serves the canonical index bytes from
  // the deployment assets; every other route collision is a real shadowing.
  const shadowingRoutes = routes.include.filter(
    (route) => !(profile === 'api-canonical-index' && route === '/index.html'),
  );

  for (const file of sourceFiles) {
    const requestPath = `/${file.path}`;

    for (const route of shadowingRoutes) {
      if (cloudflarePagesPathMatches(route, requestPath)) {
        throw new Error(
          `The source artifact file ${file.path} is served at ${requestPath}, which the `
          + `Pages worker route ${route} intercepts; the reviewed profiles route /api/* `
          + 'through the worker, so precached files must not live under those paths.',
        );
      }
    }
  }
}

/** Declared legal pages must be served statically, not intercepted by the worker. */
function assertNoLegalRoutesShadowed(
  routes: { readonly include: readonly string[] },
  legalPages: readonly string[],
  profile: CloudflarePagesDeploymentProfile,
): void {
  for (const page of legalPages) {
    const requestPath = `/${page.slice(0, -'index.html'.length)}`;

    for (const route of routes.include) {
      if (
        cloudflarePagesPathMatches(route, requestPath)
        && !(profile === 'api-canonical-index' && route === '/index.html')
      ) {
        throw new Error(
          `The declared legal page ${page} is served at ${requestPath}, which the `
            + `Pages worker route ${route} intercepts instead of serving the file.`,
        );
      }
    }
  }
}

function verifyCloudflarePagesHeaders(
  deploymentRoot: string,
  sourceFiles: readonly ArtifactFile[],
  deploymentFiles: readonly ArtifactFile[],
  declaredLegalDirectories: ReadonlySet<string>,
): void {
  const headersPath = `${deploymentRoot}/_headers`;

  if (!existsSync(headersPath)) {
    throw new Error('The deployment is missing _headers.');
  }

  const blocks = parseCloudflarePagesHeaders(readFileSync(headersPath, 'utf8'));
  const sourcePaths = new Set(sourceFiles.map((file) => file.path));
  const deploymentPaths = new Set(deploymentFiles.map((file) => file.path));

  const requirements: {
    readonly requestPath: string;
    readonly expected: string;
    readonly label: string;
  }[] = [];

  // Host-owned legal content must stay fresh: the deployment declares the
  // pages and ships legal-site.json, and stale privacy or terms pages after
  // an update are a compliance problem, so they carry revalidation policy.
  for (const file of deploymentFiles) {
    if (file.path === 'legal-site.json') {
      requirements.push({
        requestPath: '/legal-site.json',
        expected: freshCacheControl,
        label: 'legal-site.json',
      });
    }

    const declaredLegalPage = file.path.endsWith('/index.html')
      && file.path.includes('/')
      && declaredLegalDirectories.has(`${file.path.slice(0, -'index.html'.length - 1)}/`);

    if (
      (declaredLegalPage || (!sourcePaths.has(file.path) && file.path.includes('/')))
      && file.path.endsWith('/index.html')
    ) {
      const directoryUrl = `/${file.path.slice(0, -'index.html'.length)}`;

      requirements.push({
        requestPath: directoryUrl,
        expected: freshCacheControl,
        label: `${file.path} directory URL`,
      });
    }
  }

  if (sourcePaths.has('index.html')) {
    requirements.push(
      { requestPath: '/', expected: freshCacheControl, label: 'the PWA root' },
      { requestPath: '/index.html', expected: freshCacheControl, label: 'index.html' },
    );
  }

  for (const file of [...freshCacheControlFiles, ...noStoreCacheControlFiles]) {
    if (sourcePaths.has(file.slice(1))) {
      requirements.push({
        requestPath: file,
        expected: noStoreCacheControlFiles.has(file)
          ? noStoreCacheControl
          : freshCacheControl,
        label: file.slice(1),
      });
    }
  }

  // Directory-scoped policies are evaluated against every actual file path so
  // placeholder-shaped blocks that do not cover the real URLs cannot satisfy
  // the requirement by coincidence. Only filenames that carry a content
  // hash may be cached immutably; stable names require revalidation so a
  // later release at the same URL is served fresh.
  for (const file of sourceFiles) {
    const directory = file.path.includes('/') ? (file.path.split('/')[0] ?? '') : '';

    if (directory.length === 0) {
      continue;
    }

    if (immutableCacheControlDirectories.has(directory)) {
      const hashed = carriesContentHash(file.path);

      requirements.push({
        requestPath: `/${file.path}`,
        expected: hashed ? immutableCacheControl : freshCacheControl,
        label: hashed ? `content-hashed ${file.path}` : `stable-name ${file.path}`,
      });
    } else if (noStoreCacheControlDirectories.has(directory)) {
      requirements.push({
        requestPath: `/${file.path}`,
        expected: noStoreCacheControl,
        label: `stable-name ${file.path}`,
      });
    }
  }

  for (const requirement of requirements) {
    const effective = evaluateCloudflarePagesHeader(
      blocks,
      requirement.requestPath,
      'Cache-Control',
    );

    if (effective.additions.length > 1) {
      throw new Error(
        `Conflicting Cloudflare Pages cache policy for ${requirement.label}: `
          + `${requirement.requestPath} receives comma-joined Cache-Control values `
          + `(${effective.additions.join(', ')}) because more than one matching block `
          + 'adds the header. Cloudflare joins duplicate headers with commas instead '
          + 'of overriding them.',
      );
    }

    if (effective.value === undefined) {
      throw new Error(
        `Cloudflare Pages cache policy for ${requirement.label} is missing: no matching `
          + `block sets Cache-Control to ${requirement.expected} for `
          + `${requirement.requestPath}`
          + (effective.removed
            ? ' (a matching block removed the header with a removal directive)'
            : '')
          + '.',
      );
    }

    if (
      normalizeHeaderDirectiveValue(effective.value)
      !== normalizeHeaderDirectiveValue(requirement.expected)
    ) {
      throw new Error(
        `Cloudflare Pages cache policy for ${requirement.label} is wrong: expected `
          + `${requirement.expected} for ${requirement.requestPath} but the effective `
          + `value is ${effective.value}.`,
      );
    }
  }
}

/** Whether a filename carries a Vite-style content hash segment. */
function carriesContentHash(portablePath: string): boolean {
  const name = portablePath.split('/').pop() ?? '';

  // Only unambiguous hexadecimal segments earn the immutable policy. Vite's
  // URL-safe base64 segments cannot be told apart from mixed-case words like
  // "Player2D" lexically, so they take the fail-safe revalidation policy:
  // a misclassified hash merely revalidates, while a misclassified stable
  // name would serve stale release bytes for a year.
  return /(^|[/.-])[0-9a-f]{8,}\.[a-z0-9]+$/iu.test(name);
}

function verifyCloudflarePagesRedirects(
  deploymentRoot: string,
  sourceFiles: readonly ArtifactFile[],
  deploymentLegalPaths: readonly string[],
  referencedDirectoryUrls: readonly string[],
): void {
  const redirectsPath = `${deploymentRoot}/_redirects`;

  if (!existsSync(redirectsPath)) {
    throw new Error('The deployment is missing _redirects.');
  }

  const rules = parseCloudflarePagesRedirects(readFileSync(redirectsPath, 'utf8'));

  const protectedPaths = [
    ...protectedPwaMetadataRequestPaths,
    ...sourceFiles.map((file) => `/${file.path}`),
    ...deploymentLegalPaths,
    ...referencedDirectoryUrls,
  ];

  for (const rule of rules) {
    for (const protectedPath of protectedPaths) {
      if (cloudflarePagesPathMatches(rule.source, protectedPath)) {
        throw new Error(
          `The deployment _redirects rule ${rule.source} covers the protected PWA path `
          + `${protectedPath} and moves it to ${rule.destination}; the game root and `
          + 'PWA-critical files must be served directly.',
        );
      }
    }
  }
}
