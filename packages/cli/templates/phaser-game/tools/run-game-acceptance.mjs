import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runMpgdCli } from '@mpgd/cli';

const gameRoot = fileURLToPath(new URL('../', import.meta.url));
const configuredKitPath = process.env.MPGD_KIT_PATH;
const kitPath = path.resolve(
  gameRoot,
  configuredKitPath === undefined || configuredKitPath.length === 0
    ? '__DEFAULT_KIT_PATH__'
    : configuredKitPath,
);

await runMpgdCli([
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
]);
