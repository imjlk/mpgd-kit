import {
  createBoundedZipDecoder,
  defaultArchiveWorkerLimits,
  ZipDecodeError,
  type ArchiveWorkerExpected,
  type ArchiveWorkerStatus,
  type ZipDecodeWorkerLike,
} from './archives.js';
import {
  PHASER_PACK_DELIVERY_VERSION,
  validatePhaserPackDeliveryManifest,
  type PhaserPackDeliveryManifest,
  type PhaserPackDeliveryPack,
} from './pack-format.js';
import type {
  PhaserAssetPack,
  PhaserPackAsset,
  PhaserPackFileBody,
  PhaserPackFileIntegrity,
  PhaserPackFileSource,
} from './packs.js';

/**
 * Prepared pack delivery: turns a delivery manifest (the `mpgd assets
 * build-packs` output) into the loader catalog plus a file source, staging
 * ZIP packs through the bounded decoder (#191) and serving `files` packs
 * over plain HTTP. Creating a delivery performs no network request, spawns
 * no worker and arms no timer; those start with `prepare` and file reads.
 *
 * The intended lifecycle with the existing loader:
 *
 * ```ts
 * const delivery = createPhaserPackDelivery(manifest, options);
 * const loader = createPhaserAssetPackLoader(scene, delivery.catalog, {
 *   ...loaderOptions, fileSource: delivery.fileSource,
 * });
 * const prepared = await delivery.prepare(packId, { signal });
 * try {
 *   const lease = await loader.acquire(packId, { signal });
 *   // ... gameplay owns the lease ...
 * } finally {
 *   prepared.release(); // staging returns; textures survive via the lease
 * }
 * ```
 *
 * Requires a browser-like environment (fetch, Blob, crypto.subtle); the
 * worker itself is deployed by the application and supplied through
 * `createWorker`, never extracted from an asset archive.
 *
 * The whole-prepare budget is measured on one monotonic clock: it starts
 * once per prepare, is never restarted by a later archive, hands the
 * decoder only the unspent (floored) remainder, refuses to start new
 * work once spent, and refuses to certify a result that lands after it
 * is spent. The supported guarantee is elapsed-time enforcement and
 * result acceptance, not real-time termination of running work.
 */

/** Elapsed-time source for every delivery deadline and remaining-budget
 * computation: one monotonic clock, so a wall-clock correction mid-prepare
 * can neither extend nor shrink a budget. Display timestamps would stay on
 * `Date.now()`; budgets never touch it. Tests drive this through the
 * environment's `performance` (fake timers or a spy), not a public option. */
const monotonicNow = (): number => performance.now();

/** Per-operation observation state: one monotonic sequence and a
 * terminal-once latch, so a superseded operation's late progress can
 * never be mistaken for a live one and terminals never repeat. */
interface OperationTracker {
  nextEvent(
    phase: PhaserPackDeliveryEventPhase,
    fields: Omit<PhaserPackDeliveryEvent, 'operationId' | 'kind' | 'sequence' | 'phase'>,
  ): PhaserPackDeliveryEvent | undefined;
}

const createOperationTracker = (
  operationId: number,
  kind: 'prepare' | 'file-read',
  emit: (event: PhaserPackDeliveryEvent) => void,
): OperationTracker => {
  let sequence = 0;
  let done = false;
  return {
    nextEvent(phase, fields) {
      if (done) {
        return undefined;
      }
      if (phase === 'prepared' || phase === 'completed' || phase === 'failed'
        || phase === 'cancelled' || phase === 'disposed') {
        done = true;
      }
      sequence += 1;
      const event: PhaserPackDeliveryEvent = {
        operationId,
        kind,
        sequence,
        ...fields,
        phase,
      };
      emit(event);
      return event;
    },
  };
};

/** Failure categories a delivery operation can surface. Decoder statuses
 * and codes are preserved inside the message; the category stays stable for
 * programmatic handling. */
export type PhaserPackDeliveryErrorCode =
  | 'config'
  | 'not-prepared'
  | 'busy'
  | 'budget'
  | 'transport'
  | 'integrity'
  | 'cancelled'
  | 'deadline'
  | 'disposed';

/** Structured, serializable failure context. Only fields actually
 * observed at the failing execution point are set — absent means
 * unknown, never guessed. Values are primitives or absent optional
 * fields only: no URLs (queries may carry credentials), no Response
 * objects, no nested Error instances. Programs branch on `code` and
 * these details; `message` stays human-oriented. */
export interface PhaserPackDeliveryErrorDetails {
  /** Which prepare/file-read stage the failure was observed in. */
  readonly stage?: 'planning' | 'downloading' | 'decoding-and-verifying';
  /** Correlation id of the observing operation within this delivery. */
  readonly operationId?: number;
  /** Which kind of operation failed. */
  readonly kind?: 'prepare' | 'file-read';
  readonly packId?: string;
  readonly revision?: string;
  readonly assetKey?: string;
  readonly role?: string;
  /** HTTP status of a non-OK delivery response, when one was received. */
  readonly httpStatus?: number;
  /** Terminal #191 decoder status, when a decode job reported one;
   * `unsupported` and `worker-error` are the client-side terminal
   * statuses for environment and worker failures. */
  readonly decoderStatus?: ArchiveWorkerStatus | 'unsupported' | 'worker-error';
  /** The #191 core failure code, when the decoder surfaced one. */
  readonly decoderCode?: string;
  /** Manifest-declared bytes for the object whose size mismatched. */
  readonly expectedBytes?: number;
  /** Bytes actually observed for that object. */
  readonly receivedBytes?: number;
}

/** Every delivery failure carries one stable code; `details` keeps the
 * underlying cause (HTTP status, digest mismatch, decoder status/code)
 * as data instead of a parsed message. The constructor stays backward
 * compatible: existing two-argument calls keep working. */
export class PhaserPackDeliveryError extends Error {
  /** Stable failure category. */
  readonly code: PhaserPackDeliveryErrorCode;
  /** Safe structured context; programs read this and `code`, never
   * `message`. */
  readonly details: Readonly<PhaserPackDeliveryErrorDetails>;

  constructor(
    code: PhaserPackDeliveryErrorCode,
    message: string,
    details?: PhaserPackDeliveryErrorDetails,
  ) {
    super(message);
    // Keep the class name visible in stacks and error.name checks.
    this.name = 'PhaserPackDeliveryError';
    this.code = code;
    this.details = details ?? {};
  }

  /** A copy with extra details layered over the existing ones; used at
   * operation boundaries where the correlation id becomes known. */
  withDetails(extra: PhaserPackDeliveryErrorDetails): PhaserPackDeliveryError {
    return new PhaserPackDeliveryError(this.code, this.message, {
      ...this.details,
      ...extra,
    });
  }
}

/** Progress phases actually observed by the delivery. They describe
 * delivery work only: `prepared` means the ZIP staging completed, never
 * that the loader finished decoding images — combine with the loader's
 * own progress for that. Internal hashing and inflate percentages are
 * not observable through the #191 contract and are never fabricated. */
export type PhaserPackDeliveryEventPhase =
  | 'planning'
  | 'downloading'
  | 'decoding-and-verifying'
  | 'prepared'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'disposed';

/** Measured progress only. Every field is optional and absent when the
 * delivery has no observation for it (absent means unknown, never a
 * guess or a Content-Length-derived certainty); the values are kept
 * per-stage and are never merged into one synthetic 0-100 number. */
