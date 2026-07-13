import {
  type RecordVerifiedLeaderboardAttemptRequest,
  type VerifiedLeaderboardService,
} from './verified-leaderboard';

export const verifiedLeaderboardConformanceScenarios = [
  'first-selection-and-snapshot',
  'best-selection-and-retry',
  'deterministic-ties',
  'identity-and-definition-conflicts',
  'concurrent-idempotency',
  'mutation-isolation',
  'runtime-validation',
] as const;

export type VerifiedLeaderboardConformanceScenario =
  (typeof verifiedLeaderboardConformanceScenarios)[number];

export interface CreateVerifiedLeaderboardConformanceFixtureInput {
  readonly scenario: VerifiedLeaderboardConformanceScenario;
  readonly now: string;
}

export interface VerifiedLeaderboardConformanceFixture {
  readonly service: VerifiedLeaderboardService;
  readonly dispose?: () => Promise<void> | void;
}

export type CreateVerifiedLeaderboardConformanceFixture = (
  input: CreateVerifiedLeaderboardConformanceFixtureInput,
) => Promise<VerifiedLeaderboardConformanceFixture> | VerifiedLeaderboardConformanceFixture;

export interface RunVerifiedLeaderboardConformanceInput {
  /**
   * Return an isolated provider fixture for each scenario. Durable adapters may
   * instead namespace every fixture in a shared test database.
   */
  readonly createFixture: CreateVerifiedLeaderboardConformanceFixture;
  readonly now?: string;
}

export interface VerifiedLeaderboardConformanceReport {
  readonly passedScenarios: readonly VerifiedLeaderboardConformanceScenario[];
}

interface ScenarioContext {
  readonly service: VerifiedLeaderboardService;
  readonly now: string;
}

type ScenarioRunner = (context: ScenarioContext) => Promise<void>;

const scenarios: ReadonlyArray<
  readonly [VerifiedLeaderboardConformanceScenario, ScenarioRunner]
> = [
  ['first-selection-and-snapshot', runFirstSelectionAndSnapshotScenario],
  ['best-selection-and-retry', runBestSelectionAndRetryScenario],
  ['deterministic-ties', runDeterministicTiesScenario],
  ['identity-and-definition-conflicts', runIdentityAndDefinitionConflictsScenario],
  ['concurrent-idempotency', runConcurrentIdempotencyScenario],
  ['mutation-isolation', runMutationIsolationScenario],
  ['runtime-validation', runRuntimeValidationScenario],
];

/**
 * Runs the provider-neutral verified leaderboard contract against an adapter.
 * The helper is test-framework independent and throws with the failed scenario
 * name when a provider diverges from the public service semantics.
 */
export async function runVerifiedLeaderboardConformance(
  input: RunVerifiedLeaderboardConformanceInput,
): Promise<VerifiedLeaderboardConformanceReport> {
  const now = input.now ?? '2030-01-02T03:04:05.000Z';
  const passedScenarios: VerifiedLeaderboardConformanceScenario[] = [];

  for (const [scenario, runScenario] of scenarios) {
    let fixture: VerifiedLeaderboardConformanceFixture | undefined;
    let scenarioError: unknown;
    let scenarioFailed = false;

    try {
      fixture = await input.createFixture({ scenario, now });
      await runScenario({ service: fixture.service, now });
    } catch (error) {
      scenarioError = error;
      scenarioFailed = true;
    }

    let cleanupError: unknown;
    let cleanupFailed = false;

    try {
      await fixture?.dispose?.();
    } catch (error) {
      cleanupError = error;
      cleanupFailed = true;
    }

    if (scenarioFailed) {
      throw new Error(`Verified leaderboard conformance failed: ${scenario}.`, {
        cause: cleanupFailed
          ? new AggregateError(
              [scenarioError, cleanupError],
              `Scenario and fixture cleanup both failed: ${scenario}.`,
            )
          : scenarioError,
      });
    }

    if (cleanupFailed) {
      throw new Error(`Verified leaderboard conformance cleanup failed: ${scenario}.`, {
        cause: cleanupError,
      });
    }

    passedScenarios.push(scenario);
  }

  return { passedScenarios };
}

