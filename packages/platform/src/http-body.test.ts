import { getEventListeners } from 'node:events';
import { runInNewContext } from 'node:vm';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  HttpBodyError,
  readBoundedJsonRequest,
  readBoundedJsonResponse,
  readBoundedRequestText,
  readBoundedResponseText,
  type HttpBodyErrorCode,
} from './http-body.js';

const encoder = new TextEncoder();
const json = { 'Content-Type': 'application/json' };

interface TrackedBody {
  readonly stream: ReadableStream<Uint8Array>;
  /** How many chunks the reader asked for. */
  pulls(): number;
  /** The cancel reason, once the body was cancelled. */
  cancelled(): { readonly reason: unknown } | undefined;
}

/**
 * A body that hands out one chunk per read, then closes or, with `stall`,
 * never answers again. Strings are UTF-8 encoded unless `raw`; other values
 * are enqueued as they are. It pulls nothing until a reader asks.
 */
function trackedBody(
  chunks: readonly unknown[],
  { stall = false, raw = false } = {},
): TrackedBody {
  const queue = chunks.map((chunk) =>
    typeof chunk === 'string' && !raw ? encoder.encode(chunk) : chunk,
  );
  let pulls = 0;
  let cancelled: { readonly reason: unknown } | undefined;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulls += 1;
        if (queue.length > 0) {
          controller.enqueue(queue.shift() as Uint8Array);
          return undefined;
        }
        if (stall) {
          return new Promise<void>(() => undefined);
        }
        controller.close();
        return undefined;
      },
      cancel(reason) {
        cancelled = { reason };
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, pulls: () => pulls, cancelled: () => cancelled };
}

function post(body: BodyInit | null, headers: HeadersInit = json): Request {
  return new Request('https://game.example/api/score', {
    method: 'POST',
    headers,
    body,
    duplex: 'half',
  } as RequestInit);
}