export interface PhaserPackDeliveryProgress {
  /** Body bytes the network stream actually delivered to the
   * application for the object being read (not wire-transfer bytes). */
  readonly bodyBytes?: number;
  /** The manifest's declared byte size of that object. */
  readonly expectedBodyBytes?: number;
  /** Expanded entry bytes the decoder verified so far this archive. */
  readonly entryBytes?: number;
  /** Entries verified so far this archive. */
  readonly entriesVerified?: number;
  /** Manifest entry count of the archive being decoded. */
  readonly expectedEntries?: number;
}

/** One observation about one delivery operation. Terminal phases
 * (`prepared`, `completed`, `failed`, `cancelled`, `disposed`) are
 * emitted exactly once per operation, and no further events follow
 * them for that operation. */
export interface PhaserPackDeliveryEvent {
  /** Correlation id, unique per operation within this delivery's
   * lifetime (a monotonic counter). It is not an idempotency key and
   * carries no meaning across deliveries. */
  readonly operationId: number;
  readonly kind: 'prepare' | 'file-read';
  /** 1-based order of this event within its operation. */
  readonly sequence: number;
  readonly packId: string;
  readonly revision: string;
  readonly phase: PhaserPackDeliveryEventPhase;
  readonly assetKey?: string;
  readonly role?: string;
  readonly progress?: Readonly<PhaserPackDeliveryProgress>;
  /** Present on `failed`, `cancelled` and `disposed` terminals: the
   * stable error code and its safe structured details. */
  readonly error?: {
    readonly code: PhaserPackDeliveryErrorCode;
    readonly details: Readonly<PhaserPackDeliveryErrorDetails>;
  };
}

/** Observation listener. Called synchronously; a throwing or rejecting
 * listener never changes delivery results — exceptions are contained
 * and rejected promises are handled, never awaited. */
export type PhaserPackDeliveryListener = (event: PhaserPackDeliveryEvent) => void;

export interface PhaserPackDeliveryOptions {
  /** Base URL manifest artifact paths resolve against. The delivery encodes
   * each path segment exactly once before resolving, so revisions and file
   * names carrying `#`, `?`, spaces or non-ASCII address the resource the
   * static host serves. Mutually exclusive with `resolveURL`. */
  readonly baseUrl?: string;
  /** Custom artifact URL resolver; receives the once-encoded path and the
   * pack context, and returns the final URL. Mutually exclusive with
   * `baseUrl`. */
  readonly resolveURL?: (path: string, context: {
    readonly packId: string;
    readonly revision: string;
  }) => string;
  /** Factory for the application-deployed module worker (#191 contract).
   * Required when the manifest contains zip-delivery packs; never called
   * for files-only manifests. */
  readonly createWorker?: () => ZipDecodeWorkerLike;
  /** Finite cap on simultaneously staged archive+expanded bytes.
   * Default: 64 MiB. Independent of the loader's own byte budget. */
  readonly stagingBudgetBytes?: number;
  /** Deadline for one whole prepare; stages never restart it and the
   * decoder receives only the unspent remainder. Default: 15 s. */
  readonly prepareTimeoutMs?: number;
  /** Per HTTP attempt deadline — each archive and files-delivery file; the
   * window ends with the body. Default: 10 s. */
  readonly requestTimeoutMs?: number;
  /** Per-file transport cap for files-delivery packs. Default: 32 MiB. */
  readonly maxFileBytes?: number;
  /** Browser HTTP cache policy for delivery requests. Default no-store;
   * use default for immutable artifact URLs. */
  readonly requestCache?: 'default' | 'no-store' | 'reload';
}

export interface PreparedPhaserPack {
  /** Return this preparation's stake in the staged packs. Bytes survive
   * while another handle or an open reader still references them;
   * registered textures are unaffected. Idempotent. */
  release(): void;
}

export interface PhaserPackDeliveryStaging {
  readonly packId: string;
  readonly revision: string;
  readonly handles: number;
  readonly openReaders: number;
  readonly reservationBytes: number;
}

export interface PhaserPackDeliverySnapshot {
  readonly stagingUsedBytes: number;
  readonly stagingBudgetBytes: number;
  readonly archiveRequests: number;
  readonly fileRequests: number;
  readonly staging: readonly PhaserPackDeliveryStaging[];
}

export interface PhaserPackDelivery {
  /** Loader catalog derived once from the delivery manifest. */
  readonly catalog: readonly PhaserAssetPack[];
  /** The observation API: registers a listener for prepare and
   * files-delivery read work observed from this call onward. Returns an
   * idempotent unsubscribe. This is the single observation surface —
   * there is no separate onProgress callback. */
  subscribe(listener: PhaserPackDeliveryListener): () => void;
  /** Supplies staged ZIP entries; files-delivery packs stay plain HTTP. */
  readonly fileSource: PhaserPackFileSource;
  /** Stage a pack and its dependency closure. Single-flight: a concurrent
   * prepare rejects with a busy error instead of racing the budget. A
   * files-only closure is a light no-op that touches no network or worker. */
  prepare(packId: string, options?: { readonly signal?: AbortSignal }): Promise<PreparedPhaserPack>;
  /** Stop everything: aborts an active prepare and drops all staging. */
  dispose(): void;
  snapshot(): PhaserPackDeliverySnapshot;
}

interface RoleFile {
  readonly mediaType: string;
  readonly path: string;
}

interface PackIndexEntry {
  readonly pack: PhaserPackDeliveryPack;
  /** `${assetKey}\u0000${role}` → media type and delivery file path. */
  readonly roles: ReadonlyMap<string, RoleFile>;
}

interface StagedPack {
  readonly pack: PhaserPackDeliveryPack;
  readonly files: ReadonlyMap<string, { readonly bytes: Uint8Array; readonly mediaType: string }>;
  readonly reservationBytes: number;
  handles: number;
  openReaders: number;
}

/** Combine two abort signals with first-abort-wins reason forwarding; a
 * manual bridge for environments without AbortSignal.any. */
const bridgeSignals = (
  primary: AbortSignal,
  secondary: AbortSignal,
): { readonly signal: AbortSignal; readonly dispose: () => void } => {
  if (typeof AbortSignal.any === 'function') {
    return { signal: AbortSignal.any([primary, secondary]), dispose: () => undefined };
  }
  const controller = new AbortController();
  const forward = (event: Event): void => {
    controller.abort((event.target as AbortSignal).reason);
  };
  if (primary.aborted) {
    controller.abort(primary.reason);
  } else if (secondary.aborted) {
    controller.abort(secondary.reason);
  } else {
    primary.addEventListener('abort', forward, { once: true });
    secondary.addEventListener('abort', forward, { once: true });
  }
  return {
    signal: controller.signal,
    dispose(): void {
      // A completed read must detach its bridge so the delivery-lifetime
      // shutdown signal never accumulates listeners across reads.
      primary.removeEventListener('abort', forward);
      secondary.removeEventListener('abort', forward);
    },
  };
};

/** Internal capped read keeping the declared-size error wording and the
 * already-acquired reader; the loop itself lives once, in the exported
 * helper. */
const readCapped = async (
  response: Response,
  reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
  cap: number,
  declaredBytes?: number | undefined,
  onBodyBytes?: (received: number) => void,
): Promise<Uint8Array> => readCappedDeliveryBody(response, cap, {
  reader,
  describeOverrun: (): string => declaredError(declaredBytes, cap),
  ...(onBodyBytes === undefined ? {} : { onBodyBytes }),
});

const fail = (
  code: PhaserPackDeliveryErrorCode,
  message: string,
  details?: PhaserPackDeliveryErrorDetails,
): never => {
  throw new PhaserPackDeliveryError(code, message, details);
};

/** The Blob constructor copies exactly the view's span by spec, so staged
 * bytes need no extra pre-copy; the cast carries the ArrayBufferLike
 * typing of Node's DOM lib. */
