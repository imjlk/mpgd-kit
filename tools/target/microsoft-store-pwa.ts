import { createHash, type Hash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

import { readJsonFile } from '../io';

export const microsoftStorePwaCacheSchema = 'microsoft-store-offline-v1';

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
  readonly cacheName: string;
  readonly precacheUrls: readonly string[];
}

export interface MicrosoftStorePwaProvenance {
  readonly appVersion: string;
  readonly buildId: string;
  readonly sourceGitSha: string;
  readonly kitGitSha: string;
}

interface PrecacheEntry {
  readonly url: string;
  readonly source: string | Uint8Array;
}

export function writeMicrosoftStorePwaArtifacts(input: {
  readonly artifactRoot: string;
  readonly provenance: MicrosoftStorePwaProvenance;
}): MicrosoftStorePwaReleaseEvidence {
  const artifactRoot = resolve(input.artifactRoot);
  const manifest = readJsonFile(`${artifactRoot}/manifest.webmanifest`);
  const pwaId = readPwaId(manifest);
  const artifactEntries = listPrecacheEntries(artifactRoot);
  const precacheUrls = [
    ...artifactEntries.map((entry) => entry.url),
    './pwa-release.json',
  ].sort(compareCodeUnits);
  const revision = createMicrosoftStorePwaRevision({
    ...input.provenance,
    precacheEntries: artifactEntries,
  });
  const evidence = createMicrosoftStorePwaReleaseEvidence({
    ...input.provenance,
    pwaId,
    revision,
    precacheUrls,
  });

  writeFileSync(`${artifactRoot}/pwa-release.json`, `${JSON.stringify(evidence, null, 2)}\n`);
  writeFileSync(
    `${artifactRoot}/service-worker.js`,
    createMicrosoftStorePwaServiceWorker(evidence),
  );

  return evidence;
}

export function createMicrosoftStorePwaRevision(input: {
  readonly appVersion: string;
  readonly buildId: string;
  readonly sourceGitSha: string;
  readonly kitGitSha: string;
  readonly precacheEntries: readonly PrecacheEntry[];
}): string {
  const hash = createHash('sha256');
  const release = {
    appVersion: requireNonEmptyString(input.appVersion, 'PWA app version'),
    buildId: requireNonEmptyString(input.buildId, 'PWA build ID'),
    sourceGitSha: requireGitSha(input.sourceGitSha, 'PWA source Git SHA'),
    kitGitSha: requireGitSha(input.kitGitSha, 'PWA kit Git SHA'),
  };

  updateRevisionField(hash, microsoftStorePwaCacheSchema);
  updateRevisionField(hash, JSON.stringify(release));

  for (const entry of normalizePrecacheEntries(input.precacheEntries)) {
    updateRevisionField(hash, entry.url);
    updateRevisionField(hash, entry.source);
  }

  return hash.digest('hex').slice(0, 16);
}

export function createMicrosoftStorePwaReleaseEvidence(input: {
  readonly pwaId: string;
  readonly appVersion: string;
  readonly buildId: string;
  readonly sourceGitSha: string;
  readonly kitGitSha: string;
  readonly revision: string;
  readonly precacheUrls: readonly string[];
}): MicrosoftStorePwaReleaseEvidence {
  const pwaId = requireGameSpecificPwaId(input.pwaId);
  const revision = requireRevision(input.revision);
  const cachePrefix = `mpgd-pwa-${createHash('sha256').update(pwaId).digest('hex').slice(0, 12)}-`;

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
    cacheName: `${cachePrefix}${revision}`,
    precacheUrls: normalizePrecacheUrls(input.precacheUrls),
  };
}

export function createMicrosoftStorePwaServiceWorker(
  evidence: MicrosoftStorePwaReleaseEvidence,
): string {
  const cacheName = requireNonEmptyString(evidence.cacheName, 'PWA cache name');
  const cachePrefix = requireNonEmptyString(evidence.cachePrefix, 'PWA cache prefix');
  const precacheUrls = normalizePrecacheUrls(evidence.precacheUrls);

  return `'use strict';

const CACHE_NAME = ${JSON.stringify(cacheName)};
const CACHE_PREFIX = ${JSON.stringify(cachePrefix)};
const PRECACHE_URLS = ${JSON.stringify(precacheUrls, null, 2)};
const INDEX_URL = new URL('./index.html', self.registration.scope).href;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);

    try {
      const requests = PRECACHE_URLS.map((url) => new Request(
        new URL(url, self.registration.scope),
        { cache: 'reload' },
      ));
      await cache.addAll(requests);
    } catch (error) {
      try {
        await caches.delete(CACHE_NAME);
      } catch {
        // Preserve the original installation error when cleanup also fails.
      }
      throw error;
    }
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const cacheNames = await caches.keys();
    await Promise.all(
      cacheNames
        .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
        .map((name) => caches.delete(name)),
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;

  if (request.method !== 'GET') {
    return;
  }

  const url = new URL(request.url);

  if (url.origin !== self.location.origin) {
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      return await cache.match(INDEX_URL) ?? fetch(request);
    })());
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    return await cache.match(request) ?? fetch(request);
  })());
});
`;
}

