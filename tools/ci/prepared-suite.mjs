import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// Keep the local prepared command and the isolated CI jobs on one manifest.
// Order is significant within a group; the groups have separate checkouts.
export const preparedGroups = Object.freeze({
  contracts: [
    'test:tooling',
    'test:ttsx-assertions',
    'test:cli-output',
    'test:icons',
    'test:target-artifacts',
    'smoke:target-config:dist',
    'smoke:game-services:dist',
    'smoke:tutorial:dist',
    'build:tutorial',
    'test:workspaces',
    'smoke:target-config',
    'smoke:target-config-extensions',
    'smoke:effective-config',
    'smoke:game-config',
    'smoke:phaser-assets-archive-decode',
    'smoke:release-manifest-merge',
    'smoke:adapter-effective-config',
    'smoke:platform-capability-conformance',
    'smoke:storage-adapter-conformance',
  ],
  cli: [
    'smoke:platform-version-allocation',
    'smoke:microsoft-store-pwa-release',
    'smoke:cli-hosted-pwa-deployment',
    'smoke:cli-kit-upgrade',
    'smoke:cli-asset-pack-build',
    'smoke:cli-asset-pack-verify',
    'smoke:cli-configured-web-targets',
    'smoke:cli-game-release-inputs',
    'smoke:cli-game-acceptance',
    'smoke:cli-gameplay-e2e',
    'smoke:cli-browser-gameplay-e2e',
    'smoke:cli-offline-playtest',
    'smoke:cli-microsoft-store-pwa-e2e',
    'smoke:cli-microsoft-store-submission',
    'smoke:cli-microsoft-store-package-generation',
    'smoke:cli-microsoft-store-package-acceptance',
    'smoke:cli-microsoft-store-starter-onboarding',
    'smoke:cli-capacitor-shell-starter',
    'smoke:cli-deploy-planning',
    'smoke:cli-deploy-process',
    'smoke:cli-release-workspace',
    'smoke:cli-release-state',
    // The real CLI tarball + registry install + cap add smoke remains a local
    // release acceptance command; it deliberately does not run on every PR.
  ],
  services: [
    'smoke:production-target-readiness',
    'smoke:native-release-identity',
    'smoke:verse8-agent8-acceptance',
    'smoke:admob-ssv-conformance',
    'smoke:google-play-purchase',
    'smoke:app-store-purchase',
    'smoke:game-services:prepared',
    'smoke:game-services:worker:prepared',
  ],
});

export function resolvePreparedScript(script, checked) {
  if (script === 'test:workspaces') {
    // The worker gets its own build/test below, not a second workspace test.
    return 'test:workspaces:prepared';
  }
  if (checked && script === 'smoke:game-services:worker:prepared') {
    // CI's prepare job already ran the worker's check through pnpm check.
    return 'smoke:game-services:worker:checked';
  }
  return script;
}

// These scripts validate ttsx itself or dynamically import authored .ts
// configs with extensionless imports that Node's compiled runner cannot load.
const scriptsRequiringTtsx = new Set(['test:ttsx-assertions', 'smoke:game-config']);

export function requiresTtsx(script) {
  return scriptsRequiringTtsx.has(script);
}

function run() {
  const requestedGroup = process.argv[2] ?? 'all';
  const checked = process.argv.slice(3).includes('--checked');
  if (requestedGroup === '--list') {
    process.stdout.write(`${JSON.stringify(preparedGroups, null, 2)}\n`);
    return;
  }
  const groups = requestedGroup === 'all'
    ? Object.entries(preparedGroups)
    : [[requestedGroup, preparedGroups[requestedGroup]]];
  if (groups.some(([, scripts]) => scripts === undefined)) {
    throw new Error(`Unknown prepared test group: ${requestedGroup}`);
  }

  const results = [];
  for (const [group, scripts] of groups) {
    for (const script of scripts) {
      const invokedScript = resolvePreparedScript(script, checked);
      const start = process.hrtime.bigint();
      process.stdout.write(`\n${process.env.GITHUB_ACTIONS ? '::group::' : ''}${group}: ${invokedScript}\n`);
      const child = spawnSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['run', invokedScript], {
        cwd: repoRoot,
        // Preserve ttsx semantics where a smoke needs its runtime hooks.
        env: requiresTtsx(script)
          ? { ...process.env, MPGD_FORCE_TTSX: '1' }
          : process.env,
        stdio: 'inherit',
      });
      if (process.env.GITHUB_ACTIONS) process.stdout.write('::endgroup::\n');
      const seconds = Number(process.hrtime.bigint() - start) / 1e9;
      const exitCode = child.status ?? 1;
      results.push({ group, script: invokedScript, seconds, exitCode });
      process.stdout.write(`Prepared test ${invokedScript}: ${seconds.toFixed(1)}s, exit ${exitCode}\n`);
      if (child.error) process.stderr.write(`${child.error.message}\n`);
      if (exitCode !== 0) {
        writeSummary(results);
        process.exitCode = exitCode;
        return;
      }
    }
  }
  writeSummary(results);
}

function writeSummary(results) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  const rows = results.map(({ group, script, seconds, exitCode }) =>
    `| ${group} | \`${script}\` | ${seconds.toFixed(1)} | ${exitCode} |`);
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, [
    '### Prepared test timings',
    '',
    '| Group | Command | Seconds | Exit |',
    '| --- | --- | ---: | ---: |',
    ...rows,
    '',
  ].join('\n'));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run();
}
