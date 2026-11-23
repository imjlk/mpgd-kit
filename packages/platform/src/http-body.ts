/**
 * Bounded readers for fetch-API request and response bodies.
 *
 * A reader refuses a body larger than `maximumBytes`: first from a declared
 * `Content-Length`, then by counting the bytes the stream yields, so an
 * oversized body is refused before it is buffered. One timeout bounds the
 * whole read, however slowly the bytes arrive, and an optional `AbortSignal`
 * stops it early. Text is strict UTF-8, and the JSON readers also require a
 * JSON media type. Every refusal is an `HttpBodyError` with a stable `code`.
 *
 * The module uses only web-standard globals (streams, `TextDecoder`, timers
 * and `AbortSignal`), so it runs unchanged in browsers, Cloudflare Workers and
 * Node. The request readers also need `Request.body`, which Firefox does not
 * implement; there they reject with a TypeError. The readers check size and
 * format only: the JSON readers return `unknown`, and authentication and
 * schema checks stay with the caller.
 */

/** Why a bounded reader refused a body. The codes are stable; messages are not. */
export type HttpBodyErrorCode =
  | 'JSON_REQUIRED'
  | 'INVALID_CONTENT_LENGTH'
  | 'BODY_TOO_LARGE'
  | 'BODY_READ_TIMEOUT'
  | 'BODY_READ_ABORTED'
  | 'BODY_READ_FAILED'
  | 'INVALID_UTF8'
  | 'EMPTY_BODY'
  | 'INVALID_JSON';

/** The HTTP status a server answers for a request body refused with a code. */
export type HttpBodyErrorStatus = 400 | 408 | 413 | 415;

const statusByCode = {
  JSON_REQUIRED: 415,
  INVALID_CONTENT_LENGTH: 400,
  BODY_TOO_LARGE: 413,
  BODY_READ_TIMEOUT: 408,
  BODY_READ_ABORTED: 400,
  BODY_READ_FAILED: 400,
  INVALID_UTF8: 400,
  EMPTY_BODY: 400,
  INVALID_JSON: 400,
} as const satisfies Record<HttpBodyErrorCode, HttpBodyErrorStatus>;

const messageByCode = {
  JSON_REQUIRED: 'The body does not have a JSON Content-Type.',
  INVALID_CONTENT_LENGTH: 'The Content-Length header is not a single decimal length.',
  BODY_TOO_LARGE: 'The body is larger than the byte limit.',
  BODY_READ_TIMEOUT: 'The body was not read before the timeout.',
  BODY_READ_ABORTED: 'Reading the body was aborted.',
  BODY_READ_FAILED: 'The body stream failed.',
  INVALID_UTF8: 'The body is not valid UTF-8.',
  EMPTY_BODY: 'The body is empty.',
  INVALID_JSON: 'The body is not valid JSON.',
} as const satisfies Record<HttpBodyErrorCode, string>;

/**
 * A body a bounded reader refused. Branch on `code`. `status` is the answer a
 * server gives for a request body refused this way; a refused response body is
 * an upstream failure, so its caller answers with its own status instead.
 * `cause` carries the abort reason, stream error, decoder error or JSON syntax
 * error when there is one.
 */
export class HttpBodyError extends Error {
  readonly code: HttpBodyErrorCode;
  readonly status: HttpBodyErrorStatus;

  constructor(code: HttpBodyErrorCode, options: { readonly cause?: unknown } = {}) {
    super(messageByCode[code], 'cause' in options ? { cause: options.cause } : undefined);
    this.name = 'HttpBodyError';
    this.code = code;
    this.status = statusByCode[code];
  }
}

export interface HttpBodyReadOptions {
  /**
   * Milliseconds the whole read may take, from the call until the last byte;
   * 10 000 when omitted. A positive integer of at most 2 147 483 647, the
   * longest delay a timer keeps. A stream whose chunks are always ready, such
   * as one built in memory, never waits: in Workers, whose clock stands still
   * until the next I/O, reading it is bounded by `maximumBytes` instead.
   */
  readonly timeoutMs?: number | undefined;
  /** Stops the read when it aborts; the reader then refuses with `BODY_READ_ABORTED`. */
  readonly signal?: AbortSignal | undefined;
}

