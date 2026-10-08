/// <reference types="node" />

import { readdirSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  createAdSession,
  reduceAdSession,
  type AdPresentationEvent,
  type AdSessionSnapshot,
} from './ads.js';
import {
  assertAdConformanceVector,
  runAdConformance,
  type AdConformanceDriver,
  type AdConformanceFixture,
  type AdConformanceStep,
  type AdConformanceValue,
} from './ads-conformance.js';

const vectorDirectory = new URL('../../../docs/specs/ads/vectors/', import.meta.url);
const vectors: unknown[] = readdirSync(vectorDirectory).filter((file) => file.endsWith('.json'))
  .sort().map((file) => JSON.parse(readFileSync(new URL(file, vectorDirectory), 'utf8')) as unknown);

interface Flight {
  snapshot: AdSessionSnapshot;
  disposed: boolean;
  claim?: 'pending' | 'granted' | 'rejected';
  normalization?: 'rejected';
  ledgerEntryId?: string;
}

/** Test-only reference ports: SDK events and backend grants must be explicitly scripted. */
class ReferenceDriver implements AdConformanceDriver {
  readonly flights = new Map<string, Flight>();
  readonly outcomes = new Map<string, string>();
  readonly ledger = new Map<string, string>();
  readonly ledgerIds = new Map<string, string>();
  readonly callers = new Map<string, string>();
  readonly reasons = new Map<string, string>();
  readonly owners = new Set<string>();
  active: string | undefined;
  last: string | undefined;
  sdkShows = 0;
  claimRequests = 0;
  lateCloseObserved = false;
  preparation = 'ready';
  unavailableReason: string | undefined;

  constructor(readonly profile: Readonly<Record<string, AdConformanceValue>>) {}

