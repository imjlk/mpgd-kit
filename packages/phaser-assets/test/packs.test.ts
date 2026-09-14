import { EventEmitter } from 'node:events';

import type Phaser from 'phaser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createPhaserAssetPackLoader,
  definePhaserAssetPacks,
  type PhaserAssetPack,
} from '../src/packs.js';
const catalog: readonly PhaserAssetPack[] = [
  {
    id: 'shared', revision: '1', assets: [{
      kind: 'image', key: 'pilot', url: '/pilot.png',
    }],
  },
  {
    id: 'grove',
    revision: '1',
    dependsOn: ['shared'],
    assets: [{
      kind: 'image', key: 'ground', url: '/grove.png',
    }],
  },
  {
    id: 'dunes',
    revision: '1',
    dependsOn: ['shared'],
    assets: [{
      kind: 'image', key: 'ground', url: '/dunes.png',
    }],
  },
];
let decode: () => Promise<void>;
let images: {
  src: string;
}[];
function fixture() {
  const values = new Map<string, unknown>();
  const events = new EventEmitter();
  const remove = vi.fn((key: string) => values.delete(key));
  const add = vi.fn((key: string) => {
    const texture = {
      frameTotal: 2,
    };
    values.set(key, texture);
    return texture;
  });
  const scene = {
    events,
    textures: {
      exists: (key: string) => values.has(key), remove, addImage: add, addAtlas: add, addSpriteSheet: add,
    },
  } as unknown as Phaser.Scene;
  return {
    scene,
    events,
    values,
    remove,
    add,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return {
    promise,
    resolve,
  };
}
beforeEach(() => {
  decode = async () => {
  };
  images = [];
  vi.stubGlobal('Image', class {
    src = '';
    naturalWidth = 16;
    naturalHeight = 16;
    constructor() {
      images.push(this);
    }
    decode() {
      return decode();
    }
  });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), {
    headers: {
      'Content-Type': 'image/png',
    },
  })));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe('pack contract and ownership', () => {
  it('validates the whole graph, including unused invalid packs and verification metadata', () => {
    expect(() => definePhaserAssetPacks([...catalog, catalog[0]!])).toThrow('duplicate pack');
    expect(() => definePhaserAssetPacks([{
      ...catalog[0]!, dependsOn: ['missing'],
    }])).toThrow('Unknown pack');
    expect(() => definePhaserAssetPacks([{
      ...catalog[0]!, dependsOn: ['shared'],
    }])).toThrow('Cyclic');
    expect(() => definePhaserAssetPacks([{
      ...catalog[0]!, assets: [catalog[0]!.assets[0]!, catalog[0]!.assets[0]!],
    }])).toThrow('duplicate asset');
    expect(() => definePhaserAssetPacks([{
      ...catalog[0]!, assets: [{
        ...catalog[0]!.assets[0]!, integrity: {
          texture: {
            bytes: 1, sha256: 'bad',
          },
        },
      }],
    }])).toThrow('Invalid integrity');
  });
  it('shares concurrent dependencies and keeps keys valid until the last owner releases', async () => {
    const f = fixture();
    const loader = createPhaserAssetPackLoader(f.scene, catalog);
    const [grove, dunes] = await Promise.all([loader.acquire('grove'), loader.acquire('dunes')]);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(grove.key('shared', 'pilot')).toBe(dunes.key('shared', 'pilot'));
    const shared = dunes.key('shared', 'pilot');
    grove.release();
    grove.release();
    expect(f.values.has(shared)).toBe(true);
    expect(() => grove.key('shared', 'pilot')).toThrow('released');
    expect(() => dunes.key('grove', 'ground')).toThrow('not in this lease');
    dunes.release();
    expect(f.values.size).toBe(0);
    expect(loader.snapshot()).toEqual([]);
    loader.dispose();
    expect(f.events.listenerCount('shutdown')).toBe(0);
  });
  it('cancels one waiter without aborting another, including cancellation from progress', async () => {
    const f = fixture();
    const gate = deferred<void>();
    decode = () => gate.promise;
    const loader = createPhaserAssetPackLoader(f.scene, catalog);
    const cancel = new AbortController();
    const one = loader.acquire('shared', {
      signal: cancel.signal,
    });
    const rejected = expect(one).rejects.toMatchObject({
      name: 'AbortError',
    });
    const two = loader.acquire('shared');
    cancel.abort();
    await rejected;
    gate.resolve();
    const lease = await two;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(f.values.has(lease.key('shared', 'pilot'))).toBe(true);
    const duringProgress = new AbortController();
    await expect(loader.acquire('shared', {
      signal: duringProgress.signal, onProgress(n) {
        if (n) {
          duringProgress.abort();
        }
      },
    })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(loader.snapshot()[0]?.owners).toBe(1);
    lease.release();
    loader.dispose();
  });
  it('times out a stuck decoder, revokes its URL, and admits a retry after native decode settles', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const gate = deferred<void>();
    const started = deferred<void>();
    decode = () => {
      started.resolve();
      return gate.promise;
    };
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    const loader = createPhaserAssetPackLoader(f.scene, catalog, {
      timeoutMs: 30,
    });
    const failed = expect(loader.acquire('shared')).rejects.toThrow('timed out');
    await started.promise;
    await vi.advanceTimersByTimeAsync(30);
    await failed;
    expect(loader.snapshot()).toEqual([]);
    expect(revoke).toHaveBeenCalledOnce();
    expect(images[0]!.src).toBe('');
    decode = async () => {
    };
    const retry = loader.acquire('shared');
    gate.resolve();
    const next = await retry;
    await Promise.resolve();
    expect(f.values.size).toBe(1);
    expect(f.values.has(next.key('shared', 'pilot'))).toBe(true);
    next.release();
    loader.dispose();
  });
  it('rolls back a failed transition while preserving a previously held level', async () => {
    const f = fixture();
    const loader = createPhaserAssetPackLoader(f.scene, catalog);
    const old = await loader.acquire('grove');
    vi.mocked(fetch).mockImplementation(async (url) => new Response(new Uint8Array([1]), {
      status: String(url).includes('dunes') ? 404 : 200,
    }));
    await expect(loader.acquire('dunes')).rejects.toThrow('HTTP 404');
    expect(loader.snapshot().map((entry) => entry.packId).sort()).toEqual(['grove', 'shared']);
    expect(f.values.has(old.key('shared', 'pilot'))).toBe(true);
    old.release();
    loader.dispose();
  });
  it('pins metadata, resolves URLs with pack context, and keeps scene.load untouched', async () => {
    const f = fixture();
    const mutable = structuredClone(catalog) as PhaserAssetPack[];
    const resolveURL = vi.fn((url: string) => `https://cdn.example${url}`);
    const loader = createPhaserAssetPackLoader(f.scene, mutable, {
      resolveURL,
    });
    mutable[0] = {
      ...mutable[0]!, assets: [],
    };
    const lease = await loader.acquire('shared');
    expect(resolveURL).toHaveBeenCalledWith('/pilot.png', {
      packId: 'shared', revision: '1',
    });
    expect(f.values.size).toBe(1);
    lease.release();
    loader.dispose();
  });
  it('releases resources on scene shutdown and rejects future use of the loader/lease', async () => {
    const f = fixture();
    const loader = createPhaserAssetPackLoader(f.scene, catalog);
    const lease = await loader.acquire('shared');
    f.events.emit('shutdown');
    expect(f.values.size).toBe(0);
    expect(() => lease.key('shared', 'pilot')).toThrow('released');
    await expect(loader.acquire('shared')).rejects.toThrow('disposed');
    lease.release();
    loader.dispose();
  });
  it('does not leave textures behind when a readiness observer throws', async () => {
    const f = fixture();
    const loader = createPhaserAssetPackLoader(f.scene, catalog);
    await expect(loader.acquire('grove', {
      onProgress(n) {
        if (n) {
          throw new Error('observer');
        }
      },
    })).rejects.toThrow('observer');
    expect(f.values.size).toBe(0);
    expect(loader.snapshot()).toEqual([]);
    loader.dispose();
  });
});
it.each([undefined, null, {
  frameWidth: 0,
}, {
    frameWidth: 16, frameHeight: 0,
  }])('rejects malformed spritesheet config before fetching', (frameConfig) => {
    const f = fixture();
    const packs = [{
      id: 'bad', revision: '1', assets: [{
        kind: 'spritesheet', key: 'hero', url: '/hero.png', frameConfig,
      }],
    }] as unknown as PhaserAssetPack[];
    expect(() => createPhaserAssetPackLoader(f.scene, packs)).toThrow('Invalid spritesheet frame size');
    expect(fetch).not.toHaveBeenCalled();
    expect(f.events.listenerCount('shutdown')).toBe(0);
  });
