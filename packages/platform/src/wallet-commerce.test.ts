import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  createCommerceConformanceBackend,
  createCommerceConformanceClock,
  createCommerceConformanceHarness,
  createCommerceConformanceJournal,
  runCommerceConformanceVectors,
  type CommerceConformanceHarness,
  type CommerceConformanceWalletActor,
} from './commerce-conformance.js';
import { assertCommerceConformanceVector } from './commerce-vectors.js';
import {
  addIsoDuration,
  assertCreditScopeRegistry,
  assertCreditWalletOffer,
  compareCreditLotSpendOrder,
  createCreditCommerceCapabilities,
  createCreditCommerceProvider,
  createCreditSubscriptionEventId,
  createCreditWalletSpendEvidence,
  createInMemoryCreditWallet,
  createMembershipRenewalKey,
  creditPriceMultiple,
  creditWalletSpendEvidenceSchema,
  defaultCommerceBillingAuthority,
  deriveCreditLotSpendScope,
  isCreditLotEligible,
  isIsoDuration,
  parseIsoDuration,
  planCreditDebits,
  readCreditWalletSpendEvidence,
  resolveCommerceBillingAuthority,
  sameCreditAmount,
  selectEligibleCreditLots,
  type CreditEntitlement,
  type CreditLot,
  type CreditOffer,
  type CreditWalletClient,
  type InMemoryCreditWallet,
} from './commerce-wallet.js';
import { CommerceError, type CommerceEvent } from './commerce.js';

const currency = 'wallet-unit';
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
const walletVectors = readdirSync(vectorsDir)
  .filter((file) => file.endsWith('.json'))
  .sort()
  .map((file) =>
    assertCommerceConformanceVector(JSON.parse(readFileSync(join(vectorsDir, file), 'utf8'))))
  .filter((vector) => vector.wallet !== undefined);

function lot(input: Partial<CreditLot> & { readonly lotId: string }): CreditLot {
  return {
    currency,
    amount: 10,
    remaining: 10,
    createdAt: '2026-10-01T00:00:00Z',
    origin: { channel: 'store', store: 'fixture', titleId: 'title-a' },
    spendScope: { kind: 'title', titleId: 'title-a' },
    ...input,
  };
}

const packOffer: CreditOffer = {
  logicalId: 'booster',
  storeSku: 'booster.1',
  kind: 'consumable',
  title: 'Booster',
  description: 'One booster',
  price: { currency, amount: 4 },
};
const membershipTerms = {
  scope: 'platform' as const,
  price: { currency, amount: 30 },
  period: 'P30D',
};
const membershipOffer: CreditOffer = {
  logicalId: 'membership_plus',
  storeSku: 'membership.plus',
  kind: 'subscription',
  title: 'Plus',
  description: 'Plus membership',
  price: { currency, amount: 30 },
  membership: membershipTerms,
};
const grant = (
  ledgerEntryId: string,
  amount: number,
  channel: 'store' | 'off-store' = 'store',
  extra: { readonly expiresAt?: string; readonly createdAt?: string; readonly titleId?: string } = {},
) => ({
  ledgerEntryId,
  currency,
  amount,
  origin: {
    channel,
    store: channel === 'store' ? 'fixture.store' : 'fixture.web',
    titleId: extra.titleId ?? 'title-a',
  },
  createdAt: extra.createdAt ?? '2026-10-01T00:00:00Z',
  ...(extra.expiresAt === undefined ? {} : { expiresAt: extra.expiresAt }),
});

