import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import typia from 'typia';

import type { TargetConfig, TargetConfigMatrix } from '@mpgd/target-config';

import { readJsonFile } from '../io';

export const defaultTargetConfigMatrixFile = 'packages/target-config/targets.json';
export const targetConfigExtensionsFileEnv = 'MPGD_TARGET_CONFIG_EXTENSIONS_FILE';

interface TargetConfigExtensions {
  readonly schemaVersion: 1;
  readonly targets: Readonly<Record<string, TargetConfig>>;
}

const assertTargetConfigMatrix = typia.createAssert<TargetConfigMatrix>();
const assertTargetConfigExtensions = typia.createAssert<TargetConfigExtensions>();

export function loadTargetConfigMatrix(
  baseFile = defaultTargetConfigMatrixFile,
  extensionsFile = process.env[targetConfigExtensionsFileEnv],
): TargetConfigMatrix {
  const base = assertTargetConfigMatrix(readJsonFile(baseFile));

  if (extensionsFile === undefined || extensionsFile.trim().length === 0) {
    return base;
  }

  const normalizedExtensionsFile = extensionsFile.trim();
  const extensions = assertTargetConfigExtensions(readJsonFile(normalizedExtensionsFile));
  const collisions = Object.keys(extensions.targets).filter(
    (target) => base.targets[target] !== undefined,
  );

  if (collisions.length > 0) {
    throw new Error(
      `Target config extensions cannot replace built-in targets: ${collisions.join(', ')}`,
    );
  }

  const digest = createHash('sha256')
    .update(readFileSync(normalizedExtensionsFile))
    .digest('hex')
    .slice(0, 16);

  return {
    version: `${base.version}+extensions.${digest}`,
    targets: {
      ...base.targets,
      ...extensions.targets,
    },
  };
}
