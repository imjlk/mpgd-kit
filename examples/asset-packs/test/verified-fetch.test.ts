import { createHash } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PlannedImage } from '../src/packs.js';
import { verifiedImage } from '../src/verified-fetch.js';

const bytes = new Uint8Array([1, 2, 3]);
const image: PlannedImage = {
  id: 'image', packId: 'test', identity: 'test/v1/image', path: 'packs/image.png',
  mediaType: 'image/png', bytes: bytes.length, width: 1, height: 1,
  sha256: createHash('sha256').update(bytes).digest('hex'),
};
const url = new URL('https://assets.example.test/packs/image.png');
afterEach(() => vi.unstubAllGlobals());

describe('verified image stream failures', () => {
  it('preserves a read failure and releases the lock when cancellation also rejects', async () => {
    const failure = new Error('original read failure');
    const releaseLock = vi.fn();
    const reader = { read: vi.fn().mockRejectedValue(failure), cancel: vi.fn().mockRejectedValue(new Error('errored stream')), releaseLock };
    const fetch = vi.fn().mockResolvedValue({ ok: true, body: { getReader: () => reader } });
    vi.stubGlobal('fetch', fetch);
    await expect(verifiedImage(url, image, new AbortController().signal)).rejects.toBe(failure);
    expect(releaseLock).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('retries HTTP 500 even if discarding its error body fails, preserving catalog MIME', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 500, body: { cancel: vi.fn().mockRejectedValue(new Error('errored body')) } })
      .mockResolvedValueOnce(new Response(bytes));
    vi.stubGlobal('fetch', fetch);
    const blob = await verifiedImage(url, image, new AbortController().signal);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
    expect(blob.type).toBe('image/png');
  });

  it('fails clearly before fetching when digest verification is unavailable', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('crypto', undefined);
    vi.stubGlobal('fetch', fetch);
    await expect(verifiedImage(url, image, new AbortController().signal)).rejects.toThrow('secure context');
    expect(fetch).not.toHaveBeenCalled();
  });
});
