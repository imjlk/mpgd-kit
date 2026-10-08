import { adProtocol, adProtocolVersion } from './ads.js';

export type AdConformanceValue = string | number | boolean | null
  | readonly AdConformanceValue[]
  | { readonly [key: string]: AdConformanceValue };

export type AdConformanceActor = 'game' | 'sdk' | 'backend' | 'clock' | 'runtime';
export interface AdConformanceStep {
  readonly actor: AdConformanceActor;
  readonly action: string;
  readonly [key: string]: AdConformanceValue;
}

export interface AdConformanceVector {
  readonly vector: string;
  readonly protocol: typeof adProtocol;
  readonly version: typeof adProtocolVersion;
  readonly profile: Readonly<Record<string, AdConformanceValue>>;
  readonly steps: readonly AdConformanceStep[];
  readonly expect: Readonly<Record<string, AdConformanceValue>>;
}

export interface AdConformanceDriver {
  /** Complete immediate scheduled work, without waiting for an open native surface. */
  step(input: AdConformanceStep): Promise<void>;
  read(): Promise<Readonly<Record<string, AdConformanceValue>>>;
  dispose(): Promise<void>;
}

export interface AdConformanceFixture {
  readonly name: string;
  /** A fresh driver for every vector. Expectations are never supplied to the driver. */
  create(input: {
    readonly vector: string;
    readonly profile: Readonly<Record<string, AdConformanceValue>>;
  }): Promise<AdConformanceDriver>;
}

const actions: Readonly<Record<AdConformanceActor, readonly string[]>> = {
  game: ['prepare', 'start', 'disposeView'],
  sdk: ['started', 'rewardEarned', 'closed', 'failed'],
  backend: ['grant', 'reject'],
  clock: ['advance'],
  runtime: ['block', 'release', 'recover', 'restart'],
};
const observationKeys = new Set([
  'sdkShows',
  'claimRequests',
  'ledgerGrants',
  'purchaseUiOpened',
  'occupied',
  'outcomes',
  'claims',
  'reason',
  'presentation',
  'eligibility',
  'claimState',
  'preparation',
  'lateCloseObserved',
  'updatesAfterViewDisposal',
  'activeInvocationId',
  'executionOwners',
  'reasons',
  'callerResults',
  'normalization',
  'ledgerEntryId',
]);

/** Deterministic orchestration only: adapters translate each step into their real SDK input. */
export async function runAdConformance(input: {
  readonly vectors: readonly unknown[];
  readonly fixtures: readonly AdConformanceFixture[];
}): Promise<{ readonly passed: readonly { readonly fixture: string; readonly vector: string }[] }> {
  if (input.vectors.length === 0 || input.fixtures.length === 0) {
    throw new TypeError('Ad conformance requires vectors and fixtures.');
  }
  const vectors = input.vectors.map(assertAdConformanceVector);
  assertUnique(
    vectors.map((vector) => vector.vector),
    'vector',
  );
  assertUnique(
    input.fixtures.map((fixture) => fixture.name),
    'fixture',
  );
  const passed: { fixture: string; vector: string }[] = [];
  for (const fixture of input.fixtures) {
    for (const vector of vectors) {
      let driver: AdConformanceDriver | undefined;
      let failure: unknown;
      let failed = false;
      try {
        driver = await fixture.create({ vector: vector.vector, profile: vector.profile });
        for (const step of vector.steps) {
          const { expect: checkpoint, ...action } = step;
          await driver.step(action);
          if (checkpoint !== undefined) {
            assertMatches(cloneValue(await driver.read(), 0), checkpoint, 'checkpoint');
          }
        }
        const observed = cloneValue(await driver.read(), 0);
        assertMatches(observed, vector.expect, 'expect');
      } catch (error) {
        failed = true;
        failure = error;
      } finally {
        try {
          await driver?.dispose();
        } catch (error) {
          if (!failed) {
            failed = true;
            failure = error;
          }
        }
      }
      if (failed) {
        throw new Error(`Ad conformance failed: ${fixture.name}/${vector.vector}.`, {
          cause: failure,
        });
      }
      passed.push(Object.freeze({ fixture: fixture.name, vector: vector.vector }));
    }
  }
  return Object.freeze({ passed: Object.freeze(passed) });
}

