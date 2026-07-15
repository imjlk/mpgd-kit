import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

import {
  escapeMarkdownInline,
  escapeMarkdownTable,
  formatDuration,
  formatError,
  readBoundedUtf8File,
  relativeOrAbsolute,
  writeEvidenceReportFiles,
} from './evidence-io.js';
import {
  collectGameplayE2EPathEvidence,
  maximumGameplayE2EStates,
  readGameplayE2EPlan,
  resolveGameplayE2EPathInsideGameRoot,
} from './gameplay-e2e.js';

export const defaultGameAcceptanceCommandTimeoutMs = 30 * 60 * 1_000;
const defaultGameAcceptanceReleaseManifestFile = 'artifacts/release-manifest.json';
export const maximumGameplayE2EReportBytes = 1_024 * 1_024;

export function resolveGameAcceptanceReleaseManifestFile(
  gameRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configuredFile = env.MPGD_RELEASE_MANIFEST_FILE;

  return path.resolve(
    gameRoot,
    configuredFile === undefined || configuredFile.length === 0
      ? defaultGameAcceptanceReleaseManifestFile
      : configuredFile,
  );
}

export type GameAcceptanceStatus = 'failed' | 'passed';
export type GameAcceptanceStepStatus = 'failed' | 'passed' | 'skipped';

export interface GameAcceptanceStep {
  readonly id: string;
  readonly label: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly skipReason?: string;
}

export interface GameAcceptanceStepResult {
  readonly id: string;
  readonly label: string;
  readonly command: string | null;
  readonly args: readonly string[];
  readonly cwd: string | null;
  readonly status: GameAcceptanceStepStatus;
  readonly exitCode: number | null;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly detail: string | null;
}

export interface GameAcceptanceReport {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly status: GameAcceptanceStatus;
  readonly gameRoot: string;
  readonly durationMs: number;
  readonly options: Readonly<Record<string, string | boolean | null>>;
  readonly steps: readonly GameAcceptanceStepResult[];
  readonly evidence: {
    readonly releaseManifest: {
      readonly file: string;
      readonly found: boolean;
      readonly parseError: string | null;
      readonly value: unknown;
    } | null;
    readonly gameplayE2E: {
      readonly file: string;
      readonly found: boolean;
      readonly parseError: string | null;
      readonly validationError: string | null;
      readonly value: unknown;
    } | null;
  };
}

export interface GameAcceptanceCommandResult {
  readonly exitCode: number;
  readonly detail?: string;
}

export type GameAcceptanceCommandRunner = (
  step: Required<Pick<GameAcceptanceStep, 'command' | 'args' | 'cwd'>>,
) => GameAcceptanceCommandResult;

export interface RunGameAcceptanceInput {
  readonly gameRoot: string;
  readonly reportDir: string;
  readonly releaseManifestFile?: string;
  readonly gameplayE2EReportFile?: string;
  readonly requireGameplayE2EReport?: boolean;
  /** Step that must replace any previous gameplay report before evidence is accepted. */
  readonly gameplayE2EStepId?: string;
  /** Resolved acceptance targets that gameplay evidence is allowed to represent. */
  readonly gameplayE2ETargets?: readonly string[];
  readonly options: Readonly<Record<string, string | boolean | null>>;
  readonly steps: readonly GameAcceptanceStep[];
  readonly env?: NodeJS.ProcessEnv;
  readonly commandTimeoutMs?: number;
  readonly commandRunner?: GameAcceptanceCommandRunner;
  readonly now?: () => number;
  readonly log?: (message: string) => void;
}

export interface RunGameAcceptanceResult {
  readonly report: GameAcceptanceReport;
  readonly jsonFile: string;
  readonly markdownFile: string;
}

