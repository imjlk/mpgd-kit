import type { ProductGrant } from '@mpgd/catalog';

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

export function assertEntitlementLedgerGrant(
  input: EntitlementLedgerGrant,
): EntitlementLedgerGrant {
  assertRecord(input, 'EntitlementLedgerGrant');
  assertNonEmptyString(input.playerId, 'playerId');
  assertNonEmptyString(input.grantId, 'grantId');
  assertLedgerSource(input.source);
  assertNonEmptyString(input.idempotencyKey, 'idempotencyKey');
  assertNonEmptyString(input.grantedAt, 'grantedAt');
  if (input.grant !== undefined) {
    assertProductGrant(input.grant);
  }
  assertPayload(input.payload);

  return input;
}

export function assertEntitlementLedgerResult(
  input: EntitlementLedgerResult,
): EntitlementLedgerResult {
  assertRecord(input, 'EntitlementLedgerResult');
  assertNonEmptyString(input.ledgerEntryId, 'ledgerEntryId');
  assertBoolean(input.alreadyProcessed, 'alreadyProcessed');

  return input;
}

export function assertProductGrantTransaction(
  input: ProductGrantTransaction,
): ProductGrantTransaction {
  assertRecord(input, 'ProductGrantTransaction');
  assertNonEmptyString(input.ledgerEntryId, 'ledgerEntryId');
  assertNonEmptyString(input.playerId, 'playerId');
  assertNonEmptyString(input.grantId, 'grantId');
  assertLedgerSource(input.source);
  assertNonEmptyString(input.idempotencyKey, 'idempotencyKey');
  assertNonEmptyString(input.grantedAt, 'grantedAt');
  if (input.grant !== undefined) {
    assertProductGrant(input.grant);
  }
  assertPayload(input.payload);

  return input;
}

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
  return createCompositeKey([grant.source, grant.playerId, grant.idempotencyKey]);
}

function createLedgerEntryId(grant: EntitlementLedgerGrant): string {
  return [
    'ledger',
    encodeIdSegment(grant.source),
    encodeIdSegment(grant.playerId),
    encodeIdSegment(grant.idempotencyKey),
  ].join('_');
}

function createCompositeKey(parts: readonly string[]): string {
  return JSON.stringify(parts);
}

function encodeIdSegment(value: string): string {
  return `${value.length}:${encodeURIComponent(value)}`;
}

function assertRecord(input: unknown, label: string): asserts input is Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error(`${label} must be an object.`);
  }
}

function assertNonEmptyString(input: unknown, label: string): asserts input is string {
  if (typeof input !== 'string' || input.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
}

function assertBoolean(input: unknown, label: string): asserts input is boolean {
  if (typeof input !== 'boolean') {
    throw new Error(`${label} must be a boolean.`);
  }
}

function assertFiniteNumber(input: unknown, label: string): asserts input is number {
  if (typeof input !== 'number' || !Number.isFinite(input)) {
    throw new Error(`${label} must be a finite number.`);
  }
}

function assertLedgerSource(input: unknown): asserts input is EntitlementLedgerSource {
  if (input !== 'purchase' && input !== 'ad_reward' && input !== 'admin') {
    throw new Error('source must be purchase, ad_reward, or admin.');
  }
}

function assertProductGrant(input: unknown): asserts input is ProductGrant {
  assertRecord(input, 'grant');

  if (input.type === 'currency') {
    if (input.currency !== 'coin' && input.currency !== 'gem') {
      throw new Error('grant.currency must be coin or gem.');
    }

    assertFiniteNumber(input.amount, 'grant.amount');
    return;
  }

  if (input.type === 'entitlement') {
    assertNonEmptyString(input.entitlement, 'grant.entitlement');
    return;
  }

  if (input.type === 'resource') {
    assertNonEmptyString(input.resource, 'grant.resource');
    assertFiniteNumber(input.amount, 'grant.amount');
    if (input.amount <= 0) {
      throw new Error('grant.amount must be greater than zero for a resource grant.');
    }
    return;
  }

  throw new Error('grant.type must be currency, entitlement, or resource.');
}

function assertPayload(input: unknown): asserts input is EntitlementLedgerPayload {
  assertRecord(input, 'payload');

  for (const [key, value] of Object.entries(input)) {
    const valueType = typeof value;

    if (valueType !== 'string' && valueType !== 'number' && valueType !== 'boolean') {
      throw new Error(`payload.${key} must be a string, number, or boolean.`);
    }
  }
}
