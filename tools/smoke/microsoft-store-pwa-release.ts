import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import {
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
  assert(readFileSync(`${artifactRoot}/service-worker.js`, 'utf8').includes(first.cacheName));
} finally {
  rmSync(artifactRoot, { recursive: true, force: true });
}

console.log('Microsoft Store PWA release smoke passed.');