async function refusal(read: Promise<unknown>): Promise<HttpBodyError> {
  const error: unknown = await read.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(HttpBodyError);
  return error as HttpBodyError;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('HttpBodyError', () => {
  it('keeps one status per stable code', () => {
    const statuses = {
      JSON_REQUIRED: 415,
      INVALID_CONTENT_LENGTH: 400,
      BODY_TOO_LARGE: 413,
      BODY_READ_TIMEOUT: 408,
      BODY_READ_ABORTED: 400,
      BODY_READ_FAILED: 400,
      INVALID_UTF8: 400,
      EMPTY_BODY: 400,
      INVALID_JSON: 400,
    } satisfies Record<HttpBodyErrorCode, number>;

    for (const [code, status] of Object.entries(statuses)) {
      const error = new HttpBodyError(code as HttpBodyErrorCode);
      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe('HttpBodyError');
      expect([error.code, error.status]).toEqual([code, status]);
      expect(error.message).not.toBe('');
      expect('cause' in error).toBe(false);
    }
    const cause = new SyntaxError('Unexpected end of JSON input');
    expect(new HttpBodyError('INVALID_JSON', { cause }).cause).toBe(cause);
  });
});

describe('size limit', () => {
  it('refuses a declared Content-Length over the limit, a request before reading', async () => {
    const request = trackedBody(['{}', '{}']);
    const requestError = await refusal(
      readBoundedJsonRequest(post(request.stream, { ...json, 'Content-Length': '17' }), 16),
    );
    expect([requestError.code, requestError.status]).toEqual(['BODY_TOO_LARGE', 413]);
    // The server runtime discards a request body it did not read.
    expect([request.pulls(), request.cancelled()]).toEqual([0, undefined]);

    // A response's declared length counts once its first byte arrives.
    const response = trackedBody(['{}', '{}']);
    const responseError = await refusal(
      readBoundedJsonResponse(
        new Response(response.stream, { headers: { ...json, 'Content-Length': '17' } }),
        16,
      ),
    );
    expect(responseError.code).toBe('BODY_TOO_LARGE');
    // Nothing else releases a response body, so the reader cancels it.
    expect([response.pulls(), response.cancelled()]).toEqual([1, { reason: responseError }]);
  });

  it('refuses a streamed body once the bytes read pass the limit, and cancels it', async () => {
    // 6 + 6 + 5 bytes: the third chunk passes 16, and the fourth is never read.
    const body = trackedBody(['["0123', '456789', '01234', '56789"]']);
    const error = await refusal(readBoundedJsonRequest(post(body.stream), 16));
    expect([error.code, error.status]).toEqual(['BODY_TOO_LARGE', 413]);
    expect(body.pulls()).toBe(3);
    expect(body.cancelled()).toEqual({ reason: error });
  });

  it('counts the bytes read even when the declared length is smaller', async () => {
    const body = trackedBody(['"0123456789', '0123456789"']);
    const error = await refusal(
      readBoundedJsonResponse(
        new Response(body.stream, { headers: { ...json, 'Content-Length': '2' } }),
        16,
      ),
    );
    expect(error.code).toBe('BODY_TOO_LARGE');
    expect(body.cancelled()).toEqual({ reason: error });
  });

  it('accepts a body of exactly the limit, declared or streamed', async () => {
    const text = '"0123456789abcd"';
    expect(text).toHaveLength(16);
    const declared = new Response(text, { headers: { ...json, 'Content-Length': '16' } });
    await expect(readBoundedJsonResponse(declared, 16)).resolves.toBe('0123456789abcd');
    const streamed = trackedBody(['"01234567', '89abcd"']);
    await expect(readBoundedJsonRequest(post(streamed.stream), 16)).resolves.toBe(
      '0123456789abcd',
    );
    // Multi-byte characters count as bytes, not as string length.
    await expect(readBoundedResponseText(new Response('é'.repeat(8)), 16)).resolves.toBe(
      'é'.repeat(8),
    );
    await expect(
      refusal(readBoundedResponseText(new Response('é'.repeat(9)), 16)),
    ).resolves.toMatchObject({ code: 'BODY_TOO_LARGE' });
  });

  it('refuses a Content-Length that is not one decimal length', async () => {
    for (const declared of ['abc', '-1', '1.5', '1e3', '0x10', '', '10, 11', '10,']) {
      const request = trackedBody(['{}']);
      const error = await refusal(
        readBoundedJsonRequest(post(request.stream, { ...json, 'Content-Length': declared }), 64),
      );
      expect([declared, error.code, error.status]).toEqual([
        declared,
        'INVALID_CONTENT_LENGTH',
        400,
      ]);
      expect([request.pulls(), request.cancelled()]).toEqual([0, undefined]);

      const response = trackedBody(['{}']);
      const responseError = await refusal(
        readBoundedJsonResponse(
          new Response(response.stream, { headers: { ...json, 'Content-Length': declared } }),
          64,
        ),
      );
      expect(responseError.code).toBe('INVALID_CONTENT_LENGTH');
      expect(response.cancelled()).toEqual({ reason: responseError });
    }
    // Repeated fields that agree, as Headers joins them, are one length.
    const repeated = new Headers(json);
    repeated.append('Content-Length', '2');
    repeated.append('Content-Length', '2');
    expect(repeated.get('Content-Length')).toBe('2, 2');
    await expect(readBoundedJsonResponse(new Response('{}', { headers: repeated }), 64)).resolves
      .toEqual({});
  });
});

describe('timeout and abort', () => {
  it('stops a stalled body after the timeout and cancels it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const body = trackedBody(['{"partial":'], { stall: true });
    let settled = false;
    const read = refusal(readBoundedJsonRequest(post(body.stream), 1024)).finally(() => {
      settled = true;
    });

    // 10 seconds by default.
    await vi.advanceTimersByTimeAsync(9_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const error = await read;
    expect([error.code, error.status]).toEqual(['BODY_READ_TIMEOUT', 408]);
    expect(body.cancelled()).toEqual({ reason: error });
  });

  it('bounds the whole read, not the wait for each chunk', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let pulls = 0;
    let cancelled = false;
    const trickle = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          return new Promise<void>((resolve) => {
            setTimeout(() => {
              if (!cancelled) {
                controller.enqueue(encoder.encode(' '));
              }
              resolve();
            }, 100);
          });
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const read = refusal(
      readBoundedResponseText(new Response(trickle), 1_000_000, { timeoutMs: 1_000 }),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await read).code).toBe('BODY_READ_TIMEOUT');
    expect(pulls).toBeGreaterThan(5);
    expect(cancelled).toBe(true);
  });

  it('times out a stream whose chunks are always ready, before the timer can', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    let pulls = 0;
    let cancelled = false;
    const ready = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          if (pulls > 100) {
            controller.close();
            return;
          }
          // Each chunk is ready at once but costs 1 ms; no timer runs meanwhile.
          vi.setSystemTime(Date.now() + 1);
          controller.enqueue(encoder.encode(' '));
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const error = await refusal(
      readBoundedResponseText(new Response(ready), 1024, { timeoutMs: 50 }),
    );
    expect([error.code, pulls, cancelled]).toEqual(['BODY_READ_TIMEOUT', 50, true]);
  });

  it('does not wait for a cancel that the stream never finishes', async () => {
    // A body whose source never finishes its cancel step.
    const stuck = (pull: NonNullable<UnderlyingDefaultSource<Uint8Array>['pull']>) => {
      const record = { cancelled: false };
      const stream = new ReadableStream<Uint8Array>(
        {
          pull,
          cancel: () => {
            record.cancelled = true;
            return new Promise<void>(() => undefined);
          },
        },
        { highWaterMark: 0 },
      );
      return { stream, record };
    };

    const stalled = stuck(() => new Promise<void>(() => undefined));
    const timeout = await refusal(
      readBoundedResponseText(new Response(stalled.stream), 64, { timeoutMs: 20 }),
    );
    expect([timeout.code, stalled.record.cancelled]).toEqual(['BODY_READ_TIMEOUT', true]);

    const oversized = stuck((controller) => controller.enqueue(encoder.encode('x'.repeat(65))));
    const tooLarge = await refusal(readBoundedResponseText(new Response(oversized.stream), 64));
    expect([tooLarge.code, oversized.record.cancelled]).toEqual(['BODY_TOO_LARGE', true]);
  });

  it('refuses an already aborted signal before reading', async () => {
    const reason = new Error('player left');
    const signal = AbortSignal.abort(reason);

    const request = trackedBody(['{}']);
    const requestError = await refusal(
      readBoundedJsonRequest(post(request.stream), 64, { signal }),
    );
    expect([requestError.code, requestError.status, requestError.cause]).toEqual([
      'BODY_READ_ABORTED',
      400,
      reason,
    ]);
    expect([request.pulls(), request.cancelled()]).toEqual([0, undefined]);

    const response = trackedBody(['{}']);
    const responseError = await refusal(
      readBoundedJsonResponse(new Response(response.stream, { headers: json }), 64, { signal }),
    );
    expect(responseError.code).toBe('BODY_READ_ABORTED');
    expect([response.pulls(), response.cancelled()]).toEqual([0, { reason: responseError }]);
  });

  it('stops reading when the signal aborts and cancels the body', async () => {
    const controller = new AbortController();
    const body = trackedBody(['{"partial":'], { stall: true });
    const read = refusal(
      readBoundedJsonResponse(new Response(body.stream, { headers: json }), 1024, {
        signal: controller.signal,
      }),
    );
    await vi.waitFor(() => expect(body.pulls()).toBe(2));
    const reason = new Error('navigated away');
    controller.abort(reason);
    const error = await read;
    expect([error.code, error.cause]).toEqual(['BODY_READ_ABORTED', reason]);
    expect(body.cancelled()).toEqual({ reason: error });
  });

  it('reports an abort that also errors the body stream as an abort', async () => {
    // fetch errors a response body with the abort reason when its signal aborts.
    const controller = new AbortController();
    const fetchedBody = new ReadableStream<Uint8Array>({
      start(stream) {
        controller.signal.addEventListener('abort', () => stream.error(controller.signal.reason));
      },
    });
    const read = refusal(
      readBoundedResponseText(new Response(fetchedBody), 1024, { signal: controller.signal }),
    );
    await Promise.resolve();
    controller.abort();
    const error = await read;
    expect(error.code).toBe('BODY_READ_ABORTED');
    expect(error.cause).toBeInstanceOf(DOMException);
    expect((error.cause as DOMException).name).toBe('AbortError');
  });

  it('releases its timer and abort listener whether the read succeeds or fails', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { signal } = new AbortController();

    await readBoundedJsonResponse(new Response('{"ok":true}', { headers: json }), 64, { signal });
    expect([vi.getTimerCount(), getEventListeners(signal, 'abort').length]).toEqual([0, 0]);

    await refusal(
      readBoundedJsonResponse(new Response('[1,2,3]', { headers: json }), 4, { signal }),
    );
    expect([vi.getTimerCount(), getEventListeners(signal, 'abort').length]).toEqual([0, 0]);
  });
});

