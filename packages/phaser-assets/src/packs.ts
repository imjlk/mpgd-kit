import type Phaser from 'phaser';

import type { PhaserAtlasAsset, PhaserImageAsset, PhaserSpritesheetAsset } from './index.js';
import { fetchPackFile } from './pack-fetch.js';

/** Optional verification of encoded file bytes, before browser decoding. */
export interface PhaserPackFileIntegrity { readonly bytes: number; readonly sha256: string; }
/** Existing texture manifests can be used directly; integrity metadata is optional. */
export type PhaserPackAsset = (PhaserImageAsset | PhaserSpritesheetAsset | PhaserAtlasAsset) & {
  readonly integrity?: { readonly texture?: PhaserPackFileIntegrity; readonly atlas?: PhaserPackFileIntegrity };
};
export interface PhaserAssetPack {
  readonly id: string;
  readonly revision: string;
  readonly dependsOn?: readonly string[];
  readonly assets: readonly PhaserPackAsset[];
}
export interface PhaserAssetPackOptions {
  /** Receives the original manifest URL. Return an absolute or page-relative URL. */
  readonly resolveURL?: (url: string, context: { readonly packId: string; readonly revision: string }) => string;
  /** Deadline for each asset, including its files and image decoding. Default: 15 seconds. */
  readonly timeoutMs?: number;
  /** Retries per file for network errors, 429 and 5xx. Default: 1; maximum: 3. */
  readonly retries?: number;
  /** Encoded bytes per file, enforced while streaming. Default: 32 MiB. */
  readonly maxFileBytes?: number;
  /** Reject larger decoded images before registering a texture. Default: 16 million pixels. */
  readonly maxDecodedPixels?: number;
}
export interface PhaserAssetPackLease {
  /** Resolve a logical manifest key to the owned Phaser texture key. Throws after release. */
  key(packId: string, assetKey: string): string;
  /** Destroy display objects/animations using these keys before release. Idempotent. */
  release(): void;
}
export interface PhaserAssetPackLoader {
  /** Share dependencies and in-flight work. Failure/cancellation rolls back this caller only. */
  acquire(packId: string, options?: { readonly signal?: AbortSignal; readonly onProgress?: (ready: number, total: number) => void }): Promise<PhaserAssetPackLease>;
  /** Inspect ownership and decoded-size estimates; these are not measured GPU/process bytes. */
  snapshot(): readonly { readonly packId: string; readonly assetKey: string; readonly owners: number; readonly ready: boolean; readonly rgbaEstimate: number }[];
  /** Permanently close the loader. Also runs automatically on scene shutdown/destroy. */
  dispose(): void;
}
interface Planned { pack: PhaserAssetPack; asset: PhaserPackAsset; identity: string; }
interface Resource { key: string; pixels: number; dispose(): void; }
interface Entry { item: Planned; owners: Set<symbol>; abort: AbortController; promise: Promise<Resource>; resource?: Resource; }
let generation = 0;
const abortError = () => new DOMException('Asset pack acquisition cancelled', 'AbortError');

