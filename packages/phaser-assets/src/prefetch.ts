import type { PhaserAssetPackLease, PhaserAssetPackLoader } from './packs.js';
export interface PhaserPackPrefetchAcquireOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (ready: number, total: number) => void;
}

export type PhaserPackPrefetchResult =
  | { readonly status: 'warmed' | 'cancelled' | 'evicted' }
  | { readonly status: 'failed'; readonly error: unknown };
export interface PhaserPackPrefetchOptions {
  readonly maxQueuedPacks?: number;
  readonly maxWarmPacks?: number;
  /** Unique retained RGBA estimates + PCM samples + HTML5 Blob bytes. Not total process/GPU memory. */
  readonly maxRetainedBytes?: number;
  /** Use acquireDeliveredPack here for a ZIP/mixed delivery. Must use this same loader. */
  readonly acquire?: (packId: string, options: PhaserPackPrefetchAcquireOptions) => Promise<PhaserAssetPackLease>;
}
export interface PhaserPackPrefetcher {
  /** Explicitly allow background work. False aborts the running prefetch; warm leases remain bounded. */
  setIdle(idle: boolean): void;
  /** Higher priority first, FIFO at equal priority. Duplicate queued ids share one operation. */
  enqueue(packId: string, priority?: number): Promise<PhaserPackPrefetchResult>;
  /** Foreground admission pauses prefetch until every foreground acquisition settles. */
  acquire(packId: string, options?: PhaserPackPrefetchAcquireOptions): Promise<PhaserAssetPackLease>;
  /** Cancel queued/running work or evict a warm pack. Does not touch a consumer's independent lease. */
  cancel(packId: string): void;
  snapshot(): { readonly idle: boolean; readonly foreground: number; readonly queued: readonly string[]; readonly warming: string | null; readonly warm: readonly string[]; readonly retainedBytes: number };
  dispose(): void;
}
interface Job {
  readonly id: string;
  readonly priority: number;
  readonly sequence: number;
  readonly controller: AbortController;
  readonly result: Promise<PhaserPackPrefetchResult>;
  readonly resolve: (value: PhaserPackPrefetchResult) => void;
}
interface Warm {
  readonly lease: PhaserAssetPackLease;
  readonly resources: ReadonlyMap<string, number>;
}

