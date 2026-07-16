import type { StorageAdapter } from './index.js';

export const storageAdapterConformanceScenarios = [
  'missing-read',
  'round-trip-and-overwrite',
  'storage-scope-isolation',
  'mutation-isolation',
  'quota-rejection-preserves-value',
  'save-failure-is-fail-closed',
  'load-failure-is-fail-closed',
] as const;

export type StorageAdapterConformanceScenario =
  (typeof storageAdapterConformanceScenarios)[number];

export interface CreateStorageAdapterConformanceFixtureInput {
  readonly scenario: StorageAdapterConformanceScenario;
}

export interface StorageAdapterConformanceFixture {
  /** Storage area under test. */
  readonly storage: StorageAdapter;
  /**
   * A distinct account, namespace, browser profile, or equivalent storage
   * scope backed by the same kind of provider.
   */
  readonly isolatedStorage: StorageAdapter;
  /** A value that the fixture's configured provider quota must reject. */
  readonly oversizedValue: unknown;
  /** Fail the next primary-scope save before it becomes visible. */
  readonly armNextSaveFailure: () => void;
  /** Fail the next primary-scope load instead of reporting a missing value. */
  readonly armNextLoadFailure: () => void;
  readonly dispose?: () => Promise<void> | void;
}

export type CreateStorageAdapterConformanceFixture = (
  input: CreateStorageAdapterConformanceFixtureInput,
) => Promise<StorageAdapterConformanceFixture> | StorageAdapterConformanceFixture;

export interface RunStorageAdapterConformanceInput {
  /** Return an isolated fixture, or a uniquely namespaced fixture, per scenario. */
  readonly createFixture: CreateStorageAdapterConformanceFixture;
}

export interface StorageAdapterConformanceReport {
  readonly passedScenarios: readonly StorageAdapterConformanceScenario[];
}

type ScenarioRunner = (fixture: StorageAdapterConformanceFixture) => Promise<void>;

const scenarioRunners: Readonly<Record<StorageAdapterConformanceScenario, ScenarioRunner>> = {
  'missing-read': runMissingReadScenario,
  'round-trip-and-overwrite': runRoundTripAndOverwriteScenario,
  'storage-scope-isolation': runStorageScopeIsolationScenario,
  'mutation-isolation': runMutationIsolationScenario,
  'quota-rejection-preserves-value': runQuotaRejectionPreservesValueScenario,
  'save-failure-is-fail-closed': runSaveFailureIsFailClosedScenario,
  'load-failure-is-fail-closed': runLoadFailureIsFailClosedScenario,
};

/**
 * Runs provider-neutral persistence checks against a StorageAdapter. The
 * suite distinguishes a missing value from a provider failure, requires
 * quota and fault rejection to preserve the last committed value, and checks
 * JSON-style value isolation across the adapter boundary.
 */
export async function runStorageAdapterConformance(
  input: RunStorageAdapterConformanceInput,
): Promise<StorageAdapterConformanceReport> {
  const passedScenarios: StorageAdapterConformanceScenario[] = [];

  for (const scenario of storageAdapterConformanceScenarios) {
    let fixture: StorageAdapterConformanceFixture | undefined;
    let scenarioError: unknown;
    let scenarioFailed = false;

    try {
      fixture = await input.createFixture({ scenario });
      await scenarioRunners[scenario](fixture);
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
      throw new Error(`Storage adapter conformance failed: ${scenario}.`, {
        cause: cleanupFailed
          ? new AggregateError(
              [scenarioError, cleanupError],
              `Scenario and fixture cleanup both failed: ${scenario}.`,
            )
          : scenarioError,
      });
    }

    if (cleanupFailed) {
      throw new Error(`Storage adapter conformance cleanup failed: ${scenario}.`, {
        cause: cleanupError,
      });
    }

    passedScenarios.push(scenario);
  }

  return { passedScenarios };
}

async function runMissingReadScenario(fixture: StorageAdapterConformanceFixture): Promise<void> {
  const key = scenarioKey('missing-read');
  assertEqual(await fixture.storage.load({ key }), null, 'missing values must return null');
}

async function runRoundTripAndOverwriteScenario(
  fixture: StorageAdapterConformanceFixture,
): Promise<void> {
  const key = scenarioKey('round-trip-and-overwrite');
  const first = { revision: 1, progress: { stage: 2, coins: 10 } };
  const second = { revision: 2, progress: { stage: 3, coins: 25 } };

  await fixture.storage.save({ key, value: first });
  assertJsonEqual(
    await fixture.storage.load({ key }),
    { value: first },
    'saved values must round-trip',
  );

  await fixture.storage.save({ key, value: second });
  assertJsonEqual(
    await fixture.storage.load({ key }),
    { value: second },
    'later saves must replace the value for the same key',
  );
}