it('accepts explicitly undefined optional integrity and rejects malformed values clearly', async () => {
  const f = fixture();
  const optional = [{
    ...catalog[0]!, assets: [{
      ...catalog[0]!.assets[0]!, integrity: {
        texture: undefined,
        atlas: undefined,
      },
    }],
  }] as unknown as PhaserAssetPack[];
  const loader = createPhaserAssetPackLoader(f.scene, optional);
  const lease = await loader.acquire('shared');
  expect(fetch).toHaveBeenCalledWith('/pilot.png', expect.objectContaining({
    cache: 'no-store',
  }));
  lease.release();
  loader.dispose();
  for (const texture of [null, 'bad', {
    bytes: 3, sha256: 123,
  }]) {
    const bad = [{
      ...catalog[0]!, assets: [{
        ...catalog[0]!.assets[0]!, integrity: {
          texture,
        },
      }],
    }] as unknown as PhaserAssetPack[];
    expect(() => definePhaserAssetPacks(bad)).toThrow('Invalid integrity');
  }
});
it.each(['default', 'reload'] as const)('passes an explicit HTTP cache policy to the transport', async (requestCache) => {
  const f = fixture();
  const loader = createPhaserAssetPackLoader(f.scene, catalog, {
    requestCache,
  });
  const lease = await loader.acquire('shared');
  expect(fetch).toHaveBeenCalledWith('/pilot.png', expect.objectContaining({
    cache: requestCache,
  }));
  lease.release();
  loader.dispose();
});
it('rejects unsupported HTTP cache policies without fetching', () => {
  const f = fixture();
  expect(() => createPhaserAssetPackLoader(f.scene, catalog, {
    requestCache: 'only-if-cached' as 'default',
  })).toThrow('HTTP cache policy');
  expect(fetch).not.toHaveBeenCalled();
});
it('reports zero image dimensions without suggesting a larger pixel budget', async () => {
  const f = fixture();
  vi.stubGlobal('Image', class {
    src = '';
    naturalWidth = 0;
    naturalHeight = 0;
    async decode() {
    }
  });
  const loader = createPhaserAssetPackLoader(f.scene, catalog);
  await expect(loader.acquire('shared')).rejects.toThrow('has no dimensions');
  expect(f.add).not.toHaveBeenCalled();
  loader.dispose();
});