/**
 * Reads a JSON request body of at most `maximumBytes` bytes and returns the
 * parsed value as `unknown`, for the caller's own schema check.
 *
 * Before reading, it refuses an already aborted `signal`
 * (`BODY_READ_ABORTED`), a Content-Type that is not a JSON media type
 * (`JSON_REQUIRED`), and a declared Content-Length that is malformed
 * (`INVALID_CONTENT_LENGTH`) or over the limit (`BODY_TOO_LARGE`), and leaves
 * the body unread for the server runtime to discard once the error response
 * is sent. While reading, it refuses a body that passes the limit, outlasts
 * `timeoutMs`, is aborted, or whose stream fails or yields something other
 * than bytes (`BODY_TOO_LARGE`, `BODY_READ_TIMEOUT`, `BODY_READ_ABORTED`,
 * `BODY_READ_FAILED`), and cancels it. Empty chunks are skipped, but more
 * than 1024 of them are a `BODY_READ_FAILED` too. A complete body that is
 * empty, not UTF-8 or not JSON is refused with `EMPTY_BODY`, `INVALID_UTF8`
 * or `INVALID_JSON`.
 *
 * A body that was already read, even partly, that another reader has locked,
 * or that the runtime does not expose as a stream rejects with a TypeError,
 * and an invalid `maximumBytes` or `timeoutMs` with a RangeError; neither
 * touches the body.
 */
export async function readBoundedJsonRequest(
  request: Request,
  maximumBytes: number,
  options: HttpBodyReadOptions = {},
): Promise<unknown> {
  return parseJson(await readBody(request, planRead('request', true, maximumBytes, options)));
}

/**
 * Reads a request body of at most `maximumBytes` bytes as strict UTF-8 text,
 * whatever its Content-Type or charset says, for example to verify a webhook
 * signature over the body text. Like `text()`, it drops a leading byte order
 * mark. A request without a body reads as `''`. Refusals follow
 * `readBoundedJsonRequest`, without `JSON_REQUIRED`, `EMPTY_BODY` and
 * `INVALID_JSON`.
 */
export async function readBoundedRequestText(
  request: Request,
  maximumBytes: number,
  options: HttpBodyReadOptions = {},
): Promise<string> {
  return decodeUtf8(await readBody(request, planRead('request', false, maximumBytes, options)));
}

/**
 * Reads a JSON response body of at most `maximumBytes` bytes and returns the
 * parsed value as `unknown`, for the caller's own schema check. Refusals
 * follow `readBoundedJsonRequest`, except that a refusal before reading
 * cancels the body too, since nothing else releases the connection behind an
 * unread response body.
 */
export async function readBoundedJsonResponse(
  response: Response,
  maximumBytes: number,
  options: HttpBodyReadOptions = {},
): Promise<unknown> {
  return parseJson(await readBody(response, planRead('response', true, maximumBytes, options)));
}

/**
 * Reads a response body of at most `maximumBytes` bytes as strict UTF-8 text,
 * whatever its Content-Type or charset says. A response without a body reads
 * as `''`. Refusals follow `readBoundedRequestText`, and every one cancels
 * the body, as in `readBoundedJsonResponse`.
 */
export async function readBoundedResponseText(
  response: Response,
  maximumBytes: number,
  options: HttpBodyReadOptions = {},
): Promise<string> {
  return decodeUtf8(await readBody(response, planRead('response', false, maximumBytes, options)));
}

const defaultTimeoutMs = 10_000;
// Browsers, Workers and Node run a timer with a longer delay at once.
const maximumTimeoutMs = 2_147_483_647;