async function runStorageScopeIsolationScenario(
  fixture: StorageAdapterConformanceFixture,
): Promise<void> {
  const key = scenarioKey('storage-scope-isolation');
  const primaryValue = { owner: 'primary', coins: 10 };
  const isolatedValue = { owner: 'isolated', coins: 20 };

  await fixture.storage.save({ key, value: primaryValue });
  assertEqual(
    await fixture.isolatedStorage.load({ key }),
    null,
    'a distinct storage scope must not observe the primary value',
  );

  await fixture.isolatedStorage.save({ key, value: isolatedValue });
  assertJsonEqual(
    await fixture.storage.load({ key }),
    { value: primaryValue },
    'writing an isolated scope must not replace the primary value',
  );
  assertJsonEqual(
    await fixture.isolatedStorage.load({ key }),
    { value: isolatedValue },
    'the isolated scope must retain its own value',
  );
}

async function runMutationIsolationScenario(
  fixture: StorageAdapterConformanceFixture,
): Promise<void> {
  const key = scenarioKey('mutation-isolation');
  const savedInput = {
    revision: 1,
    progress: { stage: 4, coins: 40 },
    inventory: ['starter'],
  };
  const committedValue = {
    revision: 1,
    progress: { stage: 4, coins: 40 },
    inventory: ['starter'],
  };

  await fixture.storage.save({ key, value: savedInput });
  savedInput.progress.coins = 999;
  savedInput.inventory.push('mutated-after-save');

  const firstLoad = await fixture.storage.load({ key });
  assertJsonEqual(
    firstLoad,
    { value: committedValue },
    'mutating the saved input must not mutate committed storage',
  );
  assert(firstLoad !== null, 'the committed value must remain readable');

  const mutableLoadedValue = firstLoad.value as {
    progress: { coins: number };
    inventory: string[];
  };

  try {
    mutableLoadedValue.progress.coins = -1;
    mutableLoadedValue.inventory.push('mutated-after-load');
  } catch {
    // Deeply immutable loaded values already prevent callers from mutating
    // provider state. The following read still proves isolation.
  }

  assertJsonEqual(
    await fixture.storage.load({ key }),
    { value: committedValue },
    'mutating a loaded value must not mutate later reads',
  );
}

async function runQuotaRejectionPreservesValueScenario(
  fixture: StorageAdapterConformanceFixture,
): Promise<void> {
  const key = scenarioKey('quota-rejection-preserves-value');
  const committedValue = { revision: 1, state: 'committed-before-quota' };

  await fixture.storage.save({ key, value: committedValue });
  await assertRejects(
    () => fixture.storage.save({ key, value: fixture.oversizedValue }),
    'an oversized value must reject instead of reporting success',
  );
  assertJsonEqual(
    await fixture.storage.load({ key }),
    { value: committedValue },
    'quota rejection must preserve the last committed value',
  );
}

async function runSaveFailureIsFailClosedScenario(
  fixture: StorageAdapterConformanceFixture,
): Promise<void> {
  const key = scenarioKey('save-failure-is-fail-closed');
  const committedValue = { revision: 1, state: 'committed-before-save-failure' };

  await fixture.storage.save({ key, value: committedValue });
  fixture.armNextSaveFailure();
  await assertRejects(
    () => fixture.storage.save({ key, value: { revision: 2, state: 'must-not-commit' } }),
    'provider save failures must reject instead of falling back or reporting success',
  );
  assertJsonEqual(
    await fixture.storage.load({ key }),
    { value: committedValue },
    'a failed save must preserve the last committed value',
  );
}

async function runLoadFailureIsFailClosedScenario(
  fixture: StorageAdapterConformanceFixture,
): Promise<void> {
  const key = scenarioKey('load-failure-is-fail-closed');
  const committedValue = { revision: 1, state: 'committed-before-load-failure' };

  await fixture.storage.save({ key, value: committedValue });
  fixture.armNextLoadFailure();
  await assertRejects(
    () => fixture.storage.load({ key }),
    'provider load failures must reject instead of returning a missing or fallback value',
  );
  assertJsonEqual(
    await fixture.storage.load({ key }),
    { value: committedValue },
    'the next load must recover the committed value after a transient failure',
  );
}

function scenarioKey(scenario: StorageAdapterConformanceScenario): string {
  return `storage-conformance:${scenario}`;
}

async function assertRejects(run: () => Promise<unknown>, message: string): Promise<void> {
  let rejected = false;

  try {
    await run();
  } catch {
    rejected = true;
  }

  assert(rejected, message);
}

function assertJsonEqual(actual: unknown, expected: unknown, message: string): void {
  if (!jsonValuesEqual(actual, expected)) {
    throw new Error(
      `${message}. Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}.`,
    );
  }
}

function jsonValuesEqual(actual: unknown, expected: unknown): boolean {
  if (actual === expected) {
    return true;
  }

  if (Array.isArray(actual) || Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      Array.isArray(expected) &&
      actual.length === expected.length &&
      actual.every((value, index) => jsonValuesEqual(value, expected[index]))
    );
  }

  if (!isJsonObject(actual) || !isJsonObject(expected)) {
    return false;
  }

  const actualKeys = Object.keys(actual);
  const expectedKeys = Object.keys(expected);

  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every(
      (key) =>
        Object.hasOwn(expected, key) && jsonValuesEqual(actual[key], expected[key]),
    )
  );
}

function isJsonObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}. Expected ${String(expected)}, received ${String(actual)}.`);
  }
}