describe('failure isolation and bounded preparation', () => {
  it.each([0, 1])('returns every owner when disposer %i throws', async (index) => {
    const f = fixture();
    const all = [...catalog, { id: 'all', revision: '1', dependsOn: ['grove', 'dunes'], assets: [] }];
    const loader = createPhaserAssetPackLoader(f.scene, all);
    const lease = await loader.acquire('all');
    const broken = [...f.values.keys()][index];
    f.remove.mockImplementation((key) => {
      if (key === broken) {
        throw new Error('engine cleanup');
      }
      return f.values.delete(key);
    });
    expect(() => lease.release()).not.toThrow();
    expect(f.remove).toHaveBeenCalledTimes(3);
    expect(loader.snapshot()).toEqual([]);
    expect(images.every((image) => image.src === '')).toBe(true);
    expect(loader.takeCleanupErrors()).toHaveLength(1);
    expect(loader.takeCleanupErrors()).toEqual([]);
    lease.release();
    expect(f.remove).toHaveBeenCalledTimes(3);
    loader.dispose();
  });
  it('preserves another owner when cleanup of an unrelated texture fails', async () => {
    const f = fixture();
    const loader = createPhaserAssetPackLoader(f.scene, catalog);
    const grove = await loader.acquire('grove');
    const dunes = await loader.acquire('dunes');
    const broken = grove.key('grove', 'ground');
    f.remove.mockImplementation((key) => {
      if (key === broken) {
        throw new Error('engine cleanup');
      }
      return f.values.delete(key);
    });
    grove.release();
    expect(f.values.has(dunes.key('shared', 'pilot'))).toBe(true);
    expect(loader.snapshot().every((entry) => entry.owners === 1)).toBe(true);
    loader.dispose();
    expect(loader.snapshot()).toEqual([]);
    expect(loader.takeCleanupErrors()).toHaveLength(1);
  });
  it('settles cancellation even when a ready resource cannot be disposed', async () => {
    const f = fixture();
    const loader = createPhaserAssetPackLoader(f.scene, catalog);
    f.remove.mockImplementation(() => {
      throw new Error('engine cleanup');
    });
    const cancel = new AbortController();
    await expect(loader.acquire('grove', {
      signal: cancel.signal, onProgress(ready) {
        if (ready === 1) {
          cancel.abort();
        }
      },
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(loader.snapshot()).toEqual([]);
    expect(loader.takeCleanupErrors().length).toBeGreaterThan(0);
    loader.dispose();
  });
  it.each(['download', 'decode'])('rejects shutdown during %s and discards late completion', async (stage) => {
    const f = fixture();
    const started = deferred<void>();
    const gate = deferred<void>();
    if (stage === 'download') {
      vi.mocked(fetch).mockImplementation(async () => {
        started.resolve();
        await gate.promise;
        return new Response(new Uint8Array([1]));
      });
    } else {
      decode = () => {
        started.resolve();
        return gate.promise;
      };
    }
    const loader = createPhaserAssetPackLoader(f.scene, catalog);
    const failed = expect(loader.acquire('shared')).rejects.toMatchObject({ name: 'AbortError' });
    await started.promise;
    f.events.emit('shutdown');
    await failed;
    expect(loader.snapshot()).toEqual([]);
    expect(images.every((image) => image.src === '')).toBe(true);
    gate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.add).not.toHaveBeenCalled();
    await expect(loader.acquire('shared')).rejects.toThrow('disposed');
  });
  it('limits downloads independently and never starts a cancelled queued request', async () => {
    const f = fixture();
    const started = deferred<void>();
    const gate = deferred<void>();
    vi.mocked(fetch).mockImplementation(async () => {
      started.resolve();
      await gate.promise;
      return new Response(new Uint8Array([1]));
    });
    const loader = createPhaserAssetPackLoader(f.scene, catalog, { maxConcurrentDownloads: 1 });
    const one = loader.acquire('shared');
    await started.promise;
    const cancel = new AbortController();
    const cancelled = expect(loader.acquire('grove', { signal: cancel.signal })).rejects.toMatchObject({ name: 'AbortError' });
    cancel.abort();
    await cancelled;
    expect(fetch).toHaveBeenCalledTimes(1);
    gate.resolve();
    (await one).release();
    loader.dispose();
  });
  it('reserves bytes before download and holds decode slots through native cancellation', async () => {
    const f = fixture();
    const gate = deferred<void>();
    const started = deferred<void>();
    let calls = 0;
    decode = () => {
      if (++calls === 1) {
        started.resolve();
        return gate.promise;
      }
      return Promise.resolve();
    };
    const loader = createPhaserAssetPackLoader(f.scene, catalog, {
      maxFileBytes: 3, maxBufferedBytes: 3, maxConcurrentDownloads: 3, maxConcurrentDecodes: 1,
    });
    const cancel = new AbortController();
    const first = expect(loader.acquire('shared', { signal: cancel.signal })).rejects.toMatchObject({ name: 'AbortError' });
    await started.promise;
    cancel.abort();
    await first;
    const next = loader.acquire('dunes');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(calls).toBe(1);
    gate.resolve();
    (await next).release();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(calls).toBe(3);
    loader.dispose();
  });
  it('includes queue waiting in the preparation deadline and rejects oversized reservations before fetch', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const gate = deferred<void>();
    const started = deferred<void>();
    decode = () => {
      started.resolve();
      return gate.promise;
    };
    const loader = createPhaserAssetPackLoader(f.scene, catalog, { timeoutMs: 30, maxFileBytes: 3, maxBufferedBytes: 3 });
    const failed = expect(loader.acquire('grove')).rejects.toThrow('timed out');
    await started.promise;
    await vi.advanceTimersByTimeAsync(30);
    await failed;
    expect(fetch).toHaveBeenCalledTimes(1);
    gate.resolve();
    loader.dispose();
    const tiny = createPhaserAssetPackLoader(f.scene, catalog, { maxFileBytes: 3, maxBufferedBytes: 2 });
    await expect(tiny.acquire('shared')).rejects.toThrow('buffered byte limit');
    expect(fetch).toHaveBeenCalledTimes(1);
    tiny.dispose();
  });
});

it('limits decode independently when all downloads fit in the byte budget', async () => {
  const f = fixture();
  const gates = [deferred<void>(), deferred<void>(), deferred<void>()];
  const started = deferred<void>();
  let calls = 0;
  decode = () => {
    const gate = gates[calls++];
    started.resolve();
    return gate?.promise ?? Promise.resolve();
  };
  const all = [...catalog, { id: 'all', revision: '1', dependsOn: ['grove', 'dunes'], assets: [] }];
  const loader = createPhaserAssetPackLoader(f.scene, all, { maxFileBytes: 3, maxBufferedBytes: 9, maxConcurrentDownloads: 3, maxConcurrentDecodes: 1 });
  const work = loader.acquire('all');
  await started.promise;
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(calls).toBe(1);
  gates[0]?.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(calls).toBe(2);
  gates[1]?.resolve();
  gates[2]?.resolve();
  (await work).release();
  expect(calls).toBe(3);
  loader.dispose();
});

it('rejects misspelled and inapplicable integrity fields before starting work', () => {
  for (const field of ['textrue', 'atlas']) {
    expect(() => definePhaserAssetPacks([{ id: 'bad', revision: '1', assets: [{
      kind: 'image', key: 'image', url: '/image', integrity: { [field]: { bytes: 3, sha256: '0'.repeat(64) } },
    }] }] as readonly PhaserAssetPack[])).toThrow('Unknown or inapplicable integrity entry');
  }
});

it('identifies an atlas that cannot fit its reservation without rejecting smaller catalogs', async () => {
  const f = fixture();
  const loader = createPhaserAssetPackLoader(f.scene, [{ id: 'atlas-pack', revision: '1', assets: [{ kind: 'atlas', key: 'terrain', textureUrl: '/image', atlasUrl: '/json' }] }], { maxFileBytes: 8, maxBufferedBytes: 8 });
  await expect(loader.acquire('atlas-pack')).rejects.toThrow('Asset atlas-pack/terrain reservation 16 exceeds buffered byte limit 8');
  expect(fetch).not.toHaveBeenCalled();
  loader.dispose();
});
