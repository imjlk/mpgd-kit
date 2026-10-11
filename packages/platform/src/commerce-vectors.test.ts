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

function readVector(file: string): unknown {
  return JSON.parse(readFileSync(join(vectorsDir, file), 'utf8')) as unknown;
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

  it('covers every actor and action named by the RFC', () => {
    const seen = new Set<string>();
    for (const file of vectorFiles) {
      for (const step of assertCommerceConformanceVector(readVector(file)).steps) {
        seen.add(`${step.actor}.${step.action}`);
      }
    }
    const expected: readonly `${CommerceConformanceStep['actor']}.${CommerceConformanceStep['action']}`[] = [
      'runtime.start',
      'runtime.stop',
      'runtime.reconcile',
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