export function runGameAcceptance(input: RunGameAcceptanceInput): RunGameAcceptanceResult {
  const now = input.now ?? Date.now;
  const log = input.log ?? console.log;
  const commandTimeoutMs = input.commandTimeoutMs ?? defaultGameAcceptanceCommandTimeoutMs;

  if (!Number.isInteger(commandTimeoutMs) || commandTimeoutMs <= 0) {
    throw new Error(`Acceptance command timeout must be a positive integer: ${commandTimeoutMs}`);
  }

  const commandRunner = input.commandRunner
    ?? ((step) => runAcceptanceCommand(step, input.env ?? process.env, commandTimeoutMs));
  const gameRoot = path.resolve(input.gameRoot);
  const startedAtMs = now();
  const results: GameAcceptanceStepResult[] = [];
  let failed = false;
  let gameplayE2EReportFileToReplace: string | undefined;

  if (input.gameplayE2EStepId !== undefined) {
    if (input.gameplayE2EReportFile === undefined) {
      throw new Error('A gameplay E2E evidence step needs a report file.');
    }

    if (input.steps.filter((step) => step.id === input.gameplayE2EStepId).length !== 1) {
      throw new Error(
        `Gameplay E2E evidence step must occur exactly once: ${input.gameplayE2EStepId}`,
      );
    }

    gameplayE2EReportFileToReplace = resolveGameplayE2EPathInsideGameRoot(
      gameRoot,
      input.gameplayE2EReportFile,
      'Gameplay E2E report',
    );
  }

  for (const step of input.steps) {
    if (
      !failed
      && step.id === input.gameplayE2EStepId
      && gameplayE2EReportFileToReplace !== undefined
    ) {
      try {
        // Earlier acceptance commands are untrusted and may have changed the path hierarchy.
        const verifiedGameplayE2EReportFile = resolveGameplayE2EPathInsideGameRoot(
          gameRoot,
          gameplayE2EReportFileToReplace,
          'Gameplay E2E report',
        );

        rmSync(verifiedGameplayE2EReportFile, { force: true });
      } catch (error) {
        results.push(failedStepResult(step, now(), formatError(error)));
        failed = true;
        continue;
      }
    }

    if (failed) {
      results.push(skippedStepResult(step, now(), 'A previous acceptance step failed.'));
      continue;
    }

    if (step.skipReason !== undefined) {
      log(`[mpgd:accept] skipped ${step.label}: ${step.skipReason}`);
      results.push(skippedStepResult(step, now(), step.skipReason));
      continue;
    }

    const runnableStep = resolveRunnableStep(step);

    if (!runnableStep.ok) {
      results.push(failedStepResult(step, now(), runnableStep.detail));
      failed = true;
      continue;
    }

    const command = runnableStep.command;
    const args = step.args ?? [];
    const cwd = path.resolve(runnableStep.cwd);
    const stepStartedAtMs = now();
    const startedAt = new Date(stepStartedAtMs).toISOString();

    log(`[mpgd:accept] ${step.label}`);

    let commandResult: GameAcceptanceCommandResult;

    try {
      commandResult = commandRunner({ command, args, cwd });
    } catch (error) {
      commandResult = {
        exitCode: 1,
        detail: formatError(error),
      };
    }

    const status = commandResult.exitCode === 0 ? 'passed' : 'failed';

    results.push({
      id: step.id,
      label: step.label,
      command,
      args,
      cwd,
      status,
      exitCode: commandResult.exitCode,
      startedAt,
      durationMs: Math.max(0, now() - stepStartedAtMs),
      detail: commandResult.detail ?? null,
    });

    failed = status === 'failed';
  }

  const releaseManifest = readOptionalJsonEvidence(input.releaseManifestFile, gameRoot);
  const gameplayE2E = readGameplayE2EEvidence(
    input.gameplayE2EReportFile,
    gameRoot,
    input.releaseManifestFile,
    typeof input.options.profile === 'string' ? input.options.profile : undefined,
    input.gameplayE2ETargets,
  );
  const evidenceFailed = input.requireGameplayE2EReport === true
    && (
      gameplayE2E === null
      || !gameplayE2E.found
      || gameplayE2E.parseError !== null
      || gameplayE2E.validationError !== null
    );
  const finishedAtMs = now();
  const report: GameAcceptanceReport = {
    schemaVersion: 1,
    generatedAt: new Date(finishedAtMs).toISOString(),
    status: failed || evidenceFailed ? 'failed' : 'passed',
    gameRoot,
    durationMs: Math.max(0, finishedAtMs - startedAtMs),
    options: input.options,
    steps: results,
    evidence: {
      releaseManifest,
      gameplayE2E,
    },
  };
  const reportDir = path.resolve(input.reportDir);
  const jsonFile = path.join(reportDir, 'acceptance-report.json');
  const markdownFile = path.join(reportDir, 'acceptance-report.md');

  mkdirSync(reportDir, { recursive: true });
  writeEvidenceReportFiles({
    jsonFile,
    markdownFile,
    report,
    markdown: renderGameAcceptanceMarkdown(report),
  });

  return { report, jsonFile, markdownFile };
}

