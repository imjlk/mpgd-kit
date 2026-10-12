import {
  isMonetizationOperationGranted,
  isMonetizationOperationRecoverable,
  type MonetizationOperationRecord,
  type MonetizationOperationStore,
} from '@mpgd/game-services';
import type { StorageAdapter } from '@mpgd/platform';

/** The storage key the journal document lives under. */
export const defaultMonetizationJournalKey = 'mpgd:monetization-journal';
/** Terminal records older than this are dropped on the next write (30 days). */
export const defaultMonetizationJournalRetentionMs = 30 * 24 * 60 * 60 * 1000;
/**
 * At most this many terminal records without a ledger grant are kept (the
 * most recently settled): finished rewarded ads, cancelled, failed, and
 * rejected attempts. Platform storage bounds one value (the Devvit bridge
 * allows 256 KiB), so the document must not grow with every one of them.
 * Open records are never dropped, and granted purchases (`granted`,
 * `finishing`, `finished` with a ledger entry) leave only by age, so the
 * revocation pass and `findByTransaction` keep them for the whole window.
 */
export const defaultMonetizationJournalMaxTerminalRecords = 100;

export interface CreateStorageMonetizationOperationStoreInput {
  /** The platform storage adapter (`gateway.storage`); the host owns its durability. */
  readonly storage: StorageAdapter;
  /** Defaults to `mpgd:monetization-journal`. */
  readonly key?: string;
  /** Defaults to 30 days; `Infinity` keeps every terminal record within the count bound. */
  readonly retentionMs?: number;
  /** Defaults to 100 ungranted terminal records; `Infinity` keeps them all within the window. */
  readonly maxTerminalRecords?: number;
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
 * age (and, without a ledger grant, by count; open records are always kept),
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
    const terminal: [string, number][] = [];
    const kept: Record<string, MonetizationOperationRecord> = {};
    for (const [recordKey, record] of records) {
      const settledAt = terminalSettledAt(record);
      if (settledAt === undefined) {
        kept[recordKey] = record;
      } else if (settledAt < cutoff) {
        continue;
      } else if (isMonetizationOperationGranted(record)) {
        kept[recordKey] = record;
      } else {
        terminal.push([recordKey, settledAt]);
      }
    }
    // Newest first; the oldest terminal records beyond the bound are dropped.
    terminal.sort((left, right) => right[1] - left[1]);
    for (const [recordKey] of terminal.slice(0, Math.max(0, maxTerminalRecords))) {
      const record = records.get(recordKey);
      if (record !== undefined) {
        kept[recordKey] = record;
      }
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
