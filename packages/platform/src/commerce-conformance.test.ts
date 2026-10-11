import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  addIsoDuration,
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
  fillCommerceConformancePurchase,
  matchPartial,
  runCommerceConformanceVector,
  runCommerceConformanceVectors,
  type CommerceConformanceFailure,
  type CommerceConformanceHarness,
} from './commerce-conformance.js';
import {
  assertCommerceConformanceVector,
  type CommerceConformanceVector,
} from './commerce-vectors.js';
import type { CreditLot } from './commerce.js';

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
