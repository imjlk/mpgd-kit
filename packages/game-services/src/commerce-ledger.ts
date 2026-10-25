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
    if (grant.source === 'purchase' && purchaseWideRevocationReasons.has(revocation.reason)) {
      // A store event (refund, chargeback, voided purchase) is about the
      // purchase: every player a verified restore shared it with loses it
      // too (RFC "Restore sharing"). Replays finish a fan-out an earlier
      // attempt left part-way. An admin entry stays on the grant it names.
      await revokeOtherPurchaseHolders(store, grant, revocation);
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
 * a refund names the store's transaction, never a ledger entry.
 */
export async function findPurchaseGrantByEvidenceVerificationId(
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

/** Longest run of holder slots one purchase may have; more is a ledger error. */
export const maxPurchaseHolderSlots = 10_000;

/**
 * Every grant of one purchase (RFC "Restore sharing"): `first`, the grant its
 * store verification id names, and `shared`, the grants verified restores
 * wrote for other players, in slot order. Slots are dense: a share is
 * written at `nextSlot`, the first free one, so two concurrent writers that
 * read the same holders collide on one evidence id and the holder cap holds.
 */
export interface PurchaseHolders {
  readonly first?: ProductGrantTransaction;
  readonly shared: readonly ProductGrantTransaction[];
  readonly nextSlot: number;
}

export async function listPurchaseHolders(
  store: GameServicesStore,
  purchaseVerificationId: string,
): Promise<PurchaseHolders> {
  const first = await findPurchaseGrantByEvidenceVerificationId(store, purchaseVerificationId);
  const shared: ProductGrantTransaction[] = [];
  for (let slot = 1; slot <= maxPurchaseHolderSlots; slot += 1) {
    const grant = await findPurchaseGrantByEvidenceVerificationId(
      store,
      createPurchaseHolderEvidenceVerificationId(purchaseVerificationId, slot),
    );
    if (grant === undefined) {
      return { ...(first === undefined ? {} : { first }), shared, nextSlot: slot };
    }
    shared.push(grant);
  }
  throw new Error('A purchase has more holder slots than maxPurchaseHolderSlots.');
}

/**
 * The evidence id of a purchase's `slot`-th shared grant (1 for the first
 * share): unique per slot, so a slot is written once.
 */
export function createPurchaseHolderEvidenceVerificationId(
  purchaseVerificationId: string,
  slot: number,
): string {
  if (!Number.isSafeInteger(slot) || slot < 1) {
    throw new RangeError('A holder slot is a positive integer.');
  }
  return `mpgd-holder:${String(slot)}:${purchaseVerificationId}`;
}

/**
 * The store verification id of the purchase a grant records: the purchase's
 * own id for a shared grant (whose ledger evidence id names its slot),
 * otherwise the grant's evidence id. Finalizers (a Play acknowledge) and
 * refunds are keyed by it.
 */
export function readPurchaseVerificationId(
  transaction: ProductGrantTransaction,
): string | undefined {
  const shared = transaction.payload.holderOfEvidenceVerificationId;
  if (typeof shared === 'string' && shared.length > 0) {
    return shared;
  }
  const recorded = transaction.evidenceVerificationId ?? transaction.payload.evidenceVerificationId;
  return typeof recorded === 'string' && recorded.length > 0 ? recorded : undefined;
}

/**
 * Whether a verified restore across players wrote this grant: a shared
 * grant, or a purchase's first grant written for a player the store did not
 * bind it to (`restoredAcrossAccounts`).
 */
export function isRestoredAcrossPlayers(transaction: ProductGrantTransaction): boolean {
  const shared = transaction.payload.holderOfEvidenceVerificationId;
  return (typeof shared === 'string' && shared.length > 0)
    || transaction.payload.restoredAcrossAccounts === true;
}

/** The revoke reasons a store event writes: they end the purchase for every holder. */
export const purchaseWideRevocationReasons: ReadonlySet<string> = new Set([
  'refund',
  'chargeback',
  'voided',
]);

/**
 * The store event (refund, chargeback, voided purchase) that ended a
 * purchase, read from its holders' revoke entries, the first grant's first;
 * undefined while the purchase is live. An `admin` entry ends one holder only.
 */
export async function findPurchaseWideRevocation(
  store: GameServicesStore,
  holders: readonly ProductGrantTransaction[],
): Promise<EntitlementRevocationTransaction | undefined> {
  const order = new Map(holders.map((holder, index) => [holder.ledgerEntryId, index]));
  return (await findEntitlementRevocationsChunked(store, holders.map((holder) => holder.ledgerEntryId)))
    .filter((entry) => purchaseWideRevocationReasons.has(entry.reason))
    .sort((left, right) =>
      (order.get(left.revokesLedgerEntryId) ?? 0) - (order.get(right.revokesLedgerEntryId) ?? 0))[0];
}

async function revokeOtherPurchaseHolders(
  store: GameServicesStore,
  named: ProductGrantTransaction,
  revocation: EntitlementLedgerRevocation,
): Promise<void> {
  const purchaseVerificationId = readPurchaseVerificationId(named);
  const record = store.recordEntitlementRevocation;
  if (purchaseVerificationId === undefined || record === undefined) {
    return;
  }
  const holders = await listPurchaseHolders(store, purchaseVerificationId);
  const others = [...(holders.first === undefined ? [] : [holders.first]), ...holders.shared]
    .filter((holder) => holder.ledgerEntryId !== named.ledgerEntryId);
  if (others.length === 0) {
    return;
  }
  const reversed = new Set(
    (await findEntitlementRevocationsChunked(store, others.map((holder) => holder.ledgerEntryId)))
      .map((entry) => entry.revokesLedgerEntryId),
  );
  for (const holder of others) {
    if (reversed.has(holder.ledgerEntryId)) {
      continue;
    }
    await record.call(store, {
      ...revocation,
      playerId: holder.playerId,
      revokesLedgerEntryId: holder.ledgerEntryId,
      // The store event's own identity names one entry; each holder's is
      // derived from it, so a replay finds the same entries.
      ...(revocation.evidenceVerificationId === undefined
        ? {}
        : { evidenceVerificationId: `${revocation.evidenceVerificationId}#${holder.ledgerEntryId}` }),
    });
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
