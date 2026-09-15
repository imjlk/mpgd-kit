import type Phaser from 'phaser';

import { digestOf } from './archive-digest.js';
import type { PhaserAtlasAsset, PhaserImageAsset, PhaserSpritesheetAsset } from './index.js';
import { createPackBudget } from './pack-budget.js';
import {
  createPackUrlFileSource,
  type PhaserPackFileBody,
  type PhaserPackFileContext,
  type PhaserPackFileIntegrity,
  type PhaserPackFileSource,
  type PhaserPackOpenedFile,
} from './pack-file-source.js';

export type {
  PhaserPackFileBody,
  PhaserPackFileBudgets,
  PhaserPackFileContext,
  PhaserPackFileIntegrity,
  PhaserPackFileRequest,
  PhaserPackFileRole,
  PhaserPackFileSource,
  PhaserPackOpenedFile,
} from './pack-file-source.js';
/** Existing texture manifests can be used directly; integrity metadata is optional. */
export type PhaserPackAsset = (PhaserImageAsset | PhaserSpritesheetAsset | PhaserAtlasAsset) & {
  readonly integrity?: {
    readonly texture?: PhaserPackFileIntegrity;
    readonly atlas?: PhaserPackFileIntegrity;
  };
};
export interface PhaserAssetPack {
  readonly id: string;
  readonly revision: string;
  readonly dependsOn?: readonly string[];
  readonly assets: readonly PhaserPackAsset[];
}
export interface PhaserAssetPackOptions {
  /** Default URL source only: receives the original manifest URL. Return an absolute or page-relative URL. */
  readonly resolveURL?: (url: string, context: {
    readonly packId: string;
    readonly revision: string;
  }) => string;
  /** Deadline for each asset, including its files and image decoding. Default: 15 seconds. */
  readonly timeoutMs?: number;
  /** Default URL source only: per HTTP attempt, including reading its body. Default: 10 seconds. */
  readonly requestTimeoutMs?: number;
  /** Concurrent file transfers, shared with the file source through its context. Default: 4. */
  readonly maxConcurrentDownloads?: number;
  /** Concurrent native decodes; an aborted decode retains its slot until it settles. Default: 1. */
  readonly maxConcurrentDecodes?: number;
  /** Reserved encoded bytes across downloading, queued and decoding assets. Default: 64 MiB.
   * Missing integrity reserves maxFileBytes per file. Oversized reservations reject before fetching. */
  readonly maxBufferedBytes?: number;
  /** Default URL source only: retries per file for network errors, 429 and 5xx. Default: 1; maximum: 3. */
  readonly retries?: number;
  /** Default URL source only: browser HTTP cache policy. Default no-store; use default for immutable URLs. */
  readonly requestCache?: 'default' | 'no-store' | 'reload';
  /** Encoded bytes per file, enforced while streaming and after every source read. Default: 32 MiB. */
  readonly maxFileBytes?: number;
  /** Reject larger decoded images before registering a texture. Default: 16 million pixels. */
  readonly maxDecodedPixels?: number;
  /** Supplies file bytes instead of the default manifest-URL HTTP transport.
   * Integrity verification, byte reservations and decoding stay with the loader. */
  readonly fileSource?: PhaserPackFileSource;
}
export interface PhaserAssetPackLease {
  /** Resolve a logical manifest key to the owned Phaser texture key. Throws after release. */
  key(packId: string, assetKey: string): string;
  /** Destroy display objects/animations using these keys before release. Idempotent. */
  release(): void;
}
export interface PhaserAssetPackLoader {
  /** Share dependencies and in-flight work. Failure/cancellation rolls back this caller only. */
  acquire(packId: string, options?: {
    readonly signal?: AbortSignal;
    readonly onProgress?: (ready: number, total: number) => void;
  }): Promise<PhaserAssetPackLease>;
  /** Inspect ownership and decoded-size estimates; these are not measured GPU/process bytes. */
  snapshot(): readonly {
    readonly packId: string;
    readonly assetKey: string;
    readonly owners: number;
    readonly ready: boolean;
    readonly rgbaEstimate: number;
  }[];
  /** Drain cleanup failures. Ownership is already returned; failed engine deletion is not retried. */
  takeCleanupErrors(): readonly {
    readonly packId: string;
    readonly assetKey: string;
    readonly error: unknown;
  }[];
  /** Permanently close the loader. Also runs automatically on scene shutdown/destroy. */
  dispose(): void;
}
interface Planned {
  pack: PhaserAssetPack;
  asset: PhaserPackAsset;
  identity: string;
}
interface PlannedFile {
  role: 'texture' | 'atlas';
  url: string;
  integrity?: PhaserPackFileIntegrity | undefined;
}
interface Resource {
  key: string;
  pixels: number;
  dispose(): void;
}
interface Entry {
  item: Planned;
  owners: Set<symbol>;
  abort: AbortController;
  promise: Promise<Resource>;
  resource?: Resource;
}
let generation = 0;
const abortError = () => new DOMException('Asset pack acquisition cancelled', 'AbortError');
/** Validate a dependency graph without starting any browser work. */
export function definePhaserAssetPacks<const T extends readonly PhaserAssetPack[]>(packs: T): T {
  const byId = new Map<string, PhaserAssetPack>();
  for (const pack of packs) {
    if (!pack || typeof pack.id !== 'string' || !pack.id || typeof pack.revision !== 'string' || !pack.revision || !Array.isArray(
      pack.assets,
    ) || byId.has(pack.id)) {
      throw new Error(`Invalid or duplicate pack: ${pack?.id}`);
    }
    const dependencies = pack.dependsOn;
    const invalidDependencies = dependencies !== undefined && (!Array.isArray(dependencies)
      || dependencies.some((id) => typeof id !== 'string' || !id));
    if (invalidDependencies) {
      throw new Error(`Invalid pack dependencies: ${pack.id}`);
    }
    byId.set(pack.id, pack);
    const keys = new Set<string>();
    for (const asset of pack.assets) {
      if (!asset || typeof asset.key !== 'string' || !asset.key || keys.has(asset.key)) {
        throw new Error(`Invalid or duplicate asset: ${pack.id}/${asset?.key}`);
      }
      if (!['image', 'spritesheet', 'atlas'].includes(asset.kind)) {
        throw new Error(`Unsupported pack asset kind: ${asset.kind}`);
      }
      keys.add(asset.key);
      const urls = asset.kind === 'atlas' ? [asset.textureUrl, asset.atlasUrl] : [asset.url];
      if (urls.some((url) => typeof url !== 'string' || !url.trim())) {
        throw new Error(`Missing asset URL: ${asset.key}`);
      }
      if (asset.kind === 'spritesheet') {
        const config = asset.frameConfig;
        const height = config?.frameHeight ?? config?.frameWidth;
        if (!config || !Number.isSafeInteger(
          config.frameWidth,
        ) || config.frameWidth <= 0 || !Number.isSafeInteger(height) || height <= 0) {
          throw new Error(`Invalid spritesheet frame size: ${asset.key}`);
        }
      }
      if (asset.integrity !== undefined && (!asset.integrity || typeof asset.integrity !== 'object' || Array.isArray(
        asset.integrity,
      ))) {
        throw new Error(`Invalid integrity: ${asset.key}`);
      }
      const atlasEntryInapplicable = asset.kind !== 'atlas' && asset.integrity?.atlas !== undefined;
      for (const name of Object.keys(asset.integrity ?? {})) {
        if (name !== 'texture' && (name !== 'atlas' || atlasEntryInapplicable)) {
          throw new Error(`Unknown or inapplicable integrity entry '${name}': ${asset.key}`);
        }
      }
      for (const value of Object.values(asset.integrity ?? {})) {
        // Optional fields may be explicitly undefined in JavaScript consumers.
        if (value === undefined) {
          continue;
        }
        if (!value || typeof value !== 'object' || !('bytes' in value) || typeof value.bytes !== 'number' || !('sha256' in value) || !Number.isSafeInteger(
          value.bytes,
        ) || value.bytes <= 0 || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(
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
  const customFileSource = options.fileSource;
  if (customFileSource !== undefined && (!customFileSource || typeof customFileSource.open !== 'function')) {
    throw new Error('Invalid asset pack file source');
  }
  const timeoutMs = options.timeoutMs ?? 15000;
  const retries = options.retries ?? 1;
  const requestTimeoutMs = options.requestTimeoutMs ?? 10000;
  const maxConcurrentDownloads = options.maxConcurrentDownloads ?? 4;
  const maxConcurrentDecodes = options.maxConcurrentDecodes ?? 1;
  const maxBufferedBytes = options.maxBufferedBytes ?? 64 * 1024 * 1024;
  const requestCache = options.requestCache ?? 'no-store';
  const maxFileBytes = options.maxFileBytes ?? 32 * 1024 * 1024;
  const maxDecodedPixels = options.maxDecodedPixels ?? 16000000;
  if (![timeoutMs, maxConcurrentDownloads, maxConcurrentDecodes, maxBufferedBytes, maxFileBytes, maxDecodedPixels].every(
    (n) => Number.isSafeInteger(n) && n > 0,
  )) {
    throw new Error('Invalid asset pack limits');
  }
  // Transport-only limits govern the default URL source; an injected source
  // owns its transport, so it must not be rejected for unused HTTP settings.
  if (customFileSource === undefined) {
    if (!['default', 'no-store', 'reload'].includes(requestCache)) {
      throw new Error('Invalid asset pack HTTP cache policy');
    }
    if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0
      || !Number.isInteger(retries) || retries < 0 || retries > 3) {
      throw new Error('Invalid asset pack limits');
    }
  }
  const resolveURL = options.resolveURL ?? ((url: string) => url);
  const entries = new Map<string, Entry>();
  const downloads = createPackBudget(maxConcurrentDownloads);
  const decodes = createPackBudget(maxConcurrentDecodes);
  const buffered = createPackBudget(maxBufferedBytes);
  const fileSource = customFileSource ?? createPackUrlFileSource({
    resolveURL,
    retries,
    requestTimeoutMs,
    requestCache,
    maxFileBytes,
  });
  const fileBudgets = {
    transfers: {
      acquire: (signal: AbortSignal) => downloads.acquire(1, signal),
    },
    bytes: {
      acquire: (weight: number, signal: AbortSignal) => buffered.acquire(weight, signal),
    },
  };
  const cleanupErrors: {
    packId: string;
    assetKey: string;
    error: unknown;
  }[] = [];
  const clean = (item: Planned, action: () => void): void => {
    try {
      action();
    } catch (error) {
      cleanupErrors.push({
        packId: item.pack.id,
        assetKey: item.asset.key,
        error,
      });
    }
  };
  let disposed = false;
  const forget = (entry: Entry): void => {
    if (entries.get(entry.item.identity) === entry) {
      entries.delete(entry.item.identity);
    }
  };
  const release = (entry: Entry, owner: symbol): void => {
    if (!entry.owners.delete(owner) || entry.owners.size) {
      return;
    }
    forget(entry);
    entry.abort.abort();
    const resource = entry.resource;
    delete entry.resource;
    if (resource) {
      clean(entry.item, () => resource.dispose());
    }
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
    const files: PlannedFile[] = [
      {
        role: 'texture',
        url: asset.kind === 'atlas' ? asset.textureUrl : asset.url,
        integrity: asset.integrity?.texture,
      },
    ];
    if (asset.kind === 'atlas') {
      files.push({
        role: 'atlas',
        url: asset.atlasUrl,
        integrity: asset.integrity?.atlas,
      });
    }
    const reservation = (asset.integrity?.texture?.bytes ?? maxFileBytes)
      + (asset.kind === 'atlas' ? (asset.integrity?.atlas?.bytes ?? maxFileBytes) : 0);
    if (!Number.isSafeInteger(reservation) || reservation > maxBufferedBytes) {
      throw new Error(
        `Asset ${pack.id}/${asset.key} reservation ${reservation} exceeds buffered byte limit ${maxBufferedBytes}`,
      );
    }
    // Final integrity verification is the loader's job for every file source;
    // reject files it could not verify before any source work starts.
    const assetLabel = `${pack.id}/${asset.key}`;
    for (const file of files) {
      if (!file.integrity) {
        continue;
      }
      if (file.integrity.bytes > maxFileBytes) {
        throw new Error(`Asset ${assetLabel} ${file.role} declared file exceeds byte limit`);
      }
      if (!globalThis.crypto?.subtle) {
        throw new Error(`Asset ${assetLabel} ${file.role} integrity requires HTTPS or localhost`);
      }
    }
    const context: PhaserPackFileContext = { signal, budgets: fileBudgets };
    const openedFiles: PhaserPackOpenedFile[] = [];
    const bodies: PhaserPackFileBody[] = [];
    let returnDecode: (() => void) | undefined;
    let returnBytes: (() => void) | undefined;
    const openFile = async (file: PlannedFile): Promise<PhaserPackOpenedFile> => {
      const opened = await fileSource.open(
        {
          packId: pack.id,
          revision: pack.revision,
          assetKey: asset.key,
          role: file.role,
          url: file.url,
          integrity: file.integrity,
        },
        context,
      );
      openedFiles.push(opened);
      return opened;
    };
    const readFileBody = async (file: PlannedFile, opened: PhaserPackOpenedFile): Promise<PhaserPackFileBody> => {
      const body = await opened.read();
      bodies.push(body);
      signal.throwIfAborted();
      if (file.integrity) {
        if (body.bytes.size !== file.integrity.bytes) {
          throw new Error(`Asset ${assetLabel} ${file.role} size mismatch`);
        }
        const digest = await digestOf(new Uint8Array(await body.bytes.arrayBuffer()));
        if (digest !== file.integrity.sha256.toLowerCase()) {
          throw new Error(`Asset ${assetLabel} ${file.role} digest mismatch`);
        }
      } else if (body.bytes.size > maxFileBytes) {
        throw new Error(`Asset ${assetLabel} ${file.role} file exceeds byte limit`);
      }
      return body;
    };
    try {
      // Every file acquires source-side ownership before byte admission, so
      // shared source work (an archive, for example) survives admission
      // batching; bodies still transfer only after the budget approves.
      const openedResults = await Promise.allSettled(files.map((file) => openFile(file)));
      const readyFiles: PhaserPackOpenedFile[] = [];
      for (const result of openedResults) {
        if (result.status === 'rejected') {
          throw result.reason;
        }
        readyFiles.push(result.value);
      }
      returnBytes = await buffered.acquire(reservation, signal);
      // Keep the byte reservation until BOTH files settle, even when one fails.
      // Promise.all would release it early while its sibling still holds payloads.
      const results = await Promise.allSettled([
        readFileBody(files[0]!, readyFiles[0]!),
        asset.kind === 'atlas'
          ? readFileBody(files[1]!, readyFiles[1]!).then(
              async (body) => JSON.parse(await body.bytes.text()) as unknown,
            )
          : undefined,
      ]);
      for (const result of results) {
        if (result.status === 'rejected') {
          throw result.reason;
        }
      }
      const imageResult = results[0];
      const atlasResult = results[1];
      if (imageResult.status !== 'fulfilled' || atlasResult.status !== 'fulfilled') {
        throw new Error('Asset download failed');
      }
      const blob = imageResult.value.bytes;
      const atlas = atlasResult.value;
      signal.throwIfAborted();
      returnDecode = await decodes.acquire(1, signal);
      const image = new Image();
      const url = URL.createObjectURL(blob);
      let key: string | undefined;
      try {
        image.src = url;
        // Native decode cannot be cancelled reliably. Keep its slot and byte reservation
        // until it settles, while claim's deadline promptly rejects the waiting caller.
        const cancelImage = (): void => {
          image.src = '';
          URL.revokeObjectURL(url);
        };
        signal.addEventListener('abort', cancelImage, {
          once: true,
        });
        try {
          signal.throwIfAborted();
          await image.decode();
          signal.throwIfAborted();
        } finally {
          signal.removeEventListener('abort', cancelImage);
        }
        const pixels = image.naturalWidth * image.naturalHeight;
        if (!pixels) {
          throw new Error(`Decoded image has no dimensions: ${asset.key}`);
        }
        if (pixels > maxDecodedPixels) {
          throw new Error(`Decoded image exceeds pixel limit: ${asset.key}`);
        }
        if (asset.kind === 'atlas' && (!atlas || typeof atlas !== 'object' || !('frames' in atlas) || !atlas.frames || typeof atlas.frames !== 'object')) {
          throw new Error(`Invalid JSON atlas: ${asset.key}`);
        }
        do {
          key = `__mpgd_pack_${++generation}`;
        } while (scene.textures.exists(key));
        let texture: Phaser.Textures.Texture | null;
        if (asset.kind === 'atlas') {
          texture = scene.textures.addAtlas(key, image, atlas as object);
        } else if (asset.kind === 'spritesheet') {
          texture = scene.textures.addSpriteSheet(key, image, asset.frameConfig);
        } else {
          texture = scene.textures.addImage(key, image);
        }
        if (texture && asset.kind !== 'image' && texture.frameTotal <= 1) {
          throw new Error(`No usable frames: ${asset.key}`);
        }
        if (!texture) {
          throw new Error(`Could not register texture: ${asset.key}`);
        }
        let released = false;
        const textureKey = key;
        return {
          key: textureKey,
          pixels,
          dispose() {
            if (released) {
              return;
            }
            released = true;
            try {
              if (scene.textures.exists(textureKey)) {
                scene.textures.remove(textureKey);
              }
            } finally {
              image.src = '';
            }
          },
        };
      } catch (error) {
        clean(item, () => {
          try {
            if (key && scene.textures.exists(key)) {
              scene.textures.remove(key);
            }
          } finally {
            image.src = '';
          }
        });
        throw error;
      } finally {
        URL.revokeObjectURL(url);
      }
    } finally {
      // File bytes end with decoding/parsing; textures and their leases do not.
      // Returning source bytes or ownership must never abort the remaining
      // cleanup, the decode slot or the byte reservation.
      for (const body of bodies) {
        clean(item, () => body.release());
      }
      for (const opened of openedFiles) {
        clean(item, () => opened.close());
      }
      returnDecode?.();
      returnBytes?.();
    }
  }
  const claim = (item: Planned, owner: symbol): Entry => {
    const existing = entries.get(item.identity);
    if (existing) {
      existing.owners.add(owner);
      return existing;
    }
    const entry: Entry = {
      item, owners: new Set([owner]), abort: new AbortController(), promise: Promise.resolve().then(async () => {
        if (entry.abort.signal.aborted) {
          throw abortError();
        }
        const timer = setTimeout(() => entry.abort.abort(new Error(`Asset preparation timed out: ${item.asset.key}`)), timeoutMs);
        let listener: (() => void) | undefined;
        const work = prepare(item, entry.abort.signal).then((resource) => {
          if (entry.abort.signal.aborted || !entry.owners.size) {
            clean(item, () => resource.dispose());
            throw entry.abort.signal.reason ?? abortError();
          }
          entry.resource = resource;
          return resource;
        });
        try {
          return await Promise.race([work, new Promise<never>((_, reject) => {
            listener = () => reject(entry.abort.signal.reason ?? abortError());
            entry.abort.signal.addEventListener('abort', listener, {
              once: true,
            });
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
        entry.abort.abort(error);
        forget(entry);
        throw error;
      }),
    };
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
    takeCleanupErrors: () => cleanupErrors.splice(0),
    snapshot: () => [...entries.values()].map((entry) => ({
      packId: entry.item.pack.id, assetKey: entry.item.asset.key, owners: entry.owners.size, ready: !!entry.resource, rgbaEstimate: (entry.resource?.pixels ?? 0) * 4,
    })),
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
          }
        }
      };
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
            reject(abortError());
          };
          settings.signal?.addEventListener('abort', listener, {
            once: true,
          });
          if (settings.signal?.aborted) {
            listener();
          }
        })]);
        if (disposed || settings.signal?.aborted) {
          throw abortError();
        }
        const keys = new Map(planned.map((item, i) => [JSON.stringify([item.pack.id, item.asset.key]), resources[i]!.key]));
        return {
          release: releaseAll, key(packId, assetKey) {
            if (released || disposed) {
              throw new Error('Asset pack lease is released');
            }
            const key = keys.get(JSON.stringify([packId, assetKey]));
            if (!key) {
              throw new Error(`Asset is not in this lease: ${packId}/${assetKey}`);
            }
            return key;
          },
        };
      } catch (error) {
        releaseAll();
        throw error;
      } finally {
        if (listener) {
          settings.signal?.removeEventListener('abort', listener);
        }
      }
    },
  };
}
