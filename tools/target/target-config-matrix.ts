import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import typia from 'typia';

import type {
  ReleaseProfile,
  TargetConfig,
  TargetConfigMatrix,
  TargetRuntimeKind,
} from '@mpgd/target-config';

import { targetConfigExtensionsFileEnv } from '../../packages/cli/src/target-config-env';
import { assertDeploymentTargetName } from '../../packages/cli/src/target-name';
import { readJsonFile } from '../io';

export const defaultTargetConfigMatrixFile = 'packages/target-config/targets.json';
export { targetConfigExtensionsFileEnv };

interface TargetConfigExtensions {
  readonly schemaVersion: 1;
  readonly targets: Readonly<Record<string, TargetConfig>>;
}

const assertTargetConfigMatrix = typia.createAssert<TargetConfigMatrix>();
const assertTargetConfigExtensions = typia.createAssert<TargetConfigExtensions>();
const releaseProfileByRuntime = {
  'web-preview': 'web-preview',
  'microsoft-store-pwa': 'microsoft-store',
  'capacitor-android': 'google-play',
  'capacitor-ios': 'app-store',
  'apps-in-toss': 'apps-in-toss',
  'devvit-web': 'devvit',
  'verse8-web': 'verse8',
} as const satisfies Record<TargetRuntimeKind, ReleaseProfile>;

export function loadTargetConfigMatrix(
  baseFile = defaultTargetConfigMatrixFile,
  extensionsFile = process.env[targetConfigExtensionsFileEnv],
): TargetConfigMatrix {
  const base = assertTargetConfigMatrix(readJsonFile(baseFile));

  if (extensionsFile === undefined || extensionsFile.trim().length === 0) {
    return base;
  }

  const normalizedExtensionsFile = extensionsFile.trim();
  const fileContent = readFileSync(normalizedExtensionsFile);
  const extensions = assertTargetConfigExtensions(
    JSON.parse(fileContent.toString('utf8')) as unknown,
  );
  const collisions = Object.keys(extensions.targets).filter(
    (target) => base.targets[target] !== undefined,
  );

  if (collisions.length > 0) {
    throw new Error(
      `Target config extensions cannot replace built-in targets: ${collisions.join(', ')}`,
    );
  }

  for (const [target, config] of Object.entries(extensions.targets)) {
    assertDeploymentTargetName(target);
    assertCustomTargetPolicy(target, config);
  }

  const digest = createHash('sha256').update(fileContent).digest('hex').slice(0, 16);

  return {
    version: `${base.version}+extensions.${digest}`,
    targets: {
      ...base.targets,
      ...extensions.targets,
    },
  };
}

function assertCustomTargetPolicy(target: string, config: TargetConfig): void {
  if (
    config.runtime === 'microsoft-store-pwa'
    || config.release.profile === 'microsoft-store'
  ) {
    throw new Error(
      `Target config extension ${target} cannot use the reserved Microsoft Store PWA runtime or release profile.`,
    );
  }

  const expectedReleaseProfile = releaseProfileByRuntime[config.runtime];

  if (config.release.profile !== expectedReleaseProfile) {
    throw new Error(
      `Target config extension ${target} runtime ${config.runtime} requires release profile ${expectedReleaseProfile}; received ${config.release.profile}.`,
    );
  }
}
