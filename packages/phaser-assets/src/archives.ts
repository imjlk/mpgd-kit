import { digestOf } from './archive-digest.js';
import { ZipDecodeError, type ZipDecodeFailureCode } from './archive-errors.js';
import {
  ARCHIVE_WORKER_PROTOCOL,
  defaultArchiveWorkerLimits,
  invalidArchiveLimit,
  type ArchiveWorkerExpected,
  type ArchiveWorkerExpectedEntry,
  type ArchiveWorkerLimits,
  type ArchiveWorkerRequest,
  type ArchiveWorkerResponse,
  type ArchiveWorkerStats,
  type ArchiveWorkerStatus,
} from './archive-protocol.js';
import { ZIP_ENTRY_COUNT_CEILING } from './archive-zip-core.js';
import { PHASER_PACK_DELIVERY_VERSION } from './pack-format.js';

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
export { ZIP_ENTRY_COUNT_CEILING } from './archive-zip-core.js';
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
   * Default false clones the bytes for transport; transfer mode instead
   * requires an exact-fit, non-shared buffer and rejects views into
   * larger buffers or shared memory with `unsupported`. */
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

/** A worker-side failure report before cause translation. */
type WorkerFailureStatus = {
  readonly status: Exclude<BoundedZipDecodeStatus['status'], 'completed' | 'cancelled'>;
  readonly code: string;
  readonly detail: string;
};
/** The settlement a decided cause dictates, regardless of what the worker
 * reports afterwards. */
type DecidedCause =
  | { readonly status: 'cancelled'; readonly code: 'cancelled' }
  | { readonly status: 'deadline'; readonly code: 'deadline' };

const validCounter = (value: unknown): boolean => typeof value === 'number'
  && Number.isSafeInteger(value) && value >= 0;
const validElapsed = (value: unknown): boolean => typeof value === 'number'
  && Number.isFinite(value) && value >= 0;
/** Shared wording for settlements where the worker itself overran the deadline. */
const DEADLINE_MISS_DETAIL = 'The archive decode worker missed its deadline';
/** Terminal statuses a done message may carry, plus the client
 * settlements that surface through the same failure branch. */
type TerminalFailureStatus = ArchiveWorkerStatus | 'unsupported' | 'worker-error';
/** Detailed failure codes the error terminal status may carry (the
 * unsupported capability signal included); every other status fixes its
 * code in normalizeWorkerFailureCode (deadline/cancelled/worker-error are
 * fixed by that switch, so they are excluded here). The constraint keeps
 * the table compile-checked against the rest of the union: a newly added
 * failure code the error status should carry must be added here or the
 * build fails, not silently normalize. */
const DETAILED_FAILURE_CODES = {
  'archive-mismatch': null,
  'unsupported-zip': null,
  'invalid-structure': null,
  'entry-mismatch': null,
  limit: null,
  decode: null,
  integrity: null,
  'worker-busy': null,
  unsupported: null,
} as const satisfies Omit<Record<ZipDecodeFailureCode, null>, 'deadline' | 'cancelled' | 'worker-error'>;

/** Normalize a worker-supplied code to the public union: every status
 * except error fixes its settlement code (completed carries none,
 * cancelled/deadline/unsupported/worker-error carry their own), and only
 * the error status may carry a detailed failure code from the table —
 * anything else the worker reported becomes 'worker-error'. Result and
 * iterator therefore always agree on the cause. */