const toBlob = (bytes: Uint8Array, mediaType: string): Blob =>
  new Blob([bytes as unknown as BlobPart], { type: mediaType });

const positiveInteger = (value: number, label: string): void => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail('config', `Delivery ${label} must be a positive integer`);
  }
};

/** Timeouts feed platform timers: delays beyond 2^31-1 clamp or wrap into
 * firing immediately, so oversized values must fail validation instead of
 * producing instant, misleading deadline errors. */
const timerRangeInteger = (value: number, label: string): void => {
  positiveInteger(value, label);
  if (value > 2 ** 31 - 1) {
    fail('config', `Delivery ${label} exceeds the platform timer range`);
  }
};

/** Distinguish a lying manifest declaration from a transport-cap trip so
 * operators can tell which contract the response violated. */
const declaredError = (declaredBytes: number | undefined, cap: number): string => {
  if (declaredBytes !== undefined && declaredBytes > 0 && declaredBytes <= cap) {
    return 'Delivery response exceeds its declared size';
  }
  return `Delivery response exceeds the transport byte cap (${cap})`;
};

/** Marks the whole-prepare deadline abort so error classification never
 * depends on parsing messages. */
class DeliveryDeadlineAbort extends Error {}

/** Marks a dispose()-caused abort so classification distinguishes it from a
 * caller cancellation without parsing messages. */
class DeliveryDisposedAbort extends Error {}

/** Carries the HTTP status of a non-OK delivery response so catch sites
 * read it as data instead of parsing it out of the message. */
class DeliveryHttpStatusError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
  ) {
    super(message);
  }
}

/** Marks the per-request timeout abort so a race with a later outer-signal
 * abort still classifies the timeout as the first cause. */
class DeliveryRequestTimeout extends Error {
  constructor() {
    super('Delivery request timed out');
  }
}

/** Classify an aborted delivery operation from its abort reason: the
 * deadline sentinel maps to 'deadline', anything else to 'cancelled'. */
const abortCategory = (reason: unknown, contextLabel: string): PhaserPackDeliveryError => {
  if (reason instanceof DeliveryDeadlineAbort) {
    return new PhaserPackDeliveryError('deadline', reason.message);
  }
  if (reason instanceof DeliveryDisposedAbort) {
    return new PhaserPackDeliveryError('disposed', 'Phaser pack delivery is disposed');
  }
  return new PhaserPackDeliveryError('cancelled', `Delivery ${contextLabel} was cancelled`);
};

/** Map the per-request timeout sentinel to its transport delivery
 * error with the resource noun already embedded. */
const requestTimeoutError = (noun: string, id: string): PhaserPackDeliveryError =>
  new PhaserPackDeliveryError('transport', `Delivery ${noun} for ${id} timed out`);

/** Classify a prepare failure: delivery errors pass through, an aborted
 * controller maps to its deadline/cancelled category, and anything else is
 * a transport-stage failure. */
const classifyPrepareFailure = (
  thrown: unknown,
  signal: AbortSignal,
  packId: string,
): PhaserPackDeliveryError => {
  if (thrown instanceof PhaserPackDeliveryError) {
    return thrown;
  }
  if (signal.aborted) {
    return abortCategory(signal.reason, `preparation for ${packId}`);
  }
  return new PhaserPackDeliveryError(
    'transport',
    thrown instanceof Error ? thrown.message : String(thrown),
  );
};

/** Read a response body under an explicit byte cap, cancelling the
 * stream as soon as the cap or any failure ends the read; exported for
 * consumers that fetch their own manifest under the same discipline. */
export const readCappedDeliveryBody = async (
  response: Response,
  cap: number,
  options?: {
    readonly reader?: ReadableStreamDefaultReader<Uint8Array> | undefined;
    readonly describeOverrun?: () => string;
    /** Observation hook: called with the cumulative body bytes the
     * stream delivered to the application, once per network chunk —
     * chunks are already network-sized, so no additional coalescing
     * interval exists. Purely observational. */
    readonly onBodyBytes?: (received: number) => void;
  },
): Promise<Uint8Array> => {
  positiveInteger(cap, 'response cap');
  const overrun = options?.describeOverrun ?? ((): string => `Delivery response exceeds ${cap} bytes`);
  // Key-presence check: an explicit reader: undefined selects the
  // no-stream path, unlike an omitted option which acquires the body's
  // own reader.
  const reader = 'reader' in (options ?? {}) ? options?.reader : response.body?.getReader();
  if (reader === undefined) {
    // No stream available: the cap is only enforceable against an honest
    // Content-Length, so fail closed when the header is missing or already
    // over the cap rather than buffering an unbounded body first.
    // A missing header reads as null; map it to NaN so the guard fires
    // instead of Number('') === 0 slipping through.
    const header = response.headers.get('Content-Length');
    const declaredLength = header === null ? Number.NaN : Number(header);
    if (!Number.isFinite(declaredLength) || declaredLength < 0 || declaredLength > cap) {
      throw new Error(overrun());
    }
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > cap) {
      throw new Error(overrun());
    }
    return new Uint8Array(buffer);
  }
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      received += value.byteLength;
      if (received > cap) {
        throw new Error(overrun());
      }
      chunks.push(value);
      options?.onBodyBytes?.(received);
    }
  } catch (error) {
    // Every failure path cancels the stream so its connection returns to
    // the pool instead of waiting for GC.
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const whole = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    whole.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return whole;
};

/** One HTTP GET whose window ends with the body, not the headers: the
 * attempt controller stays armed while the body streams, an abort cancels
 * the reader, and an undrained error response is cancelled so its
 * connection returns to the pool. */
const fetchWithin = (
  url: string,
  timeoutMs: number,
  signal: AbortSignal,
  requestCache: 'default' | 'no-store' | 'reload',
): {
  readonly response: Promise<Response>;
  readonly body: (
    cap: number,
    declaredBytes?: number | undefined,
    onBodyBytes?: (received: number) => void,
  ) => Promise<Uint8Array>;
  readonly settle: () => void;
} => {
  const controller = new AbortController();
  const timer = setTimeout((): void => controller.abort(new DeliveryRequestTimeout()), timeoutMs);
  // Forward the outer abort's reason (caller cancel, whole-prepare deadline,
  // delivery shutdown) instead of degrading it to a generic AbortError.
  const forward = (): void => controller.abort(signal.reason);
  // A listener attached to an already-aborted signal never fires: an abort
  // that landed while the caller was suspended between awaits must cancel
  // this attempt immediately instead of letting it stream to its timeout.
  if (signal.aborted) {
    forward();
  } else {
    signal.addEventListener('abort', forward, { once: true });
  }
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const attempt = fetch(url, { signal: controller.signal, cache: requestCache, credentials: 'omit' }).then(
    (response) => {
      reader = response.body?.getReader();
      return response;
    },
    (error) => {
      // The attempt controller's reason remembers which abort fired
      // first, even when the outer signal aborted later in the same turn.
      const attemptReason = controller.signal.aborted ? controller.signal.reason : undefined;
      if (attemptReason instanceof DeliveryRequestTimeout) {
        throw attemptReason;
      }
      if (signal.aborted) {
        throw error;
      }
      // Keep the underlying transport failure visible when neither abort
      // fired first.
      throw new Error(`Delivery request failed: ${error instanceof Error ? error.message : String(error)}`);
    },
  );
  const settle = (): void => {
    clearTimeout(timer);
    signal.removeEventListener('abort', forward);
    void reader?.cancel().catch(() => undefined);
  };
  return {
    response: attempt,
    body: async (
      cap: number,
      declaredBytes?: number | undefined,
      onBodyBytes?: (received: number) => void,
    ) => {
      try {
        const response = await attempt;
        return await readCapped(response, reader, cap, declaredBytes, onBodyBytes);
      } catch (error) {
        // A timeout firing mid-body rejects reader.read() with a raw abort
        // on platforms that do not forward reasons into streams; the
        // attempt controller's reason keeps the first-cause ordering.
        if (controller.signal.reason instanceof DeliveryRequestTimeout) {
          throw controller.signal.reason;
        }
        throw error;
      } finally {
        settle();
      }
    },
    settle,
  };
};