describe('UTF-8', () => {
  it('refuses bytes that are not UTF-8', async () => {
    const sequences = [
      [0xff],
      [0x22, 0xc3, 0x28, 0x22],
      [0x22, 0xe2, 0x82],
      [0x22, 0xed, 0xa0, 0x80, 0x22],
      [0x22, 0xc0, 0xaf, 0x22],
    ];
    for (const sequence of sequences) {
      const bytes = new Uint8Array(sequence);
      const jsonError = await refusal(
        readBoundedJsonResponse(new Response(bytes, { headers: json }), 64),
      );
      const textError = await refusal(readBoundedRequestText(post(bytes, {}), 64));
      expect([jsonError.code, jsonError.status, textError.code]).toEqual([
        'INVALID_UTF8',
        400,
        'INVALID_UTF8',
      ]);
      expect(jsonError.cause).toBeInstanceOf(TypeError);
    }
  });

  it('decodes characters split across chunks and drops a byte order mark', async () => {
    const euro = encoder.encode('"€😀"');
    const body = trackedBody([euro.slice(0, 2), euro.slice(2, 5), euro.slice(5)]);
    await expect(readBoundedJsonRequest(post(body.stream), 64)).resolves.toBe('€😀');

    const marked = new Uint8Array([0xef, 0xbb, 0xbf, ...encoder.encode('{"a":1}')]);
    await expect(readBoundedJsonResponse(new Response(marked, { headers: json }), 64)).resolves
      .toEqual({ a: 1 });
    await expect(readBoundedResponseText(new Response(marked), 64)).resolves.toBe('{"a":1}');
  });

  it('decodes UTF-8 whatever charset the Content-Type names', async () => {
    const latin1 = new Response(new Uint8Array([0x63, 0x61, 0x66, 0xe9]), {
      headers: { 'Content-Type': 'text/plain; charset=iso-8859-1' },
    });
    await expect(refusal(readBoundedResponseText(latin1, 64))).resolves.toMatchObject({
      code: 'INVALID_UTF8',
    });
  });
});

