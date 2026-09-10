import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  microsoftStorePwaCacheSchema,
  type MicrosoftStorePwaReleaseEvidence,
} from '../../packages/cli/src/microsoft-store-pwa-e2e';
import {
  assertMicrosoftStorePwaProvenance,
  createMicrosoftStorePwaReleaseEvidence,
  createMicrosoftStorePwaRevision,
  createMicrosoftStorePwaServiceWorker,
  listPrecacheEntries,
  readMicrosoftStorePwaReleaseEvidence,
  requireGameSpecificPwaId,
  type MicrosoftStorePwaProvenance,
  type PrecacheEntry,
} from '../../packages/cli/src/microsoft-store-pwa-release';
import { readJsonFile } from '../io';

// Shared PWA release primitives live in @mpgd/cli so the public deployment
// verifier can run without a kit checkout; this module keeps the build-time
// artifact writer and the repo-script export surface stable.

export { microsoftStorePwaCacheSchema };
export type { MicrosoftStorePwaReleaseEvidence, MicrosoftStorePwaProvenance, PrecacheEntry };
export {
  assertMicrosoftStorePwaProvenance,
  createMicrosoftStorePwaReleaseEvidence,
  createMicrosoftStorePwaRevision,
  createMicrosoftStorePwaServiceWorker,
  listPrecacheEntries,
  readMicrosoftStorePwaReleaseEvidence,
};

export function writeMicrosoftStorePwaArtifacts(input: {
  readonly artifactRoot: string;
  readonly provenance: MicrosoftStorePwaProvenance;
}): MicrosoftStorePwaReleaseEvidence {
  const artifactRoot = resolve(input.artifactRoot);
  const provenance = assertMicrosoftStorePwaProvenance(input.provenance);
  const pwaId = readPwaId(readJsonFile(`${artifactRoot}/manifest.webmanifest`));
  const artifactEntries = listPrecacheEntries(artifactRoot);
  const precacheUrls = [
    ...artifactEntries.map((entry) => entry.url),
    './pwa-release.json',
  ].sort(compareCodeUnits);
  const revision = createMicrosoftStorePwaRevision({
    ...provenance,
    precacheEntries: artifactEntries,
  });
  const evidence = createMicrosoftStorePwaReleaseEvidence({
    ...provenance,
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

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function readPwaId(input: unknown): string {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('Microsoft Store PWA manifest must be an object.');
  }

  return requireGameSpecificPwaId((input as Record<string, unknown>).id);
}