describe('credit lot rules', () => {
  it('derives the spend scope from the origin channel', () => {
    expect(deriveCreditLotSpendScope({ channel: 'store', store: 'fixture', titleId: 'title-a' }))
      .toEqual({ kind: 'title', titleId: 'title-a' });
    expect(deriveCreditLotSpendScope({ channel: 'off-store', store: 'web', titleId: 'title-a' }))
      .toEqual({ kind: 'cross-title' });
    expect(deriveCreditLotSpendScope({ channel: 'promotion', store: 'promo', titleId: 'title-a' }))
      .toEqual({ kind: 'title', titleId: 'title-a' });
    expect(deriveCreditLotSpendScope(
      { channel: 'promotion', store: 'promo', titleId: 'title-a' },
      { explicit: { kind: 'cross-title' } },
    )).toEqual({ kind: 'cross-title' });
    expect(() => deriveCreditLotSpendScope(
      { channel: 'store', store: 'fixture', titleId: 'title-a' },
      { explicit: { kind: 'cross-title' } },
    )).toThrow(TypeError);
    expect(() => deriveCreditLotSpendScope(
      { channel: 'promotion', store: 'promo', titleId: 'title-a' },
      { explicit: { kind: 'everywhere' } as never },
    )).toThrow();
    expect(() => deriveCreditLotSpendScope(
      { channel: 'promotion', store: 'google-play', titleId: 'title-a' },
      { explicit: { kind: 'cross-title' } },
    )).toThrow(RangeError);
  });

  it('lets the credit scope registry decide which stores count as off-store, except the fixed stores', () => {
    const creditScope = { 'partner-store': 'cross-title', 'web-checkout': 'title' } as const;
    expect(deriveCreditLotSpendScope(
      { channel: 'store', store: 'partner-store', titleId: 'title-a' },
      { creditScope },
    )).toEqual({ kind: 'cross-title' });
    expect(deriveCreditLotSpendScope(
      { channel: 'off-store', store: 'web-checkout', titleId: 'title-a' },
      { creditScope },
    )).toEqual({ kind: 'title', titleId: 'title-a' });
    expect(deriveCreditLotSpendScope(
      { channel: 'off-store', store: 'google-play', titleId: 'title-a' },
    )).toEqual({ kind: 'title', titleId: 'title-a' });
    expect(deriveCreditLotSpendScope(
      { channel: 'store', store: 'constructor', titleId: 'title-a' },
      { creditScope },
    )).toEqual({ kind: 'title', titleId: 'title-a' });
    expect(() => assertCreditScopeRegistry({ 'google-play': 'cross-title' })).toThrow(RangeError);
    expect(() => assertCreditScopeRegistry({ 'app-store': 'cross-title' })).toThrow(RangeError);
    expect(() => assertCreditScopeRegistry({ web: 'everywhere' as 'title' })).toThrow(TypeError);
    expect(() => deriveCreditLotSpendScope(
      { channel: 'store', store: 'app-store', titleId: 'title-a' },
      { creditScope: { 'app-store': 'cross-title' } },
    )).toThrow(RangeError);
  });

  it('selects eligible lots by currency, balance, expiry, and scope in spend order', () => {
    const lots = [
      lot({ lotId: 'cross', spendScope: { kind: 'cross-title' }, createdAt: '2026-09-01T00:00:00Z' }),
      lot({ lotId: 'title-b', spendScope: { kind: 'title', titleId: 'title-b' } }),
      lot({ lotId: 'expired', expiresAt: '2026-10-01T00:00:00Z' }),
      lot({ lotId: 'expiring', expiresAt: '2026-12-01T00:00:00Z' }),
      lot({ lotId: 'empty', remaining: 0 }),
      lot({ lotId: 'other-currency', currency: 'other' }),
      lot({ lotId: 'title-a' }),
    ];
    const now = '2026-10-01T00:00:00Z';
    expect(selectEligibleCreditLots(lots, { titleId: 'title-a', currency, now }).map((entry) => entry.lotId))
      .toEqual(['expiring', 'title-a', 'cross']);
    expect(selectEligibleCreditLots(lots, { titleId: 'title-a', currency, scope: 'platform', now })
      .map((entry) => entry.lotId)).toEqual(['cross']);
    expect(isCreditLotEligible(lots[2] as CreditLot, { titleId: 'title-a', currency, now: Date.parse(now) - 1 }))
      .toBe(true);
    // At a historical boundary, a lot that did not exist yet cannot fund the spend.
    expect(isCreditLotEligible(lots[6] as CreditLot, { titleId: 'title-a', currency, now, createdBy: now })).toBe(true);
    expect(isCreditLotEligible(lots[6] as CreditLot, {
      titleId: 'title-a', currency, now, createdBy: '2026-09-30T23:59:59Z',
    })).toBe(false);
    expect(() => isCreditLotEligible(lots[6] as CreditLot, { titleId: 'title-a', currency, now, createdBy: 'later' }))
      .toThrow(TypeError);
    expect(() => isCreditLotEligible(lots[0] as CreditLot, { titleId: 'title-a', currency, now: 'soon' }))
      .toThrow(TypeError);
    expect([...lots].sort(compareCreditLotSpendOrder)[0]?.lotId).toBe('expired');
  });

  it('plans debits in order and plans nothing when the eligible balance is short', () => {
    const eligible = [
      lot({ lotId: 'b', remaining: 3 }),
      lot({ lotId: 'a', remaining: 5, createdAt: '2026-09-01T00:00:00Z' }),
    ];
    expect(planCreditDebits(eligible, 6)).toEqual({
      status: 'debited',
      debits: [{ lotId: 'a', amount: 5 }, { lotId: 'b', amount: 1 }],
    });
    expect(planCreditDebits(eligible, 9)).toMatchObject({
      status: 'rejected', error: { code: 'INSUFFICIENT_BALANCE', retryable: false },
    });
    expect(planCreditDebits(eligible, 0)).toMatchObject({ status: 'rejected', error: { code: 'INVALID_RESPONSE' } });
    expect(planCreditDebits(eligible, Number.NaN)).toMatchObject({ status: 'rejected' });
    expect(eligible.map((entry) => entry.remaining)).toEqual([3, 5]);
    expect(creditPriceMultiple(8, 4)).toBe(2);
    expect(creditPriceMultiple(6, 4)).toBeUndefined();
    expect(creditPriceMultiple(0.3, 0.1)).toBe(3);
    expect(creditPriceMultiple(4, 0)).toBeUndefined();
  });

  it('does not treat a shortfall within an absolute epsilon as covered', () => {
    // Hand-checked on the old helper: sameCreditAmount(0, 1e-9) was true.
    expect(sameCreditAmount(0, 1e-9)).toBe(false);
    expect(planCreditDebits([], 1e-9)).toMatchObject({
      status: 'rejected',
      error: { code: 'INSUFFICIENT_BALANCE', retryable: false },
    });
    expect(planCreditDebits([lot({ lotId: 'empty', remaining: 0 })], 1e-9)).toMatchObject({
      status: 'rejected',
      error: { code: 'INSUFFICIENT_BALANCE' },
    });
    // Half of a tiny price is still a shortfall; relative noise cannot cover it.
    expect(planCreditDebits([lot({ lotId: 'half', remaining: 5e-10, amount: 5e-10 })], 1e-9))
      .toMatchObject({ status: 'rejected', error: { code: 'INSUFFICIENT_BALANCE' } });
    // A lot that actually holds the tiny price is debited, not skipped as dust.
    expect(planCreditDebits([lot({ lotId: 'dust', remaining: 1e-9, amount: 1e-9 })], 1e-9)).toEqual({
      status: 'debited',
      debits: [{ lotId: 'dust', amount: 1e-9 }],
    });
    const fractional = planCreditDebits([
      lot({ lotId: 'tenth', remaining: 0.1, amount: 0.1 }),
      lot({ lotId: 'fifth', remaining: 0.2, amount: 0.2, createdAt: '2026-10-02T00:00:00Z' }),
    ], 0.3);
    expect(fractional.status).toBe('debited');
    if (fractional.status === 'debited') {
      expect(fractional.debits.reduce((sum, debit) => sum + debit.amount, 0)).toBeGreaterThanOrEqual(0.3);
    }
    // 0.7 + 0.1 lands slightly under 0.8; that float residue still covers.
    expect(planCreditDebits([
      lot({ lotId: 'seven', remaining: 0.7, amount: 0.7 }),
      lot({ lotId: 'tenth-b', remaining: 0.1, amount: 0.1, createdAt: '2026-10-02T00:00:00Z' }),
    ], 0.8)).toMatchObject({ status: 'debited' });
    expect(creditPriceMultiple(1e-9, 1e-9)).toBe(1);
    expect(creditPriceMultiple(1e-9, 2e-9)).toBeUndefined();
    expect(creditPriceMultiple(0.3, 0.1)).toBe(3);
  });

  it('does not treat a one-credit shortfall of a large price as covered', () => {
    // A relative 1e-9 of 1_000_000_000 is one credit, so the old check accepted it.
    for (const price of [1_000_000_000, 1_000_000_000_000]) {
      const balance = price - 1;
      expect(sameCreditAmount(balance, price), String(price)).toBe(false);
      expect(planCreditDebits([lot({ lotId: 'short', remaining: balance, amount: balance })], price), String(price))
        .toMatchObject({ status: 'rejected', error: { code: 'INSUFFICIENT_BALANCE', retryable: false } });
      expect(creditPriceMultiple(balance, price), String(price)).toBeUndefined();
      expect(planCreditDebits([lot({ lotId: 'exact', remaining: price, amount: price })], price), String(price))
        .toEqual({ status: 'debited', debits: [{ lotId: 'exact', amount: price }] });
      }
      });

      it('covers a price paid by many fractional lots', () => {
      const lots = Array.from({ length: 100 }, (_, index) => lot({
        lotId: `tenth-${index}`,
        remaining: 0.1,
        amount: 0.1,
      }));
      const plan = planCreditDebits(lots, 10);
      expect(plan).toMatchObject({ status: 'debited' });
      if (plan.status === 'debited') {
        expect(plan.debits).toHaveLength(100);
        expect(plan.debits.reduce((sum, debit) => sum + debit.amount, 0)).toBeCloseTo(10, 10);
      }
      });

      it('does not treat half of a subnormal price as covered', () => {
      const price = 2 * Number.MIN_VALUE;
      expect(planCreditDebits([
        lot({ lotId: 'half-min', remaining: Number.MIN_VALUE, amount: Number.MIN_VALUE }),
      ], price)).toMatchObject({ status: 'rejected', error: { code: 'INSUFFICIENT_BALANCE' } });
      });

      it('covers a finite price from one lot when the other lots would overflow the sum', () => {
      const plan = planCreditDebits([
        lot({ lotId: 'max-a', remaining: Number.MAX_VALUE, amount: Number.MAX_VALUE }),
        lot({ lotId: 'max-b', remaining: Number.MAX_VALUE, amount: Number.MAX_VALUE, createdAt: '2026-10-02T00:00:00Z' }),
      ], Number.MAX_VALUE);
      expect(plan).toEqual({
        status: 'debited',
        debits: [{ lotId: 'max-a', amount: Number.MAX_VALUE }],
      });
      });

  it('builds membership renewal keys and stable subscription event ids', () => {
    expect(createMembershipRenewalKey('op-1', 2)).toBe('membership:op-1:2');
    expect(createCreditSubscriptionEventId('op-1', 0, 'subscriptionStarted')).toBe('op-1:0:subscriptionStarted');
    expect(() => createMembershipRenewalKey('', 0)).toThrow(TypeError);
    expect(() => createMembershipRenewalKey('op-1', -1)).toThrow(TypeError);
    expect(() => createMembershipRenewalKey('op-1', 1.5)).toThrow(TypeError);
    expect(() => createCreditSubscriptionEventId('op-1', 0, 'subscriptionPaused' as 'subscriptionStarted'))
      .toThrow(TypeError);
  });

  it('accepts only positive ISO-8601 periods and anchors months on the start date', () => {
    expect(isIsoDuration('P30D')).toBe(true);
    expect(isIsoDuration('PT1S')).toBe(true);
    expect(parseIsoDuration('P1Y2M3W4DT5H6M7S')).toEqual({
      years: 1, months: 2, weeks: 3, days: 4, hours: 5, minutes: 6, seconds: 7,
    });
    for (const invalid of ['PT', 'P', '30D', 'P0D', 'PT0S', 'P0Y0M', 'P1DT', 'PT1H0']) {
      expect(isIsoDuration(invalid), invalid).toBe(false);
    }
    expect(addIsoDuration('2026-01-31T00:00:00Z', 'P1M')).toBe('2026-02-28T00:00:00Z');
    expect(addIsoDuration('2026-01-31T00:00:00Z', 'P1M', 2)).toBe('2026-03-31T00:00:00Z');
    expect(addIsoDuration('2026-01-31T00:00:00Z', 'P1M', 3)).toBe('2026-04-30T00:00:00Z');
    expect(addIsoDuration('2024-02-29T00:00:00Z', 'P1Y')).toBe('2025-02-28T00:00:00Z');
    expect(addIsoDuration('2026-10-01T00:00:00Z', 'P30D', 2)).toBe('2026-11-30T00:00:00Z');
    expect(addIsoDuration('2026-10-01T00:00:00Z', 'P30D', 0)).toBe('2026-10-01T00:00:00Z');
    expect(() => addIsoDuration('2026-10-01T00:00:00Z', 'P30D', 1.5)).toThrow(TypeError);
  });

  it('validates wallet offers beyond their shape', () => {
    expect(assertCreditWalletOffer(membershipOffer)).toEqual(membershipOffer);
    expect(() => assertCreditWalletOffer({ ...packOffer, kind: 'subscription' })).toThrow(/no membership terms/u);
    expect(() => assertCreditWalletOffer({ ...packOffer, membership: membershipTerms })).toThrow(/is consumable/u);
    expect(() => assertCreditWalletOffer({
      ...membershipOffer, membership: { ...membershipTerms, period: 'P0D' },
    })).toThrow(/positive ISO-8601/u);
    expect(() => assertCreditWalletOffer({ ...membershipOffer, price: { currency, amount: 29 } }))
      .toThrow(/priced as its membership terms/u);
  });
});

describe('billing authority', () => {
  it('resolves the RFC defaults and rejects host on store-billed profiles', () => {
    expect(defaultCommerceBillingAuthority('web')).toBe('host');
    expect(resolveCommerceBillingAuthority('web')).toBe('host');
    expect(resolveCommerceBillingAuthority('web-preview')).toBe('host');
    expect(resolveCommerceBillingAuthority('web', 'store')).toBe('store');
    expect(resolveCommerceBillingAuthority('microsoft-store')).toBe('store');
    expect(resolveCommerceBillingAuthority('devvit', 'host')).toBe('host');
    expect(resolveCommerceBillingAuthority('google-play')).toBe('store');
    expect(resolveCommerceBillingAuthority('app-store', 'store')).toBe('store');
    expect(() => resolveCommerceBillingAuthority('google-play', 'host')).toThrow(RangeError);
    expect(() => resolveCommerceBillingAuthority('app-store', 'host')).toThrow(RangeError);
    expect(() => resolveCommerceBillingAuthority('web', 'bank' as 'host')).toThrow(TypeError);
    expect(() => resolveCommerceBillingAuthority('')).toThrow(TypeError);
  });
});