export function renderGameAcceptanceMarkdown(report: GameAcceptanceReport): string {
  const lines = [
    '# Game Acceptance Report',
    '',
    `Status: ${report.status}`,
    `Generated: ${report.generatedAt}`,
    `Game root: ${escapeMarkdownInline(report.gameRoot)}`,
    `Duration: ${formatDuration(report.durationMs)}`,
    '',
    '## Steps',
    '',
    '| Step | Status | Duration | Detail |',
    '| --- | --- | ---: | --- |',
    ...report.steps.map((step) => [
      escapeMarkdownTable(step.label),
      step.status,
      formatDuration(step.durationMs),
      escapeMarkdownTable(step.detail ?? ''),
    ].join(' | ')).map((row) => `| ${row} |`),
    '',
    '## Release Evidence',
    '',
  ];

  if (report.evidence.releaseManifest === null) {
    lines.push('- Release manifest collection disabled.');
  } else if (!report.evidence.releaseManifest.found) {
    lines.push(
      `- Release manifest not found: ${escapeMarkdownInline(report.evidence.releaseManifest.file)}`,
    );
  } else if (report.evidence.releaseManifest.parseError !== null) {
    lines.push(
      `- Release manifest is invalid: ${escapeMarkdownInline(report.evidence.releaseManifest.file)}`,
      `  - ${escapeMarkdownInline(report.evidence.releaseManifest.parseError)}`,
    );
  } else {
    lines.push(`- Release manifest: ${escapeMarkdownInline(report.evidence.releaseManifest.file)}`);
  }

  lines.push('', '## Gameplay E2E Evidence', '');

  if (report.evidence.gameplayE2E === null) {
    lines.push('- Gameplay E2E evidence collection disabled.');
  } else if (!report.evidence.gameplayE2E.found) {
    lines.push(
      `- Gameplay E2E report not found: ${escapeMarkdownInline(report.evidence.gameplayE2E.file)}`,
    );
  } else if (report.evidence.gameplayE2E.parseError !== null) {
    lines.push(
      `- Gameplay E2E report is invalid JSON: ${escapeMarkdownInline(report.evidence.gameplayE2E.file)}`,
      `  - ${escapeMarkdownInline(report.evidence.gameplayE2E.parseError)}`,
    );
  } else if (report.evidence.gameplayE2E.validationError !== null) {
    lines.push(
      `- Gameplay E2E report failed validation: ${escapeMarkdownInline(report.evidence.gameplayE2E.file)}`,
      `  - ${escapeMarkdownInline(report.evidence.gameplayE2E.validationError)}`,
    );
  } else {
    lines.push(`- Gameplay E2E report: ${escapeMarkdownInline(report.evidence.gameplayE2E.file)}`);
  }

  return `${lines.join('\n')}\n`;
}

function runAcceptanceCommand(
  step: Required<Pick<GameAcceptanceStep, 'command' | 'args' | 'cwd'>>,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): GameAcceptanceCommandResult {
  const result = spawnSync(step.command, [...step.args], {
    cwd: step.cwd,
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    timeout: timeoutMs,
    killSignal: 'SIGTERM',
  });

  if (result.error !== undefined) {
    return {
      exitCode: 1,
      detail: isTimeoutError(result.error)
        ? `Command timed out after ${timeoutMs}ms.`
        : result.error.message,
    };
  }

  return {
    exitCode: result.status ?? 1,
    ...(result.signal === null ? {} : { detail: `Terminated by ${result.signal}.` }),
  };
}

function failedStepResult(
  step: GameAcceptanceStep,
  nowMs: number,
  detail: string,
): GameAcceptanceStepResult {
  return {
    id: step.id,
    label: step.label,
    command: normalizeStepCommand(step.command),
    args: step.args ?? [],
    cwd: normalizeStepCwd(step.cwd),
    status: 'failed',
    exitCode: 1,
    startedAt: new Date(nowMs).toISOString(),
    durationMs: 0,
    detail,
  };
}

