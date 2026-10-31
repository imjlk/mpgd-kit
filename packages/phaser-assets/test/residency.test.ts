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

/** Minimal game: texture manager, caches, sound, scene manager and a manually flushed loader. */
function fixture(settings: { deferHost?: boolean; sizes?: Record<string, [number, number]> } = {}) {
  const log: string[] = [];
  const textures = new Map<string, { source: { width: number; height: number }[] }>();
  const caches = {
    json: new Map<string, unknown>(),
    binary: new Map<string, unknown>(),
    audio: new Map<string, unknown>(),
  };
  const failing = new Set<string>();
  const queue: { key: string; kind: Kind }[] = [];
  const loadEvents = new EventEmitter();
  let loading = false;
  const enqueue = (key: string, kind: Kind): void => {
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
    expect(() => f.residency.claim('screen', ['a'])).toThrow(/disposed/);
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