describe('content type', () => {
  it('requires a JSON media type, and only for the JSON readers', async () => {
    const refused = [
      undefined,
      'text/plain',
      'application/x-www-form-urlencoded',
      'multipart/form-data; boundary=x',
      'application/jsonp',
      'application/json-seq',
      'text/plain, application/json',
      'json',
      'application/',
    ];
    for (const contentType of refused) {
      const headers: Record<string, string> =
        contentType === undefined ? {} : { 'Content-Type': contentType };

      const request = trackedBody(['{}']);
      const requestError = await refusal(readBoundedJsonRequest(post(request.stream, headers), 64));
      expect([contentType, requestError.code, requestError.status]).toEqual([
        contentType,
        'JSON_REQUIRED',
        415,
      ]);
      expect([request.pulls(), request.cancelled()]).toEqual([0, undefined]);

      const response = trackedBody(['{}']);
      const responseError = await refusal(
        readBoundedJsonResponse(new Response(response.stream, { headers }), 64),
      );
      expect(responseError.code).toBe('JSON_REQUIRED');
      expect([response.pulls(), response.cancelled()]).toEqual([0, { reason: responseError }]);

      await expect(readBoundedRequestText(post('{}', headers), 64)).resolves.toBe('{}');
      await expect(readBoundedResponseText(new Response('{}', { headers }), 64)).resolves.toBe(
        '{}',
      );
    }

    const accepted = [
      'application/json',
      'application/json; charset=utf-8',
      'APPLICATION/JSON',
      'application/problem+json',
      'application/vnd.api+json; ext="https://example.com/ext"',
      'text/json',
    ];
    for (const contentType of accepted) {
      await expect(
        readBoundedJsonRequest(post('{"ok":true}', { 'Content-Type': contentType }), 64),
      ).resolves.toEqual({ ok: true });
    }
  });
});

