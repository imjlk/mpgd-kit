import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  createPhaserPackCacheKey,
  readPhaserPackArtifact,
  readPhaserPackArtifactWithCommit,
  type PhaserPackCacheEvent,
  type PhaserPackPersistentCache,
} from '../src/pack-cache.js';

const bytes = new Uint8Array([1, 2, 3, 4]);
const sha256 = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex');
const integrity = { bytes: bytes.byteLength, sha256: sha256(bytes) };
const artifact = {
  kind: 'file' as const,
  packId: 'shared',
  revision: '1',
  assetKey: 'pilot',
  role: 'texture',
};

function memoryCache(initial?: ArrayBuffer): PhaserPackPersistentCache & {
  value: ArrayBuffer | undefined;
  puts: number;
  deletes: number;
  failGet: boolean;
  failPut: boolean;
} {
  const values = new Map<string, ArrayBuffer>();
  const state = {
    value: initial,
    puts: 0,
    deletes: 0,
    failGet: false,
    failPut: false,
  };
  const id = (key: { namespace: string; sha256: string; bytes: number }): string =>
    `${key.namespace}|${key.sha256}|${key.bytes}`;
  if (initial !== undefined) {
    values.set('app|' + integrity.sha256 + '|' + integrity.bytes, initial);
  }
  return {
    ...state,
    async get(key) {
      if (this.failGet) {
        throw new Error('read unavailable');
      }
      const found = values.get(id(key));
      return found?.slice(0) as ArrayBuffer | undefined;
    },
    async put(key, value) {
      if (this.failPut) {
        throw new Error('quota');
      }
      this.puts++;
      const copy = value.slice(0);
      values.set(id(key), copy);
      this.value = copy;
    },
    async delete(key) {
      this.deletes++;
      return values.delete(id(key));
    },
    async clear(namespace) {
      for (const key of values.keys()) {
        if (key.startsWith(`${namespace}|`)) {
          values.delete(key);
        }
      }
    },
    async usage(namespace) {
      const owned = [...values.entries()].filter(([key]) => key.startsWith(`${namespace}|`));
      return {
        records: owned.length,
        totalBytes: owned.reduce((sum, [, value]) => sum + value.byteLength, 0),
      };
    },
  };
}

const optionsOf = (
  storage: PhaserPackPersistentCache,
  events: PhaserPackCacheEvent[],
) => ({
  storage,
  namespace: 'app',
  onEvent: (event: PhaserPackCacheEvent): void => {
    events.push(event);
  },
});

describe('persistent pack cache boundary', () => {
  it('reuses a verified hit without touching origin and exposes management identity', async () => {
    const storage = memoryCache(bytes.buffer.slice(0));
    const events: PhaserPackCacheEvent[] = [];
    const key = createPhaserPackCacheKey('app', integrity);
    let originCalls = 0;
    const result = await readPhaserPackArtifact({
      persistentCache: optionsOf(storage, events),
      integrity,
      artifact,
      signal: new AbortController().signal,
      fetchOrigin: async () => {
        originCalls++;
        return bytes.buffer.slice(0);
      },
    });
    expect(new Uint8Array(result)).toEqual(bytes);
    expect(originCalls).toBe(0);
    expect(events.map((event) => event.outcome)).toEqual(['cache-hit']);
    expect(events[0]?.key).toEqual(key);
    expect(await storage.usage('app')).toEqual({ records: 1, totalBytes: bytes.byteLength });
    expect(await storage.delete(key)).toBe(true);
    expect(await storage.usage('app')).toEqual({ records: 0, totalBytes: 0 });
  });

  it('downloads and stores misses, but keeps origin success when storage fails', async () => {
    const storage = memoryCache();
    storage.failPut = true;
    const events: PhaserPackCacheEvent[] = [];
    let originCalls = 0;
    const result = await readPhaserPackArtifact({
      persistentCache: optionsOf(storage, events),
      integrity,
      artifact,
      signal: new AbortController().signal,
      fetchOrigin: async () => {
        originCalls++;
        return bytes.buffer.slice(0);
      },
    });
    expect(new Uint8Array(result)).toEqual(bytes);
    expect(originCalls).toBe(1);
    expect(events.map((event) => event.outcome)).toEqual(['origin-download', 'cache-store-failed']);
  });

  it('defers an origin store until the authoritative caller verifies the bytes', async () => {
    const storage = memoryCache();
    const events: PhaserPackCacheEvent[] = [];
    const read = await readPhaserPackArtifactWithCommit({
      persistentCache: optionsOf(storage, events),
      integrity,
      artifact,
      signal: new AbortController().signal,
      fetchOrigin: async () => bytes.buffer.slice(0),
    });
    expect(new Uint8Array(read.bytes)).toEqual(bytes);
    expect(storage.puts).toBe(0);
    await read.commit?.(false);
    expect(storage.puts).toBe(0);
    await read.commit?.(true);
    expect(storage.puts).toBe(1);
  });

  it('invalidates a corrupt record and falls back to origin', async () => {
    const corrupt = new Uint8Array(bytes);
    corrupt[0]! ^= 0xff;
    const storage = memoryCache(corrupt.buffer.slice(0));
    const events: PhaserPackCacheEvent[] = [];
    let originCalls = 0;
    await readPhaserPackArtifact({
      persistentCache: optionsOf(storage, events),
      integrity,
      artifact,
      signal: new AbortController().signal,
      fetchOrigin: async () => {
        originCalls++;
        return bytes.buffer.slice(0);
      },
    });
    expect(originCalls).toBe(1);
    expect(storage.deletes).toBe(1);
    expect(events.map((event) => event.outcome)).toEqual(['cache-corrupt', 'origin-download']);
  });

  it('does not turn a cache read failure into an origin failure', async () => {
    const storage = memoryCache();
    storage.failGet = true;
    const events: PhaserPackCacheEvent[] = [];
    await expect(readPhaserPackArtifact({
      persistentCache: optionsOf(storage, events),
      integrity,
      artifact,
      signal: new AbortController().signal,
      fetchOrigin: async () => bytes.buffer.slice(0),
    })).resolves.toEqual(bytes.buffer);
    expect(events.map((event) => event.outcome)).toEqual(['cache-read-failed', 'origin-download']);
  });

  it('stops on caller cancellation while a storage read is pending', async () => {
    const controller = new AbortController();
    const storage: PhaserPackPersistentCache = {
      get: async () => new Promise<ArrayBuffer | undefined>(() => undefined),
      put: async () => undefined,
      delete: async () => false,
      clear: async () => undefined,
      usage: async () => ({ records: 0, totalBytes: 0 }),
    };
    const pending = readPhaserPackArtifact({
      persistentCache: optionsOf(storage, []),
      integrity,
      artifact,
      signal: controller.signal,
      fetchOrigin: async () => bytes.buffer.slice(0),
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