async function runFirstSelectionAndSnapshotScenario(
  context: ScenarioContext,
): Promise<void> {
  const missing = await context.service.getSnapshot({ leaderboardId: 'first:missing' });
  assertEqual(missing, undefined, 'unknown boards must not synthesize snapshots');

  const laterRequest = createAttempt({
    leaderboardId: 'first:board',
    participantId: 'participant:first',
    participantLabel: 'First Player',
    attemptId: 'attempt:later',
    score: 20,
    completedAt: '2030-01-02T02:02:00.000Z',
  });
  const laterRecord = await context.service.recordVerifiedAttempt(laterRequest);
  const earlierRecord = await context.service.recordVerifiedAttempt(
    createAttempt({
      leaderboardId: 'first:board',
      participantId: 'participant:first',
      participantLabel: 'First Player',
      attemptId: 'attempt:earlier',
      score: 30,
      completedAt: '2030-01-02T02:01:00.000Z',
    }),
  );
  await context.service.recordVerifiedAttempt(
    createAttempt({
      leaderboardId: 'first:board',
      participantId: 'participant:leader',
      attemptId: 'attempt:leader',
      score: 10,
      completedAt: '2030-01-02T02:03:00.000Z',
    }),
  );

  assertEqual(laterRecord.retained, true, 'the first observed attempt must be retained');
  assertEqual(
    earlierRecord.retained,
    true,
    'an earlier verified completion must replace a later completion',
  );

  const snapshot = await context.service.getSnapshot({
    leaderboardId: 'first:board',
    participantId: 'participant:first',
    limit: 1,
  });
  assert(snapshot !== undefined, 'recorded boards must return snapshots');
  assertEqual(snapshot.entries.length, 1, 'snapshot limits must be honored');
  assertEqual(
    snapshot.entries[0]?.participantId,
    'participant:leader',
    'ascending snapshots must rank lower scores first',
  );
  assertEqual(
    snapshot.participantEntry?.attemptId,
    'attempt:earlier',
    'participant entries must reflect retained attempts outside the requested page',
  );
  assertEqual(snapshot.participantEntry?.rank, 2, 'participant entries must carry global rank');
  assertEqual(snapshot.totalParticipants, 2, 'snapshots must count retained participants');
  assertEqual(snapshot.generatedAt, context.now, 'snapshots must use the provider clock');

  const laterRetry = await context.service.recordVerifiedAttempt(laterRequest);
  assertEqual(laterRetry.alreadyProcessed, true, 'retries must be detected');
  assertEqual(
    laterRetry.retained,
    true,
    'retries must preserve the decision returned by the original write',
  );
  assertEqual(
    laterRetry.entry.attemptId,
    'attempt:later',
    'superseded retries must preserve their original response entry',
  );
}

