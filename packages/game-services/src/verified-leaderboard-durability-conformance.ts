import {
  assertRecordVerifiedLeaderboardAttemptResponse,
  assertVerifiedLeaderboardSnapshot,
  type RecordVerifiedLeaderboardAttemptRequest,
  type VerifiedLeaderboardService,
} from './verified-leaderboard';

export const verifiedLeaderboardDurabilityConformanceScenarios = [
  'replacement-after-interrupted-retained-write',
  'concurrent-retry-after-interrupted-retained-write',
  'snapshot-after-interrupted-retained-write',
] as const;

export type VerifiedLeaderboardDurabilityConformanceScenario =
  (typeof verifiedLeaderboardDurabilityConformanceScenarios)[number];

export interface CreateVerifiedLeaderboardDurabilityConformanceFixtureInput {
  readonly scenario: VerifiedLeaderboardDurabilityConformanceScenario;
  readonly now: string;
}

export interface VerifiedLeaderboardDurabilityConformanceFixture {
  readonly service: VerifiedLeaderboardService;
  /**
   * Arms one retained record so its caller observes a failure after the
   * provider has crossed the recovery boundary. Transactional providers may
   * simulate a committed write with a lost response. Multi-write providers
   * should interrupt at their recoverable handoff boundary.
   */
  readonly interruptNextRetainedRecord: () => void;
  readonly dispose?: () => Promise<void> | void;
}

export type CreateVerifiedLeaderboardDurabilityConformanceFixture = (
  input: CreateVerifiedLeaderboardDurabilityConformanceFixtureInput,
) =>
  | Promise<VerifiedLeaderboardDurabilityConformanceFixture>
  | VerifiedLeaderboardDurabilityConformanceFixture;

export interface RunVerifiedLeaderboardDurabilityConformanceInput {
  /** Return an isolated fixture, or a uniquely namespaced fixture, per scenario. */
  readonly createFixture: CreateVerifiedLeaderboardDurabilityConformanceFixture;
  readonly now?: string;
}

export interface VerifiedLeaderboardDurabilityConformanceReport {
  readonly passedScenarios: readonly VerifiedLeaderboardDurabilityConformanceScenario[];
}

type DurabilityScenarioRunner = (
  fixture: VerifiedLeaderboardDurabilityConformanceFixture,
) => Promise<void>;

type DurabilityScenarioRunners = Readonly<Record<
  VerifiedLeaderboardDurabilityConformanceScenario,
  DurabilityScenarioRunner
>>;

const durabilityScenarioRunners: DurabilityScenarioRunners = {
  'replacement-after-interrupted-retained-write':
    runReplacementAfterInterruptedRetainedWriteScenario,
  'concurrent-retry-after-interrupted-retained-write':
    runConcurrentRetryAfterInterruptedRetainedWriteScenario,
  'snapshot-after-interrupted-retained-write':
    runSnapshotAfterInterruptedRetainedWriteScenario,
};

/**
 * Runs provider-neutral recovery checks that require a provider-specific fault
 * boundary. It complements the semantic conformance suite and deliberately
 * does not prescribe a shared persistence implementation.
 */
export async function runVerifiedLeaderboardDurabilityConformance(
  input: RunVerifiedLeaderboardDurabilityConformanceInput,
): Promise<VerifiedLeaderboardDurabilityConformanceReport> {
  const now = input.now ?? '2030-01-02T03:04:05.000Z';
  const passedScenarios: VerifiedLeaderboardDurabilityConformanceScenario[] = [];

  for (const scenario of verifiedLeaderboardDurabilityConformanceScenarios) {
    const runScenario = durabilityScenarioRunners[scenario];
    let fixture: VerifiedLeaderboardDurabilityConformanceFixture | undefined;
    let scenarioError: unknown;
    let scenarioFailed = false;

    try {
      fixture = await input.createFixture({ scenario, now });
      await runScenario(fixture);
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
      throw new Error(`Verified leaderboard durability conformance failed: ${scenario}.`, {
        cause: cleanupFailed
          ? new AggregateError(
              [scenarioError, cleanupError],
              `Scenario and fixture cleanup both failed: ${scenario}.`,
            )
          : scenarioError,
      });
    }

    if (cleanupFailed) {
      const message = `Verified leaderboard durability conformance cleanup failed: ${scenario}.`;
      throw new Error(message, { cause: cleanupError });
    }

    passedScenarios.push(scenario);
  }

  return { passedScenarios };
}

/**
 * Wraps an atomic provider so the next armed record commits successfully but
 * its caller observes an interruption. Use a provider-specific fixture when
 * the implementation has a recoverable boundary inside a multi-write flow.
 */
export function createAmbiguousCommitVerifiedLeaderboardDurabilityFixture(
  provider: VerifiedLeaderboardService,
  dispose?: () => Promise<void> | void,
): VerifiedLeaderboardDurabilityConformanceFixture {
  let interruptNextRecord = false;

  return {
    service: {
      async recordVerifiedAttempt(input) {
        const response = await provider.recordVerifiedAttempt(input);

        if (interruptNextRecord) {
          interruptNextRecord = false;
          throw new Error('Simulated verified leaderboard response interruption.');
        }

        return response;
      },
      getSnapshot: (input) => provider.getSnapshot(input),
    },
    interruptNextRetainedRecord() {
      if (interruptNextRecord) {
        throw new Error('A verified leaderboard interruption is already armed.');
      }

      interruptNextRecord = true;
    },
    ...(dispose === undefined ? {} : { dispose }),
  };
}

