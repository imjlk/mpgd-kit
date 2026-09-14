import { ZipDecodeError, type ZipDecodeFailureCode } from './archive-errors.js';
import {
  ARCHIVE_WORKER_PROTOCOL,
  defaultArchiveWorkerLimits,
  type ArchiveWorkerExpected,
  type ArchiveWorkerLimits,
  type ArchiveWorkerRequest,
  type ArchiveWorkerResponse,
  type ArchiveWorkerStats,
} from './archive-protocol.js';

export { ZipDecodeError } from './archive-errors.js';
export type { ZipDecodeFailureCode } from './archive-errors.js';
export type {
  ArchiveWorkerExpected,
  ArchiveWorkerExpectedEntry,
  ArchiveWorkerLimits,
  ArchiveWorkerStats,
  ArchiveWorkerStatus,
} from './archive-protocol.js';
export { defaultArchiveWorkerLimits } from './archive-protocol.js';
export type {
  ExpectedZipArchive,
  ExpectedZipEntry,
  ZipDecodeControl,
  ZipDecodeEntry,
  ZipDecodeLimits,
} from './archive-zip-core.js';

/**
 * Worker surface the decoder drives. A real `Worker` satisfies it; tests can
 * substitute an in-process port. The consumer decides how workers are
 * created and deployed (bundled entry, CSP-compatible URL); importing this
 * module never constructs workers, fetches or timers.
 */
export interface ZipDecodeWorkerLike {
  postMessage(message: ArchiveWorkerRequest, transfer?: readonly Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<ArchiveWorkerResponse>) => void): void;
  addEventListener(type: 'error' | 'messageerror', listener: (event: Event) => void): void;
  terminate(): void;
}
export interface BoundedZipDecoderOptions {
  /** Must throw when the environment cannot create workers (CSP, no Worker). */
  createWorker(): ZipDecodeWorkerLike;
  /** Concurrent decode jobs; further jobs queue. Default 2. */
  readonly maxConcurrentDecodes?: number;
  /** Grace before a cancelled or timed-out worker is terminated. Default 5000. */
  readonly cancelGraceMs?: number;
}
export interface BoundedZipDecodeRequest {
  readonly archive: Uint8Array;
  readonly expected: ArchiveWorkerExpected;
  readonly limits?: ArchiveWorkerLimits;
  /** Transfer the archive buffer instead of copying it: the caller's view
   * detaches for the job's duration and the buffer returns via
   * `status.archiveBuffer`. Default false clones the bytes, so the caller's
   * buffer is never detached. Views into a larger buffer are always copied
   * for transport. */
  readonly transferArchive?: boolean;
}
export interface BoundedZipDecodeStatus {
  readonly status:
    | 'completed'
    | 'cancelled'
    | 'deadline'
    | 'error'
    | 'unsupported'
    | 'worker-error';
  readonly code?: string | undefined;
  readonly detail?: string | undefined;
  readonly stats?: ArchiveWorkerStats | undefined;
  readonly archiveBuffer?: ArrayBuffer | undefined;
  /** True when a transferred archive was not returned before a hard failure. */
  readonly archiveLost?: boolean | undefined;
}
export interface BoundedZipDecodeEntry {
  readonly path: string;
  readonly method: 'store' | 'deflate';
  readonly bytes: Uint8Array;
}
export interface BoundedZipDecodeJob {
  /** Decoded entries under credit backpressure: the worker decodes at most
   * one entry ahead of the consumer, so a stalled consumer keeps at most the
   * held entry plus one buffered entry resident. Pulling the next entry
   * releases the previous one's bytes back to the worker. */
  readonly entries: AsyncIterable<BoundedZipDecodeEntry>;
  /** Stop the job. The worker gets a chance to finish cleanly; it is
   * terminated after the grace period. */
  cancel(): Promise<BoundedZipDecodeStatus>;
  /** Final status; resolves exactly once, after cleanup. */
  readonly result: Promise<BoundedZipDecodeStatus>;
}
export interface BoundedZipDecoder {
  decode(request: BoundedZipDecodeRequest): BoundedZipDecodeJob;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => {
  setTimeout(resolve, ms);
});
/** Extra wall-clock slack beyond the decode deadline for worker messaging. */
const DEADLINE_TRANSPORT_GRACE_MS = 2000;
/** Workers read the posted buffer as a whole, so the payload must be an
 * exact-fit buffer. Sub-views are copied after the archive bound is known;
 * transport copies are outside the decode output limits but part of the
 * job's wall clock. */