const normalizeWorkerFailureCode = (
  code: string | undefined,
  status: TerminalFailureStatus,
): ZipDecodeFailureCode | undefined => {
  // Every status except error fixes its settlement code, so a recognized
  // but status-incompatible worker code (deadline + integrity, cancelled +
  // archive-mismatch) can never surface a contradictory pair.
  switch (status) {
    case 'completed':
      return undefined;
    case 'cancelled':
      return 'cancelled';
    case 'deadline':
      return 'deadline';
    case 'unsupported':
      return 'unsupported';
    case 'worker-error':
      return 'worker-error';
    case 'error':
      break;
    default: {
      // Compile-checked exhaustiveness: a future status member must be
      // classified here, never silently funneled into the error branch.
      const unseen: never = status;
      return unseen;
    }
  }
  // Only the error status carries detailed failure codes; anything else
  // the worker reported normalizes to the generic failure.
  if (code !== undefined && Object.hasOwn(DETAILED_FAILURE_CODES, code)) {
    return code as ZipDecodeFailureCode;
  }
  return 'worker-error';
};
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
  // Read every view property exactly once: a subclass with switching
  // accessors must not let the bound check and the transport decision
  // observe different views of the same nominal input.
  const viewBytes = archive.byteLength;
  const viewOffset = archive.byteOffset;
  const viewBuffer = archive.buffer;
  if (viewBytes > limits.archiveBytes) {
    throw new ZipDecodeError('limit', 'ZIP archive exceeds the archive byte limit');
  }
  const shared = typeof SharedArrayBuffer !== 'undefined'
    && viewBuffer instanceof SharedArrayBuffer;
  const exact = !shared && viewOffset === 0
    && viewBytes === viewBuffer.byteLength;
  if (exact && transfer) {
    return viewBuffer as ArrayBuffer;
  }
  if (exact) {
    // A real worker structured-clones a posted buffer, but an in-process
    // port receives the reference itself; clone mode promises the caller's
    // buffer is never shared, so exact-fit inputs are copied too. The copy
    // is bounded by the captured view facts and never dispatches to the
    // input's polymorphic slice.
    return copyViewBytes(viewBuffer, viewOffset, viewBytes);
  }
  if (shared) {
    if (transfer) {
      throw new ZipDecodeError(
        'unsupported',
        'transferArchive requires a non-shared buffer; copy the view first',
      );
    }
    // Shared buffers cannot be digested or transferred as ordinary archives;
    // the documented clone behavior requires a private copy anyway. The
    // copy is bounded by the captured view facts, not the view's internal
    // slots, so a lying accessor cannot smuggle a larger transport.
    return copyViewBytes(viewBuffer, viewOffset, viewBytes);
  }
  if (transfer) {
    throw new ZipDecodeError(
      'unsupported',
      'transferArchive requires an exact-fit buffer; copy the view first',
    );
  }
  return copyViewBytes(viewBuffer, viewOffset, viewBytes);
};

/** Copy a view's bytes bounded by explicitly captured facts: the view's
 * internal slots are only read through an explicitly sized window, so
 * lying accessors cannot enlarge the transport. */
const copyViewBytes = (
  viewBuffer: ArrayBufferLike,
  viewOffset: number,
  viewBytes: number,
): ArrayBuffer => {
  const copy = new ArrayBuffer(viewBytes);
  new Uint8Array(copy).set(new Uint8Array(viewBuffer, viewOffset, viewBytes));
  return copy;
};

/** Render any thrown value without the rendering itself throwing: a
 * hostile toString (or a Proxy trap behind it) gets a constant fallback. */
const ERROR_DETAIL_LIMIT = 512;
const safeErrorDetail = (error: unknown): string => {
  let rendered: string;
  try {
    rendered = String(error);
  } catch {
    return 'an unreadable error value';
  }
  // A hostile but non-throwing toString can still return an unbounded
  // string; cap what any settlement detail retains.
  return rendered.length > ERROR_DETAIL_LIMIT
    ? `${rendered.slice(0, ERROR_DETAIL_LIMIT)}… (${rendered.length} chars)`
    : rendered;
};

/** Accept a worker-supplied buffer candidate: genuine ArrayBuffers pass
 * regardless of their originating realm (realm-local instanceof alone
 * would reject cross-realm buffers), while shared memory, plain objects,
 * iterables and @@toStringTag-spoofed fakes are rejected. A DataView
 * probe validates the [[ArrayBufferData]] internal slot itself — it does
 * NOT distinguish ArrayBuffer from SharedArrayBuffer, and no pure-JS
 * probe reliably can: the exclusion above is best-effort (a same-realm
 * @@toStringTag spoof on a genuine SharedArrayBuffer evades it), with the
 * real containment downstream — copyBufferBytes copies bytes out before
 * anything client-owned observes them. Detached buffers fail the DataView probe
 * itself (the spec's IsDetachedBuffer check) and settle at the shape
 * check; the length guard in copyBufferBytes remains as defense in depth. */
const acceptWorkerBuffer = (candidate: unknown): candidate is ArrayBuffer => {
  if (
    typeof SharedArrayBuffer !== 'undefined'
    && (candidate instanceof SharedArrayBuffer
      || Object.prototype.toString.call(candidate) === '[object SharedArrayBuffer]')
  ) {
    // The toString tag is internal-slot-derived, so it also catches
    // cross-realm shared buffers the realm-local instanceof misses.
    return false;
  }
  // The DataView probe is the sole authority: an instanceof shortcut would
  // accept same-realm prototype spoofs (Object.create(ArrayBuffer.prototype),
  // Proxy getPrototypeOf traps), while the probe validates the internal
  // slot itself and grants every genuine buffer of any realm.
  try {
    new DataView(candidate as ArrayBufferLike, 0, 0);
    return true;
  } catch {
    return false;
  }
};

/** Copy buffer bytes by construction, never by dispatching to the
 * untrusted buffer's polymorphic slice: an override returning `this`
 * would hand the caller a view over storage another party can mutate. */