/** Headers, capped stream and settle semantics in one place for every
 * delivery call site. */
const fetchDeliveryBytes = async (
  url: string,
  timeoutMs: number,
  signal: AbortSignal,
  requestCache: 'default' | 'no-store' | 'reload',
  cap: number,
  describeFailure: (status: number) => string,
  declaredBytes?: number | undefined,
  onBodyBytes?: (received: number) => void,
): Promise<Uint8Array> => {
  const attempt = fetchWithin(url, timeoutMs, signal, requestCache);
  try {
    const response = await attempt.response;
    if (!response.ok) {
      throw new DeliveryHttpStatusError(describeFailure(response.status), response.status);
    }
    return await attempt.body(cap, declaredBytes, onBodyBytes);
  } finally {
    attempt.settle();
  }
};

/** Uncompressed file bytes of a pack: the single source for the staging
 * reservation, the pre-network budget check and the decoder's total
 * expanded limit, so the three can never drift apart. */
const expandedBytesOf = (pack: PhaserPackDeliveryPack): number => pack.assets
  .flatMap((asset) => asset.files)
  .reduce((sum, file) => sum + file.bytes, 0);

const integrityOf = (file: { readonly bytes: number; readonly sha256: string }): PhaserPackFileIntegrity => ({
  bytes: file.bytes,
  sha256: file.sha256,
});

const loaderAsset = (
  pack: PhaserPackDeliveryPack,
  asset: PhaserPackDeliveryPack['assets'][number],
): PhaserPackAsset => {
  // The validated snapshot guarantees the role pairing per asset kind.
  const fileFor = (role: 'texture' | 'atlas') => asset.files.find(
    (candidate) => candidate.role === role,
  )!;
  const texture = fileFor('texture');
  if (asset.kind === 'atlas') {
    const atlas = fileFor('atlas');
    return {
      kind: 'atlas',
      key: asset.assetKey,
      textureUrl: texture.path,
      atlasUrl: atlas.path,
      integrity: { texture: integrityOf(texture), atlas: integrityOf(atlas) },
    };
  }
  if (asset.kind === 'spritesheet') {
    const config = asset.frameConfig!;
    return {
      kind: 'spritesheet',
      key: asset.assetKey,
      url: texture.path,
      frameConfig: {
        frameWidth: config.frameWidth,
        frameHeight: config.frameHeight,
        ...(config.startFrame === undefined ? {} : { startFrame: config.startFrame }),
        ...(config.endFrame === undefined ? {} : { endFrame: config.endFrame }),
        ...(config.margin === undefined ? {} : { margin: config.margin }),
        ...(config.spacing === undefined ? {} : { spacing: config.spacing }),
      },
      integrity: { texture: integrityOf(texture) },
    };
  }
  return {
    kind: 'image',
    key: asset.assetKey,
    url: texture.path,
    integrity: { texture: integrityOf(texture) },
  };
};

/** Expected description handed to the #191 decoder: entries in manifest
 * order, which is the deterministic writer's archive order. */
const expectedFor = (pack: PhaserPackDeliveryPack): ArchiveWorkerExpected => ({
  formatVersion: PHASER_PACK_DELIVERY_VERSION,
  archive: {
    bytes: pack.archive!.bytes,
    sha256: pack.archive!.sha256,
  },
  entries: pack.assets.flatMap((asset) => asset.files.map((file) => ({
    path: file.path,
    method: file.method!,
    bytes: file.bytes,
    sha256: file.sha256,
  }))),
});

/** Create a delivery over a validated manifest snapshot. The manifest and
 * options are validated and frozen before anything asynchronous can run;
 * later caller mutation cannot change an in-flight delivery's catalog,
 * verification basis or limits. */
