import type { GameServicesStore } from './server.js';
import {
  assertEntitlementLedgerRevocation,
  assertPurchaseLedgerStatusRequest,
  assertPurchaseLedgerStatusResponse,
  type EntitlementLedgerRevocation,
  type EntitlementRevocationTransaction,
  type ProductGrantTransaction,
  type PurchaseLedgerStatus,
  type PurchaseLedgerStatusRequest,
  type PurchaseLedgerStatusResponse,
} from './types.js';

/**
 * Ledger reads and the revocation write path over any `GameServicesStore`
 * (RFC "Revocation and expiry entries"). Kept apart from the transport module
 * so a notification handler can import it without the HTTP and oRPC
 * machinery.
 */

/** The D1 bound-parameter cap: every ledger read is issued in chunks of at most this many ids. */
export const ledgerReadChunkSize = 100;

export function chunkLedgerEntryIds(
  ledgerEntryIds: readonly string[],
  size = ledgerReadChunkSize,
): readonly (readonly string[])[] {
  const chunks: (readonly string[])[] = [];
  for (let index = 0; index < ledgerEntryIds.length; index += size) {
    chunks.push(ledgerEntryIds.slice(index, index + size));
  }
  return chunks;
}

/** The revocations reversing any of the given grants, read in chunks the store accepts. */
export async function findEntitlementRevocationsChunked(
  store: GameServicesStore,
  ledgerEntryIds: readonly string[],
): Promise<readonly EntitlementRevocationTransaction[]> {
  const read = store.findEntitlementRevocations;
  if (read === undefined || ledgerEntryIds.length === 0) {
    return [];
  }
  const revocations: EntitlementRevocationTransaction[] = [];
  for (const chunk of chunkLedgerEntryIds([...new Set(ledgerEntryIds)])) {
    revocations.push(...await read.call(store, { ledgerEntryIds: chunk }));
  }
  return revocations;
}

/** The grants with the given ids, through the store's batched read when it has one. */
export async function getEntitlementTransactionsChunked(
  store: GameServicesStore,
  ledgerEntryIds: readonly string[],
): Promise<ReadonlyMap<string, ProductGrantTransaction>> {
  const found = new Map<string, ProductGrantTransaction>();
  const unique = [...new Set(ledgerEntryIds)];
  const batched = store.getEntitlementTransactions;
  if (batched !== undefined) {
    for (const chunk of chunkLedgerEntryIds(unique)) {
      for (const transaction of await batched.call(store, chunk)) {
        found.set(transaction.ledgerEntryId, transaction);
      }
    }
    return found;
  }
  for (const ledgerEntryId of unique) {
    const transaction = await store.getEntitlementTransaction(ledgerEntryId);
    if (transaction !== undefined) {
      found.set(ledgerEntryId, transaction);
    }
  }
  return found;
}

/**
 * Whether each grant is still active or which `revoke` entry reversed it
 * (RFC "Revocation and expiry entries"): one status per requested id, in
 * request order. A store without revocation support answers `active` for
 * every grant it holds; an id that names no grant, or a grant of another
 * player than `playerId`, is `unknown`.
 */
export async function readPurchaseLedgerStatuses(
  store: GameServicesStore,
  input: PurchaseLedgerStatusRequest,
): Promise<PurchaseLedgerStatusResponse> {
  const request = assertPurchaseLedgerStatusRequest(input);
  const grants = await getEntitlementTransactionsChunked(store, request.ledgerEntryIds);
  const owned = [...grants.values()]
    .filter((grant) => request.playerId === undefined || grant.playerId === request.playerId)
    .map((grant) => grant.ledgerEntryId);
  const reversedBy = new Map<string, string>();
  for (const revocation of await findEntitlementRevocationsChunked(store, owned)) {
    if (!reversedBy.has(revocation.revokesLedgerEntryId)) {
      reversedBy.set(revocation.revokesLedgerEntryId, revocation.ledgerEntryId);
    }
  }
  const ownedSet = new Set(owned);
  const statuses: PurchaseLedgerStatus[] = request.ledgerEntryIds.map((ledgerEntryId) => {
    const by = reversedBy.get(ledgerEntryId);
    if (by !== undefined) {
      return { ledgerEntryId, status: 'reversed', reversedBy: by };
    }
    return { ledgerEntryId, status: ownedSet.has(ledgerEntryId) ? 'active' : 'unknown' };
  });
  return assertPurchaseLedgerStatusResponse({ statuses });
}

