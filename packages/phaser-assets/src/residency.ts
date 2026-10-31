import type Phaser from 'phaser';

import { loadPhaserAsset, type PhaserAsset, type PhaserAudioAsset } from './index.js';
import {
  createResidencyPolicy,
  type ResidencyGroupSnapshot,
  type ResidencyPolicySnapshot,
} from './residency-policy.js';

export {
  createResidencyPolicy,
  type ResidencyGroupSnapshot,
  type ResidencyGroupState,
  type ResidencyPlan,
  type ResidencyPolicy,
  type ResidencyPolicyOptions,
  type ResidencyPolicySnapshot,
} from './residency-policy.js';

/** A set of assets that is loaded, kept and unloaded together. Asset keys are the engine keys (fixed, not generated). */
export interface PhaserResidencyGroup {
  readonly id: string;
  /** Root manifest shapes: image, spritesheet, atlas, json, binary and audio. */
  readonly assets: readonly PhaserAsset[];
  /** Groups claimed (and loaded) together with this one. */
  readonly dependsOn?: readonly string[];
  /** Expected resident bytes before loading (e.g. width x height x 4 per texture). Used to make room before the load. */
  readonly estimateBytes?: number;
}

/** A runtime-generated resource whose lifetime follows a group (render/canvas textures, derived caches). */
export interface PhaserResidencyAttachment {
  /** Texture removed from the game's texture manager when the group is evicted. */
  readonly textureKey?: string;
  /** Bytes counted toward the group. A function is re-read on `refresh()`. Default: the texture's width x height x 4, else 0. */
  readonly bytes?: number | (() => number);
  /** Called when the group is evicted (before `textureKey` is removed). */
  readonly dispose?: () => void;
}

export interface PhaserResidencyOptions {
  /** Retention cap for unowned groups, in bytes (decoded RGBA estimate + audio PCM + attachments). */
  readonly budgetBytes: number;
  /**
   * Key of the hidden, game-level scene whose loader serves every claim. Default: `__mpgdResidency`. Each instance
   * on the same game needs its own unused key; Phaser rejects a duplicate scene key.
   */
  readonly hostSceneKey?: string;
  /**
   * Called before a group's assets are removed, so the game can drop animations or other engine objects that
   * reference them. Owned groups are never evicted, so display objects of a claimed group are never affected.
   */
  readonly onEvict?: (groupId: string, assetKeys: readonly string[]) => void;
}

export interface PhaserResidencyClaimOptions {
  /** Abort waiting. The claim is dropped if it is still the owner's latest; an in-flight load keeps going and stays cached. */
  readonly signal?: AbortSignal;
}

export interface PhaserResidencyGroupSnapshot extends ResidencyGroupSnapshot {
  readonly attachments: number;
  /**
   * Audio keys of this group that were not loaded because the game cannot play them: audio is disabled
   * (`audio.noAudio`, or no Web Audio and no HTML5 audio) or no URL has a type the device can play. They count as
   * 0 bytes and do not block residency; `game.cache.audio` has no entry for them.
   */
  readonly skippedAudio: readonly string[];
}

export interface PhaserResidencySnapshot extends ResidencyPolicySnapshot {
  readonly groups: readonly PhaserResidencyGroupSnapshot[];
  readonly hostReady: boolean;
}

