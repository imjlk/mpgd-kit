import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

export const defaultGameplayE2EReportFile =
  'artifacts/gameplay-e2e/gameplay-e2e-report.json';

const gameplayStateIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const gameplayKeyControlCharacterPattern = /[\u0000-\u001f\u007f]/u;
export const maximumGameplayE2EStates = 50;
const maximumActionsPerState = 100;
const maximumWaitMs = 60_000;
const maximumBackgroundMs = 5 * 60_000;
const maximumHashReadChunkBytes = 64 * 1_024;
const defaultGameplayE2EHashLimits = {
  maximumDepth: 128,
  maximumEntries: 100_000,
  maximumTotalFileBytes: 4 * 1_024 * 1_024 * 1_024,
} as const satisfies GameplayE2EHashLimits;

export interface GameplayE2EHashLimits {
  readonly maximumDepth: number;
  readonly maximumEntries: number;
  readonly maximumTotalFileBytes: number;
}

class GameplayE2EAggregatedError extends Error {
  readonly errors: readonly unknown[];

  constructor(message: string, errors: readonly unknown[]) {
    super(message);
    this.name = 'GameplayE2EAggregatedError';
    this.errors = errors;
  }
}

export interface GameplayE2EPlan {
  readonly schemaVersion: 1;
  readonly states: readonly GameplayE2EState[];
}

export interface GameplayE2EState {
  readonly id: string;
  readonly label: string;
  readonly expectation?: string;
  readonly actions: readonly GameplayE2EAction[];
}

export type GameplayE2EAction =
  | GameplayE2EInputAction
  | GameplayE2EPauseResumeAction;

export type GameplayE2EInputAction =
  | {
      readonly type: 'tap';
      readonly x: number;
      readonly y: number;
    }
  | {
      readonly type: 'key';
      readonly key: string;
    }
  | {
      readonly type: 'wait';
      readonly durationMs: number;
    };

export interface GameplayE2EPauseResumeAction {
  readonly type: 'pause-resume';
  readonly backgroundMs: number;
  readonly expectSameSession?: boolean;
}

