import { digestOf } from './archive-digest.js';
import { ZipDecodeError, type ZipDecodeFailureCode } from './archive-errors.js';
import {
  ARCHIVE_WORKER_PROTOCOL,
  defaultArchiveWorkerLimits,
  invalidArchiveLimit,
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
  /** Cooperative cleanup window after a cancellation or deadline is
   * decided: the worker gets this long to finish and return buffers before
   * it is terminated and the job settles. A response landing inside the
   * window cannot turn a decided deadline into a completed job. Default
   * 5000. */
  readonly cancelGraceMs?: number;
}
export interface BoundedZipDecodeRequest {
  readonly archive: Uint8Array;
  readonly expected: ArchiveWorkerExpected;
  readonly limits?: ArchiveWorkerLimits;
  /** Opt into ownership-handoff semantics: the submission is frozen once
   * into a client-owned snapshot, that snapshot is transferred without a
   * second transport copy, and the exact submitted snapshot returns via
   * `status.archiveBuffer`, so caller mutations during submission cannot
   * desynchronize the verification digest. The caller's buffer is never
   * detached; the freeze costs one archive-sized copy of peak memory.
   * Default false clones the bytes for transport. Views into a larger
   * buffer are always copied for transport. */
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
  /** True when a transferred submission snapshot was not returned before a
   * hard failure. The caller's own buffer is unaffected either way; the
   * flag reports that the job's snapshot copy was not handed back. */
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
   * held entry plus one buffered entry resident. The release credit returns
   * when an entry is handed to the consumer and its digest has verified. */
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

const validCounter = (value: unknown): boolean => typeof value === 'number'
  && Number.isSafeInteger(value) && value >= 0;
const validElapsed = (value: unknown): boolean => typeof value === 'number'
  && Number.isFinite(value) && value >= 0;
/** Shared wording for settlements where the worker itself overran the deadline. */
const DEADLINE_MISS_DETAIL = 'The archive decode worker missed its deadline';
/** The deadline expired client-side, before the job was even submitted. */
const PRE_SUBMIT_DEADLINE_DETAIL
  = 'The archive decode deadline expired before the job was submitted';
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
  if (exact && transfer) {
    return archive.buffer as ArrayBuffer;
  }
  if (exact) {
    // A real worker structured-clones a posted buffer, but an in-process
    // port receives the reference itself; clone mode promises the caller's
    // buffer is never shared, so exact-fit inputs are copied too. The
    // constructor copies rather than calling the input's polymorphic slice,
    // which Buffer subclasses override to return another view.
    return new Uint8Array(archive).buffer;
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
    return new Uint8Array(archive).buffer;
  }
  if (transfer) {
    throw new ZipDecodeError(
      'unsupported',
      'transferArchive requires an exact-fit buffer; copy the view first',
    );
  }
  return new Uint8Array(archive).buffer;
};

/** Copy the expected manifest so no side shares another's verification
 * basis: the client freezes the caller's request at submission, and the
 * posted request is a separate copy an in-process port cannot mutate. */
const copyExpected = (source: ArchiveWorkerExpected): ArchiveWorkerExpected => ({
  formatVersion: source.formatVersion,
  archive: { ...source.archive },
  entries: source.entries.map((entry) => ({ ...entry })),
});

/** Create a bounded ZIP decoder over consumer-provided workers. Each decode
 * job uses one fresh worker and terminates it when the job finishes; the
 * decoder enforces the concurrency limit itself. */