async function runReplacementAfterInterruptedRetainedWriteScenario(
  fixture: VerifiedLeaderboardDurabilityConformanceFixture,
): Promise<void> {
  const interrupted = createAttempt(
    'replacement-after-interrupted-retained-write',
    'interrupted',
    10,
    '2030-01-02T03:00:00.000Z',
  );
  const later = createAttempt(
    'replacement-after-interrupted-retained-write',
    'later-better',
    20,
    '2030-01-02T03:01:00.000Z',
  );

  fixture.interruptNextRetainedRecord();
  await assertRejects(
    () => fixture.service.recordVerifiedAttempt(interrupted),
    'the armed retained record must surface an interruption',
  );

  const laterResponse = await fixture.service.recordVerifiedAttempt(later);
  assertRecordVerifiedLeaderboardAttemptResponse(laterResponse);
  assertEqual(laterResponse.retained, true, 'the later better attempt must be retained');
  assertEqual(
    laterResponse.entry.attemptId,
    later.attempt.attemptId,
    'the later better attempt must replace the interrupted retained entry',
  );

  const retry = await fixture.service.recordVerifiedAttempt(interrupted);
  assertOriginalInterruptedDecision(retry, interrupted);

  const snapshot = await fixture.service.getSnapshot({
    leaderboardId: interrupted.definition.leaderboardId,
    participantId: interrupted.attempt.participantId,
  });
  assert(snapshot !== undefined, 'the recovered board must return a snapshot');
  assertVerifiedLeaderboardSnapshot(snapshot);
  assertEqual(snapshot.totalParticipants, 1, 'the replacement must keep one participant');
  assertEqual(
    snapshot.participantEntry?.attemptId,
    later.attempt.attemptId,
    'the final snapshot must retain the later better attempt',
  );
}

async function runConcurrentRetryAfterInterruptedRetainedWriteScenario(
  fixture: VerifiedLeaderboardDurabilityConformanceFixture,
): Promise<void> {
  const interrupted = createAttempt(
    'concurrent-retry-after-interrupted-retained-write',
    'interrupted',
    10,
    '2030-01-02T03:00:00.000Z',
  );

  fixture.interruptNextRetainedRecord();
  await assertRejects(
    () => fixture.service.recordVerifiedAttempt(interrupted),
    'the armed retained record must surface an interruption',
  );

  const retries = await Promise.all([
    fixture.service.recordVerifiedAttempt(interrupted),
    fixture.service.recordVerifiedAttempt(interrupted),
  ]);

  for (const retry of retries) {
    assertOriginalInterruptedDecision(retry, interrupted);
  }

  const snapshot = await fixture.service.getSnapshot({
    leaderboardId: interrupted.definition.leaderboardId,
  });
  assert(snapshot !== undefined, 'the concurrently recovered board must return a snapshot');
  assertVerifiedLeaderboardSnapshot(snapshot);
  assertEqual(snapshot.totalParticipants, 1, 'concurrent retries must not duplicate participants');
  assertEqual(snapshot.entries.length, 1, 'concurrent retries must not duplicate retained rows');
}

async function runSnapshotAfterInterruptedRetainedWriteScenario(
  fixture: VerifiedLeaderboardDurabilityConformanceFixture,
): Promise<void> {
  const interrupted = createAttempt(
    'snapshot-after-interrupted-retained-write',
    'interrupted',
    10,
    '2030-01-02T03:00:00.000Z',
  );

  fixture.interruptNextRetainedRecord();
  await assertRejects(
    () => fixture.service.recordVerifiedAttempt(interrupted),
    'the armed retained record must surface an interruption',
  );

  const snapshot = await fixture.service.getSnapshot({
    leaderboardId: interrupted.definition.leaderboardId,
    participantId: interrupted.attempt.participantId,
  });
  assert(snapshot !== undefined, 'reads must recover an interrupted retained record');
  assertVerifiedLeaderboardSnapshot(snapshot);
  assertEqual(
    snapshot.participantEntry?.attemptId,
    interrupted.attempt.attemptId,
    'reads must expose the recovered retained entry',
  );

  const retry = await fixture.service.recordVerifiedAttempt(interrupted);
  assertOriginalInterruptedDecision(retry, interrupted);
}

function assertOriginalInterruptedDecision(
  response: Awaited<ReturnType<VerifiedLeaderboardService['recordVerifiedAttempt']>>,
  interrupted: RecordVerifiedLeaderboardAttemptRequest,
): void {
  assertRecordVerifiedLeaderboardAttemptResponse(response);
  assertEqual(response.alreadyProcessed, true, 'retries must detect the interrupted write');
  assertEqual(response.retained, true, 'retries must preserve the original retained decision');
  assertEqual(
    response.entry.attemptId,
    interrupted.attempt.attemptId,
    'retries must preserve the original response entry',
  );
  assertEqual(
    response.entry.score,
    interrupted.attempt.score,
    'retries must preserve the original response score',
  );
}

function createAttempt(
  scenario: VerifiedLeaderboardDurabilityConformanceScenario,
  suffix: string,
  score: number,
  completedAt: string,
): RecordVerifiedLeaderboardAttemptRequest {
  return {
    definition: {
      leaderboardId: `durability:${scenario}`,
      scoreOrder: 'descending',
      attemptSelection: 'best',
    },
    attempt: {
      participantId: `participant:${scenario}`,
      attemptId: `attempt:${scenario}:${suffix}`,
      score,
      completedAt,
      verification: {
        authorityId: 'verified-leaderboard-durability-conformance',
        evidenceId: `evidence:${scenario}:${suffix}`,
        verifiedAt: completedAt,
      },
    },
  };
}

async function assertRejects(callback: () => Promise<unknown>, message: string): Promise<void> {
  let rejected = false;

  try {
    await callback();
  } catch {
    rejected = true;
  }

  assert(rejected, message);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}.`);
  }
}