  async step(step: AdConformanceStep): Promise<void> {
    if (step.actor === 'game') {
      const id = String(step.invocationId);
      if (step.action === 'prepare') {
        this.preparation = typeof this.profile.preparation === 'string' ? this.profile.preparation : 'ready';
        return;
      }
      if (step.action === 'disposeView') {
        this.flight(id).disposed = true;
        return;
      }
      if (this.flights.has(id) || this.outcomes.has(id)) {
        this.callers.set(typeof step.callerId === 'string' ? step.callerId : id, id);
        return;
      }
      this.callers.set(typeof step.callerId === 'string' ? step.callerId : id, id);
      if (this.active !== undefined) {
        this.outcomes.set(id, 'unavailable');
        this.reasons.set(id, 'busy');
        return;
      }
      const formats = this.profile.formats;
      const supported = Array.isArray(formats) && formats.includes(step.format);
      if (step.format === 'purchase') {
        throw new Error('Reference purchase display was not scripted.');
      }
      const format = step.format === 'interstitial' ? 'interstitial' : 'rewarded';
      this.last = id;
      this.flights.set(id, {
        snapshot: createAdSession({
          providerId: 'fixture-provider',
          invocationId: id,
          format,
          rewardSignal: this.profile.rewardSignal === 'delayed' ? 'delayed' : 'immediate',
        }),
        disposed: false,
      });
      if (!supported || this.profile.configured !== true || this.profile.policyEnabled === false || this.profile.actionRequired === true) {
        this.unavailableReason = !supported ? 'unsupported'
          : this.profile.configured !== true ? 'configuration-required'
          : this.profile.policyEnabled === false ? 'policy-disabled' : 'action-required';
        this.outcomes.set(id, 'unavailable');
        return;
      }
      this.active = id;
      this.sdkShows += 1;
      this.owners.add(`ad:${id}`);
      return;
    }
    if (step.actor === 'runtime') {
      if (step.action === 'block') {
        this.owners.add(String(step.owner));
      } else if (step.action === 'release') {
        this.owners.delete(String(step.owner));
      } else if (step.action === 'restart') {
        for (const flight of this.flights.values()) {
          flight.disposed = true;
        }
        this.active = undefined;
        this.owners.clear();
      } else if (step.action === 'recover') {
        // Read the retained claim; never invoke the SDK from recovery.
        this.flight(String(step.invocationId));
      }
      return;
    }
    if (step.actor === 'clock') {
      if (Number(step.milliseconds) >= 30000 && this.active !== undefined) {
        const flight = this.flight(this.active);
        flight.snapshot = reduceAdSession(flight.snapshot, {
          providerId: 'fixture-provider', invocationId: this.active,
          sequence: flight.snapshot.sequence + 1, type: 'unknown',
        });
        this.outcomes.set(this.active, 'pending');
        if (flight.snapshot.eligibility === 'eligible') {
          this.claim(flight);
        }
      }
      return;
    }
    const id = String(step.invocationId);
    const flight = this.flight(id);
    if (step.actor === 'backend') {
      if (flight.claim === undefined) {
        throw new Error('Backend grant/rejection without a scripted claim.');
      }
      if (step.action === 'reject') {
        flight.claim = 'rejected';
        return;
      }
      const impressionId = String(step.verifiedImpressionId);
      const expectedBinding = {
        playerId: 'test-player',
        placementId: 'CONTINUE',
        invocationId: id,
        deploymentId: 'fixture-deployment',
        providerId: 'fixture-provider',
      };
      const payload = flight.snapshot.evidence?.payload;
      if (payload !== undefined && Object.entries(expectedBinding).some(([key, expected]) => payload[key] !== expected)) {
        flight.claim = 'rejected';
        return;
      }
      const previous = this.ledger.get(impressionId);
      if (previous !== undefined && previous !== id) {
        flight.claim = 'rejected';
      } else {
        this.ledger.set(impressionId, id);
        if (!this.ledgerIds.has(impressionId)) {
          this.ledgerIds.set(impressionId, String(step.ledgerEntryId));
        }
        const ledgerEntryId = this.ledgerIds.get(impressionId);
        if (ledgerEntryId !== undefined) {
          flight.ledgerEntryId = ledgerEntryId;
        }
        flight.claim = 'granted';
      }
      return;
    }
    const base = {
      providerId: 'fixture-provider',
      invocationId: id,
      sequence: flight.snapshot.sequence + 1,
    };
    let event: AdPresentationEvent;
    if (step.action === 'rewardEarned') {
      event = {
        ...base, type: 'reward-earned',
        evidence: {
          schema: typeof step.schema === 'string' ? step.schema : 'fixture.reward.v1',
          payload: {
            impressionId: id, playerId: 'test-player', placementId: 'CONTINUE', invocationId: id,
            deploymentId: 'fixture-deployment', providerId: 'fixture-provider',
            ...(typeof step.binding === 'object' && step.binding !== null && !Array.isArray(step.binding) ? step.binding : {}),
          } as Record<string, string | number | boolean>,
        },
      };
    } else if (step.action === 'failed') {
      event = { ...base, type: 'failed', reason: 'transient-failure' };
    } else {
      event = { ...base, type: step.action === 'started' ? 'started' : 'closed' };
    }
    const previous = flight.snapshot;
    flight.snapshot = reduceAdSession(previous, event);
    if (event.type === 'closed' || event.type === 'failed') {
      if (this.active === id) {
        this.active = undefined;
        this.owners.delete(`ad:${id}`);
      }
      if (previous.presentation === 'unknown' && event.type === 'closed') {
        this.lateCloseObserved = true;
      }
      if (!this.outcomes.has(id)) {
        this.outcomes.set(
          id,
          event.type === 'failed' ? 'failed' : previous.started ? 'shown' : 'skipped',
        );
      }
      if (flight.snapshot.format === 'rewarded' && (flight.snapshot.eligibility === 'eligible'
        || flight.snapshot.eligibility === 'unknown' && flight.snapshot.rewardSignal === 'delayed')) {
        this.claim(flight);
      }
    }
  }

  claim(flight: Flight): void {
    if (flight.claim !== undefined) {
      return;
    }
    if (flight.snapshot.evidence !== undefined && flight.snapshot.evidence.schema !== 'fixture.reward.v1') {
      flight.normalization = 'rejected';
      return;
    }
    flight.claim = 'pending';
    this.claimRequests += 1;
  }

  flight(id: string): Flight {
    const flight = this.flights.get(id);
    if (flight === undefined) {
      throw new Error('SDK/backend event without a scripted invocation.');
    }
    return flight;
  }

