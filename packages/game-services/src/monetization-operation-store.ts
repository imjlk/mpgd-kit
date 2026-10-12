import { isTerminalCommercePurchaseState } from '@mpgd/platform/commerce';

import type {
  MonetizationOperationRecord,
  MonetizationOperationStore,
} from './monetization-recovery.js';

/**
 * Whether a journal record still needs a reconcile pass. A game's durable
 * `MonetizationOperationStore.listRecoverable` applies this rule (or an
 * equivalent index): a v1 purchase or rewarded-ad record is open until it
 * holds a non-pending result with no pending finalization; a commerce v2
 * purchase record is open until its state is terminal (`finished`,
 * `cancelled`, `failed`, `rejected`, `revoked`). Terminal records stay
 * addressable by `read` for duplicate protection.
 */
export function isMonetizationOperationRecoverable(record: MonetizationOperationRecord): boolean {
  if (record.kind === 'commerce-purchase') {
    return !isTerminalCommercePurchaseState(record.state);
  }
  if (record.result === undefined || record.result.status === 'pending') {
    return true;
  }
  return record.kind === 'purchase' && record.response?.finalization?.status === 'pending';
}

/** Whether a commerce v2 record holds a ledger grant the revocation pass should keep checking. */
export function isMonetizationOperationGranted(record: MonetizationOperationRecord): boolean {
  return record.kind === 'commerce-purchase'
    && record.ledgerEntryId !== undefined
    && (record.state === 'granted' || record.state === 'finishing' || record.state === 'finished');
}

/**
 * Session-only journal: the compare-and-swap semantics of a durable store
 * without the durability. It backs the commerce reconciler of a client that
 * was given no `operationStore`, and tests. It is not crash recovery: a game
 * supplies a durable, encrypted, access-controlled implementation.
 */
export function createInMemoryMonetizationOperationStore(): MonetizationOperationStore {
  const records = new Map<string, MonetizationOperationRecord>();
  const clone = (record: MonetizationOperationRecord): MonetizationOperationRecord =>
    structuredClone(record);
  return {
    async reserve(record) {
      const existing = records.get(record.key);
      if (existing !== undefined) {
        return { created: false, record: clone(existing) };
      }
      records.set(record.key, clone(record));
      return { created: true, record: clone(record) };
    },
    async read(key) {
      const record = records.get(key);
      return record === undefined ? undefined : clone(record);
    },
    async replace(expectedRevision, record) {
      const existing = records.get(record.key);
      if (
        existing === undefined
        || existing.revision !== expectedRevision
        || record.revision !== expectedRevision + 1
        || existing.playerId !== record.playerId
        || existing.target !== record.target
        || existing.kind !== record.kind
      ) {
        throw new Error('Stale or conflicting monetization journal write.');
      }
      records.set(record.key, clone(record));
    },
    async listRecoverable(playerId) {
      return [...records.values()]
        .filter((record) => record.playerId === playerId && isMonetizationOperationRecoverable(record))
        .map(clone);
    },
    async listGranted(playerId) {
      return [...records.values()]
        .filter((record) => record.playerId === playerId && isMonetizationOperationGranted(record))
        .map(clone);
    },
  };
}