/** Clone and freeze the script so fixtures cannot mutate later assertions. */
export function assertAdConformanceVector(value: unknown): AdConformanceVector {
  const record = asRecord(cloneValue(value, 0));
  if (typeof record.vector !== 'string' || !/^[a-z][a-z0-9-]{0,127}$/.test(record.vector)
    || record.protocol !== adProtocol || record.version !== adProtocolVersion) {
    throw new TypeError('Invalid advertising vector identity or protocol.');
  }
  const profile = asRecord(record.profile);
  if (!Array.isArray(profile.formats) || profile.formats.some((format) => format !== 'rewarded' && format !== 'interstitial')
    || typeof profile.configured !== 'boolean'
    || (profile.rewardSignal !== 'immediate' && profile.rewardSignal !== 'delayed')) {
    throw new TypeError('Invalid advertising vector profile.');
  }
  if (!Array.isArray(record.steps) || record.steps.length === 0 || record.steps.length > 500) {
    throw new TypeError('Invalid advertising vector steps.');
  }
  if ((profile.policyEnabled !== undefined && typeof profile.policyEnabled !== 'boolean')
    || (profile.actionRequired !== undefined && typeof profile.actionRequired !== 'boolean')
    || (profile.preparation !== undefined && !['ready', 'deferred', 'unavailable', 'failed'].includes(profile.preparation as string))) {
    throw new TypeError('Invalid advertising vector policy or preparation.');
  }
  for (const supplied of record.steps) {
    const step = asRecord(supplied);
    if (typeof step.actor !== 'string' || !Object.hasOwn(actions, step.actor)
      || typeof step.action !== 'string' || !actions[step.actor as AdConformanceActor].includes(step.action)) {
      throw new TypeError('Invalid advertising vector actor/action.');
    }
    if (['start', 'disposeView', 'started', 'rewardEarned', 'closed', 'failed', 'grant', 'reject', 'recover'].includes(step.action)
      && (typeof step.invocationId !== 'string' || step.invocationId.trim() === '' || step.invocationId.length > 512)) {
      throw new TypeError('Invalid advertising step invocation identity.');
    }
    if (step.action === 'start' || step.action === 'prepare') {
      if ((step.format !== 'rewarded' && step.format !== 'interstitial'
        && !(step.action === 'start' && step.format === 'purchase'))
        || typeof step.placementId !== 'string' || step.placementId.trim() === '') {
        throw new TypeError('Invalid advertising step placement.');
      }
    }
    if (step.actor === 'clock' && (!Number.isSafeInteger(step.milliseconds) || (step.milliseconds as number) < 0)) {
      throw new TypeError('Invalid advertising clock advance.');
    }
    if ((step.action === 'block' || step.action === 'release')
      && (typeof step.owner !== 'string' || step.owner.trim() === '')) {
      throw new TypeError('Invalid advertising execution owner.');
    }
    if (step.expect !== undefined) {
      assertExpectation(step.expect);
    }
  }
  assertExpectation(record.expect);
  return record as unknown as AdConformanceVector;
}

function assertExpectation(value: unknown): void {
  const expected = asRecord(value);
  if (Object.keys(expected).length === 0 || Object.keys(expected).some((key) => !observationKeys.has(key))) {
    throw new TypeError('Invalid advertising vector expectations.');
  }
}

function assertUnique(names: readonly string[], kind: string): void {
  const unique = new Set<string>();
  for (const name of names) {
    if (typeof name !== 'string' || name.trim() === '' || unique.has(name)) {
      throw new TypeError(`Invalid or duplicate ad conformance ${kind} name.`);
    }
    unique.add(name);
  }
}

function asRecord(value: unknown): Record<string, AdConformanceValue> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Expected an advertising conformance object.');
  }
  return value as Record<string, AdConformanceValue>;
}

function cloneValue(value: unknown, depth: number): AdConformanceValue {
  if (depth > 12) {
    throw new TypeError('Advertising conformance value is too deeply nested.');
  }
  if (value === null || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string' && value.length <= 8192) {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (Array.isArray(value) && value.length <= 500) {
    return Object.freeze(value.map((entry) => cloneValue(entry, depth + 1)));
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const entries = Object.entries(value);
    if (entries.length <= 128 && entries.every(([key]) => key.length <= 128)) {
      return Object.freeze(
        Object.fromEntries(entries.map(([key, entry]) => [key, cloneValue(entry, depth + 1)])),
      );
    }
  }
  throw new TypeError('Invalid advertising conformance value.');
}

function assertMatches(actual: AdConformanceValue, expected: AdConformanceValue, path: string): void {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) {
      throw new Error(`Advertising observation differs at ${path}.`);
    }
    for (let i = 0; i < expected.length; i += 1) {
      const wanted = expected[i];
      const observed = actual[i];
      if (wanted === undefined || observed === undefined) {
        throw new Error(`Advertising observation missing at ${path}[${i}].`);
      }
      assertMatches(observed, wanted, `${path}[${i}]`);
    }
    return;
  }
  if (expected !== null && typeof expected === 'object') {
    const record = asRecord(actual);
    for (const [key, wanted] of Object.entries(expected)) {
      const observed = record[key];
      if (!Object.hasOwn(record, key) || observed === undefined) {
        throw new Error(`Advertising observation missing at ${path}.${key}.`);
      }
      assertMatches(observed, wanted, `${path}.${key}`);
    }
    return;
  }
  if (actual !== expected) {
    throw new Error(`Advertising observation differs at ${path}.`);
  }
}
