/** Wire messages between the bounded ZIP decode client and its worker.
 * Pure data; no runtime behavior so both sides can share the shapes. */
export const ARCHIVE_WORKER_PROTOCOL = 1;
export type ArchiveZipEntryMethod = 'store' | 'deflate';
export interface ArchiveWorkerExpectedEntry {
  readonly path: string;
  readonly method: ArchiveZipEntryMethod;
  readonly bytes: number;
  readonly sha256: string;
}
export interface ArchiveWorkerExpected {
  readonly formatVersion: number;
  readonly archive: {
    readonly bytes: number;
    readonly sha256: string;
  };
  readonly entries: readonly ArchiveWorkerExpectedEntry[];
}
export interface ArchiveWorkerLimits {
  readonly archiveBytes: number;
  readonly entryBytes: number;
  readonly totalExpandedBytes: number;
  readonly entryCount: number;
  readonly maxPathLength: number;
  readonly decodeDeadlineMs: number;
}
/** Numeric floors for every decode limit, shared by the worker core's
 * validation and the client's boundary guard so the two cannot drift; the
 * satisfies typing makes TypeScript reject a table that misses a newly
 * added limit field. */
export const ARCHIVE_LIMIT_MINIMUMS = {
  archiveBytes: 1,
  entryBytes: 1,
  totalExpandedBytes: 1,
  entryCount: 1,
  maxPathLength: 1,
  decodeDeadlineMs: 0,
} as const satisfies Record<keyof ArchiveWorkerLimits, number>;
/** First limit whose value is not a safe integer at or above its floor. */
export const invalidArchiveLimit = (
  limits: ArchiveWorkerLimits,
): { readonly name: keyof ArchiveWorkerLimits; readonly minimum: number } | undefined => {
  for (const name of Object.keys(ARCHIVE_LIMIT_MINIMUMS) as (keyof ArchiveWorkerLimits)[]) {
    const minimum = ARCHIVE_LIMIT_MINIMUMS[name];
    const value = limits[name];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
      return { name, minimum };
    }
  }
  return undefined;
};
/** Conservative starting bounds, not performance targets. */
export function defaultArchiveWorkerLimits(): ArchiveWorkerLimits {
  return {
    archiveBytes: 32 * 1024 * 1024,
    entryBytes: 32 * 1024 * 1024,
    totalExpandedBytes: 256 * 1024 * 1024,
    entryCount: 4096,
    maxPathLength: 512,
    decodeDeadlineMs: 15000,
  };
}
export interface ArchiveWorkerStats {
  readonly entries: number;
  readonly expandedBytes: number;
  readonly elapsedMs: number;
}
export type ArchiveWorkerRequest =
  | {
    readonly type: 'decode';
    readonly jobId: number;
    readonly protocol: number;
    readonly archive: ArrayBuffer;
    readonly transferArchive: boolean;
    readonly expected: ArchiveWorkerExpected;
    readonly limits: ArchiveWorkerLimits;
  }
  | {
    readonly type: 'release';
    readonly jobId: number;
    readonly seq: number;
  }
  | {
    readonly type: 'cancel';
    readonly jobId: number;
  };
export type ArchiveWorkerStatus = 'completed' | 'cancelled' | 'deadline' | 'error';
export type ArchiveWorkerResponse =
  | {
    readonly type: 'entry';
    readonly jobId: number;
    readonly seq: number;
    readonly path: string;
    readonly method: ArchiveZipEntryMethod;
    readonly bytes: ArrayBuffer;
  }
  | {
    readonly type: 'done';
    readonly jobId: number;
    readonly status: ArchiveWorkerStatus;
    readonly code?: string | undefined;
    readonly detail?: string | undefined;
    readonly archive?: ArrayBuffer | undefined;
    readonly stats: ArchiveWorkerStats;
  };