/** Validate a dependency graph without starting any browser work. */
export function definePhaserAssetPacks<const T extends readonly PhaserAssetPack[]>(packs: T): T {
  const byId = new Map<string, PhaserAssetPack>();
  for (const pack of packs) {
    if (!pack.id || !pack.revision || byId.has(pack.id)) {
      throw new Error(`Invalid or duplicate pack: ${pack.id}`);
    }
    byId.set(pack.id, pack);
    const keys = new Set<string>();
    for (const asset of pack.assets) {
      if (!asset.key || keys.has(asset.key)) {
        throw new Error(`Invalid or duplicate asset: ${pack.id}/${asset.key}`);
      }
      if (!['image', 'spritesheet', 'atlas'].includes(asset.kind)) {
        throw new Error(`Unsupported pack asset kind: ${asset.kind}`);
      }
      keys.add(asset.key);
      const urls = asset.kind === 'atlas' ? [asset.textureUrl, asset.atlasUrl] : [asset.url];
      if (urls.some((url) => !url)) {
        throw new Error(`Missing asset URL: ${asset.key}`);
      }
      for (const value of Object.values(asset.integrity ?? {})) {
        if (!Number.isSafeInteger(value.bytes) || value.bytes <= 0 || !/^[a-f0-9]{64}$/i.test(
          value.sha256,
        )) {
          throw new Error(`Invalid integrity: ${asset.key}`);
        }
      }
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) {
      throw new Error(`Cyclic pack dependency: ${id}`);
    }
    if (visited.has(id)) {
      return;
    }
    const pack = byId.get(id);
    if (!pack) {
      throw new Error(`Unknown pack: ${id}`);
    }
    visiting.add(id);
    for (const dependency of pack.dependsOn ?? []) {
      visit(dependency);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of byId.keys()) {
    visit(id);
  }
  return packs;
}

/**
 * Scene-scoped texture ownership for images, spritesheets and JSON atlases.
 * Uses an independent fetch/decode pipeline, so cancellation never resets scene.load.
 * Acquire in scene.create; share one loader between consumers that should share assets.
 */
export function createPhaserAssetPackLoader(scene: Phaser.Scene, catalog: readonly PhaserAssetPack[], options: PhaserAssetPackOptions = {}): PhaserAssetPackLoader {
  const packs = new Map(
    definePhaserAssetPacks(structuredClone(catalog)).map((pack) => [pack.id, pack]),
  );
  const timeoutMs = options.timeoutMs ?? 15_000;
  const retries = options.retries ?? 1;
  const maxFileBytes = options.maxFileBytes ?? 32 * 1024 * 1024;
  const maxDecodedPixels = options.maxDecodedPixels ?? 16_000_000;
  if (![timeoutMs, maxFileBytes, maxDecodedPixels].every(
    (n) => Number.isSafeInteger(n) && n > 0,
  ) || !Number.isInteger(retries) || retries < 0 || retries > 3) {
    throw new Error('Invalid asset pack limits');
  }
  const resolveURL = options.resolveURL ?? ((url: string) => url);
  const entries = new Map<string, Entry>();
  let disposed = false;
  const forget = (entry: Entry): void => {
    if (entries.get(entry.item.identity) === entry) {
      entries.delete(entry.item.identity);
    } };
  const release = (entry: Entry, owner: symbol): void => {
    if (!entry.owners.delete(owner) || entry.owners.size) {
      return;
    }
    forget(entry);
    entry.abort.abort();
    entry.resource?.dispose();
    delete entry.resource;
  };
  const plan = (id: string): Planned[] => {
    const seen = new Set<string>();
    const result: Planned[] = [];
    const visit = (packId: string): void => {
      if (seen.has(packId)) {
        return;
      }
      const pack = packs.get(packId);
      if (!pack) {
        throw new Error(`Unknown pack: ${packId}`);
      }
      seen.add(packId);
      for (const dependency of pack.dependsOn ?? []) {
        visit(dependency);
      }
      for (const asset of pack.assets) {
        result.push({
          pack,
          asset,
          identity: JSON.stringify([pack.id, pack.revision, asset.key]),
        });
      }
    };
    visit(id);
    return result;
  };
  async function prepare(item: Planned, signal: AbortSignal): Promise<Resource> {
    const { asset, pack } = item;
    const file = (url: string, integrity?: PhaserPackFileIntegrity) => fetchPackFile(
      resolveURL(url, { packId: pack.id, revision: pack.revision }),
      { signal, retries, maxFileBytes, integrity },
    );
    const [blob, atlas] = await Promise.all([
      file(asset.kind === 'atlas' ? asset.textureUrl : asset.url, asset.integrity?.texture),
      asset.kind === 'atlas'
        ? file(asset.atlasUrl, asset.integrity?.atlas).then(
            async (value) => JSON.parse(await value.text()) as unknown,
          )
        : undefined,
    ]);
    if (signal.aborted) {
      throw signal.reason;
    }
    const image = new Image();
    const url = URL.createObjectURL(blob);
    let key: string | undefined;
    try {
      image.src = url;
      let cancelDecode: (() => void) | undefined;
      try {
        await Promise.race([
          image.decode(),
          new Promise<never>((_, reject) => {
            cancelDecode = () => reject(signal.reason);
            signal.addEventListener('abort', cancelDecode, { once: true });
            if (signal.aborted) {
cancelDecode();
}
          }),
        ]);
      } finally {
        if (cancelDecode) {
          signal.removeEventListener('abort', cancelDecode);
        } }
      if (signal.aborted) {
        throw signal.reason;
      }
      const pixels = image.naturalWidth * image.naturalHeight;
      if (!pixels || pixels > maxDecodedPixels) {
        throw new Error(`Decoded image exceeds pixel limit: ${asset.key}`);
      }
      if (asset.kind === 'spritesheet' && (!Number.isSafeInteger(
        asset.frameConfig.frameWidth,
      ) || asset.frameConfig.frameWidth <= 0 || !Number.isSafeInteger(
        asset.frameConfig.frameHeight ?? asset.frameConfig.frameWidth,
      ) || (asset.frameConfig.frameHeight ?? asset.frameConfig.frameWidth) <= 0)) {
        throw new Error(`Invalid spritesheet frame size: ${asset.key}`);
      }
      if (asset.kind === 'atlas' && (!atlas || typeof atlas !== 'object' || !('frames' in atlas) || !atlas.frames || typeof atlas.frames !== 'object')) {
        throw new Error(`Invalid JSON atlas: ${asset.key}`);
      }
      do {
        key = `__mpgd_pack_${++generation}`; } while (scene.textures.exists(key));
      let texture: Phaser.Textures.Texture | null;
      if (asset.kind === 'atlas') {
        texture = scene.textures.addAtlas(key, image, atlas as object);
      }
      else if (asset.kind === 'spritesheet') {
        texture = scene.textures.addSpriteSheet(key, image, asset.frameConfig);
      }
      else {
        texture = scene.textures.addImage(key, image);
      }
      if (texture && asset.kind !== 'image' && texture.frameTotal <= 1) {
        throw new Error(`No usable frames: ${asset.key}`);
      }
      if (!texture) {
        throw new Error(`Could not register texture: ${asset.key}`);
      }
      let released = false;
      return { key, pixels, dispose() {
        if (released) {
return;
}
        released = true;
        if (scene.textures.exists(key!)) {
scene.textures.remove(key!);
}
        image.src = '';
      } };
    } catch (error) {
      if (key && scene.textures.exists(key)) {
        scene.textures.remove(key);
      }
      image.src = '';
      throw error;
    } finally {
      URL.revokeObjectURL(url); }
  }
  const claim = (item: Planned, owner: symbol): Entry => {
    const existing = entries.get(item.identity);
    if (existing) {
      existing.owners.add(owner);
      return existing; }
    const entry: Entry = { item, owners: new Set([owner]), abort: new AbortController(), promise: Promise.resolve().then(async () => {
      if (entry.abort.signal.aborted) {
throw abortError();
}
      const timer = setTimeout(() => entry.abort.abort(new Error(`Asset preparation timed out: ${item.asset.key}`)), timeoutMs);
      let listener: (() => void) | undefined;
      const work = prepare(item, entry.abort.signal).then((resource) => {
        if (entry.abort.signal.aborted || !entry.owners.size) {
            resource.dispose();
            throw entry.abort.signal.reason ?? abortError(); }
        entry.resource = resource;
        return resource;
      });
      try {
        return await Promise.race([work, new Promise<never>((_, reject) => {
          listener = () => reject(entry.abort.signal.reason ?? abortError());
          entry.abort.signal.addEventListener('abort', listener, { once: true });
          if (entry.abort.signal.aborted) {
listener();
}
        })]);
      } finally {
        clearTimeout(timer);
        if (listener) {
entry.abort.signal.removeEventListener('abort', listener);
}
      }
    }).catch((error: unknown) => {
        forget(entry);
        throw error; }) };
    entries.set(item.identity, entry);
    return entry;
  };
  const dispose = (): void => {
    if (disposed) {
      return;
    }
    disposed = true;
    scene.events.off('shutdown', dispose);
    scene.events.off('destroy', dispose);
    for (const entry of [...entries.values()]) {
      for (const owner of [...entry.owners]) {
        release(entry, owner);
      }
    }
  };
  scene.events.once('shutdown', dispose);
  scene.events.once('destroy', dispose);
  return {
    dispose,
    snapshot: () => [...entries.values()].map((entry) => ({ packId: entry.item.pack.id, assetKey: entry.item.asset.key, owners: entry.owners.size, ready: !!entry.resource, rgbaEstimate: (entry.resource?.pixels ?? 0) * 4 })),
    async acquire(id, settings = {}) {
      if (disposed) {
throw new Error('Asset pack loader is disposed');
}
      if (settings.signal?.aborted) {
throw abortError();
}
      const planned = plan(id);
      settings.onProgress?.(0, planned.length);
      if (disposed || settings.signal?.aborted) {
throw abortError();
}
      const owner = Symbol(id);
      const claims = planned.map((item) => claim(item, owner));
      let released = false;
      const releaseAll = (): void => {
        if (!released) {
          released = true;
          for (const entry of claims) {
release(entry, owner);
} } };
      let listener: (() => void) | undefined;
      let ready = 0;
      try {
        const all = Promise.all(claims.map(async (entry) => {
          const resource = await entry.promise;
          if (!released) {
settings.onProgress?.(++ready, claims.length);
}
          return resource;
        }));
        const resources = await Promise.race([all, new Promise<never>((_, reject) => {
          listener = () => {
            releaseAll();
            reject(abortError()); };
          settings.signal?.addEventListener('abort', listener, { once: true });
          if (settings.signal?.aborted) {
listener();
}
        })]);
        if (disposed || settings.signal?.aborted) {
throw abortError();
}
        const keys = new Map(planned.map((item, i) => [JSON.stringify([item.pack.id, item.asset.key]), resources[i]!.key]));
        return { release: releaseAll, key(packId, assetKey) {
          if (released || disposed) {
throw new Error('Asset pack lease is released');
}
          const key = keys.get(JSON.stringify([packId, assetKey]));
          if (!key) {
throw new Error(`Asset is not in this lease: ${packId}/${assetKey}`);
}
          return key;
        } };
      } catch (error) {
        releaseAll();
        throw error; }
      finally {
        if (listener) {
settings.signal?.removeEventListener('abort', listener);
} }
    },
  };
}