/** A revocation key reused for another grant than the one it first reversed. */
export class RevocationKeyConflictError extends Error {
  constructor() {
    super('Entitlement revocation idempotency key is bound to another grant.');
    this.name = 'RevocationKeyConflictError';
  }
}

export type RevokeEntitlementGrantResult =
  | { readonly status: 'revoked'; readonly ledgerEntryId: string; readonly alreadyProcessed: boolean }
  | { readonly status: 'grant_not_found' }
  | { readonly status: 'grant_mismatch' }
  /** The notification key already reversed another grant. */
  | { readonly status: 'key_conflict' }
  /** The notification's authority identity already reversed another grant. */
  | { readonly status: 'evidence_already_processed' };

/**
 * Appends a `revoke` entry for an earlier grant: the write path of store
 * notification handlers (a Play voided purchase, an App Store refund, an Apps
 * in Toss or Devvit refunded order). The grant must exist and belong to the
 * revocation's player; a store without `recordEntitlementRevocation` throws.
 * Replays of the same notification key, and a second revocation of one
 * grant, answer the first entry with `alreadyProcessed: true`; a key or
 * authority identity reused for another grant is a conflict, not a success.
 */
export async function revokeEntitlementGrant(
  store: GameServicesStore,
  input: EntitlementLedgerRevocation,
): Promise<RevokeEntitlementGrantResult> {
  const revocation = assertEntitlementLedgerRevocation(input);
  if (store.recordEntitlementRevocation === undefined) {
    throw new Error('This GameServicesStore does not record entitlement revocations.');
  }
  const grant = await store.getEntitlementTransaction(revocation.revokesLedgerEntryId);
  if (grant === undefined) {
    return { status: 'grant_not_found' };
  }
  if (grant.playerId !== revocation.playerId) {
    return { status: 'grant_mismatch' };
  }
  try {
    const result = await store.recordEntitlementRevocation(revocation);
    return {
      status: 'revoked',
      ledgerEntryId: result.ledgerEntryId,
      alreadyProcessed: result.alreadyProcessed,
    };
  } catch (error) {
    if (error instanceof RevocationKeyConflictError) {
      return { status: 'key_conflict' };
    }
    if (error instanceof Error && error.name === 'EvidenceAlreadyProcessedError') {
      return { status: 'evidence_already_processed' };
    }
    throw error;
  }
}

/** Whether a grant was reversed by a `revoke` entry; false on a store without revocations. */
export async function isEntitlementGrantReversed(
  store: GameServicesStore,
  ledgerEntryId: string,
): Promise<boolean> {
  const revocations = await findEntitlementRevocationsChunked(store, [ledgerEntryId]);
  return revocations.length > 0;
}

/**
 * The ledger's grants minus those a `revoke` entry reversed: the read an
 * entitlement or balance computation starts from (RFC "Revocation and expiry
 * entries": entitlement reads subtract reversed grants).
 */
export async function listActiveEntitlementTransactions(
  store: GameServicesStore,
  options: { readonly playerId?: string } = {},
): Promise<readonly ProductGrantTransaction[]> {
  const transactions = (await store.listEntitlementTransactions()).filter(
    (transaction) => options.playerId === undefined || transaction.playerId === options.playerId,
  );
  if (store.findEntitlementRevocations === undefined || transactions.length === 0) {
    return transactions;
  }
  const revocations = await findEntitlementRevocationsChunked(
    store,
    transactions.map((transaction) => transaction.ledgerEntryId),
  );
  const reversed = new Set(revocations.map((revocation) => revocation.revokesLedgerEntryId));
  return transactions.filter((transaction) => !reversed.has(transaction.ledgerEntryId));
}