async function runBestSelectionAndRetryScenario(context: ScenarioContext): Promise<void> {
  const initialRequest = createAttempt({
    leaderboardId: 'best:board',
    scoreOrder: 'descending',
    attemptSelection: 'best',
    participantId: 'participant:best',
    attemptId: 'attempt:initial',
    score: 100,
    completedAt: '2030-01-02T02:10:00.000Z',
  });
  await context.service.recordVerifiedAttempt(initialRequest);
  const worseRecord = await context.service.recordVerifiedAttempt(
    createAttempt({
      leaderboardId: 'best:board',
      scoreOrder: 'descending',
      attemptSelection: 'best',
      participantId: 'participant:best',
      attemptId: 'attempt:worse',
      score: 90,
      completedAt: '2030-01-02T02:11:00.000Z',
    }),
  );
  const improvedRecord = await context.service.recordVerifiedAttempt(
    createAttempt({
      leaderboardId: 'best:board',
      scoreOrder: 'descending',
      attemptSelection: 'best',
      participantId: 'participant:best',
      attemptId: 'attempt:improved',
      score: 110,
      completedAt: '2030-01-02T02:12:00.000Z',
    }),
  );

  assertEqual(worseRecord.retained, false, 'best selection must reject worse attempts');
  assertEqual(
    worseRecord.reason,
    'ATTEMPT_NOT_RETAINED',
    'non-retained attempts must explain their decision',
  );
  assertEqual(improvedRecord.retained, true, 'best selection must retain improved attempts');
  assertEqual(
    improvedRecord.entry.attemptId,
    'attempt:improved',
    'improved attempts must replace the retained entry',
  );

  const initialRetry = await context.service.recordVerifiedAttempt(initialRequest);
  assertEqual(initialRetry.alreadyProcessed, true, 'superseded best retries must be detected');
  assertEqual(
    initialRetry.retained,
    true,
    'superseded best retries must preserve their original decision',
  );
  assertEqual(
    initialRetry.entry.attemptId,
    'attempt:initial',
    'superseded best retries must preserve their original response entry',
  );

  await context.service.recordVerifiedAttempt(
    createAttempt({
      leaderboardId: 'best:board',
      scoreOrder: 'descending',
      attemptSelection: 'best',
      participantId: 'participant:runner-up',
      attemptId: 'attempt:runner-up',
      score: 105,
      completedAt: '2030-01-02T02:13:00.000Z',
    }),
  );
  const descendingSnapshot = await context.service.getSnapshot({
    leaderboardId: 'best:board',
    limit: 2,
  });
  assertEqual(
    descendingSnapshot?.entries[0]?.attemptId,
    'attempt:improved',
    'descending snapshots must rank higher scores first',
  );
  assertEqual(
    descendingSnapshot?.entries[1]?.attemptId,
    'attempt:runner-up',
    'descending snapshots must preserve lower-scoring followers',
  );

  await context.service.recordVerifiedAttempt(
    createAttempt({
      leaderboardId: 'best:ascending',
      scoreOrder: 'ascending',
      attemptSelection: 'best',
      participantId: 'participant:ascending',
      attemptId: 'attempt:ascending-initial',
      score: 100,
      completedAt: '2030-01-02T02:14:00.000Z',
    }),
  );
  const slowerAscendingRecord = await context.service.recordVerifiedAttempt(
    createAttempt({
      leaderboardId: 'best:ascending',
      scoreOrder: 'ascending',
      attemptSelection: 'best',
      participantId: 'participant:ascending',
      attemptId: 'attempt:ascending-slower',
      score: 110,
      completedAt: '2030-01-02T02:15:00.000Z',
    }),
  );
  const fasterAscendingRecord = await context.service.recordVerifiedAttempt(
    createAttempt({
      leaderboardId: 'best:ascending',
      scoreOrder: 'ascending',
      attemptSelection: 'best',
      participantId: 'participant:ascending',
      attemptId: 'attempt:ascending-faster',
      score: 90,
      completedAt: '2030-01-02T02:16:00.000Z',
    }),
  );
  assertEqual(
    slowerAscendingRecord.retained,
    false,
    'ascending best selection must reject higher scores',
  );
  assertEqual(
    fasterAscendingRecord.retained,
    true,
    'ascending best selection must retain lower scores',
  );
}

