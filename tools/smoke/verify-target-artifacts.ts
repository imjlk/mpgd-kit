import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';

import typia from 'typia';

import type { ReleaseManifest } from '@mpgd/release-manifest';

import { readJsonFile } from '../io';

const requiredTargets = ['web-preview', 'android', 'ios', 'ait'] as const;
type SmokeTarget = (typeof requiredTargets)[number];

const knownTargets = new Set<string>(requiredTargets);
const assertReleaseManifest = typia.createAssert<ReleaseManifest>();

const requiredArtifacts: Record<SmokeTarget, string> = {
  'web-preview': 'artifacts/web-preview/index.html',
  android: 'release-output/android/app-release.aab',
  ios: 'apps/mobile-capacitor/ios',
  ait: 'release-output/ait/mpgd-kit.ait',
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

    const effectiveConfigContent = readFileSync(entry.effectiveConfig.path, 'utf8');
    const effectiveConfigDigest = sha256(effectiveConfigContent);
    const effectiveConfig = JSON.parse(effectiveConfigContent) as { readonly target?: string };

    if (effectiveConfig.target !== target) {
      throw new Error(
        `Release manifest target ${target} points to effective config for ${String(
          effectiveConfig.target,
        )}.`,
      );
    }

    if (effectiveConfigDigest !== entry.effectiveConfig.digest) {
      throw new Error(`Release manifest target ${target} effective config digest mismatch.`);
    }
  }

  console.log(`Target smoke passed: ${targets.join(', ')}`);
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
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
