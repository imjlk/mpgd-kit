import {
  isCommercePurchaseOperationRecord,
  isMonetizationOperationGranted,
  isMonetizationOperationRecoverable,
  isParkedForAnotherAccount,
  type MonetizationOperationRecord,
  type MonetizationOperationStore,
} from '@mpgd/game-services';
import type { StorageAdapter } from '@mpgd/platform';

/** The storage key the journal document lives under. */
export const defaultMonetizationJournalKey = 'mpgd:monetization-journal';
/** Terminal records older than this are dropped on the next write (30 days). */
export const defaultMonetizationJournalRetentionMs = 30 * 24 * 60 * 60 * 1000;
/**
 * At most this many terminal records without a ledger grant and without a
 * store transaction are kept (the most recently settled): finished rewarded
 * ads and cancelled or failed attempts the store never answered. Platform
 * storage bounds one value (the Devvit bridge allows 256 KiB), so the
 * document must not grow with every one of them. Open records are never
 * dropped; granted purchases (`granted`, `finishing`, `finished` with a
 * ledger entry) and purchases that still name a store transaction leave by
 * age, or by the byte budget (`defaultMonetizationJournalMaxDocumentBytes`)
 * when the document would not fit, so the revocation pass and
 * `findByTransaction` keep them for the window whenever storage allows.
 * Records parked as another account's purchase are the one kind of open
 * record that leaves (`defaultMonetizationJournalParkedRetentionMs`).
 */
export const defaultMonetizationJournalMaxTerminalRecords = 100;
/**
 * Records parked as another account's purchase (RFC "Another account's
 * purchase") leave this long after their last write (30 days): the parking,
 * or the player's last Restore Purchases resend. They are open records, but
 * nothing of their player is in progress: the backend granted and recorded
 * nothing for them, and the store still holds the purchase for the account it
 * is bound to, which recovers it under its own key. Dropping one costs at most
 * one more verify that parks it again, if the store still lists the purchase
 * and the client cannot tell its binding is another account's.
 */
export const defaultMonetizationJournalParkedRetentionMs = 30 * 24 * 60 * 60 * 1000;
/**
 * At most this many parked records are kept across every player of the
 * install, the most recently written first; the byte budget may drop parked
 * records before granted purchases.
 */
export const defaultMonetizationJournalMaxParkedRecords = 20;
/**
 * Upper bound of the serialized document (192 KiB, below the Devvit bridge's
 * 256 KiB per value). When the records in the window would exceed it, the
 * oldest terminal records leave first: ungranted ones without a store
 * transaction, then ungranted ones that still name a store transaction and
 * parked records, then granted purchases. Other open records are never dropped.
 */
export const defaultMonetizationJournalMaxDocumentBytes = 192 * 1024;

export interface CreateStorageMonetizationOperationStoreInput {
  /** The platform storage adapter (`gateway.storage`); the host owns its durability. */
  readonly storage: StorageAdapter;
  /** Defaults to `mpgd:monetization-journal`. */
  readonly key?: string;
  /** Defaults to 30 days; `Infinity` keeps every terminal record within the count bound. */
  readonly retentionMs?: number;
  /** Defaults to 100 ungranted terminal records; `Infinity` keeps them all within the window. */
  readonly maxTerminalRecords?: number;
  /** Defaults to 192 KiB of serialized JSON; see `defaultMonetizationJournalMaxDocumentBytes`. */
  readonly maxDocumentBytes?: number;
  /** Defaults to 30 days; see `defaultMonetizationJournalParkedRetentionMs`. */
  readonly parkedRetentionMs?: number;
  /** Defaults to 20 parked records; see `defaultMonetizationJournalMaxParkedRecords`. */
  readonly maxParkedRecords?: number;
  readonly now?: () => number;
  /**
   * Cross-context lock for the read-modify-write of the document; defaults to
   * the Web Locks API (`navigator.locks`) when the host has it, so two tabs or
   * PWA windows over the same storage cannot lose each other's writes. `null`
   * keeps only the in-context queue.
   */
  readonly locks?: JournalLockManager | null;
}

/** The part of the Web Locks API (`LockManager`) the journal uses. */
export interface JournalLockManager {
  request<T>(name: string, callback: (lock: unknown) => Promise<T>): Promise<T>;
}

interface JournalDocument {
  readonly version: 1;
  readonly records: Readonly<Record<string, MonetizationOperationRecord>>;
}

/**
 * The reference durable `MonetizationOperationStore` of the starter: one JSON
 * document in the platform storage adapter, rewritten whole on every change
 * so a record and its index can never disagree, terminal records bounded by
 * age (and, without a ledger grant, by count; open records are kept, except
 * records parked as another account's purchase, bounded by age and count),
 * with every operation
 * serialized through one promise chain so the compare-and-swap of `replace`
 * holds inside the WebView. It is crash recovery, not grant authority: the
 * backend ledger still decides every grant. The platform storage is the
 * host's; a game whose host cannot keep that storage private supplies an
 * encrypted, access-controlled implementation through
 * `bootstrapStarter({ monetization: { operationStore } })` instead.
 *
 * A document that cannot be parsed fails every call instead of being
 * replaced: silently starting over would let a purchase be verified twice.
 */