async function runDeterministicTiesScenario(context: ScenarioContext): Promise<void> {
  const bmpPrivateUseAttemptId = String.fromCodePoint(0xE000);
  const supplementaryAttemptId = String.fromCodePoint(0x10000);
  const attemptIds = ['ä', 'z', 'a', bmpPrivateUseAttemptId, supplementaryAttemptId];

  for (const attemptId of attemptIds) {
    await context.service.recordVerifiedAttempt(
      createAttempt({
        leaderboardId: 'ties:ranking',
        participantId: `participant:${attemptId}`,
        attemptId,
        score: 10,
        completedAt: '2030-01-02T02:20:00.000Z',
      }),
    );
  }

  const snapshot = await context.service.getSnapshot({
    leaderboardId: 'ties:ranking',
    limit: attemptIds.length,
  });
  assert(snapshot !== undefined, 'tie board must return a snapshot');
  assertEqual(snapshot.entries[0]?.attemptId, 'a', 'ties must use ordinal attempt IDs');
  assertEqual(snapshot.entries[1]?.attemptId, 'z', 'ties must not use locale collation');
  assertEqual(snapshot.entries[2]?.attemptId, 'ä', 'non-ASCII IDs must sort ordinally');
  assertEqual(
    snapshot.entries[3]?.attemptId,
    supplementaryAttemptId,
    'supplementary IDs must follow JavaScript UTF-16 ordinal ordering',
  );
  assertEqual(
    snapshot.entries[4]?.attemptId,
    bmpPrivateUseAttemptId,
    'BMP IDs must not be reordered by UTF-8 byte collation',
  );

  await context.service.recordVerifiedAttempt(
    createAttempt({
      leaderboardId: 'ties:first',
      participantId: 'participant:tie',
      attemptId: 'ä',
      score: 1,
      completedAt: '2030-01-02T02:21:00.000Z',
    }),
  );
  await context.service.recordVerifiedAttempt(
    createAttempt({
      leaderboardId: 'ties:first',
      participantId: 'participant:tie',
      attemptId: 'z',
      score: 2,
      completedAt: '2030-01-02T02:21:00.000Z',
    }),
  );
  const firstSnapshot = await context.service.getSnapshot({ leaderboardId: 'ties:first' });
  assertEqual(
    firstSnapshot?.entries[0]?.attemptId,
    'z',
    'first selection must use ordinal IDs for equal completion instants',
  );
}

async function runIdentityAndDefinitionConflictsScenario(
  context: ScenarioContext,
): Promise<void> {
  const request = createAttempt({
    leaderboardId: 'identity:board',
    participantId: 'participant:identity',
    participantLabel: 'Original Label',
    attemptId: 'attempt:identity',
    score: 42,
    completedAt: '2030-01-02T02:30:00.000Z',
  });
  await context.service.recordVerifiedAttempt(request);

  const equivalentRetry = await context.service.recordVerifiedAttempt({
    ...request,
    attempt: {
      ...request.attempt,
      participantLabel: 'Changed Label',
      completedAt: '2030-01-02T11:30:00.000+09:00',
      verification: {
        ...request.attempt.verification,
        verifiedAt: '2030-01-02T11:30:00.000+09:00',
      },
    },
  });
  assertEqual(equivalentRetry.alreadyProcessed, true, 'equivalent retries must be idempotent');
  assertEqual(
    equivalentRetry.entry.participantLabel,
    'Original Label',
    'retry labels must not rewrite stored presentation metadata',
  );
  assertEqual(
    equivalentRetry.entry.completedAt,
    request.attempt.completedAt,
    'equivalent retries must preserve the original timestamp representation',
  );

  await assertRejects(
    () => context.service.recordVerifiedAttempt({
      ...request,
      attempt: { ...request.attempt, score: 43 },
    }),
    'attempt IDs reused with a different score must fail closed',
  );
  await assertRejects(
    () => context.service.recordVerifiedAttempt({
      ...request,
      attempt: {
        ...request.attempt,
        verification: {
          ...request.attempt.verification,
          evidenceId: 'evidence:different',
        },
      },
    }),
    'attempt IDs reused with different evidence must fail closed',
  );
  await assertRejects(
    () => context.service.recordVerifiedAttempt({
      ...request,
      definition: { ...request.definition, scoreOrder: 'descending' },
      attempt: { ...request.attempt, attemptId: 'attempt:policy-conflict' },
    }),
    'leaderboard definitions must be immutable',
  );

  const otherBoardRecord = await context.service.recordVerifiedAttempt(
    createAttempt({
      leaderboardId: 'identity:other-board',
      participantId: request.attempt.participantId,
      ...(request.attempt.participantLabel === undefined
        ? {}
        : { participantLabel: request.attempt.participantLabel }),
      attemptId: request.attempt.attemptId,
      score: request.attempt.score,
      completedAt: request.attempt.completedAt,
    }),
  );
  assertEqual(
    otherBoardRecord.alreadyProcessed,
    false,
    'attempt identity must be scoped to one leaderboard',
  );
}