function skippedStepResult(
  step: GameAcceptanceStep,
  nowMs: number,
  detail: string,
): GameAcceptanceStepResult {
  return {
    id: step.id,
    label: step.label,
    command: normalizeStepCommand(step.command),
    args: step.args ?? [],
    cwd: normalizeStepCwd(step.cwd),
    status: 'skipped',
    exitCode: null,
    startedAt: new Date(nowMs).toISOString(),
    durationMs: 0,
    detail,
  };
}

function normalizeStepCommand(command: string | undefined): string | null {
  return command === undefined || command.length === 0 ? null : command;
}

function normalizeStepCwd(cwd: string | undefined): string | null {
  return cwd === undefined || cwd.length === 0 ? null : path.resolve(cwd);
}

function readOptionalJsonEvidence(
  file: string | undefined,
  gameRoot: string,
): GameAcceptanceReport['evidence']['releaseManifest'] {
  if (file === undefined) {
    return null;
  }

  let resolved: string;

  try {
    resolved = resolveGameplayE2EPathInsideGameRoot(gameRoot, file, 'Release manifest');
  } catch (error) {
    return {
      file: '<outside-game-root>',
      found: false,
      parseError: formatError(error),
      value: null,
    };
  }

  const displayFile = relativeOrAbsolute(gameRoot, resolved);

  if (!existsSync(resolved)) {
    return { file: displayFile, found: false, parseError: null, value: null };
  }

  try {
    const releaseManifestContent = readBoundedUtf8File(resolved, maximumGameplayE2EReportBytes);

    if (releaseManifestContent === null) {
      return {
        file: displayFile,
        found: true,
        parseError:
          `Release manifest cannot exceed ${maximumGameplayE2EReportBytes} bytes.`,
        value: null,
      };
    }

    return {
      file: displayFile,
      found: true,
      parseError: null,
      value: JSON.parse(releaseManifestContent) as unknown,
    };
  } catch (error) {
    return {
      file: displayFile,
      found: true,
      parseError: formatError(error),
      value: null,
    };
  }
}

function readGameplayE2EEvidence(
  file: string | undefined,
  gameRoot: string,
  releaseManifestFile: string | undefined,
  expectedProfile: string | undefined,
  expectedTargets: readonly string[] | undefined,
): GameAcceptanceReport['evidence']['gameplayE2E'] {
  if (file === undefined) {
    return null;
  }

  let resolved: string;

  try {
    resolved = resolveGameplayE2EPathInsideGameRoot(gameRoot, file, 'Gameplay E2E report');
  } catch (error) {
    return {
      file: '<outside-game-root>',
      found: false,
      parseError: null,
      validationError: formatError(error),
      value: null,
    };
  }

  const displayFile = relativeOrAbsolute(gameRoot, resolved);

  if (!existsSync(resolved)) {
    return {
      file: displayFile,
      found: false,
      parseError: null,
      validationError: null,
      value: null,
    };
  }

  let value: unknown;

  try {
    const reportContent = readBoundedUtf8File(resolved, maximumGameplayE2EReportBytes);

    if (reportContent === null) {
      return {
        file: displayFile,
        found: true,
        parseError: null,
        validationError:
          `Gameplay E2E report cannot exceed ${maximumGameplayE2EReportBytes} bytes.`,
        value: null,
      };
    }

    value = JSON.parse(reportContent) as unknown;
  } catch (error) {
    return {
      file: displayFile,
      found: true,
      parseError: formatError(error),
      validationError: null,
      value: null,
    };
  }

  return {
    file: displayFile,
    found: true,
    parseError: null,
    validationError: validateGameplayE2EEvidence(
      value,
      gameRoot,
      releaseManifestFile,
      expectedProfile,
      expectedTargets,
    ),
    value,
  };
}