  async read(): Promise<Readonly<Record<string, AdConformanceValue>>> {
    const last = this.last === undefined ? undefined : this.flights.get(this.last);
    const reason = this.unavailableReason ?? last?.snapshot.reason;
    return {
      sdkShows: this.sdkShows,
      claimRequests: this.claimRequests,
      ledgerGrants: this.ledger.size,
      purchaseUiOpened: 0,
      occupied: this.active !== undefined,
      outcomes: Object.fromEntries(this.outcomes),
      reasons: Object.fromEntries(this.reasons),
      callerResults: Object.fromEntries(
        [...this.callers].flatMap(([caller, invocationId]) => {
          const outcome = this.outcomes.get(invocationId);
          return outcome === undefined ? [] : [[caller, { invocationId, outcome }]];
        }),
      ),
      claims: Object.fromEntries(
        [...this.flights].flatMap(([id, flight]) =>
          flight.claim === undefined ? [] : [[id, flight.claim]],
        ),
      ),
      presentation: last?.snapshot.presentation ?? 'not-started',
      eligibility: last?.snapshot.eligibility ?? 'unknown',
      claimState: last?.claim ?? 'not-requested',
      preparation: this.preparation,
      lateCloseObserved: this.lateCloseObserved,
      updatesAfterViewDisposal: 0,
      activeInvocationId: this.active ?? '',
      executionOwners: [...this.owners],
      ...(last?.normalization === undefined ? {} : { normalization: last.normalization }),
      ...(last?.ledgerEntryId === undefined ? {} : { ledgerEntryId: last.ledgerEntryId }),
      ...(reason === undefined ? {} : { reason }),
    };
  }

  async dispose(): Promise<void> {}
}

const reference: AdConformanceFixture = {
  name: 'reference-ports',
  async create(input) {
    return new ReferenceDriver(input.profile);
  },
};

describe('advertising conformance orchestration', () => {
  it('runs all committed vectors against scripted SDK and ledger reference ports', async () => {
    const report = await runAdConformance({ vectors, fixtures: [reference] });
    expect(report.passed).toHaveLength(vectors.length);
    expect(new Set(report.passed.map((item) => item.vector)).size).toBe(vectors.length);
  });

  it('rejects an adapter that releases another execution owner', async () => {
    const vector = vectors.find((value) => assertAdConformanceVector(value).vector === 'background-ownership');
    const broken: AdConformanceFixture = {
      name: 'broken-resume',
      async create(input) {
        const driver = new ReferenceDriver(input.profile);
        return {
          step: async (step) => {
            await driver.step(step);
            if (step.action === 'closed') {
              driver.owners.clear();
            }
          },
          read: () => driver.read(),
          dispose: () => driver.dispose(),
        };
      },
    };
    await expect(runAdConformance({ vectors: [vector], fixtures: [broken] })).rejects.toThrow('broken-resume/background-ownership');
  });

  it('cleans up a failed fixture and retains the original failure when cleanup also fails', async () => {
    let disposed = false;
    const fixture: AdConformanceFixture = {
      name: 'throwing-sdk',
      async create() {
        return {
          async step() { throw new Error('sdk failed'); },
          async read() { return {}; },
          async dispose() { disposed = true; throw new Error('cleanup failed'); },
        };
      },
    };
    const failure = await runAdConformance({ vectors: [vectors[0]], fixtures: [fixture] }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).cause).toMatchObject({ message: 'sdk failed' });
    expect(disposed).toBe(true);
  });

  it('hides expectations from fixtures and freezes scripts against accidental mutation', async () => {
    const input = assertAdConformanceVector(vectors[0]);
    expect(Object.isFrozen(input.profile)).toBe(true);
    expect(Object.isFrozen(input.expect)).toBe(true);
    await runAdConformance({ vectors: [input], fixtures: [{
      name: 'isolated',
      async create(context) {
        expect(context).not.toHaveProperty('expect');
        expect(context).not.toHaveProperty('steps');
        return reference.create(context);
      },
    }] });
  });

  it('rejects malformed scripts and duplicate names before creating a driver', async () => {
    await expect(runAdConformance({ vectors: [], fixtures: [reference] })).rejects.toThrow();
    await expect(runAdConformance({ vectors, fixtures: [reference, reference] })).rejects.toThrow('duplicate');
    await expect(runAdConformance({ vectors: [vectors[0], vectors[0]], fixtures: [reference] })).rejects.toThrow('duplicate');
    const vector = assertAdConformanceVector(vectors[0]);
    expect(() => assertAdConformanceVector({ ...vector, steps: [{ actor: 'sdk', action: 'award-money', invocationId: 'a' }] })).toThrow();
    expect(() => assertAdConformanceVector({ ...vector, steps: [{ actor: 'clock', action: 'advance', milliseconds: -1 }] })).toThrow();
    expect(() => assertAdConformanceVector({ ...vector, expect: { success: true } })).toThrow();
    expect(() => assertAdConformanceVector({
      ...vector, steps: [{ actor: 'backend', action: 'grant', invocationId: 'a', ledgerEntryId: 'ledger-a' }],
    })).toThrow('grant identity');
    expect(() => assertAdConformanceVector({
      ...vector, steps: [{ actor: 'backend', action: 'grant', invocationId: 'a', verifiedImpressionId: 'impression-a', ledgerEntryId: '' }],
    })).toThrow('grant identity');
  });
});