describe('spend evidence', () => {
  it('round-trips through a flat envelope payload', () => {
    const envelope = createCreditWalletSpendEvidence({
      store: 'wallet',
      titleId: 'title-a',
      entitlementId: 'op-1',
      amount: 6,
      debits: [{ lotId: 'a', amount: 5 }, { lotId: 'b', amount: 1 }],
    });
    expect(envelope.schema).toBe(creditWalletSpendEvidenceSchema);
    expect(Object.values(envelope.payload).every((value) => typeof value !== 'object')).toBe(true);
    expect(readCreditWalletSpendEvidence(envelope)).toEqual({
      store: 'wallet',
      titleId: 'title-a',
      entitlementId: 'op-1',
      amount: 6,
      debits: [{ lotId: 'a', amount: 5 }, { lotId: 'b', amount: 1 }],
    });
    expect(readCreditWalletSpendEvidence({ schema: 'other', payload: {} })).toBeUndefined();
    expect(readCreditWalletSpendEvidence({ ...envelope, payload: { ...envelope.payload, debits: '{' } }))
      .toBeUndefined();
    expect(readCreditWalletSpendEvidence({
      ...envelope, payload: { ...envelope.payload, debits: '[{"lotId":"a","amount":"5"}]' },
    })).toBeUndefined();
  });
});