describe('empty bodies', () => {
  it('refuses an empty JSON body and reads empty text as an empty string', async () => {
    const emptyJson = [
      new Request('https://game.example/api/score', { headers: json }),
      post(null),
      post('', { ...json, 'Content-Length': '0' }),
      post(trackedBody([]).stream),
    ];
    for (const request of emptyJson) {
      const error = await refusal(readBoundedJsonRequest(request, 64));
      expect([error.code, error.status]).toEqual(['EMPTY_BODY', 400]);
    }
    const error = await refusal(
      readBoundedJsonResponse(new Response(null, { status: 204, headers: json }), 64),
    );
    expect(error.code).toBe('EMPTY_BODY');

    await expect(readBoundedRequestText(new Request('https://game.example/'), 64)).resolves.toBe(
      '',
    );
    await expect(readBoundedResponseText(new Response(''), 64)).resolves.toBe('');
    await expect(readBoundedResponseText(new Response(null), 64)).resolves.toBe('');
  });
});

describe('bodyless messages', () => {
  it('reads a message without a body as empty, whatever its headers describe', async () => {
    // A response to HEAD, or a 304, keeps the Content-Type and Content-Length
    // of the representation it describes.
    const head = () =>
      new Response(null, { headers: { 'Content-Type': 'text/html', 'Content-Length': '1024' } });
    await expect(readBoundedResponseText(head(), 64)).resolves.toBe('');
    await expect(refusal(readBoundedJsonResponse(head(), 64))).resolves.toMatchObject({
      code: 'EMPTY_BODY',
    });

    const notModified = new Response(null, { status: 304, headers: { 'Content-Length': 'x' } });
    await expect(readBoundedResponseText(notModified, 64)).resolves.toBe('');
    const noContent = new Response(null, { status: 204 });
    await expect(refusal(readBoundedJsonResponse(noContent, 64))).resolves.toMatchObject({
      code: 'EMPTY_BODY',
    });

    const get = new Request('https://game.example/', { headers: { 'Content-Length': '999' } });
    await expect(readBoundedRequestText(get, 64)).resolves.toBe('');

    // Chromium and WebKit give a response to HEAD an empty stream, not a null body.
    const emptyHead = (contentLength: string) =>
      new Response(trackedBody([]).stream, {
        headers: { ...json, 'Content-Length': contentLength },
      });
    await expect(readBoundedResponseText(emptyHead('1024'), 64)).resolves.toBe('');
    await expect(readBoundedResponseText(emptyHead('x'), 64)).resolves.toBe('');
    await expect(refusal(readBoundedJsonResponse(emptyHead('1024'), 64))).resolves.toMatchObject(
      { code: 'EMPTY_BODY' },
    );
  });
});

describe('JSON syntax', () => {
  it('refuses a body that is not JSON and keeps the syntax error', async () => {
    for (const text of ['{', '{"a":1}x', "{'a':1}", '   ', 'undefined']) {
      const error = await refusal(readBoundedJsonRequest(post(text), 64));
      expect([text, error.code, error.status]).toEqual([text, 'INVALID_JSON', 400]);
      expect(error.cause).toBeInstanceOf(SyntaxError);
    }
  });

  it('returns any JSON value unchecked', async () => {
    const values = ['null', '0', '"x"', 'true', '[1,{"b":[null]}]', ' {"nested":{"a":1}} '];
    for (const text of values) {
      await expect(readBoundedJsonResponse(new Response(text, { headers: json }), 64)).resolves
        .toEqual(JSON.parse(text));
    }
  });
});