export function readMicrosoftStorePwaReleaseEvidence(
  path: string,
): MicrosoftStorePwaReleaseEvidence {
  const input = readJsonFile(path);

  if (!isRecord(input)) {
    throw new Error('PWA release evidence must be an object.');
  }

  if (input.schemaVersion !== 1 || input.cacheSchema !== microsoftStorePwaCacheSchema) {
    throw new Error('Unsupported Microsoft Store PWA release evidence schema.');
  }

  if (input.configTarget !== 'microsoft-store') {
    throw new Error('PWA release evidence must target microsoft-store.');
  }

  if (!Array.isArray(input.precacheUrls)) {
    throw new Error('PWA release evidence precacheUrls must be an array.');
  }

  const evidence = createMicrosoftStorePwaReleaseEvidence({
    pwaId: requireNonEmptyString(input.pwaId, 'PWA ID'),
    appVersion: requireNonEmptyString(input.appVersion, 'PWA app version'),
    buildId: requireNonEmptyString(input.buildId, 'PWA build ID'),
    sourceGitSha: requireGitSha(input.sourceGitSha, 'PWA source Git SHA'),
    kitGitSha: requireGitSha(input.kitGitSha, 'PWA kit Git SHA'),
    revision: requireRevision(input.revision),
    precacheUrls: input.precacheUrls.map((value) =>
      requireNonEmptyString(value, 'PWA precache URL'),
    ),
  });

  if (input.cachePrefix !== evidence.cachePrefix || input.cacheName !== evidence.cacheName) {
    throw new Error('PWA release evidence cache identity is inconsistent.');
  }

  return evidence;
}

function listPrecacheEntries(artifactRoot: string): readonly PrecacheEntry[] {
  const files: string[] = [];
  const pendingDirectories = [artifactRoot];

  while (pendingDirectories.length > 0) {
    const directory = pendingDirectories.pop();

    if (directory === undefined) {
      throw new Error('PWA artifact traversal lost its directory.');
    }

    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);

      if (entry.isDirectory()) {
        pendingDirectories.push(path);
      } else if (entry.isFile()) {
        files.push(path);
      }
    }
  }

  return files
    .filter((path) =>
      !path.endsWith('.map')
      && !path.endsWith(`${sep}pwa-release.json`)
      && !path.endsWith(`${sep}service-worker.js`),
    )
    .map((path) => ({
      url: toPrecacheUrl(artifactRoot, path),
      source: readFileSync(path),
    }))
    .sort((left, right) => compareCodeUnits(left.url, right.url));
}

function normalizePrecacheEntries(entries: readonly PrecacheEntry[]): readonly PrecacheEntry[] {
  const entriesByUrl = new Map<string, string | Uint8Array>();

  for (const entry of entries) {
    const url = requirePrecacheUrl(entry.url);

    if (entriesByUrl.has(url)) {
      throw new Error(`Duplicate PWA precache URL: ${url}`);
    }

    if (typeof entry.source !== 'string' && !(entry.source instanceof Uint8Array)) {
      throw new Error(`PWA precache source must be bytes or text: ${url}`);
    }

    entriesByUrl.set(url, entry.source);
  }

  return [...entriesByUrl.entries()]
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([url, source]) => ({ url, source }));
}

function normalizePrecacheUrls(urls: readonly string[]): readonly string[] {
  const normalized = urls.map(requirePrecacheUrl);

  if (new Set(normalized).size !== normalized.length) {
    throw new Error('PWA precache URLs must be unique.');
  }

  return normalized.sort(compareCodeUnits);
}

function toPrecacheUrl(root: string, path: string): string {
  const portablePath = relative(root, path).split(sep).join('/');
  return requirePrecacheUrl(`./${portablePath}`);
}

function requirePrecacheUrl(value: string): string {
  const url = requireNonEmptyString(value, 'PWA precache URL');

  if (
    !url.startsWith('./')
    || url.includes('\\')
    || url.includes('?')
    || url.includes('#')
    || url.split('/').includes('..')
  ) {
    throw new Error(`Unsafe PWA precache URL: ${url}`);
  }

  return url;
}

function readPwaId(input: unknown): string {
  if (!isRecord(input)) {
    throw new Error('Microsoft Store PWA manifest must be an object.');
  }

  return requireGameSpecificPwaId(input.id);
}

function requireGameSpecificPwaId(value: unknown): string {
  const pwaId = requireNonEmptyString(value, 'Microsoft Store PWA manifest id');

  if (pwaId === '.' || pwaId === './' || pwaId === '/') {
    throw new Error('Microsoft Store PWA manifest id must be game-specific.');
  }

  return pwaId;
}

function updateRevisionField(hash: Hash, value: string | Uint8Array): void {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;

  hash.update(`${String(bytes.byteLength)}:`);
  hash.update(bytes);
}

function requireGitSha(value: unknown, label: string): string {
  const sha = requireNonEmptyString(value, label);

  if (!/^[0-9a-f]{40}$/u.test(sha)) {
    throw new Error(`${label} must be a full 40-character hexadecimal SHA.`);
  }

  return sha;
}

function requireRevision(value: unknown): string {
  const revision = requireNonEmptyString(value, 'PWA revision');

  if (!/^[0-9a-f]{16}$/u.test(revision)) {
    throw new Error('PWA revision must be a 16-character hexadecimal digest.');
  }

  return revision;
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }

  return value.trim();
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}
