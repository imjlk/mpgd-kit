import typia from 'typia';

import type { ProductGrant } from '@mpgd/product-catalog';

export type PurchaseIdempotencyKey = string;
export type AdRewardIdempotencyKey = string;
export type EntitlementIdempotencyKey = PurchaseIdempotencyKey | AdRewardIdempotencyKey;

export type EntitlementLedgerSource = 'purchase' | 'ad_reward' | 'admin';
export type EntitlementLedgerPayload = Record<string, string | number | boolean>;

export interface EntitlementLedgerGrant {
  readonly playerId: string;
  readonly grantId: string;
  readonly source: EntitlementLedgerSource;
  readonly idempotencyKey: EntitlementIdempotencyKey;
  readonly grantedAt: string;
  readonly grant?: ProductGrant;
  readonly payload: EntitlementLedgerPayload;
}

export interface EntitlementLedgerResult {
  readonly ledgerEntryId: string;
  readonly alreadyProcessed: boolean;
}

export interface ProductGrantTransaction {
  readonly ledgerEntryId: string;
  readonly playerId: string;
  readonly grantId: string;
  readonly source: EntitlementLedgerSource;
  readonly idempotencyKey: EntitlementIdempotencyKey;
  readonly grantedAt: string;
  readonly grant?: ProductGrant;
  readonly payload: EntitlementLedgerPayload;
}

export interface EntitlementLedger {
  recordGrant(input: EntitlementLedgerGrant): EntitlementLedgerResult;
  getTransaction(ledgerEntryId: string): ProductGrantTransaction | undefined;
  listTransactions(): readonly ProductGrantTransaction[];
}

export const assertEntitlementLedgerGrant = typia.createAssert<EntitlementLedgerGrant>();
export const assertEntitlementLedgerResult = typia.createAssert<EntitlementLedgerResult>();
export const assertProductGrantTransaction = typia.createAssert<ProductGrantTransaction>();

export class InMemoryEntitlementLedger implements EntitlementLedger {
  private readonly transactionsByKey = new Map<string, ProductGrantTransaction>();
  private readonly transactionsById = new Map<string, ProductGrantTransaction>();

  recordGrant(input: EntitlementLedgerGrant): EntitlementLedgerResult {
    const grant = assertEntitlementLedgerGrant(input);
    const key = createIdempotencyIndexKey(grant);
    const existing = this.transactionsByKey.get(key);

    if (existing !== undefined) {
      return assertEntitlementLedgerResult({
        ledgerEntryId: existing.ledgerEntryId,
        alreadyProcessed: true,
      });
    }

    const transaction = createTransaction(grant);
    this.transactionsByKey.set(key, transaction);
    this.transactionsById.set(transaction.ledgerEntryId, transaction);

    return assertEntitlementLedgerResult({
      ledgerEntryId: transaction.ledgerEntryId,
      alreadyProcessed: false,
    });
  }

  getTransaction(ledgerEntryId: string): ProductGrantTransaction | undefined {
    return this.transactionsById.get(ledgerEntryId);
  }

  listTransactions(): readonly ProductGrantTransaction[] {
    return [...this.transactionsById.values()];
  }
}

export function createInMemoryEntitlementLedger(): InMemoryEntitlementLedger {
  return new InMemoryEntitlementLedger();
}

function createTransaction(grant: EntitlementLedgerGrant): ProductGrantTransaction {
  const baseTransaction = {
    ledgerEntryId: createLedgerEntryId(grant),
    playerId: grant.playerId,
    grantId: grant.grantId,
    source: grant.source,
    idempotencyKey: grant.idempotencyKey,
    grantedAt: grant.grantedAt,
    payload: grant.payload,
  };

  return assertProductGrantTransaction(
    grant.grant === undefined ? baseTransaction : { ...baseTransaction, grant: grant.grant },
  );
}

function createIdempotencyIndexKey(grant: EntitlementLedgerGrant): string {
  return `${grant.source}:${grant.playerId}:${grant.idempotencyKey}`;
}

function createLedgerEntryId(grant: EntitlementLedgerGrant): string {
  return [
    'ledger',
    grant.source,
    normalizeIdSegment(grant.playerId),
    normalizeIdSegment(grant.idempotencyKey),
  ].join('_');
}

function normalizeIdSegment(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9]+/g, '-').replaceAll(/^-|-$/g, '').slice(0, 48);
}