export function createStorageMonetizationOperationStore(
  input: CreateStorageMonetizationOperationStoreInput,
): MonetizationOperationStore {
  const key = input.key ?? defaultMonetizationJournalKey;
  const retentionMs = input.retentionMs ?? defaultMonetizationJournalRetentionMs;
  const maxTerminalRecords = input.maxTerminalRecords
    ?? defaultMonetizationJournalMaxTerminalRecords;
  const maxDocumentBytes = input.maxDocumentBytes ?? defaultMonetizationJournalMaxDocumentBytes;
  const parkedRetentionMs = input.parkedRetentionMs ?? defaultMonetizationJournalParkedRetentionMs;
  const maxParkedRecords = input.maxParkedRecords ?? defaultMonetizationJournalMaxParkedRecords;
  const now = input.now ?? (() => Date.now());
  const locks = input.locks === undefined ? readHostLockManager() : (input.locks ?? undefined);
  const lockName = `mpgd-monetization-journal:${key}`;
  let chain: Promise<unknown> = Promise.resolve();

  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const run = locks === undefined ? operation : () => locks.request(lockName, () => operation());
    const next = chain.then(run, run);
    chain = next.catch(() => undefined);
    return next;
  };

  const load = async (): Promise<Map<string, MonetizationOperationRecord>> => {
    const loaded = await input.storage.load({ key });
    if (loaded === null || loaded.value === undefined || loaded.value === null) {
      return new Map();
    }
    const document = loaded.value;
    if (!isJournalDocument(document)) {
      throw new Error(`Monetization journal at ${key} is unreadable; it was not replaced.`);
    }
    return new Map(Object.entries(document.records));
  };

  const save = async (records: Map<string, MonetizationOperationRecord>): Promise<void> => {
    const cutoff = now() - retentionMs;
    const parkedCutoff = now() - parkedRetentionMs;
    const terminal: [string, number][] = [];
    const parked: [string, number][] = [];
    const kept: Record<string, MonetizationOperationRecord> = {};
    /** Records the byte budget may drop, with their drop tier (lower leaves first). */
    const droppable: [string, number, number][] = [];
    for (const [recordKey, record] of records) {
      const parkedAt = parkedWrittenAt(record);
      if (parkedAt !== undefined) {
        // Another account's purchase: nothing of this player is in progress,
        // and the purchase's own account recovers it under its own key.
        if (parkedAt >= parkedCutoff) {
          parked.push([recordKey, parkedAt]);
        }
        continue;
      }
      const settledAt = terminalSettledAt(record);
      if (settledAt === undefined) {
        kept[recordKey] = record;
      } else if (settledAt < cutoff) {
        continue;
      } else if (isMonetizationOperationGranted(record)) {
        kept[recordKey] = record;
        droppable.push([recordKey, settledAt, 2]);
      } else if (holdsStoreTransaction(record)) {
        // A rejected or failed purchase the store still lists: the reconciler's
        // findByTransaction needs it, so the count bound does not drop it.
        kept[recordKey] = record;
        droppable.push([recordKey, settledAt, 1]);
      } else {
        terminal.push([recordKey, settledAt]);
      }
    }
    // Newest first: a parked record a Restore Purchases resend just rewrote is
    // the newest, so neither bound drops it while its answer is awaited.
    parked.sort((left, right) => right[1] - left[1]);
    for (const [recordKey, writtenAt] of parked.slice(0, Math.max(0, maxParkedRecords))) {
      const record = records.get(recordKey);
      if (record !== undefined) {
        kept[recordKey] = record;
        droppable.push([recordKey, writtenAt, 1]);
      }
    }
    // Newest first; the oldest terminal records beyond the bound are dropped.
    terminal.sort((left, right) => right[1] - left[1]);
    for (const [recordKey, settledAt] of terminal.slice(0, Math.max(0, maxTerminalRecords))) {
      const record = records.get(recordKey);
      if (record !== undefined) {
        kept[recordKey] = record;
        droppable.push([recordKey, settledAt, 0]);
      }
    }
    // The document must fit the host's per-value limit, or every later write
    // fails and monetization stops: the oldest record of the lowest tier leaves
    // until it fits. Open records other than parked ones are never dropped.
    droppable.sort((left, right) => left[2] - right[2] || left[1] - right[1]);
    let size = documentBytes(kept);
    for (const [recordKey] of droppable) {
      if (size <= maxDocumentBytes) {
        break;
      }
      delete kept[recordKey];
      size = documentBytes(kept);
    }
    const document: JournalDocument = { version: 1, records: kept };
    await input.storage.save({ key, value: document });
  };

  return {
    reserve(record) {
      return serialize(async () => {
        const records = await load();
        const existing = records.get(record.key);
        if (existing !== undefined) {
          return { created: false, record: clone(existing) };
        }
        records.set(record.key, clone(record));
        await save(records);
        return { created: true, record: clone(record) };
      });
    },
    read(recordKey) {
      return serialize(async () => {
        const record = (await load()).get(recordKey);
        return record === undefined ? undefined : clone(record);
      });
    },
    replace(expectedRevision, record) {
      return serialize(async () => {
        const records = await load();
        const existing = records.get(record.key);
        if (
          existing === undefined
          || existing.revision !== expectedRevision
          || record.revision !== expectedRevision + 1
          || existing.playerId !== record.playerId
          || existing.target !== record.target
          || existing.deploymentTarget !== record.deploymentTarget
          || existing.kind !== record.kind
        ) {
          throw new Error('Stale or conflicting monetization journal write.');
        }
        records.set(record.key, clone(record));
        await save(records);
      });
    },
    listRecoverable(playerId) {
      return serialize(async () =>
        [...(await load()).values()]
          .filter((record) => record.playerId === playerId
            && isMonetizationOperationRecoverable(record))
          .map(clone));
    },
    listGranted(playerId) {
      return serialize(async () =>
        [...(await load()).values()]
          .filter((record) => record.playerId === playerId
            && isMonetizationOperationGranted(record))
          .map(clone));
    },
    findByTransaction(lookup) {
      return serialize(async () => {
        const found = [...(await load()).values()].find(
          (record) =>
            record.kind === 'commerce-purchase'
            && record.playerId === lookup.playerId
            && record.target === lookup.target
            && record.deploymentTarget === lookup.deploymentTarget
            && record.store === lookup.store
            && record.purchase?.transactionId === lookup.transactionId,
        );
        return found === undefined ? undefined : clone(found);
      });
    },
  };
}