export interface PhaserResidency {
  /**
   * `owner` now needs exactly `groupIds` (and their dependencies), replacing its previous claim. Resolves once all
   * are resident. Rejects if a group fails to load or the signal aborts. A signal that is already aborted, or a
   * disposed residency, rejects without changing anything.
   */
  claim(owner: string, groupIds: readonly string[], options?: PhaserResidencyClaimOptions): Promise<void>;
  /**
   * `claim` with the scene as owner. The claim is released when the scene shuts down or is destroyed. After
   * `dispose()` it rejects and registers no scene hooks.
   */
  claimForScene(scene: Phaser.Scene, groupIds: readonly string[], options?: PhaserResidencyClaimOptions): Promise<void>;
  /** Drop an owner's claim. Groups stay cached until room is needed. */
  release(owner: string): void;
  /**
   * Warm groups into free budget only (never evicts). Each requested group is admitted together with its missing
   * dependencies or not at all. Returns the group ids that started loading. A prefetched group
   * that is still unclaimed when it loads, and measures more than the free budget, is unloaded again. Throws after
   * `dispose()`.
   */
  prefetch(groupIds: readonly string[]): readonly string[];
  /** True when every group (and dependency) is resident and its assets are present, so a scene can build synchronously. */
  isResident(groupIds: readonly string[]): boolean;
  /**
   * Tie a runtime resource to a resident group. Returns a detach function that does not dispose it. Throws a
   * RangeError when `bytes` is not a non-negative safe integer, and throws after `dispose()`.
   */
  attach(groupId: string, resource: PhaserResidencyAttachment): () => void;
  /**
   * Re-measure resident groups (attachments may have grown) and evict to fit the budget. Throws a RangeError, before
   * changing anything, if an attachment reports an invalid byte count.
   */
  refresh(): void;
  setBudget(bytes: number): void;
  snapshot(): PhaserResidencySnapshot;
  /** Drain errors thrown by disposers and engine removal during eviction. */
  takeCleanupErrors(): readonly { readonly groupId: string; readonly error: unknown }[];
  /** Reject pending claims, unload every tracked group and remove the host scene. */
  dispose(): void;
}

const DEFAULT_HOST_KEY = '__mpgdResidency';

/** Validate a group catalog: unique ids, unique asset keys across groups, known and acyclic dependencies. */
export function definePhaserResidencyGroups<const T extends readonly PhaserResidencyGroup[]>(groups: T): T {
  const ids = new Set<string>();
  const keys = new Map<string, string>();
  for (const group of groups) {
    if (!group.id || ids.has(group.id)) {
      throw new Error(`Duplicate or empty residency group id: ${group.id}`);
    }
    ids.add(group.id);
    if (group.estimateBytes !== undefined && (!Number.isSafeInteger(group.estimateBytes) || group.estimateBytes < 0)) {
      throw new RangeError(`Invalid estimateBytes for residency group ${group.id}`);
    }
    for (const asset of group.assets) {
      const owner = keys.get(asset.key);
      if (owner !== undefined) {
        throw new Error(`Asset key ${asset.key} is in residency groups ${owner} and ${group.id}`);
      }
      keys.set(asset.key, group.id);
    }
  }
  const byId = new Map(groups.map((group) => [group.id, group]));
  const visiting = new Set<string>();
  const done = new Set<string>();
  const visit = (id: string): void => {
    if (done.has(id)) {
      return;
    }
    if (visiting.has(id)) {
      throw new Error(`Residency group dependency cycle at ${id}`);
    }
    visiting.add(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (!byId.has(dep)) {
        throw new Error(`Residency group ${id} depends on unknown group ${dep}`);
      }
      visit(dep);
    }
    visiting.delete(id);
    done.add(id);
  };
  for (const group of groups) {
    visit(group.id);
  }
  return groups;
}

interface Pending {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
  /** Files were handed to the host loader, so its next `complete` covers them. */
  enqueued: boolean;
  /** Asset keys that were already cached when this load started. */
  readonly preexisting: ReadonlySet<string>;
}

interface Attached {
  readonly resource: PhaserResidencyAttachment;
}

/**
 * Game-level residency for asset groups. Loads run on a hidden host scene, so claims survive scene changes; consumer
 * scenes claim what they draw (`claimForScene`) and their claims end with them. Call after the game is created; the
 * host scene starts with the game's scene manager.
 */
