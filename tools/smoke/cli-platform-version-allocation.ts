import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { assertReleaseManifest } from '@mpgd/release-manifest';
import {
  allocatePlatformVersions,
  formatMpgdReleaseId,
  HOSTED_PWA_SHELL_VERSION_POLICY,
  type PlatformVersionLedger,
} from '@mpgd/target-config';

const repoRoot = process.cwd();
const fixtureRoot = join(repoRoot, 'node_modules', '.cache', 'mpgd-platform-version-preview');
const sourceSha = 'a'.repeat(40);
const kitSha = 'b'.repeat(40);
const configDigest = 'c'.repeat(64);

rmSync(fixtureRoot, { force: true, recursive: true });
mkdirSync(fixtureRoot, { recursive: true });

const ledgerFile = join(fixtureRoot, 'platform-versions.json');
const planFile = join(fixtureRoot, 'existing-plan.json');

const ledger: PlatformVersionLedger = {
  schemaVersion: 3,
  platforms: {
    'microsoft-store': {
      versionPolicy: HOSTED_PWA_SHELL_VERSION_POLICY,
      shellRevision: 0,
    },
    android: { versionCode: 12 },
  },
  releaseRevision: { lastAllocated: 0 },
};

// Cross-check the allocated plan against the kit's release identity and
// release manifest contracts (required test 12).
const allocation = allocatePlatformVersions({
  gameId: 'smoke-game',
  gameVersion: '0.3.27',
  kitGitSha: kitSha,
  ledger,
  sourceGitSha: sourceSha,
  targetConfigDigest: configDigest,
  targets: [{ target: 'microsoft-store' }, { target: 'android' }],
});
const plan = allocation.plan;

// An existing plan pairs with the ledger state that already recorded it.
writeFileSync(ledgerFile, `${JSON.stringify(allocation.ledger, null, 2)}\n`);
const ledgerHashBefore = sha256(ledgerFile);

{

  const manifest = assertReleaseManifest({
    adPlacementVersion: '1',
    buildId: plan.buildId,
    catalogVersion: '1',
    gameVersion: plan.gameVersion,
    gitSha: plan.sourceGitSha,
    kitGitSha: plan.kitGitSha,
    releaseId: formatMpgdReleaseId(plan.releaseLabel, plan.buildId),
    releaseIdentity: {
      gameVersion: plan.gameVersion,
      label: plan.releaseLabel,
      releaseRevision: plan.releaseRevision,
    },
    targetConfigVersion: '1',
    targets: {},
  });

  assertEqual(
    manifest.releaseId,
    `mpgd-${plan.releaseLabel}+${plan.buildId}`,
    'releaseId embeds the plan identity',
  );
  assertEqual(
    manifest.releaseIdentity?.releaseRevision,
    plan.releaseRevision,
    'manifest carries the plan revision',
  );
  writeFileSync(planFile, `${JSON.stringify(plan, null, 2)}\n`);
}

const planHashBefore = sha256(planFile);
const baseArgs = [
  'target',
  'preview-versions',
  '--ledger-file',
  ledgerFile,
  '--plan-file',
  planFile,
  '--game-id',
  'smoke-game',
  '--game-version',
  '0.3.27',
  '--source-git-sha',
  sourceSha,
  '--kit-git-sha',
  kitSha,
  '--target-config-digest',
  configDigest,
  '--targets',
  'microsoft-store,android',
];

// Required test 13: the read-only CLI leaves input files byte-identical.
const firstRun = runPreview([...baseArgs, '--json']);
const secondRun = runPreview([...baseArgs, '--json']);
assertEqual(sha256(ledgerFile), ledgerHashBefore, 'the CLI preview must not modify the ledger');
assertEqual(sha256(planFile), planHashBefore, 'the CLI preview must not modify the existing plan');

// Required test 14: identical inputs produce identical candidate output.
assertEqual(secondRun.stdout, firstRun.stdout, 'repeated preview runs are deterministic');

// Required test 15: output presents candidates, never reservations.
const parsed = JSON.parse(extractJsonDocument(firstRun.stdout)) as {
  candidate: boolean;
  note: string;
};
assertEqual(parsed.candidate, true, 'JSON output is marked as a candidate');
if (!parsed.note.includes('not reserved')) {
  throw new Error(`Preview note must state the numbers are not reserved: ${parsed.note}`);
}

const summaryRun = runPreview(baseArgs);
if (!summaryRun.stdout.includes('not reserved')) {
  throw new Error('Summary output must state the numbers are not reserved.');
}
if (summaryRun.stdout.includes('Reservation complete')) {
  throw new Error('Summary output must not claim completed reservations.');
}

// Validation failures exit non-zero without touching the ledger.
const failingRun = runPreview(
  baseArgs.slice(0, -2).concat('--targets', 'microsoft-store,play-web'),
);
assertEqual(failingRun.status, 1, 'unsupported targets exit non-zero');
assertEqual(
  sha256(ledgerFile),
  ledgerHashBefore,
  'a failed preview still leaves the ledger untouched',
);

rmSync(fixtureRoot, { force: true, recursive: true });

function runPreview(args: readonly string[]): {
  combined: string;
  stdout: string;
  status: number;
} {
  const result = spawnSync(
    process.execPath,
    ['tools/run-ttsx.mjs', '--mpgd-cli', 'packages/cli/src/bin.ts', ...args],
    {
      cwd: repoRoot,
      env: { ...process.env, MPGD_KIT_PATH: repoRoot },
      encoding: 'utf8',
      timeout: 120_000,
    },
  );

  if (result.error !== undefined) {
    throw result.error;
  }

  return {
    combined: `${result.stdout}\n${result.stderr}`,
    stdout: result.stdout,
    status: result.status ?? -1,
  };
}

function extractJsonDocument(stdout: string): string {
  const lines = stdout.split('\n');
  const start = lines.findIndex((line) => line === '{');

  if (start < 0) {
    throw new Error(`No JSON document found in preview output: ${stdout.slice(0, 200)}`);
  }

  return lines.slice(start).join('\n');
}

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function assertIncludes(haystack: string, needle: string, message: string): void {
  if (!haystack.includes(needle)) {
    throw new Error(`${message}: output did not contain "${needle}".`);
  }
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}.`);
  }
}
