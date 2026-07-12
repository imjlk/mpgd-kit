import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const gameRoot = fileURLToPath(new URL('../', import.meta.url));
const kitPath = path.resolve(gameRoot, process.env.MPGD_KIT_PATH ?? '__DEFAULT_KIT_PATH__');
const cliBin = fileURLToPath(new URL('./bin.js', import.meta.resolve('@mpgd/cli')));
const result = spawnSync(
  process.execPath,
  [
    cliBin,
    'game',
    'accept',
    gameRoot,
    '--targets',
    'default',
    '--profile',
    'staging',
    '--ait-variant',
    'wrapper',
    '--kit-path',
    kitPath,
  ],
  {
    cwd: gameRoot,
    env: process.env,
    stdio: 'inherit',
  },
);

if (result.error !== undefined) {
  throw result.error;
}

process.exitCode = result.status ?? 1;