const copyBufferBytes = (source: ArrayBuffer, expectedLength: number): ArrayBuffer => {
  let actualLength: number;
  try {
    actualLength = source.byteLength;
  } catch (error) {
    // A subclass getter can throw on the length itself.
    throw new TypeError(`buffer length could not be read: ${safeErrorDetail(error)}`);
  }
  if (actualLength !== expectedLength) {
    // A detached buffer reads as zero-length here; the mismatch is the
    // detachment signal that a polymorphic slice used to provide as a
    // TypeError, so the existing catches keep failing the job.
    throw new TypeError('buffer is detached or has an unexpected length');
  }
  const copy = new ArrayBuffer(expectedLength);
  new Uint8Array(copy).set(new Uint8Array(source));
  return copy;
};

const copyArchiveMeta = (meta: ArchiveWorkerExpected['archive']): ArchiveWorkerExpected['archive'] => ({
  bytes: meta.bytes,
  sha256: meta.sha256,
});

/** Copy the expected manifest so no side shares another's verification
 * basis: the client freezes the caller's request at submission, and the
 * posted request is a separate copy an in-process port cannot mutate. */
const copyExpectedFrom = (
  formatVersion: number,
  archiveMeta: ArchiveWorkerExpected['archive'],
  sourceEntries: readonly ArchiveWorkerExpectedEntry[],
  entryTotal: number,
): ArchiveWorkerExpected => {
  // Every argument arrives pre-captured by the caller, so validation and
  // this snapshot observe one collection and one set of scalars; each
  // entry is copied element by element (an Array subclass's overridden
  // map() could return its own collection), so no side shares another's
  // verification basis.
  const entries: ArchiveWorkerExpectedEntry[] = [];
  for (let index = 0; index < entryTotal; index++) {
    entries.push({ ...sourceEntries[index]! });
  }
  return {
    formatVersion,
    archive: copyArchiveMeta(archiveMeta),
    entries,
  };
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
  const pending: { readonly job: number; readonly resolve: () => void }[] = [];
  const acquire = async (job: number): Promise<void> => {
    if (free > 0) {
      free--;
      return;
    }
    await new Promise<void>((resolve) => {
      pending.push({ job, resolve });
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
    waiter.resolve();
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
      // Read the manifest reference exactly once: a switching accessor must
      // not let the preflight validate one manifest while the snapshot
      // copies another.
      const sourceExpected = request.expected;
      const sourceEntries = sourceExpected.entries;
      const sourceEntryTotal = sourceEntries.length;
      const sourceFormatVersion = sourceExpected.formatVersion;
      // Preflight the configuration before snapshotting the manifest: the
      // checks run on the caller's objects without allocating, and a
      // request that can never validate fails before a copied manifest
      // graph or a worker exists. The rejection is surfaced through
      // job.result when the job starts, like every other config error.
      let preflight: { readonly code: ZipDecodeFailureCode; readonly detail: string } | undefined;
      const invalidLimit = invalidArchiveLimit(limits);
      if (invalidLimit !== undefined) {
        preflight = {
          code: 'limit',
          detail: `ZIP decode limit ${invalidLimit.name} must be an integer of at least ${invalidLimit.minimum}`,
        };
      } else if (limits.decodeDeadlineMs > 2 ** 31 - 1) {
        // Arming the platform timer beyond its range would wrap it into
        // firing immediately instead of honoring the configured deadline.
        preflight = {
          code: 'limit',
          detail: 'ZIP decode deadline exceeds the platform timer range',
        };
      } else if (sourceFormatVersion !== PHASER_PACK_DELIVERY_VERSION) {
        preflight = {
          code: 'unsupported-zip',
          detail: `Unsupported archive format version ${JSON.stringify(sourceFormatVersion)}`,
        };
      } else if (sourceEntryTotal === 0) {
        preflight = {
          code: 'invalid-structure',
          detail: 'ZIP v1 delivery archives require at least one expected entry',
        };
      } else if (sourceEntryTotal > limits.entryCount) {
        preflight = {
          code: 'limit',
          detail: `ZIP decode expected manifest has ${sourceEntryTotal} entries, exceeding the entry limit ${limits.entryCount}`,
        };
      } else if (sourceEntryTotal > ZIP_ENTRY_COUNT_CEILING) {
        preflight = {
          code: 'limit',
          detail: `ZIP decode expected manifest has ${sourceEntryTotal} entries, beyond the ZIP v1 entry count ceiling ${ZIP_ENTRY_COUNT_CEILING}`,
        };
      }
      const sourceArchiveMeta = sourceExpected.archive;
      // Rejected requests keep an empty placeholder so nothing retains the
      // copied manifest graph.
      const rejectedManifest = (): ArchiveWorkerExpected => ({
        formatVersion: sourceFormatVersion,
        archive: copyArchiveMeta(sourceArchiveMeta),
        entries: [],
      });
      let expected: ArchiveWorkerExpected = preflight === undefined
        ? copyExpectedFrom(
          sourceFormatVersion,
          sourceArchiveMeta,
          sourceEntries,
          sourceEntryTotal,
        )
        : rejectedManifest();
      // The path-bound scan runs on the snapshot itself, so exactly one
      // read of each entry decides the bound — the count checks above
      // have already guarded the allocation. A violation releases the
      // copy back to the empty placeholder, matching every other
      // preflight rejection; an already-rejected request skips the scan.
      if (preflight === undefined) {
        for (let index = 0; index < sourceEntryTotal; index++) {
          const entryPath = expected.entries[index]!.path;
          if (entryPath.length > limits.maxPathLength) {
            preflight = {
              code: 'limit',
              detail: `ZIP decode expected manifest has a path longer than the length limit ${limits.maxPathLength}`,
            };
            expected = rejectedManifest();
            break;
          }
        }
      }
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
            // The normalizer always returns a code on the failure
            // statuses that reach this branch; the fallback is kept as
            // defensive future-proofing, not a reachable path.
            normalizeWorkerFailureCode(status.code, status.status) ?? 'worker-error',
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

        // Release the reference before terminating: a retained completed
        // job must not keep the terminated Worker (and the listener-closed
        // job state) strongly reachable, and a throwing terminate must not
        // block the permit return below. The interface exposes no listener
        // removal, so the listeners die with the terminated worker itself.
        const terminated = worker;
        worker = undefined;
        try {
          terminated?.terminate();
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
          // an acknowledgement that never arrived. Release posts spend the
          // job budget, so one that blocks past the deadline settles as the
          // deadline like every other late failure.
          if (!finished) {
            failWorker({
              status: 'worker-error',
              code: 'worker-error',
              detail: `Could not post the entry release: ${safeErrorDetail(error)}`,
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
            detail: `Could not verify ${scope}: ${safeErrorDetail(error)}`,
          });
      };
      /** The result a pull receives once the job has settled. */
      const settledPull = (): Promise<IteratorResult<BoundedZipDecodeEntry>> => {
        if (failure !== undefined) {
          return Promise.reject(failure);
        }
        return Promise.resolve({
          done: true, value: undefined,
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
      /** The status a settlement takes when a cause was already decided:
       * the first cause wins over any later worker report — success,
       * failure or echo. */
      const decidedCauseStatus = (): DecidedCause | undefined => {
        if (firstCause === 'deadline') {
          return { status: 'deadline', code: 'deadline' };
        }
        if (firstCause === 'user') {
          return { status: 'cancelled', code: 'cancelled' };
        }
        return undefined;
      };
      /** A late worker-side failure follows the decided cause: a
       * cancellation or deadline chosen before the failure keeps its
       * status instead of the failure replacing it; the detail is framed
       * by the decided cause so the two cannot read as unrelated, captured
       * worker statistics ride along, and whatever buffer the failure
       * withheld is reported as lost by the settlement. */
      const frameLateDetail = (detail: string | undefined, prefix: string, fallback: string): string =>
        detail !== undefined ? `${prefix}; ${detail}` : fallback;
      const translateLateFailure = (
        failure: WorkerFailureStatus,
      ): WorkerFailureStatus
      | (DecidedCause & {
        readonly detail: string;
        readonly stats?: ArchiveWorkerStats | undefined;
      }) => {
        observeDeadline();
        const decided = decidedCauseStatus();
        if (decided === undefined) {
          return failure;
        }
        return {
          ...decided,
          detail: decided.status === 'cancelled'
            ? frameLateDetail(failure.detail, 'Cancellation was decided first', failure.detail)
            : frameLateDetail(failure.detail, 'The deadline was decided first', failure.detail),
          ...(terminalStats !== undefined ? { stats: terminalStats } : {}),
        };
      };
      /** Settle a worker-side protocol failure (malformed message, violated
       * check, crash) under the decided cause. */
      const failWorker = (failure: WorkerFailureStatus): void => {
        finalize(translateLateFailure(failure));
      };
      const start = async (): Promise<void> => {
        await acquire(jobId);
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
        // Configuration problems preflighted at decode() time — invalid
        // limits, unsupported manifest versions, unvalidatable manifest
        // bounds — surface here through job.result, like every other
        // config error; a custom worker runs no core, so the client
        // boundary performs the core's validation itself.
        if (preflight !== undefined) {
          finalize({
            status: 'error',
            code: preflight.code,
            detail: preflight.detail,
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
          // Worker creation spends the job budget: a factory that blocks
          // past the deadline and then throws settles as the deadline, not
          // as an environment failure.
          failWorker({
            status: 'unsupported',
            code: 'unsupported',
            detail: `Cannot create the archive decode worker: ${safeErrorDetail(error)}`,
          });
          return;
        }
        const handleMessage = (event: MessageEvent<ArchiveWorkerResponse>): void => {
          if (terminalSeen) {
            // A terminal response was accepted; everything racing its
            // archive-digest verification is ignored, malformed or not.
            return;
          }
          const message = event.data;
          if (typeof message !== 'object' || message === null) {
            failWorker({
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
            failWorker({
              status: 'worker-error',
              code: 'worker-error',
              detail: `The archive decode worker posted an unknown message type ${described}`,
            });
            return;
          }
          if (messageType === 'entry') {
            // Read every field exactly once and validate the captured
            // values: switching accessors must not let the shape check
            // approve one value while later logic uses another.
            const entryMessage = message as Extract<ArchiveWorkerResponse, { readonly type: 'entry' }>;
            const rawSeq: unknown = entryMessage.seq;
            const rawPath: unknown = entryMessage.path;
            const rawMethod: unknown = entryMessage.method;
            const rawBytes: unknown = entryMessage.bytes;
            const entryShapeValid = typeof rawSeq === 'number'
              && Number.isSafeInteger(rawSeq)
              && typeof rawPath === 'string'
              && (rawMethod === 'store' || rawMethod === 'deflate')
              && acceptWorkerBuffer(rawBytes);
            if (!entryShapeValid) {
              failWorker({
                status: 'worker-error',
                code: 'worker-error',
                detail: 'The archive decode worker posted a malformed entry message',
              });
              return;
            }
            // Freeze the fields later reads use — the digest continuation
            // and the delivered entry: an in-process worker can mutate its
            // response object, or expose it through switching accessors.
            const seq = rawSeq;
            const path = rawPath;
            const method = rawMethod;
            const bytesBuffer = rawBytes;
            const bytesLength = bytesBuffer.byteLength;
            if (seq !== outstandingSeq + 1) {
              failWorker({
                status: 'worker-error',
                code: 'worker-error',
                detail: `The archive decode worker skipped entry sequence ${outstandingSeq + 1}`,
              });
              return;
            }
            if (outstandingSeq > releasedSeq) {
              // An entry delivered before the previous one was released
              // exceeds the one-outstanding-entry credit.
              failWorker({
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
              || method !== expectedEntry.method
              || bytesLength !== expectedEntry.bytes
            ) {
              // A version-skewed or custom worker must not be able to swap
              // files under a decode that still reports success.
              failWorker({
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
              failWorker({
                status: 'error',
                code: 'limit',
                detail: `Delivered entry ${seq} path exceeds the length limit ${limits.maxPathLength}`,
              });
              return;
            }
            if (bytesLength > limits.entryBytes) {
              failWorker({
                status: 'error',
                code: 'limit',
                detail: `Delivered entry ${seq} exceeds the per-entry byte limit ${limits.entryBytes}`,
              });
              return;
            }
            if (seq > limits.entryCount) {
              failWorker({
                status: 'error',
                code: 'limit',
                detail: `Delivered entry ${seq} exceeds the entry count limit ${limits.entryCount}`,
              });
              return;
            }
            deliveredBytes += bytesLength;
            if (deliveredBytes > limits.totalExpandedBytes) {
              failWorker({
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
              entryBytes = new Uint8Array(copyBufferBytes(bytesBuffer, expectedEntry.bytes));
            } catch (error) {
              failWorker({
                status: 'worker-error',
                code: 'worker-error',
                detail: `The archive decode worker delivered entry ${seq} with an undeliverable buffer: ${safeErrorDetail(error)}`,
              });
              return;
            }
            const value: BoundedZipDecodeEntry = {
              path,
              method,
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
                  failWorker({
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
                  failWorker({
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
          if (messageType === 'done') {
            // Read every terminal field exactly once: a switching
            // accessor must not let the shape check validate one status
            // while the settlement snapshots another.
            const doneMessage = message as Extract<ArchiveWorkerResponse, { readonly type: 'done' }>;
            const doneStatus = doneMessage.status;
            const doneArchive = doneMessage.archive;
            const doneCode = doneMessage.code;
            const doneDetail = doneMessage.detail;
            const doneStats = doneMessage.stats;
            const statsIsObject = typeof doneStats === 'object' && doneStats !== null;
            const doneStatEntries = statsIsObject ? doneStats.entries : undefined;
            const doneStatExpanded = statsIsObject ? doneStats.expandedBytes : undefined;
            const doneStatElapsed = statsIsObject ? doneStats.elapsedMs : undefined;
            const doneShapeValid = typeof doneStatus === 'string'
              && (doneArchive === undefined || acceptWorkerBuffer(doneArchive))
              && (doneStatus === 'completed'
                || doneStatus === 'cancelled'
                || doneStatus === 'deadline'
                || doneStatus === 'error')
              && (doneStatus !== 'completed'
                || transfer === (doneArchive !== undefined))
              && (doneCode === undefined || typeof doneCode === 'string')
              && (doneDetail === undefined || typeof doneDetail === 'string')
              && validCounter(doneStatEntries)
              && validCounter(doneStatExpanded)
              && validElapsed(doneStatElapsed);
            if (!doneShapeValid) {
              failWorker({
                status: 'worker-error',
                code: 'worker-error',
                detail: 'The archive decode worker posted a malformed done message',
              });
              return;
            }
            // An in-process worker can retain and mutate the response
            // object after emit() returns; settlements must ride on the
            // fields that were validated, not on whatever the object says
            // later. Snapshotting before the archive checks also lets
            // late-failure translations preserve the worker's statistics.
            const terminal: {
              status: ArchiveWorkerStatus;
              code: string | undefined;
              detail: string | undefined;
              stats: ArchiveWorkerStats;
            } = {
              status: doneStatus,
              code: doneCode,
              detail: doneDetail,
              // The shape check above validated each counter as a
              // non-negative number; the casts only carry that fact.
              stats: {
                entries: doneStatEntries as number,
                expandedBytes: doneStatExpanded as number,
                elapsedMs: doneStatElapsed as number,
              },
            };
            // The terminal is accepted from here: any reentrant response to
            // the deadline translation's cooperative cancel must not
            // displace it, clone mode included.
            terminalSeen = true;
            terminalStats = terminal.stats;
            let returnedLength: number;
            try {
              returnedLength = doneArchive === undefined ? -1 : doneArchive.byteLength;
            } catch (error) {
              // A throwing byteLength getter must settle the job through
              // the failure path instead of escaping the listener after
              // the terminal was accepted.
              failWorker({
                status: 'worker-error',
                code: 'worker-error',
                detail: `The archive decode worker returned an archive buffer whose length could not be read: ${safeErrorDetail(error)}`,
              });
              return;
            }
            if (transfer && doneArchive !== undefined && returnedLength !== archiveByteLength) {
              // A different-length buffer cannot be the caller's detached
              // archive, so ownership was not restored.
              failWorker({
                status: 'worker-error',
                code: 'worker-error',
                detail: 'The archive decode worker returned an archive buffer that is not the transported archive',
              });
              return;
            }
            // A completion is only accepted when its metadata matches the
            // delivery the client actually verified. The rejection is
            // settled after any returned archive is authenticated, so a
            // recoverable snapshot is still restored alongside it.
            let completionRejection: WorkerFailureStatus | undefined;
            if (terminal.status === 'completed') {
              if (outstandingSeq > releasedSeq) {
                completionRejection = {
                  status: 'worker-error',
                  code: 'worker-error',
                  detail: 'The archive decode worker completed with an unreleased entry outstanding',
                };
              } else if (verifiedEntries !== expected.entries.length) {
                completionRejection = {
                  status: 'worker-error',
                  code: 'worker-error',
                  detail: 'The archive decode worker completed without delivering every expected entry',
                };
              } else if (
                archiveByteLength !== expected.archive.bytes
                || submittedArchiveDigest === undefined
                || submittedArchiveDigest !== expected.archive.sha256
              ) {
                // A custom worker runs no core: without this check it could
                // complete an archive the manifest rejects. Archive
                // integrity is mandatory on every path.
                completionRejection = {
                  status: 'error',
                  code: 'archive-mismatch',
                  detail: 'The archive decode worker completed an archive that does not match the expected manifest archive',
                };
              } else if (
                terminal.stats.entries !== verifiedEntries
                || terminal.stats.expandedBytes !== deliveredBytes
              ) {
                // The client observed the real delivery; a completion must
                // not report measurements it did not verify.
                completionRejection = {
                  status: 'worker-error',
                  code: 'worker-error',
                  detail: 'The archive decode worker completed with statistics that do not match the delivered output',
                };
              }
            }
            // A cancellation answering this client's own deadline timer is a
            // deadline, unless the user asked to cancel first; a completion
            // arriving after the deadline guard fired is one too. Worker
            // errors carrying the unsupported code keep the public status
            // callers use for unavailable platform capabilities.
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
              // decided cause; a late worker status cannot replace it, and
              // a late failure's own detail is framed by the cause instead
              // of being discarded.
              const decided = decidedCauseStatus();
              if (decided?.status === 'deadline') {
                return deadlineTranslate(terminal.status === 'completed'
                  ? 'The archive decode worker completed after the decode deadline fired'
                  : frameLateDetail(terminal.detail, 'The deadline was decided first', DEADLINE_MISS_DETAIL));
              }
              if (decided?.status === 'cancelled' && terminal.status !== 'cancelled') {
                return {
                  status: 'cancelled',
                  code: 'cancelled',
                  detail: terminal.status === 'completed'
                    ? 'The archive decode worker completed after cancellation was requested'
                    : frameLateDetail(
                      terminal.detail,
                      'Cancellation was decided first',
                      `The archive decode worker reported ${terminal.status} after cancellation was requested`,
                    ),
                };
              }
              if (terminal.status === 'error' && terminal.code === 'unsupported') {
                return {
                  status: 'unsupported', code: 'unsupported', detail: terminal.detail,
                };
              }
              // A worker-originated failure carries a code even when the
              // optional field is missing, so the iterator's ZipDecodeError
              // and job.result agree on the failure.
              return {
                status: terminal.status,
                code: normalizeWorkerFailureCode(terminal.code, terminal.status),
                detail: terminal.detail,
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
            if (transfer && doneArchive !== undefined) {
              // A same-length substitute buffer would silently replace the
              // caller's archive, so ownership is only restored after the
              // digest matches the bytes actually submitted (which may
              // legitimately differ from the manifest); done is terminal,
              // so messages racing the hash are ignored. The buffer is
              // snapshotted so a worker retaining its storage cannot
              // mutate it after verification.
              let returned: ArrayBuffer;
              try {
                returned = copyBufferBytes(doneArchive, archiveByteLength);
              } catch (error) {
                // An unrecoverable buffer must settle the job instead of
                // escaping the listener and stalling every pending pull.
                failWorker({
                  status: 'worker-error',
                  code: 'worker-error',
                  detail: `The archive decode worker returned an archive buffer that could not be recovered: ${safeErrorDetail(error)}`,
                });
                return;
              }
              void digestOf(new Uint8Array(returned)).then(
                (digest) => {
                  if (finished) {
                    return;
                  }
                  if (
                    submittedArchiveDigest === undefined
                    || digest !== submittedArchiveDigest
                  ) {
                    failWorker({
                      status: 'worker-error',
                      code: 'worker-error',
                      detail: 'The archive decode worker returned an archive buffer that is not the transported archive',
                    });
                    return;
                  }
                  if (completionRejection !== undefined) {
                    // The buffer is authenticated as the caller's own
                    // submission, so ownership is restored even though the
                    // completion metadata was rejected.
                    finalize({
                      ...translateLateFailure(completionRejection),
                      stats: terminal.stats,
                      archiveBuffer: returned,
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
                  failWorker(error instanceof ZipDecodeError
                    ? {
                      status: 'error', code: error.code, detail: error.message,
                    }
                    : {
                      status: 'worker-error',
                      code: 'worker-error',
                      detail: `Could not verify the returned archive: ${safeErrorDetail(error)}`,
                    });
                },
              );
              return;
            }
            if (completionRejection !== undefined) {
              failWorker(completionRejection);
              return;
            }
            settle();
          }
        };
        worker.addEventListener('message', (event) => {
          // The whole boundary is capture-guarded: a getter on event.data,
          // a message field or a stats counter that throws must settle the
          // job through the common failure path instead of escaping the
          // listener and stalling pending pulls and the concurrency slot.
          try {
            handleMessage(event);
          } catch (error) {
            // A throw after a terminal was accepted is intentionally not
            // settled here: every read between terminalSeen and settlement
            // is individually guarded, and the accepted terminal's own
            // verification (or the forced-settlement backstop) owns the
            // job from that point.
            if (!finished && !terminalSeen) {
              failWorker({
                status: 'worker-error',
                code: 'worker-error',
                detail: `The archive decode worker posted a message that could not be read: ${safeErrorDetail(error)}`,
              });
            }
          }
        });

        const onWorkerFailure = (): void => {
          if (terminalSeen) {
            // A terminal response was accepted and only its archive digest
            // verification is pending; later worker lifecycle events cannot
            // change that settlement.
            return;
          }
          failWorker({
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
          // Constructing the payload spends the job budget; a blocking
          // subclass getter that throws past the deadline settles as the
          // deadline like every other late startup failure.
          failWorker(error instanceof ZipDecodeError
            ? {
              status: 'error', code: error.code, detail: error.message,
            }
            : {
              status: 'error', code: 'unsupported', detail: safeErrorDetail(error),
            });
          return;
        }
        if (transfer) {
          // Freeze the submission before the async hash: the digest and the
          // transferred bytes must describe the same immutable snapshot
          // even if the caller mutates its view while hashing runs. The
          // frozen copy is what gets transferred and later returned.
          archivePayload = copyBufferBytes(archivePayload, archiveByteLength);
        }
        // Both transport modes digest the submission: transfer mode
        // authenticates the returned buffer with it, and every mode needs
        // it so a custom worker that skips the core's archive-integrity
        // check cannot complete an archive the manifest rejects. The hash
        // spends the same absolute deadline.
        try {
          submittedArchiveDigest = await digestOf(new Uint8Array(archivePayload));
        } catch (error) {
          // A cause decided while the hash pended keeps its settlement:
          // the hash failure follows the decided ending like any other
          // late failure.
          if (error instanceof ZipDecodeError && error.code === 'unsupported') {
            failWorker({
              status: 'unsupported', code: 'unsupported', detail: error.message,
            });
          } else if (error instanceof ZipDecodeError) {
            failWorker({
              status: 'error', code: error.code, detail: error.message,
            });
          } else {
            failWorker({
              status: 'worker-error',
              code: 'worker-error',
              detail: `Could not hash the archive for submission: ${safeErrorDetail(error)}`,
            });
          }
          return;
        }
        // The hash await yields to the event loop: honour a settlement
        // that landed while hashing instead of submitting the buffer
        // anyway. The first cause wins, matching the terminal-response
        // translation.
        if (finished) {
          return;
        }
        if (preSubmitGuard()) {
          return;
        }
        // Copy the manifest and limits for the worker: an in-process port
        // shares nothing with the client's verification basis, so it cannot
        // mutate the checks its own responses are judged against.
        const postedEntries = expected.entries;
        const postedExpected = copyExpectedFrom(
          expected.formatVersion,
          expected.archive,
          postedEntries,
          postedEntries.length,
        );
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
          // A throwing post does not consume the transfer list, so the
          // submission may still be recoverable. Verify it like every
          // other restoration path — the digest also catches an in-place
          // mutation of a subclassed buffer between the pre-submit hash
          // and the failed post — before returning it with the settlement.
          let restored: ArrayBuffer | undefined;
          let restoreFailure: string | undefined;
          if (!finished && transfer && archivePayload.byteLength === archiveByteLength) {
            try {
              // Copy synchronously before any await: whatever verifies
              // below is a client-owned snapshot an in-process port can
              // no longer reach, even one that stashed the payload from
              // the transfer list and still threw. The copy shares the
              // try so an allocation failure settles the same way.
              const candidate = copyBufferBytes(archivePayload, archiveByteLength);
              const redigest = await digestOf(new Uint8Array(candidate));
              if (redigest === submittedArchiveDigest) {
                restored = candidate;
              } else {
                restoreFailure = 'the submission digest no longer matches';
              }
            } catch (restoreError) {
              // An unverifiable buffer is reported as lost below, with the
              // reason attached for debugging ownership loss.
              restoreFailure = safeErrorDetail(restoreError);
            }
          }
          // A settlement landing while the re-digest pends has already
          // reported the archive conservatively as lost; finalize is
          // idempotent, so the verified snapshot is abandoned in that race
          // instead of resurrecting a decided settlement.
          if (!finished) {
            // Posting the decode request spends the job budget: a post
            // that blocks past the deadline and then throws settles as
            // the deadline, like every other late failure.
            finalize({
              ...translateLateFailure({
                status: 'worker-error',
                code: 'worker-error',
                detail: restoreFailure === undefined
                  ? `Could not post the decode request: ${safeErrorDetail(error)}`
                  : `Could not post the decode request: ${safeErrorDetail(error)}; the submission could not be restored (${restoreFailure})`,
              }),
              ...(restored !== undefined ? { archiveBuffer: restored } : {}),
            });
          }
          return;
        }
      };
      void start().catch((error) => {
        // Unexpected startup failures — a throwing transfer snapshot or
        // listener registration — follow the decided cause when the budget
        // already elapsed while they ran.
        failWorker({
          status: 'worker-error',
          code: 'worker-error',
          detail: `Starting the decode job failed: ${safeErrorDetail(error)}`,
        });
      });
      const iterator: AsyncIterator<BoundedZipDecodeEntry> = {
        next: (): Promise<IteratorResult<BoundedZipDecodeEntry>> => {
          if (finished) {
            return settledPull();
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
          if (buffered !== undefined && !cancelRequested && !observeDeadline()) {
            // Release at handout: the consumer owns the bytes now, so the
            // credit is never spent on an unverified message while the
            // worker may still decode one entry ahead. The deadline is
            // re-read from the clock here — the timer cannot fire while
            // the caller's long-running task still holds the thread — so
            // a buffered entry cannot surface past the elapsed budget.
            // Once a cancellation or deadline settlement has begun, the
            // settlement resolves the pull instead of surfacing more
            // output.
            postRelease(bufferedCapturedSeq);
            return Promise.resolve({
              done: false, value: buffered,
            });
          }
          if (finished) {
            // Observing the deadline can finalize reentrantly (an
            // in-process worker may answer the cooperative cancel inside
            // the post); a pull registered after that would never settle.
            return settledPull();
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
          if (!slotAcquired) {
            // A queued or not-yet-started job owns no worker, buffer or
            // timer: nothing needs the cooperative cleanup window, and
            // leaving its waiter in the queue would retain the job until
            // an unrelated job frees a slot.
            const index = pending.findIndex((waiter) => waiter.job === jobId);
            if (index !== -1) {
              pending.splice(index, 1);
            }
            finalize({
              status: 'cancelled',
              code: 'cancelled',
            });
            return result;
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
