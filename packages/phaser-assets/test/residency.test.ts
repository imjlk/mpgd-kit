import { EventEmitter } from 'node:events';

import type Phaser from 'phaser';
import { describe, expect, it, vi } from 'vitest';

import {
  createPhaserResidency,
  definePhaserResidencyGroups,
  type PhaserResidencyGroup,
  type PhaserResidencyOptions,
} from '../src/residency.js';

const MiB = 1024 * 1024;
const TEXTURE_2048 = 2048 * 2048 * 4;

type Kind = 'texture' | 'json' | 'binary' | 'audio';
const PLAYS_EVERYTHING = { webAudio: true, audioData: true, ogg: true, mp3: true, m4a: true };

/** Minimal game: texture manager, caches, sound, scene manager and a manually flushed loader. */
function fixture(
  settings: {
    deferHost?: boolean;
    sizes?: Record<string, [number, number]>;
    audio?: { noAudio?: boolean; device?: Record<string, boolean> };
  } = {},
) {
  const log: string[] = [];
  const textures = new Map<string, { source: { width: number; height: number }[] }>();
  const caches = {
    json: new Map<string, unknown>(),
    binary: new Map<string, unknown>(),
    audio: new Map<string, unknown>(),
  };
  const failing = new Set<string>();
  const throwing = new Set<string>();
  const queue: { key: string; kind: Kind }[] = [];
  const loadEvents = new EventEmitter();
  let loading = false;
  const enqueue = (key: string, kind: Kind): void => {
    if (throwing.has(key)) {
      throw new Error(`cannot queue ${key}`);
    }
    log.push(`queue ${key}`);
    queue.push({ key, kind });
  };
  const load = Object.assign(loadEvents, {
    image: (key: string) => enqueue(key, 'texture'),
    spritesheet: (key: string) => enqueue(key, 'texture'),
    atlas: (key: string) => enqueue(key, 'texture'),
    json: (key: string) => enqueue(key, 'json'),
    binary: (key: string) => enqueue(key, 'binary'),
    audio: (key: string) => enqueue(key, 'audio'),
    isLoading: () => loading,
    setPrefix: vi.fn(),
    start: vi.fn(() => {
      loading = true;
    }),
  });
  /** finish every queued file (or fail the ones in `failing`), then complete like Phaser's loader */
  const flush = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
    while (queue.length) {
      const file = queue.shift()!;
      if (failing.has(file.key)) {
        load.emit('loaderror', { key: file.key });
        continue;
      }
      if (file.kind === 'texture') {
        const [width, height] = settings.sizes?.[file.key] ?? [2048, 2048];
        textures.set(file.key, { source: [{ width, height }] });
      } else if (file.kind === 'audio') {
        caches.audio.set(file.key, { length: 48_000, numberOfChannels: 2 });
      } else {
        caches[file.kind].set(file.key, {});
      }
      log.push(`loaded ${file.key}`);
      load.emit('filecomplete', file.key);
    }
    loading = false;
    load.emit('complete');
    await Promise.resolve();
  };
  const cache = (map: Map<string, unknown>) => ({
    exists: (key: string) => map.has(key),
    get: (key: string) => map.get(key),
    remove: (key: string) => {
      log.push(`remove ${key}`);
      map.delete(key);
    },
  });
  let createHost: (() => void) | undefined;
  const host = { sys: { settings: { key: '__mpgdResidency' } }, load, events: new EventEmitter() };
  const sceneManager = {
    add: vi.fn((_key: string, config: { create: (this: unknown) => void }) => {
      createHost = () => config.create.call(host);
      if (!settings.deferHost) {
        createHost();
      }
      return null;
    }),
    remove: vi.fn(),
  };
  const game = {
    textures: {
      exists: (key: string) => textures.has(key),
      get: (key: string) => textures.get(key),
      remove: (key: string) => {
        log.push(`remove ${key}`);
        textures.delete(key);
      },
    },
    cache: { json: cache(caches.json), binary: cache(caches.binary), audio: cache(caches.audio) },
    sound: { removeByKey: vi.fn((key: string) => log.push(`sound ${key}`)) },
    scene: sceneManager,
    config: { audio: { noAudio: settings.audio?.noAudio ?? false } },
    device: { audio: settings.audio?.device ?? PLAYS_EVERYTHING },
  } as unknown as Phaser.Game;
  const scene = (key: string) => {
    const events = new EventEmitter();
    return { scene: { sys: { settings: { key } }, events } as unknown as Phaser.Scene, events };
  };
  return {
    game,
    log,
    textures,
    caches,
    failing,
    throwing,
    flush,
    load,
    sceneManager,
    scene,
    createHost: () => createHost?.(),
    queue,
  };
}

const set = (id: string, extra: Partial<PhaserResidencyGroup> = {}): PhaserResidencyGroup => ({
  id,
  estimateBytes: TEXTURE_2048,
  assets: [
    { kind: 'atlas', key: `${id}-atlas`, textureUrl: `${id}.webp`, atlasUrl: `${id}.json` },
    { kind: 'json', key: `${id}-data`, url: `${id}-data.json` },
  ],
  ...extra,
});

function setup(groups: readonly PhaserResidencyGroup[], options: Partial<PhaserResidencyOptions> = {}, settings: Parameters<typeof fixture>[0] = {}) {
  const f = fixture(settings);
  const residency = createPhaserResidency(f.game, groups, { budgetBytes: 32 * MiB, ...options });
  return { ...f, residency };
}

