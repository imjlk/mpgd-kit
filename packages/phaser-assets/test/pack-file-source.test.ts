import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

import type Phaser from 'phaser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PhaserPackCacheEvent, PhaserPackPersistentCache } from '../src/pack-cache.js';
import { createPackUrlFileSource } from '../src/pack-file-source.js';
import {
  createPhaserAssetPackLoader,
  type PhaserAssetPack,
  type PhaserPackAsset,
  type PhaserPackFileBody,
  type PhaserPackFileContext,
  type PhaserPackFileRequest,
  type PhaserPackFileSource,
} from '../src/packs.js';

const png = new Uint8Array([1, 2, 3]);
const atlasJson = JSON.stringify({ frames: { ground: {} } });
const sha256 = (value: Uint8Array | string): string =>
  createHash('sha256').update(value).digest('hex');
const imageCatalog = (assets: readonly PhaserPackAsset[]): readonly PhaserAssetPack[] => [
  {
    id: 'shared',
    revision: '1',
    assets,
  },
];

interface RecordedRead {
  request: PhaserPackFileRequest;
  context: PhaserPackFileContext;
  resolveBody: (body: PhaserPackFileBody) => void;
  rejectBody: (reason: unknown) => void;
}

/** Injectable in-memory source: no HTTP, observable lifecycles, gateable reads. */
function memorySource(): PhaserPackFileSource & {
  opens: PhaserPackFileRequest[];
  contexts: PhaserPackFileContext[];
  reads: RecordedRead[];
  releases: PhaserPackFileBody[];
  closes: PhaserPackFileRequest[];
} {
  const opens: PhaserPackFileRequest[] = [];
  const contexts: PhaserPackFileContext[] = [];
  const reads: RecordedRead[] = [];
  const releases: PhaserPackFileBody[] = [];
  const closes: PhaserPackFileRequest[] = [];
  return {
    opens, contexts, reads, releases, closes,
    async open(request, context) {
      opens.push(request);
      contexts.push(context);
      return {
        read: () => new Promise<PhaserPackFileBody>((resolveBody, rejectBody) => {
          reads.push({
            request, context, resolveBody, rejectBody,
          });
        }),
        close() {
          closes.push(request);
        },
      };
    },
  };
}

/** Resolve a recorded read with fresh body bytes for its requested file. */
function serveRead(source: ReturnType<typeof memorySource>, index: number): void {
  const read = source.reads[index]!;
  const raw = read.request.url.endsWith('.json') ? atlasJson : png;
  let released = false;
  const body: PhaserPackFileBody = {
    bytes: new Blob([raw]), release() {
      if (released) {
        return;
      }
      released = true;
      source.releases.push(body);
    },
  };
  read.resolveBody(body);
}

/** Serve reads as the loader admits them, until `count` files were read.
 * With default limits only two maxFileBytes reservations fit at once, so later
 * reads appear only after earlier assets returned their bytes. */
async function serveAdmitted(source: ReturnType<typeof memorySource>, count: number): Promise<void> {
  for (let served = 0; served < count;) {
    await vi.waitFor(() => expect(source.reads.length).toBeGreaterThan(served));
    while (served < source.reads.length) {
      serveRead(source, served++);
    }
  }
}

function fixture() {
  const values = new Map<string, unknown>();
  const events = new EventEmitter();
  const scene = {
    events,
    textures: {
      exists: (key: string) => values.has(key),
      remove: (key: string) => values.delete(key),
      addImage: (key: string) => {
        const texture = { frameTotal: 1 };
        values.set(key, texture);
        return texture;
      },
      addAtlas: (key: string) => {
        const texture = { frameTotal: 2 };
        values.set(key, texture);
        return texture;
      },
      addSpriteSheet: (key: string) => {
        const texture = { frameTotal: 4 };
        values.set(key, texture);
        return texture;
      },
    },
  } as unknown as Phaser.Scene;
  return { scene, events, values };
}