describe('in-memory credit wallet', () => {
  const createWallet = (input: {
    readonly now?: () => string;
    readonly offers?: readonly CreditOffer[];
    readonly maxRenewalsPerTick?: number;
  } = {}) => createInMemoryCreditWallet({
    store: 'wallet',
    currencies: [currency],
    now: input.now ?? (() => '2026-10-01T00:00:00Z'),
    offers: input.offers ?? [packOffer, membershipOffer],
    ...(input.maxRenewalsPerTick === undefined ? {} : { maxRenewalsPerTick: input.maxRenewalsPerTick }),
  });

  it('credits a lot once per ledger entry and refuses a conflicting replay', () => {
    const wallet = createWallet();
    const first = wallet.creditFromGrant(grant('le-1', 10));
    expect(wallet.creditFromGrant(grant('le-1', 10))).toEqual(first);
    expect(wallet.lots).toHaveLength(1);
    expect(() => wallet.creditFromGrant(grant('le-1', 11))).toThrow(/different lot/u);
    expect(() => wallet.creditFromGrant(grant('le-1', 10, 'store', { expiresAt: '2026-12-01T00:00:00Z' })))
      .toThrow(/different lot/u);
    expect(() => wallet.creditFromGrant(grant('le-1', 10, 'store', { createdAt: '2026-10-02T00:00:00Z' })))
      .toThrow(/different lot/u);
    const promo = {
      ...grant('le-promo', 3), origin: { channel: 'promotion' as const, store: 'promo', titleId: 'title-a' },
    };
    wallet.creditFromGrant(promo);
    expect(() => wallet.creditFromGrant(promo, { explicit: { kind: 'cross-title' } })).toThrow(/different lot/u);
    expect(() => wallet.creditFromGrant({ ...grant('le-2', 1), currency: 'other' })).toThrow(TypeError);
    expect(() => wallet.creditFromGrant({ ...grant('le-3', 1), extra: true } as never)).toThrow();
    expect(() => createInMemoryCreditWallet({ store: 'wallet', currencies: [' padded'] })).toThrow(TypeError);
    expect(() => createInMemoryCreditWallet({ store: '', currencies: [currency] })).toThrow(TypeError);
    expect(() => createInMemoryCreditWallet({
      store: 'wallet', currencies: [currency], creditScope: { 'google-play': 'cross-title' },
    })).toThrow(RangeError);
    expect(() => createInMemoryCreditWallet({ store: 'wallet', currencies: [currency], maxRenewalsPerTick: 0 }))
      .toThrow(TypeError);
    expect(() => createInMemoryCreditWallet({
      store: 'wallet', currencies: [currency], offers: [{ ...packOffer, price: { currency: 'other', amount: 1 } }],
    })).toThrow(TypeError);
    expect(() => createInMemoryCreditWallet({
      store: 'wallet', currencies: [currency], offers: [{ ...packOffer, kind: 'subscription' }],
    })).toThrow(TypeError);
  });

  it('applies the wallet credit scope registry to credited lots', () => {
    const wallet = createInMemoryCreditWallet({
      store: 'wallet', currencies: [currency], creditScope: { 'fixture.store': 'cross-title' },
    });
    expect(wallet.creditFromGrant(grant('le-1', 10)).spendScope).toEqual({ kind: 'cross-title' });
  });

  it('prices spends by its offers and keeps them idempotent by key', async () => {
    const wallet = createWallet();
    wallet.creditFromGrant(grant('le-1', 10));
    const spend = { titleId: 'title-a', currency, amount: 4, idempotencyKey: 'op-1', logicalId: 'booster' };
    const first = await wallet.spend(spend);
    expect(first).toEqual({
      status: 'debited',
      entitlementId: 'op-1',
      debits: [{ lotId: 'le-1', amount: 4 }],
      createdAt: '2026-10-01T00:00:00Z',
    });
    expect(await wallet.spend(spend)).toEqual({ ...first, alreadyProcessed: true });
    expect(await wallet.spend({ ...spend, amount: 8 })).toMatchObject({
      status: 'rejected', error: { code: 'INVALID_RESPONSE' },
    });
    expect(await wallet.spend({ ...spend, idempotencyKey: 'membership:op-1:0' })).toMatchObject({
      status: 'rejected', error: { code: 'INVALID_RESPONSE' },
    });
    expect(await wallet.spend({ ...spend, idempotencyKey: '' })).toMatchObject({ status: 'rejected' });
    expect(await wallet.spend({ ...spend, idempotencyKey: 'op-2', titleId: '' })).toMatchObject({ status: 'rejected' });
    // Under-priced, mis-priced, foreign-currency, and unknown offers mint nothing.
    expect(await wallet.spend({ ...spend, idempotencyKey: 'op-3', amount: 1 })).toMatchObject({
      status: 'rejected', error: { code: 'ITEM_UNAVAILABLE' },
    });
    expect(await wallet.spend({ ...spend, idempotencyKey: 'op-4', amount: 6 })).toMatchObject({
      status: 'rejected', error: { code: 'ITEM_UNAVAILABLE' },
    });
    expect(await wallet.spend({ ...spend, idempotencyKey: 'op-5', currency: 'other' })).toMatchObject({
      status: 'rejected', error: { code: 'ITEM_UNAVAILABLE' },
    });
    expect(await wallet.spend({ ...spend, idempotencyKey: 'op-6', logicalId: 'sword' })).toMatchObject({
      status: 'rejected', error: { code: 'ITEM_UNAVAILABLE' },
    });
    expect(wallet.debits).toEqual([{ idempotencyKey: 'op-1', lotId: 'le-1', amount: 4 }]);
    expect(wallet.entitlements).toHaveLength(1);
    // A rejected spend is not remembered: the same key succeeds once the balance allows it.
    expect(await wallet.spend({ ...spend, idempotencyKey: 'op-7', amount: 8 })).toMatchObject({
      status: 'rejected', error: { code: 'INSUFFICIENT_BALANCE' },
    });
    wallet.creditFromGrant(grant('le-2', 5));
    expect(await wallet.spend({ ...spend, idempotencyKey: 'op-7', amount: 8 })).toMatchObject({
      status: 'debited', debits: [{ lotId: 'le-1', amount: 6 }, { lotId: 'le-2', amount: 2 }],
    });
    // A spend without a logical id is a plain debit without an entitlement.
    expect(await wallet.spend({ titleId: 'title-a', currency, amount: 1, idempotencyKey: 'op-8' }))
      .toMatchObject({ status: 'debited' });
    expect(wallet.entitlements).toHaveLength(2);
    expect(wallet.offers.map((offer) => offer.logicalId)).toEqual(['booster', 'membership_plus']);
    wallet.addOffers([{ ...packOffer, price: { currency, amount: 5 } }]);
    expect(wallet.offers[0]?.price.amount).toBe(5);
  });

  it('starts a membership from a spend of a membership offer and keeps its key idempotent across paths', async () => {
    let at = '2026-10-01T00:00:00Z';
    const wallet = createWallet({ now: () => at });
    wallet.creditFromGrant(grant('le-title', 100));
    wallet.creditFromGrant(grant('le-web', 65, 'off-store'));
    const spend = { titleId: 'title-a', currency, amount: 30, idempotencyKey: 'op-1', logicalId: 'membership_plus' };
    const started = await wallet.spend(spend);
    expect(started).toEqual({
      status: 'debited',
      entitlementId: 'membership:op-1:0',
      debits: [{ lotId: 'le-web', amount: 30 }],
      createdAt: '2026-10-01T00:00:00Z',
    });
    expect(await wallet.spend(spend)).toEqual({ ...started, alreadyProcessed: true });
    // The same key cannot be reused for a plain spend with other parameters.
    expect(await wallet.spend({ ...spend, logicalId: 'booster', amount: 4 })).toMatchObject({
      status: 'rejected', error: { code: 'INVALID_RESPONSE' },
    });
    expect(await wallet.spend({ ...spend, idempotencyKey: 'op-2', amount: 29 })).toMatchObject({
      status: 'rejected', error: { code: 'ITEM_UNAVAILABLE' },
    });
    expect(await wallet.spend({ ...spend, idempotencyKey: 'op-3', amount: 60 })).toMatchObject({
      status: 'rejected', error: { code: 'ITEM_UNAVAILABLE' },
    });
    expect(await wallet.startMembership({
      subscriptionId: 'op-1', titleId: 'title-a', logicalId: 'membership_plus', terms: membershipTerms,
    })).toMatchObject({ status: 'started', alreadyProcessed: true, entitlementId: 'membership:op-1:0' });
    // A subscription id already started with other terms, title, or product is refused.
    for (const variant of [
      { titleId: 'title-b' },
      { logicalId: 'other_membership' },
      { terms: { ...membershipTerms, scope: 'title' as const } },
      { terms: { ...membershipTerms, period: 'P7D' } },
      { terms: { ...membershipTerms, price: { currency, amount: 1 } } },
    ]) {
      expect(await wallet.startMembership({
        subscriptionId: 'op-1', titleId: 'title-a', logicalId: 'membership_plus', terms: membershipTerms, ...variant,
      })).toMatchObject({ status: 'rejected', error: { code: 'INVALID_RESPONSE' } });
    }
    expect(await wallet.startMembership({
      subscriptionId: 'op-x', titleId: 'title-a', logicalId: 'membership_plus',
      terms: { ...membershipTerms, period: '30D' },
    })).toMatchObject({ status: 'rejected', error: { code: 'ITEM_UNAVAILABLE' } });
    expect(await wallet.startMembership({
      subscriptionId: 'op-y', titleId: 'title-a', logicalId: 'membership_plus',
      terms: { ...membershipTerms, scope: 'everywhere' as 'title' },
    })).toMatchObject({ status: 'rejected', error: { code: 'INVALID_RESPONSE' } });
    expect(wallet.debits).toHaveLength(1);
    expect(await wallet.getActiveSubscriptions({ titleId: 'title-b' })).toMatchObject([{ subscriptionId: 'op-1' }]);

    at = '2026-10-31T00:00:00Z';
    await wallet.renewDue();
    await wallet.renewDue('2026-10-31T00:00:00Z');
    expect(wallet.debits).toEqual([
      { idempotencyKey: 'membership:op-1:0', lotId: 'le-web', amount: 30 },
      { idempotencyKey: 'membership:op-1:1', lotId: 'le-web', amount: 30 },
    ]);
    await wallet.renewDue('2026-12-01T00:00:00Z');
    expect(wallet.subscriptionEvents.map((event) => event.eventId)).toEqual([
      'op-1:0:subscriptionStarted', 'op-1:1:subscriptionRenewed', 'op-1:2:subscriptionLapsed',
    ]);
    expect(wallet.subscriptionEvents[2]).toMatchObject({
      reason: 'INSUFFICIENT_BALANCE', expiresAt: '2026-11-30T00:00:00Z',
    });
    expect(await wallet.getActiveSubscriptions()).toEqual([]);
    // The title lot never funded the platform membership. After the lapse the
    // purchase key still replays its original answer, nothing is charged, and
    // the lapsed id cannot be restarted.
    expect(wallet.lots.map((entry) => [entry.lotId, entry.remaining])).toEqual([['le-title', 100], ['le-web', 5]]);
    expect(await wallet.spend(spend)).toEqual({ ...started, alreadyProcessed: true });
    expect(await wallet.startMembership({
      subscriptionId: 'op-1', titleId: 'title-a', logicalId: 'membership_plus', terms: membershipTerms,
    })).toMatchObject({ status: 'started', alreadyProcessed: true, subscription: { state: 'lapsed', periodIndex: 1 } });
    expect(wallet.debits).toHaveLength(2);
    expect(await wallet.getActiveSubscriptions()).toEqual([]);
    expect(await wallet.getBalance({ titleId: 'title-a' })).toEqual({ titleId: 'title-a', balances: { [currency]: 105 } });
  });

  it('refuses a client key that an owner-started membership already uses', async () => {
    const wallet = createWallet();
    wallet.creditFromGrant(grant('le-web', 100, 'off-store'));
    expect(await wallet.startMembership({
      subscriptionId: 'owner-1', titleId: 'title-a', logicalId: 'membership_plus', terms: membershipTerms,
    })).toMatchObject({ status: 'started' });
    for (const reuse of [
      { titleId: 'title-a', currency, amount: 1, idempotencyKey: 'owner-1' },
      { titleId: 'title-a', currency, amount: 4, idempotencyKey: 'owner-1', logicalId: 'booster' },
    ]) {
      expect(await wallet.spend(reuse)).toMatchObject({ status: 'rejected', error: { code: 'INVALID_RESPONSE' } });
    }
    // The same membership through the client key replays the owner's start without charging.
    expect(await wallet.spend({
      titleId: 'title-a', currency, amount: 30, idempotencyKey: 'owner-1', logicalId: 'membership_plus',
    })).toMatchObject({ status: 'debited', entitlementId: 'membership:owner-1:0', alreadyProcessed: true });
    expect(wallet.debits).toEqual([{ idempotencyKey: 'membership:owner-1:0', lotId: 'le-web', amount: 30 }]);
    // And a client spend key cannot become a subscription id afterwards.
    await wallet.spend({ titleId: 'title-a', currency, amount: 4, idempotencyKey: 'client-1', logicalId: 'booster' });
    expect(await wallet.startMembership({
      subscriptionId: 'client-1', titleId: 'title-a', logicalId: 'membership_plus', terms: membershipTerms,
    })).toMatchObject({ status: 'rejected', error: { code: 'INVALID_RESPONSE' } });
    expect(wallet.debits).toHaveLength(2);
  });

  it('judges renewal eligibility at each period boundary and caps the periods per tick', async () => {
    let at = '2026-01-01T00:00:00Z';
    const wallet = createWallet({ now: () => at, maxRenewalsPerTick: 2 });
    wallet.creditFromGrant(grant('g1', 100, 'off-store', { expiresAt: '2026-01-20T00:00:00Z', createdAt: at }));
    wallet.creditFromGrant(grant('g2', 5, 'off-store', { createdAt: at }));
    const terms = { scope: 'platform' as const, price: { currency, amount: 10 }, period: 'P30D' };
    expect(await wallet.startMembership({
      subscriptionId: 's-1', titleId: 'title-a', logicalId: 'membership_plus', terms,
    })).toMatchObject({ status: 'started', debits: [{ lotId: 'g1', amount: 10 }] });
    // A catch-up tick after downtime: g1 expired before period 1 began, so only g2 is eligible.
    await wallet.renewDue('2026-02-05T00:00:00Z');
    expect(wallet.subscriptionEvents.map((event) => event.eventId)).toEqual([
      's-1:0:subscriptionStarted', 's-1:1:subscriptionLapsed',
    ]);
    expect(wallet.lots.map((entry) => entry.remaining)).toEqual([90, 5]);

    at = '2026-03-01T00:00:00Z';
    wallet.creditFromGrant(grant('g3', 100, 'off-store', { createdAt: at }));
    expect(await wallet.startMembership({
      subscriptionId: 's-2', titleId: 'title-a', logicalId: 'membership_plus', terms,
    })).toMatchObject({ status: 'started' });
    // Five periods are overdue; a tick charges at most two and the next tick continues.
    await wallet.renewDue('2026-08-01T00:00:00Z');
    expect(await wallet.getActiveSubscriptions()).toMatchObject([
      { subscriptionId: 's-2', periodIndex: 2, expiresAt: '2026-05-30T00:00:00Z' },
    ]);
    await wallet.renewDue('2026-08-01T00:00:00Z');
    expect(await wallet.getActiveSubscriptions()).toMatchObject([{ subscriptionId: 's-2', periodIndex: 4 }]);
    await wallet.renewDue('2026-08-01T00:00:00Z');
    expect(await wallet.getActiveSubscriptions()).toMatchObject([
      { subscriptionId: 's-2', periodIndex: 5, expiresAt: '2026-08-28T00:00:00Z' },
    ]);
    expect(new Set(
      wallet.debits.filter((debit) => debit.idempotencyKey.startsWith('membership:s-2:')).map((debit) => debit.idempotencyKey),
    ).size).toBe(6);
  });

  it('does not charge a period with credits granted after it ended', async () => {
    let at = '2026-01-01T00:00:00Z';
    const wallet = createWallet({ now: () => at });
    wallet.creditFromGrant(grant('g1', 10, 'off-store', { createdAt: at }));
    const terms = { scope: 'platform' as const, price: { currency, amount: 10 }, period: 'P30D' };
    await wallet.startMembership({ subscriptionId: 's-1', titleId: 'title-a', logicalId: 'membership_plus', terms });
    at = '2026-02-05T00:00:00Z';
    wallet.creditFromGrant(grant('g2', 100, 'off-store', { createdAt: '2026-02-01T00:00:00Z' }));
    // Period 1 ended on 01-31; g2 arrived on 02-01 and cannot fund it, so the membership lapsed.
    await wallet.renewDue();
    expect(wallet.subscriptionEvents.map((event) => event.eventId)).toEqual([
      's-1:0:subscriptionStarted', 's-1:1:subscriptionLapsed',
    ]);
    expect(wallet.lots.map((entry) => entry.remaining)).toEqual([0, 100]);
    // A present-time spend may use it.
    expect(await wallet.spend({ titleId: 'title-a', currency, amount: 1, idempotencyKey: 'op-1' }))
      .toMatchObject({ status: 'debited', debits: [{ lotId: 'g2', amount: 1 }] });
  });

  it('anchors renewals on the start date', async () => {
    const wallet = createWallet({ now: () => '2026-01-31T00:00:00Z' });
    wallet.creditFromGrant(grant('g1', 100, 'off-store', { createdAt: '2026-01-31T00:00:00Z' }));
    await wallet.startMembership({
      subscriptionId: 's-1', titleId: 'title-a', logicalId: 'membership_plus',
      terms: { scope: 'platform', price: { currency, amount: 10 }, period: 'P1M' },
    });
    await wallet.renewDue('2026-04-15T00:00:00Z');
    expect(wallet.subscriptionEvents.map((event) => event.expiresAt)).toEqual([
      '2026-02-28T00:00:00Z', '2026-03-31T00:00:00Z', '2026-04-30T00:00:00Z',
    ]);
  });

  it('scopes title memberships to their title, in reads and in events', async () => {
    const wallet = createWallet();
    const seenA: string[] = [];
    const seenB: string[] = [];
    const seenAll: string[] = [];
    wallet.creditFromGrant(grant('le-title', 20));
    wallet.creditFromGrant(grant('le-web', 60, 'off-store'));
    const terms = { scope: 'title' as const, price: { currency, amount: 10 }, period: 'P7D' };
    expect(await wallet.startMembership({ subscriptionId: 's-1', titleId: 'title-a', logicalId: 'membership_plus', terms }))
      .toMatchObject({ status: 'started', debits: [{ lotId: 'le-title', amount: 10 }] });
    // Events before any listener wait for a listener that can see them.
    wallet.subscribe((event) => seenB.push(describeEvent(event)), { titleId: 'title-b' });
    expect(seenB).toEqual([]);
    wallet.subscribe((event) => seenA.push(describeEvent(event)), { titleId: 'title-a' });
    expect(seenA).toEqual(['s-1:active:0']);
    wallet.subscribe((event) => seenAll.push(describeEvent(event)));
    expect(seenAll).toEqual([]);
    expect(await wallet.getActiveSubscriptions({ titleId: 'title-a' })).toHaveLength(1);
    expect(await wallet.getActiveSubscriptions({ titleId: 'title-b' })).toEqual([]);
    await wallet.startMembership({
      subscriptionId: 's-2', titleId: 'title-a', logicalId: 'membership_plus', terms: membershipTerms,
    });
    expect(seenA).toEqual(['s-1:active:0', 's-2:active:0']);
    expect(seenB).toEqual(['s-2:active:0']);
    expect(seenAll).toEqual(['s-2:active:0']);
    await wallet.renewDue('2026-10-08T00:00:00Z');
    expect(seenB).toEqual(['s-2:active:0']);
    expect(seenA).toEqual(['s-1:active:0', 's-2:active:0', 's-1:active:1']);
  });

  it('redeems an entitlement once, for the ledger entry that granted it', async () => {
    const wallet = createWallet();
    wallet.creditFromGrant(grant('le-1', 10));
    await wallet.spend({ titleId: 'title-a', currency, amount: 4, idempotencyKey: 'op-1', logicalId: 'booster' });
    expect(await wallet.listUnredeemed({ titleId: 'title-a' })).toMatchObject([{ entitlementId: 'op-1' }]);
    expect(await wallet.listUnredeemed({ titleId: 'title-b' })).toEqual([]);
    expect(await wallet.redeem({ entitlementId: 'op-1', ledgerEntryId: '' })).toEqual({ redeemed: false });
    expect(await wallet.redeem({ entitlementId: 'missing', ledgerEntryId: 'le-x' })).toEqual({ redeemed: false });
    expect(await wallet.listUnredeemed({ titleId: 'title-a' })).toHaveLength(1);
    expect(await wallet.redeem({ entitlementId: 'op-1', ledgerEntryId: 'le-x' })).toEqual({ redeemed: true });
    expect(await wallet.redeem({ entitlementId: 'op-1', ledgerEntryId: 'le-x' })).toEqual({ redeemed: true });
    expect(await wallet.redeem({ entitlementId: 'op-1', ledgerEntryId: 'le-y' })).toEqual({ redeemed: false });
    expect(await wallet.listUnredeemed({ titleId: 'title-a' })).toEqual([]);
  });

  it('excludes expired lots from balances and spends', async () => {
    let at = '2026-10-01T00:00:00Z';
    const wallet = createWallet({ now: () => at });
    wallet.creditFromGrant(grant('le-1', 10, 'store', { expiresAt: '2026-10-02T00:00:00Z' }));
    expect(await wallet.getBalance({ titleId: 'title-a' })).toEqual({ titleId: 'title-a', balances: { [currency]: 10 } });
    at = '2026-10-02T00:00:00Z';
    expect(await wallet.getBalance({ titleId: 'title-a' })).toEqual({ titleId: 'title-a', balances: { [currency]: 0 } });
    expect(await wallet.spend({ titleId: 'title-a', currency, amount: 1, idempotencyKey: 'op-1' }))
      .toMatchObject({ status: 'rejected', error: { code: 'INSUFFICIENT_BALANCE' } });
    expect(await wallet.spend({ titleId: 'title-a', currency: 'other', amount: 1, idempotencyKey: 'op-2' }))
      .toMatchObject({ status: 'rejected', error: { code: 'ITEM_UNAVAILABLE' } });
  });
});

