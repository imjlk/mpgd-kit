import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

import {
  assertMicrosoftStorePwaProvenance,
  createMicrosoftStorePwaReleaseEvidence,
  createMicrosoftStorePwaRevision,
  createMicrosoftStorePwaServiceWorker,
  readMicrosoftStorePwaReleaseEvidence,
  writeMicrosoftStorePwaArtifacts,
} from '../target/microsoft-store-pwa';

const sourceGitSha = '1'.repeat(40);
const kitGitSha = '2'.repeat(40);
const provenance = {
  appVersion: '1.2.3',
  buildId: 'store-42',
  sourceGitSha,
  kitGitSha,
};
const entries = [
  { url: './index.html', source: '<html></html>' },
  { url: './assets/game.js', source: 'console.log("game")' },
] as const;
const revision = createMicrosoftStorePwaRevision({
  ...provenance,
  precacheEntries: entries,
});

assert.equal(
  revision,
  createMicrosoftStorePwaRevision({
    ...provenance,
    precacheEntries: [...entries].reverse(),
  }),
  'PWA revision must not depend on directory traversal order',
);
assert.notEqual(
  revision,
  createMicrosoftStorePwaRevision({
    ...provenance,
    precacheEntries: entries.map((entry) =>
      entry.url === './assets/game.js' ? { ...entry, source: 'changed' } : entry,
    ),
  }),
  'PWA revision must change with precached content',
);
assert.notEqual(
  createMicrosoftStorePwaRevision({
    ...provenance,
    precacheEntries: [{ url: './a', source: 'bc' }],
  }),
  createMicrosoftStorePwaRevision({
    ...provenance,
    precacheEntries: [{ url: './ab', source: 'c' }],
  }),
  'PWA revision fields must have unambiguous boundaries',
);

const evidence = createMicrosoftStorePwaReleaseEvidence({
  ...provenance,
  pwaId: './fixture-game',
  revision,
  precacheUrls: ['./pwa-release.json', ...entries.map((entry) => entry.url)],
});
const worker = createMicrosoftStorePwaServiceWorker(evidence);

