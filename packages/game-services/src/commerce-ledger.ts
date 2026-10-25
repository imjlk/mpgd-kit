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
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new RangeError('Ledger read chunk size must be a positive integer.');
  }
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
 * request order, for the grants of `playerId`. A store without revocation
 * support answers `active` for every grant it holds; an id that names no
 * grant, or a grant of another player, is `unknown`.
 */
export async function readPurchaseLedgerStatuses(
  store: GameServicesStore,
  input: PurchaseLedgerStatusRequest,
): Promise<PurchaseLedgerStatusResponse> {
  const request = assertPurchaseLedgerStatusRequest(input);
  const grants = await getEntitlementTransactionsChunked(store, request.ledgerEntryIds);
  const owned = [...grants.values()]
    .filter((grant) => grant.playerId === request.playerId)
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

/**
 * A transfer that cannot be written as asked (RFC "Restore transfers"): the
 * grant it moves was already reversed (a refund, or another transfer that
 * won the race), or the move's grant key or evidence id is taken by
 * another entry. Nothing was written.
 */
export class EntitlementTransferConflictError extends Error {
  constructor() {
    super('The entitlement transfer conflicts with an existing ledger entry.');
    this.name = 'EntitlementTransferConflictError';
  }
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
  return revokeEntitlementGrantAt(store, input, 0);
}

async function revokeEntitlementGrantAt(
  store: GameServicesStore,
  input: EntitlementLedgerRevocation,
  depth: number,
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
  if (revocation.reason === 'transfer') {
    throw new Error(
      'Transfers are written by recordEntitlementTransfer, not revokeEntitlementGrant.',
    );
  }
  try {
    const result = await store.recordEntitlementRevocation(revocation);
    if (result.alreadyProcessed && grant.source === 'purchase') {
      // The grant moved to another player (a restore transfer) before this
      // reversal: the store event is about the purchase, so it reverses the
      // grant that holds it now.
      const holder = await resolvePurchaseGrantHolder(store, grant);
      if (holder.grant.ledgerEntryId !== grant.ledgerEntryId && depth < maxPurchaseTransferChain) {
        return revokeEntitlementGrantAt(
          store,
          {
            ...revocation,
            playerId: holder.grant.playerId,
            revokesLedgerEntryId: holder.grant.ledgerEntryId,
          },
          depth + 1,
        );
      }
    }
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

/**
 * The purchase grant a provider verification id names (the
 * `evidenceVerificationId` the purchase verifier recorded), through the
 * store's index when it has one. Store notification handlers start here:
 * a refund names the store's transaction, never a ledger entry. A purchase
 * moved by restore transfers answers the grant that holds it now (RFC
 * "Restore transfers"); `followTransfers: false` answers the first grant.
 */
export async function findPurchaseGrantByEvidenceVerificationId(
  store: GameServicesStore,
  evidenceVerificationId: string,
  options: { readonly followTransfers?: boolean } = {},
): Promise<ProductGrantTransaction | undefined> {
  const grant = await findPurchaseGrantRecord(store, evidenceVerificationId);
  if (grant === undefined || options.followTransfers === false) {
    return grant;
  }
  return (await resolvePurchaseGrantHolder(store, grant)).grant;
}

/** Longest chain of moves one purchase may have; a longer one is a ledger error. */
export const maxPurchaseTransferChain = 1000;

/**
 * Where a purchase is now (RFC "Restore transfers"): `grant` holds it
 * unless `reversal` says otherwise. `transfers` are the `revoke` entries
 * (reason `transfer`) the purchase moved through from the first grant,
 * oldest first. `reversal` is the entry that reversed `grant`: a refund or
 * other reversal, or a transfer whose receiving grant cannot be read.
 */
export interface PurchaseGrantHolder {
  readonly grant: ProductGrantTransaction;
  readonly transfers: readonly EntitlementRevocationTransaction[];
  readonly reversal?: EntitlementRevocationTransaction;
}

/** Follows a purchase grant's transfers to the grant that holds the purchase now. */
export async function resolvePurchaseGrantHolder(
  store: GameServicesStore,
  first: ProductGrantTransaction,
): Promise<PurchaseGrantHolder> {
  let grant = first;
  const transfers: EntitlementRevocationTransaction[] = [];
  const seen = new Set<string>([grant.ledgerEntryId]);
  for (let step = 0; step <= maxPurchaseTransferChain; step += 1) {
    const [reversal] = await findEntitlementRevocationsChunked(store, [grant.ledgerEntryId]);
    if (reversal === undefined) {
      return { grant, transfers };
    }
    const nextEvidence = reversal.payload.transferEvidenceVerificationId;
    const next = reversal.reason === 'transfer' && typeof nextEvidence === 'string'
      ? await findPurchaseGrantRecord(store, nextEvidence)
      : undefined;
    if (next === undefined || seen.has(next.ledgerEntryId)) {
      return { grant, transfers, reversal };
    }
    seen.add(next.ledgerEntryId);
    transfers.push(reversal);
    grant = next;
  }
  throw new Error('A purchase grant moved more often than maxPurchaseTransferChain.');
}

/**
 * The store verification id of the purchase a grant records: the
 * purchase's own id for a grant a restore transfer wrote (whose ledger
 * evidence id names the move), otherwise the grant's evidence id. A
 * finalizer (a Play acknowledge) is keyed by it.
 */
export function readPurchaseVerificationId(
  transaction: ProductGrantTransaction,
): string | undefined {
  const transferred = transaction.payload.transferOfEvidenceVerificationId;
  if (typeof transferred === 'string' && transferred.length > 0) {
    return transferred;
  }
  const recorded = transaction.evidenceVerificationId ?? transaction.payload.evidenceVerificationId;
  return typeof recorded === 'string' && recorded.length > 0 ? recorded : undefined;
}

/**
 * Whether a restore transfer wrote this grant (RFC "Restore transfers"): a
 * move from another player's grant, or a restore of a purchase no grant held
 * yet that the store bound to another player (`restoredAcrossAccounts`).
 */
export function isPurchaseTransferGrant(transaction: ProductGrantTransaction): boolean {
  const from = transaction.payload.transferredFromLedgerEntryId;
  return (typeof from === 'string' && from.length > 0)
    || transaction.payload.restoredAcrossAccounts === true;
}

/**
 * The evidence id of the `sequence`-th move of a purchase (1 for the first):
 * unique per move, so two concurrent moves of the same holder collide.
 */
export function createPurchaseTransferEvidenceVerificationId(
  purchaseVerificationId: string,
  sequence: number,
): string {
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new RangeError('A transfer sequence is a positive integer.');
  }
  return `mpgd-transfer:${String(sequence)}:${purchaseVerificationId}`;
}

async function findPurchaseGrantRecord(
  store: GameServicesStore,
  evidenceVerificationId: string,
): Promise<ProductGrantTransaction | undefined> {
  const grant = store.findEntitlementTransactionByEvidenceVerificationId === undefined
    ? (await store.listEntitlementTransactions()).find((transaction) => {
        return transaction.source === 'purchase'
          && (transaction.evidenceVerificationId
            ?? transaction.payload.evidenceVerificationId) === evidenceVerificationId;
      })
    : await store.findEntitlementTransactionByEvidenceVerificationId({
        source: 'purchase',
        evidenceVerificationId,
      });
  return grant?.source === 'purchase' ? grant : undefined;
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