function describeEvent(event: CommerceEvent): string {
  return event.type === 'subscriptionUpdated'
    ? `${event.subscription.subscriptionId}:${event.subscription.state}:${event.subscription.periodIndex}`
    : event.type;
}

interface ClientFixture {
  readonly client: CreditWalletClient;
  readonly wallet: InMemoryCreditWallet;
  readonly emit: (event: CommerceEvent) => void;
}

function createClientFixture(input: {
  readonly offers?: readonly CreditOffer[];
  readonly now?: () => string;
  readonly subscribe?: boolean;
  readonly activeSubscriptions?: boolean;
} = {}): ClientFixture {
  const wallet = createInMemoryCreditWallet({
    store: 'wallet',
    currencies: [currency],
    now: input.now ?? (() => '2026-10-01T00:00:00Z'),
    offers: input.offers ?? [packOffer, membershipOffer],
  });
  const listeners = new Set<(event: CommerceEvent) => void>();
  const client: CreditWalletClient = {
    store: wallet.store,
    listOffers: (request) => wallet.listOffers(request),
    spend: (request) => wallet.spend(request),
    listUnredeemed: (request) => wallet.listUnredeemed(request),
    redeem: (request) => wallet.redeem(request),
    getBalance: (request) => wallet.getBalance(request),
    ...(input.activeSubscriptions === false
      ? {}
      : {
          getActiveSubscriptions: (request: { readonly titleId: string }) =>
            wallet.getActiveSubscriptions(request),
        }),
    ...(input.subscribe === false
      ? {}
      : {
          subscribe(listener: (event: CommerceEvent) => void, request?: { readonly titleId?: string }) {
            listeners.add(listener);
            const stop = wallet.subscribe(listener, request);
            return () => {
              listeners.delete(listener);
              stop();
            };
          },
        }),
  };
  return {
    client,
    wallet,
    emit(event) {
      for (const listener of listeners) {
        listener(event);
      }
    },
  };
}