assert.match(worker, /cache:\s*'reload'/u);
assert.doesNotMatch(worker, /\bskipWaiting\s*\(/u);
assert.doesNotMatch(worker, /\bcaches\.match\s*\(/u);
assert.match(worker, /name\.startsWith\(CACHE_PREFIX\)/u);
assert.match(worker, /CACHE_SCOPE = encodeURIComponent\(self\.registration\.scope\)/u);
assert.match(worker, /cache\.match\(request, \{ ignoreSearch: true \}\)/u);
assert.match(worker, /if \(!response\.redirected\)/u);
assert.match(worker, /const APP_BASE_URL = self\.registration\.scope/u);
assert.match(worker, /<base href=/u);
assert.match(worker, /headers\.delete\('content-length'\)/u);
assert.doesNotMatch(worker, /return await cache\.match\(INDEX_URL\)/u);

const workerListeners = new Map<string, (event: unknown) => void>();
const redirectedIndex = new Response(
  '<!doctype html><html><head data-shell="true"></head><body></body></html>',
  {
    headers: {
      'Content-Encoding': 'gzip',
      'Content-Length': '999',
      'Content-Type': 'text/html; charset=utf-8',
    },
  },
);
Object.defineProperty(redirectedIndex, 'redirected', { value: true });
runInNewContext(worker, {
  Headers,
  Request,
  Response,
  URL,
  caches: {
    async keys() {
      return [];
    },
    async open() {
      return {
        async match() {
          return redirectedIndex;
        },
      };
    },
  },
  fetch,
  self: {
    addEventListener(type: string, listener: (event: unknown) => void) {
      workerListeners.set(type, listener);
    },
    clients: { claim: () => Promise.resolve() },
    location: { origin: 'https://example.test' },
    registration: { scope: 'https://example.test/game/' },
  },
});
let nestedNavigationResponse: Promise<Response> | undefined;
const fetchListener = workerListeners.get('fetch');
assert(fetchListener !== undefined);
fetchListener({
  request: {
    method: 'GET',
    mode: 'navigate',
    url: 'https://example.test/game/level/',
  },
  respondWith(response: Promise<Response>) {
    void (nestedNavigationResponse = response);
  },
});
assert(nestedNavigationResponse !== undefined);
const normalizedNavigation = await nestedNavigationResponse;
assert.match(
  await normalizedNavigation.text(),
  /<head data-shell="true"><base href="https:\/\/example\.test\/game\/">/u,
);
assert.equal(normalizedNavigation.headers.get('content-encoding'), null);
assert.equal(normalizedNavigation.headers.get('content-length'), null);
assert.throws(
  () => createMicrosoftStorePwaReleaseEvidence({
    ...provenance,
    pwaId: './fixture-game',
    revision,
    precacheUrls: ['./index.html', './index.html'],
  }),
  /must be unique/u,
);
assert.throws(
  () => createMicrosoftStorePwaReleaseEvidence({
    ...provenance,
    pwaId: './fixture-game',
    revision,
    precacheUrls: ['../escape.js'],
  }),
  /Unsafe PWA precache URL/u,
);
assert.throws(
  () => createMicrosoftStorePwaReleaseEvidence({
    ...provenance,
    pwaId: './',
    revision,
    precacheUrls: ['./index.html'],
  }),
  /must be game-specific/u,
);
assert.throws(
  () => assertMicrosoftStorePwaProvenance({
    ...provenance,
    sourceGitSha: 'uncommitted',
  }),
  /full 40-character hexadecimal SHA/u,
);
assert.throws(
  () => createMicrosoftStorePwaReleaseEvidence({
    ...provenance,
    pwaId: './fixture-game',
    revision,
    precacheUrls: ['./%2e%2e/escape.js'],
  }),
  /Unsafe PWA precache URL/u,
);

const artifactRoot = mkdtempSync(resolve(tmpdir(), 'mpgd-pwa-release-'));

try {
  mkdirSync(`${artifactRoot}/assets`);
  writeFileSync(`${artifactRoot}/index.html`, '<script src="./assets/game.js"></script>');
  writeFileSync(`${artifactRoot}/manifest.webmanifest`, JSON.stringify({ start_url: './' }));
  writeFileSync(`${artifactRoot}/effective-target-config.json`, '{}');
  writeFileSync(`${artifactRoot}/assets/game.js`, 'console.log("game")');
  writeFileSync(`${artifactRoot}/assets/game.js.map`, '{}');

  assert.throws(
    () => writeMicrosoftStorePwaArtifacts({ artifactRoot, provenance }),
    /manifest id/u,
  );
  writeFileSync(`${artifactRoot}/manifest.webmanifest`, JSON.stringify({ id: './fixture-game' }));

  const first = writeMicrosoftStorePwaArtifacts({ artifactRoot, provenance });
  const second = writeMicrosoftStorePwaArtifacts({ artifactRoot, provenance });

  assert.deepEqual(second, first, 'Identical artifacts must produce identical release evidence');
  assert(!first.precacheUrls.some((url) => url.endsWith('.map')));
  assert(first.precacheUrls.includes('./effective-target-config.json'));
  assert(first.precacheUrls.includes('./pwa-release.json'));
  assert.equal(
    readMicrosoftStorePwaReleaseEvidence(`${artifactRoot}/pwa-release.json`).revision,
    first.revision,
  );
  assert(
    readFileSync(`${artifactRoot}/service-worker.js`, 'utf8').includes(first.revision),
    'PWA service worker must use the release revision',
  );

  writeFileSync(`${artifactRoot}/robots.txt`, 'User-agent: *\nDisallow:\n');
  const withOverlay = writeMicrosoftStorePwaArtifacts({ artifactRoot, provenance });
  assert.notEqual(withOverlay.revision, first.revision);
  assert(withOverlay.precacheUrls.includes('./robots.txt'));
  assert(
    readFileSync(`${artifactRoot}/service-worker.js`, 'utf8').includes(withOverlay.revision),
    'PWA evidence must be regenerated after static files are overlaid',
  );
} finally {
  rmSync(artifactRoot, { recursive: true, force: true });
}

console.log('Microsoft Store PWA release smoke passed.');