async function runConcurrentIdempotencyScenario(context: ScenarioContext): Promise<void> {
  const request = createAttempt({
    leaderboardId: 'concurrent:board',
    participantId: 'participant:concurrent',
    attemptId: 'attempt:concurrent',
    score: 7,
    completedAt: '2030-01-02T02:40:00.000Z',
  });
  const responses = await Promise.all([
    context.service.recordVerifiedAttempt(request),
    context.service.recordVerifiedAttempt(request),
  ]);
  const newWrites = responses.filter((response) => !response.alreadyProcessed);
  const retries = responses.filter((response) => response.alreadyProcessed);

  assertEqual(newWrites.length, 1, 'concurrent duplicates must produce one new write');
  assertEqual(retries.length, 1, 'concurrent duplicates must produce one idempotent retry');
  assertEqual(responses[0]?.retained, responses[1]?.retained, 'duplicate decisions must agree');
  assertEqual(
    responses[0]?.entry.attemptId,
    responses[1]?.entry.attemptId,
    'duplicate responses must reference the same attempt',
  );
}

async function runMutationIsolationScenario(context: ScenarioContext): Promise<void> {
  const request = createMutableAttempt({
    leaderboardId: 'mutation:board',
    participantId: 'participant:mutation',
    participantLabel: 'Stable Label',
    attemptId: 'attempt:mutation',
    score: 50,
    completedAt: '2030-01-02T02:50:00.000Z',
  });
  const response = await context.service.recordVerifiedAttempt(request);
  request.definition.scoreOrder = 'descending';
  request.attempt.score = -1;
  request.attempt.verification.evidenceId = 'evidence:mutated';

  try {
    Object.assign(response.entry, { participantLabel: 'Mutated Label', score: -2 });
  } catch {
    // Frozen provider responses are already isolated from caller mutation.
  }

  const snapshot = await context.service.getSnapshot({ leaderboardId: 'mutation:board' });
  assert(snapshot !== undefined, 'mutation board must return a snapshot');
  const snapshotEntry = snapshot.entries[0];
  assert(snapshotEntry !== undefined, 'mutation board must retain its recorded entry');
  assertEqual(snapshot.definition.scoreOrder, 'ascending', 'stored definitions must be cloned');
  assertEqual(snapshotEntry.score, 50, 'stored attempts must resist caller mutation');
  assertEqual(
    snapshotEntry.participantLabel,
    'Stable Label',
    'response mutation must not rewrite retained entries',
  );

  try {
    Object.assign(snapshot.definition, { scoreOrder: 'descending' });
  } catch {
    // Frozen provider snapshot definitions are already isolated from mutation.
  }

  try {
    Object.assign(snapshotEntry, { participantLabel: 'Snapshot Mutation', score: -3 });
  } catch {
    // Frozen provider snapshot entries are already isolated from mutation.
  }

  const rereadSnapshot = await context.service.getSnapshot({ leaderboardId: 'mutation:board' });
  assertEqual(
    rereadSnapshot?.definition.scoreOrder,
    'ascending',
    'snapshot definition mutation must not rewrite stored policy',
  );
  assertEqual(
    rereadSnapshot?.entries[0]?.score,
    50,
    'snapshot entry mutation must not rewrite retained attempts',
  );
  assertEqual(
    rereadSnapshot?.entries[0]?.participantLabel,
    'Stable Label',
    'snapshot label mutation must not rewrite presentation metadata',
  );
}

