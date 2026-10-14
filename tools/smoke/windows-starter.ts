import { spawnSync } from 'node:child_process';

// run-ttsx --compile-once validates KIT before the generated workspace install
// rewires workspace package dependency links. Nested target commands inherit
// the checked emit and its source-checkout marker until this child finishes.
const result = spawnSync(process.execPath, ['tools/smoke/windows-starter-consumer.mjs'], {
  stdio: 'inherit',
  env: process.env,
});
if (result.error !== undefined) {
  throw result.error;
}
process.exit(result.status ?? 1);