interface ReadPlan {
  /**
   * A server runtime discards a request body its handler leaves unread, so a
   * refusal before reading leaves it alone; nothing releases an unread
   * response body but a cancel.
   */
  readonly owner: 'request' | 'response';
  readonly json: boolean;
  readonly maximumBytes: number;
  readonly timeoutMs: number;
  readonly signal: AbortSignal | undefined;
}

function planRead(
  owner: ReadPlan['owner'],
  json: boolean,
  maximumBytes: number,
  options: HttpBodyReadOptions,
): ReadPlan {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new RangeError('maximumBytes must be a positive safe integer.');
  }
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > maximumTimeoutMs) {
    throw new RangeError(`timeoutMs must be a positive integer of at most ${maximumTimeoutMs}.`);
  }
  return { owner, json, maximumBytes, timeoutMs, signal: options.signal };
}

async function readBody(message: Request | Response, plan: ReadPlan): Promise<Uint8Array> {
  const body = message.body as ReadableStream<Uint8Array> | null | undefined;
  if (body === undefined) {
    // Firefox does not implement Request.body.
    throw new TypeError('This runtime does not expose the body as a stream.');
  }
  // A partly read body could otherwise pass as a complete, shorter one.
  if (message.bodyUsed || body?.locked === true) {
    throw new TypeError('The body was already read or is locked by another reader.');
  }
  const refusal = refuseBeforeReading(message.headers, plan);
  if (refusal !== undefined) {
    if (plan.owner === 'response' && body !== null) {
      void body.cancel(refusal).catch(() => undefined);
    }
    throw refusal;
  }
  return body === null ? new Uint8Array(0) : readStream(body, plan);
}

function refuseBeforeReading(headers: Headers, plan: ReadPlan): HttpBodyError | undefined {
  if (plan.signal?.aborted === true) {
    return new HttpBodyError('BODY_READ_ABORTED', { cause: plan.signal.reason });
  }
  if (plan.json && !isJsonMediaType(headers.get('Content-Type'))) {
    return new HttpBodyError('JSON_REQUIRED');
  }
  const declared = headers.get('Content-Length');
  if (declared === null) {
    return undefined;
  }
  // Headers joins repeated fields with ", "; repeats must agree, as in fetch.
  const lengths = new Set(declared.split(',').map((part) => part.trim()));
  const [length] = lengths;
  if (lengths.size !== 1 || length === undefined || !/^\d+$/u.test(length)) {
    return new HttpBodyError('INVALID_CONTENT_LENGTH');
  }
  return Number(length) > plan.maximumBytes ? new HttpBodyError('BODY_TOO_LARGE') : undefined;
}