async function runRuntimeValidationScenario(context: ScenarioContext): Promise<void> {
  const validVerificationTimestamp = '2030-01-02T02:00:00.000Z';

  await assertRejects(
    () => context.service.recordVerifiedAttempt(
      createAttempt({
        leaderboardId: 'validation:calendar',
        participantId: 'participant:calendar',
        attemptId: 'attempt:calendar',
        score: 1,
        completedAt: '2030-02-31T02:00:00.000Z',
        verifiedAt: validVerificationTimestamp,
      }),
    ),
    'invalid calendar timestamps must fail closed',
  );
  await assertRejects(
    () => context.service.recordVerifiedAttempt(
      createAttempt({
        leaderboardId: 'validation:timezone',
        participantId: 'participant:timezone',
        attemptId: 'attempt:timezone',
        score: 1,
        completedAt: '2030-01-02T02:00:00.000',
        verifiedAt: validVerificationTimestamp,
      }),
    ),
    'offset-less timestamps must fail closed',
  );
  await assertRejects(
    () => context.service.recordVerifiedAttempt(
      createAttempt({
        leaderboardId: 'validation:precision',
        participantId: 'participant:precision',
        attemptId: 'attempt:precision',
        score: 1,
        completedAt: '2030-01-02T02:00:00.0001Z',
        verifiedAt: validVerificationTimestamp,
      }),
    ),
    'sub-millisecond timestamps must fail closed',
  );
  await assertRejects(
    () => context.service.recordVerifiedAttempt(
      createAttempt({
        leaderboardId: 'validation:evidence-timezone',
        participantId: 'participant:evidence-timezone',
        attemptId: 'attempt:evidence-timezone',
        score: 1,
        completedAt: validVerificationTimestamp,
        verifiedAt: '2030-01-02T02:00:00.000',
      }),
    ),
    'invalid verification timestamps must fail closed independently',
  );
  await assertRejects(
    () => context.service.getSnapshot({ leaderboardId: 'validation:limit', limit: 0 }),
    'invalid snapshot limits must fail closed',
  );
}

function createAttempt(input: {
  readonly leaderboardId: string;
  readonly scoreOrder?: 'ascending' | 'descending';
  readonly attemptSelection?: 'first' | 'best';
  readonly participantId: string;
  readonly participantLabel?: string;
  readonly attemptId: string;
  readonly score: number;
  readonly completedAt: string;
  readonly verifiedAt?: string;
}): RecordVerifiedLeaderboardAttemptRequest {
  return createMutableAttempt(input);
}

function createMutableAttempt(input: {
  readonly leaderboardId: string;
  readonly scoreOrder?: 'ascending' | 'descending';
  readonly attemptSelection?: 'first' | 'best';
  readonly participantId: string;
  readonly participantLabel?: string;
  readonly attemptId: string;
  readonly score: number;
  readonly completedAt: string;
  readonly verifiedAt?: string;
}): {
  definition: {
    leaderboardId: string;
    scoreOrder: 'ascending' | 'descending';
    attemptSelection: 'first' | 'best';
  };
  attempt: {
    participantId: string;
    participantLabel?: string;
    attemptId: string;
    score: number;
    completedAt: string;
    verification: {
      authorityId: string;
      evidenceId: string;
      verifiedAt: string;
    };
  };
} {
  return {
    definition: {
      leaderboardId: input.leaderboardId,
      scoreOrder: input.scoreOrder ?? 'ascending',
      attemptSelection: input.attemptSelection ?? 'first',
    },
    attempt: {
      participantId: input.participantId,
      ...(input.participantLabel === undefined
        ? {}
        : { participantLabel: input.participantLabel }),
      attemptId: input.attemptId,
      score: input.score,
      completedAt: input.completedAt,
      verification: {
        authorityId: 'verified-leaderboard-conformance',
        evidenceId: `evidence:${input.leaderboardId}:${input.attemptId}`,
        verifiedAt: input.verifiedAt ?? input.completedAt,
      },
    },
  };
}

async function assertRejects(operation: () => Promise<unknown>, message: string): Promise<void> {
  try {
    await operation();
  } catch {
    return;
  }

  throw new Error(`${message}: expected the operation to reject.`);
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}.`);
  }
}
