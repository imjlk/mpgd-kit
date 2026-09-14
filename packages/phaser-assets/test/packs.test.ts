import { EventEmitter } from 'node:events';

import type Phaser from 'phaser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createPhaserAssetPackLoader,
  definePhaserAssetPacks,
  type PhaserAssetPack,
} from '../src/packs.js';

const catalog: readonly PhaserAssetPack[] = [
  { id: 'shared', revision: '1', assets: [{ kind: 'image', key: 'pilot', url: '/pilot.png' }] },
  {
    id: 'grove',
    revision: '1',
    dependsOn: ['shared'],
    assets: [{ kind: 'image', key: 'ground', url: '/grove.png' }],
  },
  {
    id: 'dunes',
    revision: '1',
    dependsOn: ['shared'],
    assets: [{ kind: 'image', key: 'ground', url: '/dunes.png' }],
  },
];
let decode: () => Promise<void>;
let images: { src: string }[];
function fixture() {
  const values = new Map<string, unknown>();
  const events = new EventEmitter();
  const remove = vi.fn((key: string) => values.delete(key));
  const add = vi.fn((key: string) => {
    const texture = { frameTotal: 2 };
    values.set(key, texture);
    return texture;
  });
  const scene = {
    events,
    textures: { exists: (key: string) => values.has(key), remove, addImage: add, addAtlas: add, addSpriteSheet: add },
  } as unknown as Phaser.Scene;
  return { scene, events, values, remove, add };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
beforeEach(() => {
  decode = async () => {};
  images = [];
  vi.stubGlobal('Image', class {
    src = ''; naturalWidth = 16; naturalHeight = 16;
    constructor() {
      images.push(this); }
    decode() {
      return decode(); }
  });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/png' } })));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('pack contract and ownership', () => {
  it('validates the whole graph, including unused invalid packs and verification metadata', () => {
    expect(() => definePhaserAssetPacks([...catalog, catalog[0]!])).toThrow('duplicate pack');
    expect(() => definePhaserAssetPacks([{ ...catalog[0]!, dependsOn: ['missing'] }])).toThrow(
      'Unknown pack',
    );
    expect(() => definePhaserAssetPacks([{ ...catalog[0]!, dependsOn: ['shared'] }])).toThrow(
      'Cyclic',
    );
    expect(() => definePhaserAssetPacks([{ ...catalog[0]!, assets: [catalog[0]!.assets[0]!, catalog[0]!.assets[0]!] }])).toThrow(
      'duplicate asset',
    );
    expect(() => definePhaserAssetPacks([{ ...catalog[0]!, assets: [{ ...catalog[0]!.assets[0]!, integrity: { texture: { bytes: 1, sha256: 'bad' } } }] }])).toThrow(
      'Invalid integrity',
    );
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
    const one = loader.acquire('shared', { signal: cancel.signal });
    const rejected = expect(one).rejects.toMatchObject({ name: 'AbortError' });
    const two = loader.acquire('shared');
    cancel.abort();
    await rejected;
    gate.resolve();
    const lease = await two;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(f.values.has(lease.key('shared', 'pilot'))).toBe(true);
    const duringProgress = new AbortController();
    await expect(loader.acquire('shared', { signal: duringProgress.signal, onProgress(n) {
        if (n) {
duringProgress.abort();
} } })).rejects.toMatchObject({ name: 'AbortError' });
    expect(loader.snapshot()[0]?.owners).toBe(1);
    lease.release();
    loader.dispose();
  });
  it('times out a stuck decoder, revokes its URL, and allows an immediate retry', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const gate = deferred<void>();
    const started = deferred<void>();
    decode = () => {
      started.resolve();
      return gate.promise; };
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    const loader = createPhaserAssetPackLoader(f.scene, catalog, { timeoutMs: 30 });
    const failed = expect(loader.acquire('shared')).rejects.toThrow('timed out');
    await started.promise;
    await vi.advanceTimersByTimeAsync(30);
    await failed;
    expect(loader.snapshot()).toEqual([]);
    expect(revoke).toHaveBeenCalledOnce();
    expect(images[0]!.src).toBe('');
    decode = async () => {};
    const next = await loader.acquire('shared');
    gate.resolve();
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
    vi.mocked(fetch).mockImplementation(
      async (url) => new Response(new Uint8Array([1]), {
        status: String(url).includes('dunes') ? 404 : 200,
      }),
    );
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
    const loader = createPhaserAssetPackLoader(f.scene, mutable, { resolveURL });
    mutable[0] = { ...mutable[0]!, assets: [] };
    const lease = await loader.acquire('shared');
    expect(resolveURL).toHaveBeenCalledWith('/pilot.png', { packId: 'shared', revision: '1' });
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
    await expect(loader.acquire('grove', { onProgress(n) {
        if (n) {
throw new Error('observer');
} } })).rejects.toThrow('observer');
    expect(f.values.size).toBe(0);
    expect(loader.snapshot()).toEqual([]);
    loader.dispose();
  });
});
