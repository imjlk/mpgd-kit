import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  adaptDerivedPurchaseKey,
  adaptDerivedPurchaseKeyStore,
  addIsoDuration,
  commerceConformanceAdaptiveSkipReason,
  CommerceConformanceAnotherAccountError,
  commerceConformanceDefaultClockStart,
  commerceConformanceJournalKey,
  compareCreditLotSpendOrder,
  createCommerceConformanceBackend,
  createCommerceConformanceCapabilities,
  createCommerceConformanceClock,
  createCommerceConformanceHarness,
  createCommerceConformanceJournal,
  createCommerceConformanceRuntime,
  createCommerceConformanceStore,
  createCommerceConformanceWallet,
  createCommerceConformanceWalletProvider,
  deriveAdaptiveCommerceConformanceExpectation,
  fillCommerceConformancePurchase,
  isAdaptiveCommerceConformanceVector,
  isCommerceConformanceStoreAccountMismatchReason,
  isCommerceJournalRecordParked,
  matchPartial,
  runCommerceConformanceVector,
  runCommerceConformanceVectors,
  withStoreTokens,
  type CommerceConformanceAdaptation,
  type CommerceConformanceContext,
  type CommerceConformanceFailure,
  type CommerceConformanceHarness,
  type CommerceConformanceStoreActor,
  type CommerceConformanceVectorResult,
  type CommerceJournalRecord,
  type CommerceJournalStore,
} from './commerce-conformance.js';
import {
  assertCommerceConformanceVector,
  type CommerceConformanceProfile,
  type CommerceConformancePurchaseFixture,
  type CommerceConformanceVector,
} from './commerce-vectors.js';
import {
  createDerivedPurchaseIdempotencyKey,
  isTerminalCommercePurchaseState,
  type CommerceFinishOwner,
  type CommerceProvider,
  type CreditLot,
  type GetAvailablePurchasesInput,
} from './commerce.js';

const vectorsDir = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'docs',
  'specs',
  'commerce',
  'vectors',
);
const vectorFiles = readdirSync(vectorsDir).filter((file) => file.endsWith('.json')).sort();

function readVector(file: string): CommerceConformanceVector {
  return assertCommerceConformanceVector(
    JSON.parse(readFileSync(join(vectorsDir, file), 'utf8')) as unknown,
  );
}

const vectors = vectorFiles.map(readVector);

const reconcilerVectorsDir = join(vectorsDir, '..', 'reconciler-vectors');
const reconcilerVectors = readdirSync(reconcilerVectorsDir)
  .filter((file) => file.endsWith('.json'))
  .sort()
  .map((file) => assertCommerceConformanceVector(
    JSON.parse(readFileSync(join(reconcilerVectorsDir, file), 'utf8')) as unknown,
  ));

function reconcilerVectorNamed(name: string): CommerceConformanceVector {
  const vector = reconcilerVectors.find((candidate) => candidate.vector === name);
  if (vector === undefined) {
    throw new Error(`Missing reconciler vector ${name}.`);
  }
  return vector;
}

function vectorNamed(name: string): CommerceConformanceVector {
  const vector = vectors.find((candidate) => candidate.vector === name);
  if (vector === undefined) {
    throw new Error(`Missing vector ${name}.`);
  }
  return vector;
}

const clientTokenProfile = vectorNamed('purchase-client-finish').profile;
const gemsCatalog = vectorNamed('purchase-client-finish').catalog ?? [];

describe("reconciler vectors (another account's purchase)", () => {
  it('passes every reconciler vector with the reference reconciler', async () => {
    const results = await runCommerceConformanceVectors(reconcilerVectors);
    expect(results.map((result) => [result.vector, result.status, result.failures])).toEqual(
      reconcilerVectors.map((vector) => [vector.vector, 'passed', []]),
    );
    expect(results).toHaveLength(6);
  });

  it('fails when a parked record is expected to have ended', async () => {
    const vector = reconcilerVectorNamed('another-account-http-parks');
    const result = await runCommerceConformanceVector({
      ...vector,
      expect: { ...vector.expect, parked: {} },
    });
    expect(result.status).toBe('failed');
    expect(result.failures).toEqual([
      { path: 'parked', expected: [], actual: ['store:fixture.client-token:tx-1'] },
    ]);
  });

  it('fails a vector whose parked record was resent by a pass', async () => {
    const vector = reconcilerVectorNamed('another-account-legacy-rejected-parks');
    const result = await runCommerceConformanceVector({
      ...vector,
      expect: {
        ...vector.expect,
        verifyRequests: [...(vector.expect.verifyRequests ?? []), ...(vector.expect.verifyRequests ?? [])],
      },
    });
    expect(result.failures).toEqual([{ path: 'verifyRequests.length', expected: 2, actual: 1 }]);
  });

  it('throws the another-account answer from the fake backend and keeps nothing', async () => {
    const backend = createCommerceConformanceBackend();
    backend.queueVerify({
      status: 'another-account',
      reason: 'GOOGLE_PLAY_ACCOUNT_MISMATCH',
      transport: 'orpc',
    });
    const request = {
      idempotencyKey: 'op-1',
      playerId: 'player-1',
      store: 'fixture.client-token',
      transactionId: 'tx-1',
      token: 'token-1',
      logicalId: 'gems_small',
      quantity: 1,
      evidence: { schema: 'fixture.fixture.client-token.v1', payload: { token: 'token-1' } },
    } as const;
    const error = await backend.verifyPurchase(request).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(CommerceConformanceAnotherAccountError);
    expect(error).toMatchObject({
      code: 'PURCHASE_BOUND_TO_ANOTHER_ACCOUNT',
      reason: 'GOOGLE_PLAY_ACCOUNT_MISMATCH',
      transport: 'orpc',
    });
    expect(backend.ledger).toEqual([]);
    backend.queueVerify({ status: 'rejected', reason: 'GOOGLE_PLAY_ACCOUNT_ID_MISSING' });
    expect(await backend.verifyPurchase(request)).toEqual({
      status: 'rejected',
      reason: 'GOOGLE_PLAY_ACCOUNT_ID_MISSING',
    });
  });

  it('refuses a same-state revision unless it parks or unparks a verifying record', async () => {
    const journal = createCommerceConformanceJournal();
    const { record } = await journal.reserve({
      key: 'op-1',
      revision: 0,
      playerId: 'player-1',
      store: 'fixture.client-token',
      logicalId: 'gems_small',
      kind: 'consumable',
      origin: 'game',
      state: 'verifying',
      updatedAt: commerceConformanceDefaultClockStart,
    });
    await expect(journal.replace(0, { ...record, revision: 1 })).rejects.toThrow(
      /must change its state/u,
    );
    const parked = await journal.replace(0, {
      ...record,
      anotherAccount: { reason: 'GOOGLE_PLAY_ACCOUNT_MISMATCH', reportedAt: record.updatedAt },
    });
    expect(isCommerceJournalRecordParked(parked)).toBe(true);
    const { anotherAccount: _marker, ...unparked } = parked;
    await journal.replace(1, unparked);
    expect(journal.history('op-1')).toEqual(['verifying']);
  });

  it("refuses another player's key unless its record is parked", async () => {
    const vector = reconcilerVectorNamed('rejected-other-reason-ends');
    const result = await runCommerceConformanceVector({
      ...vector,
      steps: [
        ...vector.steps,
        { actor: 'runtime', action: 'switchPlayer', playerId: 'player-2' },
        { actor: 'runtime', action: 'start' },
      ],
    });
    // The rejected record keeps its key: player 2 neither journals nor sends the purchase.
    expect(result.failures).toEqual([]);
    expect(commerceConformanceJournalKey('k', 'player-2')).toBe('k@player-2');
  });

  it('never parks a thrown another-account error whose reason is not a binding mismatch', async () => {
    const vector = reconcilerVectorNamed('another-account-http-parks');
    const result = await runCommerceConformanceVector({
      ...vector,
      steps: vector.steps.map((step) =>
        step.actor === 'backend' && step.action === 'queueVerify'
          // A vector the validator refuses, built in code: the runtime path refuses it too.
          ? { ...step, decision: { status: 'another-account', reason: 'GOOGLE_PLAY_ACCOUNT_ID_MISSING' } as never }
          : step),
    });
    expect(result.status).toBe('failed');
    expect(result.failures[0]?.path).toBe('steps[2]');
    expect(String(result.failures[0]?.actual)).toContain('GOOGLE_PLAY_ACCOUNT_ID_MISSING');
    expect(isCommerceConformanceStoreAccountMismatchReason('GOOGLE_PLAY_ACCOUNT_ID_MISSING'))
      .toBe(false);
  });

  it("refuses a player-scoped key another player's record holds", async () => {
    const vector = reconcilerVectorNamed('another-account-owner-recovers');
    const shared = 'store:fixture.client-token:tx-1';
    const switchAt = vector.steps.findIndex((step) => step.action === 'switchPlayer');
    const result = await runCommerceConformanceVector({
      ...vector,
      steps: [
        ...vector.steps.slice(0, switchAt),
        // Player 1's game key spells player 2's scoped key for the purchase.
        {
          actor: 'game',
          action: 'requestPurchase',
          input: { logicalId: 'gems_small', idempotencyKey: `${shared}@player-2` },
          returns: { outcome: 'launched' },
        },
        { actor: 'runtime', action: 'switchPlayer', playerId: 'player-2' },
        { actor: 'runtime', action: 'start' },
        { actor: 'backend', action: 'queueVerify', decision: { status: 'granted', ledgerEntryId: 'le-2' } },
        {
          actor: 'game',
          action: 'requestPurchase',
          input: { logicalId: 'gems_small', idempotencyKey: 'op-p2' },
          returns: { outcome: 'launched' },
        },
        {
          actor: 'store',
          action: 'complete',
          purchase: { transactionId: 'tx-2', storeSku: 'gems.small', token: 'token-2', state: 'purchased' },
        },
      ],
      expect: {
        journal: {
          [shared]: ['purchased', 'verifying'],
          [`${shared}@player-2`]: ['requested', 'launched'],
          'op-p2': ['requested', 'launched', 'purchased', 'verifying', 'granted', 'finishing', 'finished'],
        },
        parked: { [shared]: 'GOOGLE_PLAY_ACCOUNT_MISMATCH' },
        verifyRequests: [
          { idempotencyKey: shared, store: 'fixture.client-token', transactionId: 'tx-1', token: 'token-1', playerId: 'player-1' },
          { idempotencyKey: 'op-p2', store: 'fixture.client-token', transactionId: 'tx-2', token: 'token-2', playerId: 'player-2' },
        ],
      },
    });
    // Remembering player 1's record would make it a second open attempt of
    // player 2's product, and tx-2 would match two records.
    expect(result.failures).toEqual([]);
  });

  it("keeps a restore grant's completed server finalization for the finishing pass", async () => {
    const vector = reconcilerVectorNamed('another-account-restore-resends');
    const result = await runCommerceConformanceVector({
      ...vector,
      profile: {
        ...vector.profile,
        lifecycle: {
          availablePurchases: true,
          pending: false,
          restore: true,
          events: true,
          finish: 'server',
        },
      },
      steps: vector.steps.map((step) =>
        step.actor === 'backend' && step.action === 'queueVerify' && step.decision.status === 'granted'
          ? { ...step, decision: { ...step.decision, finalization: 'completed' as const } }
          : step),
      // The grant completed the server finish: the fixture's two verify
      // requests stay the only ones, and nothing re-reads finalization.
      expect: { ...vector.expect, finishCalls: [] },
    });
    expect(result.failures).toEqual([]);
  });

  describe('a parked record the journal pruned while the runtime held it', () => {
    /**
     * A journal that can drop records, as a journal's retention does. A key in
     * `dropAfterRead` is dropped right after its next read: another
     * context's save between Restore's re-read and its write.
     */
    function createPruningJournal(): {
      readonly records: Map<string, CommerceJournalRecord>;
      readonly dropAfterRead: Set<string>;
      readonly journal: CommerceJournalStore;
    } {
      const records = new Map<string, CommerceJournalRecord>();
      const dropAfterRead = new Set<string>();
      const list = (playerId: string, accept: (record: CommerceJournalRecord) => boolean) =>
        [...records.values()].filter((record) => record.playerId === playerId && accept(record));
      return {
        records,
        dropAfterRead,
        journal: {
          async reserve(record) {
            const existing = records.get(record.key);
            if (existing !== undefined) {
              return { created: false, record: existing };
            }
            records.set(record.key, record);
            return { created: true, record };
          },
          async read(key) {
            const record = records.get(key);
            if (dropAfterRead.delete(key)) {
              records.delete(key);
            }
            return record;
          },
          async replace(expectedRevision, record) {
            const existing = records.get(record.key);
            if (existing === undefined || existing.revision !== expectedRevision) {
              throw new Error(`Journal record ${record.key} is gone or stale.`);
            }
            const stored = { ...record, revision: expectedRevision + 1 };
            records.set(record.key, stored);
            return stored;
          },
          async listRecoverable(playerId) {
            return list(playerId, (record) => !isTerminalCommercePurchaseState(record.state));
          },
          async listGranted(playerId) {
            return list(playerId, (record) => record.ledgerEntryId !== undefined
              && (record.state === 'granted' || record.state === 'finishing' || record.state === 'finished'));
          },
        },
      };
    }

    async function parkThenRestore(prune: (input: {
      readonly key: string;
      readonly records: Map<string, CommerceJournalRecord>;
      readonly dropAfterRead: Set<string>;
    }) => void) {
      const vector = reconcilerVectorNamed('another-account-restore-resends');
      const context = { profile: vector.profile, catalog: vector.catalog ?? [], playerId: 'player-1' };
      const store = createCommerceConformanceStore(context);
      const backend = createCommerceConformanceBackend();
      const { records, dropAfterRead, journal } = createPruningJournal();
      const runtime = createCommerceConformanceRuntime({
        provider: store.provider,
        backend,
        journal,
        clock: createCommerceConformanceClock(),
        catalog: context.catalog,
        playerId: 'player-1',
      });
      const key = 'store:fixture.client-token:tx-1';
      await runtime.start();
      backend.queueVerify({ status: 'another-account', reason: 'GOOGLE_PLAY_ACCOUNT_MISMATCH' });
      store.complete({ transactionId: 'tx-1', storeSku: 'remove.ads', token: 'token-1', state: 'purchased' });
      await runtime.runUntilIdle();
      expect(records.get(key)?.anotherAccount?.reason).toBe('GOOGLE_PLAY_ACCOUNT_MISMATCH');
      prune({ key, records, dropAfterRead });
      backend.queueVerify({ status: 'granted', ledgerEntryId: 'le-1' });
      await expect(runtime.restorePurchases?.()).resolves.toBeUndefined();
      return { key, records, backend, store };
    }

    it('re-reads it before Restore writes it and ingests the purchase anew', async () => {
      const { key, records, backend, store } = await parkThenRestore(({ key: pruned, records }) => {
        records.delete(pruned);
      });
      expect(records.get(key)).toMatchObject({ state: 'finished', revision: 4, ledgerEntryId: 'le-1' });
      expect(records.get(key)?.anotherAccount).toBeUndefined();
      expect(backend.verifyRequests).toHaveLength(2);
      expect(store.purchases).toEqual([]);
    });

    it('ingests it anew when it is pruned between the re-read and the write', async () => {
      const { key, records, backend } = await parkThenRestore(({ key: pruned, dropAfterRead }) => {
        dropAfterRead.add(pruned);
      });
      expect(records.get(key)).toMatchObject({ state: 'finished', ledgerEntryId: 'le-1' });
      expect(records.get(key)?.anotherAccount).toBeUndefined();
      expect(backend.verifyRequests).toHaveLength(2);
    });
  });

  it('fails a restore step against a runtime without restorePurchases', async () => {
    const vector = reconcilerVectorNamed('another-account-restore-resends');
    const result = await runCommerceConformanceVector(vector, {
      createRuntime(input) {
        const { restorePurchases: _restore, ...runtime } = createCommerceConformanceRuntime(input);
        return runtime;
      },
    });
    expect(result.status).toBe('failed');
    expect(result.failures[0]?.path).toBe('steps[6]');
    expect(String(result.failures[0]?.actual)).toContain('has no restorePurchases');
  });
});

