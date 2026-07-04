import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';

import { verifyTargetArtifacts } from './verify-target-artifacts';

const generatedPaths = [
  'artifacts/target-config',
  'artifacts/release-manifest.json',
  'release-output/android/app-release.aab',
  'release-output/ait/mpgd-kit.ait',
  'apps/target-devvit/dist',
];

for (const path of generatedPaths) {
  rmSync(path, { force: true, recursive: true });
}

for (const script of ['build:web', 'build:android', 'build:ios', 'build:ait', 'build:devvit']) {
  run('pnpm', [script]);
}

verifyTargetArtifacts();

function run(command: string, args: readonly string[]): void {
  const result = spawnSync(command, [...args], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  });

  if (result.error !== undefined) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}.`);
  }
}