beforeEach(() => {
  vi.stubGlobal('Image', class {
    src = '';
    naturalWidth = 16;
    naturalHeight = 16;
    async decode() {
    }
  });
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('injected file sources', () => {
  it('prepares image, spritesheet and atlas assets without any HTTP', async () => {
    const f = fixture();
    const source = memorySource();
    const loader = createPhaserAssetPackLoader(f.scene, imageCatalog([
      { kind: 'image', key: 'pilot', url: '/pilot.png' },
      { kind: 'spritesheet', key: 'hero', url: '/hero.png', frameConfig: { frameWidth: 16 } },
      { kind: 'atlas', key: 'terrain', textureUrl: '/terrain.png', atlasUrl: '/atlas.json' },
    ]), { fileSource: source });
    const acquiring = loader.acquire('shared');
    await serveAdmitted(source, 4);
    const lease = await acquiring;
    expect(fetch).not.toHaveBeenCalled();
    expect(f.values.size).toBe(3);
    expect(source.releases).toHaveLength(4);
    expect(source.closes).toHaveLength(4);
    lease.release();
    loader.dispose();
  });

  it('distinguishes atlas texture and metadata roles for the same asset key', async () => {
    const f = fixture();
    const source = memorySource();
    const loader = createPhaserAssetPackLoader(f.scene, imageCatalog([{
      kind: 'atlas', key: 'terrain', textureUrl: '/terrain.png', atlasUrl: '/atlas.json', integrity: {
        texture: { bytes: 3, sha256: sha256(png) },
      },
    }]), { fileSource: source });
    const acquiring = loader.acquire('shared');
    await vi.waitFor(() => expect(source.reads).toHaveLength(2));
    expect(source.opens.map((request) => [request.packId, request.revision, request.assetKey, request.role, request.url])).toEqual([
      ['shared', '1', 'terrain', 'texture', '/terrain.png'],
      ['shared', '1', 'terrain', 'atlas', '/atlas.json'],
    ]);
    expect(source.opens[0]!.integrity).toEqual({ bytes: 3, sha256: sha256(png) });
    expect(source.opens[1]!.integrity).toBeUndefined();
    serveRead(source, 0);
    serveRead(source, 1);
    await acquiring;
    loader.dispose();
  });

  it('opens every file before byte admission gates the reads', async () => {
    const f = fixture();
    const source = memorySource();
    // Default limits admit two maxFileBytes reservations; the third asset must
    // still acquire source ownership while it waits for admission.
    const loader = createPhaserAssetPackLoader(f.scene, [
      { id: 'one', revision: '1', assets: [{ kind: 'image', key: 'a', url: '/a.png' }] },
      { id: 'two', revision: '1', assets: [{ kind: 'image', key: 'b', url: '/b.png' }] },
      { id: 'three', revision: '1', assets: [{ kind: 'image', key: 'c', url: '/c.png' }] },
    ], { fileSource: source });
    const all = Promise.all([loader.acquire('one'), loader.acquire('two'), loader.acquire('three')]);
    await vi.waitFor(() => expect(source.opens).toHaveLength(3));
    expect(source.reads.length).toBeLessThanOrEqual(2);
    await serveAdmitted(source, 3);
    const leases = await all;
    expect(f.values.size).toBe(3);
    for (const lease of leases) {
      lease.release();
    }
    loader.dispose();
  });

  it('shares dependencies and reads each file once for concurrent owners', async () => {
    const f = fixture();
    const source = memorySource();
    const loader = createPhaserAssetPackLoader(f.scene, [
      { id: 'shared', revision: '1', assets: [{ kind: 'image', key: 'pilot', url: '/pilot.png' }] },
      { id: 'grove', revision: '1', dependsOn: ['shared'], assets: [{ kind: 'image', key: 'ground', url: '/grove.png' }] },
      { id: 'dunes', revision: '1', dependsOn: ['shared'], assets: [{ kind: 'image', key: 'ground', url: '/dunes.png' }] },
    ], { fileSource: source });
    const both = Promise.all([loader.acquire('grove'), loader.acquire('dunes')]);
    await serveAdmitted(source, 3);
    const [grove, dunes] = await both;
    expect(source.opens.map((request) => `${request.packId}/${request.assetKey}`).sort()).toEqual([
      'dunes/ground', 'grove/ground', 'shared/pilot',
    ]);
    expect(grove.key('shared', 'pilot')).toBe(dunes.key('shared', 'pilot'));
    grove.release();
    expect(f.values.has(dunes.key('shared', 'pilot'))).toBe(true);
    dunes.release();
    loader.dispose();
  });

  it('keeps another owner after one owner cancels, returning cancelled bytes and ownership', async () => {
    const f = fixture();
    const source = memorySource();
    const loader = createPhaserAssetPackLoader(f.scene, [
      { id: 'shared', revision: '1', assets: [{ kind: 'image', key: 'pilot', url: '/pilot.png' }] },
      { id: 'dunes', revision: '1', dependsOn: ['shared'], assets: [{ kind: 'image', key: 'ground', url: '/dunes.png' }] },
    ], { fileSource: source });
    const cancel = new AbortController();
    const cancelled = expect(loader.acquire('dunes', { signal: cancel.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    await vi.waitFor(() => expect(source.reads).toHaveLength(2));
    cancel.abort();
    await cancelled;
    // Late bodies of cancelled work return their bytes; no texture may register.
    serveRead(source, 0);
    serveRead(source, 1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.values.size).toBe(0);
    expect(source.releases).toHaveLength(2);
    expect(source.closes).toHaveLength(2);
    const lease = loader.acquire('shared');
    await vi.waitFor(() => expect(source.reads).toHaveLength(3));
    serveRead(source, 2);
    (await lease).release();
    loader.dispose();
  });

  it.each(['download', 'decode'])('rejects shutdown during %s and discards late bytes', async (stage) => {
    const f = fixture();
    const source = memorySource();
    let resolveGate: () => void = () => {
    };
    const gate = new Promise<void>((resolve) => {
      resolveGate = resolve;
    });
    if (stage === 'decode') {
      vi.stubGlobal('Image', class {
        src = '';
        naturalWidth = 16;
        naturalHeight = 16;
        decode(): Promise<void> {
          return gate;
        }
      });
    }
    const loader = createPhaserAssetPackLoader(f.scene, imageCatalog([{
      kind: 'image', key: 'pilot', url: '/pilot.png',
    }]), { fileSource: source });
    const failed = expect(loader.acquire('shared')).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(source.reads).toHaveLength(1));
    if (stage === 'download') {
      f.events.emit('shutdown');
      serveRead(source, 0);
    } else {
      serveRead(source, 0);
      await new Promise((resolve) => setTimeout(resolve, 0));
      f.events.emit('shutdown');
    }
    await failed;
    resolveGate();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.values.size).toBe(0);
    expect(source.releases).toHaveLength(1);
    expect(source.closes).toHaveLength(1);
    loader.dispose();
  });

  it('isolates body release and file close failures from the remaining cleanup', async () => {
    const f = fixture();
    const failures: string[] = [];
    const loader = createPhaserAssetPackLoader(f.scene, imageCatalog([{
      kind: 'image', key: 'pilot', url: '/pilot.png',
    }]), {
      fileSource: {
        async open() {
          return {
            async read() {
              return {
                bytes: new Blob([png]), release() {
                  failures.push('release');
                  throw new Error('source release failed');
                },
              };
            },
            close() {
              failures.push('close');
              throw new Error('source close failed');
            },
          };
        },
      },
    });
    const held = await loader.acquire('shared');
    expect(failures).toEqual(['release', 'close']);
    expect(f.values.size).toBe(1);
    held.release();
    expect(f.values.size).toBe(0);
    const errors = loader.takeCleanupErrors();
    expect(errors.map((entry) => String(entry.error))).toEqual(expect.arrayContaining([
      'Error: source release failed', 'Error: source close failed',
    ]));
    expect(errors.every((entry) => entry.packId === 'shared' && entry.assetKey === 'pilot')).toBe(true);
    loader.dispose();
  });

  it('verifies injected bytes even though the transport is replaced', async () => {
    const f = fixture();
    const cases: {
      name: string;
      integrity?: { texture: { bytes: number; sha256: string } };
      maxFileBytes?: number;
      bytes: Blob;
      message: RegExp;
    }[] = [
      {
        name: 'size mismatch', integrity: {
          texture: { bytes: 3, sha256: sha256(png) },
        }, bytes: new Blob([new Uint8Array([1, 2])]), message: /size mismatch/u,
      },
      {
        name: 'digest mismatch', integrity: {
          texture: { bytes: 3, sha256: sha256(new Uint8Array([9, 9, 9])) },
        }, bytes: new Blob([png]), message: /digest mismatch/u,
      },
      {
        name: 'byte limit without integrity', maxFileBytes: 8, bytes: new Blob([new Uint8Array(9)]), message: /exceeds byte limit/u,
      },
    ];
    for (const { name, integrity, maxFileBytes, bytes, message } of cases) {
      const source = memorySource();
      const loader = createPhaserAssetPackLoader(f.scene, imageCatalog(integrity
        ? [{ kind: 'image', key: 'pilot', url: '/pilot.png', integrity }]
        : [{ kind: 'image', key: 'pilot', url: '/pilot.png' }]), {
        fileSource: source, maxFileBytes: maxFileBytes ?? 32 * 1024 * 1024,
      });
      const failed = expect(loader.acquire('shared')).rejects.toThrow(message);
      await vi.waitFor(() => expect(source.reads).toHaveLength(1));
      source.reads[0]!.resolveBody({ bytes, release() {
      } });
      await failed;
      // Verification failures are terminal: the file is read exactly once.
      expect(source.reads, name).toHaveLength(1);
      loader.dispose();
    }
  });

  it('rejects unverifiable integrity before opening any file', async () => {
    const f = fixture();
    const source = memorySource();
    vi.stubGlobal('crypto', undefined);
    const secureLoader = createPhaserAssetPackLoader(f.scene, imageCatalog([{
      kind: 'image', key: 'pilot', url: '/pilot.png', integrity: {
        texture: { bytes: 3, sha256: sha256(png) },
      },
    }]), { fileSource: source });
    await expect(secureLoader.acquire('shared')).rejects.toThrow('requires HTTPS or localhost');
    expect(source.opens).toHaveLength(0);
    secureLoader.dispose();
    const oversizedLoader = createPhaserAssetPackLoader(f.scene, imageCatalog([{
      kind: 'image', key: 'pilot', url: '/pilot.png', integrity: {
        texture: { bytes: 9, sha256: sha256(png) },
      },
    }]), { fileSource: source, maxFileBytes: 8 });
    await expect(oversizedLoader.acquire('shared')).rejects.toThrow('declared file exceeds byte limit');
    expect(source.opens).toHaveLength(0);
    oversizedLoader.dispose();
  });

  it('times out a hung source read and returns ownership when it settles late', async () => {
    const f = fixture();
    const source = memorySource();
    const loader = createPhaserAssetPackLoader(f.scene, imageCatalog([{
      kind: 'image', key: 'pilot', url: '/pilot.png',
    }]), { fileSource: source, timeoutMs: 20 });
    const failed = expect(loader.acquire('shared')).rejects.toThrow('timed out');
    await vi.waitFor(() => expect(source.reads).toHaveLength(1));
    await failed;
    // A read that never settles keeps its source ownership, like a hung request.
    expect(source.closes).toHaveLength(0);
    source.reads[0]!.rejectBody(new Error('late transport failure'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(source.closes).toHaveLength(1);
    expect(source.releases).toHaveLength(0);
    loader.dispose();
  });

  it('shares transfer permits through the context budget', async () => {
    const f = fixture();
    let inFlight = 0;
    let maxInFlight = 0;
    const loader = createPhaserAssetPackLoader(f.scene, imageCatalog([
      { kind: 'image', key: 'one', url: '/one.png' },
      { kind: 'image', key: 'two', url: '/two.png' },
    ]), {
      fileSource: {
        async open(_request, context) {
          return {
            async read() {
              const releaseTransfer = await context.budgets.transfers.acquire(context.signal);
              inFlight++;
              maxInFlight = Math.max(maxInFlight, inFlight);
              try {
                await new Promise((resolve) => setTimeout(resolve, 0));
                return {
                  bytes: new Blob([png]), release() {
                  },
                };
              } finally {
                inFlight--;
                releaseTransfer();
              }
            },
            close() {
            },
          };
        },
      },
      maxConcurrentDownloads: 1,
    });
    const lease = await loader.acquire('shared');
    expect(maxInFlight).toBe(1);
    expect(f.values.size).toBe(2);
    lease.release();
    loader.dispose();
  });

  it('ignores default transport options when a source is provided and validates its shape', async () => {
    const f = fixture();
    const source = memorySource();
    const resolveURL = vi.fn((url: string) => url);
    const loader = createPhaserAssetPackLoader(f.scene, imageCatalog([{
      kind: 'image', key: 'pilot', url: '/pilot.png',
    }]), { fileSource: source, resolveURL, requestCache: 'reload' });
    const lease = loader.acquire('shared');
    await vi.waitFor(() => expect(source.reads).toHaveLength(1));
    serveRead(source, 0);
    await lease;
    expect(resolveURL).not.toHaveBeenCalled();
    loader.dispose();
    for (const invalid of [null, {}, { open: null }] as unknown as PhaserPackFileSource[]) {
      expect(() => createPhaserAssetPackLoader(f.scene, imageCatalog([{
        kind: 'image', key: 'pilot', url: '/pilot.png',
      }]), { fileSource: invalid })).toThrow('Invalid asset pack file source');
    }
    // Unused HTTP settings must not reject an injected source...
    for (const unusedTransport of [{ retries: 4 }, { requestTimeoutMs: 0 }, { requestCache: 'only-if-cached' as 'default' }]) {
      const tolerant = createPhaserAssetPackLoader(f.scene, imageCatalog([{
        kind: 'image', key: 'pilot', url: '/pilot.png',
      }]), { fileSource: memorySource(), ...unusedTransport });
      tolerant.dispose();
    }
    // ...while the default URL source still validates them.
    expect(() => createPhaserAssetPackLoader(f.scene, imageCatalog([{
      kind: 'image', key: 'pilot', url: '/pilot.png',
    }]), { retries: 4 })).toThrow('Invalid asset pack limits');
    expect(() => createPhaserAssetPackLoader(f.scene, imageCatalog([{
      kind: 'image', key: 'pilot', url: '/pilot.png',
    }]), { requestTimeoutMs: 0 })).toThrow('Invalid asset pack limits');
  });
});

describe('default URL source ownership', () => {
  const transport = {
    resolveURL: (url: string) => url,
    retries: 0,
    requestTimeoutMs: 1000,
    requestCache: 'no-store' as const,
    maxFileBytes: 8,
  };
  const openFile = async () => {
    const controller = new AbortController();
    const noop = (): void => {
    };
    const context: PhaserPackFileContext = {
      signal: controller.signal,
      budgets: {
        transfers: { acquire: async () => noop },
        bytes: { acquire: async () => noop },
      },
    };
    const opened = await createPackUrlFileSource(transport).open({
      packId: 'shared', revision: '1', assetKey: 'pilot', role: 'texture', url: '/pilot.png',
    }, context);
    return { opened, controller };
  };

  it('rejects a second read of the same opened file', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(png)));
    const { opened } = await openFile();
    expect((await opened.read()).bytes.size).toBe(3);
    await expect(opened.read()).rejects.toThrow('already read');
    expect(fetch).toHaveBeenCalledOnce();
    opened.close();
  });

  it('keeps a failed read retryable', async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce(new Response(png));
    vi.stubGlobal('fetch', fetch);
    const { opened } = await openFile();
    await expect(opened.read()).rejects.toThrow('Asset network request failed');
    expect((await opened.read()).bytes.size).toBe(3);
    expect(fetch).toHaveBeenCalledTimes(2);
    opened.close();
  });

  it('uses verified persistent bytes before starting the origin request', async () => {
    const records = new Map<string, ArrayBuffer>([['app|shared-file', png.buffer.slice(0)]]);
    const events: PhaserPackCacheEvent[] = [];
    const storage: PhaserPackPersistentCache = {
      async get() {
        return records.get('app|shared-file')?.slice(0);
      },
      async put() {
        throw new Error('put should not run for a hit');
      },
      async delete() {
        return false;
      },
      async clear() {
      },
      async usage() {
        return { records: 1, totalBytes: png.byteLength };
      },
    };
    const source = createPackUrlFileSource({
      ...transport,
      persistentCache: {
        storage,
        namespace: 'app',
        onEvent: (event): void => {
          events.push(event);
        },
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('origin must not be reached');
    }));
    const controller = new AbortController();
    const noop = (): void => {
    };
    const opened = await source.open({
      packId: 'shared',
      revision: '1',
      assetKey: 'pilot',
      role: 'texture',
      url: '/pilot.png',
      integrity: { bytes: png.byteLength, sha256: sha256(png) },
    }, {
      signal: controller.signal,
      budgets: {
        transfers: { acquire: async () => noop },
        bytes: { acquire: async () => noop },
      },
    });
    expect((await opened.read()).bytes.size).toBe(png.byteLength);
    expect(fetch).not.toHaveBeenCalled();
    expect(events.map((event) => event.outcome)).toEqual(['cache-hit']);
    opened.close();
  });
});

describe('default URL source integrity', () => {
  it('verifies delivered body bytes, not Content-Length or Content-Encoding headers', async () => {
    const f = fixture();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(png, {
      headers: { 'Content-Encoding': 'gzip', 'Content-Length': '2' },
    })));
    const loader = createPhaserAssetPackLoader(f.scene, imageCatalog([{
      kind: 'image', key: 'pilot', url: '/pilot.png', integrity: {
        texture: { bytes: 3, sha256: sha256(png) },
      },
    }]));
    const lease = await loader.acquire('shared');
    expect(f.values.size).toBe(1);
    lease.release();
    loader.dispose();
  });

  it('rejects default-source bytes whose body digest differs from the manifest', async () => {
    const f = fixture();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([3, 2, 1]))));
    const loader = createPhaserAssetPackLoader(f.scene, imageCatalog([{
      kind: 'image', key: 'pilot', url: '/pilot.png', integrity: {
        texture: { bytes: 3, sha256: sha256(png) },
      },
    }]));
    await expect(loader.acquire('shared')).rejects.toThrow('digest mismatch');
    expect(fetch).toHaveBeenCalledTimes(1);
    loader.dispose();
  });
});
