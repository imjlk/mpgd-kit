import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';

import { verifyTargetArtifacts } from './verify-target-artifacts';

const generatedPaths = [
  'examples/phaser-starter/artifacts',
  'examples/phaser-starter/release-output',
  'apps/target-devvit/dist',
];

for (const path of generatedPaths) {
  rmSync(path, { force: true, recursive: true });
}

for (const args of [
  ['build:web'],
  ['build:microsoft-store'],
  ['build:verse8'],
  ['build:target', 'android', 'staging'],
  ['build:target', 'ios', 'staging'],
  ['build:target', 'ait', 'staging'],
  ['build:devvit'],
]) {
  run('pnpm', args);
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