/** Opt-in, single-flight prefetch owned by one application. Creation starts no work. */
export function createPhaserPackPrefetcher(loader: PhaserAssetPackLoader, options: PhaserPackPrefetchOptions = {}): PhaserPackPrefetcher {
  const maxQueued = options.maxQueuedPacks ?? 16;
  const maxWarm = options.maxWarmPacks ?? 2;
  const maxBytes = options.maxRetainedBytes ?? 64 * 1024 * 1024;
  if (![maxQueued, maxWarm, maxBytes].every((value) => Number.isSafeInteger(value) && value > 0)) {
    throw new Error('Invalid asset pack prefetch limits');
  }
  const acquire = options.acquire ?? ((id, settings) => loader.acquire(id, settings));
  const queue: Job[] = [];
  const warm = new Map<string, Warm>();
  let sequence = 0;
  let idle = false;
  let foreground = 0;
  const foregroundControllers = new Set<AbortController>();
  let foregroundTail = Promise.resolve();
  let running: Job | undefined;
  let disposed = false;
  const ordered = (): Job[] => [...queue].sort(
    (left, right) => right.priority - left.priority || left.sequence - right.sequence,
  );
  const retainedBytes = (): number => {
    const unique = new Map<string, number>();
    for (const entry of warm.values()) {
      for (const [key, bytes] of entry.resources) {
        unique.set(key, bytes);
      }
    }
    let total = 0;
    for (const bytes of unique.values()) {
      if (!Number.isSafeInteger(bytes) || bytes < 0 || total > Number.MAX_SAFE_INTEGER - bytes) {
        throw new Error('Invalid prefetch resident payload accounting');
      }
      total += bytes;
    }
    return total;
  };
  const evict = (id: string): void => {
    const entry = warm.get(id);
    warm.delete(id);
    entry?.lease.release();
  };
  const resourcesOf = (lease: PhaserAssetPackLease): ReadonlyMap<string, number> => {
    const result = new Map<string, number>();
    for (const row of loader.snapshot()) {
      let key: string;
      try {
        key = lease.key(row.packId, row.assetKey);
      } catch {
        continue;
      }
      result.set(
        key,
        row.rgbaEstimate + (row.decodedAudioBytes ?? 0) + (row.encodedAudioBytes ?? 0),
      );
    }
    return result;
  };
  const pump = (): void => {
    if (disposed || !idle || foreground > 0 || running || queue.length === 0) {
      return;
    }
    const job = ordered()[0]!;
    queue.splice(queue.indexOf(job), 1);
    running = job;
    void (async () => {
      let lease: PhaserAssetPackLease | undefined;
      let outcome: PhaserPackPrefetchResult;
      try {
        lease = await acquire(job.id, { signal: job.controller.signal });
        if (disposed || job.controller.signal.aborted || !idle || foreground > 0) {
          outcome = { status: 'cancelled' };
        } else {
          const resources = resourcesOf(lease);
          let ownBytes = 0;
          for (const bytes of resources.values()) {
            if (!Number.isSafeInteger(bytes) || bytes < 0 || ownBytes > Number.MAX_SAFE_INTEGER - bytes) {
              throw new Error('Invalid prefetch resident payload accounting');
            }
            ownBytes += bytes;
          }
          if (ownBytes > maxBytes) {
            outcome = { status: 'evicted' };
          } else {
            warm.set(job.id, { lease, resources });
            lease = undefined;
            while (warm.size > maxWarm || retainedBytes() > maxBytes) {
              evict(warm.keys().next().value!);
            }
            outcome = { status: 'warmed' };
          }
        }
      } catch (error) {
        evict(job.id);
        outcome = job.controller.signal.aborted ? { status: 'cancelled' } : { status: 'failed', error };
      } finally {
        lease?.release();
        running = undefined;
      }
      job.resolve(outcome);
      pump();
    })();
  };
  const cancel = (id: string): void => {
    if (running?.id === id) {
      running.controller.abort();
    }
    const index = queue.findIndex((job) => job.id === id);
    if (index !== -1) {
      const [job] = queue.splice(index, 1);
      job!.controller.abort();
      job!.resolve({ status: 'cancelled' });
    }
    evict(id);
  };
  return {
    setIdle(value) {
      if (typeof value !== 'boolean') {
        throw new Error('Prefetch idle state must be boolean');
      }
      if (disposed) {
        throw new Error('Asset pack prefetcher is disposed');
      }
      idle = value;
      if (!idle) {
        running?.controller.abort();
      }
      pump();
    },
    enqueue(id, priority = 0) {
      if (disposed) {
        throw new Error('Asset pack prefetcher is disposed');
      }
      if (typeof id !== 'string' || id.length === 0 || !Number.isFinite(priority)) {
        throw new Error('Invalid prefetch request');
      }
      if (warm.has(id)) {
        return Promise.resolve({ status: 'warmed' });
      }
      const existing = running?.id === id ? running : queue.find((job) => job.id === id);
      if (existing) {
        return existing.result;
      }
      if (queue.length >= maxQueued) {
        throw new Error('Asset pack prefetch queue is full');
      }
      let resolve!: (value: PhaserPackPrefetchResult) => void;
      const result = new Promise<PhaserPackPrefetchResult>((yes) => { resolve = yes; });
      queue.push({ id, priority, sequence: sequence++, controller: new AbortController(), result, resolve });
      pump();
      return result;
    },
    async acquire(id, settings = {}) {
      if (disposed) {
        throw new Error('Asset pack prefetcher is disposed');
      }
      settings.signal?.throwIfAborted();
      foreground++;
      const controller = new AbortController();
      foregroundControllers.add(controller);
      const previous = foregroundTail;
      let returnTurn!: () => void;
      const turn = new Promise<void>((resolve) => { returnTurn = resolve; });
      foregroundTail = previous.then(() => turn);
      const aborted = (): void => controller.abort(settings.signal?.reason);
      settings.signal?.addEventListener('abort', aborted, { once: true });
      if (settings.signal?.aborted) {
        aborted();
      }
      const background = running;
      background?.controller.abort();
      let cancelWait!: () => void;
      const cancelled = new Promise<never>((_, reject) => {
        cancelWait = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', cancelWait, { once: true });
        if (controller.signal.aborted) {
          cancelWait();
        }
      });
      try {
        // A delivery owns a single staging operation. Wait for its abort to
        // settle before entering the foreground, without dropping warm leases.
        await Promise.race([Promise.all([previous, background?.result]), cancelled]);
        if (disposed) {
          throw new Error('Asset pack prefetcher is disposed');
        }
        controller.signal.throwIfAborted();
        const lease = await acquire(id, { ...settings, signal: controller.signal });
        if (disposed || controller.signal.aborted) {
          lease.release();
          throw controller.signal.reason ?? new Error('Asset pack prefetcher is disposed');
        }
        evict(id);
        return lease;
      } finally {
        foreground--;
        foregroundControllers.delete(controller);
        controller.signal.removeEventListener('abort', cancelWait);
        returnTurn();
        settings.signal?.removeEventListener('abort', aborted);
        pump();
      }
    },
    cancel,
    snapshot: () => ({ idle, foreground, queued: ordered().map((job) => job.id), warming: running?.id ?? null, warm: [...warm.keys()], retainedBytes: retainedBytes() }),
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      running?.controller.abort();
      for (const controller of foregroundControllers) {
        controller.abort();
      }
      for (const job of [...queue]) {
        cancel(job.id);
      }
      for (const id of [...warm.keys()]) {
        evict(id);
      }
    },
  };
}
