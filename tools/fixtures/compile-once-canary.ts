import { spawnSync } from 'node:child_process';

// Invoked through `run-ttsx.mjs --compile-once` by the untransformed Node smoke
// runner. The nested runner must reuse this command's emitted tools program.
process.stdout.write(`MPGD_COMPILE_ONCE_EMIT_ROOT=${process.env.MPGD_CI_EMIT_ROOT ?? ''}\n`);
const nested = spawnSync(
  process.execPath,
  ['tools/run-ttsx.mjs', 'tools/fixtures/ttsx-assertion-canary.ts', ...process.argv.slice(2)],
  { stdio: 'inherit' },
);
process.exit(nested.status ?? 1);