export interface GameplayE2EObservation {
  readonly passed: boolean;
  readonly sessionId: string | null;
  readonly detail?: string;
  readonly metadata?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface GameplayE2EDriver {
  readonly perform: (action: GameplayE2EInputAction) => Promise<void>;
  readonly pause: () => Promise<void>;
  readonly resume: () => Promise<void>;
  readonly inspect: (input: {
    readonly state: GameplayE2EState;
    readonly phase: 'after' | 'before' | 'resumed';
  }) => Promise<GameplayE2EObservation>;
  readonly captureScreenshot: (input: {
    readonly state: GameplayE2EState;
    readonly file: string;
  }) => Promise<void>;
}

export type GameplayE2EStatus = 'failed' | 'passed';
export type GameplayE2EResultStatus = GameplayE2EStatus | 'skipped';

export interface GameplayE2EActionResult {
  readonly action: GameplayE2EAction;
  readonly status: GameplayE2EResultStatus;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly detail: string | null;
}

export interface GameplayE2EPathEvidence {
  readonly file: string;
  readonly kind: 'directory' | 'file' | 'symbolic-link';
  readonly sha256: string;
}

export interface GameplayE2EStateResult {
  readonly id: string;
  readonly label: string;
  readonly expectation: string | null;
  readonly status: GameplayE2EResultStatus;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly detail: string | null;
  readonly actions: readonly GameplayE2EActionResult[];
  readonly observation: GameplayE2EObservation | null;
  readonly screenshot: GameplayE2EPathEvidence | null;
}

export interface GameplayE2EReport {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly status: GameplayE2EStatus;
  readonly gameRoot: string;
  readonly target: string;
  readonly profile: string;
  readonly durationMs: number;
  readonly plan: GameplayE2EPathEvidence;
  readonly artifact: GameplayE2EPathEvidence;
  readonly releaseManifest: GameplayE2EPathEvidence | null;
  readonly states: readonly GameplayE2EStateResult[];
}

export interface RunGameplayE2EInput {
  readonly gameRoot: string;
  readonly reportDir: string;
  readonly reportFile?: string;
  readonly plan: GameplayE2EPlan;
  readonly planFile: string;
  readonly target: string;
  readonly profile: string;
  readonly artifactFile: string;
  readonly releaseManifestFile?: string;
  readonly driver: GameplayE2EDriver;
  readonly now?: () => number;
  readonly log?: (message: string) => void;
}

export interface RunGameplayE2EResult {
  readonly report: GameplayE2EReport;
  readonly jsonFile: string;
  readonly markdownFile: string;
}

export function resolveGameplayE2EReportFile(
  gameRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configuredFile = env.MPGD_GAMEPLAY_E2E_REPORT_FILE;

  return path.resolve(
    gameRoot,
    configuredFile === undefined || configuredFile.length === 0
      ? defaultGameplayE2EReportFile
      : configuredFile,
  );
}

export function readGameplayE2EPlan(
  gameRoot: string,
  configFile = 'mpgd.game.json',
): { readonly file: string; readonly plan: GameplayE2EPlan } | null {
  const resolvedRoot = path.resolve(gameRoot);
  const resolvedFile = path.resolve(resolvedRoot, configFile);

  if (!existsSync(resolvedFile)) {
    throw new Error(`Missing gameplay config: ${resolvedFile}`);
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(readFileSync(resolvedFile, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`Invalid gameplay config JSON at ${resolvedFile}: ${formatError(error)}`);
  }

  assertRecord(parsed, resolvedFile);
  const acceptance = parsed.acceptance;

  if (acceptance === undefined) {
    return null;
  }

  assertRecord(acceptance, `${resolvedFile} acceptance`);

  if (acceptance.gameplay === undefined) {
    return null;
  }

  return {
    file: resolvedFile,
    plan: parseGameplayE2EPlan(acceptance.gameplay, `${resolvedFile} acceptance.gameplay`),
  };
}

export function parseGameplayE2EPlan(
  value: unknown,
  source = 'gameplay E2E plan',
): GameplayE2EPlan {
  assertRecord(value, source);
  assertOnlyKeys(value, ['schemaVersion', 'states'], source);

  if (value.schemaVersion !== 1) {
    throw new Error(`${source}.schemaVersion must be 1.`);
  }

  if (!Array.isArray(value.states)) {
    throw new Error(`${source}.states must be an array.`);
  }

  if (value.states.length === 0 || value.states.length > maximumGameplayE2EStates) {
    throw new Error(
      `${source}.states must contain between 1 and ${maximumGameplayE2EStates} states.`,
    );
  }

  const stateIds = new Set<string>();
  const states = value.states.map((state, index) =>
    parseGameplayE2EState(state, `${source}.states[${index}]`, stateIds));

  return { schemaVersion: 1, states };
}

export async function runGameplayE2E(
  input: RunGameplayE2EInput,
): Promise<RunGameplayE2EResult> {
  const now = input.now ?? Date.now;
  const log = input.log ?? console.log;
  const gameRoot = path.resolve(input.gameRoot);
  const reportDir = input.reportFile === undefined
    ? path.resolve(input.reportDir)
    : path.dirname(path.resolve(gameRoot, input.reportFile));
  const screenshotsDir = path.join(reportDir, 'screenshots');
  const startedAtMs = now();
  const plan = parseGameplayE2EPlan(input.plan);
  const planLabel = 'gameplay E2E plan';
  const planEvidence = collectGameplayE2EPathEvidence(gameRoot, input.planFile, planLabel);

  assertPathEvidenceKind(planEvidence, ['file'], planLabel);

  const configuredPlan = readGameplayE2EPlan(gameRoot, planEvidence.file);

  if (configuredPlan === null) {
    throw new Error('Gameplay E2E plan file must define acceptance.gameplay.');
  }

  if (JSON.stringify(configuredPlan.plan) !== JSON.stringify(plan)) {
    throw new Error('Gameplay E2E plan must match the linked manifest plan file.');
  }

  const artifact = collectGameplayE2EPathEvidence(gameRoot, input.artifactFile, 'target artifact');
  const releaseManifest = input.releaseManifestFile === undefined
    ? null
    : collectGameplayE2EPathEvidence(gameRoot, input.releaseManifestFile, 'release manifest');
  const states: GameplayE2EStateResult[] = [];
  let failed = false;

  assertPathEvidenceKind(artifact, ['directory', 'file'], 'target artifact');

  if (releaseManifest !== null) {
    assertPathEvidenceKind(releaseManifest, ['file'], 'release manifest');
  }

  mkdirSync(screenshotsDir, { recursive: true });

  for (const state of plan.states) {
    if (failed) {
      states.push(skippedStateResult(state, now()));
      continue;
    }

    log(`[mpgd:gameplay-e2e] ${state.label}`);
    const result = await runGameplayState({
      state,
      driver: input.driver,
      gameRoot,
      screenshotsDir,
      now,
    });

    states.push(result);
    failed = result.status === 'failed';
  }

  const finishedAtMs = now();
  const report: GameplayE2EReport = {
    schemaVersion: 1,
    generatedAt: new Date(finishedAtMs).toISOString(),
    status: failed ? 'failed' : 'passed',
    gameRoot,
    target: readNonEmptyString(input.target, 'target'),
    profile: readNonEmptyString(input.profile, 'profile'),
    durationMs: Math.max(0, finishedAtMs - startedAtMs),
    plan: planEvidence,
    artifact,
    releaseManifest,
    states,
  };
  const jsonFile = input.reportFile === undefined
    ? path.join(reportDir, 'gameplay-e2e-report.json')
    : path.resolve(gameRoot, input.reportFile);
  const markdownFile = replaceFileExtension(jsonFile, '.md');

  writeFileSync(jsonFile, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(markdownFile, renderGameplayE2EMarkdown(report));

  return { report, jsonFile, markdownFile };
}

export function renderGameplayE2EMarkdown(report: GameplayE2EReport): string {
  const lines = [
    '# Gameplay E2E Report',
    '',
    `Status: ${report.status}`,
    `Generated: ${report.generatedAt}`,
    `Target: ${escapeMarkdownInline(report.target)}`,
    `Profile: ${escapeMarkdownInline(report.profile)}`,
    `Artifact: ${escapeMarkdownInline(report.artifact.file)} (${report.artifact.sha256})`,
    report.releaseManifest === null
      ? 'Release manifest: not linked'
      : `Release manifest: ${escapeMarkdownInline(report.releaseManifest.file)} (${report.releaseManifest.sha256})`,
    `Duration: ${formatDuration(report.durationMs)}`,
    '',
    '## States',
    '',
    '| State | Status | Duration | Screenshot | Detail |',
    '| --- | --- | ---: | --- | --- |',
    ...report.states.map((state) => [
      escapeMarkdownTable(state.label),
      state.status,
      formatDuration(state.durationMs),
      escapeMarkdownTable(state.screenshot?.file ?? ''),
      escapeMarkdownTable(gameplayStateDetail(state)),
    ].join(' | ')).map((row) => `| ${row} |`),
    '',
  ];

  return `${lines.join('\n')}\n`;
}

function gameplayStateDetail(state: GameplayE2EStateResult): string {
  return [
    state.detail,
    ...state.actions.map((action) => action.detail),
    state.observation?.detail,
  ].filter((detail): detail is string =>
    detail !== null && detail !== undefined && detail.length > 0).join('; ');
}

interface RunGameplayStateInput {
  readonly state: GameplayE2EState;
  readonly driver: GameplayE2EDriver;
  readonly gameRoot: string;
  readonly screenshotsDir: string;
  readonly now: () => number;
}

async function runGameplayState(
  input: RunGameplayStateInput,
): Promise<GameplayE2EStateResult> {
  const startedAtMs = input.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const actions: GameplayE2EActionResult[] = [];
  let detail: string | null = null;
  let observation: GameplayE2EObservation | null = null;
  let screenshot: GameplayE2EPathEvidence | null = null;

  try {
    const before = validateObservation(
      await input.driver.inspect({ state: input.state, phase: 'before' }),
      `${input.state.id} before observation`,
    );

    if (!before.passed) {
      throw new Error(before.detail ?? `State ${input.state.id} was not ready.`);
    }

    for (const action of input.state.actions) {
      const actionStartedAtMs = input.now();
      const actionStartedAt = new Date(actionStartedAtMs).toISOString();

      try {
        const actionDetail = action.type === 'pause-resume'
          ? await runPauseResumeAction(input.driver, input.state, action)
          : await runInputAction(input.driver, action);

        actions.push({
          action,
          status: 'passed',
          startedAt: actionStartedAt,
          durationMs: Math.max(0, input.now() - actionStartedAtMs),
          detail: actionDetail,
        });
      } catch (error) {
        detail = formatError(error);
        actions.push({
          action,
          status: 'failed',
          startedAt: actionStartedAt,
          durationMs: Math.max(0, input.now() - actionStartedAtMs),
          detail,
        });
        throw error;
      }
    }

    observation = validateObservation(
      await input.driver.inspect({ state: input.state, phase: 'after' }),
      `${input.state.id} after observation`,
    );

    if (!observation.passed) {
      throw new Error(observation.detail ?? `State ${input.state.id} expectation failed.`);
    }
  } catch (error) {
    detail ??= formatError(error);
  }

  try {
    const screenshotFile = path.join(input.screenshotsDir, `${input.state.id}.png`);

    await input.driver.captureScreenshot({ state: input.state, file: screenshotFile });
    screenshot = collectGameplayE2EPathEvidence(
      input.gameRoot,
      screenshotFile,
      'gameplay screenshot',
    );
    assertPathEvidenceKind(screenshot, ['file'], 'gameplay screenshot');
  } catch (error) {
    const screenshotError = `Screenshot failed: ${formatError(error)}`;

    detail = detail === null ? screenshotError : `${detail} ${screenshotError}`;
  }

  const status = detail === null ? 'passed' : 'failed';

  return {
    id: input.state.id,
    label: input.state.label,
    expectation: input.state.expectation ?? null,
    status,
    startedAt,
    durationMs: Math.max(0, input.now() - startedAtMs),
    detail,
    actions,
    observation,
    screenshot,
  };
}

async function runInputAction(
  driver: GameplayE2EDriver,
  action: GameplayE2EInputAction,
): Promise<null> {
  await driver.perform(action);
  return null;
}

async function runPauseResumeAction(
  driver: GameplayE2EDriver,
  state: GameplayE2EState,
  action: GameplayE2EPauseResumeAction,
): Promise<string | null> {
  const expectSameSession = action.expectSameSession !== false;
  const before = validateObservation(
    await driver.inspect({ state, phase: 'before' }),
    `${state.id} pre-pause observation`,
  );

  if (!before.passed) {
    throw new Error(before.detail ?? `State ${state.id} was unhealthy before pause.`);
  }

  await driver.pause();
  let primaryError: unknown;

  try {
    if (action.backgroundMs > 0) {
      await driver.perform({ type: 'wait', durationMs: action.backgroundMs });
    }
  } catch (error) {
    primaryError = error;
  }

  try {
    await driver.resume();
  } catch (error) {
    if (primaryError === undefined) {
      primaryError = error;
    } else {
      primaryError = new GameplayE2EAggregatedError(
        'Gameplay background wait and resume both failed.',
        [primaryError, error],
      );
    }
  }

  if (primaryError !== undefined) {
    throw primaryError;
  }

  const resumed = validateObservation(
    await driver.inspect({ state, phase: 'resumed' }),
    `${state.id} resumed observation`,
  );

  if (!resumed.passed) {
    throw new Error(resumed.detail ?? `State ${state.id} was unhealthy after resume.`);
  }

  if (
    expectSameSession
    && (before.sessionId === null || resumed.sessionId === null || before.sessionId !== resumed.sessionId)
  ) {
    throw new Error(`State ${state.id} did not preserve its session across pause and resume.`);
  }

  return expectSameSession
    ? `Session preserved across pause and resume: ${before.sessionId}`
    : null;
}

function skippedStateResult(
  state: GameplayE2EState,
  nowMs: number,
): GameplayE2EStateResult {
  return {
    id: state.id,
    label: state.label,
    expectation: state.expectation ?? null,
    status: 'skipped',
    startedAt: new Date(nowMs).toISOString(),
    durationMs: 0,
    detail: 'A previous gameplay state failed.',
    actions: state.actions.map((action) => ({
      action,
      status: 'skipped',
      startedAt: new Date(nowMs).toISOString(),
      durationMs: 0,
      detail: 'A previous gameplay state failed.',
    })),
    observation: null,
    screenshot: null,
  };
}

function parseGameplayE2EState(
  value: unknown,
  source: string,
  stateIds: Set<string>,
): GameplayE2EState {
  assertRecord(value, source);
  assertOnlyKeys(value, ['id', 'label', 'expectation', 'actions'], source);
  const id = readNonEmptyString(value.id, `${source}.id`);

  if (!gameplayStateIdPattern.test(id)) {
    throw new Error(`${source}.id must use lowercase kebab-case.`);
  }

  if (stateIds.has(id)) {
    throw new Error(`${source}.id is duplicated: ${id}`);
  }

  stateIds.add(id);
  const label = readNonEmptyString(value.label, `${source}.label`);
  const expectation = value.expectation === undefined
    ? undefined
    : readNonEmptyString(value.expectation, `${source}.expectation`);

  if (!Array.isArray(value.actions)) {
    throw new Error(`${source}.actions must be an array.`);
  }

  if (value.actions.length > maximumActionsPerState) {
    throw new Error(
      `${source}.actions cannot contain more than ${maximumActionsPerState} actions.`,
    );
  }

  const actions = value.actions.map((action, index) =>
    parseGameplayE2EAction(action, `${source}.actions[${index}]`));

  return {
    id,
    label,
    ...(expectation === undefined ? {} : { expectation }),
    actions,
  };
}

function parseGameplayE2EAction(value: unknown, source: string): GameplayE2EAction {
  assertRecord(value, source);
  const type = readNonEmptyString(value.type, `${source}.type`);

  switch (type) {
    case 'tap': {
      assertOnlyKeys(value, ['type', 'x', 'y'], source);
      return {
        type,
        x: readBoundedNumber(value.x, `${source}.x`, 0, 1),
        y: readBoundedNumber(value.y, `${source}.y`, 0, 1),
      };
    }
    case 'key': {
      assertOnlyKeys(value, ['type', 'key'], source);
      const key = readNonEmptyString(value.key, `${source}.key`);

      if (key.length > 64) {
        throw new Error(`${source}.key cannot exceed 64 characters.`);
      }

      if (gameplayKeyControlCharacterPattern.test(key)) {
        throw new Error(`${source}.key cannot contain control characters.`);
      }

      return { type, key };
    }
    case 'wait': {
      assertOnlyKeys(value, ['type', 'durationMs'], source);
      return {
        type,
        durationMs: readBoundedInteger(
          value.durationMs,
          `${source}.durationMs`,
          0,
          maximumWaitMs,
        ),
      };
    }
    case 'pause-resume': {
      assertOnlyKeys(value, ['type', 'backgroundMs', 'expectSameSession'], source);
      const expectSameSession = value.expectSameSession ?? true;

      if (typeof expectSameSession !== 'boolean') {
        throw new Error(`${source}.expectSameSession must be a boolean.`);
      }

      return {
        type,
        backgroundMs: readBoundedInteger(
          value.backgroundMs,
          `${source}.backgroundMs`,
          0,
          maximumBackgroundMs,
        ),
        expectSameSession,
      };
    }
    default:
      throw new Error(`${source}.type is unsupported: ${type}`);
  }
}

function validateObservation(value: unknown, source: string): GameplayE2EObservation {
  assertRecord(value, source);
  assertOnlyKeys(value, ['passed', 'sessionId', 'detail', 'metadata'], source);

  if (typeof value.passed !== 'boolean') {
    throw new Error(`${source}.passed must be a boolean.`);
  }

  if (value.sessionId !== null && typeof value.sessionId !== 'string') {
    throw new Error(`${source}.sessionId must be a string or null.`);
  }

  if (typeof value.sessionId === 'string' && value.sessionId.length === 0) {
    throw new Error(`${source}.sessionId cannot be empty.`);
  }

  const detail = value.detail === undefined
    ? undefined
    : readNonEmptyString(value.detail, `${source}.detail`);
  const metadata = value.metadata === undefined
    ? undefined
    : validateObservationMetadata(value.metadata, `${source}.metadata`);

  return {
    passed: value.passed,
    sessionId: value.sessionId,
    ...(detail === undefined ? {} : { detail }),
    ...(metadata === undefined ? {} : { metadata }),
  };
}

function validateObservationMetadata(
  value: unknown,
  source: string,
): Readonly<Record<string, string | number | boolean | null>> {
  assertRecord(value, source);
  const result: Record<string, string | number | boolean | null> = {};

  for (const [key, entry] of Object.entries(value)) {
    if (
      entry !== null
      && typeof entry !== 'string'
      && typeof entry !== 'number'
      && typeof entry !== 'boolean'
    ) {
      throw new Error(`${source}.${key} must be a JSON scalar.`);
    }

    if (typeof entry === 'number' && !Number.isFinite(entry)) {
      throw new Error(`${source}.${key} must be finite.`);
    }

    result[key] = entry;
  }

  return result;
}

export function collectGameplayE2EPathEvidence(
  gameRoot: string,
  file: string,
  label: string,
  limits: GameplayE2EHashLimits = defaultGameplayE2EHashLimits,
): GameplayE2EPathEvidence {
  const resolved = resolveEvidencePathInsideGameRoot(gameRoot, file, label);

  let stats: ReturnType<typeof lstatSync>;

  try {
    stats = lstatSync(resolved);
  } catch (error) {
    throw new Error(`Unable to inspect ${label} at ${resolved}: ${formatError(error)}`);
  }
  const kind = stats.isSymbolicLink()
    ? 'symbolic-link'
    : stats.isDirectory()
      ? 'directory'
      : stats.isFile()
        ? 'file'
        : undefined;

  if (kind === undefined) {
    throw new Error(`Unsupported ${label} path type: ${resolved}`);
  }

  return {
    file: relativeOrAbsolute(gameRoot, resolved),
    kind,
    sha256: hashPath(resolved, validateHashLimits(limits)),
  };
}

function resolveEvidencePathInsideGameRoot(
  gameRoot: string,
  file: string,
  label: string,
): string {
  const resolvedRoot = path.resolve(gameRoot);
  const resolved = path.resolve(resolvedRoot, file);
  const relative = path.relative(resolvedRoot, resolved);

  if (pathEscapesRoot(relative)) {
    // Keep host paths out of validation errors when untrusted input escapes the game root.
    throw new Error(`${label} path must stay inside the game root.`);
  }

  if (resolved === resolvedRoot) {
    return resolved;
  }

  const relativeParent = path.relative(resolvedRoot, path.dirname(resolved));
  let current = resolvedRoot;

  for (const segment of relativeParent.split(path.sep).filter((entry) => entry.length > 0)) {
    current = path.join(current, segment);

    let stats: ReturnType<typeof lstatSync>;

    try {
      stats = lstatSync(current);
    } catch (error) {
      throw new Error(
        `Unable to inspect ${label} parent directory at ${current}: ${formatError(error)}`,
      );
    }

    if (stats.isSymbolicLink()) {
      throw new Error(`${label} path must not cross symbolic-link ancestors: ${current}`);
    }

    if (!stats.isDirectory()) {
      throw new Error(`${label} parent path must be a directory.`);
    }
  }

  return resolved;
}

function pathEscapesRoot(relative: string): boolean {
  return relative === '..'
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative);
}

function assertPathEvidenceKind(
  evidence: GameplayE2EPathEvidence,
  allowedKinds: readonly GameplayE2EPathEvidence['kind'][],
  label: string,
): void {
  if (!allowedKinds.includes(evidence.kind)) {
    throw new Error(`Unsupported ${label} path kind: ${evidence.kind}`);
  }
}

interface GameplayE2EHashState {
  entryCount: number;
  totalFileBytes: number;
  readonly limits: GameplayE2EHashLimits;
}

function hashPath(file: string, limits: GameplayE2EHashLimits): string {
  const hash = createHash('sha256');
  const root = path.dirname(file);
  const state: GameplayE2EHashState = {
    entryCount: 0,
    totalFileBytes: 0,
    limits,
  };

  appendPathToHash(hash, root, file, state, 0);
  return hash.digest('hex');
}

function appendPathToHash(
  hash: ReturnType<typeof createHash>,
  root: string,
  file: string,
  state: GameplayE2EHashState,
  depth: number,
): void {
  if (depth > state.limits.maximumDepth) {
    throw new Error(
      `Gameplay evidence path exceeds maximum hash depth ${state.limits.maximumDepth}: ${file}`,
    );
  }

  state.entryCount += 1;

  if (state.entryCount > state.limits.maximumEntries) {
    throw new Error(
      `Gameplay evidence exceeds maximum hash entries ${state.limits.maximumEntries}.`,
    );
  }

  const stats = lstatSync(file);
  const relative = path.relative(root, file).replaceAll(path.sep, '/');

  if (stats.isSymbolicLink()) {
    hash.update(`L\0${relative}\0${readlinkSync(file)}\0`);
    return;
  }

  if (stats.isDirectory()) {
    hash.update(`D\0${relative}\0`);

    for (const entry of readdirSync(file).sort()) {
      appendPathToHash(hash, root, path.join(file, entry), state, depth + 1);
    }

    return;
  }

  if (stats.isFile()) {
    hash.update(`F\0${relative}\0${stats.size}\0`);
    appendFileContentsToHash(hash, file, stats.size, state);
    return;
  }

  throw new Error(`Unsupported artifact path type: ${file}`);
}

function appendFileContentsToHash(
  hash: ReturnType<typeof createHash>,
  file: string,
  expectedSize: number,
  state: GameplayE2EHashState,
): void {
  const descriptor = openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(maximumHashReadChunkBytes);
  let fileBytes = 0;

  try {
    while (true) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.byteLength, null);

      if (bytesRead === 0) {
        break;
      }

      fileBytes += bytesRead;

      if (state.totalFileBytes + fileBytes > state.limits.maximumTotalFileBytes) {
        throw new Error(
          `Gameplay evidence exceeds maximum hashed bytes ${state.limits.maximumTotalFileBytes}.`,
        );
      }

      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    closeSync(descriptor);
  }

  if (fileBytes !== expectedSize) {
    throw new Error(`Gameplay evidence file changed while hashing: ${file}`);
  }

  state.totalFileBytes += fileBytes;
}

function validateHashLimits(limits: GameplayE2EHashLimits): GameplayE2EHashLimits {
  const entries = [
    ['maximumDepth', limits.maximumDepth],
    ['maximumEntries', limits.maximumEntries],
    ['maximumTotalFileBytes', limits.maximumTotalFileBytes],
  ] as const;

  for (const [name, value] of entries) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`Gameplay evidence hash limit ${name} must be a positive safe integer.`);
    }
  }

  return limits;
}