const exactArchiveBuffer = (
  archive: Uint8Array,
  transfer: boolean,
  limits: ArchiveWorkerLimits,
): ArrayBuffer => {
  if (archive.byteLength > limits.archiveBytes) {
    throw new ZipDecodeError('limit', 'ZIP archive exceeds the archive byte limit');
  }
  const shared = typeof SharedArrayBuffer !== 'undefined'
    && archive.buffer instanceof SharedArrayBuffer;
  const exact = !shared && archive.byteOffset === 0
    && archive.byteLength === archive.buffer.byteLength;
  if (exact) {
    return archive.buffer as ArrayBuffer;
  }
  if (shared) {
    if (transfer) {
      throw new ZipDecodeError(
        'unsupported',
        'transferArchive requires a non-shared buffer; copy the view first',
      );
    }
    // Shared buffers cannot be digested or transferred as ordinary archives;
    // the documented clone behavior requires a private copy anyway.
    return archive.slice().buffer as ArrayBuffer;
  }
  if (transfer) {
    throw new ZipDecodeError(
      'unsupported',
      'transferArchive requires an exact-fit buffer; copy the view first',
    );
  }
  return archive.slice().buffer as ArrayBuffer;
};

/** Create a bounded ZIP decoder over consumer-provided workers. Each decode
 * job uses one fresh worker and terminates it when the job finishes; the
 * decoder enforces the concurrency limit itself. */
