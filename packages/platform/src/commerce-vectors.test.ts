import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  assertCommerceConformanceVector,
  commerceConformanceVectorNameOf,
  isCommerceConformanceVector,
  type CommerceConformanceStep,
} from './commerce-vectors.js';
import { commerceProtocolVersion } from './commerce.js';

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
const reconcilerVectorsDir = join(vectorsDir, '..', 'reconciler-vectors');
const reconcilerVectorFiles = readdirSync(reconcilerVectorsDir)
  .filter((file) => file.endsWith('.json'))
  .sort();

function readVector(file: string, directory = vectorsDir): unknown {
  return JSON.parse(readFileSync(join(directory, file), 'utf8')) as unknown;
}

describe('commerce conformance vectors', () => {
  it('ships the fourteen RFC vectors', () => {
    expect(vectorFiles).toEqual([
      'adapter-settled.json',
      'cancelled-and-failed.json',
      'credit-lot-title-scope.json',
      'credit-membership-renewal.json',
      'event-before-listener.json',
      'finish-failure-retry.json',
      'membership-store-billing-target.json',
      'purchase-client-finish.json',
      'purchase-host-finish.json',
      'purchase-pending-then-purchased.json',
      'purchase-server-finish.json',
      'restart-before-verify.json',
      'revoked-after-grant.json',
      'server-push-settlement.json',
    ]);
  });

  it.each(vectorFiles)('%s validates and matches its file name', (file) => {
    const vector = assertCommerceConformanceVector(readVector(file));
    expect(vector.vector).toBe(commerceConformanceVectorNameOf(file));
    expect(vector.protocol).toBe(commerceProtocolVersion);
    expect(vector.steps.length).toBeGreaterThan(0);
  });

  it("ships the reconciler vectors (another account's purchase, the revoked finish)", () => {
    expect(reconcilerVectorFiles).toEqual([
      'another-account-http-parks.json',
      'another-account-legacy-rejected-parks.json',
      'another-account-orpc-parks.json',
      'another-account-owner-recovers.json',
      'another-account-restore-resends.json',
      'rejected-other-reason-ends.json',
      'revoked-refused-never-granted.json',
      'revoked-unfinished-after-grant.json',
      'revoked-without-record.json',
    ]);
  });

  it.each(reconcilerVectorFiles)('reconciler vector %s validates and matches its file name', (file) => {
    const vector = assertCommerceConformanceVector(readVector(file, reconcilerVectorsDir));
    expect(vector.vector).toBe(commerceConformanceVectorNameOf(file));
    expect(vector.protocol).toBe(commerceProtocolVersion);
    // Provider-independent scenarios: no provider runs them adaptively.
    expect(vector.profile.adaptive).toBeUndefined();
  });

  it('requires the ledger entry on every finish expectation except a revoked one', () => {
    const base = assertCommerceConformanceVector(
      readVector('revoked-unfinished-after-grant.json', reconcilerVectorsDir),
    );
    const withFinishCalls = (finishCalls: unknown): unknown => ({
      ...base,
      expect: { ...base.expect, finishCalls },
    });
    const call = { by: 'client', transactionId: 'tx-1', isConsumable: true, result: 'finished' };
    // An ordinary finish always names the grant's ledger entry.
    expect(isCommerceConformanceVector(withFinishCalls([call]))).toBe(false);
    expect(isCommerceConformanceVector(withFinishCalls([{ ...call, revoked: false }]))).toBe(false);
    expect(isCommerceConformanceVector(withFinishCalls([{ ...call, ledgerEntryId: 'le-1' }]))).toBe(true);
    // A revoked finish names the reversed grant, or none when nothing was granted.
    expect(isCommerceConformanceVector(withFinishCalls([{ ...call, revoked: true }]))).toBe(true);
    expect(isCommerceConformanceVector(withFinishCalls([
      { ...call, revoked: true, ledgerEntryId: 'le-1' },
    ]))).toBe(true);
    expect(isCommerceConformanceVector(withFinishCalls([
      { ...call, revoked: true, ledgerEntryId: '' },
    ]))).toBe(false);
  });

  it('rejects malformed another-account decisions and steps', () => {
    const base = assertCommerceConformanceVector(
      readVector('another-account-http-parks.json', reconcilerVectorsDir),
    );
    const withDecision = (decision: unknown): unknown => ({
      ...base,
      steps: [...base.steps, { actor: 'backend', action: 'queueVerify', decision }],
    });
    expect(isCommerceConformanceVector(withDecision({ status: 'another-account', transport: 'grpc' })))
      .toBe(false);
    expect(isCommerceConformanceVector(withDecision({ status: 'rejected', reason: '' }))).toBe(false);
    expect(isCommerceConformanceVector(withDecision({ status: 'bound-elsewhere' }))).toBe(false);
    // The binding mismatch is required, and only another account's answer has a wire shape.
    expect(isCommerceConformanceVector(withDecision({ status: 'another-account' }))).toBe(false);
    // A purchase bound to no account is never another account's: it stays rejected.
    expect(isCommerceConformanceVector(withDecision({
      status: 'another-account',
      reason: 'GOOGLE_PLAY_ACCOUNT_ID_MISSING',
    }))).toBe(false);
    expect(isCommerceConformanceVector(withDecision({
      status: 'another-account',
      reason: 'APP_STORE_ACCOUNT_TOKEN_MISMATCH',
    }))).toBe(true);
    expect(isCommerceConformanceVector(withDecision({ status: 'rejected', transport: 'http' })))
      .toBe(false);
    expect(isCommerceConformanceVector(withDecision({
      status: 'another-account',
      reason: 'GOOGLE_PLAY_ACCOUNT_MISMATCH',
      ledgerEntryId: 'le-1',
    }))).toBe(false);
    expect(isCommerceConformanceVector({
      ...base,
      steps: [...base.steps, { actor: 'runtime', action: 'switchPlayer' }],
    })).toBe(false);
    expect(isCommerceConformanceVector({
      ...base,
      expect: { ...base.expect, parked: { 'op-1': '' } },
    })).toBe(false);
  });

  it('covers every actor and action named by the RFC', () => {
    const seen = new Set<string>();
    for (const [directory, files] of [
      [vectorsDir, vectorFiles],
      [reconcilerVectorsDir, reconcilerVectorFiles],
    ] as const) {
      for (const file of files) {
        for (const step of assertCommerceConformanceVector(readVector(file, directory)).steps) {
          seen.add(`${step.actor}.${step.action}`);
        }
      }
    }
    const expected: readonly `${CommerceConformanceStep['actor']}.${CommerceConformanceStep['action']}`[] = [
      'runtime.start',
      'runtime.stop',
      'runtime.reconcile',
      'runtime.restore',
      'runtime.switchPlayer',
      'game.requestPurchase',
      'game.fetchProducts',
      'store.complete',
      'store.update',
      'store.error',
      'store.queueRequest',
      'store.queueFinish',
      'backend.queueVerify',
      'backend.push',
      'backend.revoke',
      'wallet.creditFromGrant',
      'wallet.spend',
      'wallet.renewDue',
      'clock.set',
    ];
    expect([...seen].sort()).toEqual([...expected].sort());
  });

  it('rejects unknown steps, unknown expectations, and bad fixtures', () => {
    const base = assertCommerceConformanceVector(readVector('purchase-client-finish.json'));
    expect(isCommerceConformanceVector(base)).toBe(true);
    expect(isCommerceConformanceVector({ ...base, vector: 'Purchase Client Finish' })).toBe(false);
    expect(isCommerceConformanceVector({ ...base, steps: [] })).toBe(false);
    expect(isCommerceConformanceVector({
      ...base,
      steps: [...base.steps, { actor: 'store', action: 'refund' }],
    })).toBe(false);
    expect(isCommerceConformanceVector({
      ...base,
      steps: [...base.steps, { actor: 'clock', action: 'set', at: 'tomorrow' }],
    })).toBe(false);
    expect(isCommerceConformanceVector({
      ...base,
      steps: [...base.steps, {
        actor: 'store', action: 'error', error: { code: 'USER_CANCELLED', storeCode: '1' },
      }],
    })).toBe(false);
    expect(isCommerceConformanceVector({ ...base, expect: { ...base.expect, refunds: [] } })).toBe(false);
    expect(isCommerceConformanceVector({
      ...base,
      expect: { ...base.expect, journal: { 'op-1': ['requested', 'done'] } },
    })).toBe(false);
    expect(isCommerceConformanceVector({
      ...base,
      catalog: [...(base.catalog ?? []), ...(base.catalog ?? [])],
    })).toBe(false);
    expect(isCommerceConformanceVector({ ...base, wallet: { currencies: [], billingAuthority: 'host' } }))
      .toBe(false);
  });

  it('derives the vector name from a path', () => {
    expect(commerceConformanceVectorNameOf('docs/specs/commerce/vectors/adapter-settled.json'))
      .toBe('adapter-settled');
    expect(commerceConformanceVectorNameOf('adapter-settled')).toBe('adapter-settled');
  });
});
