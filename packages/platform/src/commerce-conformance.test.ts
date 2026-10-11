import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  addIsoDuration,
  commerceConformanceAdaptiveSkipReason,
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
  matchPartial,
  runCommerceConformanceVector,
  runCommerceConformanceVectors,
  type CommerceConformanceAdaptation,
  type CommerceConformanceContext,
  type CommerceConformanceFailure,
  type CommerceConformanceHarness,
  type CommerceConformanceStoreActor,
  type CommerceConformanceVectorResult,
} from './commerce-conformance.js';
import {
  assertCommerceConformanceVector,
  type CommerceConformanceProfile,
  type CommerceConformanceVector,
} from './commerce-vectors.js';
import type { CommerceFinishOwner, CommerceProvider, CreditLot } from './commerce.js';

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

function vectorNamed(name: string): CommerceConformanceVector {
  const vector = vectors.find((candidate) => candidate.vector === name);
  if (vector === undefined) {
    throw new Error(`Missing vector ${name}.`);
  }
  return vector;
}

const clientTokenProfile = vectorNamed('purchase-client-finish').profile;
const gemsCatalog = vectorNamed('purchase-client-finish').catalog ?? [];

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
      purchase: { state: 'purchased', settlement: { ledgerEntryId: 'op-1' }, transactionId: 'op-1' },
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
    expect(addIsoDuration('2026-01-31T00:00:00Z', 'P1M')).toBe('2026-03-03T00:00:00Z');
    expect(addIsoDuration('2026-10-01T00:00:00Z', 'P1W')).toBe('2026-10-08T00:00:00Z');
    expect(addIsoDuration('2026-10-01T00:00:00Z', 'PT1H30M')).toBe('2026-10-01T01:30:00Z');
    expect(addIsoDuration('2026-10-01T00:00:00Z', 'P1Y')).toBe('2027-10-01T00:00:00Z');
    expect(() => addIsoDuration('2026-10-01T00:00:00Z', '30D')).toThrow(TypeError);
    expect(() => addIsoDuration('2026-10-01T00:00:00Z', 'P')).toThrow(TypeError);
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
      createdAt: '2026-10-05T00:00:00Z', expiresAt: '2026-11-01T00:00:00Z',
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
      debits: [{ lotId: 'le-expiring', amount: 5 }, { lotId: 'le-title', amount: 10 }, { lotId: 'le-cross', amount: 3 }],
    });
    expect(await wallet.spend({ titleId: 'title-a', currency: 'credits', amount: 18, idempotencyKey: 's-1' }))
      .toEqual({ ...spend, alreadyProcessed: true });
    expect(wallet.debits).toHaveLength(3);
    clock.set('2026-11-02T00:00:00Z');
    wallet.creditFromGrant({
      ledgerEntryId: 'le-expiring', currency: 'credits', amount: 5,
      origin: { channel: 'store', store: 'fixture.client-token', titleId: 'title-a' },
      createdAt: '2026-10-05T00:00:00Z', expiresAt: '2026-11-01T00:00:00Z',
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
      purchase: { transactionId: 'membership:op-1:0', logicalId: 'membership_plus', settlement: { ledgerEntryId: 'membership:op-1:0' } },
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

  it('skips store-side pending and purchaseError scenarios the provider does not declare', async () => {
    const results = await runCommerceConformanceVectors(adaptiveVectors, {
      createProvider: fakeProviderWith({
        ...ownerProfiles.client,
        lifecycle: { ...ownerProfiles.client.lifecycle, pending: false, events: false },
      }),
    });
    expect(summarize(results).filter((result) => result.status === 'skipped')).toEqual([
      {
        vector: 'cancelled-and-failed',
        status: 'skipped',
        reason: 'purchaseError event needs lifecycle.events; the provider declares events: false',
      },
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

  it('refuses a derivation whose reference run does not reach the fixture terminal state', () => {
    const vector = vectorNamed('purchase-client-finish');
    const derived = deriveAdaptiveCommerceConformanceExpectation(vector, {
      store: 'test.store',
      journal: { 'op-1': ['requested', 'launched'] },
      verifyRequests: [],
      finishCalls: [],
    });
    expect(derived.reason).toBe(
      "the reference run under the provider capabilities ends op-1 in 'launched', not 'finished'",
    );
    const extra = deriveAdaptiveCommerceConformanceExpectation(vector, {
      store: 'test.store',
      journal: { 'op-1': ['requested', 'finished'], 'op-2': ['requested'] },
      verifyRequests: [],
      finishCalls: [],
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