export function createBoundedZipDecoder(options: BoundedZipDecoderOptions): BoundedZipDecoder {
  const maxConcurrent = options.maxConcurrentDecodes ?? 2;
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent <= 0) {
    throw new Error('maxConcurrentDecodes must be a positive integer');
  }
  const graceMs = options.cancelGraceMs ?? 5000;
  let free = maxConcurrent;
  let nextJobId = 1;
  const pending: (() => void)[] = [];
  const acquire = async (): Promise<void> => {
    if (free > 0) {
      free--;
      return;
    }
    await new Promise<void>((resolve) => {
      pending.push(resolve);
    });
    // The permit was handed off directly by releaseSlot.
  };
  const releaseSlot = (): void => {
    const waiter = pending.shift();
    if (waiter === undefined) {
      free++;
      return;
    }
    // Hand the freed permit straight to the oldest waiter so a completion
    // continuation starting a new job cannot steal it first.
    waiter();
  };
  return {
    decode(request) {
      const jobId = nextJobId++;
      const transfer = request.transferArchive === true;
      const limits = request.limits ?? defaultArchiveWorkerLimits();
      // Reject oversized archives before any transport copy is made; the
      // payload view is only materialized once the job acquires a slot.
      const payload = (): ArrayBuffer => exactArchiveBuffer(request.archive, transfer, limits);
      let worker: ZipDecodeWorkerLike | undefined;
      let finished = false;
      let slotAcquired = false;
      let releasedSeq = 0;
      let outstandingSeq = 0;
      let resolveEntry: ((value: IteratorResult<BoundedZipDecodeEntry>) => void) | undefined;
      let rejectEntry: ((error: ZipDecodeError) => void) | undefined;
      let bufferedEntry: BoundedZipDecodeEntry | undefined;
      let decodePosted = false;
      let cancelRequested = false;
      let deadlineInitiated = false;
      let firstCause: 'user' | 'deadline' | undefined;
      let settleResult: ((status: BoundedZipDecodeStatus) => void) | undefined;
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      const result = new Promise<BoundedZipDecodeStatus>((resolve) => {
        settleResult = resolve;
      });
      let failure: ZipDecodeError | undefined;
      const finalize = (status: BoundedZipDecodeStatus): void => {
        if (finished) {
          return;
        }
        finished = true;
        bufferedEntry = undefined;
        if (deadlineTimer !== undefined) {
          clearTimeout(deadlineTimer);
          deadlineTimer = undefined;
        }
        if (status.status === 'completed' || status.status === 'cancelled') {
          resolveEntry?.({
            done: true, value: undefined,
          });
        } else {
          failure = new ZipDecodeError(
            (status.code as ZipDecodeFailureCode | undefined) ?? 'worker-error',
            status.detail ?? `Archive decode job failed with ${status.status}`,
          );
          rejectEntry?.(failure);
        }
        resolveEntry = undefined;
        rejectEntry = undefined;
        if (
          transfer && decodePosted && status.archiveBuffer === undefined
          && status.status !== 'completed'
        ) {
          status = {
            ...status, archiveLost: true,
          };
        }
        settleResult?.(status);

        try {
          worker?.terminate();
        } catch {
          // Termination is best effort; the job is finished either way.
        }
        if (slotAcquired) {
          releaseSlot();
        }
      };
      const start = async (): Promise<void> => {
        await acquire();
        if (finished || cancelRequested) {
          if (!finished) {
            finalize({
              status: 'cancelled',
              code: 'cancelled',
            });
          }
          releaseSlot();
          return;
        }
        slotAcquired = true;
        try {
          worker = options.createWorker();
        } catch (error) {
          finalize({
            status: 'unsupported',
            code: 'unsupported',
            detail: `Cannot create the archive decode worker: ${String(error)}`,
          });
          return;
        }
        worker.addEventListener('message', (event) => {
          const message = event.data;
          if (typeof message !== 'object' || message === null) {
            finalize({
              status: 'worker-error',
              code: 'worker-error',
              detail: 'The archive decode worker posted a malformed message',
            });
            return;
          }
          if (message.jobId !== jobId || finished) {
            return;
          }
          const messageType: unknown = (message as { type?: unknown }).type;
          if (messageType !== 'entry' && messageType !== 'done') {
            const described = typeof messageType === 'string'
              ? messageType
              : Object.prototype.toString.call(messageType);
            finalize({
              status: 'worker-error',
              code: 'worker-error',
              detail: `The archive decode worker posted an unknown message type ${described}`,
            });
            return;
          }
          if (message.type === 'entry') {
            const entryShapeValid = typeof message.seq === 'number'
              && Number.isSafeInteger(message.seq)
              && typeof message.path === 'string'
              && (message.method === 'store' || message.method === 'deflate')
              && message.bytes instanceof ArrayBuffer;
            if (!entryShapeValid) {
              finalize({
                status: 'worker-error',
                code: 'worker-error',
                detail: 'The archive decode worker posted a malformed entry message',
              });
              return;
            }
            if (message.seq !== outstandingSeq + 1) {
              finalize({
                status: 'worker-error',
                code: 'worker-error',
                detail: `The archive decode worker skipped entry sequence ${outstandingSeq + 1}`,
              });
              return;
            }
            if (outstandingSeq > releasedSeq) {
              // An entry delivered before the previous one was released
              // exceeds the one-outstanding-entry credit.
              finalize({
                status: 'worker-error',
                code: 'worker-error',
                detail: 'The archive decode worker delivered an entry before its predecessor was released',
              });
              return;
            }
            outstandingSeq = message.seq;
            const value: BoundedZipDecodeEntry = {
              path: message.path,
              method: message.method,
              bytes: new Uint8Array(message.bytes),
            };
            const resolve = resolveEntry;
            if (resolve !== undefined) {
              resolveEntry = undefined;
              rejectEntry = undefined;
              resolve({
                done: false, value,
              });
            } else if (bufferedEntry === undefined) {
              bufferedEntry = value;
            } else {
              // A worker delivering past the single-outstanding-entry credit
              // is a protocol failure, not a data source.
              finalize({
                status: 'worker-error',
                code: 'worker-error',
                detail: 'The archive decode worker delivered more entries than credited',
              });
            }
            return;
          }
          if (
            message.type === 'done' && message.status === 'completed'
            && outstandingSeq > releasedSeq
          ) {
            finalize({
              status: 'worker-error',
              code: 'worker-error',
              detail: 'The archive decode worker completed with an unreleased entry outstanding',
            });
            return;
          }
          if (message.type === 'done') {
            const doneShapeValid = typeof message.status === 'string'
              && (!transfer || message.status !== 'completed'
                || message.archive instanceof ArrayBuffer)
              && (message.status === 'completed'
                || message.status === 'cancelled'
                || message.status === 'deadline'
                || message.status === 'error')
              && typeof message.stats === 'object'
              && message.stats !== null;
            if (!doneShapeValid) {
              finalize({
                status: 'worker-error',
                code: 'worker-error',
                detail: 'The archive decode worker posted a malformed done message',
              });
              return;
            }
          }
          // A cancellation answering this client's own deadline timer is a
          // deadline, unless the user asked to cancel first.
          const translated = message.status === 'cancelled'
            && (firstCause === 'deadline' || (deadlineInitiated && firstCause === undefined))
            ? {
              status: 'deadline' as const,
              code: 'deadline',
              detail: 'The archive decode worker missed its deadline',
            }
            : {
              status: message.status,
              code: message.code,
              detail: message.detail,
            };
          finalize({
            ...translated,
            stats: message.stats,
            ...(transfer && message.archive !== undefined ? { archiveBuffer: message.archive } : {}),
          });
        });
        const onWorkerFailure = (): void => {
          finalize({
            status: 'worker-error',
            code: 'worker-error',
            detail: 'The archive decode worker failed or received an invalid message',
          });
        };
        worker.addEventListener('error', onWorkerFailure);
        worker.addEventListener('messageerror', onWorkerFailure);
        deadlineTimer = setTimeout(() => {
          deadlineInitiated = true;
          if (firstCause === undefined) {
            firstCause = 'deadline';
          }
          try {
            worker?.postMessage({
              type: 'cancel',
              jobId,
            });
          } catch {
            // A throwing postMessage must not skip the forced deadline.
          }
          void sleep(graceMs).then(() => {
            if (!finished) {
              finalize({
                status: 'deadline',
                code: 'deadline',
                detail: 'The archive decode worker missed its deadline',
              });
            }
          });
        }, limits.decodeDeadlineMs + DEADLINE_TRANSPORT_GRACE_MS);
        let archivePayload: ArrayBuffer;
        try {
          archivePayload = payload();
        } catch (error) {
          finalize(error instanceof ZipDecodeError
            ? {
              status: 'error', code: error.code, detail: error.message,
            }
            : {
              status: 'error', code: 'unsupported', detail: String(error),
            });
          return;
        }
        try {
          // Mark ownership before posting: an in-process worker may transfer
          // the buffer and reply synchronously from inside postMessage, and a
          // reentrant failure must already count the buffer as gone.
          decodePosted = true;
          worker.postMessage({
            type: 'decode',
            jobId,
            protocol: ARCHIVE_WORKER_PROTOCOL,
            archive: archivePayload,
            transferArchive: transfer,
            expected: request.expected,
            limits,
          }, transfer ? [archivePayload] : []);
        } catch (error) {
          if (!finished) {
            finalize({
              status: 'worker-error',
              code: 'worker-error',
              detail: `Could not post the decode request: ${String(error)}`,
            });
          }
          return;
        }
      };
      void start().catch((error) => {
        finalize({
          status: 'worker-error',
          code: 'worker-error',
          detail: `Starting the decode job failed: ${String(error)}`,
        });
      });
      const iterator: AsyncIterator<BoundedZipDecodeEntry> = {
        next: (): Promise<IteratorResult<BoundedZipDecodeEntry>> => {
          if (finished) {
            if (failure !== undefined) {
              return Promise.reject(failure);
            }
            return Promise.resolve({
              done: true, value: undefined,
            });
          }
          if (outstandingSeq > releasedSeq) {
            releasedSeq = outstandingSeq;
            worker?.postMessage({
              type: 'release',
              jobId,
              seq: releasedSeq,
            });
          }
          const buffered = bufferedEntry;
          if (buffered !== undefined) {
            bufferedEntry = undefined;
            return Promise.resolve({
              done: false, value: buffered,
            });
          }
          if (resolveEntry !== undefined) {
            return Promise.reject(new Error('A decode entry pull is already pending'));
          }
          return new Promise<IteratorResult<BoundedZipDecodeEntry>>((resolve, reject) => {
            resolveEntry = resolve;
            rejectEntry = reject;
          });
        },
        return: (): Promise<IteratorResult<BoundedZipDecodeEntry>> => job.cancel().then(() => ({
          done: true,
          value: undefined,
        })),
      };
      const job: BoundedZipDecodeJob = {
        entries: {
          [Symbol.asyncIterator]: (): AsyncIterator<BoundedZipDecodeEntry> => iterator,
        },
        cancel: async (): Promise<BoundedZipDecodeStatus> => {
          if (finished) {
            return result;
          }
          cancelRequested = true;
          if (firstCause === undefined) {
            firstCause = 'user';
          }
          worker?.postMessage({
            type: 'cancel',
            jobId,
          });
          const forced = sleep(graceMs).then((): BoundedZipDecodeStatus => ({
            status: 'cancelled',
            code: 'cancelled',
            detail: 'The archive decode worker was terminated after cancellation',
          }));
          return Promise.race([result, forced]).then((status) => {
            if (!finished) {
              finalize(status);
            }
            return result;
          });
        },
        result,
      };
      return job;
    },
  };
}