export function createPhaserResidency(
  game: Phaser.Game,
  catalog: readonly PhaserResidencyGroup[],
  options: PhaserResidencyOptions,
): PhaserResidency {
  const groups = new Map(
    definePhaserResidencyGroups([...catalog]).map((group) => [group.id, group]),
  );
  const groupOfKey = new Map<string, string>();
  for (const group of groups.values()) {
    for (const asset of group.assets) {
      groupOfKey.set(asset.key, group.id);
    }
  }
  const policy = createResidencyPolicy({
    budgetBytes: options.budgetBytes,
    estimateBytes: (id) => groups.get(id)?.estimateBytes ?? 0,
  });
  const pending = new Map<string, Pending>();
  const attachments = new Map<string, Attached[]>();
  const generation = new Map<string, number>();
  /** Consumer scenes with release hooks, and the function that unhooks them. */
  const hookedScenes = new Map<Phaser.Scene, () => void>();
  const cleanupErrors: { groupId: string; error: unknown }[] = [];
  const waitingForHost: ((host: Phaser.Scene) => void)[] = [];
  /** Groups that failed mid-batch: retries queue their files only after that batch completes. */
  const draining = new Set<string>();
  const afterBatch: (() => void)[] = [];
  const hostKey = options.hostSceneKey ?? DEFAULT_HOST_KEY;
  let host: Phaser.Scene | undefined;
  let disposed = false;
  const disposedError = (): Error => new Error('Residency was disposed');

  const expand = (ids: readonly string[]): string[] => {
    const out: string[] = [];
    const seen = new Set<string>();
    const visit = (id: string): void => {
      if (seen.has(id)) {
        return;
      }
      const group = groups.get(id);
      if (!group) {
        throw new Error(`Unknown residency group: ${id}`);
      }
      seen.add(id);
      for (const dep of group.dependsOn ?? []) {
        visit(dep);
      }
      out.push(id);
    };
    for (const id of ids) {
      visit(id);
    }
    return out;
  };

  /** Mirrors Phaser 4's `load.audio`, which queues nothing when audio is disabled or no URL is playable. */
  const audioSkipped = (asset: PhaserAudioAsset): boolean => {
    const config = (game.config as { audio?: { noAudio?: boolean } } | undefined)?.audio;
    const device = (game.device as { audio?: Record<string, boolean> } | undefined)?.audio;
    if (!device) {
      return false;
    }
    if (config?.noAudio || (!device['webAudio'] && !device['audioData'])) {
      return true;
    }
    const urls = typeof asset.urls === 'string' ? [asset.urls] : asset.urls;
    return !urls.some((url) => {
      if (url.startsWith('blob:') || url.startsWith('data:')) {
        return true;
      }
      const type = /\.([a-zA-Z0-9]+)($|\?)/.exec(url)?.[1]?.toLowerCase();
      return type !== undefined && device[type] === true;
    });
  };

  const present = (asset: PhaserAsset): boolean => {
    switch (asset.kind) {
      case 'image':
      case 'spritesheet':
      case 'atlas':
        return game.textures.exists(asset.key);
      case 'json':
        return game.cache.json.exists(asset.key);
      case 'binary':
        return game.cache.binary.exists(asset.key);
      case 'audio':
        return game.cache.audio.exists(asset.key) || audioSkipped(asset);
    }
  };

  const textureBytes = (key: string): number => {
    if (!game.textures.exists(key)) {
      return 0;
    }
    let sum = 0;
    for (const source of game.textures.get(key).source) {
      sum += source.width * source.height * 4;
    }
    return sum;
  };

  const audioBytes = (key: string): number => {
    const data = game.cache.audio.get(
      key,
    ) as { length?: unknown; numberOfChannels?: unknown } | undefined;
    if (data && typeof data.length === 'number' && typeof data.numberOfChannels === 'number') {
      return data.length * data.numberOfChannels * 4;
    }
    return 0;
  };

  /** Reads an attachment's bytes; throws RangeError in strict mode, otherwise counts invalid values as 0. */
  const attachmentBytes = (resource: PhaserResidencyAttachment, strict = false): number => {
    const value = typeof resource.bytes === 'function' ? resource.bytes() : resource.bytes;
    if (value !== undefined) {
      if (Number.isSafeInteger(value) && value >= 0) {
        return value;
      }
      if (strict) {
        throw new RangeError(`Invalid residency attachment byte count: ${String(value)}`);
      }
      return 0;
    }
    return resource.textureKey ? textureBytes(resource.textureKey) : 0;
  };

  const measure = (id: string): number => {
    let sum = 0;
    for (const asset of groups.get(id)?.assets ?? []) {
      if (asset.kind === 'image' || asset.kind === 'spritesheet' || asset.kind === 'atlas') {
        sum += textureBytes(asset.key);
      } else if (asset.kind === 'audio') {
        sum += audioBytes(asset.key);
      }
    }
    for (const { resource } of attachments.get(id) ?? []) {
      sum += attachmentBytes(resource);
    }
    return sum;
  };

  const guard = (id: string, step: () => void): void => {
    try {
      step();
    } catch (error) {
      cleanupErrors.push({ groupId: id, error });
    }
  };

  /** Remove a group's assets from the engine, except the keys in `keep`, or only `only` when given. */
  const removeAssets = (id: string, keep?: ReadonlySet<string>, only?: string): void => {
    const group = groups.get(id);
    if (!group) {
      return;
    }
    for (const asset of group.assets) {
      if (keep?.has(asset.key) || (only !== undefined && asset.key !== only)) {
        continue;
      }
      guard(id, () => {
        switch (asset.kind) {
          case 'image':
          case 'spritesheet':
          case 'atlas':
            if (game.textures.exists(asset.key)) {
              game.textures.remove(asset.key);
            }
            return;
          case 'json':
            if (game.cache.json.exists(asset.key)) {
              game.cache.json.remove(asset.key);
            }
            return;
          case 'binary':
            if (game.cache.binary.exists(asset.key)) {
              game.cache.binary.remove(asset.key);
            }
            return;
          case 'audio':
            game.sound.removeByKey(asset.key);
            if (game.cache.audio.exists(asset.key)) {
              game.cache.audio.remove(asset.key);
            }
            return;
        }
      });
    }
  };

  /** Groups whose eviction is running: their assets still exist but are about to be removed. */
  const evicting = new Set<string>();

  /** Every asset of the group is usable now (and not about to be removed by a running eviction). */
  const groupPresent = (group: PhaserResidencyGroup): boolean => !evicting.has(group.id) && group.assets.every(present);

  /**
   * Mark a batch of victims before any eviction callback runs: a callback may claim another victim of the batch,
   * which must then reload instead of adopting assets that are about to be removed. Returns the marked ids.
   */
  const markEvicting = (ids: readonly string[]): readonly string[] => {
    const batch = ids.filter((id) => groups.has(id) && !evicting.has(id));
    for (const id of batch) {
      evicting.add(id);
    }
    return batch;
  };

  /** Run the eviction of a batch returned by `markEvicting`. */
  const evictMarked = (batch: readonly string[]): void => {
    for (const id of batch) {
      const group = groups.get(id);
      if (!group) {
        continue;
      }
      if (options.onEvict) {
        const onEvict = options.onEvict;
        guard(id, () =>
          onEvict(
            id,
            group.assets.map((asset) => asset.key),
          ),
        );
      }
      // Take the list first: a disposer may call its own detach function, which would splice a live list.
      const attached = attachments.get(id) ?? [];
      attachments.delete(id);
      for (const { resource } of attached) {
        if (resource.dispose) {
          const dispose = resource.dispose;
          guard(id, dispose);
        }
        const textureKey = resource.textureKey;
        if (textureKey !== undefined) {
          guard(id, () => {
            if (game.textures.exists(textureKey)) {
              game.textures.remove(textureKey);
            }
          });
        }
      }
      removeAssets(id);
      evicting.delete(id);
    }
  };

  const unload = (ids: readonly string[]): void => {
    evictMarked(markEvicting(ids));
  };

  /** Forget resident groups whose engine assets were removed by someone else, so the next claim reloads them. */
  const isStale = (id: string): boolean => {
    const group = groups.get(id);
    return group !== undefined && policy.state(id) === 'resident' && !evicting.has(id) && !group.assets.every(present);
  };

  const healMissing = (ids: readonly string[]): void => {
    for (const id of ids) {
      if (isStale(id)) {
        // Keep its owners: other claims still need it once it is back. Register the reload before eviction callbacks
        // run, so a claim made from onEvict waits for it; files are queued after the cleanup.
        const batch = markEvicting([id]);
        policy.invalidate(id);
        startLoad(id);
        evictMarked(batch);
      }
    }
  };

  /**
   * Record a finished load and unload what the policy evicts. A prefetch the policy discards (it no longer fits) only
   * loses the assets this attempt loaded: prefetch never removes what was already cached.
   */
  const finishLoad = (id: string, preexisting: ReadonlySet<string>): void => {
    const evict = policy.loaded(id, measure(id));
    if (policy.state(id) === undefined) {
      removeAssets(id, preexisting);
      unload(evict.filter((other) => other !== id));
    } else {
      unload(evict);
    }
  };

  const settle = (id: string): void => {
    const wait = pending.get(id);
    if (policy.state(id) !== 'loading') {
      return;
    }
    pending.delete(id);
    finishLoad(id, wait?.preexisting ?? new Set());
    if (disposed) {
      // an eviction callback disposed the residency, which also unloaded this group
      wait?.reject(disposedError());
    } else {
      wait?.resolve();
    }
  };

  const fail = (id: string, error: unknown): void => {
    const wait = pending.get(id);
    if (!wait) {
      return;
    }
    pending.delete(id);
    policy.failed(id);
    // only what this attempt loaded: assets that were already cached stay
    removeAssets(id, wait.preexisting);
    if (host?.load.isLoading()) {
      // Sibling files of this attempt may still be in flight; Phaser would treat a retry's files as duplicates.
      draining.add(id);
    }
    wait.reject(error);
  };

  const check = (): void => {
    for (const id of [...pending.keys()]) {
      const group = groups.get(id);
      if (group && groupPresent(group)) {
        settle(id);
      }
    }
  };

  /** Depth of host-loader event dispatches currently on the stack. */
  let dispatchDepth = 0;
  const dispatching =
    <A extends unknown[]>(handler: (...args: A) => void) =>
    (...args: A): void => {
      dispatchDepth += 1;
      try {
        handler(...args);
      } finally {
        dispatchDepth -= 1;
      }
    };

  const onFileComplete = dispatching((key: string): void => {
    const id = groupOfKey.get(key);
    if (id !== undefined && !pending.has(id) && policy.state(id) === undefined) {
      // a late sibling file of a group that already failed: drop just that asset instead of leaving it untracked
      removeAssets(id, undefined, key);
    }
    check();
  });

  const onHost = (run: (scene: Phaser.Scene) => void): void => {
    // Deferred: never enqueue inside the loader's own COMPLETE dispatch, which resets its queue afterwards.
    queueMicrotask(() => {
      if (disposed) {
        return;
      }
      if (host) {
        run(host);
      } else {
        waitingForHost.push(run);
      }
    });
  };

  /** Registers a pending load for a group with missing assets. Returns false (and does nothing) when all are present. */
  const startLoad = (id: string): boolean => {
    const group = groups.get(id);
    if (!group) {
      return true;
    }
    if (groupPresent(group)) {
      return false;
    }
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    promise.catch(() => undefined);
    // assets of a group whose eviction is running are about to be removed: none of them counts as preexisting
    const cached = evicting.has(id) ? [] : group.assets.filter(present);
    const preexisting = new Set(cached.map((asset) => asset.key));
    const wait: Pending = { promise, resolve, reject, enqueued: false, preexisting };
    pending.set(id, wait);
    const enqueue = (scene: Phaser.Scene): void => {
      if (pending.get(id) !== wait) {
        return;
      }
      if (draining.has(id)) {
        afterBatch.push(() => onHost(enqueue));
        return;
      }
      try {
        for (const asset of group.assets) {
          if (!present(asset)) {
            loadPhaserAsset(scene, asset);
          }
        }
      } catch (error) {
        fail(id, error);
        return;
      }
      wait.enqueued = true;
      if (!scene.load.isLoading()) {
        scene.load.start();
      }
      check();
    };
    onHost(enqueue);
    return true;
  };

  /**
   * Start loading groups the policy just admitted. Every pending load is registered before any adoption can run
   * eviction callbacks, so a claim made from `onEvict` waits for the others instead of resolving early.
   */
  const startLoads = (ids: readonly string[]): void => {
    const adoptable = ids.filter((id) => !startLoad(id));
    for (const id of adoptable) {
      if (policy.state(id) !== 'loading' || startLoad(id)) {
        continue;
      }
      finishLoad(id, new Set(groups.get(id)?.assets.map((asset) => asset.key)));
    }
  };

  const onLoadError = dispatching((file: { key?: string }): void => {
    const id = file.key === undefined ? undefined : groupOfKey.get(file.key);
    // A retry that has not queued its files yet is waiting for this batch to drain: the error is the old attempt's.
    if (id !== undefined && pending.get(id)?.enqueued) {
      fail(id, new Error(`Residency group ${id} failed to load asset ${String(file.key)}`));
    }
  });

  const onLoadComplete = dispatching((): void => {
    check();
    for (const [id, wait] of [...pending]) {
      const group = groups.get(id);
      // Groups claimed during this dispatch (e.g. from onEvict) are not enqueued yet; the next batch covers them.
      if (wait.enqueued && group && !groupPresent(group)) {
        fail(id, new Error(`Residency group ${id} did not finish loading`));
      }
    }
    draining.clear();
    for (const run of afterBatch.splice(0)) {
      run();
    }
  });

  const attachHost = (scene: Phaser.Scene): void => {
    if (disposed) {
      // disposed before the scene manager started the host: remove it now that it exists
      game.scene.remove(hostKey);
      return;
    }
    host = scene;
    // Residency keys are fixed manifest keys: do not inherit the game's `loader.prefix`.
    scene.load.setPrefix('');
    scene.load.on('filecomplete', onFileComplete);
    scene.load.on('loaderror', onLoadError);
    scene.load.on('complete', onLoadComplete);
    for (const run of waitingForHost.splice(0)) {
      run(scene);
    }
  };

  game.scene.add(
    hostKey,
    {
      key: hostKey,
      active: true,
      visible: false,
      create(this: Phaser.Scene) {
        attachHost(this);
      },
    },
    true,
  );

  const ensureLive = (): void => {
    if (disposed) {
      throw disposedError();
    }
  };

  const abortable = (promise: Promise<void>, signal: AbortSignal | undefined, onAbort: () => void): Promise<void> => {
    if (!signal) {
      return promise;
    }
    if (signal.aborted) {
      // claim() rejects pre-aborted signals before doing anything; kept so this helper never leaks a rejection
      promise.catch(() => undefined);
      onAbort();
      return Promise.reject(signal.reason);
    }
    return new Promise<void>((resolve, reject) => {
      const stop = (): void => {
        onAbort();
        reject(signal.reason);
      };
      signal.addEventListener('abort', stop, { once: true });
      promise.then(
        () => {
          signal.removeEventListener('abort', stop);
          resolve();
        },
        (error: unknown) => {
          signal.removeEventListener('abort', stop);
          reject(error);
        },
      );
    });
  };

  const residency: PhaserResidency = {
    claim(owner, groupIds, claimOptions = {}) {
      if (disposed) {
        return Promise.reject(disposedError());
      }
      if (!owner) {
        return Promise.reject(new Error('Residency owner must be a non-empty string'));
      }
      const signal = claimOptions.signal;
      if (signal?.aborted) {
        // cancelled before it started: no claim, no eviction, no load
        return Promise.reject(signal.reason);
      }
      let ids: string[];
      try {
        ids = expand(groupIds);
      } catch (error) {
        return Promise.reject(error);
      }
      healMissing(ids);
      const plan = policy.claim(owner, ids);
      const turn = (generation.get(owner) ?? 0) + 1;
      generation.set(owner, turn);
      // Register the loads before eviction callbacks run, so a claim made from onEvict waits for them. Files are
      // still queued only after this call returns, so eviction happens before loading.
      const victims = markEvicting(plan.evict);
      startLoads(plan.load);
      evictMarked(victims);
      if (disposed) {
        // an eviction callback disposed the residency, which rejected and dropped the loads registered above
        return Promise.reject(disposedError());
      }
      const waits = ids.flatMap((id) => {
        const wait = pending.get(id);
        return wait ? [wait.promise] : [];
      });
      const all = waits.length ? Promise.all(waits).then(() => undefined) : Promise.resolve();
      return abortable(all, signal, () => {
        if (generation.get(owner) === turn) {
          policy.release(owner);
        }
      });
    },
    claimForScene(scene, groupIds, claimOptions) {
      if (disposed) {
        return Promise.reject(disposedError());
      }
      const owner = `scene:${scene.sys.settings.key}`;
      if (!hookedScenes.has(scene) && !claimOptions?.signal?.aborted) {
        const unhook = (): void => {
          hookedScenes.delete(scene);
          scene.events.off('shutdown', end);
          scene.events.off('destroy', end);
        };
        const end = (): void => {
          unhook();
          if (!disposed) {
            policy.release(owner);
          }
        };
        hookedScenes.set(scene, unhook);
        scene.events.once('shutdown', end);
        scene.events.once('destroy', end);
      }
      return residency.claim(owner, groupIds, claimOptions);
    },
    release(owner) {
      policy.release(owner);
    },
    prefetch(groupIds) {
      ensureLive();
      const started: string[] = [];
      for (const requested of groupIds) {
        const closure = expand([requested]);
        if (closure.some(isStale)) {
          // a group lost assets outside residency; prefetch never reloads or evicts it, the next claim heals it
          continue;
        }
        const missing = closure.filter((id) => policy.state(id) === undefined);
        if (!missing.length) {
          continue;
        }
        // All or nothing per requested group: never warm a group whose dependencies do not fit.
        const admitted = policy.prefetch(missing);
        if (admitted.length !== missing.length) {
          for (const id of admitted) {
            policy.forget(id);
          }
          continue;
        }
        startLoads(admitted);
        started.push(...admitted);
      }
      return started;
    },
    isResident(groupIds) {
      return expand(groupIds).every(
        (id) => policy.state(id) === 'resident' && (groups.get(id)?.assets.every(present) ?? false),
      );
    },
    attach(groupId, resource) {
      ensureLive();
      if (policy.state(groupId) !== 'resident') {
        throw new Error(`Residency group ${groupId} is not resident`);
      }
      attachmentBytes(resource, true);
      const entry: Attached = { resource };
      const list = attachments.get(groupId) ?? [];
      list.push(entry);
      attachments.set(groupId, list);
      unload(policy.resize(groupId, measure(groupId)));
      return () => {
        const current = attachments.get(groupId);
        const at = current?.indexOf(entry) ?? -1;
        if (current && at >= 0) {
          current.splice(at, 1);
          unload(policy.resize(groupId, measure(groupId)));
        }
      };
    },
    refresh() {
      const resident = policy.snapshot().groups.filter((group) => group.state === 'resident');
      // Validate every attachment before resizing anything, so an invalid count leaves sizes unchanged.
      for (const group of resident) {
        for (const { resource } of attachments.get(group.id) ?? []) {
          attachmentBytes(resource, true);
        }
      }
      unload(policy.resizeAll(new Map(resident.map((group) => [group.id, measure(group.id)]))));
    },
    setBudget(bytes) {
      unload(policy.setBudget(bytes));
    },
    snapshot() {
      const base = policy.snapshot();
      return {
        ...base,
        groups: base.groups.map((group) => ({
          ...group,
          attachments: attachments.get(group.id)?.length ?? 0,
          skippedAudio: (groups.get(group.id)?.assets ?? []).flatMap((asset) =>
            asset.kind === 'audio' && !game.cache.audio.exists(asset.key) && audioSkipped(asset) ? [asset.key] : [],
          ),
        })),
        hostReady: host !== undefined,
      };
    },
    takeCleanupErrors() {
      return cleanupErrors.splice(0);
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      for (const id of [...pending.keys()]) {
        const wait = pending.get(id);
        pending.delete(id);
        wait?.reject(disposedError());
      }
      const tracked = policy.snapshot().groups.map((group) => group.id);
      unload(tracked);
      for (const id of tracked) {
        policy.forget(id);
      }
      waitingForHost.length = 0;
      for (const unhook of [...hookedScenes.values()]) {
        unhook();
      }
      afterBatch.length = 0;
      draining.clear();
      if (host) {
        host.load.off('filecomplete', onFileComplete);
        host.load.off('loaderror', onLoadError);
        host.load.off('complete', onLoadComplete);
      }
      host = undefined;
      if (dispatchDepth > 0) {
        // Disposed from inside a loader callback (e.g. onEvict at load time): Phaser's loader still touches its
        // queues after this returns, so destroy the host scene once that dispatch has unwound.
        queueMicrotask(() => game.scene.remove(hostKey));
      } else {
        game.scene.remove(hostKey);
      }
    },
  };
  return residency;
}
