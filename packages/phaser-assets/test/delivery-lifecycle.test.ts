import { describe, expect, it, vi } from 'vitest';

import { acquireDeliveredPack, type AcquireDeliveredPackOptions } from '../src/delivery.js';
import type { PhaserAssetPackLease } from '../src/packs.js';

function fixture() {
  const prepared = { release: vi.fn() };
  const lease: PhaserAssetPackLease = { key: vi.fn(() => 'texture-key'), release: vi.fn() };
  const delivery = { prepare: vi.fn(async () => prepared) };
  const loader = { acquire: vi.fn(async () => lease) };
  return { prepared, lease, delivery, loader };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((fulfill, fail) => {
    resolve = fulfill;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe('acquireDeliveredPack', () => {
  it('holds preparation until acquisition settles, then hands the lease to the caller', async () => {
    const f = fixture();
    const preparing = deferred<typeof f.prepared>();
    const acquiring = deferred<PhaserAssetPackLease>();
    f.delivery.prepare.mockReturnValue(preparing.promise);
    f.loader.acquire.mockReturnValue(acquiring.promise);
    const signal = new AbortController().signal;
    const onTextureProgress = vi.fn();
    const pending = acquireDeliveredPack({ ...f, packId: 'grove', signal, onTextureProgress });
    expect(f.delivery.prepare).toHaveBeenCalledWith('grove', { signal });
    expect(f.delivery.prepare.mock.contexts[0]).toBe(f.delivery);
    expect(f.loader.acquire).not.toHaveBeenCalled();
    preparing.resolve(f.prepared);
    await Promise.resolve();
    expect(f.loader.acquire).toHaveBeenCalledWith('grove', { signal, onProgress: onTextureProgress });
    expect(f.loader.acquire.mock.contexts[0]).toBe(f.loader);
    expect(f.prepared.release).not.toHaveBeenCalled();
    acquiring.resolve(f.lease);
    await expect(pending).resolves.toBe(f.lease);
    expect(f.prepared.release).toHaveBeenCalledOnce();
    expect(f.prepared.release.mock.contexts[0]).toBe(f.prepared);
    expect(f.lease.release).not.toHaveBeenCalled();
    f.lease.release();
    expect(f.lease.release).toHaveBeenCalledOnce();
  });

  it.each(['failed', 'cancelled'])('does not acquire when preparation is %s', async (kind) => {
    const f = fixture();
    const reason = new Error(kind);
    f.delivery.prepare.mockRejectedValue(reason);
    await expect(acquireDeliveredPack({ ...f, packId: 'grove' })).rejects.toBe(reason);
    expect(f.loader.acquire).not.toHaveBeenCalled();
    expect(f.prepared.release).not.toHaveBeenCalled();
  });

  it.each([false, true])('returns preparation after an acquisition failure (synchronous=%s)', async (sync) => {
    const f = fixture();
    const reason = new Error('decode failed');
    f.loader.acquire.mockImplementation(() => {
      if (sync) {
        throw reason;
      }
      return Promise.reject(reason);
    });
    await expect(acquireDeliveredPack({ ...f, packId: 'grove' })).rejects.toBe(reason);
    expect(f.prepared.release).toHaveBeenCalledOnce();
    expect(f.lease.release).not.toHaveBeenCalled();
  });

  it('returns preparation after in-flight acquisition cancellation', async () => {
    const f = fixture();
    const controller = new AbortController();
    const acquiring = deferred<PhaserAssetPackLease>();
    f.loader.acquire.mockReturnValue(acquiring.promise);
    const reason = new Error('cancelled');
    const pending = acquireDeliveredPack({ ...f, packId: 'grove', signal: controller.signal });
    await Promise.resolve();
    expect(f.loader.acquire).toHaveBeenCalledWith('grove', { signal: controller.signal });
    controller.abort(reason);
    acquiring.reject(controller.signal.reason);
    await expect(pending).rejects.toBe(reason);
    expect(f.prepared.release).toHaveBeenCalledOnce();
  });

  it('pins the operation inputs while preparation is pending', async () => {
    const f = fixture();
    const preparing = deferred<typeof f.prepared>();
    f.delivery.prepare.mockReturnValue(preparing.promise);
    const options = {
      delivery: f.delivery, loader: f.loader, packId: 'grove',
    } satisfies AcquireDeliveredPackOptions;
    const pending = acquireDeliveredPack(options);
    const replacement = fixture();
    options.loader = replacement.loader;
    options.packId = 'dunes';
    preparing.resolve(f.prepared);
    await expect(pending).resolves.toBe(f.lease);
    expect(f.loader.acquire).toHaveBeenCalledWith('grove', {});
    expect(replacement.loader.acquire).not.toHaveBeenCalled();
    expect(f.prepared.release).toHaveBeenCalledOnce();
  });

  it('does not reclaim a successful lease when its request signal later aborts', async () => {
    const f = fixture();
    const controller = new AbortController();
    const lease = await acquireDeliveredPack({ ...f, packId: 'grove', signal: controller.signal });
    controller.abort();
    expect(lease).toBe(f.lease);
    expect(f.prepared.release).toHaveBeenCalledOnce();
    expect(lease.release).not.toHaveBeenCalled();
  });
});
