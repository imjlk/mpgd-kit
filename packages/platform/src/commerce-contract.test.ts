import typia, { type tags } from 'typia';
import { describe, expect, it } from 'vitest';

import type {
  CommerceDateTimeFormat,
  CommerceInt64,
  CommerceMinimum,
  CommerceMinLength,
  CommerceUint32,
} from './commerce-contract.js';
import { assertStorePurchase } from './commerce.js';

// Each pair declares the same shape once with the contract's structural tags
// and once with typia's own aliases. typia must validate both identically and
// render the same JSON Schema, so the contract module may stay typia-free.
interface ContractTagged {
  readonly text: string & CommerceMinLength<1>;
  readonly at: string & CommerceDateTimeFormat;
  readonly count: number & CommerceUint32 & CommerceMinimum<1>;
  readonly index: number & CommerceUint32;
  readonly micros: number & CommerceInt64;
}

interface TypiaTagged {
  readonly text: string & tags.MinLength<1>;
  readonly at: string & tags.Format<'date-time'>;
  readonly count: number & tags.Type<'uint32'> & tags.Minimum<1>;
  readonly index: number & tags.Type<'uint32'>;
  readonly micros: number & tags.Type<'int64'>;
}

const assertContract = typia.createAssertEquals<ContractTagged>();
const assertTypia = typia.createAssertEquals<TypiaTagged>();
const valid = { text: 'a', at: '2026-10-01T00:00:00Z', count: 1, index: 0, micros: -5 };

describe('commerce contract tags', () => {
  it('validate exactly like the typia aliases', () => {
    const invalid: readonly Partial<typeof valid>[] = [
      { text: '' },
      { at: 'yesterday' },
      { count: 0 },
      { count: 1.5 },
      { index: -1 },
      { micros: 0.5 },
    ];
    expect(assertContract(valid)).toEqual(valid);
    expect(assertTypia(valid)).toEqual(valid);
    for (const patch of invalid) {
      expect(() => assertContract({ ...valid, ...patch })).toThrow();
      expect(() => assertTypia({ ...valid, ...patch })).toThrow();
    }
  });

  it('render the same JSON Schema as the typia aliases', () => {
    const contract = typia.json.schemas<[ContractTagged]>();
    const reference = typia.json.schemas<[TypiaTagged]>();
    expect(JSON.stringify(contract).replaceAll('ContractTagged', 'Shape'))
      .toBe(JSON.stringify(reference).replaceAll('TypiaTagged', 'Shape'));
  });

  it('keep the published purchase validator strict', () => {
    const purchase = {
      store: 'google-play',
      transactionId: 'tx-1',
      storeSku: 'gems.small',
      quantity: 1,
      state: 'purchased',
      token: 'token',
      evidence: { schema: 'google-play.product-purchase.v2', payload: { purchaseToken: 'token' } },
    } as const;
    expect(assertStorePurchase(purchase)).toEqual(purchase);
    expect(() => assertStorePurchase({ ...purchase, token: '' })).toThrow();
    expect(() => assertStorePurchase({ ...purchase, quantity: 0 })).toThrow();
    expect(() => assertStorePurchase({ ...purchase, purchasedAt: 'soon' })).toThrow();
    expect(() => assertStorePurchase({ ...purchase, settlement: {} })).toThrow();
  });
});