describe('createCreditCommerceProvider', () => {
  it('declares the RFC wallet profile and sells memberships only under host authority', async () => {
    const { client } = createClientFixture();
    const host = createCreditCommerceProvider(client, { titleId: 'title-a', billingAuthority: 'host' });
    const store = createCreditCommerceProvider(client, {
      titleId: 'title-a',
      billingAuthority: 'store',
      capabilities: { purchase: { subscription: true, quantity: true }, lifecycle: { finish: 'client' } },
    });
    expect(await host.getCapabilities()).toEqual({
      purchase: { consumable: true, durable: true, subscription: true, quantity: false },
      catalog: { products: true, offers: false, localizedPrice: false },
      lifecycle: { availablePurchases: true, pending: false, restore: true, events: true, finish: 'server' },
      authority: { evidence: 'adapter-settled', accountBinding: 'host' },
      availability: 'available',
    });
    expect(await host.getCapabilities()).not.toBe(await host.getCapabilities());
    expect(await store.getCapabilities()).toMatchObject({
      purchase: { subscription: false, quantity: true }, lifecycle: { finish: 'client' },
    });
    expect(createCreditCommerceCapabilities('host', {}, { subscriptions: false }).purchase.subscription).toBe(false);
    expect(createCreditCommerceCapabilities('host').purchase.subscription).toBe(false);
    expect(createCreditCommerceCapabilities('host', {}, { subscriptions: true }).purchase.subscription).toBe(true);
    // A client that cannot report active subscriptions cannot sell memberships either.
    const unreported = createCreditCommerceProvider(createClientFixture({ activeSubscriptions: false }).client, {
      titleId: 'title-a', billingAuthority: 'host',
    });
    expect((await unreported.getCapabilities()).purchase.subscription).toBe(false);
    expect(unreported.getActiveSubscriptions).toBeUndefined();
    expect((await unreported.fetchProducts({ type: 'all' })).map((product) => product.logicalId)).toEqual(['booster']);
    expect(await unreported.requestPurchase({ logicalId: 'membership_plus', idempotencyKey: 'op-1', source: 'shop' }))
      .toMatchObject({ outcome: 'failed', error: { code: 'ITEM_UNAVAILABLE' } });
    const silent = createCreditCommerceProvider(createClientFixture({ subscribe: false }).client, {
      titleId: 'title-a', billingAuthority: 'host',
    });
    expect((await silent.getCapabilities()).lifecycle.events).toBe(true);
    expect((await host.fetchProducts({ type: 'all' })).map((product) => product.logicalId))
      .toEqual(['booster', 'membership_plus']);
    expect(await host.fetchProducts({ type: 'subscription', logicalIds: ['membership_plus'] })).toEqual([{
      logicalId: 'membership_plus',
      store: 'wallet',
      storeSku: 'membership.plus',
      kind: 'subscription',
      title: 'Plus',
      description: 'Plus membership',
      price: { formatted: `30 ${currency}`, currencyCode: currency },
    }]);
    expect((await store.fetchProducts({ type: 'all' })).map((product) => product.logicalId)).toEqual(['booster']);
    expect(await store.fetchProducts({ type: 'in-app', logicalIds: ['membership_plus'] })).toEqual([]);
    expect(await store.requestPurchase({ logicalId: 'membership_plus', idempotencyKey: 'op-1', source: 'shop' }))
      .toMatchObject({ outcome: 'failed', error: { code: 'ITEM_UNAVAILABLE', retryable: false } });
    expect(await host.requestPurchase({ logicalId: 'missing', idempotencyKey: 'op-2', source: 'shop' }))
      .toMatchObject({ outcome: 'failed', error: { code: 'ITEM_UNAVAILABLE' } });
    expect(await host.requestPurchase({ logicalId: 'booster', idempotencyKey: 'op-3', source: 'shop', quantity: 2 }))
      .toMatchObject({ outcome: 'failed', error: { code: 'ITEM_UNAVAILABLE' } });
    expect(await host.requestPurchase({ logicalId: 'membership_plus', idempotencyKey: 'op-4', source: 'shop' }))
      .toMatchObject({ outcome: 'failed', error: { code: 'INSUFFICIENT_BALANCE', retryable: false } });
    expect(host.getActiveSubscriptions).toBeDefined();
    expect(() => createCreditCommerceProvider(client, { titleId: '', billingAuthority: 'host' })).toThrow(TypeError);
    expect(() => createCreditCommerceProvider(client, { titleId: 'title-a', billingAuthority: 'bank' as 'host' }))
      .toThrow(TypeError);
    expect(() => createCreditCommerceProvider({ ...client, store: '' }, { titleId: 'title-a', billingAuthority: 'host' }))
      .toThrow(TypeError);
  });

  it('answers a spend with an adapter-settled purchase whose evidence matches later reads', async () => {
    const { client, wallet } = createClientFixture({ now: () => '2026-10-03T00:00:00Z' });
    const provider = createCreditCommerceProvider(client, {
      titleId: 'title-a',
      billingAuthority: 'host',
      currencies: [currency],
      capabilities: { purchase: { quantity: true } },
      now: () => '2026-12-24T00:00:00Z',
    });
    wallet.creditFromGrant(grant('le-1', 5));
    wallet.creditFromGrant(grant('le-2', 40, 'off-store', { createdAt: '2026-10-02T00:00:00Z' }));
    const result = await provider.requestPurchase({ logicalId: 'booster', idempotencyKey: 'op-1', source: 'shop', quantity: 2 });
    expect(result).toEqual({
      outcome: 'purchased',
      purchase: {
        store: 'wallet',
        transactionId: 'op-1',
        storeSku: 'booster.1',
        logicalId: 'booster',
        quantity: 2,
        state: 'purchased',
        purchasedAt: '2026-10-03T00:00:00Z',
        token: 'op-1',
        evidence: {
          schema: 'credit-wallet.spend.v1',
          payload: {
            store: 'wallet',
            titleId: 'title-a',
            entitlementId: 'op-1',
            amount: 8,
            debits: '[{"lotId":"le-1","amount":5},{"lotId":"le-2","amount":3}]',
          },
        },
        accountBinding: { kind: 'host-identity' },
      },
    });
    expect((result as { readonly purchase: { readonly settlement?: unknown } }).purchase.settlement)
      .toBeUndefined();
    const membership = await provider.requestPurchase({ logicalId: 'membership_plus', idempotencyKey: 'op-2', source: 'shop' });
    expect(membership).toMatchObject({
      outcome: 'purchased',
      purchase: { transactionId: 'membership:op-2:0', quantity: 1 },
    });
    expect(await provider.requestPurchase({ logicalId: 'membership_plus', idempotencyKey: 'op-3', source: 'shop', quantity: 2 }))
      .toMatchObject({ outcome: 'failed', error: { code: 'ITEM_UNAVAILABLE' } });
    expect(await provider.getActiveSubscriptions?.()).toMatchObject([{ subscriptionId: 'op-2', state: 'active' }]);
    // Available means unredeemed, and every read of a transaction shows the
    // same purchase as the answer did: same evidence, same purchasedAt.
    const available = await provider.getAvailablePurchases({ includePending: true });
    expect(available).toEqual([
      (result as { readonly purchase: unknown }).purchase,
      (membership as { readonly purchase: unknown }).purchase,
    ]);
    const replay = await provider.requestPurchase({ logicalId: 'booster', idempotencyKey: 'op-1', source: 'shop', quantity: 2 });
    expect(replay).toEqual(result);
    expect(readCreditWalletSpendEvidence(available[0]!.evidence)).toMatchObject({
      debits: [{ lotId: 'le-1', amount: 5 }, { lotId: 'le-2', amount: 3 }],
    });
    expect(wallet.lots.map((entry) => entry.remaining)).toEqual([0, 7]);
    // Without a settlement time from the wallet, the provider clock stamps the
    // purchase once and keeps that stamp for every replay.
    let providerNow = '2026-12-24T00:00:00Z';
    const bare = createCreditCommerceProvider({
      ...client,
      async spend(request) {
        const answer = await wallet.spend(request);
        return answer.status === 'debited'
          ? { status: 'debited', entitlementId: answer.entitlementId, debits: answer.debits }
          : answer;
      },
    }, { titleId: 'title-a', billingAuthority: 'host', now: () => providerNow });
    expect(await bare.requestPurchase({ logicalId: 'booster', idempotencyKey: 'op-5', source: 'shop' }))
      .toMatchObject({ outcome: 'purchased', purchase: { purchasedAt: '2026-12-24T00:00:00Z' } });
    providerNow = '2026-12-25T00:00:00Z';
    expect(await bare.requestPurchase({ logicalId: 'booster', idempotencyKey: 'op-5', source: 'shop' }))
      .toMatchObject({ outcome: 'purchased', purchase: { purchasedAt: '2026-12-24T00:00:00Z' } });
  });

  it('does not purchase a tiny offer the wallet did not pay for', async () => {
    const dust: CreditOffer = {
      ...packOffer,
      logicalId: 'dust',
      storeSku: 'dust.1',
      price: { currency, amount: 1e-9 },
    };
    const { client, wallet } = createClientFixture({ offers: [dust] });
    const provider = createCreditCommerceProvider(client, {
      titleId: 'title-a',
      billingAuthority: 'host',
    });
    expect(await provider.requestPurchase({ logicalId: 'dust', idempotencyKey: 'op-empty', source: 'shop' }))
      .toMatchObject({ outcome: 'failed', error: { code: 'INSUFFICIENT_BALANCE', retryable: false } });
    expect(wallet.debits).toEqual([]);
    expect(wallet.entitlements).toEqual([]);
    const unpaid = createCreditCommerceProvider({
      ...client,
      async spend() {
        return {
          status: 'debited',
          entitlementId: 'op-unpaid',
          debits: [],
          createdAt: '2026-10-01T00:00:00Z',
        };
      },
    }, { titleId: 'title-a', billingAuthority: 'host' });
    expect(await unpaid.requestPurchase({ logicalId: 'dust', idempotencyKey: 'op-unpaid', source: 'shop' }))
      .toMatchObject({ outcome: 'failed', error: { code: 'INVALID_RESPONSE' } });
    wallet.creditFromGrant(grant('le-dust', 1e-9));
    expect(await provider.requestPurchase({ logicalId: 'dust', idempotencyKey: 'op-paid', source: 'shop' }))
      .toMatchObject({
        outcome: 'purchased',
        purchase: { transactionId: 'op-paid', quantity: 1 },
      });
    expect(wallet.debits).toEqual([{ idempotencyKey: 'op-paid', lotId: 'le-dust', amount: 1e-9 }]);
  });

  it('refuses a debited answer that does not add up to the price', async () => {
    const { client, wallet } = createClientFixture();
    wallet.creditFromGrant(grant('le-1', 10));
    const shortChanged = createCreditCommerceProvider({
      ...client,
      async spend(request) {
        return wallet.spend({ ...request, amount: 1, logicalId: undefined } as never);
      },
    }, { titleId: 'title-a', billingAuthority: 'host' });
    expect(await shortChanged.requestPurchase({ logicalId: 'booster', idempotencyKey: 'op-1', source: 'shop' }))
      .toMatchObject({ outcome: 'failed', error: { code: 'INVALID_RESPONSE' } });
    expect(await shortChanged.getAvailablePurchases()).toEqual([]);
  });

  it('does not purchase a large offer the wallet underpaid by one credit', async () => {
    const price = 1_000_000_000;
    const offer: CreditOffer = {
      ...packOffer,
      logicalId: 'vault',
      storeSku: 'vault.1',
      price: { currency, amount: price },
    };
    const { client } = createClientFixture({ offers: [offer] });
    const underpaid = createCreditCommerceProvider({
      ...client,
      async spend() {
        return {
          status: 'debited',
          entitlementId: 'op-short',
          debits: [{ lotId: 'le-short', amount: price - 1 }],
          createdAt: '2026-10-01T00:00:00Z',
        };
      },
    }, { titleId: 'title-a', billingAuthority: 'host' });
    expect(await underpaid.requestPurchase({ logicalId: 'vault', idempotencyKey: 'op-short', source: 'shop' }))
      .toMatchObject({ outcome: 'failed', error: { code: 'INVALID_RESPONSE' } });
    expect(await underpaid.getAvailablePurchases()).toEqual([]);
  });

  it('purchases a price paid by many fractional debits', async () => {
    const offer: CreditOffer = {
      ...packOffer,
      logicalId: 'tenths',
      storeSku: 'tenths.1',
      price: { currency, amount: 10 },
    };
    const { client } = createClientFixture({ offers: [offer] });
    const provider = createCreditCommerceProvider({
      ...client,
      async spend() {
        return {
          status: 'debited',
          entitlementId: 'op-tenths',
          debits: Array.from({ length: 100 }, (_, index) => ({ lotId: `tenth-${index}`, amount: 0.1 })),
          createdAt: '2026-10-01T00:00:00Z',
        };
      },
    }, { titleId: 'title-a', billingAuthority: 'host' });
    expect(await provider.requestPurchase({ logicalId: 'tenths', idempotencyKey: 'op-tenths', source: 'shop' }))
      .toMatchObject({ outcome: 'purchased', purchase: { transactionId: 'op-tenths' } });
  });

  it('does not purchase a subnormal offer paid at half price', async () => {
    const price = 2 * Number.MIN_VALUE;
    const offer: CreditOffer = {
      ...packOffer,
      logicalId: 'speck',
      storeSku: 'speck.1',
      price: { currency, amount: price },
    };
    const { client } = createClientFixture({ offers: [offer] });
    const provider = createCreditCommerceProvider({
      ...client,
      async spend() {
        return {
          status: 'debited',
          entitlementId: 'op-speck',
          debits: [{ lotId: 'le-speck', amount: Number.MIN_VALUE }],
          createdAt: '2026-10-01T00:00:00Z',
        };
      },
    }, { titleId: 'title-a', billingAuthority: 'host' });
    expect(await provider.requestPurchase({ logicalId: 'speck', idempotencyKey: 'op-speck', source: 'shop' }))
      .toMatchObject({ outcome: 'failed', error: { code: 'INVALID_RESPONSE' } });
  });

  it('redeems only with the ledger entry id of the grant', async () => {
    const { client, wallet } = createClientFixture();
    const redeem = vi.spyOn(client, 'redeem');
    const provider = createCreditCommerceProvider(client, { titleId: 'title-a', billingAuthority: 'host' });
    wallet.creditFromGrant(grant('le-1', 5));
    await provider.requestPurchase({ logicalId: 'booster', idempotencyKey: 'op-1', source: 'shop' });
    await expect(provider.finishTransaction!({ transactionId: 'op-1', ledgerEntryId: '', isConsumable: true }))
      .rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    await expect(provider.finishTransaction!({ transactionId: '', ledgerEntryId: 'le-grant', isConsumable: true }))
      .rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(redeem).not.toHaveBeenCalled();
    expect(await provider.finishTransaction!({ transactionId: 'op-1', ledgerEntryId: 'le-grant', isConsumable: true }))
      .toEqual({ finished: true });
    expect(redeem).toHaveBeenCalledWith({ entitlementId: 'op-1', ledgerEntryId: 'le-grant' });
    expect(await provider.finishTransaction!({ transactionId: 'op-1', ledgerEntryId: 'le-other', isConsumable: true }))
      .toEqual({ finished: false });
    expect(await provider.getAvailablePurchases()).toEqual([]);
  });

  it("forwards the title's wallet events and restore reads through the pre-listener buffer once", async () => {
    const { client, wallet, emit } = createClientFixture();
    const provider = createCreditCommerceProvider(client, { titleId: 'title-a', billingAuthority: 'host' });
    const other = createCreditCommerceProvider(client, { titleId: 'title-b', billingAuthority: 'host' });
    wallet.creditFromGrant(grant('le-1', 50, 'off-store'));
    wallet.creditFromGrant(grant('le-b', 50, 'store', { titleId: 'title-b' }));
    await provider.requestPurchase({ logicalId: 'membership_plus', idempotencyKey: 'op-1', source: 'shop' });
    await provider.requestPurchase({ logicalId: 'booster', idempotencyKey: 'op-2', source: 'shop' });
    await wallet.startMembership({
      subscriptionId: 's-b', titleId: 'title-b', logicalId: 'membership_plus',
      terms: { scope: 'title', price: { currency, amount: 10 }, period: 'P7D' },
    });
    await provider.restorePurchases?.();
    await provider.restorePurchases?.();
    const seen: string[] = [];
    const stop = provider.subscribe((event) => {
      seen.push(event.type === 'purchaseUpdated' ? `purchase:${event.purchase.transactionId}` : describeEvent(event));
    });
    expect(seen).toEqual(['op-1:active:0', 'purchase:membership:op-1:0', 'purchase:op-2']);
    const seenB: string[] = [];
    other.subscribe((event) => seenB.push(event.type === 'purchaseUpdated' ? 'purchase' : describeEvent(event)));
    expect(seenB).toEqual(['op-1:active:0', 's-b:active:0']);
    emit({ type: 'purchaseError', error: { code: 'NETWORK', retryable: true } });
    expect(seen).toHaveLength(4);
    stop();
    emit({ type: 'purchaseError', error: { code: 'NETWORK', retryable: true } });
    expect(seen).toHaveLength(4);
    // After dispose the client subscription is released; nothing is buffered or forwarded.
    const beforeDispose = [...seenB];
    other.dispose();
    await wallet.renewDue('2026-10-08T00:00:00Z');
    expect(seenB).toEqual(beforeDispose);
    expect(seen).toHaveLength(4);
  });

  it('keeps delivering when a listener throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { client, wallet, emit } = createClientFixture();
      const provider = createCreditCommerceProvider(client, { titleId: 'title-a', billingAuthority: 'host' });
      wallet.creditFromGrant(grant('le-web', 100, 'off-store'));
      const seen: string[] = [];
      provider.subscribe(() => {
        throw new Error('listener boom');
      });
      provider.subscribe((event) => seen.push(event.type));
      wallet.subscribe(() => {
        throw new Error('wallet listener boom');
      });
      emit({ type: 'purchaseError', error: { code: 'NETWORK', retryable: true } });
      await provider.requestPurchase({ logicalId: 'membership_plus', idempotencyKey: 'op-1', source: 'shop' });
      await provider.requestPurchase({ logicalId: 'booster', idempotencyKey: 'op-2', source: 'shop' });
      await expect(provider.restorePurchases?.()).resolves.toBeUndefined();
      expect(seen).toEqual(['purchaseError', 'subscriptionUpdated', 'purchaseUpdated', 'purchaseUpdated']);
      expect(warn).toHaveBeenCalledWith('Credit wallet commerce listener failed.', 'listener boom');
      expect(warn).toHaveBeenCalledWith('Credit wallet listener failed.', 'wallet listener boom');

      // A first subscriber that throws while the buffer drains still receives
      // every buffered event and still gets its unsubscribe handle.
      const late = createCreditCommerceProvider(client, { titleId: 'title-a', billingAuthority: 'host' });
      await late.restorePurchases?.();
      const drained: string[] = [];
      const stop = late.subscribe((event) => {
        drained.push(event.type);
        if (drained.length === 1) {
          throw new Error('drain boom');
        }
      });
      expect(typeof stop).toBe('function');
      expect(drained).toEqual(['purchaseUpdated', 'purchaseUpdated']);
      const lateWallet = createInMemoryCreditWallet({
        store: 'wallet', currencies: [currency], now: () => '2026-10-01T00:00:00Z', offers: [membershipOffer],
      });
      lateWallet.creditFromGrant(grant('le-web', 100, 'off-store'));
      await lateWallet.startMembership({
        subscriptionId: 's-a', titleId: 'title-a', logicalId: 'membership_plus',
        terms: { ...membershipTerms, scope: 'title' },
      });
      await lateWallet.startMembership({
        subscriptionId: 's-b', titleId: 'title-b', logicalId: 'membership_plus',
        terms: { ...membershipTerms, scope: 'title' },
      });
      const seenA: string[] = [];
      lateWallet.subscribe((event) => {
        seenA.push(describeEvent(event));
        throw new Error('title-a boom');
      }, { titleId: 'title-a' });
      const seenB: string[] = [];
      lateWallet.subscribe((event) => seenB.push(describeEvent(event)), { titleId: 'title-b' });
      expect(seenA).toEqual(['s-a:active:0']);
      expect(seenB).toEqual(['s-b:active:0']);
    } finally {
      warn.mockRestore();
    }
  });

  it('turns client failures and malformed answers into normalized errors without granting', async () => {
    const failing: CreditWalletClient = {
      store: 'wallet',
      async listOffers() {
        return [{ ...packOffer, price: { currency: 'undeclared', amount: 1 } }];
      },
      async spend() {
        throw new CommerceError('NETWORK');
      },
      async listUnredeemed() {
        return [{ entitlementId: 'e-1' }] as never;
      },
      async redeem() {
        throw new Error('wallet offline');
      },
      async getBalance() {
        return { titleId: 'title-a', balances: {} };
      },
      async getActiveSubscriptions() {
        return [{ subscriptionId: 's-1' }] as never;
      },
    };
    const declared = createCreditCommerceProvider(failing, { titleId: 'title-a', billingAuthority: 'host', currencies: [currency] });
    await expect(declared.fetchProducts({})).rejects.toMatchObject({ code: 'CONFIGURATION_REQUIRED' });
    const provider = createCreditCommerceProvider(failing, { titleId: 'title-a', billingAuthority: 'host' });
    expect(await provider.requestPurchase({ logicalId: 'booster', idempotencyKey: 'op-1', source: 'shop' }))
      .toMatchObject({ outcome: 'failed', error: { code: 'NETWORK', retryable: true } });
    // Recovery skips a malformed entitlement with a warning instead of hiding every purchase.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await provider.getAvailablePurchases()).toEqual([]);
      expect(warn).toHaveBeenCalledWith('Credit wallet entitlement skipped during recovery.', expect.any(String));
    } finally {
      warn.mockRestore();
    }
    await expect(provider.getActiveSubscriptions!()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    await expect(provider.finishTransaction!({ transactionId: 'e-1', ledgerEntryId: 'le-1', isConsumable: true }))
      .rejects.toMatchObject({ code: 'UNKNOWN', message: 'wallet offline' });

    const withOffers = (offers: readonly unknown[], spend: CreditWalletClient['spend']): CreditWalletClient => ({
      ...failing,
      async listOffers() {
        return offers as readonly CreditOffer[];
      },
      spend,
    });
    const rejectedSpend: CreditWalletClient['spend'] = async () => ({
      status: 'rejected', error: { code: 'USER_CANCELLED', retryable: false },
    });
    for (const offers of [
      [{ ...packOffer, membership: membershipTerms }],
      [{ ...packOffer, kind: 'subscription' }],
      [{ ...membershipOffer, membership: { ...membershipTerms, period: 'P0D' } }],
    ]) {
      const malformed = createCreditCommerceProvider(withOffers(offers, rejectedSpend), {
        titleId: 'title-a', billingAuthority: 'host',
      });
      await expect(malformed.fetchProducts({})).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    }
    const cancelled = createCreditCommerceProvider(withOffers([packOffer], rejectedSpend), {
      titleId: 'title-a', billingAuthority: 'host',
    });
    expect(await cancelled.requestPurchase({ logicalId: 'booster', idempotencyKey: 'op-1', source: 'shop' }))
      .toMatchObject({ outcome: 'cancelled' });
    const invalidSpend = createCreditCommerceProvider(
      withOffers([packOffer], async () => ({ status: 'debited', entitlementId: 'e-1' }) as never),
      { titleId: 'title-a', billingAuthority: 'host' },
    );
    expect(await invalidSpend.requestPurchase({ logicalId: 'booster', idempotencyKey: 'op-1', source: 'shop' }))
      .toMatchObject({ outcome: 'failed', error: { code: 'INVALID_RESPONSE' } });
  });

  it("lists only the title's unredeemed entitlements, under the logical id when the offer is gone", async () => {
    const { client, wallet } = createClientFixture({ offers: [packOffer] });
    const provider = createCreditCommerceProvider(client, { titleId: 'title-a', billingAuthority: 'host' });
    wallet.creditFromGrant(grant('le-1', 5));
    await wallet.spend({ titleId: 'title-a', currency, amount: 4, idempotencyKey: 'op-1', logicalId: 'booster' });
    wallet.addOffers([{ ...packOffer, logicalId: 'retired', storeSku: 'retired.1' }]);
    wallet.creditFromGrant(grant('le-2', 5, 'off-store'));
    await wallet.spend({ titleId: 'title-a', currency, amount: 4, idempotencyKey: 'op-2', logicalId: 'retired' });
    const foreign = createCreditCommerceProvider({
      ...client,
      async listOffers() {
        return [packOffer];
      },
      async listUnredeemed() {
        return [
          ...(await wallet.listUnredeemed({ titleId: 'title-a' })),
          {
            entitlementId: 'other', titleId: 'title-b', logicalId: 'booster', idempotencyKey: 'other',
            createdAt: '2026-10-01T00:00:00Z', debits: [{ lotId: 'le-1', amount: 4 }],
          },
        ];
      },
    }, { titleId: 'title-a', billingAuthority: 'host' });
    expect(await foreign.getAvailablePurchases()).toMatchObject([
      { transactionId: 'op-1', storeSku: 'booster.1', quantity: 1 },
      { transactionId: 'op-2', storeSku: 'retired', logicalId: 'retired', quantity: 1 },
    ]);
    expect(await provider.getAvailablePurchases()).toHaveLength(2);
  });

  it('reports the quantity bought at spend time and recovers past a bad offer', async () => {
    const { client, wallet } = createClientFixture();
    const provider = createCreditCommerceProvider(client, {
      titleId: 'title-a', billingAuthority: 'host', currencies: [currency], capabilities: { purchase: { quantity: true } },
    });
    wallet.creditFromGrant(grant('le-1', 20));
    await provider.requestPurchase({ logicalId: 'booster', idempotencyKey: 'op-1', source: 'shop', quantity: 2 });
    expect(await wallet.listUnredeemed({ titleId: 'title-a' })).toMatchObject([{ entitlementId: 'op-1', quantity: 2 }]);
    // A later price change does not rewrite what was bought.
    wallet.addOffers([{ ...packOffer, price: { currency, amount: 2 } }]);
    expect(await provider.getAvailablePurchases()).toMatchObject([{ transactionId: 'op-1', quantity: 2 }]);
    wallet.addOffers([{ ...packOffer, price: { currency, amount: 16 } }]);
    expect(await provider.getAvailablePurchases()).toMatchObject([{ transactionId: 'op-1', quantity: 2 }]);
    // A wallet that records no quantity falls back to the current price.
    const unrecorded = createCreditCommerceProvider({
      ...client,
      async listUnredeemed(request) {
        return (await wallet.listUnredeemed(request)).map((entitlement) =>
          Object.fromEntries(
            Object.entries(entitlement).filter(([key]) => key !== 'quantity'),
          ) as unknown as CreditEntitlement);
      },
    }, { titleId: 'title-a', billingAuthority: 'host' });
    expect(await unrecorded.getAvailablePurchases()).toMatchObject([{ transactionId: 'op-1', quantity: 1 }]);
    // One malformed or undeclared offer does not hide unredeemed purchases.
    const degraded = createCreditCommerceProvider({
      ...client,
      async listOffers() {
        return [
          { ...packOffer, kind: 'subscription' },
          { ...membershipOffer, logicalId: 'foreign_currency', price: { currency: 'other', amount: 1 } },
          packOffer,
        ] as readonly CreditOffer[];
      },
    }, { titleId: 'title-a', billingAuthority: 'host', currencies: [currency] });
    await expect(degraded.fetchProducts({})).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(await degraded.getAvailablePurchases()).toMatchObject([{ transactionId: 'op-1', storeSku: 'booster.1', quantity: 2 }]);
    await expect(degraded.restorePurchases?.()).resolves.toBeUndefined();
    // An offers outage does not hide unredeemed purchases either; they list under their logical id.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const offline = createCreditCommerceProvider({
        ...client,
        async listOffers() {
          throw new CommerceError('NETWORK');
        },
      }, { titleId: 'title-a', billingAuthority: 'host' });
      expect(await offline.getAvailablePurchases()).toMatchObject([{ transactionId: 'op-1', storeSku: 'booster', quantity: 2 }]);
      expect(warn).toHaveBeenCalledWith('Credit wallet offers unavailable during recovery.', expect.any(String));
    } finally {
      warn.mockRestore();
    }
  });
});

