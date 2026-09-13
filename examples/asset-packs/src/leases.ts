import { planImages, type AssetPack, type PlannedImage } from './packs.js';

export interface PreparedImage {
  readonly textureKey: string;
  dispose(): void;
}

export interface PackLease {
  readonly textures: ReadonlyMap<string, string>;
  release(): void;
}

interface Entry {
  readonly image: PlannedImage;
  readonly abort: AbortController;
  readonly owners: Set<symbol>;
  promise: Promise<PreparedImage>;
  resource?: PreparedImage;
}

export function cancelled(): DOMException {
  return new DOMException('Asset preparation cancelled', 'AbortError');
}

/** Ref-counted resident images only. There is deliberately no disk cache. */
export function createPackLeases(
  catalog: readonly AssetPack[],
  prepare: (image: PlannedImage, signal: AbortSignal) => Promise<PreparedImage>,
) {
  // Pin a private catalog snapshot for this session, including nested descriptors.
  const pinned = structuredClone(catalog);
  const entries = new Map<string, Entry>();

  function forget(entry: Entry): void {
    if (entries.get(entry.image.identity) === entry) entries.delete(entry.image.identity);
  }

  function release(entry: Entry, owner: symbol): void {
    if (!entry.owners.delete(owner) || entry.owners.size > 0) return;
    forget(entry);
    entry.abort.abort();
    entry.resource?.dispose();
    delete entry.resource;
  }

  function claim(image: PlannedImage, owner: symbol): Entry {
    const existing = entries.get(image.identity);
    if (existing) {
      existing.owners.add(owner);
      return existing;
    }
    const entry: Entry = {
      image, abort: new AbortController(), owners: new Set([owner]),
      promise: Promise.resolve().then(async () => {
        if (entry.abort.signal.aborted) throw cancelled();
        const resource = await prepare(image, entry.abort.signal);
        // A decoder may complete after the last owner cancelled. Never resurrect it.
        if (entry.owners.size === 0) {
          resource.dispose();
          throw cancelled();
        }
        entry.resource = resource;
        return resource;
      }).catch((error: unknown) => {
        forget(entry);
        throw error;
      }),
    };
    entries.set(image.identity, entry);
    return entry;
  }

  return {
    async acquire(rootId: string, options: {
      readonly signal?: AbortSignal;
      readonly progress?: (ready: number, total: number) => void;
    } = {}): Promise<PackLease> {
      if (options.signal?.aborted) throw cancelled();
      const images = planImages(pinned, rootId);
      options.progress?.(0, images.length);
      if (options.signal?.aborted) throw cancelled();
      const owner = Symbol(rootId);
      const claims = images.map((image) => claim(image, owner));
      let released = false;
      const releaseAll = (): void => {
        if (released) return;
        released = true;
        for (const entry of claims) release(entry, owner);
      };
      let cancelListener: (() => void) | undefined;
      let ready = 0;
      // Attach rejection handlers to every shared task even if this caller cancels.
      const prepared = Promise.all(claims.map(async (entry) => {
        const resource = await entry.promise;
        if (!released) options.progress?.(++ready, claims.length);
        return resource;
      }));
      try {
        const abort = new Promise<never>((_, reject) => {
          cancelListener = () => { releaseAll(); reject(cancelled()); };
          options.signal?.addEventListener('abort', cancelListener, { once: true });
          if (options.signal?.aborted) cancelListener();
        });
        const resources = await Promise.race([prepared, abort]);
        if (options.signal?.aborted) throw cancelled();
        return {
          textures: new Map(images.map((image, index) => [`${image.packId}/${image.id}`, resources[index]!.textureKey])),
          release: releaseAll,
        };
      } catch (error) {
        releaseAll();
        throw error;
      } finally {
        if (cancelListener) options.signal?.removeEventListener('abort', cancelListener);
      }
    },
    snapshot() {
      return [...entries.values()].map((entry) => ({
        identity: entry.image.identity, pack: entry.image.packId, owners: entry.owners.size,
        state: entry.resource ? 'ready' : 'preparing',
        rgbaEstimate: entry.image.width * entry.image.height * 4,
      }));
    },
  };
}