export function createBoundedZipDecoder(options: BoundedZipDecoderOptions): BoundedZipDecoder {
  const maxConcurrent = options.maxConcurrentDecodes ?? 2;
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent <= 0) {
    throw new Error('maxConcurrentDecodes must be a positive integer');
  }
  const graceMs = options.cancelGraceMs ?? 5000;
  if (
    !Number.isSafeInteger(graceMs)
    || graceMs < 0
    || graceMs > 2 ** 31 - 1
  ) {
    // Oversized or non-finite graces wrap the platform timer into firing
    // immediately instead of honoring the requested grace.
    throw new Error('cancelGraceMs must be an integer between 0 and the timer range');
  }
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
      // Freeze the verification basis at submission: limits and the expected
      // manifest are shallow-copied so later caller mutations cannot change
      // what an in-flight job checks against or hands to the worker.
      const limits: ArchiveWorkerLimits = request.limits === undefined
        ? defaultArchiveWorkerLimits()
        : { ...request.limits };
      const expected = copyExpected(request.expected);
      // Reject oversized archives before any transport copy is made; the
      // payload view is only materialized once the job acquires a slot.
      const payload = (): ArrayBuffer => exactArchiveBuffer(request.archive, transfer, limits);
      let worker: ZipDecodeWorkerLike | undefined;
      let finished = false;
      let slotAcquired = false;
      let releasedSeq = 0;
      let outstandingSeq = 0;
      let verifiedEntries = 0;
      let deliveredBytes = 0;
      let archiveByteLength = -1;
      let submittedArchiveDigest: string | undefined;
      let terminalSeen = false;
      let terminalStats: ArchiveWorkerStats | undefined;
      let resolveEntry: ((value: IteratorResult<BoundedZipDecodeEntry>) => void) | undefined;
      let rejectEntry: ((error: ZipDecodeError) => void) | undefined;
      let bufferedEntry: BoundedZipDecodeEntry | undefined;
      let bufferedSeq = 0;
      let decodePosted = false;
      let cancelRequested = false;
      let deadlineInitiated = false;
      let firstCause: 'user' | 'deadline' | undefined;
      /** Absolute deadline on the monotonic clock; Infinity until the job's
       * execution budget starts when it acquires a slot. */
      let deadlineAt = Number.POSITIVE_INFINITY;
      let settleResult: ((status: BoundedZipDecodeStatus) => void) | undefined;
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      let forcedTimer: ReturnType<typeof setTimeout> | undefined;
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
        bufferedSeq = 0;
        if (deadlineTimer !== undefined) {
          clearTimeout(deadlineTimer);
          deadlineTimer = undefined;
        }
        if (forcedTimer !== undefined) {
          clearTimeout(forcedTimer);
          forcedTimer = undefined;
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
      /** Return the release credit for a handed-over entry. Shared by the
       * digest-verification resolve path and the buffered pull path so the
       * credit protocol cannot drift between them. */
      const postRelease = (seq: number): void => {
        if (seq <= releasedSeq) {
          return;
        }
        releasedSeq = seq;
        try {
          worker?.postMessage({
            type: 'release',
            jobId,
            seq,
          });
        } catch (error) {
          // A worker that cannot accept the release would otherwise wait for
          // an acknowledgement that never arrived.
          if (!finished) {
            finalize({
              status: 'worker-error',
              code: 'worker-error',
              detail: `Could not post the entry release: ${String(error)}`,
            });
          }
        }
      };
      /** Map an entry digest-verification failure to a terminal status
       * without preempting an already-accepted terminal settlement. */
      const finalizeVerificationFailure = (scope: string, error: unknown): void => {
        if (finished || terminalSeen) {
          return;
        }
        finalize(error instanceof ZipDecodeError
          ? {
            status: 'error', code: error.code, detail: error.message,
          }
          : {
            status: 'worker-error',
            code: 'worker-error',
            detail: `Could not verify ${scope}: ${String(error)}`,
          });
      };
      const postCancelToWorker = (): void => {
        try {
          worker?.postMessage({
            type: 'cancel',
            jobId,
          });
        } catch {
          // A throwing postMessage must not skip the forced settlement.
        }
      };
      /** The single cooperative-cleanup timer, shared by cancellation and
       * deadline: whoever decides the cause first arms one grace window;
       * later calls no-op, so repeated cancels or a deadline racing a cancel
       * neither stack timers nor push the settlement further out. */
      const beginForcedSettlement = (): void => {
        if (forcedTimer !== undefined || finished) {
          return;
        }
        forcedTimer = setTimeout((): void => {
          forcedTimer = undefined;
          // Not gated on terminalSeen: a terminal response whose archive
          // verification never settles must not retain the worker and
          // concurrency permit forever; the conservative settlement reports
          // the archive as lost.
          if (finished) {
            return;
          }
          finalize(firstCause === 'deadline'
            ? {
              status: 'deadline',
              code: 'deadline',
              detail: decodePosted ? DEADLINE_MISS_DETAIL : PRE_SUBMIT_DEADLINE_DETAIL,
              ...(terminalStats !== undefined ? { stats: terminalStats } : {}),
            }
            : {
              status: 'cancelled',
              code: 'cancelled',
              detail: 'The archive decode worker was terminated after cancellation',
              ...(terminalStats !== undefined ? { stats: terminalStats } : {}),
            });
        }, graceMs);
      };
      /** The timer callback is the deadline's notifier, the monotonic clock
       * comparison is its authority: a callback that runs late, or a success
       * that resolves while the callback is still queued, cannot stretch the
       * budget. The budget is exhausted at the deadline instant itself.
       * Whichever path observes the expiry first also starts the cooperative
       * stop and the cleanup window, so every observation is equivalent to
       * the timer firing. */
      const observeDeadline = (): boolean => {
        if (deadlineInitiated) {
          return true;
        }
        if (!(performance.now() >= deadlineAt)) {
          return false;
        }
        deadlineInitiated = true;
        if (firstCause === undefined) {
          firstCause = 'deadline';
        }
        postCancelToWorker();
        beginForcedSettlement();
        return true;
      };
      const onDeadline = (): void => {
        if (!observeDeadline()) {
          // The platform timer fired ahead of the monotonic comparison
          // (coarsened clocks can disagree by a fraction); re-arm for the
          // true remainder so the deadline's only scheduled notifier is
          // not spent.
          deadlineTimer = setTimeout(
            onDeadline,
            Math.max(deadlineAt - performance.now(), 0),
          );
        }
      };
      /** Pre-submission gate shared by both transport modes: the absolute
       * deadline and any user cancellation are re-checked against the
       * monotonic clock — not the pending timer callback — so preparation
       * that outlasts the budget never posts the archive. */
      const preSubmitGuard = (): boolean => {
        if (observeDeadline() && firstCause !== 'user') {
          finalize({
            status: 'deadline',
            code: 'deadline',
            detail: PRE_SUBMIT_DEADLINE_DETAIL,
          });
          return true;
        }
        if (cancelRequested) {
          finalize({
            status: 'cancelled',
            code: 'cancelled',
          });
          return true;
        }
        return false;
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
        // Mirror the core's numeric validation client-side: a custom worker
        // runs no core, so NaN or Infinity limits would silently disable
        // every boundary comparison relying on them.
        const invalidLimit = invalidArchiveLimit(limits);
        if (invalidLimit !== undefined) {
          finalize({
            status: 'error',
            code: 'limit',
            detail: `ZIP decode limit ${invalidLimit.name} must be an integer of at least ${invalidLimit.minimum}`,
          });
          return;
        }
        if (limits.decodeDeadlineMs > 2 ** 31 - 1) {
          // Arming the platform timer beyond its range would wrap it into
          // firing immediately instead of honoring the configured deadline.
          finalize({
            status: 'error',
            code: 'limit',
            detail: 'ZIP decode deadline exceeds the platform timer range',
          });
          return;
        }
        // The execution budget starts when the slot is acquired, before
        // worker creation, the transport copy, the pre-transfer hash and the
        // decode post; queue wait is not part of the budget, and everything
        // from here through returned-archive verification spends the same
        // absolute deadline. The timer fires exactly at the deadline — the
        // cancel grace applies only to the cooperative cleanup afterwards.
        deadlineAt = performance.now() + limits.decodeDeadlineMs;
        deadlineTimer = setTimeout(onDeadline, limits.decodeDeadlineMs);
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
          if (terminalSeen) {
            // A terminal response was accepted; everything racing its
            // archive-digest verification is ignored, malformed or not.
            return;
          }
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
            // Freeze the fields the async digest continuation reads: an
            // in-process worker can mutate its response object after emit.
            const seq = message.seq;
            const path = message.path;
            if (seq !== outstandingSeq + 1) {
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
            const expectedEntry = expected.entries[seq - 1];
            if (
              expectedEntry === undefined
              || path !== expectedEntry.path
              || message.method !== expectedEntry.method
              || message.bytes.byteLength !== expectedEntry.bytes
            ) {
              // A version-skewed or custom worker must not be able to swap
              // files under a decode that still reports success.
              finalize({
                status: 'worker-error',
                code: 'worker-error',
                detail: `The archive decode worker delivered entry ${seq} without matching the expected manifest entry`,
              });
              return;
            }
            // The worker-side core enforces the limits, but a custom worker
            // runs no core: this boundary is the only remaining guard for
            // the decoder's public resource-limit contract.
            if (path.length > limits.maxPathLength) {
              finalize({
                status: 'error',
                code: 'limit',
                detail: `Delivered entry ${seq} path exceeds the length limit ${limits.maxPathLength}`,
              });
              return;
            }
            if (message.bytes.byteLength > limits.entryBytes) {
              finalize({
                status: 'error',
                code: 'limit',
                detail: `Delivered entry ${seq} exceeds the per-entry byte limit ${limits.entryBytes}`,
              });
              return;
            }
            if (seq > limits.entryCount) {
              finalize({
                status: 'error',
                code: 'limit',
                detail: `Delivered entry ${seq} exceeds the entry count limit ${limits.entryCount}`,
              });
              return;
            }
            deliveredBytes += message.bytes.byteLength;
            if (deliveredBytes > limits.totalExpandedBytes) {
              finalize({
                status: 'error',
                code: 'limit',
                detail: `Delivered entries exceed the total expanded byte limit ${limits.totalExpandedBytes}`,
              });
              return;
            }
            outstandingSeq = seq;
            let entryBytes: Uint8Array;
            try {
              // Copy into client-owned storage: a custom worker may retain
              // and mutate the buffer it emitted, and verification plus the
              // consumer must both observe the same immutable snapshot. A
              // detached buffer throws here and must fail the job, not the
              // listener.
              entryBytes = new Uint8Array(message.bytes.slice(0));
            } catch (error) {
              finalize({
                status: 'worker-error',
                code: 'worker-error',
                detail: `The archive decode worker delivered entry ${seq} with an undeliverable buffer: ${String(error)}`,
              });
              return;
            }
            const value: BoundedZipDecodeEntry = {
              path,
              method: message.method,
              bytes: entryBytes,
            };
            // The client verifies the digest itself: a custom worker runs no
            // core decoder, so this boundary is the only guarantee that the
            // bytes handed to the consumer are the manifest's bytes.
            void digestOf(value.bytes).then(
              (digest) => {
                if (finished || terminalSeen || cancelRequested || observeDeadline()) {
                  // A done message was accepted and only its archive digest
                  // verification is pending, or a cancellation/deadline is
                  // already settling the job; that settlement resolves any
                  // pending pull, so this entry must not mutate state or
                  // surface output after cancellation began. A success
                  // resolving past the elapsed deadline is held the same
                  // way until the deadline settlement resolves the pull.
                  return;
                }
                if (digest !== expectedEntry.sha256) {
                  finalize({
                    status: 'worker-error',
                    code: 'worker-error',
                    detail: `The archive decode worker delivered entry ${seq} with bytes that do not match the expected manifest digest`,
                  });
                  return;
                }
                verifiedEntries++;
                const resolve = resolveEntry;
                if (resolve !== undefined) {
                  resolveEntry = undefined;
                  rejectEntry = undefined;
                  resolve({
                    done: false, value,
                  });
                  // The consumer owns the bytes now, so the release credit
                  // returns with the handout and the worker may decode one
                  // entry ahead while the consumer processes this one.
                  postRelease(seq);
                } else if (bufferedEntry === undefined) {
                  bufferedEntry = value;
                  bufferedSeq = seq;
                } else {
                  // A worker delivering past the single-outstanding-entry
                  // credit is a protocol failure, not a data source.
                  finalize({
                    status: 'worker-error',
                    code: 'worker-error',
                    detail: 'The archive decode worker delivered more entries than credited',
                  });
                }
              },
              (error) => {
                if (finished || terminalSeen || cancelRequested || observeDeadline()) {
                  // A settlement already in flight resolves the pending
                  // pull; a verification-infrastructure failure must not
                  // preempt it with an error status.
                  return;
                }
                finalizeVerificationFailure(`the delivered entry ${seq}`, error);
              },
            );
            return;
          }
          if (message.type === 'done') {
            const doneShapeValid = typeof message.status === 'string'
              && (message.archive === undefined || message.archive instanceof ArrayBuffer)
              && (message.status === 'completed'
                || message.status === 'cancelled'
                || message.status === 'deadline'
                || message.status === 'error')
              && (message.status !== 'completed'
                || transfer === (message.archive !== undefined))
              && (message.code === undefined || typeof message.code === 'string')
              && (message.detail === undefined || typeof message.detail === 'string')
              && typeof message.stats === 'object'
              && message.stats !== null
              && validCounter(message.stats.entries)
              && validCounter(message.stats.expandedBytes)
              && validElapsed(message.stats.elapsedMs);
            if (!doneShapeValid) {
              finalize({
                status: 'worker-error',
                code: 'worker-error',
                detail: 'The archive decode worker posted a malformed done message',
              });
              return;
            }
            if (
              transfer && message.archive !== undefined
              && message.archive.byteLength !== archiveByteLength
            ) {
              // A different-length buffer cannot be the caller's detached
              // archive, so ownership was not restored.
              finalize({
                status: 'worker-error',
                code: 'worker-error',
                detail: 'The archive decode worker returned an archive buffer that is not the transported archive',
              });
              return;
            }
            if (message.status === 'completed') {
              if (outstandingSeq > releasedSeq) {
                finalize({
                  status: 'worker-error',
                  code: 'worker-error',
                  detail: 'The archive decode worker completed with an unreleased entry outstanding',
                });
                return;
              }
              if (verifiedEntries !== expected.entries.length) {
                finalize({
                  status: 'worker-error',
                  code: 'worker-error',
                  detail: 'The archive decode worker completed without delivering every expected entry',
                });
                return;
              }
              if (
                message.stats.entries !== verifiedEntries
                || message.stats.expandedBytes !== deliveredBytes
              ) {
                // The client observed the real delivery; a completion must
                // not report measurements it did not verify.
                finalize({
                  status: 'worker-error',
                  code: 'worker-error',
                  detail: 'The archive decode worker completed with statistics that do not match the delivered output',
                });
                return;
              }
            }
            // A cancellation answering this client's own deadline timer is a
            // deadline, unless the user asked to cancel first; a completion
            // arriving after the deadline guard fired is one too. Worker
            // errors carrying the unsupported code keep the public status
            // callers use for unavailable platform capabilities.
            // An in-process worker can retain and mutate the response
            // object after emit() returns; the async archive verification
            // must settle on the fields that were validated, not on
            // whatever the object says later.
            const terminal = {
              status: message.status,
              code: message.code,
              detail: message.detail,
              stats: { ...message.stats },
            };
            const deadlineTranslate = (detail: string): {
              status: 'deadline'; code: 'deadline'; detail: string;
            } => ({
              status: 'deadline',
              code: 'deadline',
              detail,
            });
            const translateDone = (): {
              status: BoundedZipDecodeStatus['status'];
              code?: string | undefined;
              detail?: string | undefined;
            } => {
              // First-cause priority: once a deadline or user cancellation
              // decided the ending, any terminal response landing
              // afterwards — completion, failure or echo — settles as the
              // decided cause; a late worker status cannot replace it.
              if (firstCause === 'deadline') {
                return deadlineTranslate(terminal.status === 'completed'
                  ? 'The archive decode worker completed after the decode deadline fired'
                  : DEADLINE_MISS_DETAIL);
              }
              if (firstCause === 'user' && terminal.status !== 'cancelled') {
                return {
                  status: 'cancelled',
                  code: 'cancelled',
                  detail: `The archive decode worker reported ${terminal.status} after cancellation was requested`,
                };
              }
              if (terminal.status === 'error' && terminal.code === 'unsupported') {
                return {
                  status: 'unsupported', code: 'unsupported', detail: terminal.detail,
                };
              }
              return {
                status: terminal.status, code: terminal.code, detail: terminal.detail,
              };
            };
            const settle = (archiveBuffer?: ArrayBuffer): void => {
              // Re-checked at settlement: the budget covers returned-archive
              // verification too, so a completion settling after the
              // deadline elapsed cannot report success, while the verified
              // buffer is still restored.
              observeDeadline();
              finalize({
                ...translateDone(),
                stats: terminal.stats,
                ...(archiveBuffer !== undefined ? { archiveBuffer } : {}),
              });
            };
            if (transfer && message.archive !== undefined) {
              // A same-length substitute buffer would silently replace the
              // caller's archive, so ownership is only restored after the
              // digest matches the bytes actually submitted (which may
              // legitimately differ from the manifest); done is terminal,
              // so messages racing the hash are ignored. The buffer is
              // snapshotted so a worker retaining its storage cannot
              // mutate it after verification.
              const returned = message.archive.slice(0);
              terminalSeen = true;
              terminalStats = terminal.stats;
              void digestOf(new Uint8Array(returned)).then(
                (digest) => {
                  if (finished) {
                    return;
                  }
                  if (
                    submittedArchiveDigest === undefined
                    || digest !== submittedArchiveDigest
                  ) {
                    finalize({
                      status: 'worker-error',
                      code: 'worker-error',
                      detail: 'The archive decode worker returned an archive buffer that is not the transported archive',
                    });
                    return;
                  }
                  // The settlement translation is re-evaluated here, so a
                  // deadline that fired while this verification pended
                  // cannot be reported as success, while the verified
                  // buffer is still restored.
                  settle(returned);
                },
                (error) => {
                  // This verification is the accepted terminal settlement,
                  // not a racer of one, so guard on `finished` only.
                  if (finished) {
                    return;
                  }
                  finalize(error instanceof ZipDecodeError
                    ? {
                      status: 'error', code: error.code, detail: error.message,
                    }
                    : {
                      status: 'worker-error',
                      code: 'worker-error',
                      detail: `Could not verify the returned archive: ${String(error)}`,
                    });
                },
              );
              return;
            }
            settle();
          }
        });
        const onWorkerFailure = (): void => {
          if (terminalSeen) {
            // A terminal response was accepted and only its archive digest
            // verification is pending; later worker lifecycle events cannot
            // change that settlement.
            return;
          }
          finalize({
            status: 'worker-error',
            code: 'worker-error',
            detail: 'The archive decode worker failed or received an invalid message',
          });
        };
        worker.addEventListener('error', onWorkerFailure);
        worker.addEventListener('messageerror', onWorkerFailure);
        let archivePayload: ArrayBuffer;
        try {
          archivePayload = payload();
          archiveByteLength = archivePayload.byteLength;
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
        if (transfer) {
          // Freeze the submission before the async hash: the digest and the
          // transferred bytes must describe the same immutable snapshot
          // even if the caller mutates its view while hashing runs. The
          // frozen copy is what gets transferred and later returned.
          archivePayload = archivePayload.slice(0);
          // Digest the frozen submission so a returned buffer is compared
          // against the bytes actually submitted — not the manifest, which
          // the submission itself may legitimately fail to match.
          try {
            submittedArchiveDigest = await digestOf(new Uint8Array(archivePayload));
          } catch (error) {
            if (error instanceof ZipDecodeError && error.code === 'unsupported') {
              finalize({
                status: 'unsupported', code: 'unsupported', detail: error.message,
              });
            } else if (error instanceof ZipDecodeError) {
              finalize({
                status: 'error', code: error.code, detail: error.message,
              });
            } else {
              finalize({
                status: 'worker-error',
                code: 'worker-error',
                detail: `Could not hash the archive for transfer: ${String(error)}`,
              });
            }
            return;
          }
          // The hash await yields to the event loop: honour a settlement
          // that landed while hashing instead of transferring the caller's
          // buffer anyway. The first cause wins, matching the
          // terminal-response translation.
          if (finished) {
            return;
          }
        }
        if (preSubmitGuard()) {
          return;
        }
        // Copy the manifest and limits for the worker: an in-process port
        // shares nothing with the client's verification basis, so it cannot
        // mutate the checks its own responses are judged against.
        const postedExpected = copyExpected(expected);
        // Re-check after the copy construction: preparation work between
        // the checks must not hand the archive off past the deadline.
        if (preSubmitGuard()) {
          return;
        }
        // The worker receives only the unspent remainder of the absolute
        // deadline, measured on the client's clock; deadline authority stays
        // with the client, whose timer and translations judge the result.
        const remainingDeadlineMs = Math.ceil(deadlineAt - performance.now());
        if (remainingDeadlineMs <= 0) {
          finalize({
            status: 'deadline',
            code: 'deadline',
            detail: PRE_SUBMIT_DEADLINE_DETAIL,
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
            expected: postedExpected,
            limits: {
              ...limits,
              decodeDeadlineMs: remainingDeadlineMs,
            },
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
          // Capture the buffered value before the release post: an
          // in-process worker can answer the release synchronously, and the
          // reentrant handler must not see the still-buffered predecessor as
          // over-delivery, nor lose it to a terminal response clearing the
          // buffer while this pull still owes the caller that entry.
          const buffered = bufferedEntry;
          const bufferedCapturedSeq = bufferedSeq;
          bufferedEntry = undefined;
          bufferedSeq = 0;
          if (buffered !== undefined && !cancelRequested && !deadlineInitiated) {
            // Release at handout: the consumer owns the bytes now, so the
            // credit is never spent on an unverified message while the
            // worker may still decode one entry ahead. Once a cancellation
            // or deadline settlement has begun, the settlement resolves the
            // pull instead of surfacing more output.
            postRelease(bufferedCapturedSeq);
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
          // A deadline that already elapsed keeps its cause even when this
          // cancel lands before the timer callback runs; callback ordering
          // must not decide between user and deadline.
          if (!observeDeadline()) {
            cancelRequested = true;
            if (firstCause === undefined) {
              firstCause = 'user';
            }
          }
          postCancelToWorker();
          // The same cooperative-cleanup window the deadline uses: one
          // shared timer settles the job if the worker never answers, and
          // repeated cancels neither stack timers nor extend the wait.
          beginForcedSettlement();
          return result;
        },
        result,
      };
      return job;
    },
  };
}
