import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, posix, relative, resolve } from 'node:path';

import {
  evaluateCloudflarePagesHeader,
  parseCloudflarePagesHeaders,
  parseCloudflarePagesRedirects,
} from './cloudflare-pages-static';
import {
  createMicrosoftStorePwaRevision,
  listPrecacheEntries,
  readMicrosoftStorePwaReleaseEvidence,
} from './microsoft-store-pwa-release';

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

/** Game files that must never be redirected away by the host. */
const pwaEntryRedirectSources = new Set(['/', '/index.html']);

const freshCacheControl = 'public, max-age=0, must-revalidate';
const noStoreCacheControl = 'no-store, must-revalidate';
const immutableCacheControl = 'public, max-age=31536000, immutable';

const freshCacheControlFiles = new Set([
  '/index.html',
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

export function isSupportedHostedPwaProfile(
  host: string,
  profile: string,
): boolean {
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
  );
  verifyIndexReferences(deploymentRoot, deploymentFiles);
  const workerRoutes = verifyCloudflarePagesRoutes(deploymentRoot, input.profile);
  verifyCloudflarePagesHeaders(deploymentRoot, sourceFiles);
  verifyCloudflarePagesRedirects(deploymentRoot);

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

  for (const required of ['index.html', 'manifest.webmanifest', 'service-worker.js']) {
    if (!sourceFiles.some((file) => file.path === required)) {
      throw new Error(`The source PWA artifact is missing ${required}.`);
    }
  }

  const bytesByPath = new Map(sourceFiles.map((file) => [file.path, file.bytes] as const));
  const precacheEntries = listPrecacheEntries(sourceRoot);

  for (const entry of precacheEntries) {
    const file = entry.url.replace(/^\.\//u, '');

    if (!bytesByPath.has(file)) {
      throw new Error(`The source PWA artifact precache URL has no artifact file: ${entry.url}`);
    }
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

  return hostFiles;
}

function readLegalSitePages(deploymentRoot: string): Set<string> {
  const manifestPath = `${deploymentRoot}/legal-site.json`;

  if (!existsSync(manifestPath)) {
    return new Set();
  }

  const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
  const pages = new Set<string>();

  if (typeof parsed !== 'object' || parsed === null || !Array.isArray(
    (parsed as Record<string, unknown>).pages,
  )) {
    throw new Error('The deployment legal-site.json must declare a pages array.');
  }

  for (const page of (parsed as { pages: readonly unknown[] }).pages) {
    if (typeof page !== 'object' || page === null) {
      throw new Error('The deployment legal-site.json page entries must be objects.');
    }

    const path = (page as Record<string, unknown>).path;

    if (typeof path !== 'string' || !path.startsWith('/') || !path.endsWith('/')) {
      throw new Error(`The deployment legal-site.json page path is malformed: ${String(path)}`);
    }

    const relative = `${path.replace(/^\//u, '')}index.html`;
    const absolute = resolve(deploymentRoot, relative);

    if (dirname(absolute) === deploymentRoot || !absolute.startsWith(`${deploymentRoot}/`)) {
      throw new Error(
        `The deployment legal-site.json page path escapes the deployment root: ${path}`,
      );
    }

    pages.add(relative);
  }

  return pages;
}

function verifyIndexReferences(
  deploymentRoot: string,
  deploymentFiles: readonly ArtifactFile[],
): void {
  const index = deploymentFiles.find((file) => file.path === 'index.html');

  if (index === undefined) {
    throw new Error('The deployment is missing index.html.');
  }

  const html = index.bytes.toString('utf8');
  const deploymentPaths = new Set(deploymentFiles.map((file) => file.path));
  const referenced = new Set<string>();

  for (const match of html.matchAll(/(?:href|src)\s*=\s*["']([^"']+)["']/gu)) {
    const reference = match[1] ?? '';
    const schemeSeparated = /^([a-z][a-z0-9+.-]*):/iu.exec(reference);

    if (
      reference.length === 0
      || reference.startsWith('#')
      || reference.startsWith('//')
      || (schemeSeparated !== null && schemeSeparated[1] !== undefined)
    ) {
      continue;
    }

    const withoutQuery = reference.split(/[?#]/u)[0] ?? reference;

    if (withoutQuery.length === 0) {
      continue;
    }

    const normalized = posix.normalize(
      withoutQuery.startsWith('/') ? withoutQuery.slice(1) : `./${withoutQuery}`,
    );

    if (normalized.startsWith('../') || normalized === '..' || posix.isAbsolute(normalized)) {
      throw new Error(
        `The deployment index.html references a path outside the artifact root: ${reference}`,
      );
    }

    referenced.add(normalized);
  }

  for (const reference of [...referenced].sort()) {
    if (!deploymentPaths.has(reference)) {
      throw new Error(
        `The deployment index.html references a missing file: ${reference} `
          + `(resolved under ${deploymentRoot}).`,
      );
    }
  }
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

function verifyCloudflarePagesHeaders(
  deploymentRoot: string,
  sourceFiles: readonly ArtifactFile[],
): void {
  const headersPath = `${deploymentRoot}/_headers`;

  if (!existsSync(headersPath)) {
    throw new Error('The deployment is missing _headers.');
  }

  const blocks = parseCloudflarePagesHeaders(readFileSync(headersPath, 'utf8'));
  const sourcePaths = new Set(sourceFiles.map((file) => file.path));
  const topLevelDirectories = new Set(
    sourceFiles.map((file) => (file.path.includes('/') ? file.path.split('/')[0] : '')),
  );

  const requirements: {
    readonly requestPath: string;
    readonly expected: string;
    readonly label: string;
  }[] = [];

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

  for (const directory of [
    ...immutableCacheControlDirectories,
    ...noStoreCacheControlDirectories,
  ]) {
    if (topLevelDirectories.has(directory)) {
      requirements.push({
        requestPath: `/${directory}/*`,
        expected: immutableCacheControlDirectories.has(directory)
          ? immutableCacheControl
          : noStoreCacheControl,
        label: `${directory} files`,
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

    if (effective.value !== requirement.expected) {
      throw new Error(
        `Cloudflare Pages cache policy for ${requirement.label} is wrong: expected `
          + `${requirement.expected} for ${requirement.requestPath} but the effective `
          + `value is ${effective.value}.`,
      );
    }
  }
}

function verifyCloudflarePagesRedirects(deploymentRoot: string): void {
  const redirectsPath = `${deploymentRoot}/_redirects`;

  if (!existsSync(redirectsPath)) {
    throw new Error('The deployment is missing _redirects.');
  }

  const rules = parseCloudflarePagesRedirects(readFileSync(redirectsPath, 'utf8'));

  for (const rule of rules) {
    if (pwaEntryRedirectSources.has(rule.source)) {
      throw new Error(
        `The deployment _redirects moves the PWA entry point ${rule.source} to `
          + `${rule.destination}; the game root must serve the PWA index directly.`,
      );
    }

    const protectedTargets = new Set([
      '/manifest.webmanifest',
      '/service-worker.js',
      '/pwa-release.json',
      '/index.html',
    ]);

    if (protectedTargets.has(rule.source)) {
      throw new Error(
        `The deployment _redirects moves the PWA-critical file ${rule.source}; `
          + 'service worker, manifest, and release evidence must be served directly.',
      );
    }
  }
}
