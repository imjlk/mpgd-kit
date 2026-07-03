import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import typia from 'typia';

import type { AdPlacements } from '@mpgd/ad-placements';
import type { ProductCatalog } from '@mpgd/product-catalog';
import type { ReleaseManifest } from '@mpgd/release-manifest';

import { isCliEntrypoint, readJsonFile } from '../io';

const assertProductCatalog = typia.createAssert<ProductCatalog>();
const assertAdPlacements = typia.createAssert<AdPlacements>();
const assertReleaseManifest = typia.createAssert<ReleaseManifest>();

export interface GenerateReleaseManifestInput {
  readonly target: string;
  readonly profile: string;
  readonly artifact: string;
  readonly outputPath?: string;
}

export function generateReleaseManifest(input: GenerateReleaseManifestInput): ReleaseManifest {
  const packageJson = readJsonFile('package.json') as { version?: string };
  const catalog = assertProductCatalog(readJsonFile('packages/product-catalog/catalog.json'));
  const adPlacements = assertAdPlacements(readJsonFile('packages/ad-placements/placements.json'));
  const buildId = process.env.BUILD_ID ?? createBuildId();
  const gameVersion = process.env.APP_VERSION ?? packageJson.version ?? '0.0.0';

  return assertReleaseManifest({
    releaseId: `mpgd-${gameVersion}+${buildId}`,
    gitSha: getGitSha(),
    gameVersion,
    buildId,
    catalogVersion: catalog.version,
    adPlacementVersion: adPlacements.version,
    targets: {
      [input.target]: {
        artifact: input.artifact,
        profile: input.profile,
        ...(input.target === 'ait' ? { appName: 'mpgd-kit', sdkMajor: 2 } : {}),
      },
    },
  });
}

export function writeReleaseManifest(input: GenerateReleaseManifestInput): ReleaseManifest {
  const outputPath = input.outputPath ?? 'release-output/release-manifest.json';
  const manifest = generateReleaseManifest(input);

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(`${outputPath}`, `${JSON.stringify(manifest, null, 2)}\n`);

  return manifest;
}

function createBuildId(): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replaceAll('-', '');
  const time = now.toISOString().slice(11, 19).replaceAll(':', '');
  return `${date}.${time}`;
}

function getGitSha(): string {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'uncommitted';
  }
}

if (isCliEntrypoint(import.meta.url)) {
  const [target = 'web-preview', profile = 'production', artifact = 'artifacts/web-preview'] =
    process.argv.slice(2);
  const manifest = writeReleaseManifest({ target, profile, artifact });
  console.log(`Release manifest: ${manifest.releaseId}`);
}