function assertRecord(value: unknown, source: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${source} must be an object.`);
  }
}

function assertOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  source: string,
): void {
  const allowedKeys = new Set(allowed);
  const unexpected = Object.keys(value).filter((key) => !allowedKeys.has(key));

  if (unexpected.length > 0) {
    throw new Error(`${source} contains unsupported fields: ${unexpected.join(', ')}`);
  }
}

function readNonEmptyString(value: unknown, source: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${source} must be a non-empty string.`);
  }

  return value;
}

function readBoundedNumber(
  value: unknown,
  source: string,
  minimum: number,
  maximum: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${source} must be between ${minimum} and ${maximum}.`);
  }

  return value;
}

function readBoundedInteger(
  value: unknown,
  source: string,
  minimum: number,
  maximum: number,
): number {
  const result = readBoundedNumber(value, source, minimum, maximum);

  if (!Number.isInteger(result)) {
    throw new Error(`${source} must be an integer.`);
  }

  return result;
}

function relativeOrAbsolute(root: string, file: string): string {
  const relative = path.relative(root, file);

  return relative.startsWith('..') || path.isAbsolute(relative) ? file : relative || '.';
}

function replaceFileExtension(file: string, extension: string): string {
  const currentExtension = path.extname(file);

  return currentExtension.length === 0
    ? `${file}${extension}`
    : `${file.slice(0, -currentExtension.length)}${extension}`;
}

function escapeMarkdownTable(value: string): string {
  return escapeMarkdownInline(value).replaceAll('|', '\\|');
}

function escapeMarkdownInline(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replace(/([\\`*_[\]])/gu, '\\$1')
    .replaceAll('\n', ' ');
}

function formatDuration(durationMs: number): string {
  return durationMs < 1_000 ? `${durationMs}ms` : `${(durationMs / 1_000).toFixed(1)}s`;
}

function formatError(error: unknown): string {
  if (error instanceof GameplayE2EAggregatedError) {
    return `${error.message} ${error.errors.map(formatError).join(' ')}`;
  }

  return error instanceof Error ? error.message : String(error);
}