export function createPhaserPackDelivery(
  manifest: unknown,
  options: PhaserPackDeliveryOptions,
): PhaserPackDelivery {
  const stagingBudgetBytes = options.stagingBudgetBytes ?? 64 * 1024 * 1024;
  const prepareTimeoutMs = options.prepareTimeoutMs ?? 15_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  const maxFileBytes = options.maxFileBytes ?? 32 * 1024 * 1024;
  const requestCache = options.requestCache ?? 'no-store';
  positiveInteger(stagingBudgetBytes, 'staging budget');
  timerRangeInteger(prepareTimeoutMs, 'prepare timeout');
  timerRangeInteger(requestTimeoutMs, 'request timeout');
  positiveInteger(maxFileBytes, 'file byte cap');
  if (!['default', 'no-store', 'reload'].includes(requestCache)) {
    fail('config', 'Delivery HTTP cache policy must be default, no-store or reload');
  }
  if ((options.baseUrl === undefined) === (options.resolveURL === undefined)) {
    fail('config', 'Delivery requires exactly one of baseUrl or resolveURL');
  }
  if (options.resolveURL !== undefined && typeof options.resolveURL !== 'function') {
    fail('config', 'Delivery resolveURL must be a function');
  }
  const resolveURLOption = options.resolveURL;
  let base: URL | undefined;
  if (options.baseUrl !== undefined) {
    try {
      base = new URL(options.baseUrl, globalThis.location?.href ?? 'file:///');
    } catch {
      fail('config', 'Delivery baseUrl is not a valid URL');
    }
  }
  // The manifest is validated and cloned once: it is the single source of
  // catalog, staging and verification truth for the delivery's lifetime.
  let snapshot: PhaserPackDeliveryManifest;
  try {
    snapshot = validatePhaserPackDeliveryManifest(structuredClone(manifest));
  } catch (error) {
    throw new PhaserPackDeliveryError(
      'config',
      `Invalid delivery manifest: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const hasZipPacks = snapshot.packs.some((pack) => pack.delivery === 'zip');
  const createWorker = options.createWorker;
  if (hasZipPacks && typeof createWorker !== 'function') {
    fail('config', 'Delivery requires a createWorker factory for zip-delivery packs');
  }
  // Every derived asset carries SHA-256 integrity — the loader verifies it
  // for files packs and the decoder verifies zip archives — so WebCrypto is
  // required for any non-empty manifest: fail fast with the right category
  // on insecure origins instead of a raw TypeError or loader error later.
  const totalFiles = snapshot.packs.reduce(
    (sum, pack) => sum + pack.assets.reduce((n, asset) => n + asset.files.length, 0),
    0,
  );
  if (totalFiles > 0 && globalThis.crypto?.subtle === undefined) {
    fail('config', 'Delivery requires WebCrypto (HTTPS or localhost) to verify pack integrity');
  }

  // Manifest paths are archive/disk paths, not URLs: encode each segment
  // exactly once, so revisions or file names carrying '#', '?' or spaces
  // address the resource the static host actually serves. A custom
  // resolver receives the once-encoded path and owns only the location.
  const encodePath = (path: string): string => path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  const resolveArtifact = (path: string, context: {
    readonly packId: string;
    readonly revision: string;
  }): string => {
    if (resolveURLOption !== undefined) {
      try {
        return resolveURLOption(encodePath(path), context);
      } catch (error) {
        // A resolver that deliberately throws a delivery error keeps its
        // category; anything else is a configuration failure, shared by
        // the files and zip call sites alike.
        if (error instanceof PhaserPackDeliveryError) {
          throw error;
        }
        throw new PhaserPackDeliveryError(
          'config',
          `Delivery URL resolver failed for ${context.packId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return new URL(encodePath(path), base).href;
  };

  const packIndex = new Map<string, PackIndexEntry>();
  for (const pack of snapshot.packs) {
    const roles = new Map<string, RoleFile>();
    for (const asset of pack.assets) {
      for (const file of asset.files) {
        roles.set(`${asset.assetKey}\u0000${file.role}`, {
          mediaType: file.mediaType,
          path: file.path,
        });
      }
    }
    packIndex.set(pack.packId, { pack, roles });
  }
  const catalog: PhaserAssetPack[] = snapshot.packs.map((pack) => ({
    id: pack.packId,
    revision: pack.revision,
    dependsOn: pack.dependencies.map((dependency) => dependency.packId),
    assets: pack.assets.map((asset) => loaderAsset(pack, asset)),
  }));

  // Observation: one subscription set for the delivery's lifetime.
  // Registration sees only events from that point on (no replay); a
  // throwing or rejecting listener is contained and never awaited; the
  // unsubscribe closure is idempotent. Unsubscribed listeners are
  // dropped immediately — no references are retained for closed UI.
  const listeners = new Set<PhaserPackDeliveryListener>();
  const emitEvent = (event: PhaserPackDeliveryEvent): void => {
    for (const listener of [...listeners]) {
      try {
        const observed = listener(event) as unknown;
        if (
          observed !== null && observed !== undefined
          && typeof observed === 'object'
          && typeof (observed as PromiseLike<unknown>).then === 'function'
        ) {
          // Async observers never block delivery work and their
          // rejections are handled, never left floating.
          void (observed as PromiseLike<unknown>).then(undefined, () => undefined);
        }
      } catch {
        // Observational only: a broken observer changes nothing.
      }
    }
  };
  const subscribe = (listener: PhaserPackDeliveryListener): (() => void) => {
    listeners.add(listener);
    return (): void => {
      listeners.delete(listener);
    };
  };
  let operationCounter = 0;
  const nextOperationId = (): number => ++operationCounter;
  const revisionOf = (packId: string): string => packIndex.get(packId)?.pack.revision ?? '';

  const staged = new Map<string, StagedPack>();
  let stagingUsedBytes = 0;
  let archiveRequests = 0;
  let fileRequests = 0;
  let disposed = false;
  let activePrepare = false;
  // The decoder closure is created lazily: a files-only delivery never
  // touches the ZIP machinery at all.
  let decoder: ReturnType<typeof createBoundedZipDecoder> | undefined;
  const decoderFor = () => decoder ??= createBoundedZipDecoder({ createWorker: createWorker! });
  const shutdown = new AbortController();

  const assertLive = (): void => {
    if (disposed) {
      fail('disposed', 'Phaser pack delivery is disposed');
    }
  };

  const closureOf = (packId: string): PhaserPackDeliveryPack[] => {
    const ordered: PhaserPackDeliveryPack[] = [];
    const visited = new Set<string>();
    const visit = (id: string): void => {
      if (visited.has(id)) {
        return;
      }
      visited.add(id);
      const entry = packIndex.get(id);
      if (entry === undefined) {
        throw new PhaserPackDeliveryError('config', `Unknown delivery pack: ${id}`);
      }
      for (const dependency of entry.pack.dependencies) {
        visit(dependency.packId);
      }
      ordered.push(entry.pack);
    };
    visit(packId);
    return ordered;
  };

  const unstage = (pack: StagedPack): void => {
    if (pack.handles > 0 || pack.openReaders > 0) {
      return;
    }
    // Identity guards the accounting: a newer prepare may have restaged the
    // same pack id, and a dispose may have cleared the map entirely —
    // neither may drive the mirror counter for this older instance.
    if (staged.get(pack.pack.packId) !== pack) {
      return;
    }
    staged.delete(pack.pack.packId);
    stagingUsedBytes -= pack.reservationBytes;
  };

  const stagePack = async (
    pack: PhaserPackDeliveryPack,
    deadlineAt: number,
    signal: AbortSignal,
    tracker?: OperationTracker,
  ): Promise<StagedPack> => {
    const archive = pack.archive!;
    const packContext = { packId: pack.packId, revision: pack.revision };
    const emit = (
      phase: 'downloading' | 'decoding-and-verifying',
      progress: PhaserPackDeliveryProgress,
    ): void => {
      tracker?.nextEvent(phase, { ...packContext, progress });
    };
    const url = resolveArtifact(archive.path, packContext);
    // URL resolution runs synchronous user code; the budget gate sits
    // immediately before the request it guards, after that code, so no
    // archive request can start on a budget spent inside the resolver.
    if (deadlineAt - monotonicNow() <= 0) {
      fail('deadline', 'Delivery preparation exceeded its deadline');
    }
    archiveRequests++;
    // Emitted once the body starts: the first observation reports zero
    // delivered bytes against the manifest's declared size, and every
    // network chunk updates the measured count. Content-Length alone
    // never decides success or total size.
    emit('downloading', { bodyBytes: 0, expectedBodyBytes: archive.bytes });
    const bytes = await fetchDeliveryBytes(
      url,
      requestTimeoutMs,
      signal,
      requestCache,
      archive.bytes,
      (status): string => `Delivery archive request failed with HTTP ${status} (${pack.packId})`,
      archive.bytes,
      (received): void => {
        emit('downloading', { bodyBytes: received, expectedBodyBytes: archive.bytes });
      },
    ).catch((error: unknown) => {
      if (error instanceof PhaserPackDeliveryError) {
        throw error;
      }
      if (error instanceof DeliveryRequestTimeout) {
        throw requestTimeoutError('archive request', pack.packId)
          .withDetails({ stage: 'downloading', ...packContext });
      }
      if (signal.aborted) {
        throw abortCategory(signal.reason, `preparation for ${pack.packId}`);
      }
      if (error instanceof DeliveryHttpStatusError) {
        throw new PhaserPackDeliveryError('transport', error.message, {
          stage: 'downloading',
          ...packContext,
          httpStatus: error.httpStatus,
        });
      }
      throw new PhaserPackDeliveryError(
        'transport',
        `Could not fetch the delivery archive for ${pack.packId}: ${error instanceof Error ? error.message : String(error)}`,
        { stage: 'downloading', ...packContext },
      );
    });
    if (bytes.byteLength !== archive.bytes) {
      fail(
        'integrity',
        `Delivery archive size mismatch for ${pack.packId}: ${bytes.byteLength} of ${archive.bytes}`,
        {
          stage: 'decoding-and-verifying',
          ...packContext,
          expectedBytes: archive.bytes,
          receivedBytes: bytes.byteLength,
        },
      );
    }
    // The archive digest is verified once, inside the #191 decoder, against
    // the same manifest value; a client-side pre-hash would only double the
    // hashing cost and the prepare-deadline budget consumption.
    const expected = expectedFor(pack);
    // The path bound is pack-local: only this job's ZIP entry names feed
    // it, so an unrelated files pack's long path cannot loosen the cutoff
    // for zip decodes. A loop keeps untrusted data out of spread limits.
    let maxPathLength = defaultArchiveWorkerLimits().maxPathLength;
    for (const entry of expected.entries) {
      if (entry.path.length > maxPathLength) {
        maxPathLength = entry.path.length;
      }
    }
    const expandedBytes = expandedBytesOf(pack);
    // The whole-prepare deadline is never restarted; the decoder only ever
    // receives the unspent remainder, exactly as #191 prescribes. Both the
    // deadline and this remainder read the same monotonic clock, and the
    // spent check runs before the flooring so rounding can never mint
    // budget: a fractional remainder floors to the decoder's integer
    // contract without ever rounding up into fresh time.
    const remainingMs = deadlineAt - monotonicNow();
    if (remainingMs <= 0) {
      fail('deadline', 'Delivery preparation exceeded its deadline', {
        stage: 'decoding-and-verifying',
        ...packContext,
      });
    }
    const job = decoderFor().decode({
      archive: bytes,
      expected,
      limits: {
        archiveBytes: archive.bytes,
        entryBytes: expected.entries.reduce((max, entry) => Math.max(max, entry.bytes), 0),
        totalExpandedBytes: expandedBytes,
        entryCount: expected.entries.length,
        // The builder permits ZIP names beyond the decoder's conservative
        // default; the bound follows the manifest's longest validated path
        // so a legal generated pack is never rejected on path length.
        maxPathLength,
        decodeDeadlineMs: Math.floor(remainingMs),
      },
    });
    const mediaByPath = new Map(
      pack.assets.flatMap(
        (asset) => asset.files.map((file) => [file.path, file.mediaType] as const),
      ),
    );
    const files = new Map<string, { readonly bytes: Uint8Array; readonly mediaType: string }>();
    // While the loop pends on the next worker entry, an abort must cancel
    // the job immediately instead of waiting for the decode deadline: a
    // cancelled transition would otherwise block its serialized successor
    // for the whole remaining budget.
    const cancelWithJob = (): void => {
      void job.cancel().catch(() => undefined);
    };
    // An AbortSignal never fires for listeners attached after the abort: a
    // cancel that landed during the digest-verification window must cancel
    // the job immediately instead of waiting for the first entry.
    if (signal.aborted) {
      cancelWithJob();
    } else {
      signal.addEventListener('abort', cancelWithJob, { once: true });
    }
    // One observation before the first entry: verification has begun
    // with nothing verified yet. Internal hashing/inflate percentages
    // are not observable through the #191 contract and are not
    // fabricated.
    let verifiedEntryBytes = 0;
    emit('decoding-and-verifying', {
      entriesVerified: 0,
      entryBytes: 0,
      expectedEntries: expected.entries.length,
    });
    try {
      for await (const entry of job.entries) {
        // Caller cancel and dispose() stop the decode promptly: without this
        // check the worker keeps burning CPU until the unspent decode
        // deadline, and a superseded prepare delays its successor by that
        // much.
        if (signal.aborted) {
          throw abortCategory(signal.reason, `preparation for ${pack.packId}`);
        }
        if (!mediaByPath.has(entry.path)) {
          fail(
            'integrity',
            `Delivery archive ${pack.packId} delivered an unlisted entry: ${entry.path}`,
            { stage: 'decoding-and-verifying', ...packContext },
          );
        }
        files.set(entry.path, { bytes: entry.bytes, mediaType: mediaByPath.get(entry.path)! });
        verifiedEntryBytes += entry.bytes.byteLength;
        emit('decoding-and-verifying', {
          entriesVerified: files.size,
          entryBytes: verifiedEntryBytes,
          expectedEntries: expected.entries.length,
        });
      }
      const status = await job.result;
      if (status.status !== 'completed') {
        // Decoder statuses and codes stay visible; the category follows the
        // status so a decode deadline or cancel is not misreported as an
        // integrity failure.
        let code: PhaserPackDeliveryErrorCode = 'integrity';
        if (signal.aborted) {
          // The abort reason knows whether this was the deadline, a caller
          // cancel or a dispose — the status alone cannot.
          const classified = abortCategory(signal.reason, `preparation for ${pack.packId}`);
          if (classified.code !== 'cancelled' || status.status === 'cancelled') {
            code = classified.code;
          }
        } else if (status.status === 'deadline') {
          code = 'deadline';
        }
        throw new PhaserPackDeliveryError(
          code,
          `Delivery archive ${pack.packId} did not decode completely: ${status.status}${status.code === undefined ? '' : ` (${status.code})`}`,
          {
            stage: 'decoding-and-verifying',
            ...packContext,
            ...(status.code === undefined ? {} : { decoderCode: status.code }),
            decoderStatus: status.status,
          },
        );
      }
      if (files.size !== expected.entries.length) {
        fail(
          'integrity',
          `Delivery archive ${pack.packId} staged ${files.size} of ${expected.entries.length} entries`,
          { stage: 'decoding-and-verifying', ...packContext },
        );
      }
    } catch (error) {
      void job.cancel().catch(() => undefined);
      // Mid-stream decode failures (entry digest mismatch, corrupt interior,
      // worker error) are integrity failures, not transport ones; an aborted
      // signal keeps its deadline/cancelled/disposed category.
      if (!(error instanceof PhaserPackDeliveryError)) {
        if (signal.aborted) {
          throw abortCategory(signal.reason, `preparation for ${pack.packId}`);
        }
        // The entries iterator rejects with the decoder's failure before
        // job.result can settle, so worker-environment failures land here:
        // a worker factory throwing under CSP/no-worker conditions is a
        // configuration failure, not a corrupt archive.
        if (error instanceof ZipDecodeError && error.code === 'unsupported') {
          throw new PhaserPackDeliveryError(
            'config',
            `Delivery archive ${pack.packId} could not use its worker: ${error.message}`,
            {
              stage: 'decoding-and-verifying',
              ...packContext,
              decoderStatus: 'unsupported',
              decoderCode: error.code,
            },
          );
        }
        if (error instanceof ZipDecodeError && error.code === 'deadline') {
          // The decoder observed its own deadline before the outer prepare
          // timer aborted: the category stays 'deadline', not 'integrity'.
          throw new PhaserPackDeliveryError(
            'deadline',
            `Delivery archive ${pack.packId}: ${error.message}`,
            {
              stage: 'decoding-and-verifying',
              ...packContext,
              decoderStatus: 'deadline',
              decoderCode: error.code,
            },
          );
        }
        throw new PhaserPackDeliveryError(
          'integrity',
          `Delivery archive ${pack.packId} failed to decode: ${error instanceof Error ? error.message : String(error)}`,
          {
            stage: 'decoding-and-verifying',
            ...packContext,
            ...(error instanceof ZipDecodeError ? { decoderCode: error.code } : {}),
            ...(error instanceof ZipDecodeError && error.code === 'worker-error'
              ? { decoderStatus: 'worker-error' as const }
              : {}),
          },
        );
      }
      throw error;
    } finally {
      signal.removeEventListener('abort', cancelWithJob);
    }
    const stagedPack: StagedPack = {
      pack,
      files,
      reservationBytes: archive.bytes + expandedBytes,
      handles: 0,
      openReaders: 0,
    };
    staged.set(pack.packId, stagedPack);
    stagingUsedBytes += stagedPack.reservationBytes;
    return stagedPack;
  };

  const fileSource: PhaserPackFileSource = {
    async open(request, context) {
      assertLive();
      const entry = packIndex.get(request.packId);
      if (entry === undefined) {
        throw new PhaserPackDeliveryError('config', `Unknown delivery pack: ${request.packId}`);
      }
      if (request.revision !== entry.pack.revision) {
        throw new PhaserPackDeliveryError(
          'config',
          `Delivery pack revision mismatch for ${request.packId}: ${request.revision}`,
        );
      }
      const role = entry.roles.get(`${request.assetKey}\u0000${request.role}`);
      if (role === undefined) {
        throw new PhaserPackDeliveryError(
          'config',
          `Delivery pack ${request.packId} has no ${request.role} file for ${request.assetKey}`,
        );
      }
      if (entry.pack.delivery === 'files') {
        let readOnce = false;
        let transfer: (() => void) | undefined;
        return {
          async read(): Promise<PhaserPackFileBody> {
            if (readOnce) {
              fail('config', 'Delivery file body was already read');
            }
            readOnce = true;
            // One observed operation per files-delivery body read. Staged
            // zip entries are local bytes, not origin downloads, and emit
            // nothing.
            const operationId = nextOperationId();
            const tracker = createOperationTracker(operationId, 'file-read', emitEvent);
            const requestContext = {
              kind: 'file-read' as const,
              operationId,
              packId: request.packId,
              revision: request.revision,
              assetKey: request.assetKey,
              role: request.role,
            };
            // dispose() stops in-flight file reads too: combine the
            // loader's signal with the delivery shutdown so a disposed
            // delivery cannot keep streaming under a live loader permit.
            // Environments without AbortSignal.any get a manual bridge
            // with the same first-abort-wins semantics. Declared before the
            // try so the finally can dispose it.
            const bridge = bridgeSignals(context.signal, shutdown.signal);
            const combined = bridge.signal;
            try {
              // The permit wait hears the combined signal too: a dispose()
              // while this read is queued behind the transfer budget must
              // settle it with 'disposed', not leave it queued forever.
              transfer = await context.budgets.transfers.acquire(combined).catch(
                (error: unknown): never => {
                  if (combined.aborted) {
                    // First-abort-wins: the combined reason remembers which
                    // signal fired first even if both aborted in one turn.
                    if (context.signal.aborted && combined.reason === context.signal.reason) {
                      throw new PhaserPackDeliveryError(
                        'cancelled',
                        `Delivery file request for ${request.packId} was cancelled`,
                      );
                    }
                    throw abortCategory(combined.reason, `file request for ${request.packId}`);
                  }
                  throw error;
                },
              );
              fileRequests++;
              const url = resolveArtifact(role.path, {
                packId: request.packId, revision: request.revision,
              });
              // The loader reserves only the declared size in the shared
              // budget, so the streaming cap is the declared bytes (when
              // known) rather than the transport maximum, and the failure
              // distinguishes a lying manifest from a transport-cap trip.
              const declared = request.integrity?.bytes;
              const cap = declared === undefined || declared <= 0
                ? maxFileBytes
                : Math.min(declared, maxFileBytes);
              tracker.nextEvent('downloading', {
                packId: request.packId,
                revision: request.revision,
                assetKey: request.assetKey,
                role: request.role,
                ...(declared === undefined ? {} : { progress: { bodyBytes: 0, expectedBodyBytes: declared } }),
              });
              const bytes = await fetchDeliveryBytes(
                url,
                requestTimeoutMs,
                combined,
                requestCache,
                cap,
                (status): string => `Delivery file request failed with HTTP ${status} (${request.packId})`,
                declared,
                (received): void => {
                  tracker.nextEvent('downloading', {
                    packId: request.packId,
                    revision: request.revision,
                    assetKey: request.assetKey,
                    role: request.role,
                    ...(declared === undefined
                      ? { progress: { bodyBytes: received } }
                      : { progress: { bodyBytes: received, expectedBodyBytes: declared } }),
                  });
                },
              ).catch((error: unknown) => {
                if (error instanceof PhaserPackDeliveryError) {
                  throw error.withDetails({ ...requestContext, stage: 'downloading' });
                }
                if (error instanceof DeliveryRequestTimeout) {
                  throw requestTimeoutError('file request', request.packId)
                    .withDetails({ ...requestContext, stage: 'downloading' });
                }
                if (combined.aborted && combined.reason === context.signal.reason) {
                  throw new PhaserPackDeliveryError(
                    'cancelled',
                    `Delivery file request for ${request.packId} was cancelled`,
                    requestContext,
                  );
                }
                if (combined.aborted) {
                  // First-abort-wins: the combined reason remembers whether
                  // the shutdown fired before the loader signal.
                  const reason = combined.reason;
                  throw abortCategory(reason, `file request for ${request.packId}`)
                    .withDetails(requestContext);
                }
                if (error instanceof DeliveryHttpStatusError) {
                  throw new PhaserPackDeliveryError('transport', error.message, {
                    ...requestContext,
                    stage: 'downloading',
                    httpStatus: error.httpStatus,
                  });
                }
                throw new PhaserPackDeliveryError(
                  'transport',
                  `Could not fetch the delivery file for ${request.packId}: ${error instanceof Error ? error.message : String(error)}`,
                  { ...requestContext, stage: 'downloading' },
                );
              });
              tracker.nextEvent('completed', {
                packId: request.packId,
                revision: request.revision,
                assetKey: request.assetKey,
                role: request.role,
                ...(declared === undefined
                  ? { progress: { bodyBytes: bytes.byteLength } }
                  : { progress: { bodyBytes: bytes.byteLength, expectedBodyBytes: declared } }),
              });
              return {
                bytes: toBlob(bytes, role.mediaType),
                release(): void {
                },
              };
            } catch (error) {
              readOnce = false;
              // The files-read operation ends exactly once with the
              // classified failure; already-terminal trackers (early
              // cancelled/disposed paths above) stay silent.
              if (error instanceof PhaserPackDeliveryError) {
                const enriched = error.withDetails(requestContext);
                tracker.nextEvent(
                  enriched.code === 'cancelled' ? 'cancelled'
                    : enriched.code === 'disposed' ? 'disposed' : 'failed',
                  {
                    packId: request.packId,
                    revision: request.revision,
                    assetKey: request.assetKey,
                    role: request.role,
                    error: { code: enriched.code, details: enriched.details },
                  },
                );
              }
              throw error;
            } finally {
              bridge.dispose();
              transfer?.();
            }
          },
          close(): void {
          },
        };
      }
      const stagedPack = staged.get(request.packId);
      if (stagedPack === undefined) {
        throw new PhaserPackDeliveryError(
          'not-prepared',
          `Zip delivery pack is not prepared: ${request.packId}`,
        );
      }
      const stagedFile = stagedPack.files.get(role.path);
      if (stagedFile === undefined) {
        throw new PhaserPackDeliveryError(
          'integrity',
          `Zip delivery pack ${request.packId} is missing staged entry ${role.path}`,
        );
      }
      // One reader claim per open; the claim returns when the loader closes
      // the file, whether or not the body was read. Open bodies keep the
      // staged bytes alive even after every prepare handle was released.
      stagedPack.openReaders++;
      let readOnce = false;
      let closed = false;
      return {
        async read(): Promise<PhaserPackFileBody> {
          if (closed) {
            fail('config', 'Delivery file was already closed');
          }
          if (readOnce) {
            fail('config', 'Delivery file body was already read');
          }
          assertLive();
          readOnce = true;
          return {
            bytes: toBlob(stagedFile.bytes, stagedFile.mediaType),
            release(): void {
            },
          };
        },
        close(): void {
          if (closed) {
            return;
          }
          closed = true;
          if (disposed) {
            return;
          }
          stagedPack.openReaders--;
          unstage(stagedPack);
        },
      };
    },
  };

  /** Take one handle per zip pack in the closure; the returned release
   * drops exactly those instances so a newer restage keeps its own staging. */
  const acquireHandles = (packs: readonly PhaserPackDeliveryPack[]): {
    readonly acquired: readonly StagedPack[];
    readonly release: () => void;
  } => {
    const acquired: StagedPack[] = [];
    for (const pack of packs) {
      const stagedPack = staged.get(pack.packId);
      if (stagedPack === undefined) {
        for (const taken of acquired) {
          taken.handles--;
          unstage(taken);
        }
        throw new PhaserPackDeliveryError(
          'not-prepared',
          `Zip delivery pack lost its staging: ${pack.packId}`,
        );
      }
      stagedPack.handles++;
      acquired.push(stagedPack);
    }
    let released = false;
    return {
      acquired,
      release(): void {
        if (released) {
          return;
        }
        released = true;
        // dispose() zeroed the counters and cleared the map: a release
        // landing afterwards must not drive them negative.
        if (disposed) {
          return;
        }
        for (const stagedPack of acquired) {
          stagedPack.handles--;
          unstage(stagedPack);
        }
      },
    };
  };

  return {
    catalog,
    /** Observation entry point (the only one): listeners receive events
     * for operations observed after registration — no replay — and the
     * returned unsubscribe is idempotent. */
    subscribe,
    fileSource,
    async prepare(packId, prepareOptions = {}) {
      assertLive();
      if (activePrepare) {
        fail('busy', 'Another delivery preparation is already running');
      }
      const closure = closureOf(packId);
      const zipPacks = closure.filter((pack) => pack.delivery === 'zip');
      const missing = zipPacks.filter((pack) => !staged.has(pack.packId));
      // Reservation is archive bytes plus every expanded file byte, computed
      // for the whole closure before any network work: an oversized prepare
      // is rejected without a single request.
      const need = missing.reduce((sum, pack) => sum + pack.archive!.bytes + expandedBytesOf(pack), 0);
      if (stagingUsedBytes + need > stagingBudgetBytes) {
        fail(
          'budget',
          `Delivery staging budget exceeded: preparing ${packId} needs ${need} bytes with ${stagingUsedBytes} staged, over the ${stagingBudgetBytes} byte budget`,
        );
      }
      const operationId = nextOperationId();
      const tracker = createOperationTracker(operationId, 'prepare', emitEvent);
      const requestedRevision = revisionOf(packId);
      if (missing.length === 0) {
        // Everything is already staged (or the closure is files-only): just
        // take handles, with no timer, worker or network work at all — but
        // an already-aborted caller still gets the same 'cancelled' answer
        // the staging path would give. The prepared event describes staging
        // only: a files-only closure never downloads an image here, so
        // "prepared" must not be rendered as images loaded.
        tracker.nextEvent('planning', { packId, revision: requestedRevision });
        if (prepareOptions.signal?.aborted) {
          const cancelled = new PhaserPackDeliveryError(
            'cancelled',
            'Delivery preparation was cancelled',
            { kind: 'prepare', operationId, packId, revision: requestedRevision },
          );
          tracker.nextEvent('cancelled', {
            packId,
            revision: requestedRevision,
            error: { code: cancelled.code, details: cancelled.details },
          });
          throw cancelled;
        }
        const handles = acquireHandles(zipPacks);
        tracker.nextEvent('prepared', { packId, revision: requestedRevision });
        return { release: handles.release };
      }
      tracker.nextEvent('planning', { packId, revision: requestedRevision });
      activePrepare = true;
      const controller = new AbortController();
      const deadlineAt = monotonicNow() + prepareTimeoutMs;
      const timer = setTimeout(
        (): void => controller.abort(new DeliveryDeadlineAbort('Delivery preparation exceeded its deadline')),
        prepareTimeoutMs,
      );
      // Caller cancel and delivery shutdown forward the triggering signal's
      // own reason (the event target is whichever of the two fired), so the
      // surfaced message stays the intended one; the deadline passes its
      // reason directly through the timer abort above.
      const forward = (event: Event): void => {
        const reason = (event.target as AbortSignal).reason;
        controller.abort(reason instanceof Error ? reason : new Error('Delivery preparation was cancelled'));
      };
      prepareOptions.signal?.addEventListener('abort', forward, { once: true });
      // dispose() stops an in-flight prepare too, not just future calls.
      shutdown.signal.addEventListener('abort', forward, { once: true });
      const newlyStaged: StagedPack[] = [];
      try {
        if (prepareOptions.signal?.aborted) {
          fail('cancelled', 'Delivery preparation was cancelled');
        }
        // Staging is deliberately sequential: the single-flight budget,
        // the one shared never-restarting deadline and the bounded
        // archive+expanded memory all depend on one stage at a time.
        const assertBudgetLeft = (): void => {
          // The abort timer's callback can lag the clock: no new archive
          // request, and no successful return, may start or land on a
          // budget the monotonic clock has already spent. The thrown
          // reason is classified by the catch below like any abort.
          if (deadlineAt - monotonicNow() <= 0) {
            fail('deadline', 'Delivery preparation exceeded its deadline');
          }
        };
        for (const pack of missing) {
          assertBudgetLeft();
          const stagedPack = await stagePack(pack, deadlineAt, controller.signal, tracker);
          // dispose() during an await drops everything: a late stagePack
          // result must not repopulate a cleared delivery.
          if (disposed) {
            unstage(stagedPack);
            fail('disposed', 'Phaser pack delivery was disposed during preparation');
          }
          newlyStaged.push(stagedPack);
        }
        // Final success gate: a decode that resolved after the budget was
        // spent — with the abort callback still queued — must not certify
        // the preparation or hand out staging handles.
        assertBudgetLeft();
        const handles = acquireHandles(zipPacks);
        tracker.nextEvent('prepared', { packId, revision: requestedRevision });
        return { release: handles.release };
      } catch (thrown) {
        const classified = classifyPrepareFailure(thrown, controller.signal, packId);
        // Correlation fields merge in unconditionally, but identity the
        // failing site already recorded wins: a dependency archive's
        // failure keeps naming that dependency, not the requested pack.
        const error = classified.withDetails({
          kind: 'prepare',
          operationId,
          ...(classified.details.packId === undefined
            ? { packId, revision: requestedRevision }
            : {}),
        });
        // acquireHandles rolls its own handles back on failure, so the only
        // staged bytes to reclaim here are the ones this prepare staged.
        for (const stagedPack of newlyStaged) {
          unstage(stagedPack);
        }
        tracker.nextEvent(
          error.code === 'cancelled' ? 'cancelled' : error.code === 'disposed' ? 'disposed' : 'failed',
          {
            packId,
            revision: requestedRevision,
            error: { code: error.code, details: error.details },
          },
        );
        throw error;
      } finally {
        clearTimeout(timer);
        prepareOptions.signal?.removeEventListener('abort', forward);
        shutdown.signal.removeEventListener('abort', forward);
        activePrepare = false;
      }
    },
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      // The sentinel makes dispose-caused aborts classify as 'disposed'
      // everywhere the reason propagates, not just at explicit checks.
      shutdown.abort(new DeliveryDisposedAbort('Phaser pack delivery is disposed'));
      for (const stagedPack of staged.values()) {
        stagedPack.handles = 0;
        stagedPack.openReaders = 0;
      }
      staged.clear();
      stagingUsedBytes = 0;
    },
    snapshot(): PhaserPackDeliverySnapshot {
      return {
        stagingUsedBytes,
        stagingBudgetBytes,
        archiveRequests,
        fileRequests,
        staging: [...staged.values()].map((stagedPack) => ({
          packId: stagedPack.pack.packId,
          revision: stagedPack.pack.revision,
          handles: stagedPack.handles,
          openReaders: stagedPack.openReaders,
          reservationBytes: stagedPack.reservationBytes,
        })),
      };
    },
  };
}