describe('commerce conformance runner', () => {
  it('passes every RFC vector with the reference provider', async () => {
    const results = await runCommerceConformanceVectors(vectors);
    expect(results).toHaveLength(14);
    const failed = results.filter((result) => !result.passed);
    expect(failed.map((result) => ({ vector: result.vector, failures: result.failures })))
      .toEqual([]);
    expect(results.every((result) => result.failures.length === 0)).toBe(true);
  });

  it.each(vectorFiles)('%s passes on its own', async (file) => {
    const result = await runCommerceConformanceVector(readVector(file));
    expect(result.failures).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it('reports a deliberately altered expectation with a readable path', async () => {
    const vector = vectorNamed('purchase-client-finish');
    const altered: CommerceConformanceVector = {
      ...vector,
      expect: {
        ...vector.expect,
        journal: { 'op-1': ['requested', 'launched', 'purchased', 'verifying', 'granted'] },
        finishCalls: [
          { ...(vector.expect.finishCalls?.[0] ?? {
            by: 'client', transactionId: 'tx-1', ledgerEntryId: 'le-1', isConsumable: true,
            result: 'finished',
          }), isConsumable: false },
        ],
      },
    };
    const result = await runCommerceConformanceVector(altered);
    expect(result.passed).toBe(false);
    expect(result.failures).toEqual([
      { path: 'journal.op-1.length', expected: 5, actual: 7 },
      { path: 'finishCalls[0].isConsumable', expected: false, actual: true },
    ]);
  });

  it('fails a vector that needs an unscripted verify at the step that needed it', async () => {
    const vector = vectorNamed('purchase-client-finish');
    const unscripted: CommerceConformanceVector = {
      ...vector,
      steps: vector.steps.filter((step) => step.action !== 'queueVerify'),
    };
    const result = await runCommerceConformanceVector(unscripted);
    expect(result.passed).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.path).toBe('steps[2]');
    expect(String(result.failures[0]?.actual)).toContain('Unscripted verify for op-1');
  });

  it('fails a vector that names an unknown logical id', async () => {
    const vector = vectorNamed('purchase-client-finish');
    const unknown: CommerceConformanceVector = {
      ...vector,
      steps: vector.steps.map((step) =>
        step.actor === 'game' && step.action === 'requestPurchase'
          ? { ...step, input: { ...step.input, logicalId: 'gems_unknown' } }
          : step,
      ),
    };
    const result = await runCommerceConformanceVector(unknown);
    expect(result.passed).toBe(false);
    expect(String(result.failures[0]?.actual)).toContain('Unknown logical id gems_unknown');
  });

  it('runs a vector against a caller-supplied harness', async () => {
    const seen: string[] = [];
    const result = await runCommerceConformanceVector(vectorNamed('purchase-host-finish'), {
      createProvider(context): CommerceConformanceHarness {
        seen.push(context.vector.vector, context.profile.store);
        const store = createCommerceConformanceStore(context);
        return { provider: store.provider, store };
      },
    });
    expect(result.failures).toEqual([]);
    expect(seen).toEqual(['purchase-host-finish', 'fixture.host-callback']);
  });

  it('matches only the listed fields and arrays in order', () => {
    const failures: CommerceConformanceFailure[] = [];
    matchPartial({ a: 1 }, { a: 1, b: 2 }, 'root', failures);
    matchPartial([{ a: 1 }], [{ a: 1, extra: true }], 'list', failures);
    expect(failures).toEqual([]);
    matchPartial([1, 2], [2, 1], 'order', failures);
    matchPartial({ a: { b: 1 } }, { a: { b: 2 } }, 'deep', failures);
    matchPartial({ a: 1 }, undefined, 'missing', failures);
    expect(failures).toEqual([
      { path: 'order[0]', expected: 1, actual: 2 },
      { path: 'order[1]', expected: 2, actual: 1 },
      { path: 'deep.a.b', expected: 1, actual: 2 },
      { path: 'missing', expected: { a: 1 }, actual: undefined },
    ]);
  });
});

describe('commerce conformance journal', () => {
  it('records every state revision per key through compare-and-replace', async () => {
    const journal = createCommerceConformanceJournal();
    const base = {
      key: 'op-1',
      revision: 0,
      playerId: 'player-1',
      store: 'fixture',
      logicalId: 'gems_small',
      kind: 'consumable' as const,
      origin: 'game' as const,
      state: 'requested' as const,
      updatedAt: '2026-10-01T00:00:00Z',
    };
    const reserved = await journal.reserve(base);
    expect(reserved).toEqual({ created: true, record: base });
    expect(await journal.reserve({ ...base, state: 'launched' })).toEqual({
      created: false,
      record: base,
    });
    const launched = await journal.replace(0, { ...base, state: 'launched' });
    expect(launched.revision).toBe(1);
    await expect(journal.replace(0, { ...base, state: 'purchased' })).rejects.toThrow(
      'is at revision 1, not 0',
    );
    await expect(journal.replace(1, { ...launched, state: 'launched' })).rejects.toThrow(
      'must change its state',
    );
    await expect(journal.replace(1, { ...launched, state: 'granted' })).rejects.toThrow(
      'cannot move from launched to granted',
    );
    await expect(journal.replace(1, { ...launched, playerId: 'player-2', state: 'purchased' }))
      .rejects.toThrow('identity cannot change');
    const purchased = await journal.replace(1, { ...launched, state: 'purchased' });
    expect(await journal.listRecoverable('player-1')).toEqual([purchased]);
    expect(await journal.listRecoverable('player-2')).toEqual([]);
    const cancelled = await journal.replace(2, { ...launched, state: 'verifying' });
    await journal.replace(3, { ...cancelled, state: 'rejected' });
    expect(await journal.listRecoverable('player-1')).toEqual([]);
    expect(await journal.read('op-1')).toMatchObject({ state: 'rejected', revision: 4 });
    expect(journal.history('op-1')).toEqual([
      'requested', 'launched', 'purchased', 'verifying', 'rejected',
    ]);
    expect(journal.snapshot()).toEqual({
      'op-1': ['requested', 'launched', 'purchased', 'verifying', 'rejected'],
    });
    expect(journal.history('missing')).toEqual([]);
  });

  it('lists granted records for revocation reporting, including finished ones', async () => {
    const journal = createCommerceConformanceJournal();
    const base = {
      key: 'op-1',
      revision: 0,
      playerId: 'player-1',
      store: 'fixture',
      logicalId: 'gems_small',
      kind: 'consumable' as const,
      origin: 'game' as const,
      state: 'purchased' as const,
      updatedAt: '2026-10-01T00:00:00Z',
    };
    await journal.reserve(base);
    const verifying = await journal.replace(0, { ...base, state: 'verifying' });
    const granted = await journal.replace(1, { ...verifying, state: 'granted', ledgerEntryId: 'le-1' });
    expect(await journal.listGranted('player-1')).toEqual([granted]);
    const finished = await journal.replace(2, { ...granted, state: 'finished' });
    expect(await journal.listGranted('player-1')).toEqual([finished]);
    expect(await journal.listRecoverable('player-1')).toEqual([]);
    await journal.replace(3, { ...finished, state: 'revoked' });
    expect(await journal.listGranted('player-1')).toEqual([]);
  });
});

function createStoreFixture(profile = clientTokenProfile, catalog = gemsCatalog) {
  const clock = createCommerceConformanceClock();
  const journal = createCommerceConformanceJournal();
  const store = createCommerceConformanceStore({ profile, catalog, playerId: 'player-1' });
  const backend = createCommerceConformanceBackend({
    finalize: (request) => store.finalize?.(request),
  });
  const runtime = createCommerceConformanceRuntime({
    provider: store.provider,
    backend,
    journal,
    clock,
    catalog,
    playerId: 'player-1',
  });
  return { clock, journal, store, backend, runtime };
}

describe('commerce conformance runtime', () => {
  it('rejects a second request for a product whose record is launched with IN_PROGRESS', async () => {
    const { runtime, journal, store } = createStoreFixture();
    await runtime.start();
    const first = await runtime.requestPurchase({
      logicalId: 'gems_small', idempotencyKey: 'op-1', source: 'shop',
    });
    expect(first).toEqual({ outcome: 'launched' });
    const second = await runtime.requestPurchase({
      logicalId: 'gems_small', idempotencyKey: 'op-2', source: 'shop',
    });
    expect(second.outcome).toBe('failed');
    expect(second).toMatchObject({ error: { code: 'IN_PROGRESS', retryable: false } });
    expect(journal.snapshot()).toEqual({
      'op-1': ['requested', 'launched'],
      'op-2': ['requested', 'failed'],
    });
    expect(store.purchaseUiOpened).toBe(1);
    const replay = await runtime.requestPurchase({
      logicalId: 'gems_small', idempotencyKey: 'op-1', source: 'shop',
    });
    expect(replay).toMatchObject({ outcome: 'failed', error: { code: 'IN_PROGRESS' } });
    expect(journal.history('op-1')).toEqual(['requested', 'launched']);
  });

  it('matches a purchase delivered before the listener to one derived-key record', async () => {
    const { runtime, journal, store, backend } = createStoreFixture();
    store.complete({ transactionId: 'tx-1', storeSku: 'gems.small', token: 'token-1', state: 'purchased' });
    store.complete({ transactionId: 'tx-1', storeSku: 'gems.small', token: 'token-1', state: 'purchased' });
    backend.queueVerify({ status: 'granted', ledgerEntryId: 'le-1' });
    await runtime.start();
    expect(journal.keys).toEqual(['store:fixture.client-token:tx-1']);
    expect(journal.history('store:fixture.client-token:tx-1')).toEqual([
      'purchased', 'verifying', 'granted', 'finishing', 'finished',
    ]);
    expect(backend.verifyRequests).toHaveLength(1);
    expect(backend.verifyRequests[0]).toMatchObject({
      idempotencyKey: 'store:fixture.client-token:tx-1',
      store: 'fixture.client-token',
      transactionId: 'tx-1',
      token: 'token-1',
      logicalId: 'gems_small',
      playerId: 'player-1',
    });
    expect(store.finishCalls).toEqual([
      { by: 'client', transactionId: 'tx-1', ledgerEntryId: 'le-1', isConsumable: true, result: 'finished' },
    ]);
    expect(await store.provider.getAvailablePurchases({ includePending: true })).toEqual([]);
  });

  it('rejects an unsupported request before any store UI opens', async () => {
    const { runtime, journal, store } = createStoreFixture();
    const result = await runtime.requestPurchase({
      logicalId: 'gems_small', idempotencyKey: 'op-1', source: 'shop', quantity: 2,
    });
    expect(result).toMatchObject({ outcome: 'failed', error: { code: 'ITEM_UNAVAILABLE' } });
    expect(store.purchaseUiOpened).toBe(0);
    expect(journal.history('op-1')).toEqual(['requested', 'failed']);
  });

  it('keeps a rejected verify terminal and never finishes it', async () => {
    const { runtime, journal, store, backend } = createStoreFixture();
    await runtime.start();
    backend.queueVerify({ status: 'rejected' });
    await runtime.requestPurchase({ logicalId: 'gems_small', idempotencyKey: 'op-1', source: 'shop' });
    store.complete({ transactionId: 'tx-1', storeSku: 'gems.small', token: 'token-1', state: 'purchased' });
    await runtime.runUntilIdle();
    expect(journal.history('op-1')).toEqual([
      'requested', 'launched', 'purchased', 'verifying', 'rejected',
    ]);
    expect(store.finishCalls).toEqual([]);
    expect(backend.ledger).toEqual([]);
  });

  it('redeems a wallet entitlement through the backend finalization path', async () => {
    const vector = vectorNamed('credit-lot-title-scope');
    const clock = createCommerceConformanceClock();
    const journal = createCommerceConformanceJournal();
    const catalog = [{ logicalId: 'booster', kind: 'consumable' as const, storeSku: 'booster.1' }];
    const wallet = createCommerceConformanceWallet({
      store: vector.profile.store, clock, currencies: ['credits'],
    });
    const provider = createCommerceConformanceWalletProvider({
      wallet,
      profile: vector.profile,
      catalog,
      currencies: ['credits'],
      billingAuthority: 'host',
      titleId: 'title-a',
      clock,
    });
    const backend = createCommerceConformanceBackend({
      finalize: (request) => wallet.finalize?.(request),
    });
    const runtime = createCommerceConformanceRuntime({
      provider, backend, journal, clock, catalog, playerId: 'player-1',
    });
    wallet.creditFromGrant({
      ledgerEntryId: 'le-1',
      currency: 'credits',
      amount: 10,
      origin: { channel: 'store', store: 'fixture.client-token', titleId: 'title-a' },
      createdAt: '2026-10-01T00:00:00Z',
    });
    await runtime.start();
    backend.queueVerify({
      status: 'granted', ledgerEntryId: 'le-spend', finalization: 'completed', alreadyProcessed: true,
    });
    const result = await runtime.requestPurchase({
      logicalId: 'booster', idempotencyKey: 'op-1', source: 'shop',
    });
    expect(result).toMatchObject({
      outcome: 'purchased',
      purchase: { state: 'purchased', transactionId: 'op-1' },
    });
    expect(journal.history('op-1')).toEqual([
      'requested', 'launched', 'purchased', 'verifying', 'granted', 'finishing', 'finished',
    ]);
    expect(backend.verifyRequests).toHaveLength(1);
    expect(await provider.getAvailablePurchases()).toEqual([]);
    expect(wallet.lots[0]?.remaining).toBe(9);
    backend.queueVerify({ status: 'granted', ledgerEntryId: 'le-spend-2', finalization: 'completed' });
    const second = await runtime.requestPurchase({
      logicalId: 'booster', idempotencyKey: 'op-2', source: 'shop', quantity: 1,
    });
    expect(second.outcome).toBe('purchased');
    expect(journal.history('op-2')).toEqual([
      'requested', 'launched', 'purchased', 'verifying', 'granted', 'finishing', 'finished',
    ]);
    expect(await wallet.getBalance({ titleId: 'title-a' })).toEqual({
      titleId: 'title-a', balances: { credits: 8 },
    });
  });
});

describe('commerce conformance fakes', () => {
  it('defaults omitted profile blocks to all supported and available', () => {
    expect(createCommerceConformanceCapabilities({ store: 'fixture' })).toEqual({
      purchase: { consumable: true, durable: true, subscription: true, quantity: true },
      catalog: { products: true, offers: true, localizedPrice: true },
      lifecycle: { availablePurchases: true, pending: true, restore: true, events: true, finish: 'client' },
      authority: { evidence: 'client-token', accountBinding: 'optional' },
      availability: 'available',
    });
    const first = createCommerceConformanceCapabilities(clientTokenProfile);
    expect(first).not.toBe(createCommerceConformanceCapabilities(clientTokenProfile));
    expect(first.purchase).not.toBe(clientTokenProfile.purchase);
  });

  it('fills fixture shorthand with the store, quantity, evidence, and account binding', () => {
    const purchase = fillCommerceConformancePurchase(
      { transactionId: 'tx-1', storeSku: 'gems.small', token: 'token-1', state: 'purchased' },
      { profile: { ...clientTokenProfile, authority: { evidence: 'client-token', accountBinding: 'required' } }, catalog: gemsCatalog, playerId: 'player-1' },
    );
    expect(purchase).toEqual({
      store: 'fixture.client-token',
      transactionId: 'tx-1',
      storeSku: 'gems.small',
      logicalId: 'gems_small',
      quantity: 1,
      state: 'purchased',
      token: 'token-1',
      evidence: { schema: 'fixture.fixture.client-token.v1', payload: { token: 'token-1' } },
      accountBinding: { kind: 'obfuscated-account-id', value: 'player-1' },
    });
    expect(fillCommerceConformancePurchase(
      { transactionId: 'tx-2', storeSku: 'unknown', token: 't', state: 'pending' },
      { profile: { store: 'fixture', authority: { evidence: 'host-callback', accountBinding: 'host' } }, catalog: [], playerId: 'player-1' },
    )).toMatchObject({ accountBinding: { kind: 'host-identity' } });
    expect(fillCommerceConformancePurchase(
      { transactionId: 'tx-2', storeSku: 'unknown', token: 't', state: 'pending' },
      { profile: { store: 'fixture' }, catalog: [], playerId: 'player-1' },
    )).not.toHaveProperty('accountBinding');
  });

  it('buffers store events until the first listener and lists unfinished purchases', async () => {
    const store = createCommerceConformanceStore({ profile: clientTokenProfile, catalog: gemsCatalog, playerId: 'player-1' });
    store.complete({ transactionId: 'tx-1', storeSku: 'gems.small', token: 'token-1', state: 'pending' });
    store.error({ logicalId: 'gems_small', error: { code: 'USER_CANCELLED', retryable: false, storeCode: '1' } });
    expect(await store.provider.getAvailablePurchases()).toEqual([]);
    expect(await store.provider.getAvailablePurchases({ includePending: true })).toHaveLength(1);
    const received: string[] = [];
    const unsubscribe = store.provider.subscribe((event) => {
      received.push(event.type);
    });
    expect(received).toEqual(['purchaseUpdated', 'purchaseError']);
    store.update({ transactionId: 'tx-1', storeSku: 'gems.small', token: 'token-1', state: 'purchased' });
    expect(received).toEqual(['purchaseUpdated', 'purchaseError', 'purchaseUpdated']);
    expect(await store.provider.getAvailablePurchases()).toHaveLength(1);
    unsubscribe();
    store.queueFinish({ error: 'NETWORK' });
    await expect(store.provider.finishTransaction?.({ transactionId: 'tx-1', ledgerEntryId: 'le-1', isConsumable: true }))
      .rejects.toMatchObject({ code: 'NETWORK' });
    expect(await store.provider.finishTransaction?.({ transactionId: 'tx-1', ledgerEntryId: 'le-1', isConsumable: true }))
      .toEqual({ finished: true });
    expect(store.finishCalls.map((call) => call.result)).toEqual(['NETWORK', 'finished']);
    expect(await store.provider.getAvailablePurchases()).toEqual([]);
    await store.provider.restorePurchases?.();
    expect(store.restoreCalls).toBe(1);
    expect(await store.provider.fetchProducts({ type: 'subscription' })).toEqual([]);
    expect((await store.provider.fetchProducts({ logicalIds: ['gems_small'] })).map((p) => p.logicalId))
      .toEqual(['gems_small']);
  });

  it('ledger grants once per entry, revokes by reference, and reports status', async () => {
    const backend = createCommerceConformanceBackend();
    const request = {
      idempotencyKey: 'op-1', playerId: 'player-1', store: 'fixture', transactionId: 'tx-1',
      token: 'token-1', logicalId: 'gems_small', quantity: 1,
      evidence: { schema: 'fixture.v1', payload: { token: 'token-1' } },
    };
    await expect(backend.verifyPurchase(request)).rejects.toThrow('Unscripted verify for op-1');
    backend.queueVerify({ status: 'granted', ledgerEntryId: 'le-1' });
    backend.queueVerify({ status: 'granted', ledgerEntryId: 'le-1', alreadyProcessed: true });
    backend.queueVerify({ status: 'granted' });
    expect(await backend.verifyPurchase(request)).toEqual({ status: 'granted', ledgerEntryId: 'le-1' });
    expect(await backend.verifyPurchase(request)).toEqual({
      status: 'granted', ledgerEntryId: 'le-1', alreadyProcessed: true,
    });
    await expect(backend.verifyPurchase(request)).rejects.toThrow('must name a ledgerEntryId');
    expect(backend.ledger).toEqual([
      { entryId: 'le-1', type: 'grant', logicalId: 'gems_small', store: 'fixture', transactionId: 'tx-1', idempotencyKey: 'op-1' },
    ]);
    expect(backend.verifyRequests).toHaveLength(4);
    expect(() => backend.revoke({ ledgerEntryId: 'le-9', entryId: 'le-2', reason: 'refunded' }))
      .toThrow('holds no such grant');
    backend.revoke({ ledgerEntryId: 'le-1', entryId: 'le-2', reason: 'refunded' });
    backend.revoke({ ledgerEntryId: 'le-1', entryId: 'le-2', reason: 'refunded' });
    expect(backend.ledger).toHaveLength(2);
    expect(await backend.getLedgerStatus(['le-1', 'le-2', 'le-9'])).toEqual([
      { ledgerEntryId: 'le-1', status: 'reversed', reversedBy: 'le-2' },
      { ledgerEntryId: 'le-2', status: 'unknown' },
      { ledgerEntryId: 'le-9', status: 'unknown' },
    ]);
    expect(backend.entitlements()).toEqual([]);
    backend.push({ transactionId: 'order-1', entryId: 'le-3', logicalId: 'gems_small' });
    backend.push({ transactionId: 'order-1', entryId: 'le-3', logicalId: 'gems_small' });
    expect(backend.entitlements()).toEqual([{ id: 'le-3', logicalId: 'gems_small' }]);
  });

  it('clock normalizes timestamps and adds ISO-8601 durations in UTC', () => {
    const clock = createCommerceConformanceClock('2026-10-01T00:00:00.000Z');
    expect(clock.now()).toBe('2026-10-01T00:00:00Z');
    clock.set('2026-10-31T12:30:00+00:00');
    expect(clock.now()).toBe('2026-10-31T12:30:00Z');
    expect(() => clock.set('yesterday')).toThrow(TypeError);
    expect(addIsoDuration('2026-10-01T00:00:00Z', 'P30D')).toBe('2026-10-31T00:00:00Z');
    expect(addIsoDuration('2026-01-31T00:00:00Z', 'P1M')).toBe('2026-02-28T00:00:00Z');
    expect(addIsoDuration('2026-01-31T00:00:00Z', 'P1M', 2)).toBe('2026-03-31T00:00:00Z');
    expect(addIsoDuration('2026-10-01T00:00:00Z', 'P1W')).toBe('2026-10-08T00:00:00Z');
    expect(addIsoDuration('2026-10-01T00:00:00Z', 'PT1H30M')).toBe('2026-10-01T01:30:00Z');
    expect(addIsoDuration('2026-10-01T00:00:00Z', 'P1Y')).toBe('2027-10-01T00:00:00Z');
    expect(() => addIsoDuration('2026-10-01T00:00:00Z', '30D')).toThrow(TypeError);
    expect(() => addIsoDuration('2026-10-01T00:00:00Z', 'P')).toThrow(TypeError);
    expect(() => addIsoDuration('2026-10-01T00:00:00Z', 'P0D')).toThrow(TypeError);
    expect(() => addIsoDuration('2026-10-01T00:00:00Z', 'P1DT')).toThrow(TypeError);
  });
});

function lot(input: Partial<CreditLot> & { readonly lotId: string }): CreditLot {
  return {
    currency: 'credits',
    amount: 10,
    remaining: 10,
    createdAt: '2026-10-01T00:00:00Z',
    origin: { channel: 'store', store: 'fixture', titleId: 'title-a' },
    spendScope: { kind: 'title', titleId: 'title-a' },
    ...input,
  };
}

describe('commerce conformance wallet', () => {
  it('orders lots by expiry, then title before cross-title, then createdAt, then lotId', () => {
    const lots = [
      lot({ lotId: 'd-cross-late', spendScope: { kind: 'cross-title' }, createdAt: '2026-10-03T00:00:00Z' }),
      lot({ lotId: 'c-title-late', createdAt: '2026-10-03T00:00:00Z' }),
      lot({ lotId: 'b-title-early', createdAt: '2026-10-02T00:00:00Z' }),
      lot({ lotId: 'a-no-expiry-tie', createdAt: '2026-10-02T00:00:00Z' }),
      lot({ lotId: 'z-expires-first', expiresAt: '2026-12-01T00:00:00Z', spendScope: { kind: 'cross-title' } }),
      lot({ lotId: 'y-expires-second', expiresAt: '2026-12-02T00:00:00Z' }),
    ];
    expect([...lots].sort(compareCreditLotSpendOrder).map((entry) => entry.lotId)).toEqual([
      'z-expires-first',
      'y-expires-second',
      'a-no-expiry-tie',
      'b-title-early',
      'c-title-late',
      'd-cross-late',
    ]);
  });

  it('consumes eligible lots in order, debits nothing when short, and replays by key', async () => {
    const clock = createCommerceConformanceClock();
    const wallet = createCommerceConformanceWallet({ store: 'fixture.credit-wallet', clock, currencies: ['credits'] });
    wallet.creditFromGrant({
      ledgerEntryId: 'le-expiring', currency: 'credits', amount: 5,
      origin: { channel: 'store', store: 'fixture.client-token', titleId: 'title-a' },
      createdAt: '2026-09-05T00:00:00Z', expiresAt: '2026-11-01T00:00:00Z',
    });
    wallet.creditFromGrant({
      ledgerEntryId: 'le-title', currency: 'credits', amount: 10,
      origin: { channel: 'store', store: 'fixture.client-token', titleId: 'title-a' },
      createdAt: '2026-10-01T00:00:00Z',
    });
    wallet.creditFromGrant({
      ledgerEntryId: 'le-cross', currency: 'credits', amount: 10,
      origin: { channel: 'off-store', store: 'fixture.web-checkout', titleId: 'title-b' },
      createdAt: '2026-09-01T00:00:00Z',
    });
    wallet.creditFromGrant({
      ledgerEntryId: 'le-promo', currency: 'credits', amount: 3,
      origin: { channel: 'promotion', store: 'fixture.promo', titleId: 'title-c' },
      createdAt: '2026-09-01T00:00:00Z',
    }, { spendScope: { kind: 'cross-title' } });
    expect(wallet.lots.map((entry) => entry.spendScope)).toEqual([
      { kind: 'title', titleId: 'title-a' },
      { kind: 'title', titleId: 'title-a' },
      { kind: 'cross-title' },
      { kind: 'cross-title' },
    ]);
    expect(await wallet.getBalance({ titleId: 'title-a' })).toEqual({ titleId: 'title-a', balances: { credits: 28 } });
    expect(await wallet.getBalance({ titleId: 'title-b' })).toEqual({ titleId: 'title-b', balances: { credits: 13 } });
    expect(await wallet.spend({ titleId: 'title-b', currency: 'credits', amount: 14, idempotencyKey: 's-0' }))
      .toMatchObject({ status: 'rejected', error: { code: 'INSUFFICIENT_BALANCE', retryable: false } });
    expect(await wallet.spend({ titleId: 'title-a', currency: 'gold', amount: 1, idempotencyKey: 's-x' }))
      .toMatchObject({ status: 'rejected', error: { code: 'ITEM_UNAVAILABLE' } });
    expect(wallet.debits).toEqual([]);
    const spend = await wallet.spend({ titleId: 'title-a', currency: 'credits', amount: 18, idempotencyKey: 's-1' });
    expect(spend).toEqual({
      status: 'debited',
      entitlementId: 's-1',
      createdAt: '2026-10-01T00:00:00Z',
      debits: [{ lotId: 'le-expiring', amount: 5 }, { lotId: 'le-title', amount: 10 }, { lotId: 'le-cross', amount: 3 }],
    });
    expect(await wallet.spend({ titleId: 'title-a', currency: 'credits', amount: 18, idempotencyKey: 's-1' }))
      .toEqual({ ...spend, alreadyProcessed: true });
    expect(wallet.debits).toHaveLength(3);
    clock.set('2026-11-02T00:00:00Z');
    wallet.creditFromGrant({
      ledgerEntryId: 'le-expiring', currency: 'credits', amount: 5,
      origin: { channel: 'store', store: 'fixture.client-token', titleId: 'title-a' },
      createdAt: '2026-09-05T00:00:00Z', expiresAt: '2026-11-01T00:00:00Z',
    });
    expect(wallet.lots).toHaveLength(4);
    expect(await wallet.getBalance({ titleId: 'title-a' })).toEqual({ titleId: 'title-a', balances: { credits: 10 } });
    expect(await wallet.listUnredeemed({ titleId: 'title-a' })).toEqual([]);
  });

  it('renews a membership idempotently per period and lapses at period end', async () => {
    const clock = createCommerceConformanceClock('2026-10-01T00:00:00Z');
    const wallet = createCommerceConformanceWallet({ store: 'fixture.credit-wallet', clock, currencies: ['credits'] });
    const events: string[] = [];
    wallet.subscribe((event) => {
      if (event.type === 'subscriptionUpdated') {
        events.push(`${event.subscription.state}:${event.subscription.periodIndex}`);
      }
    });
    wallet.creditFromGrant({
      ledgerEntryId: 'le-title', currency: 'credits', amount: 25,
      origin: { channel: 'store', store: 'fixture.client-token', titleId: 'title-a' },
      createdAt: '2026-10-01T00:00:00Z',
    });
    const terms = { scope: 'title' as const, price: { currency: 'credits', amount: 10 }, period: 'P30D' };
    const started = await wallet.startMembership({
      subscriptionId: 'op-1', titleId: 'title-a', logicalId: 'membership_plus', terms,
    });
    expect(started).toMatchObject({
      status: 'started',
      entitlementId: 'membership:op-1:0',
      subscription: { periodIndex: 0, state: 'active', expiresAt: '2026-10-31T00:00:00Z', autoRenew: true },
    });
    expect(await wallet.startMembership({
      subscriptionId: 'op-1', titleId: 'title-a', logicalId: 'membership_plus', terms,
    })).toMatchObject({ status: 'started', subscription: { periodIndex: 0 } });
    await wallet.renewDue();
    expect(wallet.debits).toHaveLength(1);
    clock.set('2026-10-31T00:00:00Z');
    await wallet.renewDue();
    await wallet.renewDue();
    expect(wallet.debits).toEqual([
      { idempotencyKey: 'membership:op-1:0', lotId: 'le-title', amount: 10 },
      { idempotencyKey: 'membership:op-1:1', lotId: 'le-title', amount: 10 },
    ]);
    expect(await wallet.getActiveSubscriptions()).toMatchObject([
      { subscriptionId: 'op-1', periodIndex: 1, expiresAt: '2026-11-30T00:00:00Z' },
    ]);
    clock.set('2026-12-15T00:00:00Z');
    await wallet.renewDue();
    expect(wallet.debits).toHaveLength(2);
    expect(await wallet.getActiveSubscriptions()).toEqual([]);
    expect(wallet.subscriptionEvents.map((event) => event.eventId)).toEqual([
      'op-1:0:subscriptionStarted',
      'op-1:1:subscriptionRenewed',
      'op-1:2:subscriptionLapsed',
    ]);
    expect(wallet.subscriptionEvents[2]).toMatchObject({
      reason: 'INSUFFICIENT_BALANCE', expiresAt: '2026-11-30T00:00:00Z', periodIndex: 2,
    });
    expect(events).toEqual(['active:0', 'active:1', 'lapsed:1']);
    expect(await wallet.spend({ titleId: 'title-a', currency: 'credits', amount: 5, idempotencyKey: 's-1' }))
      .toMatchObject({ status: 'debited' });
    expect(await wallet.getBalance({ titleId: 'title-a' })).toEqual({ titleId: 'title-a', balances: { credits: 0 } });
    expect(await wallet.redeem({ entitlementId: 'membership:op-1:0', ledgerEntryId: 'le-x' })).toEqual({ redeemed: true });
    expect(await wallet.redeem({ entitlementId: 'missing', ledgerEntryId: 'le-x' })).toEqual({ redeemed: false });
    expect(await wallet.listUnredeemed({ titleId: 'title-a' })).toEqual([]);
  });

  it('offers memberships only where the billing authority is host', async () => {
    const vector = vectorNamed('membership-store-billing-target');
    const catalog = vector.catalog ?? [];
    const build = (billingAuthority: 'store' | 'host') => {
      const clock = createCommerceConformanceClock();
      const wallet = createCommerceConformanceWallet({ store: vector.profile.store, clock, currencies: ['credits'] });
      return { wallet, provider: createCommerceConformanceWalletProvider({
        wallet, profile: { store: vector.profile.store }, catalog, currencies: ['credits'],
        billingAuthority, titleId: 'title-a', clock,
      }) };
    };
    const storeBilling = build('store');
    expect((await storeBilling.provider.getCapabilities()).purchase.subscription).toBe(false);
    expect((await storeBilling.provider.fetchProducts({ type: 'all' })).map((p) => p.logicalId)).toEqual(['credits_100']);
    expect(await storeBilling.provider.requestPurchase({ logicalId: 'membership_plus', idempotencyKey: 'op-1', source: 'shop' }))
      .toMatchObject({ outcome: 'failed', error: { code: 'ITEM_UNAVAILABLE' } });
    expect(await storeBilling.provider.requestPurchase({ logicalId: 'missing', idempotencyKey: 'op-2', source: 'shop' }))
      .toMatchObject({ outcome: 'failed', error: { code: 'ITEM_UNAVAILABLE' } });
    const hostBilling = build('host');
    expect((await hostBilling.provider.getCapabilities()).purchase.subscription).toBe(true);
    expect((await hostBilling.provider.fetchProducts({ type: 'subscription' })).map((p) => p.logicalId)).toEqual(['membership_plus']);
    expect(await hostBilling.provider.requestPurchase({ logicalId: 'membership_plus', idempotencyKey: 'op-1', source: 'shop' }))
      .toMatchObject({ outcome: 'failed', error: { code: 'INSUFFICIENT_BALANCE' } });
    hostBilling.wallet.creditFromGrant({
      ledgerEntryId: 'le-web', currency: 'credits', amount: 30,
      origin: { channel: 'off-store', store: 'fixture.web-checkout', titleId: 'title-b' },
      createdAt: '2026-10-01T00:00:00Z',
    });
    const purchased = await hostBilling.provider.requestPurchase({ logicalId: 'membership_plus', idempotencyKey: 'op-1', source: 'shop' });
    expect(purchased).toMatchObject({
      outcome: 'purchased',
      purchase: { transactionId: 'membership:op-1:0', logicalId: 'membership_plus' },
    });
    expect(await hostBilling.provider.getActiveSubscriptions?.()).toMatchObject([{ logicalId: 'membership_plus' }]);
    expect(await hostBilling.provider.getAvailablePurchases()).toMatchObject([{ transactionId: 'membership:op-1:0' }]);
  });

  it('builds the default harness from the vector profile', () => {
    const base = {
      clock: createCommerceConformanceClock(),
      backend: createCommerceConformanceBackend(),
      journal: createCommerceConformanceJournal(),
      playerId: 'player-1',
      titleId: 'title-a',
    };
    const storeVector = vectorNamed('purchase-client-finish');
    const storeHarness = createCommerceConformanceHarness({
      ...base, vector: storeVector, profile: storeVector.profile, catalog: storeVector.catalog ?? [],
    });
    expect(storeHarness.store).toBeDefined();
    expect(storeHarness.wallet).toBeUndefined();
    const walletVector = vectorNamed('credit-membership-renewal');
    const walletHarness = createCommerceConformanceHarness({
      ...base, vector: walletVector, profile: walletVector.profile, catalog: walletVector.catalog ?? [],
    });
    expect(walletHarness.wallet).toBeDefined();
    expect(walletHarness.store).toBeUndefined();
    expect(walletHarness.provider.store).toBe('fixture.credit-wallet');
  });
});

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

describe('commerce conformance review fixes', () => {
  it('opens the store UI once when two requests with the same key overlap', async () => {
    const { runtime, journal, store } = createStoreFixture();
    await runtime.start();
    const [first, second] = await Promise.all([
      runtime.requestPurchase({ logicalId: 'gems_small', idempotencyKey: 'op-1', source: 'shop' }),
      runtime.requestPurchase({ logicalId: 'gems_small', idempotencyKey: 'op-1', source: 'shop' }),
    ]);
    expect(first).toEqual({ outcome: 'launched' });
    expect(second).toMatchObject({ outcome: 'failed', error: { code: 'IN_PROGRESS' } });
    expect(store.purchaseUiOpened).toBe(1);
    expect(journal.snapshot()).toEqual({ 'op-1': ['requested', 'launched'] });
  });

  it('answers a replayed key with the journaled terminal outcome', async () => {
    const { runtime, journal, store } = createStoreFixture();
    await runtime.start();
    store.queueRequest({
      outcome: 'cancelled',
      error: { code: 'USER_CANCELLED', retryable: false, storeCode: '1' },
    });
    const cancelled = await runtime.requestPurchase({
      logicalId: 'gems_small', idempotencyKey: 'op-1', source: 'shop',
    });
    const replay = await runtime.requestPurchase({
      logicalId: 'gems_small', idempotencyKey: 'op-1', source: 'shop',
    });
    expect(replay).toEqual(cancelled);
    expect(replay).toMatchObject({ outcome: 'cancelled', error: { storeCode: '1' } });
    expect(store.purchaseUiOpened).toBe(1);
    expect(journal.snapshot()).toEqual({ 'op-1': ['requested', 'cancelled'] });
  });

  it('serializes overlapping requests for the same product under different keys', async () => {
    const { runtime, journal, store } = createStoreFixture();
    await runtime.start();
    const [first, second] = await Promise.all([
      runtime.requestPurchase({ logicalId: 'gems_small', idempotencyKey: 'op-1', source: 'shop' }),
      runtime.requestPurchase({ logicalId: 'gems_small', idempotencyKey: 'op-2', source: 'shop' }),
    ]);
    expect(first).toEqual({ outcome: 'launched' });
    expect(second).toMatchObject({ outcome: 'failed', error: { code: 'IN_PROGRESS' } });
    expect(store.purchaseUiOpened).toBe(1);
    expect(journal.snapshot()).toEqual({
      'op-1': ['requested', 'launched'],
      'op-2': ['requested', 'failed'],
    });
  });

  it('starts a pass from a provider event without an explicit reconcile', async () => {
    const { runtime, journal, store, backend } = createStoreFixture();
    await runtime.start();
    backend.queueVerify({ status: 'granted', ledgerEntryId: 'le-1' });
    await runtime.requestPurchase({ logicalId: 'gems_small', idempotencyKey: 'op-1', source: 'shop' });
    store.complete({ transactionId: 'tx-1', storeSku: 'gems.small', token: 'token-1', state: 'purchased' });
    await flushMicrotasks();
    expect(journal.history('op-1')).toEqual([
      'requested', 'launched', 'purchased', 'verifying', 'granted', 'finishing', 'finished',
    ]);
    expect(store.finishCalls).toHaveLength(1);
  });

  it('surfaces a failure from an event-started pass on the next runUntilIdle', async () => {
    const { runtime, store } = createStoreFixture();
    await runtime.start();
    await runtime.requestPurchase({ logicalId: 'gems_small', idempotencyKey: 'op-1', source: 'shop' });
    store.complete({ transactionId: 'tx-1', storeSku: 'gems.small', token: 'token-1', state: 'purchased' });
    await flushMicrotasks();
    await expect(runtime.runUntilIdle()).rejects.toThrow('Unscripted verify for op-1');
    await expect(runtime.runUntilIdle()).resolves.toBeUndefined();
  });

  it('rejects a synchronous purchase for another product as unscripted', async () => {
    const result = await runCommerceConformanceVector(vectorNamed('purchase-client-finish'), {
      createProvider(context): CommerceConformanceHarness {
        const store = createCommerceConformanceStore(context);
        const provider: CommerceProvider = {
          ...store.provider,
          async requestPurchase() {
            return {
              outcome: 'purchased',
              purchase: fillCommerceConformancePurchase(
                { transactionId: 'tx-9', storeSku: 'other.sku', token: 't', state: 'purchased' },
                context,
              ),
            };
          },
        };
        return { provider, store };
      },
    });
    expect(result.passed).toBe(false);
    expect(result.failures[0]?.path).toBe('steps[2]');
    expect(String(result.failures[0]?.actual)).toContain('for fixture.client-token/other.sku');
  });

  it('rejects a synchronous purchase from another store as unscripted', async () => {
    const { store, journal } = createStoreFixture();
    const provider: CommerceProvider = {
      ...store.provider,
      async requestPurchase() {
        return {
          outcome: 'purchased',
          purchase: {
            ...fillCommerceConformancePurchase(
              { transactionId: 'tx-9', storeSku: 'gems.small', token: 't', state: 'purchased' },
              { profile: clientTokenProfile, catalog: gemsCatalog, playerId: 'player-1' },
            ),
            store: 'another-store',
          },
        };
      },
    };
    const foreign = createCommerceConformanceRuntime({
      provider, backend: createCommerceConformanceBackend(), journal, clock: createCommerceConformanceClock(),
      catalog: gemsCatalog, playerId: 'player-1',
    });
    await expect(foreign.requestPurchase({ logicalId: 'gems_small', idempotencyKey: 'op-1', source: 'shop' }))
      .rejects.toThrow('for another-store/gems.small');
    expect(journal.history('op-1')).toEqual(['requested']);
  });

  it('quiesces an in-flight pass on stop and resumes from the journal on start', async () => {
    const { journal, store, clock } = createStoreFixture();
    const backend = createCommerceConformanceBackend({ finalize: (request) => store.finalize?.(request) });
    let releaseVerify: (() => void) | undefined;
    const gated: typeof backend = {
      ...backend,
      get verifyRequests() {
        return backend.verifyRequests;
      },
      get ledger() {
        return backend.ledger;
      },
      async verifyPurchase(request) {
        if (releaseVerify === undefined) {
          await new Promise<void>((resolve) => {
            releaseVerify = resolve;
          });
        }
        return backend.verifyPurchase(request);
      },
    };
    const runtime = createCommerceConformanceRuntime({
      provider: store.provider, backend: gated, journal, clock, catalog: gemsCatalog, playerId: 'player-1',
    });
    await runtime.start();
    backend.queueVerify({ status: 'pending' });
    await runtime.requestPurchase({ logicalId: 'gems_small', idempotencyKey: 'op-1', source: 'shop' });
    store.complete({ transactionId: 'tx-1', storeSku: 'gems.small', token: 'token-1', state: 'purchased' });
    await flushMicrotasks();
    expect(journal.history('op-1')).toEqual(['requested', 'launched', 'purchased', 'verifying']);
    const stopping = runtime.stop();
    expect(runtime.started).toBe(false);
    releaseVerify?.();
    await stopping;
    expect(journal.history('op-1')).toEqual(['requested', 'launched', 'purchased', 'verifying', 'pending']);
    backend.queueVerify({ status: 'granted', ledgerEntryId: 'le-1' });
    await runtime.start();
    expect(journal.history('op-1')).toEqual([
      'requested', 'launched', 'purchased', 'verifying', 'pending', 'verifying', 'granted',
      'finishing', 'finished',
    ]);
    expect(backend.verifyRequests).toHaveLength(2);
    expect(store.finishCalls).toHaveLength(1);
  });

  it('keeps revoked purchases out of the available list', async () => {
    const store = createCommerceConformanceStore({ profile: clientTokenProfile, catalog: gemsCatalog, playerId: 'player-1' });
    const received: string[] = [];
    store.provider.subscribe((event) => {
      received.push(event.type === 'purchaseUpdated' ? event.purchase.state : event.type);
    });
    store.complete({ transactionId: 'tx-1', storeSku: 'gems.small', token: 'token-1', state: 'revoked' });
    expect(received).toEqual(['revoked']);
    expect(await store.provider.getAvailablePurchases({ includePending: true })).toEqual([]);
    expect(await store.provider.getAvailablePurchases()).toEqual([]);
  });

  it('replays a pushed grant for a retried fulfillment of the same transaction', () => {
    const backend = createCommerceConformanceBackend();
    backend.push({ transactionId: 'order-1', entryId: 'le-1', logicalId: 'gems_small' });
    backend.push({ transactionId: 'order-1', entryId: 'le-2', logicalId: 'gems_small' });
    expect(backend.ledger).toEqual([
      { entryId: 'le-1', type: 'grant', logicalId: 'gems_small', store: 'server-push', transactionId: 'order-1', pushed: true },
    ]);
    expect(backend.entitlements()).toEqual([{ id: 'le-1', logicalId: 'gems_small' }]);
    backend.push({ transactionId: 'order-2', entryId: 'le-2', logicalId: 'gems_small' });
    expect(backend.ledger).toHaveLength(2);
  });

  it('carries the requested quantity into the wallet purchase and debit', async () => {
    const clock = createCommerceConformanceClock();
    const catalog = [{ logicalId: 'booster', kind: 'consumable' as const, storeSku: 'booster.1' }];
    const build = (quantity: boolean) => {
      const wallet = createCommerceConformanceWallet({ store: 'fixture.credit-wallet', clock, currencies: ['credits'] });
      wallet.creditFromGrant({
        ledgerEntryId: 'le-1', currency: 'credits', amount: 10,
        origin: { channel: 'off-store', store: 'fixture.web-checkout', titleId: 'title-a' },
        createdAt: '2026-10-01T00:00:00Z',
      });
      const provider = createCommerceConformanceWalletProvider({
        wallet,
        profile: {
          store: 'fixture.credit-wallet',
          purchase: { consumable: true, durable: true, subscription: false, quantity },
        },
        catalog, currencies: ['credits'], billingAuthority: 'host', titleId: 'title-a', clock,
      });
      return { wallet, provider };
    };
    const capable = build(true);
    const purchased = await capable.provider.requestPurchase({
      logicalId: 'booster', idempotencyKey: 'op-1', source: 'shop', quantity: 3,
    });
    expect(purchased).toMatchObject({ outcome: 'purchased', purchase: { quantity: 3 } });
    expect(capable.wallet.debits).toEqual([{ idempotencyKey: 'op-1', lotId: 'le-1', amount: 3 }]);
    expect(await capable.provider.getAvailablePurchases()).toMatchObject([{ quantity: 3 }]);
    const limited = build(false);
    expect(await limited.provider.requestPurchase({
      logicalId: 'booster', idempotencyKey: 'op-1', source: 'shop', quantity: 2,
    })).toMatchObject({ outcome: 'failed', error: { code: 'ITEM_UNAVAILABLE' } });
    expect(limited.wallet.debits).toEqual([]);
  });

  it('lists and prices products from the wallet offers when the wallet declares them', async () => {
    const clock = createCommerceConformanceClock();
    const catalog = [
      { logicalId: 'booster', kind: 'consumable' as const, storeSku: 'booster.1' },
      { logicalId: 'hidden', kind: 'consumable' as const, storeSku: 'hidden.1' },
    ];
    const wallet = createCommerceConformanceWallet({
      store: 'fixture.credit-wallet',
      clock,
      currencies: ['credits'],
      offers: [{
        logicalId: 'booster', storeSku: 'booster.1', kind: 'consumable',
        title: 'Booster', description: 'Five credits', price: { currency: 'credits', amount: 5 },
      }],
    });
    wallet.creditFromGrant({
      ledgerEntryId: 'le-1', currency: 'credits', amount: 12,
      origin: { channel: 'off-store', store: 'fixture.web-checkout', titleId: 'title-a' },
      createdAt: '2026-10-01T00:00:00Z',
    });
    const provider = createCommerceConformanceWalletProvider({
      wallet, profile: { store: 'fixture.credit-wallet' }, catalog, currencies: ['credits'],
      billingAuthority: 'host', titleId: 'title-a', clock,
    });
    expect(await provider.fetchProducts({ type: 'all' })).toEqual([{
      logicalId: 'booster', store: 'fixture.credit-wallet', storeSku: 'booster.1', kind: 'consumable',
      title: 'Booster', description: 'Five credits',
      price: { formatted: '5 credits', currencyCode: 'credits' },
    }]);
    expect(await provider.requestPurchase({ logicalId: 'booster', idempotencyKey: 'op-1', source: 'shop' }))
      .toMatchObject({ outcome: 'purchased' });
    expect(wallet.debits).toEqual([{ idempotencyKey: 'op-1', lotId: 'le-1', amount: 5 }]);
    expect(await provider.requestPurchase({ logicalId: 'hidden', idempotencyKey: 'op-2', source: 'shop' }))
      .toMatchObject({ outcome: 'failed', error: { code: 'ITEM_UNAVAILABLE' } });
    expect(wallet.debits).toHaveLength(1);
  });

  it('rejects a membership with a malformed period before any debit', async () => {
    const clock = createCommerceConformanceClock();
    const wallet = createCommerceConformanceWallet({ store: 'fixture.credit-wallet', clock, currencies: ['credits'] });
    wallet.creditFromGrant({
      ledgerEntryId: 'le-1', currency: 'credits', amount: 100,
      origin: { channel: 'off-store', store: 'fixture.web-checkout', titleId: 'title-a' },
      createdAt: '2026-10-01T00:00:00Z',
    });
    const rejected = await wallet.startMembership({
      subscriptionId: 'op-1', titleId: 'title-a', logicalId: 'membership_plus',
      terms: { scope: 'title', price: { currency: 'credits', amount: 30 }, period: 'thirty days' },
    });
    expect(rejected).toMatchObject({ status: 'rejected', error: { code: 'ITEM_UNAVAILABLE', retryable: false } });
    expect(wallet.debits).toEqual([]);
    expect(wallet.entitlements).toEqual([]);
    expect(wallet.subscriptionEvents).toEqual([]);
    expect(await wallet.getActiveSubscriptions()).toEqual([]);
    expect(await wallet.getBalance({ titleId: 'title-a' })).toEqual({ titleId: 'title-a', balances: { credits: 100 } });
  });

  it('buffers subscription events until the first wallet subscriber', async () => {
    const clock = createCommerceConformanceClock('2026-10-01T00:00:00Z');
    const wallet = createCommerceConformanceWallet({ store: 'fixture.credit-wallet', clock, currencies: ['credits'] });
    wallet.creditFromGrant({
      ledgerEntryId: 'le-1', currency: 'credits', amount: 10,
      origin: { channel: 'off-store', store: 'fixture.web-checkout', titleId: 'title-a' },
      createdAt: '2026-10-01T00:00:00Z',
    });
    await wallet.startMembership({
      subscriptionId: 'op-1', titleId: 'title-a', logicalId: 'membership_plus',
      terms: { scope: 'platform', price: { currency: 'credits', amount: 10 }, period: 'P30D' },
    });
    clock.set('2026-10-31T00:00:00Z');
    await wallet.renewDue();
    expect(await wallet.getActiveSubscriptions()).toEqual([]);
    const received: string[] = [];
    wallet.subscribe((event) => {
      if (event.type === 'subscriptionUpdated') {
        received.push(`${event.subscription.state}:${event.subscription.periodIndex}`);
      }
    });
    expect(received).toEqual(['active:0', 'lapsed:0']);
    const late: string[] = [];
    wallet.subscribe((event) => {
      late.push(event.type);
    });
    expect(late).toEqual([]);
  });
});

// Adaptive vectors: expectations derived from the provider's declared capabilities.

const adaptiveVectors = vectors.filter(isAdaptiveCommerceConformanceVector);

type OwnerProfile = Required<Pick<CommerceConformanceProfile, 'lifecycle' | 'authority'>>;

/** Capability sets a real store provider declares, one per finish owner. */
const ownerProfiles: Readonly<Record<CommerceFinishOwner, OwnerProfile>> = {
  client: {
    lifecycle: {
      availablePurchases: true,
      pending: true,
      restore: true,
      events: true,
      finish: 'client',
    },
    authority: { evidence: 'client-token', accountBinding: 'optional' },
  },
  host: {
    lifecycle: {
      availablePurchases: true,
      pending: true,
      restore: true,
      events: true,
      finish: 'host',
    },
    authority: { evidence: 'host-callback', accountBinding: 'host' },
  },
  server: {
    lifecycle: {
      availablePurchases: true,
      pending: true,
      restore: false,
      events: true,
      finish: 'server',
    },
    authority: { evidence: 'client-token', accountBinding: 'required' },
  },
  none: {
    lifecycle: {
      availablePurchases: false,
      pending: true,
      restore: false,
      events: true,
      finish: 'none',
    },
    authority: { evidence: 'server-push', accountBinding: 'host' },
  },
};

/** The fake store as a caller-supplied provider with its own store id and capabilities. */
function fakeProviderWith(
  overrides: Partial<CommerceConformanceProfile>,
  store = 'test.store',
): (context: CommerceConformanceContext) => CommerceConformanceHarness {
  return (context) => {
    const fake = createCommerceConformanceStore({
      ...context,
      profile: { ...context.profile, store, ...overrides },
    });
    return { provider: fake.provider, store: fake };
  };
}

function summarize(results: readonly CommerceConformanceVectorResult[]) {
  return results.map((result) => ({
    vector: result.vector,
    status: result.status,
    ...(result.reason === undefined ? {} : { reason: result.reason }),
    ...(result.failures.length === 0 ? {} : { failures: result.failures }),
  }));
}

function adaptiveResult(
  results: readonly CommerceConformanceVectorResult[],
  name: string,
): CommerceConformanceAdaptation {
  const result = results.find((candidate) => candidate.vector === name);
  if (result?.adaptive === undefined) {
    throw new Error(`${name} did not run adaptively: ${JSON.stringify(result)}`);
  }
  return result.adaptive;
}

const pendingJournal = ['requested', 'launched', 'pending', 'purchased', 'verifying', 'granted'];
const verifyOp1 = {
  idempotencyKey: 'op-1',
  store: 'test.store',
  transactionId: 'tx-1',
  token: 'token-1',
};

describe('commerce conformance adaptive vectors', () => {
  it('flags the nine owner-independent lifecycle vectors', () => {
    expect(adaptiveVectors.map((vector) => vector.vector)).toEqual([
      'cancelled-and-failed',
      'event-before-listener',
      'finish-failure-retry',
      'purchase-client-finish',
      'purchase-host-finish',
      'purchase-pending-then-purchased',
      'purchase-server-finish',
      'restart-before-verify',
      'revoked-after-grant',
    ]);
  });

  it('ignores the flag on the reference harness', async () => {
    const results = await runCommerceConformanceVectors(adaptiveVectors);
    expect(summarize(results)).toEqual(
      adaptiveVectors.map((vector) => ({ vector: vector.vector, status: 'passed' })),
    );
    expect(results.every((result) => result.passed && result.adaptive === undefined)).toBe(true);
  });

  it("runs the client-finish set against a provider declaring finish: 'client'", async () => {
    const results = await runCommerceConformanceVectors(adaptiveVectors, {
      createProvider: fakeProviderWith(ownerProfiles.client),
    });
    expect(summarize(results)).toEqual([
      { vector: 'cancelled-and-failed', status: 'passed' },
      { vector: 'event-before-listener', status: 'passed' },
      { vector: 'finish-failure-retry', status: 'passed' },
      { vector: 'purchase-client-finish', status: 'passed' },
      {
        vector: 'purchase-host-finish',
        status: 'skipped',
        reason: "duplicate of purchase-client-finish for finish='client'",
      },
      { vector: 'purchase-pending-then-purchased', status: 'passed' },
      {
        vector: 'purchase-server-finish',
        status: 'skipped',
        reason: "duplicate of purchase-client-finish for finish='client'",
      },
      { vector: 'restart-before-verify', status: 'passed' },
      { vector: 'revoked-after-grant', status: 'passed' },
    ]);
    const adaptive = adaptiveResult(results, 'purchase-pending-then-purchased');
    expect(adaptive.finish).toBe('client');
    expect(adaptive.evidence).toBe('client-token');
    expect(adaptive.store).toBe('test.store');
    expect(adaptive.expect.journal).toEqual({ 'op-1': [...pendingJournal, 'finishing', 'finished'] });
    expect(adaptive.expect.finishCalls).toEqual([
      { by: 'client', transactionId: 'tx-1', ledgerEntryId: 'le-1', isConsumable: true, result: 'finished' },
    ]);
    expect(adaptive.expect.verifyRequests).toEqual([verifyOp1]);
    expect(adaptive.expect.available).toEqual([]);
    // Owner-independent fields keep the fixture's expectation.
    expect(adaptive.expect.ledger).toEqual(vectorNamed('purchase-pending-then-purchased').expect.ledger);
    expect(adaptiveResult(results, 'finish-failure-retry').expect.finishCalls?.map((call) => call.result))
      .toEqual(['NETWORK', 'finished']);
  });

  it("runs the host-finish set against a provider declaring finish: 'host'", async () => {
    const results = await runCommerceConformanceVectors(adaptiveVectors, {
      createProvider: fakeProviderWith(ownerProfiles.host),
    });
    expect(summarize(results).filter((result) => result.status !== 'passed')).toEqual([
      {
        vector: 'purchase-client-finish',
        status: 'skipped',
        reason: "duplicate of purchase-host-finish for finish='host'",
      },
      {
        vector: 'purchase-server-finish',
        status: 'skipped',
        reason: "duplicate of purchase-host-finish for finish='host'",
      },
    ]);
    const adaptive = adaptiveResult(results, 'purchase-pending-then-purchased');
    expect(adaptive.finish).toBe('host');
    expect(adaptive.evidence).toBe('host-callback');
    expect(adaptive.expect.journal).toEqual({ 'op-1': [...pendingJournal, 'finishing', 'finished'] });
    expect(adaptive.expect.finishCalls).toEqual([
      { by: 'host', transactionId: 'tx-1', ledgerEntryId: 'le-1', isConsumable: true, result: 'finished' },
    ]);
    expect(adaptive.expect.verifyRequests).toEqual([verifyOp1]);
    expect(adaptive.expect.available).toEqual([]);
  });

  it("runs the server-finish set against a provider declaring finish: 'server'", async () => {
    const results = await runCommerceConformanceVectors(adaptiveVectors, {
      createProvider: fakeProviderWith(ownerProfiles.server),
    });
    expect(summarize(results).filter((result) => result.status !== 'passed')).toEqual([
      {
        vector: 'finish-failure-retry',
        status: 'skipped',
        reason: "queueFinish scripts a client finish; the provider declares finish: 'server'",
      },
      {
        vector: 'purchase-client-finish',
        status: 'skipped',
        reason: "duplicate of purchase-server-finish for finish='server'",
      },
      {
        vector: 'purchase-host-finish',
        status: 'skipped',
        reason: "duplicate of purchase-server-finish for finish='server'",
      },
    ]);
    const adaptive = adaptiveResult(results, 'purchase-pending-then-purchased');
    expect(adaptive.finish).toBe('server');
    expect(adaptive.expect.journal).toEqual({ 'op-1': [...pendingJournal, 'finishing', 'finished'] });
    expect(adaptive.expect.finishCalls).toEqual([]);
    // The grant reported no finalization, so the reconciler re-read it once.
    expect(adaptive.expect.verifyRequests).toEqual([verifyOp1, verifyOp1]);
    expect(adaptive.expect.available).toEqual([]);
    // A vector written for a server fixture scripts its own finalization.
    expect(adaptiveResult(results, 'purchase-server-finish').expect.verifyRequests).toHaveLength(2);
    expect(adaptiveResult(results, 'revoked-after-grant').expect.journal).toEqual({
      'op-1': [
        'requested', 'launched', 'purchased', 'verifying', 'granted', 'finishing', 'finished', 'revoked',
      ],
    });
  });

  it('re-reads finalization only when the grant did not already report it completed', async () => {
    const vector = vectorNamed('purchase-client-finish');
    const completed: CommerceConformanceVector = {
      ...vector,
      steps: vector.steps.map((step) =>
        step.actor === 'backend' && step.action === 'queueVerify'
          ? { ...step, decision: { ...step.decision, finalization: 'completed' as const } }
          : step),
    };
    const [result] = await runCommerceConformanceVectors([completed], {
      createProvider: fakeProviderWith(ownerProfiles.server),
    });
    expect(result?.failures).toEqual([]);
    expect(result?.status).toBe('passed');
    expect(result?.adaptive?.expect.verifyRequests).toEqual([verifyOp1]);
  });

  it("runs the no-finish set against a provider declaring finish: 'none'", async () => {
    const results = await runCommerceConformanceVectors(adaptiveVectors, {
      createProvider: fakeProviderWith(ownerProfiles.none),
    });
    expect(summarize(results).filter((result) => result.status !== 'passed')).toEqual([
      {
        vector: 'finish-failure-retry',
        status: 'skipped',
        reason: "queueFinish scripts a client finish; the provider declares finish: 'none'",
      },
      {
        vector: 'purchase-host-finish',
        status: 'skipped',
        reason: "duplicate of purchase-client-finish for finish='none'",
      },
      {
        vector: 'purchase-server-finish',
        status: 'skipped',
        reason: "duplicate of purchase-client-finish for finish='none'",
      },
    ]);
    const adaptive = adaptiveResult(results, 'purchase-pending-then-purchased');
    expect(adaptive.finish).toBe('none');
    expect(adaptive.evidence).toBe('server-push');
    expect(adaptive.expect.journal).toEqual({ 'op-1': [...pendingJournal, 'finished'] });
    expect(adaptive.expect.finishCalls).toEqual([]);
    expect(adaptive.expect.verifyRequests).toEqual([verifyOp1]);
    expect(adaptive.expect.available).toEqual([]);
  });

  it('skips store-side pending scenarios the provider does not declare', async () => {
    const results = await runCommerceConformanceVectors(adaptiveVectors, {
      createProvider: fakeProviderWith({
        ...ownerProfiles.client,
        lifecycle: { ...ownerProfiles.client.lifecycle, pending: false },
      }),
    });
    expect(summarize(results).filter((result) => result.status === 'skipped')).toEqual([
      {
        vector: 'purchase-host-finish',
        status: 'skipped',
        reason: "duplicate of purchase-client-finish for finish='client'",
      },
      {
        vector: 'purchase-pending-then-purchased',
        status: 'skipped',
        reason: 'store-side pending purchase needs lifecycle.pending; the provider declares pending: false',
      },
      {
        vector: 'purchase-server-finish',
        status: 'skipped',
        reason: "duplicate of purchase-client-finish for finish='client'",
      },
    ]);
    const skipped = results.filter((result) => result.status === 'skipped');
    expect(skipped.every((result) => !result.passed && result.failures.length === 0)).toBe(true);
  });

  it('dedupes the purchase-finish family only within one run', async () => {
    const [alone] = await runCommerceConformanceVectors([vectorNamed('purchase-server-finish')], {
      createProvider: fakeProviderWith(ownerProfiles.client),
    });
    expect(alone?.failures).toEqual([]);
    expect(alone?.status).toBe('passed');
    expect(alone?.adaptive?.expect.finishCalls).toHaveLength(1);
    const single = await runCommerceConformanceVector(vectorNamed('purchase-host-finish'), {
      createProvider: fakeProviderWith(ownerProfiles.server),
    });
    expect(single.status).toBe('passed');
    expect(single.adaptive?.expect.finishCalls).toEqual([]);
  });

  it('names the skip reasons without running anything', () => {
    const capabilities = createCommerceConformanceCapabilities({ store: 'x', ...ownerProfiles.server });
    expect(commerceConformanceAdaptiveSkipReason(vectorNamed('finish-failure-retry'), capabilities))
      .toBe("queueFinish scripts a client finish; the provider declares finish: 'server'");
    expect(commerceConformanceAdaptiveSkipReason(vectorNamed('purchase-client-finish'), capabilities))
      .toBeUndefined();
    expect(commerceConformanceAdaptiveSkipReason(
      vectorNamed('purchase-client-finish'),
      capabilities,
      adaptiveVectors,
    )).toBe("duplicate of purchase-server-finish for finish='server'");
    expect(commerceConformanceAdaptiveSkipReason(
      vectorNamed('purchase-server-finish'),
      capabilities,
      adaptiveVectors,
    )).toBeUndefined();
  });

  it('carries the provider store id into derived keys and verify requests', async () => {
    const [result] = await runCommerceConformanceVectors([vectorNamed('event-before-listener')], {
      createProvider: fakeProviderWith(ownerProfiles.client, 'app-store'),
    });
    expect(result?.failures).toEqual([]);
    expect(result?.adaptive?.store).toBe('app-store');
    expect(Object.keys(result?.adaptive?.expect.journal ?? {})).toEqual(['store:app-store:tx-1']);
    expect(result?.adaptive?.expect.verifyRequests?.[0]?.store).toBe('app-store');
  });

  it('replays the token a store actor reports into the derived verify requests', async () => {
    // A host-order store reports the transaction id as the token; the fixture
    // carries `token-1`. The derivation must expect what the provider reports.
    const hostOrderStore = (declareToken: boolean) =>
      (context: CommerceConformanceContext): CommerceConformanceHarness => {
        const fake = createCommerceConformanceStore({
          ...context,
          profile: { ...context.profile, store: 'apps-in-toss', ...ownerProfiles.host },
        });
        const withOrderToken = (purchase: CommerceConformancePurchaseFixture) =>
          ({ ...purchase, token: purchase.transactionId });
        const store: CommerceConformanceStoreActor = {
          get purchaseUiOpened() {
            return fake.purchaseUiOpened;
          },
          get finishCalls() {
            return fake.finishCalls;
          },
          complete: (purchase) => fake.complete(withOrderToken(purchase)),
          update: (purchase) => fake.update(withOrderToken(purchase)),
          error: (input) => fake.error(input),
          queueRequest: (result) => fake.queueRequest(
            result.outcome === 'purchased'
              ? { ...result, purchase: withOrderToken(result.purchase) }
              : result,
          ),
          queueFinish: (result) => fake.queueFinish(result),
          ...(declareToken ? { tokenOf: (purchase) => purchase.transactionId } : {}),
        };
        return { provider: fake.provider, store };
      };
    const results = await runCommerceConformanceVectors(
      [vectorNamed('event-before-listener'), vectorNamed('purchase-host-finish')],
      { createProvider: hostOrderStore(true) },
    );
    expect(summarize(results)).toEqual([
      { vector: 'event-before-listener', status: 'passed' },
      { vector: 'purchase-host-finish', status: 'passed' },
    ]);
    expect(adaptiveResult(results, 'event-before-listener').expect.verifyRequests).toEqual([
      {
        idempotencyKey: 'apps-in-toss:purchase:tx-1',
        store: 'apps-in-toss',
        transactionId: 'tx-1',
        token: 'tx-1',
      },
    ]);
    expect(adaptiveResult(results, 'purchase-host-finish').expect.verifyRequests?.[0]?.token).toBe(
      'order-1',
    );
    expect(withStoreTokens(vectorNamed('event-before-listener'), () => 'mapped').steps[0]).toMatchObject({
      actor: 'store',
      action: 'complete',
      purchase: { transactionId: 'tx-1', token: 'mapped' },
    });

    // Without the hook the fixture token stays, so such a provider fails on the token.
    const [unmapped] = await runCommerceConformanceVectors([vectorNamed('event-before-listener')], {
      createProvider: hostOrderStore(false),
    });
    expect(unmapped?.status).toBe('failed');
    expect(unmapped?.failures).toEqual([
      { path: 'verifyRequests[0].token', expected: 'token-1', actual: 'tx-1' },
    ]);
  });

  it('runs a non-adaptive vector with its fixture expectations unchanged', async () => {
    const vector = vectorNamed('server-push-settlement');
    const [result] = await runCommerceConformanceVectors([vector], {
      createProvider(context) {
        const fake = createCommerceConformanceStore(context);
        return { provider: fake.provider, store: fake };
      },
    });
    expect(result).toEqual({ vector: vector.vector, status: 'passed', passed: true, failures: [] });
    const [mismatched] = await runCommerceConformanceVectors([vector], {
      createProvider: fakeProviderWith(ownerProfiles.client, vector.profile.store),
    });
    expect(mismatched?.status).toBe('failed');
    expect(mismatched?.adaptive).toBeUndefined();
  });

  it("fails a provider that declares finish: 'server' but finishes on the client", async () => {
    const [result] = await runCommerceConformanceVectors([vectorNamed('purchase-client-finish')], {
      createProvider(context) {
        const fake = createCommerceConformanceStore({
          ...context,
          profile: { ...context.profile, store: 'test.store', ...ownerProfiles.server },
        });
        // The SDK finishes every purchase it reports, behind the reconciler's back.
        const actor: CommerceConformanceStoreActor = {
          ...fake,
          get purchaseUiOpened() {
            return fake.purchaseUiOpened;
          },
          get finishCalls() {
            return fake.finishCalls;
          },
          complete(purchase) {
            fake.complete(purchase);
            void fake.provider.finishTransaction?.({
              transactionId: purchase.transactionId,
              ledgerEntryId: 'sdk-self-finish',
              isConsumable: true,
            });
          },
        };
        return { provider: fake.provider, store: actor };
      },
    });
    expect(result?.status).toBe('failed');
    expect(result?.failures).toEqual([{ path: 'finishCalls.length', expected: 0, actual: 1 }]);
  });

  it("fails a provider that declares finish: 'client' but never finishes", async () => {
    const [result] = await runCommerceConformanceVectors([vectorNamed('purchase-client-finish')], {
      createProvider(context) {
        const fake = createCommerceConformanceStore({
          ...context,
          profile: { ...context.profile, store: 'test.store', ...ownerProfiles.client },
        });
        const provider: CommerceProvider = {
          ...fake.provider,
          async finishTransaction() {
            return { finished: false };
          },
        };
        return { provider, store: fake };
      },
    });
    expect(result?.status).toBe('failed');
    expect(result?.failures).toEqual([
      { path: 'journal.op-1.length', expected: 7, actual: 6 },
      { path: 'finishCalls.length', expected: 1, actual: 0 },
      { path: 'available.length', expected: 0, actual: 1 },
    ]);
  });

  it("fails a provider that declares finish: 'server' but whose store is never finalized", async () => {
    const [result] = await runCommerceConformanceVectors([vectorNamed('purchase-client-finish')], {
      createProvider(context) {
        const fake = createCommerceConformanceStore({
          ...context,
          profile: { ...context.profile, store: 'test.store', ...ownerProfiles.server },
        });
        const actor: CommerceConformanceStoreActor = {
          get purchaseUiOpened() {
            return fake.purchaseUiOpened;
          },
          get finishCalls() {
            return fake.finishCalls;
          },
          complete: (purchase) => fake.complete(purchase),
          update: (purchase) => fake.update(purchase),
          error: (event) => fake.error(event),
          queueRequest: (result) => fake.queueRequest(result),
          queueFinish: (result) => fake.queueFinish(result),
          // No finalize: the backend's finalizer never consumes the purchase.
        };
        return { provider: fake.provider, store: actor };
      },
    });
    expect(result?.status).toBe('failed');
    expect(result?.failures).toEqual([{ path: 'available.length', expected: 0, actual: 1 }]);
  });

  it('refuses a derivation whose reference run does not reach the fixture terminal state', async () => {
    const vector = vectorNamed('purchase-client-finish');
    const derived = await deriveAdaptiveCommerceConformanceExpectation(vector, {
      store: 'test.store',
      journal: { 'op-1': ['requested', 'launched'] },
      verifyRequests: [],
      finishCalls: [],
      available: [],
    });
    expect(derived.reason).toBe(
      "the reference run under the provider capabilities ends op-1 in 'launched', not 'finished'",
    );
    const extra = await deriveAdaptiveCommerceConformanceExpectation(vector, {
      store: 'test.store',
      journal: { 'op-1': ['requested', 'finished'], 'op-2': ['requested'] },
      verifyRequests: [],
      finishCalls: [],
      available: [],
    });
    expect(extra.reason).toBe(
      'the reference run under the provider capabilities journals op-2, which the vector does not expect',
    );
  });

  it('reports a provider whose capabilities cannot be read', async () => {
    const [result] = await runCommerceConformanceVectors([vectorNamed('purchase-client-finish')], {
      createProvider(context) {
        const fake = createCommerceConformanceStore(context);
        return {
          provider: {
            ...fake.provider,
            async getCapabilities() {
              throw new Error('capabilities unavailable');
            },
          },
          store: fake,
        };
      },
    });
    expect(result?.status).toBe('failed');
    expect(result?.failures).toEqual([{
      path: 'capabilities',
      expected: 'provider.getCapabilities() resolves',
      actual: 'Error: capabilities unavailable',
    }]);
  });
});

describe('commerce conformance adaptive derived keys', () => {
  it('rewrites only the store segment of a derived key, never the transaction id', async () => {
    const vector = vectorNamed('event-before-listener');
    const fixtureStore = vector.profile.store;
    // A transaction id that happens to contain the fixture store id.
    const transactionId = `tx-${fixtureStore}-1`;
    const fixtureKey = `store:${encodeURIComponent(fixtureStore)}:${encodeURIComponent(transactionId)}`;
    const tricky: CommerceConformanceVector = {
      ...vector,
      steps: vector.steps.map((step) =>
        step.actor === 'store' && step.action === 'complete'
          ? { ...step, purchase: { ...step.purchase, transactionId } }
          : step),
      expect: {
        ...vector.expect,
        journal: { [fixtureKey]: vector.expect.journal?.[`store:${fixtureStore}:tx-1`] ?? [] },
        verifyRequests: (vector.expect.verifyRequests ?? []).map((request) => ({
          ...request,
          idempotencyKey: fixtureKey,
          transactionId,
        })),
        finishCalls: (vector.expect.finishCalls ?? []).map((call) => ({ ...call, transactionId })),
      },
    };
    expect((await runCommerceConformanceVector(tricky)).failures).toEqual([]);
    const [result] = await runCommerceConformanceVectors([tricky], {
      createProvider: fakeProviderWith(ownerProfiles.client, 'app-store'),
    });
    expect(result?.failures).toEqual([]);
    expect(result?.status).toBe('passed');
    expect(Object.keys(result?.adaptive?.expect.journal ?? {})).toEqual([
      `store:app-store:${encodeURIComponent(transactionId)}`,
    ]);
    expect(result?.adaptive?.expect.verifyRequests?.[0]?.transactionId).toBe(transactionId);
  });

  it('keeps a derived key that does not carry the fixture store prefix', async () => {
    const vector = vectorNamed('event-before-listener');
    const derived = await deriveAdaptiveCommerceConformanceExpectation(
      { ...vector, expect: { journal: { 'apps-in-toss:purchase:tx-1': ['purchased', 'finished'] } } },
      {
        store: 'app-store',
        journal: { 'apps-in-toss:purchase:tx-1': ['purchased', 'finished'] },
        verifyRequests: [],
        finishCalls: [],
        available: [],
      },
    );
    expect(derived.reason).toBeUndefined();
    expect(Object.keys(derived.expect?.journal ?? {})).toEqual(['apps-in-toss:purchase:tx-1']);
  });
});

describe('commerce conformance adaptive review follow-ups', () => {
  it('keeps a game key that starts with the fixture store id', async () => {
    // With a global substitution a fixture store `op` would rewrite the game key `op-1`.
    const vector = vectorNamed('purchase-client-finish');
    const opStore: CommerceConformanceVector = {
      ...vector,
      profile: { ...vector.profile, store: 'op' },
      expect: {
        ...vector.expect,
        verifyRequests: (vector.expect.verifyRequests ?? []).map((request) => ({
          ...request,
          store: 'op',
        })),
      },
    };
    expect((await runCommerceConformanceVector(opStore)).failures).toEqual([]);
    const [result] = await runCommerceConformanceVectors([opStore], {
      createProvider: fakeProviderWith(ownerProfiles.client, 'app-store'),
    });
    expect(result?.failures).toEqual([]);
    expect(result?.status).toBe('passed');
    expect(Object.keys(result?.adaptive?.expect.journal ?? {})).toEqual(['op-1']);
    expect(adaptDerivedPurchaseKeyStore('op-1', 'op', 'app-store')).toBe('op-1');
    expect(adaptDerivedPurchaseKeyStore('store:op:op-1', 'op', 'app-store'))
      .toBe('store:app-store:op-1');
  });

  it('polls an event-less provider and skips completions nothing would poll', async () => {
    const eventless = fakeProviderWith({
      ...ownerProfiles.client,
      lifecycle: { ...ownerProfiles.client.lifecycle, events: false },
    });
    const results = await runCommerceConformanceVectors(adaptiveVectors, {
      createProvider: eventless,
    });
    const unpolled = (index: number, action: string): string =>
      `store.${action} at steps[${String(index)}] needs lifecycle.events; the provider declares `
      + 'events: false and no reconcile or start follows it to poll the purchase';
    const intervened = (index: number, step: string, at: number): string =>
      `store.complete at steps[${String(index)}] needs lifecycle.events; the provider declares `
      + `events: false and ${step} at steps[${String(at)}] runs before the reconcile or start that `
      + 'would poll the purchase';
    expect(summarize(results)).toEqual([
      {
        vector: 'cancelled-and-failed',
        status: 'skipped',
        reason: 'purchaseError event needs lifecycle.events; the provider declares events: false',
      },
      { vector: 'event-before-listener', status: 'passed' },
      {
        vector: 'finish-failure-retry',
        status: 'skipped',
        reason: intervened(4, 'store.queueFinish', 5),
      },
      { vector: 'purchase-client-finish', status: 'skipped', reason: unpolled(3, 'complete') },
      { vector: 'purchase-host-finish', status: 'skipped', reason: unpolled(3, 'complete') },
      { vector: 'purchase-pending-then-purchased', status: 'skipped', reason: unpolled(5, 'update') },
      // The member named after the owner cannot be polled, so the runnable
      // member of the family is the canonical one here.
      { vector: 'purchase-server-finish', status: 'passed' },
      { vector: 'restart-before-verify', status: 'passed' },
      {
        vector: 'revoked-after-grant',
        status: 'skipped',
        reason: intervened(3, 'backend.revoke', 4),
      },
    ]);
    // The passing vectors were really driven by polling: the reference store
    // emitted nothing, and the journal still reached finished once per key.
    const restarted = adaptiveResult(results, 'restart-before-verify');
    expect(restarted.expect.journal).toEqual({
      'op-1': ['requested', 'launched', 'purchased', 'verifying', 'granted', 'finishing', 'finished'],
    });
    expect(restarted.expect.verifyRequests).toHaveLength(1);
    expect(restarted.expect.purchaseUiOpened).toBe(1);
    // A completion followed by a reconcile runs even though the vector was
    // written for an event-driven store.
    const vector = vectorNamed('purchase-client-finish');
    const reconciled: CommerceConformanceVector = {
      ...vector,
      steps: [...vector.steps, { actor: 'runtime', action: 'reconcile' }],
    };
    const [result] = await runCommerceConformanceVectors([reconciled], { createProvider: eventless });
    expect(result?.failures).toEqual([]);
    expect(result?.status).toBe('passed');
  });

  it('keeps the event-less fake store silent and the reconciler polling it', async () => {
    const { store, runtime, backend, journal } = createStoreFixture({
      ...clientTokenProfile,
      lifecycle: { availablePurchases: true, pending: false, restore: true, events: false, finish: 'client' },
    });
    const seen: string[] = [];
    store.provider.subscribe((event) => {
      seen.push(event.type);
    });
    store.complete({ transactionId: 'tx-1', storeSku: 'gems.small', token: 'token-1', state: 'purchased' });
    expect(seen).toEqual([]);
    backend.queueVerify({ status: 'granted', ledgerEntryId: 'le-1' });
    await runtime.reconcile();
    expect(journal.history('store:fixture.client-token:tx-1')).toEqual([
      'purchased', 'verifying', 'granted', 'finishing', 'finished',
    ]);
  });

  it('skips a purchase of a product kind or quantity the provider does not sell', async () => {
    const noConsumables = fakeProviderWith({
      ...ownerProfiles.client,
      purchase: { consumable: false, durable: true, subscription: false, quantity: false },
    });
    const results = await runCommerceConformanceVectors(
      [vectorNamed('purchase-client-finish'), vectorNamed('revoked-after-grant')],
      { createProvider: noConsumables },
    );
    expect(summarize(results)).toEqual([
      {
        vector: 'purchase-client-finish',
        status: 'skipped',
        reason: 'requestPurchase of gems_small needs purchase.consumable; the provider declares '
          + 'consumable: false',
      },
      { vector: 'revoked-after-grant', status: 'passed' },
    ]);
    const vector = vectorNamed('purchase-client-finish');
    const two: CommerceConformanceVector = {
      ...vector,
      steps: vector.steps.map((step) =>
        step.actor === 'game' && step.action === 'requestPurchase'
          ? { ...step, input: { ...step.input, quantity: 2 } }
          : step),
    };
    const [quantity] = await runCommerceConformanceVectors([two], {
      createProvider: fakeProviderWith(ownerProfiles.client),
    });
    expect(quantity?.status).toBe('skipped');
    expect(quantity?.reason).toBe(
      'requestPurchase of gems_small with quantity 2 needs purchase.quantity; the provider '
        + 'declares quantity: false',
    );
    const capabilities = createCommerceConformanceCapabilities({
      store: 'x',
      ...ownerProfiles.client,
      purchase: { consumable: true, durable: false, subscription: false, quantity: false },
    });
    expect(commerceConformanceAdaptiveSkipReason(vectorNamed('revoked-after-grant'), capabilities))
      .toBe('requestPurchase of remove_ads needs purchase.durable; the provider declares durable: false');
  });

  it('derives available from what the reference store still lists', async () => {
    // A finish that fails with no retry leaves the purchase listed and the record finishing.
    const vector = vectorNamed('finish-failure-retry');
    const steps = vector.steps.filter((step, index) =>
      !(step.actor === 'store' && step.action === 'queueFinish' && index > 2)
      && !(step.actor === 'runtime' && step.action === 'reconcile'));
    const unfinished: CommerceConformanceVector = {
      ...vector,
      steps,
      expect: {
        ...vector.expect,
        journal: {
          'op-1': ['requested', 'launched', 'purchased', 'verifying', 'granted', 'finishing'],
        },
        finishCalls: (vector.expect.finishCalls ?? []).slice(0, 1),
        available: [{ transactionId: 'tx-1', storeSku: 'gems.small', state: 'purchased' }],
      },
    };
    expect((await runCommerceConformanceVector(unfinished)).failures).toEqual([]);
    const [result] = await runCommerceConformanceVectors([unfinished], {
      createProvider: fakeProviderWith(ownerProfiles.host),
    });
    expect(result?.failures).toEqual([]);
    expect(result?.status).toBe('passed');
    expect(result?.adaptive?.expect.available).toEqual([
      { transactionId: 'tx-1', storeSku: 'gems.small', state: 'purchased' },
    ]);
    expect(result?.adaptive?.expect.finishCalls?.map((call) => [call.by, call.result]))
      .toEqual([['host', 'NETWORK']]);
  });

  it('reports a harness that cannot be built as a failed result', async () => {
    const [result] = await runCommerceConformanceVectors([vectorNamed('purchase-client-finish')], {
      createProvider() {
        throw new Error('no plugin');
      },
    });
    expect(result).toEqual({
      vector: 'purchase-client-finish',
      status: 'failed',
      passed: false,
      failures: [{ path: 'harness', expected: 'createProvider resolves', actual: 'Error: no plugin' }],
    });
  });

  it('answers a server finalization re-read from the grant, never from another record', async () => {
    const vector = vectorNamed('purchase-client-finish');
    const catalog = [
      ...(vector.catalog ?? []),
      { logicalId: 'remove_ads', kind: 'durable' as const, storeSku: 'remove.ads' },
    ];
    const finished = [
      'requested', 'launched', 'purchased', 'verifying', 'granted', 'finishing', 'finished',
    ] as const;
    const twoRecords: CommerceConformanceVector = {
      ...vector,
      vector: 'two-records-one-pass',
      catalog,
      steps: [
        { actor: 'runtime', action: 'start' },
        { actor: 'backend', action: 'queueVerify', decision: { status: 'granted', ledgerEntryId: 'le-1' } },
        { actor: 'backend', action: 'queueVerify', decision: { status: 'granted', ledgerEntryId: 'le-2' } },
        {
          actor: 'game',
          action: 'requestPurchase',
          input: { logicalId: 'gems_small', idempotencyKey: 'op-1' },
          returns: { outcome: 'launched' },
        },
        {
          actor: 'game',
          action: 'requestPurchase',
          input: { logicalId: 'remove_ads', idempotencyKey: 'op-2' },
          returns: { outcome: 'launched' },
        },
        { actor: 'runtime', action: 'stop' },
        {
          actor: 'store',
          action: 'complete',
          purchase: { transactionId: 'tx-1', storeSku: 'gems.small', token: 'token-1', state: 'purchased' },
        },
        {
          actor: 'store',
          action: 'complete',
          purchase: { transactionId: 'tx-2', storeSku: 'remove.ads', token: 'token-2', state: 'purchased' },
        },
        { actor: 'runtime', action: 'start' },
      ],
      expect: {
        journal: { 'op-1': [...finished], 'op-2': [...finished] },
        verifyRequests: [
          { idempotencyKey: 'op-1', store: vector.profile.store, transactionId: 'tx-1', token: 'token-1' },
          { idempotencyKey: 'op-2', store: vector.profile.store, transactionId: 'tx-2', token: 'token-2' },
        ],
        ledger: [
          { entryId: 'le-1', type: 'grant', logicalId: 'gems_small' },
          { entryId: 'le-2', type: 'grant', logicalId: 'remove_ads' },
        ],
        finishCalls: [
          { by: 'client', transactionId: 'tx-1', ledgerEntryId: 'le-1', isConsumable: true, result: 'finished' },
          {
            by: 'client', transactionId: 'tx-2', ledgerEntryId: 'le-2', isConsumable: false, result: 'finished',
          },
        ],
        available: [],
      },
    };
    expect((await runCommerceConformanceVector(twoRecords)).failures).toEqual([]);
    const [result] = await runCommerceConformanceVectors([twoRecords], {
      createProvider: fakeProviderWith(ownerProfiles.server),
    });
    expect(result?.failures).toEqual([]);
    expect(result?.status).toBe('passed');
    // Each record's re-read is answered by its own grant, so the second
    // record's scripted decision is still there when its first verify runs.
    expect(result?.adaptive?.expect.verifyRequests?.map((request) => request.idempotencyKey))
      .toEqual(['op-1', 'op-1', 'op-2', 'op-2']);
    expect(result?.adaptive?.expect.finishCalls).toEqual([]);
    expect(result?.adaptive?.expect.ledger).toEqual(twoRecords.expect.ledger);
  });

  it('answers a replayed granted key as finalized only when asked to', async () => {
    let reread = false;
    const finalized: string[] = [];
    const backend = createCommerceConformanceBackend({
      finalize: (request) => {
        finalized.push(request.ledgerEntryId);
      },
      finalizeOnReread: () => reread,
    });
    const request = {
      idempotencyKey: 'op-1',
      playerId: 'player-1',
      store: 'fixture.client-token',
      transactionId: 'tx-1',
      token: 'token-1',
      logicalId: 'gems_small',
      quantity: 1,
      evidence: { schema: 'fixture.v1', payload: {} },
    };
    backend.queueVerify({ status: 'granted', ledgerEntryId: 'le-1' });
    backend.queueVerify({ status: 'granted', ledgerEntryId: 'le-2' });
    expect(await backend.verifyPurchase(request)).toEqual({ status: 'granted', ledgerEntryId: 'le-1' });
    reread = true;
    expect(await backend.verifyPurchase(request)).toEqual({
      status: 'granted', ledgerEntryId: 'le-1', finalization: 'completed', alreadyProcessed: true,
    });
    expect(finalized).toEqual(['le-1']);
    // The le-2 decision is still queued for the next key.
    expect(await backend.verifyPurchase({ ...request, idempotencyKey: 'op-2', transactionId: 'tx-2' }))
      .toEqual({ status: 'granted', ledgerEntryId: 'le-2' });
    reread = false;
    await expect(backend.verifyPurchase(request)).rejects.toThrow('Unscripted verify for op-1');
  });
});

describe('commerce conformance adaptive local review follow-ups', () => {
  it('re-derives a fixture key through the provider store key form', async () => {
    // Play derives token keys; the generic prefix swap would never find them.
    const vector = vectorNamed('event-before-listener');
    const expectedKey = await createDerivedPurchaseIdempotencyKey({
      store: 'google-play',
      transactionId: 'tx-1',
      token: 'token-1',
    });
    expect(expectedKey.startsWith('store:')).toBe(false);
    expect(await adaptDerivedPurchaseKey(vector, 'store:fixture.client-token:tx-1', 'google-play'))
      .toBe(expectedKey);
    expect(await adaptDerivedPurchaseKey(vector, 'op-1', 'google-play')).toBe('op-1');
    const [result] = await runCommerceConformanceVectors([vector], {
      createProvider: fakeProviderWith(ownerProfiles.server, 'google-play'),
    });
    expect(result?.failures).toEqual([]);
    expect(result?.status).toBe('passed');
    expect(Object.keys(result?.adaptive?.expect.journal ?? {})).toEqual([expectedKey]);
  });

  it('picks a runnable canonical family member for an event-less provider', async () => {
    // `purchase-client-finish` ends on an unpolled completion, so the family
    // falls through to `purchase-server-finish`, whose completion is reconciled.
    const results = await runCommerceConformanceVectors(adaptiveVectors, {
      createProvider: fakeProviderWith({
        ...ownerProfiles.client,
        lifecycle: { ...ownerProfiles.client.lifecycle, events: false },
      }),
    });
    const family = summarize(results).filter((result) => result.vector.startsWith('purchase-')
      && result.vector.endsWith('-finish'));
    expect(family).toEqual([
      {
        vector: 'purchase-client-finish',
        status: 'skipped',
        reason: 'store.complete at steps[3] needs lifecycle.events; the provider declares events: '
          + 'false and no reconcile or start follows it to poll the purchase',
      },
      {
        vector: 'purchase-host-finish',
        status: 'skipped',
        reason: 'store.complete at steps[3] needs lifecycle.events; the provider declares events: '
          + 'false and no reconcile or start follows it to poll the purchase',
      },
      { vector: 'purchase-server-finish', status: 'passed' },
    ]);
    expect(adaptiveResult(results, 'purchase-server-finish').expect.finishCalls?.map((c) => c.by))
      .toEqual(['client']);
  });

  it('skips a completion nothing can poll when the provider lists no purchases either', () => {
    const capabilities = createCommerceConformanceCapabilities({
      store: 'x',
      ...ownerProfiles.client,
      lifecycle: { ...ownerProfiles.client.lifecycle, events: false, availablePurchases: false },
    });
    expect(commerceConformanceAdaptiveSkipReason(vectorNamed('event-before-listener'), capabilities))
      .toBe('store.complete at steps[0] needs lifecycle.events; the provider declares events: '
        + 'false and lifecycle.availablePurchases: false, so nothing can poll the purchase');
  });

  it('reports a reference run that cannot play the scenario as a skip, not a failure', async () => {
    const vector = vectorNamed('purchase-client-finish');
    const unknownSku: CommerceConformanceVector = {
      ...vector,
      steps: vector.steps.map((step) =>
        step.actor === 'store' && step.action === 'complete'
          ? { ...step, purchase: { ...step.purchase, storeSku: 'gems.unknown' } }
          : step),
    };
    const [result] = await runCommerceConformanceVectors([unknownSku], {
      createProvider: fakeProviderWith(ownerProfiles.client),
    });
    expect(result?.status).toBe('skipped');
    expect(result?.failures).toEqual([]);
    expect(result?.reason).toMatch(
      /^the reference run under the provider capabilities failed at steps\[3\]: expected store\.complete completes, got CommerceConformanceScriptError: /u,
    );
  });

  it('reports a provider read that throws while matching as a failed run', async () => {
    const [result] = await runCommerceConformanceVectors([vectorNamed('purchase-client-finish')], {
      createProvider(context) {
        const fake = createCommerceConformanceStore({
          ...context,
          profile: { ...context.profile, store: 'test.store', ...ownerProfiles.client },
        });
        let reads = 0;
        const provider: CommerceProvider = {
          ...fake.provider,
          async getAvailablePurchases(request) {
            reads += 1;
            if (reads > 1) {
              throw new Error('store went away');
            }
            return fake.provider.getAvailablePurchases(request);
          },
        };
        return { provider, store: fake };
      },
    });
    expect(result?.status).toBe('failed');
    expect(result?.failures).toEqual([
      { path: 'expect', expected: 'expectations evaluate', actual: 'Error: store went away' },
    ]);
  });

  it('does not finalize a re-read of a reversed grant', async () => {
    let reread = true;
    const backend = createCommerceConformanceBackend({ finalizeOnReread: () => reread });
    const request = {
      idempotencyKey: 'op-1',
      playerId: 'player-1',
      store: 'fixture.client-token',
      transactionId: 'tx-1',
      token: 'token-1',
      logicalId: 'gems_small',
      quantity: 1,
      evidence: { schema: 'fixture.v1', payload: {} },
    };
    backend.queueVerify({ status: 'granted', ledgerEntryId: 'le-1' });
    expect(await backend.verifyPurchase(request)).toEqual({ status: 'granted', ledgerEntryId: 'le-1' });
    backend.revoke({ ledgerEntryId: 'le-1', entryId: 'le-2', reason: 'refunded' });
    await expect(backend.verifyPurchase(request)).rejects.toThrow('Unscripted verify for op-1');
    reread = false;
  });

  it('reads an event-less store once on start', async () => {
    const { store, runtime, backend, journal } = createStoreFixture({
      ...clientTokenProfile,
      lifecycle: { availablePurchases: true, pending: false, restore: true, events: false, finish: 'client' },
    });
    let reads = 0;
    const provider = store.provider;
    const original = provider.getAvailablePurchases.bind(provider);
    Object.assign(provider, {
      async getAvailablePurchases(request: GetAvailablePurchasesInput | undefined) {
        reads += 1;
        return original(request);
      },
    });
    store.complete({ transactionId: 'tx-1', storeSku: 'gems.small', token: 'token-1', state: 'purchased' });
    backend.queueVerify({ status: 'granted', ledgerEntryId: 'le-1' });
    await runtime.start();
    expect(reads).toBe(1);
    expect(journal.history('store:fixture.client-token:tx-1')).toEqual([
      'purchased', 'verifying', 'granted', 'finishing', 'finished',
    ]);
  });
});