describe('body ownership', () => {
  it('refuses a body that was already read, even partly, with a TypeError', async () => {
    const used = new Response('{}', { headers: json });
    await used.text();
    await expect(readBoundedJsonResponse(used, 64)).rejects.toThrow(TypeError);

    const partly = new Response('{"a":1}', { headers: json });
    const reader = partly.body?.getReader();
    await reader?.read();
    reader?.releaseLock();
    expect([partly.bodyUsed, partly.body?.locked]).toEqual([true, false]);
    await expect(readBoundedJsonResponse(partly, 64)).rejects.toThrow(TypeError);

    const locked = new Response('{}', { headers: json });
    locked.body?.getReader();
    await expect(readBoundedResponseText(locked, 64)).rejects.toThrow(TypeError);
  });

  it('refuses a request whose runtime has no body stream with a TypeError', async () => {
    // Firefox implements Request but not Request.body.
    const firefoxRequest = { body: undefined, bodyUsed: false, headers: new Headers(json) };
    await expect(
      readBoundedJsonRequest(firefoxRequest as unknown as Request, 64),
    ).rejects.toThrow(new TypeError('This runtime does not expose the body as a stream.'));
  });

  it('reports a failed stream and a chunk that is not bytes as BODY_READ_FAILED', async () => {
    const reset = new TypeError('terminated');
    const failing = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(reset);
      },
    });
    const failed = await refusal(readBoundedResponseText(new Response(failing), 64));
    expect([failed.code, failed.status, failed.cause]).toEqual(['BODY_READ_FAILED', 400, reset]);

    // A Response hands out a stream it was given as it is, so its chunks may be anything.
    for (const chunk of ['{"a":1}', new Uint16Array([0x7b7b]), [123, 125]]) {
      const body = trackedBody([chunk], { raw: true });
      const notBytes = await refusal(
        readBoundedJsonResponse(new Response(body.stream, { headers: json }), 64),
      );
      expect(notBytes.code).toBe('BODY_READ_FAILED');
      expect(notBytes.cause).toBeInstanceOf(TypeError);
      expect(body.cancelled()).toEqual({ reason: notBytes });
    }
  });

  it('skips empty chunks but stops a stream that yields nothing else', async () => {
    const empty = new Uint8Array(0);
    const sparse = trackedBody([empty, '{"a":', empty, empty, '1}', empty]);
    await expect(readBoundedJsonRequest(post(sparse.stream), 64)).resolves.toEqual({ a: 1 });

    // Each read resolves at once, so the timer never gets a turn, and where the
    // clock does not move between such reads either (workerd), only a count stops it.
    let cancelled = false;
    const endless = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          controller.enqueue(new Uint8Array(0));
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const error = await refusal(readBoundedResponseText(new Response(endless), 64));
    expect([error.code, (error.cause as Error).message, cancelled]).toEqual([
      'BODY_READ_FAILED',
      'The body yielded more than 1024 empty chunks.',
      true,
    ]);
  });

  it('copies each chunk before the source can reuse its buffer', async () => {
    const text = encoder.encode('["ab","cd"]');
    const shared = new Uint8Array(4);
    let offset = 0;
    const reusing = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (offset >= text.byteLength) {
            controller.close();
            return;
          }
          const length = Math.min(shared.byteLength, text.byteLength - offset);
          shared.set(text.subarray(offset, offset + length));
          controller.enqueue(shared.subarray(0, length));
          offset += length;
        },
      },
      { highWaterMark: 0 },
    );
    await expect(readBoundedJsonResponse(new Response(reusing, { headers: json }), 64)).resolves
      .toEqual(['ab', 'cd']);
  });

  it('accepts byte chunks from another realm', async () => {
    const foreign = runInNewContext('new Uint8Array([123, 34, 97, 34, 58, 49, 125])') as unknown;
    expect(foreign instanceof Uint8Array).toBe(false);
    const body = trackedBody([foreign]);
    await expect(readBoundedJsonRequest(post(body.stream), 64)).resolves.toEqual({ a: 1 });
  });

  it('refuses invalid limits with a RangeError before touching the body', async () => {
    const invalid: readonly [number, number | undefined][] = [
      [0, undefined],
      [-1, undefined],
      [1.5, undefined],
      [Number.NaN, undefined],
      [Number.POSITIVE_INFINITY, undefined],
      [64, 0],
      [64, 1.5],
      [64, 2_147_483_648],
    ];
    for (const [maximumBytes, timeoutMs] of invalid) {
      const body = trackedBody(['{}']);
      const response = new Response(body.stream, { headers: json });
      await expect(readBoundedJsonResponse(response, maximumBytes, { timeoutMs })).rejects.toThrow(
        RangeError,
      );
      expect([response.bodyUsed, body.pulls(), body.cancelled()]).toEqual([false, 0, undefined]);
    }
  });
});
