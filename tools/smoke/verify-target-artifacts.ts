import { existsSync, statSync } from 'node:fs';

import typia from 'typia';

import type { ReleaseManifest } from '@mpgd/release-manifest';

import { readJsonFile } from '../io';
import {
  assertEmbeddedTargetConfig,
  embeddedTargetConfigFileName,
  readEmbeddedTargetConfigFromDirectory,
  readEmbeddedTargetConfigFromFile,
  readEmbeddedTargetConfigFromZip,
  type EmbeddedTargetConfigEvidence,
} from './embedded-target-config';

const requiredTargets = ['web-preview', 'android', 'ios', 'ait', 'reddit'] as const;
type SmokeTarget = (typeof requiredTargets)[number];

const knownTargets = new Set<string>(requiredTargets);
const assertReleaseManifest = typia.createAssert<ReleaseManifest>();

const requiredArtifacts: Record<SmokeTarget, string> = {
  'web-preview': 'artifacts/web-preview/index.html',
  android: 'release-output/android/app-release.aab',
  ios: 'apps/mobile-capacitor/ios',
  ait: 'release-output/ait/mpgd-kit.ait',
  reddit: 'apps/target-devvit/dist/client/index.html',
};

export function verifyTargetArtifacts(targets: readonly SmokeTarget[] = requiredTargets): void {
  const manifest = assertReleaseManifest(readJsonFile('artifacts/release-manifest.json'));

  for (const target of targets) {
    const entry = manifest.targets[target];

    if (entry === undefined) {
      throw new Error(`Missing release manifest target: ${target}`);
    }

    const expectedArtifact = requiredArtifacts[target];
    assertPathExists(expectedArtifact, `${target} artifact`);

    if (entry.artifact.length === 0) {
      throw new Error(`Release manifest target ${target} has an empty artifact path.`);
    }

    assertPathExists(entry.effectiveConfig.path, `${target} effective target config`);

    assertEmbeddedTargetConfig(
      readEmbeddedTargetConfigFromFile(
        entry.effectiveConfig.path,
        `${target} effective target config artifact`,
      ),
      {
        target,
        digest: entry.effectiveConfig.digest,
      },
    );
    assertEmbeddedTargetConfig(readReleaseEmbeddedTargetConfig(target), {
      target,
      digest: entry.effectiveConfig.digest,
    });
  }

  console.log(`Target smoke passed: ${targets.join(', ')}`);
}

function readReleaseEmbeddedTargetConfig(target: SmokeTarget): EmbeddedTargetConfigEvidence {
  switch (target) {
    case 'web-preview':
      return readEmbeddedTargetConfigFromFile(
        `artifacts/web-preview/${embeddedTargetConfigFileName}`,
        'web-preview artifact',
      );
    case 'android':
      return readEmbeddedTargetConfigFromZip(requiredArtifacts.android, 'android release AAB');
    case 'ios':
      return readEmbeddedTargetConfigFromDirectory(requiredArtifacts.ios, 'ios native artifact');
    case 'ait':
      try {
        return readEmbeddedTargetConfigFromZip(requiredArtifacts.ait, 'ait release artifact');
      } catch {
        return readEmbeddedTargetConfigFromDirectory(
          'apps/target-ait/public/game',
          'ait wrapper webDir',
        );
      }
    case 'reddit':
      return readEmbeddedTargetConfigFromDirectory(
        'apps/target-devvit/dist/client',
        'reddit Devvit client artifact',
      );
  }
}

function assertPathExists(path: string, label: string): void {
  if (!existsSync(path)) {
    throw new Error(`Missing ${label}: ${path}`);
  }

  const stat = statSync(path);

  if (!stat.isFile() && !stat.isDirectory()) {
    throw new Error(`${label} is not a file or directory: ${path}`);
  }
}

function readRequestedTargets(args: readonly string[]): readonly SmokeTarget[] {
  if (args.length === 0) {
    return requiredTargets;
  }

  return args.map((target) => {
    if (!knownTargets.has(target)) {
      throw new Error(`Unknown target smoke target: ${target}`);
    }

    return target as SmokeTarget;
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  verifyTargetArtifacts(readRequestedTargets(process.argv.slice(2)));
}
