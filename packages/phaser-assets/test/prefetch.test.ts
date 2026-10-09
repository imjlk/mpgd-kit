import { describe, expect, it, vi } from 'vitest';
import type { PhaserAssetPackLoader } from '../src/packs.js';
import { createPhaserPackPrefetcher } from '../src/prefetch.js';

function fixture() {
  const calls: string[] = [];
  const owners = new Map<string, number>();
  const paused = new Set<string>();
  const finish = new Map<string, () => void>();
  const bytes = new Map<string, number>([['shared', 5]]);
  const loader: PhaserAssetPackLoader = {
    dispose() {}, takeCleanupErrors: () => [],
    snapshot: () => [...owners].map(([id, count]) => ({ packId: id, assetKey: 'asset', owners: count, ready: true, rgbaEstimate: bytes.get(id) ?? 7 })),
    async acquire(id, settings = {}) {
      calls.push(id);
      settings.signal?.throwIfAborted();
      if (paused.has(id)) {
        await new Promise<void>((resolve, reject) => {
        const stop = (): void => { finish.delete(id); reject(settings.signal?.reason); };
        settings.signal?.addEventListener('abort', stop, { once: true });
        finish.set(id, () => { settings.signal?.removeEventListener('abort', stop); finish.delete(id); resolve(); });
      });
      }
      settings.signal?.throwIfAborted();
      const ids = [...new Set(['shared', id])];
      for (const key of ids) {
        owners.set(key, (owners.get(key) ?? 0) + 1);
      }
      let released = false;
      return {
        key(packId, assetKey) {
          if (released || !ids.includes(packId) || assetKey !== 'asset') {
            throw new Error('Not owned');
          }
          return `texture-${packId}`;
        },
        release() {
          if (released) {
            return;
          }
          released = true;
          for (const key of ids) {
            const count = (owners.get(key) ?? 1) - 1;
            if (count) {
              owners.set(key, count);
            } else {
              owners.delete(key);
            }
          }
        },
      };
    },
  };
  return { loader, calls, owners, paused, finish, bytes };
}
describe('idle-gated asset prefetch', () => {
  it('hands a resident warm pack to the consumer without repeating delivery preparation', async () => {
    const f = fixture();
    const prepare = vi.fn(async (id: string, settings: { signal?: AbortSignal }) =>
      f.loader.acquire(id, settings),
    );
    const prefetch = createPhaserPackPrefetcher(f.loader, { acquire: prepare });
    prefetch.setIdle(true);
    await prefetch.enqueue('a');
    prefetch.setIdle(false);
    const consumer = await prefetch.acquire('a');
    expect(prepare.mock.calls.map(([id]) => id)).toEqual(['a']);
    expect(f.owners.get('a')).toBe(1);
    expect(consumer.key('a', 'asset')).toBe('texture-a');
    expect(prefetch.snapshot().warm).toEqual([]);
    consumer.release();
    const cold = await prefetch.acquire('b');
    expect(prepare.mock.calls.map(([id]) => id)).toEqual(['a', 'b']);
    cold.release();
    prefetch.dispose();
    expect(f.owners.size).toBe(0);
  });
  it('serializes foreground entries for a single-flight delivery and promptly cancels a queued entry', async () => {
    const f = fixture();
    f.paused.add('a');
    const prefetch = createPhaserPackPrefetcher(f.loader);
    const a = prefetch.acquire('a');
    await vi.waitFor(() => expect(f.calls).toEqual(['a']));
    const controller = new AbortController();
    const b = prefetch.acquire('b', { signal: controller.signal });
    controller.abort();
    await expect(b).rejects.toThrow();
    expect(f.calls).toEqual(['a']);
    const c = prefetch.acquire('c');
    f.finish.get('a')?.();
    const [first, third] = await Promise.all([a, c]);
    expect(f.calls).toEqual(['a', 'c']);
    first.release();
    third.release();
    prefetch.dispose();
  });
  it('starts no work until idle, uses priority and shares duplicate queue operations', async () => {
    const f = fixture();
    const prefetch = createPhaserPackPrefetcher(f.loader);
    const a = prefetch.enqueue('a', 0);
    const b = prefetch.enqueue('b', 2);
    expect(prefetch.enqueue('a', 99)).toBe(a);
    expect(f.calls).toEqual([]);
    expect(prefetch.snapshot().queued).toEqual(['b', 'a']);
    prefetch.setIdle(true);
    expect(await b).toEqual({ status: 'warmed' });
    expect(await a).toEqual({ status: 'warmed' });
    expect(f.calls).toEqual(['b', 'a']);
    prefetch.dispose();
    expect(f.owners.size).toBe(0);
  });
  it('counts a shared dependency once and returns foreground ownership before dropping its warm lease', async () => {
    const f = fixture();
    const prefetch = createPhaserPackPrefetcher(f.loader, { maxRetainedBytes: 20 });
    prefetch.setIdle(true);
    await prefetch.enqueue('a');
    await prefetch.enqueue('b');
    expect(prefetch.snapshot().retainedBytes).toBe(19);
    const consumer = await prefetch.acquire('a');
    expect(prefetch.snapshot().warm).toEqual(['b']);
    prefetch.cancel('b');
    expect(consumer.key('a', 'asset')).toBe('texture-a');
    expect(f.owners.get('a')).toBe(1);
    consumer.release();
    expect(f.owners.size).toBe(0);
  });
  it('cancels background work before entering foreground and delays queued work until foreground settles', async () => {
    const f = fixture();
    f.paused.add('a');
    f.paused.add('f');
    const prefetch = createPhaserPackPrefetcher(f.loader);
    prefetch.setIdle(true);
    const background = prefetch.enqueue('a');
    const queued = prefetch.enqueue('b');
    const foreground = prefetch.acquire('f');
    expect(await background).toEqual({ status: 'cancelled' });
    await vi.waitFor(() => expect(f.calls).toEqual(['a', 'f']));
    expect(prefetch.snapshot().foreground).toBe(1);
    f.finish.get('f')?.();
    const consumer = await foreground;
    expect(await queued).toEqual({ status: 'warmed' });
    consumer.release();
    prefetch.dispose();
    expect(f.owners.size).toBe(0);
  });
  it('stops an active prefetch when idle ends and leaves queued work for the next idle window', async () => {
    const f = fixture();
    f.paused.add('a');
    const prefetch = createPhaserPackPrefetcher(f.loader);
    prefetch.setIdle(true);
    const active = prefetch.enqueue('a');
    const next = prefetch.enqueue('b');
    prefetch.setIdle(false);
    expect(await active).toEqual({ status: 'cancelled' });
    expect(f.calls).toEqual(['a']);
    prefetch.setIdle(true);
    expect(await next).toEqual({ status: 'warmed' });
    prefetch.dispose();
  });
  it('evicts old warm ownership without destroying a consumer lease', async () => {
    const f = fixture();
    const consumer = await f.loader.acquire('a');
    const prefetch = createPhaserPackPrefetcher(f.loader, { maxWarmPacks: 1 });
    prefetch.setIdle(true);
    await prefetch.enqueue('a');
    await prefetch.enqueue('b');
    expect(prefetch.snapshot().warm).toEqual(['b']);
    expect(consumer.key('a', 'asset')).toBe('texture-a');
    expect(f.owners.get('a')).toBe(1);
    prefetch.dispose();
    consumer.release();
    expect(f.owners.size).toBe(0);
  });
  it('rejects retention of an oversized pack without wiping a useful warm pack', async () => {
    const f = fixture();
    f.bytes.set('huge', 100);
    const prefetch = createPhaserPackPrefetcher(f.loader, { maxRetainedBytes: 20 });
    prefetch.setIdle(true);
    await prefetch.enqueue('a');
    expect(await prefetch.enqueue('huge')).toEqual({ status: 'evicted' });
    expect(prefetch.snapshot().warm).toEqual(['a']);
    expect(f.owners.has('huge')).toBe(false);
    prefetch.dispose();
  });
  it('bounds the queue and settles cancelled queued requests without any IO', async () => {
    const f = fixture();
    const prefetch = createPhaserPackPrefetcher(f.loader, { maxQueuedPacks: 1 });
    const pending = prefetch.enqueue('a');
    expect(() => prefetch.enqueue('b')).toThrow('queue is full');
    prefetch.cancel('a');
    expect(await pending).toEqual({ status: 'cancelled' });
    expect(f.calls).toEqual([]);
    prefetch.dispose();
    expect(() => prefetch.enqueue('a')).toThrow('disposed');
  });
  it("disposal cancels this scheduler's foreground acquisition", async () => {
    const f = fixture();
    f.paused.add('a');
    const prefetch = createPhaserPackPrefetcher(f.loader);
    const consumer = prefetch.acquire('a');
    prefetch.dispose();
    await expect(consumer).rejects.toThrow();
    expect(f.owners.size).toBe(0);
  });
});