describe('wallet conformance vectors', () => {
  it('pass through createCreditCommerceProvider in the reference harness', async () => {
    expect(walletVectors.map((vector) => vector.vector)).toEqual([
      'credit-lot-title-scope', 'credit-membership-renewal', 'membership-store-billing-target',
    ]);
    const results = await runCommerceConformanceVectors(walletVectors);
    expect(results.map((result) => [result.vector, result.status, result.failures])).toEqual(
      walletVectors.map((vector) => [vector.vector, 'passed', []]),
    );
    const vector = walletVectors[0]!;
    const harness = createCommerceConformanceHarness({
      vector,
      profile: vector.profile,
      catalog: [{ logicalId: 'booster', kind: 'consumable', storeSku: 'booster.1' }],
      playerId: 'player-1',
      titleId: 'title-a',
      clock: createCommerceConformanceClock(),
      backend: createCommerceConformanceBackend(),
      journal: createCommerceConformanceJournal(),
    });
    harness.wallet!.creditFromGrant({
      ledgerEntryId: 'le-1', currency: 'credits', amount: 5,
      origin: { channel: 'store', store: 'fixture.client-token', titleId: 'title-a' }, createdAt: '2026-10-01T00:00:00Z',
    });
    expect(await harness.provider.requestPurchase({ logicalId: 'booster', idempotencyKey: 'op-1', source: 'shop' }))
      .toMatchObject({ outcome: 'purchased', purchase: { evidence: { schema: creditWalletSpendEvidenceSchema } } });
  });

  it('pass against a caller-supplied harness over the in-memory wallet', async () => {
    const results = await runCommerceConformanceVectors(walletVectors, {
      createProvider(context): CommerceConformanceHarness {
        const currencies = context.vector.wallet?.currencies ?? [];
        const defaultCurrency = currencies[0]!;
        const wallet = createInMemoryCreditWallet({
          store: context.profile.store,
          currencies,
          now: () => context.clock.now(),
          offers: context.catalog.map((entry): CreditOffer => ({
            logicalId: entry.logicalId,
            storeSku: entry.storeSku,
            kind: entry.kind,
            title: entry.logicalId,
            description: entry.storeSku,
            price: entry.membership?.price ?? { currency: defaultCurrency, amount: 1 },
            ...(entry.membership === undefined ? {} : { membership: entry.membership }),
          })),
        });
        const actor: CommerceConformanceWalletActor = {
          get lots() {
            return wallet.lots;
          },
          get debits() {
            return wallet.debits;
          },
          get subscriptionEvents() {
            return wallet.subscriptionEvents;
          },
          creditFromGrant: (fixture, options = {}) => wallet.creditFromGrant(
            fixture,
            options.spendScope === undefined ? {} : { explicit: options.spendScope },
          ),
          spend: (request) => wallet.spend(request),
          renewDue: () => wallet.renewDue(),
          getBalance: (request) => wallet.getBalance(request),
          getActiveSubscriptions: () => wallet.getActiveSubscriptions(),
          async finalize(request) {
            await wallet.redeem({ entitlementId: request.transactionId, ledgerEntryId: request.ledgerEntryId });
          },
        };
        const provider = createCreditCommerceProvider(wallet, {
          titleId: context.titleId,
          billingAuthority: context.vector.wallet?.billingAuthority ?? 'store',
          currencies,
          capabilities: {
            ...(context.profile.purchase === undefined ? {} : { purchase: context.profile.purchase }),
            ...(context.profile.lifecycle === undefined ? {} : { lifecycle: context.profile.lifecycle }),
            ...(context.profile.authority === undefined ? {} : { authority: context.profile.authority }),
          },
          now: () => context.clock.now(),
        });
        return { provider, wallet: actor };
      },
    });
    expect(results.map((result) => [result.vector, result.status, result.failures])).toEqual(
      walletVectors.map((vector) => [vector.vector, 'passed', []]),
    );
  });
});