/** A JSON MIME type in the WHATWG MIME Sniffing sense; parameters such as charset are ignored. */
function isJsonMediaType(contentType: string | null): boolean {
  const essence = contentType?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  const match = /^([!#$%&'*+.^_`|~0-9a-z-]+)\/([!#$%&'*+.^_`|~0-9a-z-]+)$/u.exec(essence);
  const type = match?.[1];
  const subtype = match?.[2];
  if (type === undefined || subtype === undefined) {
    return false;
  }
  return (
    subtype.endsWith('+json') || (subtype === 'json' && (type === 'application' || type === 'text'))
  );
}

// Where the clock does not advance between reads that never yield to the
// event loop (workerd), nothing else would stop a stream of empty chunks.
const maximumEmptyChunks = 1024;

async function readStream(
  body: ReadableStream<Uint8Array>,
  { maximumBytes, timeoutMs, signal }: ReadPlan,
): Promise<Uint8Array> {
  const reader = body.getReader();
  // Chunks are copied as they arrive: holding every chunk object would cost
  // far more than its bytes for a body sent a byte at a time, and a source
  // may reuse a chunk's buffer after enqueueing it.
  let bytes = new Uint8Array(0);
  let received = 0;
  let emptyChunks = 0;
  let stopped: HttpBodyError | undefined;
  let rejectPendingRead: ((reason: HttpBodyError) => void) | undefined;
  // Settle the pending read first: the cancel below resolves it as done, and
  // must not pass for the end of the body. The cancel is not awaited, since a
  // stream's cancel step may never finish.
  const stop = (failure: HttpBodyError): void => {
    if (stopped !== undefined) {
      return;
    }
    stopped = failure;
    rejectPendingRead?.(failure);
    void reader.cancel(failure).catch(() => undefined);
  };
  const abort = (): void => {
    stop(new HttpBodyError('BODY_READ_ABORTED', { cause: signal?.reason }));
  };
  const timer = setTimeout(() => stop(new HttpBodyError('BODY_READ_TIMEOUT')), timeoutMs);
  // A stream whose chunks are always ready resolves every read without
  // yielding to the event loop, so the timer cannot fire; the clock is
  // checked after each read as well. Workers' clock stands still until the
  // next I/O, so there such a read is bounded by maximumBytes alone: a timer
  // yield would fix that, but would also hang callers' tests on fake timers.
  const deadline = Date.now() + timeoutMs;
  signal?.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      const next = await new Promise<ReadableStreamReadResult<unknown>>((resolve, reject) => {
        if (stopped !== undefined) {
          reject(stopped);
          return;
        }
        rejectPendingRead = reject;
        reader.read().then(resolve, reject);
      });
      rejectPendingRead = undefined;
      if (Date.now() >= deadline) {
        throw new HttpBodyError('BODY_READ_TIMEOUT');
      }
      if (next.done) {
        break;
      }
      const chunk = next.value;
      if (!isUint8Array(chunk)) {
        throw new HttpBodyError('BODY_READ_FAILED', {
          cause: new TypeError('A body chunk is not a Uint8Array.'),
        });
      }
      if (chunk.byteLength === 0) {
        emptyChunks += 1;
        if (emptyChunks > maximumEmptyChunks) {
          throw new HttpBodyError('BODY_READ_FAILED', {
            cause: new TypeError(`The body yielded more than ${maximumEmptyChunks} empty chunks.`),
          });
        }
        continue;
      }
      const end = received + chunk.byteLength;
      if (end > maximumBytes) {
        throw new HttpBodyError('BODY_TOO_LARGE');
      }
      if (end > bytes.byteLength) {
        const grown = new Uint8Array(
          Math.min(maximumBytes, Math.max(end, bytes.byteLength * 2, 4096)),
        );
        grown.set(bytes.subarray(0, received));
        bytes = grown;
      }
      bytes.set(chunk, received);
      received = end;
    }
    if (stopped !== undefined) {
      throw stopped;
    }
  } catch (error) {
    let failure = stopped;
    if (failure === undefined && signal?.aborted === true) {
      // A fetch aborted by the same signal errors its body stream as well.
      failure = new HttpBodyError('BODY_READ_ABORTED', { cause: signal.reason });
    }
    failure ??=
      error instanceof HttpBodyError
        ? error
        : new HttpBodyError('BODY_READ_FAILED', { cause: error });
    stop(failure);
    throw failure;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
  return bytes.subarray(0, received);
}

// `instanceof` alone misses a Uint8Array from another realm, such as a test DOM's.
function isUint8Array(value: unknown): value is Uint8Array {
  return (
    value instanceof Uint8Array ||
    (ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === '[object Uint8Array]')
  );
}

/** Strict UTF-8, as fetch's `text()` decodes: a leading byte order mark is dropped. */
function decodeUtf8(bytes: Uint8Array): string {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    return decoder.decode(bytes);
  } catch (cause) {
    throw new HttpBodyError('INVALID_UTF8', { cause });
  }
}

function parseJson(bytes: Uint8Array): unknown {
  if (bytes.byteLength === 0) {
    throw new HttpBodyError('EMPTY_BODY');
  }
  const text = decodeUtf8(bytes);
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new HttpBodyError('INVALID_JSON', { cause });
  }
}
