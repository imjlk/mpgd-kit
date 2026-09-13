import { describe, expect, it, vi } from 'vitest';

import { createPackLeases, type PreparedImage } from '../src/leases.js';
import { planImages, type AssetPack } from '../src/packs.js';

const image = { id: 'image', path: 'packs/image.svg', mediaType: 'image/svg+xml', sha256: 'a'.repeat(64), bytes: 8, width: 2, height: 2 };
const catalog: AssetPack[] = [
  { id: 'shared', revision: 'shared-v1', dependsOn: [], images: [image] },
  { id: 'grove', revision: 'grove-v1', dependsOn: ['shared'], images: [image] },
  { id: 'dunes', revision: 'dunes-v1', dependsOn: ['shared'], images: [image] },
];
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const resource = (textureKey: string) => ({ textureKey, dispose: vi.fn() });
const turn = async () => { await Promise.resolve(); await Promise.resolve(); };

describe('private pack planning', () => {
  it('resolves dependencies once, before theme images', () => {
    const tree = [...catalog, { id: 'both', revision: 'v1', dependsOn: ['grove', 'dunes'], images: [] }];
    expect(planImages(tree, 'both').map((asset) => asset.packId)).toEqual(['shared', 'grove', 'dunes']);
  });
  it('rejects missing, cyclic and duplicate descriptions', () => {
    expect(() => planImages(catalog, 'missing')).toThrow('Unknown pack');
    expect(() => planImages([...catalog, catalog[0]!], 'grove')).toThrow('Duplicate pack');
    expect(() => planImages([{ ...catalog[0]!, dependsOn: ['grove'] }, catalog[1]!], 'grove')).toThrow('Cyclic');
    expect(() => planImages([{ ...catalog[0]!, images: [image, image] }], 'shared')).toThrow('Duplicate image');
  });
});

describe('resident ownership and preparation', () => {
  it('deduplicates concurrent shared images and frees only the last owner', async () => {
    const resources = new Map<string, ReturnType<typeof resource>>();
    const prepare = vi.fn(async (asset) => {
      const value = resource(asset.packId);
      resources.set(asset.packId, value);
      return value;
    });
    const packs = createPackLeases(catalog, prepare);
    const [grove, dunes] = await Promise.all([packs.acquire('grove'), packs.acquire('dunes')]);
    expect(prepare).toHaveBeenCalledTimes(3);
    expect(packs.snapshot().find((asset) => asset.pack === 'shared')?.owners).toBe(2);
    grove.release();
    grove.release();
    expect(resources.get('grove')!.dispose).toHaveBeenCalledTimes(1);
    expect(resources.get('shared')!.dispose).not.toHaveBeenCalled();
    expect(dunes.textures.get('shared/image')).toBe('shared');
    dunes.release();
    expect(resources.get('shared')!.dispose).toHaveBeenCalledTimes(1);
    expect(packs.snapshot()).toEqual([]);
  });

  it('cancels one waiter without cancelling a shared preparation', async () => {
    const job = deferred<PreparedImage>();
    let sharedSignal: AbortSignal | undefined;
    const prepare = vi.fn(async (_asset, signal) => { sharedSignal = signal; return job.promise; });
    const packs = createPackLeases(catalog, prepare);
    const abort = new AbortController();
    const one = packs.acquire('shared', { signal: abort.signal });
    const rejected = expect(one).rejects.toMatchObject({ name: 'AbortError' });
    const two = packs.acquire('shared');
    await turn();
    abort.abort();
    await rejected;
    expect(sharedSignal!.aborted).toBe(false);
    const value = resource('shared');
    job.resolve(value);
    const lease = await two;
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(value.dispose).not.toHaveBeenCalled();
    lease.release();
    expect(value.dispose).toHaveBeenCalledTimes(1);
  });

  it('releases cancelled claims synchronously and cleans a non-cancellable late decoder', async () => {
    const jobs = [deferred<PreparedImage>(), deferred<PreparedImage>()];
    const prepare = vi.fn().mockImplementationOnce(() => jobs[0]!.promise).mockImplementationOnce(() => jobs[1]!.promise);
    const packs = createPackLeases(catalog, prepare);
    const abort = new AbortController();
    const first = packs.acquire('shared', { signal: abort.signal });
    const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await turn();
    abort.abort();
    expect(packs.snapshot()).toEqual([]);
    await rejected;
    const second = packs.acquire('shared');
    await turn();
    const old = resource('old-generation');
    jobs[0]!.resolve(old);
    await turn();
    const current = resource('current-generation');
    jobs[1]!.resolve(current);
    const lease = await second;
    expect(old.dispose).toHaveBeenCalledTimes(1);
    expect(current.dispose).not.toHaveBeenCalled();
    expect(packs.snapshot()).toHaveLength(1);
    lease.release();
    expect(current.dispose).toHaveBeenCalledTimes(1);
  });

  it('rolls back partial failures without evicting an existing level, then retries', async () => {
    const shared = resource('shared');
    const grove = resource('grove');
    let fail = true;
    const packs = createPackLeases(catalog, async (asset) => {
      if (asset.packId === 'dunes' && fail) throw new Error('Missing theme');
      return asset.packId === 'shared' ? shared : asset.packId === 'grove' ? grove : resource('dunes');
    });
    const first = await packs.acquire('grove');
    await expect(packs.acquire('dunes')).rejects.toThrow('Missing theme');
    expect(packs.snapshot().map((entry) => entry.pack).sort()).toEqual(['grove', 'shared']);
    expect(shared.dispose).not.toHaveBeenCalled();
    fail = false;
    const second = await packs.acquire('dunes');
    first.release();
    expect(shared.dispose).not.toHaveBeenCalled();
    second.release();
    expect(shared.dispose).toHaveBeenCalledTimes(1);
  });

  it('reports readiness only after preparation and never starts pre-aborted work', async () => {
    const job = deferred<PreparedImage>();
    const prepare = vi.fn(() => job.promise);
    const packs = createPackLeases(catalog, prepare);
    const abort = new AbortController();
    abort.abort();
    await expect(packs.acquire('shared', { signal: abort.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(prepare).not.toHaveBeenCalled();
    const progress = vi.fn();
    const waiting = packs.acquire('shared', { progress });
    await turn();
    expect(progress.mock.calls).toEqual([[0, 1]]);
    job.resolve(resource('ready'));
    const lease = await waiting;
    expect(progress.mock.calls).toEqual([[0, 1], [1, 1]]);
    lease.release();
  });

  it('pins catalog contents and releases work when a progress observer throws', async () => {
    const mutable = structuredClone(catalog);
    const value = resource('ready');
    const packs = createPackLeases(mutable, async () => value);
    mutable[0] = { ...mutable[0]!, revision: 'new-revision' };
    const lease = await packs.acquire('shared');
    expect(packs.snapshot()[0]!.identity).toContain('/shared-v1/');
    lease.release();
    const prepared = resource('next');
    const other = createPackLeases(catalog, async () => prepared);
    await expect(other.acquire('shared', { progress(ready) { if (ready) throw new Error('observer'); } })).rejects.toThrow('observer');
    expect(prepared.dispose).toHaveBeenCalledTimes(1);
    expect(other.snapshot()).toEqual([]);
  });
});
