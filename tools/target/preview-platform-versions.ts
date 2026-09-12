import { readFileSync } from 'node:fs';

import {
  allocatePlatformVersions,
  assertPlatformVersionLedger,
  type PlatformVersionLedger,
  type PlatformVersionReleasePlan,
  type PlatformVersionTargetRequest,
} from '@mpgd/target-config';

/**
 * Read-only platform version preview.
 *
 * Prints the candidate allocation an `allocatePlatformVersions` call would
 * produce for the given ledger and provenance. The candidate numbers are NOT
 * reservations: nothing is written, and two processes reading the same ledger
 * can compute the same candidates. Operational reservation needs external
 * serialization (see docs/PLATFORM_VERSION_ALLOCATION.md).
 */

try {
  const ledgerFile = requireEnv('MPGD_PREVIEW_LEDGER_FILE');
  const planFile = optionalEnv('MPGD_PREVIEW_PLAN_FILE');
  const gameId = requireEnv('MPGD_PREVIEW_GAME_ID');
  const gameVersion = requireEnv('MPGD_PREVIEW_GAME_VERSION');
  const sourceGitSha = requireEnv('MPGD_PREVIEW_SOURCE_GIT_SHA');
  const kitGitSha = requireEnv('MPGD_PREVIEW_KIT_GIT_SHA');
  const targetConfigDigest = requireEnv('MPGD_PREVIEW_TARGET_CONFIG_DIGEST');
  const targets = parseTargetRequests(requireEnv('MPGD_PREVIEW_TARGETS'));
  const jsonOutput = optionalEnv('MPGD_PREVIEW_JSON') === '1';
  const ledger: PlatformVersionLedger = assertPlatformVersionLedger(
    readJsonFile(ledgerFile, 'platform version ledger'),
  );
  const existingPlan: PlatformVersionReleasePlan | undefined = planFile === undefined
    ? undefined
    : (readJsonFile(planFile, 'existing release plan') as PlatformVersionReleasePlan);

  const { ledger: candidateLedger, plan } = allocatePlatformVersions({
    gameId,
    gameVersion,
    kitGitSha,
    ledger,
    sourceGitSha,
    targetConfigDigest,
    targets,
    ...(existingPlan === undefined ? {} : { existingPlan }),
  });

  const result = {
    candidate: true,
    note: 'Candidate allocation only: numbers are proposed, not reserved or persisted.',
    plan,
    ledger: candidateLedger,
  };

  if (jsonOutput) {
    write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    write(`Candidate release plan (not reserved)\n`);
    write(`  game:          ${plan.gameId} ${plan.gameVersion}\n`);
    write(`  release label: ${plan.releaseLabel}\n`);
    write(`  buildId:       ${plan.buildId}\n`);
    write(`  targets:\n`);
    for (const [target, entry] of Object.entries(plan.targets)) {
      const details = Object.entries(entry)
        .filter(([key]) => key !== 'buildId' && key !== 'releaseLabel')
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(' ');
      write(`    ${target}: ${details === '' ? '(identity only)' : details}\n`);
    }
    write(`  candidate ledger:\n`);
    write(
      `    releaseRevision.lastAllocated: ${String(candidateLedger.releaseRevision.lastAllocated)}\n`,
    );
    for (const [platform, entry] of Object.entries(candidateLedger.platforms)) {
      write(`    ${platform}: ${JSON.stringify(entry)}\n`);
    }
    write(
      'Candidates are proposals only. Reservation requires operational serialization '
        + 'outside this preview; the input files were not modified.\n',
    );
  }
} catch (cause) {
  writeError(
    `Platform version preview failed: ${cause instanceof Error ? cause.message : String(cause)}\n`,
  );
  process.exit(1);
}

function parseTargetRequests(raw: string): PlatformVersionTargetRequest[] {
  return raw.split(',').map((piece) => {
    const trimmed = piece.trim();

    if (trimmed.length === 0) {
      throw new Error(`MPGD_PREVIEW_TARGETS contains an empty target near "${raw}".`);
    }

    const separatorIndex = trimmed.indexOf(':');
    const target = separatorIndex < 0 ? trimmed : trimmed.slice(0, separatorIndex);
    const intent = separatorIndex < 0 ? undefined : trimmed.slice(separatorIndex + 1);

    if (
      intent !== undefined
      && intent !== 'package-upload'
      && intent !== 'hosted-content-only'
    ) {
      throw new Error(
        `MPGD_PREVIEW_TARGETS entry "${trimmed}" has an unknown intent "${intent}" `
          + '(expected package-upload or hosted-content-only).',
      );
    }

    return {
      target: target as PlatformVersionTargetRequest['target'],
      ...(intent === undefined ? {} : { intent }),
    };
  });
}

function readJsonFile(file: string, label: string): unknown {
  let text: string;

  try {
    text = readFileSync(file, 'utf8');
  } catch (cause) {
    throw new Error(`Could not read ${label} at ${file}.`, { cause });
  }

  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new Error(`${label} at ${file} is not valid JSON.`, { cause });
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];

  if (value === undefined || value.trim().length === 0) {
    throw new Error(`Missing required environment variable: ${name}.`);
  }

  return value.trim();
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name];

  return value === undefined || value.trim().length === 0 ? undefined : value.trim();
}

function write(text: string): void {
  process.stdout.write(text);
}

function writeError(text: string): void {
  process.stderr.write(text);
}