/**
 * When a terminal record settled, or `undefined` for an open record (never
 * dropped). A terminal record without a readable time sorts as the newest:
 * only the count bound drops it.
 */
function terminalSettledAt(record: MonetizationOperationRecord): number | undefined {
  if (isMonetizationOperationRecoverable(record)) {
    return undefined;
  }
  const settledAt = record.kind === 'commerce-purchase'
    ? record.updatedAt
    : record.platformCompletedAt;
  const time = settledAt === undefined ? Number.NaN : Date.parse(settledAt);
  return Number.isFinite(time) ? time : Number.MAX_SAFE_INTEGER;
}

/**
 * When a record parked as another account's purchase was last written (its
 * parking, or a Restore Purchases resend), or `undefined` for any other
 * record. A parked record without a readable time sorts as the newest: only
 * the count bound drops it.
 */
function parkedWrittenAt(record: MonetizationOperationRecord): number | undefined {
  if (!isCommercePurchaseOperationRecord(record) || !isParkedForAnotherAccount(record)) {
    return undefined;
  }
  const times = [record.updatedAt, record.anotherAccount?.reportedAt]
    .map((time) => (time === undefined ? Number.NaN : Date.parse(time)))
    .filter((time) => Number.isFinite(time));
  return times.length === 0 ? Number.MAX_SAFE_INTEGER : Math.max(...times);
}

/** A commerce purchase record that names a store transaction (the store may still list it). */
function holdsStoreTransaction(record: MonetizationOperationRecord): boolean {
  return record.kind === 'commerce-purchase' && record.purchase?.transactionId !== undefined;
}

/** UTF-8 size of the document the records serialize to. */
function documentBytes(records: Readonly<Record<string, MonetizationOperationRecord>>): number {
  return new TextEncoder().encode(JSON.stringify({ version: 1, records })).length;
}

function readHostLockManager(): JournalLockManager | undefined {
  const candidate = (globalThis as { readonly navigator?: { readonly locks?: unknown } })
    .navigator?.locks;
  return typeof candidate === 'object'
    && candidate !== null
    && typeof (candidate as { readonly request?: unknown }).request === 'function'
    ? candidate as JournalLockManager
    : undefined;
}

function isJournalDocument(value: unknown): value is JournalDocument {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const document = value as { readonly version?: unknown; readonly records?: unknown };
  return document.version === 1
    && typeof document.records === 'object'
    && document.records !== null
    && !Array.isArray(document.records)
    && Object.values(document.records).every(
      (record) => typeof record === 'object' && record !== null
        && typeof (record as { readonly key?: unknown }).key === 'string'
        && typeof (record as { readonly revision?: unknown }).revision === 'number',
    );
}

function clone(record: MonetizationOperationRecord): MonetizationOperationRecord {
  return structuredClone(record);
}
