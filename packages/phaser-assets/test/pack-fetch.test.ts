import { createHash } from 'node:crypto';

import { afterEach, expect, it, vi } from 'vitest';

import { fetchPackFile } from '../src/pack-fetch.js';
const bytes = new Uint8Array([1, 2, 3]);
const integrity = {
  bytes: 3,
  sha256: createHash('sha256').update(bytes).digest('hex'),
};
const options = () => ({
  signal: new AbortController().signal,
  retries: 1,
  maxFileBytes: 8,
  integrity,
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it('preserves read errors and releases the reader lock when cancelling an errored stream fails', async () => {
  const failure = new Error('read failed');
  const releaseLock = vi.fn();
  const reader = {
    read: vi.fn().mockRejectedValue(failure), cancel: vi.fn().mockRejectedValue(new Error('cancel failed')), releaseLock,
  };
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true, body: {
      getReader: () => reader,
    },
  }));
  await expect(fetchPackFile('/image.png', options())).rejects.toBe(failure);
  expect(releaseLock).toHaveBeenCalledOnce();
});
it('retains retry classification if discarding an HTTP error body rejects', async () => {
  const fetch = vi.fn().mockResolvedValueOnce({
    ok: false, status: 500, body: {
      cancel: vi.fn().mockRejectedValue(new Error('broken body')),
    },
  }).mockResolvedValueOnce(new Response(bytes));
  vi.stubGlobal('fetch', fetch);
  expect(new Uint8Array(await (await fetchPackFile('/image.png', options())).arrayBuffer())).toEqual(bytes);
  expect(fetch).toHaveBeenCalledTimes(2);
});
it.each([
  [new Uint8Array([1, 2]), 'size mismatch'],
  [new Uint8Array([1, 2, 3, 4]), 'size mismatch'],
  [new Uint8Array([3, 2, 1]), 'digest mismatch'],
])('does not retry invalid encoded content', async (body, message) => {
  const fetch = vi.fn(async () => new Response(body));
  vi.stubGlobal('fetch', fetch);
  await expect(fetchPackFile('/image.png', options())).rejects.toThrow(message);
  expect(fetch).toHaveBeenCalledOnce();
});
it('caps streaming bodies even without integrity metadata', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(9))));
  await expect(fetchPackFile('/image.png', {
    signal: new AbortController().signal, retries: 0, maxFileBytes: 8,
  })).rejects.toThrow('byte limit');
});
it('does not expose signed URLs in terminal network errors', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockRejectedValue(new TypeError('https://assets.example/file?secret=private')),
  );
  await expect(fetchPackFile('https://assets.example/file?secret=private', options())).rejects.toThrow('Asset network request failed');
  expect(fetch).toHaveBeenCalledTimes(2);
});
it('rejects unavailable integrity verification before downloading', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  vi.stubGlobal('crypto', undefined);
  await expect(fetchPackFile('/image.png', options())).rejects.toThrow('requires HTTPS or localhost');
  expect(fetch).not.toHaveBeenCalled();
});

it('aborts a stalled response body at the per-request deadline', async () => {
  vi.useFakeTimers();
  let requestSignal: AbortSignal | undefined;
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    requestSignal = init.signal as AbortSignal;
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
        requestSignal?.addEventListener('abort', () => controller.error(requestSignal?.reason), { once: true });
      },
    }));
  }));
  const failed = expect(fetchPackFile('/stalled', {
    signal: new AbortController().signal, retries: 0, maxFileBytes: 10, requestTimeoutMs: 20,
  })).rejects.toThrow('request timed out');
  await vi.advanceTimersByTimeAsync(20);
  await failed;
  expect(requestSignal?.aborted).toBe(true);
  vi.useRealTimers();
});

it('ends the request deadline before non-abortable integrity hashing', async () => {
  vi.useFakeTimers();
  let finish!: (value: ArrayBuffer) => void;
  let started!: () => void;
  const hashing = new Promise<void>((resolve) => {
    started = resolve; });
  const digest = new Promise<ArrayBuffer>((resolve) => {
    finish = resolve; });
  const realDigest = await crypto.subtle.digest('SHA-256', bytes);
  vi.stubGlobal('crypto', { subtle: { digest: () => {
        started();
        return digest; } } });
  let requestSignal: AbortSignal | undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, init: RequestInit) => {
      requestSignal = init.signal as AbortSignal;
      return new Response(bytes);
    }),
  );
  const work = fetchPackFile('/image.png', { ...options(), requestTimeoutMs: 10 });
  await hashing;
  await vi.advanceTimersByTimeAsync(20);
  expect(requestSignal?.aborted).toBe(false);
  finish(realDigest);
  expect((await work).size).toBe(3);
  expect(fetch).toHaveBeenCalledOnce();
});

it('honors Retry-After and still aborts an outstanding backoff', async () => {
  vi.useFakeTimers();
  const serverBusy = () => new Response('', { status: 429, headers: { 'Retry-After': '1' } });
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValueOnce(serverBusy()).mockResolvedValueOnce(new Response(bytes)),
  );
  const first = fetchPackFile('/image.png', options());
  await vi.advanceTimersByTimeAsync(999);
  expect(fetch).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  await first;
  expect(fetch).toHaveBeenCalledTimes(2);
  vi.mocked(fetch).mockResolvedValueOnce(serverBusy());
  const cancel = new AbortController();
  const cancelled = expect(fetchPackFile('/image.png', { ...options(), signal: cancel.signal })).rejects.toMatchObject({ name: 'AbortError' });
  await vi.advanceTimersByTimeAsync(100);
  cancel.abort();
  await cancelled;
  await vi.advanceTimersByTimeAsync(1000);
  expect(fetch).toHaveBeenCalledTimes(3);
});