describe('phaser residency', () => {
  it('loads a group (texture + json) on a game-level host scene and measures it', async () => {
    const f = setup([set('a')]);
    expect(f.sceneManager.add).toHaveBeenCalledWith('__mpgdResidency', expect.objectContaining({ active: true, visible: false }), true);
    const claim = f.residency.claim('screen', ['a']);
    expect(f.residency.isResident(['a'])).toBe(false);
    await f.flush();
    await claim;
    expect(f.residency.isResident(['a'])).toBe(true);
    expect(f.caches.json.has('a-data')).toBe(true);
    expect(f.residency.snapshot()).toMatchObject({ totalBytes: TEXTURE_2048, ownedBytes: TEXTURE_2048, hostReady: true });
  });

  it('resolves a resident group without touching the loader', async () => {
    const f = setup([set('a')]);
    const first = f.residency.claim('one', ['a']);
    await f.flush();
    await first;
    f.load.start.mockClear();
    f.log.length = 0;
    await f.residency.claim('two', ['a']);
    expect(f.load.start).not.toHaveBeenCalled();
    expect(f.log).toEqual([]);
  });

  it('adopts assets already in the caches instead of loading them again', async () => {
    const f = setup([set('a')]);
    f.textures.set('a-atlas', { source: [{ width: 1024, height: 1024 }] });
    f.caches.json.set('a-data', {});
    await f.residency.claim('screen', ['a']);
    expect(f.queue).toEqual([]);
    expect(f.residency.snapshot().totalBytes).toBe(1024 * 1024 * 4);
  });

  it('evicts the released group before queueing the next one, with its json', async () => {
    const f = setup([set('a'), set('b')], { budgetBytes: 24 * MiB });
    const a = f.residency.claim('screen', ['a']);
    await f.flush();
    await a;
    f.log.length = 0;
    const b = f.residency.claim('screen', ['b']);
    await f.flush();
    await b;
    expect(f.log.indexOf('remove a-atlas')).toBeGreaterThanOrEqual(0);
    expect(f.log.indexOf('remove a-atlas')).toBeLessThan(f.log.indexOf('queue b-atlas'));
    expect(f.log).toContain('remove a-data');
    expect(f.residency.snapshot().groups.map((group) => group.id)).toEqual(['b']);
  });

  it('keeps a released group warm while it fits', async () => {
    const f = setup([set('a'), set('b')], { budgetBytes: 32 * MiB });
    const a = f.residency.claim('screen', ['a']);
    await f.flush();
    await a;
    const b = f.residency.claim('screen', ['b']);
    await f.flush();
    await b;
    expect(f.residency.isResident(['a'])).toBe(true);
    f.log.length = 0;
    await f.residency.claim('screen', ['a']);
    expect(f.log).toEqual([]);
  });

  it('claims dependencies with the group and shares them', async () => {
    const shared: PhaserResidencyGroup = { id: 'shared', assets: [{ kind: 'image', key: 'shared-image', url: 'shared.png' }] };
    const f = setup([shared, set('a', { dependsOn: ['shared'] }), set('b', { dependsOn: ['shared'] })], { budgetBytes: 64 * MiB });
    const a = f.residency.claim('one', ['a']);
    const b = f.residency.claim('two', ['b']);
    await f.flush();
    await Promise.all([a, b]);
    expect(f.log.filter((line) => line === 'queue shared-image')).toHaveLength(1);
    expect(f.residency.snapshot().groups.find((group) => group.id === 'shared')?.owners).toEqual(['one', 'two']);
  });

  it('releases a scene claim when the scene shuts down, leaving the group cached', async () => {
    const f = setup([set('a'), set('b')], { budgetBytes: 16 * MiB });
    const s = f.scene('Level');
    const claim = f.residency.claimForScene(s.scene, ['a']);
    await f.flush();
    await claim;
    expect(f.residency.snapshot().groups[0]?.owners).toEqual(['scene:Level']);
    s.events.emit('shutdown');
    expect(f.residency.snapshot().groups[0]?.owners).toEqual([]);
    expect(f.residency.isResident(['a'])).toBe(true);
    // the next screen needs the room: the cached group goes first
    const next = f.residency.claim('menu', ['b']);
    await f.flush();
    await next;
    expect(f.residency.isResident(['a'])).toBe(false);
    expect(s.events.listenerCount('shutdown')).toBe(0);
  });

  it('ties attached runtime textures to the group: counted, disposed and removed on eviction', async () => {
    const f = setup([set('a'), set('b')], { budgetBytes: 24 * MiB });
    const a = f.residency.claim('screen', ['a']);
    await f.flush();
    await a;
    f.textures.set('a-derived', { source: [{ width: 512, height: 1024 }] });
    const dispose = vi.fn();
    f.residency.attach('a', { textureKey: 'a-derived', dispose });
    expect(f.residency.snapshot().groups[0]).toMatchObject({ bytes: TEXTURE_2048 + 2 * MiB, attachments: 1 });
    const b = f.residency.claim('screen', ['b']);
    await f.flush();
    await b;
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(f.textures.has('a-derived')).toBe(false);
  });

  it('disposes every attachment even when a disposer detaches itself', async () => {
    const f = setup([set('a')]);
    const a = f.residency.claim('screen', ['a']);
    await f.flush();
    await a;
    const disposed: string[] = [];
    const detachFirst = f.residency.attach('a', {
      dispose: () => {
        disposed.push('first');
        detachFirst();
      },
    });
    f.residency.attach('a', { dispose: () => disposed.push('second') });
    f.residency.release('screen');
    f.residency.setBudget(0);
    expect(disposed).toEqual(['first', 'second']);
  });

  it('re-measures attachments with a bytes function on refresh, and detach keeps the resource', async () => {
    const f = setup([set('a')], { budgetBytes: 64 * MiB });
    const a = f.residency.claim('screen', ['a']);
    await f.flush();
    await a;
    let bytes = 1 * MiB;
    const dispose = vi.fn();
    const detach = f.residency.attach('a', { bytes: () => bytes, dispose });
    bytes = 4 * MiB;
    f.residency.refresh();
    expect(f.residency.snapshot().groups[0]?.bytes).toBe(TEXTURE_2048 + 4 * MiB);
    detach();
    expect(f.residency.snapshot().groups[0]?.bytes).toBe(TEXTURE_2048);
    f.residency.release('screen');
    f.residency.setBudget(0);
    expect(dispose).not.toHaveBeenCalled();
    expect(() => f.residency.attach('a', {})).toThrow(/not resident/);
  });

  it('rejects invalid attachment byte counts on attach and refresh without changing sizes', async () => {
    const f = setup([set('a')], { budgetBytes: 64 * MiB });
    const a = f.residency.claim('screen', ['a']);
    await f.flush();
    await a;
    expect(() => f.residency.attach('a', { bytes: -1 })).toThrow(RangeError);
    expect(() => f.residency.attach('a', { bytes: 1.5 })).toThrow(RangeError);
    expect(f.residency.snapshot().groups[0]).toMatchObject({ attachments: 0, bytes: TEXTURE_2048 });
    let bytes = MiB;
    f.residency.attach('a', { bytes: () => bytes });
    bytes = Number.NaN;
    expect(() => f.residency.refresh()).toThrow(RangeError);
    expect(f.residency.snapshot().groups[0]?.bytes).toBe(TEXTURE_2048 + MiB);
  });

  it('prefetches a group only together with dependencies that fit', async () => {
    const big: PhaserResidencyGroup = { ...set('big'), estimateBytes: 4 * TEXTURE_2048 };
    const f = setup([big, set('child', { dependsOn: ['big'] }), set('solo')], { budgetBytes: 32 * MiB });
    expect(f.residency.prefetch(['child', 'solo'])).toEqual(['solo']);
    expect(f.residency.snapshot().groups.map((group) => group.id)).toEqual(['solo']);
    await f.flush();
    expect(f.residency.isResident(['child'])).toBe(false);
    expect(f.residency.isResident(['solo'])).toBe(true);
  });

  it('reloads a group whose assets were removed by someone else', async () => {
    const f = setup([set('a')]);
    const a = f.residency.claim('screen', ['a']);
    await f.flush();
    await a;
    f.textures.delete('a-atlas');
    expect(f.residency.isResident(['a'])).toBe(false);
    const again = f.residency.claim('screen', ['a']);
    await f.flush();
    await again;
    expect(f.textures.has('a-atlas')).toBe(true);
    expect(f.residency.isResident(['a'])).toBe(true);
  });

  it('a claim made from onEvict for the evicted group reloads it instead of adopting removed assets', async () => {
    const ref: { residency?: ReturnType<typeof createPhaserResidency> } = {};
    let reclaim: Promise<void> | undefined;
    const f = setup([set('a'), set('b')], {
      budgetBytes: 16 * MiB,
      onEvict: (id) => {
        if (id === 'a' && !reclaim) {
          reclaim = ref.residency?.claim('other', ['a']);
        }
      },
    });
    ref.residency = f.residency;
    const a = f.residency.claim('screen', ['a']);
    await f.flush();
    await a;
    f.residency.release('screen');
    const b = f.residency.claim('screen', ['b']);
    expect(f.textures.has('a-atlas')).toBe(false);
    expect(f.residency.isResident(['a'])).toBe(false);
    await f.flush();
    await Promise.all([b, reclaim]);
    expect(f.textures.has('a-atlas')).toBe(true);
    expect(f.residency.isResident(['a', 'b'])).toBe(true);
  });

  it('prefetches into free budget only and never evicts', async () => {
    const f = setup([set('a'), set('b'), set('c')], { budgetBytes: 32 * MiB });
    const a = f.residency.claim('screen', ['a']);
    await f.flush();
    await a;
    expect(f.residency.prefetch(['b', 'c'])).toEqual(['b']);
    await f.flush();
    expect(f.residency.isResident(['b'])).toBe(true);
    expect(f.residency.prefetch(['c'])).toEqual([]);
    expect(f.residency.isResident(['a'])).toBe(true);
  });

  it('rejects a claim whose group fails, removes partial assets and retries on the next claim', async () => {
    const f = setup([set('a')]);
    f.failing.add('a-atlas');
    const claim = f.residency.claim('screen', ['a']);
    await f.flush();
    await expect(claim).rejects.toThrow(/a/);
    expect(f.caches.json.has('a-data')).toBe(false);
    expect(f.residency.snapshot().groups).toEqual([]);
    f.failing.clear();
    const retry = f.residency.claim('screen', ['a']);
    await f.flush();
    await expect(retry).resolves.toBeUndefined();
  });

  it('a retry after a mid-batch failure queues its files only after that batch completes', async () => {
    const f = setup([set('a')]);
    const first = f.residency.claim('screen', ['a']);
    await Promise.resolve();
    await Promise.resolve();
    expect(f.queue.map((file) => file.key)).toEqual(['a-atlas', 'a-data']);
    // the atlas fails while a-data is still in flight; the game retries right away
    f.queue.shift();
    let retry: Promise<void> | undefined;
    const retried = first.catch(() => {
      retry = f.residency.claim('screen', ['a']);
    });
    f.load.emit('loaderror', { key: 'a-atlas' });
    await retried;
    await Promise.resolve();
    expect(f.log.filter((line) => line === 'queue a-atlas')).toHaveLength(1);
    await f.flush(); // a-data lands and the batch completes
    expect(f.log.filter((line) => line === 'queue a-atlas')).toHaveLength(2);
    await f.flush();
    await expect(retry).resolves.toBeUndefined();
    expect(f.residency.isResident(['a'])).toBe(true);
  });

  it('errors from the failed attempt do not reject a retry that waits for the batch to drain', async () => {
    const f = setup([set('a')]);
    f.failing.add('a-data');
    const first = f.residency.claim('screen', ['a']);
    await Promise.resolve();
    await Promise.resolve();
    f.queue.shift();
    let retry: Promise<void> | undefined;
    const retried = first.catch(() => {
      retry = f.residency.claim('screen', ['a']);
    });
    f.load.emit('loaderror', { key: 'a-atlas' });
    await retried;
    let rejected = false;
    retry?.catch(() => {
      rejected = true;
    });
    await f.flush(); // a-data fails too, in the old batch
    expect(rejected).toBe(false);
    f.failing.clear();
    await f.flush();
    await expect(retry).resolves.toBeUndefined();
    expect(f.residency.isResident(['a'])).toBe(true);
  });

  it('a claim whose load-time eviction callback disposes the residency rejects', async () => {
    let removedInDispatch: number | undefined;
    const f = setup([set('warm'), set('big', { estimateBytes: 0 })], {
      budgetBytes: 20 * MiB,
      onEvict: () => {
        f.residency.dispose();
        removedInDispatch ??= f.sceneManager.remove.mock.calls.length;
      },
    });
    const warm = f.residency.claim('screen', ['warm']);
    await f.flush();
    await warm;
    f.residency.release('screen');
    const big = f.residency.claim('screen', ['big']);
    big.catch(() => undefined);
    await f.flush();
    await expect(big).rejects.toThrow(/disposed/);
    expect(f.textures.has('big-atlas')).toBe(false);
    // the host scene is destroyed only after the loader dispatch has unwound
    expect(removedInDispatch).toBe(0);
    expect(f.sceneManager.remove).toHaveBeenCalledTimes(1);
  });

  it('aborting a wait drops the latest claim; the load still completes and stays cached', async () => {
    const f = setup([set('a')]);
    const abort = new AbortController();
    const claim = f.residency.claim('screen', ['a'], { signal: abort.signal });
    abort.abort(new Error('left'));
    await expect(claim).rejects.toThrow('left');
    await f.flush();
    expect(f.residency.isResident(['a'])).toBe(true);
    expect(f.residency.snapshot().groups[0]?.owners).toEqual([]);
  });

  it('an already-aborted signal rejects without starting work or changing claims', async () => {
    const f = setup([set('a'), set('b')], { budgetBytes: 64 * MiB });
    const a = f.residency.claim('screen', ['a']);
    await f.flush();
    await a;
    const abort = new AbortController();
    abort.abort(new Error('gone'));
    await expect(f.residency.claim('screen', ['b'], { signal: abort.signal })).rejects.toThrow('gone');
    await Promise.resolve();
    expect(f.queue).toEqual([]);
    expect(f.residency.snapshot().groups.map((group) => [group.id, group.owners])).toEqual([['a', ['screen']]]);
    // dispose with no pending aggregate must not surface an unhandled rejection
    f.residency.dispose();
  });

  it('an abort during a load that later fails does not leave an unhandled rejection', async () => {
    const f = setup([set('a')]);
    f.failing.add('a-atlas');
    const abort = new AbortController();
    const claim = f.residency.claim('screen', ['a'], { signal: abort.signal });
    abort.abort(new Error('left'));
    await expect(claim).rejects.toThrow('left');
    await f.flush();
    expect(f.residency.snapshot().groups).toEqual([]);
  });

  it('unloads a prefetched group that measures over its estimate instead of evicting warm groups', async () => {
    const f = setup([set('warm'), set('extra', { estimateBytes: 0 })], { budgetBytes: 24 * MiB });
    const warm = f.residency.claim('screen', ['warm']);
    await f.flush();
    await warm;
    f.residency.release('screen');
    expect(f.residency.prefetch(['extra'])).toEqual(['extra']);
    await f.flush();
    expect(f.residency.isResident(['warm'])).toBe(true);
    expect(f.residency.isResident(['extra'])).toBe(false);
    expect(f.textures.has('extra-atlas')).toBe(false);
    expect(f.caches.json.has('extra-data')).toBe(false);
  });

  it('an aborted older claim does not drop a newer claim by the same owner', async () => {
    const f = setup([set('a'), set('b')], { budgetBytes: 64 * MiB });
    const abort = new AbortController();
    const old = f.residency.claim('screen', ['a'], { signal: abort.signal });
    const latest = f.residency.claim('screen', ['b']);
    abort.abort(new Error('superseded'));
    await expect(old).rejects.toThrow('superseded');
    await f.flush();
    await latest;
    expect(f.residency.snapshot().groups.find((group) => group.id === 'b')?.owners).toEqual(['screen']);
  });

  it('queues work until the host scene is created', async () => {
    const f = setup([set('a')], {}, { deferHost: true });
    const claim = f.residency.claim('screen', ['a']);
    await Promise.resolve();
    expect(f.queue).toEqual([]);
    expect(f.residency.snapshot().hostReady).toBe(false);
    f.createHost();
    await f.flush();
    await claim;
    expect(f.residency.isResident(['a'])).toBe(true);
  });

  it('calls onEvict before removal, removes audio from the sound manager, and collects cleanup errors', async () => {
    const order: string[] = [];
    const audioSet: PhaserResidencyGroup = { id: 'voice', assets: [{ kind: 'audio', key: 'voice-line', urls: ['line.ogg'] }] };
    const f = setup([audioSet, set('b')], {
      budgetBytes: 16 * MiB,
      onEvict: (id, keys) => {
        order.push(`evict ${id} ${keys.join(',')}`);
        throw new Error('animation cleanup failed');
      },
    });
    const voice = f.residency.claim('screen', ['voice']);
    await f.flush();
    await voice;
    expect(f.residency.snapshot().groups[0]?.bytes).toBe(48_000 * 2 * 4);
    f.residency.release('screen');
    const b = f.residency.claim('screen', ['b']);
    await f.flush();
    await b;
    expect(order).toEqual(['evict voice voice-line']);
    expect(f.log).toContain('sound voice-line');
    expect(f.log).toContain('remove voice-line');
    const errors = f.residency.takeCleanupErrors();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.groupId).toBe('voice');
    expect(f.residency.takeCleanupErrors()).toEqual([]);
  });

  it('dispose rejects pending claims, unloads everything and removes the host scene', async () => {
    const f = setup([set('a'), set('b')], { budgetBytes: 64 * MiB });
    const a = f.residency.claim('screen', ['a']);
    await f.flush();
    await a;
    const b = f.residency.claim('other', ['b']);
    f.residency.dispose();
    await expect(b).rejects.toThrow(/disposed/);
    expect(f.textures.has('a-atlas')).toBe(false);
    expect(f.sceneManager.remove).toHaveBeenCalledWith('__mpgdResidency');
    f.residency.dispose();
  });

  it('removes a host scene that is created after dispose', async () => {
    const f = setup([set('a')], {}, { deferHost: true });
    f.residency.dispose();
    f.createHost();
    expect(f.sceneManager.remove).toHaveBeenCalledTimes(2);
    expect(f.residency.snapshot().hostReady).toBe(false);
    expect(f.load.listenerCount('filecomplete')).toBe(0);
  });

  it('after dispose, claim and claimForScene reject without throwing or hooking the scene; prefetch and attach throw', async () => {
    const f = setup([set('a')]);
    f.residency.dispose();
    let claim: Promise<void> | undefined;
    expect(() => {
      claim = f.residency.claim('screen', ['a']);
    }).not.toThrow();
    await expect(claim).rejects.toThrow(/disposed/);
    const s = f.scene('Level');
    await expect(f.residency.claimForScene(s.scene, ['a'])).rejects.toThrow(/disposed/);
    expect(s.events.listenerCount('shutdown')).toBe(0);
    expect(s.events.listenerCount('destroy')).toBe(0);
    expect(() => f.residency.prefetch(['a'])).toThrow(/disposed/);
    expect(() => f.residency.attach('a', {})).toThrow(/disposed/);
  });

  it('a prefetched group that outgrows the free budget is unloaded instead of evicting warm groups', async () => {
    const f = setup([set('warm'), set('b', { estimateBytes: 0 })], { budgetBytes: 20 * MiB });
    const warm = f.residency.claim('screen', ['warm']);
    await f.flush();
    await warm;
    f.residency.release('screen');
    expect(f.residency.prefetch(['b'])).toEqual(['b']);
    await f.flush();
    expect(f.residency.isResident(['warm'])).toBe(true);
    expect(f.textures.has('warm-atlas')).toBe(true);
    expect(f.residency.isResident(['b'])).toBe(false);
    expect(f.textures.has('b-atlas')).toBe(false);
    expect(f.caches.json.has('b-data')).toBe(false);
    expect(f.residency.snapshot().groups.map((group) => group.id)).toEqual(['warm']);
  });

  it('claiming a group that is still loading speculatively makes it a normal demanded load', async () => {
    const f = setup([set('warm'), set('b', { estimateBytes: 0 })], { budgetBytes: 20 * MiB });
    const warm = f.residency.claim('screen', ['warm']);
    await f.flush();
    await warm;
    f.residency.release('screen');
    expect(f.residency.prefetch(['b'])).toEqual(['b']);
    const claim = f.residency.claim('level', ['b']);
    await f.flush();
    await claim;
    expect(f.residency.isResident(['b'])).toBe(true);
    expect(f.residency.isResident(['warm'])).toBe(false);
    expect(f.log.filter((line) => line === 'queue b-atlas')).toHaveLength(1);
  });

  it('an already-aborted claim changes nothing: no owner, no eviction, no load', async () => {
    const f = setup([set('a'), set('b')], { budgetBytes: 16 * MiB });
    const a = f.residency.claim('screen', ['a']);
    await f.flush();
    await a;
    f.residency.release('screen');
    f.log.length = 0;
    const abort = new AbortController();
    abort.abort(new Error('gone'));
    await expect(f.residency.claim('screen', ['b'], { signal: abort.signal })).rejects.toThrow('gone');
    await f.flush();
    expect(f.log).toEqual([]);
    expect(f.residency.isResident(['a'])).toBe(true);
    expect(f.residency.snapshot().groups.map((group) => group.id)).toEqual(['a']);
  });

  it('an already-aborted claim on a loading group leaves no unhandled rejection when the load later fails', async () => {
    const unhandled: unknown[] = [];
    const record = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', record);
    try {
      const f = setup([set('a'), set('b')]);
      f.failing.add('a-atlas');
      const first = f.residency.claim('one', ['a']);
      first.catch(() => undefined);
      const abort = new AbortController();
      abort.abort(new Error('gone'));
      await expect(f.residency.claim('two', ['a'], { signal: abort.signal })).rejects.toThrow('gone');
      await f.flush();
      await expect(first).rejects.toThrow(/a-atlas/);
      const second = f.residency.claim('one', ['b']);
      second.catch(() => undefined);
      await expect(f.residency.claim('two', ['b'], { signal: abort.signal })).rejects.toThrow('gone');
      f.residency.dispose();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', record);
    }
  });

  it('a claim made inside the loader dispatch (from onEvict) waits for the next batch instead of failing', async () => {
    const small: PhaserResidencyGroup = { id: 'small', assets: [{ kind: 'image', key: 'small-image', url: 'small.png' }] };
    const tiny: PhaserResidencyGroup = { id: 'tiny', assets: [{ kind: 'image', key: 'tiny-image', url: 'tiny.png' }] };
    let nested: Promise<void> | undefined;
    let prefetched: readonly string[] = [];
    const f = setup(
      [set('warm'), set('big', { estimateBytes: 0 }), small, tiny],
      {
        budgetBytes: 20 * MiB,
        onEvict: (id) => {
          if (id === 'warm') {
            nested = f.residency.claim('hud', ['small']);
            prefetched = f.residency.prefetch(['tiny']);
          }
        },
      },
      { sizes: { 'small-image': [16, 16], 'tiny-image': [8, 8] } },
    );
    const warm = f.residency.claim('screen', ['warm']);
    await f.flush();
    await warm;
    f.residency.release('screen');
    // big is estimated at 0, so warm is evicted only when big's measured size lands, inside filecomplete
    const big = f.residency.claim('screen', ['big']);
    await f.flush();
    await big;
    expect(nested).toBeDefined();
    let settled: 'resolved' | 'rejected' | undefined;
    nested?.then(
      () => {
        settled = 'resolved';
      },
      () => {
        settled = 'rejected';
      },
    );
    await Promise.resolve();
    expect(settled).toBeUndefined();
    await f.flush();
    await expect(nested).resolves.toBeUndefined();
    expect(prefetched).toEqual(['tiny']);
    expect(f.residency.isResident(['small', 'tiny', 'big'])).toBe(true);
  });

  it('re-claiming the group being evicted from onEvict reloads it instead of adopting assets about to be removed', async () => {
    let nested: Promise<void> | undefined;
    const f = setup([set('warm'), set('big', { estimateBytes: 0 })], {
      budgetBytes: 40 * MiB,
      onEvict: (id) => {
        if (id === 'warm' && !nested) {
          nested = f.residency.claim('hud', ['warm']);
        }
      },
    });
    const warm = f.residency.claim('screen', ['warm']);
    await f.flush();
    await warm;
    f.residency.release('screen');
    f.residency.setBudget(20 * MiB);
    const big = f.residency.claim('screen', ['big']);
    await f.flush();
    await big;
    expect(nested).toBeDefined();
    expect(f.textures.has('warm-atlas')).toBe(false);
    await f.flush();
    await nested;
    expect(f.residency.isResident(['warm'])).toBe(true);
    expect(f.textures.has('warm-atlas')).toBe(true);
    expect(f.caches.json.has('warm-data')).toBe(true);
    expect(f.residency.snapshot().groups.find((group) => group.id === 'warm')?.owners).toEqual(['hud']);
  });

  it('a callback for one evicted group can re-claim a later victim of the same batch, which reloads', async () => {
    let nested: Promise<void> | undefined;
    const f = setup([set('w1'), set('w2')], {
      budgetBytes: 40 * MiB,
      onEvict: (id) => {
        if (id === 'w1') {
          nested = f.residency.claim('hud', ['w2']);
        }
      },
    });
    const both = f.residency.claim('screen', ['w1', 'w2']);
    await f.flush();
    await both;
    f.residency.release('screen');
    f.residency.setBudget(0);
    expect(nested).toBeDefined();
    expect(f.textures.has('w2-atlas')).toBe(false);
    await f.flush();
    await nested;
    expect(f.residency.isResident(['w2'])).toBe(true);
    expect(f.textures.has('w2-atlas')).toBe(true);
    expect(f.residency.isResident(['w1'])).toBe(false);
  });

  it('a claim made from onEvict for the group whose claim caused the eviction waits for its load', async () => {
    let nested: Promise<void> | undefined;
    const f = setup([set('warm'), set('next')], {
      budgetBytes: 20 * MiB,
      onEvict: (id) => {
        if (id === 'warm') {
          nested = f.residency.claim('hud', ['next']);
        }
      },
    });
    const warm = f.residency.claim('screen', ['warm']);
    await f.flush();
    await warm;
    f.residency.release('screen');
    const next = f.residency.claim('screen', ['next']);
    expect(nested).toBeDefined();
    let settled = false;
    nested?.then(
      () => {
        settled = true;
      },
      () => undefined,
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(f.log.indexOf('remove warm-atlas')).toBeLessThan(f.log.indexOf('queue next-atlas'));
    await f.flush();
    await Promise.all([next, nested]);
    expect(settled).toBe(true);
    expect(f.residency.isResident(['next'])).toBe(true);
  });

  it('adopting one claimed group cannot let an onEvict claim skip the wait for another claimed group', async () => {
    let nested: Promise<void> | undefined;
    const f = setup([set('warm'), set('a', { estimateBytes: 0 }), set('b', { estimateBytes: 0 })], {
      budgetBytes: 20 * MiB,
      onEvict: (id) => {
        if (id === 'warm') {
          nested = f.residency.claim('hud', ['b']);
        }
      },
    });
    const warm = f.residency.claim('screen', ['warm']);
    await f.flush();
    await warm;
    f.residency.release('screen');
    f.textures.set('a-atlas', { source: [{ width: 2048, height: 2048 }] });
    f.caches.json.set('a-data', {});
    // a is adopted synchronously (16 MiB measured over a 0 estimate), which evicts warm before b has loaded
    const claim = f.residency.claim('screen', ['a', 'b']);
    expect(nested).toBeDefined();
    let settled = false;
    nested?.then(
      () => {
        settled = true;
      },
      () => undefined,
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    await f.flush();
    await Promise.all([claim, nested]);
    expect(f.residency.isResident(['a', 'b'])).toBe(true);
  });

  it('an onEvict claim for a planned victim, made while adopting another group, reloads it', async () => {
    let nested: Promise<void> | undefined;
    const f = setup([set('w1'), set('w2'), set('a', { estimateBytes: 16 * MiB })], {
      budgetBytes: 32 * MiB,
      onEvict: (id) => {
        if (id === 'w2') {
          nested = f.residency.claim('hud', ['w1']);
        }
      },
    });
    const both = f.residency.claim('screen', ['w1', 'w2']);
    await f.flush();
    await both;
    f.residency.release('screen');
    f.residency.claim('screen', ['w2']).catch(() => undefined);
    f.residency.release('screen'); // w1 is now the least recently used
    f.textures.set('a-atlas', { source: [{ width: 2048, height: 4096 }] });
    f.caches.json.set('a-data', {});
    // the plan evicts w1 for a's estimate; adopting a (32 MiB measured) then evicts w2, whose onEvict re-claims w1
    const claim = f.residency.claim('screen', ['a']);
    expect(nested).toBeDefined();
    await f.flush();
    await Promise.all([claim, nested]);
    expect(f.residency.isResident(['w1'])).toBe(true);
    expect(f.textures.has('w1-atlas')).toBe(true);
    expect(f.caches.json.has('w1-data')).toBe(true);
  });

  it('clears the inherited loader key prefix on the host', () => {
    const f = setup([set('a')]);
    expect(f.load.setPrefix).toHaveBeenCalledWith('');
  });

  it('a claim whose eviction callback disposes the residency rejects', async () => {
    const f = setup([set('warm'), set('next')], {
      budgetBytes: 20 * MiB,
      onEvict: () => f.residency.dispose(),
    });
    const warm = f.residency.claim('screen', ['warm']);
    await f.flush();
    await warm;
    f.residency.release('screen');
    await expect(f.residency.claim('screen', ['next'])).rejects.toThrow(/disposed/);
  });

  it('dispose unhooks consumer scenes that are still running', async () => {
    const f = setup([set('a')]);
    const s = f.scene('Level');
    const claim = f.residency.claimForScene(s.scene, ['a']);
    await f.flush();
    await claim;
    expect(s.events.listenerCount('shutdown')).toBe(1);
    f.residency.dispose();
    expect(s.events.listenerCount('shutdown')).toBe(0);
    expect(s.events.listenerCount('destroy')).toBe(0);
  });

  it('removes a host scene that starts after dispose', () => {
    const f = setup([set('a')], {}, { deferHost: true });
    f.residency.dispose();
    expect(f.sceneManager.remove).toHaveBeenCalledTimes(1);
    f.createHost();
    expect(f.sceneManager.remove).toHaveBeenCalledTimes(2);
    expect(f.load.listenerCount('filecomplete')).toBe(0);
    expect(f.load.listenerCount('complete')).toBe(0);
    expect(f.residency.snapshot().hostReady).toBe(false);
  });

  it('healing a group with missing assets keeps the other owners', async () => {
    const f = setup([set('a')]);
    const one = f.residency.claim('one', ['a']);
    const two = f.residency.claim('two', ['a']);
    await f.flush();
    await Promise.all([one, two]);
    f.textures.delete('a-atlas');
    const again = f.residency.claim('one', ['a']);
    await f.flush();
    await again;
    expect(f.textures.has('a-atlas')).toBe(true);
    f.residency.release('one');
    expect(f.residency.snapshot().groups[0]?.owners).toEqual(['two']);
    f.residency.setBudget(0);
    expect(f.residency.isResident(['a'])).toBe(true);
  });

  it('prefetch skips a closure with a stale group instead of healing it', async () => {
    const f = setup([set('dep'), set('child', { dependsOn: ['dep'] })], { budgetBytes: 16 * MiB });
    const dep = f.residency.claim('screen', ['dep']);
    await f.flush();
    await dep;
    f.residency.release('screen');
    f.textures.delete('dep-atlas');
    f.log.length = 0;
    expect(f.residency.prefetch(['child'])).toEqual([]);
    await f.flush();
    expect(f.log).toEqual([]);
    expect(f.caches.json.has('dep-data')).toBe(true);
    expect(f.residency.snapshot().groups.map((group) => group.id)).toEqual(['dep']);
  });

  it('a claim made from onEvict while healing waits for the reload', async () => {
    let nested: Promise<void> | undefined;
    const f = setup([set('a')], {
      onEvict: (id) => {
        if (id === 'a' && !nested) {
          nested = f.residency.claim('hud', ['a']);
        }
      },
    });
    const first = f.residency.claim('screen', ['a']);
    await f.flush();
    await first;
    f.textures.delete('a-atlas');
    const again = f.residency.claim('screen', ['a']);
    expect(nested).toBeDefined();
    let settled = false;
    nested?.then(
      () => {
        settled = true;
      },
      () => undefined,
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    await f.flush();
    await Promise.all([again, nested]);
    expect(f.textures.has('a-atlas')).toBe(true);
    expect(f.residency.snapshot().groups[0]?.owners).toEqual(['screen', 'hud']);
  });

  it('refresh applies every new size before evicting', async () => {
    const f = setup([set('a'), set('b')], { budgetBytes: 2 * TEXTURE_2048 + 2 * MiB });
    const both = f.residency.claim('screen', ['a', 'b']);
    await f.flush();
    await both;
    let aBytes = MiB;
    let bBytes = MiB;
    f.residency.attach('a', { bytes: () => aBytes });
    f.residency.attach('b', { bytes: () => bBytes });
    f.residency.release('screen');
    aBytes = 2 * MiB - 1;
    bBytes = 1;
    f.residency.refresh();
    expect(f.residency.isResident(['a', 'b'])).toBe(true);
    expect(f.residency.snapshot().totalBytes).toBe(2 * TEXTURE_2048 + 2 * MiB);
  });

  it('a failed reload of the group being evicted removes what the reload brought in', async () => {
    let nested: Promise<void> | undefined;
    const f = setup([set('warm'), set('big', { estimateBytes: 0 })], {
      budgetBytes: 40 * MiB,
      onEvict: (id) => {
        if (id === 'warm' && !nested) {
          nested = f.residency.claim('hud', ['warm']);
          nested.catch(() => undefined);
        }
      },
    });
    const warm = f.residency.claim('screen', ['warm']);
    await f.flush();
    await warm;
    f.residency.release('screen');
    f.residency.setBudget(20 * MiB);
    f.failing.add('warm-data');
    const big = f.residency.claim('screen', ['big']);
    await f.flush();
    await big;
    await f.flush();
    await expect(nested).rejects.toThrow(/warm-data/);
    expect(f.textures.has('warm-atlas')).toBe(false);
    expect(f.residency.snapshot().groups.map((group) => group.id)).toEqual(['big']);
  });

  it('rejects the claim when queueing a file throws, and retries on the next claim', async () => {
    const f = setup([set('a')]);
    f.throwing.add('a-data');
    const claim = f.residency.claim('screen', ['a']);
    await f.flush();
    await expect(claim).rejects.toThrow('cannot queue a-data');
    expect(f.residency.snapshot().groups).toEqual([]);
    expect(f.textures.has('a-atlas')).toBe(false);
    f.throwing.clear();
    const retry = f.residency.claim('screen', ['a']);
    await f.flush();
    await expect(retry).resolves.toBeUndefined();
  });

  it('a prefetch that adopts cached assets but does not fit forgets them without removing them', async () => {
    const f = setup([set('warm'), set('b', { estimateBytes: 0 })], { budgetBytes: 20 * MiB });
    const warm = f.residency.claim('screen', ['warm']);
    await f.flush();
    await warm;
    f.residency.release('screen');
    f.textures.set('b-atlas', { source: [{ width: 2048, height: 2048 }] });
    f.caches.json.set('b-data', {});
    expect(f.residency.prefetch(['b'])).toEqual(['b']);
    expect(f.residency.snapshot().groups.map((group) => group.id)).toEqual(['warm']);
    expect(f.textures.has('b-atlas')).toBe(true);
    expect(f.caches.json.has('b-data')).toBe(true);
    expect(f.residency.isResident(['warm'])).toBe(true);
  });

  it('a discarded partial prefetch removes only the assets it loaded', async () => {
    const f = setup([set('warm'), set('b', { estimateBytes: 0 })], { budgetBytes: 20 * MiB });
    const warm = f.residency.claim('screen', ['warm']);
    await f.flush();
    await warm;
    f.residency.release('screen');
    f.textures.set('b-atlas', { source: [{ width: 2048, height: 2048 }] });
    expect(f.residency.prefetch(['b'])).toEqual(['b']);
    await f.flush();
    expect(f.log).toContain('queue b-data');
    expect(f.log).not.toContain('queue b-atlas');
    expect(f.residency.snapshot().groups.map((group) => group.id)).toEqual(['warm']);
    expect(f.textures.has('b-atlas')).toBe(true);
    expect(f.caches.json.has('b-data')).toBe(false);
  });

  it('a failed load keeps assets that were cached before it and drops late siblings it loaded', async () => {
    const group: PhaserResidencyGroup = {
      id: 'c',
      assets: [
        { kind: 'image', key: 'c-cached', url: 'c-cached.png' },
        { kind: 'atlas', key: 'c-atlas', textureUrl: 'c.webp', atlasUrl: 'c.json' },
        { kind: 'json', key: 'c-data', url: 'c-data.json' },
      ],
    };
    const f = setup([group]);
    f.textures.set('c-cached', { source: [{ width: 64, height: 64 }] });
    expect(f.residency.prefetch(['c'])).toEqual(['c']);
    await Promise.resolve();
    await Promise.resolve();
    expect(f.queue.map((file) => file.key)).toEqual(['c-atlas', 'c-data']);
    f.queue.shift();
    f.load.emit('loaderror', { key: 'c-atlas' });
    await f.flush(); // c-data lands after the group failed
    expect(f.caches.json.has('c-data')).toBe(false);
    expect(f.textures.has('c-cached')).toBe(true);
    expect(f.residency.snapshot().groups).toEqual([]);
    f.failing.add('c-data');
    const claim = f.residency.claim('screen', ['c']);
    await f.flush();
    await expect(claim).rejects.toThrow(/c-data/);
    expect(f.textures.has('c-cached')).toBe(true);
    expect(f.textures.has('c-atlas')).toBe(false);
  });

  it('claimForScene with an already-aborted signal registers no scene hooks', async () => {
    const f = setup([set('a')]);
    const s = f.scene('Level');
    const abort = new AbortController();
    abort.abort(new Error('gone'));
    await expect(f.residency.claimForScene(s.scene, ['a'], { signal: abort.signal })).rejects.toThrow('gone');
    expect(s.events.listenerCount('shutdown')).toBe(0);
  });

  it('treats audio the device cannot play as resident with 0 bytes and reports it in the snapshot', async () => {
    const voice: PhaserResidencyGroup = {
      id: 'voice',
      assets: [
        { kind: 'audio', key: 'voice-line', urls: ['line.ogg', 'line.m4a?v=2'] },
        { kind: 'json', key: 'voice-cues', url: 'cues.json' },
      ],
    };
    const f = setup([voice], {}, { audio: { device: { webAudio: true, audioData: true, ogg: false, m4a: false, mp3: true } } });
    for (let round = 0; round < 2; round += 1) {
      const claim = f.residency.claim('screen', ['voice']);
      await f.flush();
      await expect(claim).resolves.toBeUndefined();
    }
    expect(f.log.filter((line) => line.startsWith('queue'))).toEqual(['queue voice-cues']);
    expect(f.residency.isResident(['voice'])).toBe(true);
    expect(f.residency.snapshot().groups[0]).toMatchObject({ bytes: 0, skippedAudio: ['voice-line'] });
  });

  it('treats audio as skipped when the game disables sound, and loads it when one URL is playable', async () => {
    const voice: PhaserResidencyGroup = { id: 'voice', assets: [{ kind: 'audio', key: 'voice-line', urls: ['line.ogg'] }] };
    const muted = setup([voice], {}, { audio: { noAudio: true } });
    await muted.residency.claim('screen', ['voice']);
    expect(muted.queue).toEqual([]);
    expect(muted.residency.snapshot().groups[0]?.skippedAudio).toEqual(['voice-line']);
    const noBackend = setup([voice], {}, { audio: { device: { webAudio: false, audioData: false, ogg: true } } });
    await noBackend.residency.claim('screen', ['voice']);
    expect(noBackend.residency.isResident(['voice'])).toBe(true);
    const playable = setup(
      [{ id: 'voice', assets: [{ kind: 'audio', key: 'voice-line', urls: ['line.ogg', 'LINE.MP3'] }] }],
      {},
      { audio: { device: { webAudio: true, audioData: true, ogg: false, mp3: true } } },
    );
    const claim = playable.residency.claim('screen', ['voice']);
    await playable.flush();
    await claim;
    expect(playable.log).toContain('queue voice-line');
    expect(playable.residency.snapshot().groups[0]).toMatchObject({ bytes: 48_000 * 2 * 4, skippedAudio: [] });
  });

  it('rejects unknown groups and empty owners', async () => {
    const f = setup([set('a')]);
    await expect(f.residency.claim('screen', ['nope'])).rejects.toThrow(/Unknown residency group/);
    await expect(f.residency.claim('', ['a'])).rejects.toThrow(/owner/);
  });
});

describe('residency group catalog', () => {
  it('validates ids, asset keys, dependencies and estimates', () => {
    expect(() => definePhaserResidencyGroups([set('a'), set('a')])).toThrow(/Duplicate/);
    expect(() => definePhaserResidencyGroups([set('a'), { id: 'b', assets: [{ kind: 'json', key: 'a-data', url: 'x.json' }] }])).toThrow(
      /a-data/,
    );
    expect(() => definePhaserResidencyGroups([set('a', { dependsOn: ['missing'] })])).toThrow(
      /unknown group/,
    );
    expect(() => definePhaserResidencyGroups([set('a', { dependsOn: ['b'] }), set('b', { dependsOn: ['a'] })])).toThrow(
      /cycle/,
    );
    expect(() => definePhaserResidencyGroups([set('a', { estimateBytes: -1 })])).toThrow(RangeError);
    const groups = definePhaserResidencyGroups([set('a'), set('b', { dependsOn: ['a'] })]);
    expect(groups.map((group) => group.id)).toEqual(['a', 'b']);
  });
});