function validateGameplayE2EEvidence(
  value: unknown,
  gameRoot: string,
  releaseManifestFile: string | undefined,
  expectedProfile: string | undefined,
  expectedTargets: readonly string[] | undefined,
): string | null {
  if (!isRecord(value)) {
    return 'Gameplay E2E report must be an object.';
  }

  if (value.schemaVersion !== 1) {
    return 'Gameplay E2E report schemaVersion must be 1.';
  }

  if (value.status !== 'passed') {
    return 'Gameplay E2E report status must be passed.';
  }

  const generatedAtMs = typeof value.generatedAt === 'string'
    ? Date.parse(value.generatedAt)
    : Number.NaN;

  if (
    typeof value.generatedAt !== 'string'
    || !Number.isFinite(generatedAtMs)
    || new Date(generatedAtMs).toISOString() !== value.generatedAt
  ) {
    return 'Gameplay E2E report generatedAt must be an ISO timestamp.';
  }

  if (typeof value.target !== 'string' || value.target.length === 0) {
    return 'Gameplay E2E report target must be a non-empty string.';
  }

  if (expectedTargets !== undefined && !expectedTargets.includes(value.target)) {
    return `Gameplay E2E report target must match an acceptance target: ${expectedTargets.join(', ')}.`;
  }

  if (typeof value.profile !== 'string' || value.profile.length === 0) {
    return 'Gameplay E2E report profile must be a non-empty string.';
  }

  if (expectedProfile !== undefined && value.profile !== expectedProfile) {
    return `Gameplay E2E report profile must match acceptance profile ${expectedProfile}.`;
  }

  if (!isPathEvidence(value.artifact) || value.artifact.kind === 'symbolic-link') {
    return 'Gameplay E2E report must link a hashed file or directory target artifact.';
  }

  const artifactError = validateCurrentPathEvidence(value.artifact, gameRoot, 'target artifact');

  if (artifactError !== null) {
    return artifactError;
  }

  if (!isPathEvidence(value.plan) || value.plan.kind !== 'file') {
    return 'Gameplay E2E report must link its hashed manifest plan.';
  }

  const planError = validateCurrentPathEvidence(value.plan, gameRoot, 'manifest plan');

  if (planError !== null) {
    return planError;
  }

  let configuredPlan: ReturnType<typeof readGameplayE2EPlan>;

  try {
    configuredPlan = readGameplayE2EPlan(gameRoot);
  } catch (error) {
    return `Gameplay E2E manifest plan is invalid: ${formatError(error)}`;
  }

  if (configuredPlan === null) {
    return 'Gameplay E2E manifest plan must define acceptance.gameplay.';
  }

  if (path.resolve(gameRoot, value.plan.file) !== configuredPlan.file) {
    return 'Gameplay E2E report must link the game manifest plan path.';
  }

  if (releaseManifestFile !== undefined) {
    if (!isPathEvidence(value.releaseManifest) || value.releaseManifest.kind !== 'file') {
      return 'Gameplay E2E report must link the current release manifest.';
    }

    let resolvedReleaseManifest: string;

    try {
      resolvedReleaseManifest = resolveGameplayE2EPathInsideGameRoot(
        gameRoot,
        releaseManifestFile,
        'Gameplay E2E release manifest',
      );
    } catch (error) {
      return formatError(error);
    }

    if (path.resolve(gameRoot, value.releaseManifest.file) !== resolvedReleaseManifest) {
      return 'Gameplay E2E report must link the acceptance release manifest path.';
    }

    const releaseManifestError = validateCurrentPathEvidence(
      value.releaseManifest,
      gameRoot,
      'release manifest',
    );

    if (releaseManifestError !== null) {
      return releaseManifestError;
    }

    let releaseManifest: unknown;

    try {
      const releaseManifestContent = readBoundedUtf8File(
        resolvedReleaseManifest,
        maximumGameplayE2EReportBytes,
      );

      if (releaseManifestContent === null) {
        return `Gameplay E2E release manifest cannot exceed ${maximumGameplayE2EReportBytes} bytes.`;
      }

      releaseManifest = JSON.parse(releaseManifestContent) as unknown;
    } catch (error) {
      return `Gameplay E2E report release manifest is unreadable: ${formatError(error)}`;
    }

    const releaseTargetError = validateReleaseTargetEvidence(
      releaseManifest,
      value.target,
      value.profile,
      value.artifact.file,
      gameRoot,
    );

    if (releaseTargetError !== null) {
      return releaseTargetError;
    }
  }

  if (!Array.isArray(value.states) || value.states.length === 0) {
    return 'Gameplay E2E report must contain at least one state.';
  }

  if (value.states.length > maximumGameplayE2EStates) {
    return `Gameplay E2E report cannot contain more than ${maximumGameplayE2EStates} states.`;
  }

  const stateIds: string[] = [];

  for (const state of value.states) {
    if (
      !isRecord(state)
      || typeof state.id !== 'string'
      || state.id.length === 0
      || state.status !== 'passed'
      || !isPathEvidence(state.screenshot)
      || state.screenshot.kind !== 'file'
    ) {
      return 'Every gameplay E2E state must have passed with a hashed screenshot.';
    }

    const screenshotError = validateCurrentPathEvidence(
      state.screenshot,
      gameRoot,
      'state screenshot',
    );

    if (screenshotError !== null) {
      return screenshotError;
    }

    stateIds.push(state.id);
  }

  const configuredStateIds = configuredPlan.plan.states.map((state) => state.id);

  if (
    stateIds.length !== configuredStateIds.length
    || stateIds.some((stateId, index) => stateId !== configuredStateIds[index])
  ) {
    return 'Gameplay E2E report must cover every manifest plan state in order.';
  }

  return null;
}

