import type Phaser from 'phaser';

import { loadPhaserAsset, type PhaserAsset } from './index.js';
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
  /** Key of the hidden, game-level scene whose loader serves every claim. Default: `__mpgdResidency`. */
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

export interface PhaserResidencySnapshot extends ResidencyPolicySnapshot {
  readonly groups: readonly (ResidencyGroupSnapshot & { readonly attachments: number })[];
  readonly hostReady: boolean;
}

export interface PhaserResidency {
  /**
   * `owner` now needs exactly `groupIds` (and their dependencies), replacing its previous claim. Resolves once all
   * are resident. Rejects if a group fails to load or the signal aborts.
   */
  claim(owner: string, groupIds: readonly string[], options?: PhaserResidencyClaimOptions): Promise<void>;
  /** `claim` with the scene as owner. The claim is released when the scene shuts down or is destroyed. */
  claimForScene(scene: Phaser.Scene, groupIds: readonly string[], options?: PhaserResidencyClaimOptions): Promise<void>;
  /** Drop an owner's claim. Groups stay cached until room is needed. */
  release(owner: string): void;
  /** Warm groups into free budget only (never evicts). Returns the group ids that started loading. */
  prefetch(groupIds: readonly string[]): readonly string[];
  /** True when every group (and dependency) is resident, so a scene can build synchronously. */
  isResident(groupIds: readonly string[]): boolean;
  /** Tie a runtime resource to a resident group. Returns a detach function that does not dispose it. */
  attach(groupId: string, resource: PhaserResidencyAttachment): () => void;
  /** Re-measure resident groups (attachments may have grown) and evict to fit the budget. */
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
  const hookedScenes = new Set<Phaser.Scene>();
  const cleanupErrors: { groupId: string; error: unknown }[] = [];
  const waitingForHost: ((host: Phaser.Scene) => void)[] = [];
  const hostKey = options.hostSceneKey ?? DEFAULT_HOST_KEY;
  let host: Phaser.Scene | undefined;
  let disposed = false;

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
        return game.cache.audio.exists(asset.key);
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

  const attachmentBytes = (resource: PhaserResidencyAttachment): number => {
    const value = typeof resource.bytes === 'function' ? resource.bytes() : resource.bytes;
    if (value !== undefined) {
      return Number.isSafeInteger(value) && value > 0 ? value : 0;
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

  const removeAssets = (id: string): void => {
    const group = groups.get(id);
    if (!group) {
      return;
    }
    for (const asset of group.assets) {
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

  const unload = (ids: readonly string[]): void => {
    for (const id of ids) {
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
      for (const { resource } of attachments.get(id) ?? []) {
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
      attachments.delete(id);
      removeAssets(id);
    }
  };

  const settle = (id: string): void => {
    const wait = pending.get(id);
    if (policy.state(id) !== 'loading') {
      return;
    }
    pending.delete(id);
    unload(policy.loaded(id, measure(id)));
    wait?.resolve();
  };

  const fail = (id: string, error: unknown): void => {
    const wait = pending.get(id);
    if (!wait) {
      return;
    }
    pending.delete(id);
    policy.failed(id);
    removeAssets(id);
    wait.reject(error);
  };

  const check = (): void => {
    for (const id of [...pending.keys()]) {
      const group = groups.get(id);
      if (group && group.assets.every(present)) {
        settle(id);
      }
    }
  };

  const onFileComplete = (key: string): void => {
    const id = groupOfKey.get(key);
    if (id !== undefined && !pending.has(id) && policy.state(id) === undefined) {
      // a sibling file of a group that already failed: drop it instead of leaving an untracked asset behind
      removeAssets(id);
    }
    check();
  };

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

  const startLoad = (id: string): void => {
    const group = groups.get(id);
    if (!group) {
      return;
    }
    if (group.assets.every(present)) {
      unload(policy.loaded(id, measure(id)));
      return;
    }
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    promise.catch(() => undefined);
    pending.set(id, { promise, resolve, reject });
    onHost((scene) => {
      if (!pending.has(id)) {
        return;
      }
      for (const asset of group.assets) {
        if (!present(asset)) {
          loadPhaserAsset(scene, asset);
        }
      }
      if (!scene.load.isLoading()) {
        scene.load.start();
      }
      check();
    });
  };

  const attachHost = (scene: Phaser.Scene): void => {
    host = scene;
    scene.load.on('filecomplete', onFileComplete);
    scene.load.on('loaderror', (file: { key?: string }) => {
      const id = file.key === undefined ? undefined : groupOfKey.get(file.key);
      if (id !== undefined) {
        fail(id, new Error(`Residency group ${id} failed to load asset ${String(file.key)}`));
      }
    });
    scene.load.on('complete', () => {
      check();
      for (const id of [...pending.keys()]) {
        const group = groups.get(id);
        if (group && !group.assets.every(present)) {
          fail(id, new Error(`Residency group ${id} did not finish loading`));
        }
      }
    });
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
      throw new Error('Residency was disposed');
    }
  };

  const abortable = (promise: Promise<void>, signal: AbortSignal | undefined, onAbort: () => void): Promise<void> => {
    if (!signal) {
      return promise;
    }
    if (signal.aborted) {
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
      ensureLive();
      if (!owner) {
        return Promise.reject(new Error('Residency owner must be a non-empty string'));
      }
      let ids: string[];
      try {
        ids = expand(groupIds);
      } catch (error) {
        return Promise.reject(error);
      }
      const plan = policy.claim(owner, ids);
      unload(plan.evict);
      const turn = (generation.get(owner) ?? 0) + 1;
      generation.set(owner, turn);
      for (const id of plan.load) {
        startLoad(id);
      }
      const waits = ids.flatMap((id) => {
        const wait = pending.get(id);
        return wait ? [wait.promise] : [];
      });
      const all = waits.length ? Promise.all(waits).then(() => undefined) : Promise.resolve();
      return abortable(all, claimOptions.signal, () => {
        if (generation.get(owner) === turn) {
          policy.release(owner);
        }
      });
    },
    claimForScene(scene, groupIds, claimOptions) {
      const owner = `scene:${scene.sys.settings.key}`;
      if (!hookedScenes.has(scene)) {
        hookedScenes.add(scene);
        const end = (): void => {
          hookedScenes.delete(scene);
          scene.events.off('shutdown', end);
          scene.events.off('destroy', end);
          if (!disposed) {
            policy.release(owner);
          }
        };
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
      const load = policy.prefetch(expand(groupIds));
      for (const id of load) {
        startLoad(id);
      }
      return load;
    },
    isResident(groupIds) {
      return expand(groupIds).every((id) => policy.state(id) === 'resident');
    },
    attach(groupId, resource) {
      ensureLive();
      if (policy.state(groupId) !== 'resident') {
        throw new Error(`Residency group ${groupId} is not resident`);
      }
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
      for (const group of policy.snapshot().groups) {
        if (group.state === 'resident') {
          unload(policy.resize(group.id, measure(group.id)));
        }
      }
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
        wait?.reject(new Error('Residency was disposed'));
      }
      const tracked = policy.snapshot().groups.map((group) => group.id);
      unload(tracked);
      for (const id of tracked) {
        policy.forget(id);
      }
      waitingForHost.length = 0;
      if (host) {
        host.load.off('filecomplete', onFileComplete);
        host.load.removeAllListeners('loaderror');
        host.load.removeAllListeners('complete');
      }
      game.scene.remove(hostKey);
      host = undefined;
    },
  };
  return residency;
}