function validateReleaseTargetEvidence(
  value: unknown,
  target: string,
  profile: string,
  artifactFile: string,
  gameRoot: string,
): string | null {
  if (!isRecord(value) || !isRecord(value.targets)) {
    return 'Gameplay E2E release manifest must define target evidence.';
  }

  const targetEvidence = value.targets[target];

  if (!isRecord(targetEvidence) || typeof targetEvidence.artifact !== 'string') {
    return `Gameplay E2E release manifest does not contain target ${target}.`;
  }

  if (
    targetEvidence.profile !== undefined
    && targetEvidence.profile !== profile
  ) {
    return `Gameplay E2E release manifest target ${target} does not match profile ${profile}.`;
  }

  if (
    path.resolve(gameRoot, targetEvidence.artifact)
    !== path.resolve(gameRoot, artifactFile)
  ) {
    return `Gameplay E2E release manifest target ${target} does not match the tested artifact.`;
  }

  return null;
}

interface GameplayPathEvidenceValue {
  readonly file: string;
  readonly kind: 'directory' | 'file' | 'symbolic-link';
  readonly sha256: string;
}

function isPathEvidence(value: unknown): value is GameplayPathEvidenceValue {
  return isRecord(value)
    && typeof value.file === 'string'
    && value.file.length > 0
    && (value.kind === 'file' || value.kind === 'directory' || value.kind === 'symbolic-link')
    && typeof value.sha256 === 'string'
    && /^[a-f0-9]{64}$/u.test(value.sha256);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateCurrentPathEvidence(
  evidence: GameplayPathEvidenceValue,
  gameRoot: string,
  label: string,
): string | null {
  const resolved = path.resolve(gameRoot, evidence.file);
  const relative = path.relative(gameRoot, resolved);

  if (
    relative === '..'
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    return `Gameplay E2E ${label} path escapes the game root.`;
  }

  let current: GameplayPathEvidenceValue;

  try {
    current = collectGameplayE2EPathEvidence(gameRoot, evidence.file, label);
  } catch (error) {
    return `Gameplay E2E ${label} is unavailable: ${formatError(error)}`;
  }

  return current.kind === evidence.kind && current.sha256 === evidence.sha256
    ? null
    : `Gameplay E2E ${label} hash does not match its current contents.`;
}

function resolveRunnableStep(step: GameAcceptanceStep):
  | { readonly ok: true; readonly command: string; readonly cwd: string }
  | { readonly ok: false; readonly detail: string } {
  if (step.command === undefined || step.command.length === 0) {
    return { ok: false, detail: `Acceptance step ${step.id} is missing command.` };
  }

  if (step.cwd === undefined || step.cwd.length === 0) {
    return { ok: false, detail: `Acceptance step ${step.id} is missing cwd.` };
  }

  return { ok: true, command: step.command, cwd: step.cwd };
}

function isTimeoutError(error: Error): boolean {
  return 'code' in error && error.code === 'ETIMEDOUT';
}
