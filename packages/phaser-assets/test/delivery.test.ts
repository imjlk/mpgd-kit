import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ArchiveWorkerRequest, ArchiveWorkerResponse } from '../src/archive-protocol.js';
import { createArchiveWorkerDispatch } from '../src/archive-worker-impl.js';
import {
  createPhaserPackDelivery,
  PhaserPackDeliveryError,
  readCappedDeliveryBody,
} from '../src/delivery.js';
import type { PhaserPackFileRequest } from '../src/pack-file-source.js';
import { buildZipV1Fixture, type ZipV1FixtureEntry } from '../src/test-utils.js';

const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');

const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

interface ServedFile {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
}

/** In-memory static origin: records decoded request paths so encoding and
 * routing assertions observe exactly what the delivery asked for. */
const startOrigin = async (): Promise<{
  readonly url: string;
  readonly requests: string[];
  readonly files: Map<string, ServedFile>;
  readonly close: () => Promise<void>;
}> => {
  const files = new Map<string, ServedFile>();
  const requests: string[] = [];
  const server: Server = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname).replace(/^\//u, '');
    requests.push(path);
    const file = files.get(path);
    if (file === undefined) {
      response.writeHead(404).end('missing');
      return;
    }
    response.setHeader('Content-Type', file.mediaType);
    response.setHeader('Content-Length', file.bytes.byteLength);
    response.end(file.bytes);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('no origin address');
  }
  return {
    url: `http://127.0.0.1:${address.port}/`,
    requests,
    files,
    close: async (): Promise<void> => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
};

const servers: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

/** In-process worker substitute running the real dispatch, matching the
 * application-deployed module worker contract. */
const createFakeWorkerFactory = () => {
  const posted: ArchiveWorkerRequest[] = [];
  const factory = (): Worker => {
    const messageListeners: ((event: MessageEvent<ArchiveWorkerResponse>) => void)[] = [];
    const dispatch = createArchiveWorkerDispatch({
      post: (message: ArchiveWorkerResponse): void => {
        for (const listener of [...messageListeners]) {
          listener({ data: message } as MessageEvent<ArchiveWorkerResponse>);
        }
      },
    });
    return {
      postMessage(message: ArchiveWorkerRequest): void {
        posted.push(message);
        dispatch(message);
      },
      addEventListener(
        type: string,
        listener: (event: never) => void,
      ): void {
        // Only message listeners receive worker messages; the client's
        // error/messageerror listeners must stay silent in this fixture.
        if (type === 'message') {
          messageListeners.push(listener as (event: MessageEvent<ArchiveWorkerResponse>) => void);
        }
      },
      terminate(): void {
      },
    } as unknown as Worker;
  };
  return { factory, posted };
};

/** Origin whose responses wait on per-path gates, so tests hold a
 * download at an exact phase boundary instead of sleeping. */
const startGatedOrigin = async (): Promise<{
  readonly url: string;
  readonly requests: string[];
  readonly files: Map<string, ServedFile>;
  readonly hold: (path: string) => void;
  readonly release: (path: string) => void;
  readonly close: () => Promise<void>;
}> => {
  const files = new Map<string, ServedFile>();
  const requests: string[] = [];
  const gates = new Map<string, { readonly promise: Promise<void>; readonly release: () => void }>();
  const gateFor = (path: string): { readonly promise: Promise<void>; readonly release: () => void } => {
    let entry = gates.get(path);
    if (entry === undefined) {
      let release!: () => void;
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      entry = { promise, release };
      gates.set(path, entry);
    }
    return entry;
  };
  const server: Server = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname).replace(/^\//u, '');
    void (async (): Promise<void> => {
      requests.push(path);
      const gate = gates.get(path);
      if (gate !== undefined) {
        await gate.promise;
      }
      const file = files.get(path);
      if (file === undefined) {
        response.writeHead(404).end('missing');
        return;
      }
      response.setHeader('Content-Type', file.mediaType);
      response.setHeader('Content-Length', file.bytes.byteLength);
      // One connection per response: these tests phase-gate downloads,
      // and a pooled socket reused across gates adds runner-dependent
      // transport behavior they do not aim to measure.
      response.setHeader('Connection', 'close');
      response.end(file.bytes);
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('no gated origin address');
  }
  return {
    url: `http://127.0.0.1:${address.port}/`,
    requests,
    files,
    hold: (path: string): void => {
      gateFor(path);
    },
    release: (path: string): void => {
      gates.get(path)?.release();
    },
    close: async (): Promise<void> => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
};

/** Wait until the gated origin has received the given request path. */
const waitForRequest = async (requests: readonly string[], path: string): Promise<void> => {
  while (!requests.includes(path)) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
};

/** Worker substitute that queues posts and dispatches exactly one per
 * step, so a test can move the clock between a request and its reply and
 * land a reply's synchronous side effects before any microtask runs. */
const createDeferredWorkerFactory = () => {
  const posted: ArchiveWorkerRequest[] = [];
  const queue: ArchiveWorkerRequest[] = [];
  const listeners: ((event: MessageEvent<ArchiveWorkerResponse>) => void)[] = [];
  let dispatch: ((message: ArchiveWorkerRequest) => void) | undefined;
  const factory = (): Worker => {
    dispatch = createArchiveWorkerDispatch({
      post: (message: ArchiveWorkerResponse): void => {
        for (const listener of [...listeners]) {
          listener({ data: message } as MessageEvent<ArchiveWorkerResponse>);
        }
      },
    });
    return {
      postMessage(message: ArchiveWorkerRequest): void {
        posted.push(message);
        queue.push(message);
      },
      addEventListener(
        type: string,
        listener: (event: never) => void,
      ): void {
        if (type === 'message') {
          listeners.push(listener as (event: MessageEvent<ArchiveWorkerResponse>) => void);
        }
      },
      terminate(): void {
      },
    } as unknown as Worker;
  };
  return {
    factory,
    posted,
    /** Dispatches exactly one queued worker request, synchronously. */
    step: (): boolean => {
      const message = queue.shift();
      if (message === undefined) {
        return false;
      }
      dispatch?.(message);
      return true;
    },
  };
};

/** Manual monotonic clock: performance.now moves only on explicit phase
 * commands while Date.now is free to jump, mirroring a wall-clock
 * correction that must not move a delivery budget. */
const useMonotonicFakeClock = () => {
  let elapsed = 0;
  const spy = vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
  return {
    advance: (ms: number): void => {
      elapsed += ms;
    },
    set: (ms: number): void => {
      elapsed = ms;
    },
    restore: (): void => {
      spy.mockRestore();
    },
  };
};

const decodeRequest = (
  posted: readonly ArchiveWorkerRequest[],
  index: number,
): { readonly limits: { readonly decodeDeadlineMs: number } } | undefined => {
  const requests = posted.filter((message): message is Extract<ArchiveWorkerRequest, { type: 'decode' }> =>
    message.type === 'decode');
  return requests[index];
};

interface BuiltZip {
  readonly entries: readonly ZipV1FixtureEntry[];
  readonly archive: Uint8Array;
}

interface ManifestPackSpec {
  readonly id: string;
  readonly revision?: string;
  readonly dependsOn?: readonly string[];
  readonly delivery: 'files' | 'zip';
  readonly zip?: BuiltZip;
  readonly fileName?: string;
}

/** Assemble a delivery manifest around real fixture bytes. */
const buildManifest = (packs: readonly ManifestPackSpec[]): {
  readonly manifest: Record<string, unknown>;
  readonly packFiles: Map<string, ServedFile>;
} => {
  const packFiles = new Map<string, ServedFile>();
  const manifestPacks = packs.map((pack) => {
    const revision = pack.revision ?? '1';
    const texturePath = pack.delivery === 'files'
      ? `packs/${pack.id}@${revision}/${pack.fileName ?? 'pilot.png'}`
      : 'pilot.png';
    if (pack.delivery === 'files') {
      packFiles.set(texturePath, { bytes: pngBytes, mediaType: 'image/png' });
    }
    if (pack.delivery === 'zip' && pack.zip !== undefined) {
      packFiles.set(`packs/${pack.id}@${revision}.zip`, {
        bytes: pack.zip.archive, mediaType: 'application/zip',
      });
    }
    const textureFile = {
      role: 'texture',
      mediaType: 'image/png',
      bytes: pngBytes.byteLength,
      sha256: sha256(pngBytes),
      path: texturePath,
      ...(pack.delivery === 'zip' ? { method: 'store' as const } : {}),
    };
    return {
      packId: pack.id,
      revision,
      dependencies: (pack.dependsOn ?? []).map((dependency) => ({
        packId: dependency, revision: packs.find((candidate) => candidate.id === dependency)?.revision ?? '1',
      })),
      delivery: pack.delivery,
      assets: [{
        assetKey: 'pilot',
        kind: 'spritesheet' as const,
        frameConfig: { frameWidth: 8, frameHeight: 8 },
        files: [textureFile],
      }],
      ...(pack.delivery === 'zip' && pack.zip !== undefined ? {
        archive: {
          path: `packs/${pack.id}@${revision}.zip`,
          bytes: pack.zip.archive.byteLength,
          sha256: sha256(pack.zip.archive),
          entryCount: pack.zip.entries.length,
        },
      } : {}),
    };
  });
  return { manifest: { format: 'mpgd-asset-packs', version: 1, packs: manifestPacks }, packFiles };
};

const withZipBytes = (entries: readonly ZipV1FixtureEntry[]): BuiltZip => ({
  entries,
  archive: buildZipV1Fixture(entries).archive,
});

const zipFixture = (): BuiltZip => withZipBytes([
  { path: 'pilot.png', data: pngBytes, method: 'store' },
]);

const openRequest = (packId: string, revision = '1'): PhaserPackFileRequest => ({
  packId,
  revision,
  assetKey: 'pilot',
  role: 'texture',
  url: 'pilot.png',
  integrity: { bytes: pngBytes.byteLength, sha256: sha256(pngBytes) },
});

const budgets = () => ({
  transfers: {
    acquire: async (): Promise<() => void> => () => undefined,
  },
  bytes: {
    acquire: async (): Promise<() => void> => () => undefined,
  },
});

describe('phaser pack delivery', () => {
  it('derives the loader catalog, roles and dependencies from the manifest', async () => {
    const origin = await startOrigin();
    servers.push(origin);
    const { manifest } = buildManifest([
      { id: 'shared', delivery: 'files' },
      { id: 'theme', dependsOn: ['shared'], delivery: 'zip', zip: zipFixture() },
    ]);
    const delivery = createPhaserPackDelivery(manifest, {
      baseUrl: origin.url,
      createWorker: (): Worker => undefined as unknown as Worker,
    });
    expect(delivery.catalog.map((pack) => pack.id)).toEqual(['shared', 'theme']);
    const shared = delivery.catalog[0]!;
    expect(shared.dependsOn).toEqual([]);
    expect(shared.assets[0]).toMatchObject({
      kind: 'spritesheet', key: 'pilot', url: 'packs/shared@1/pilot.png',
    });
    const theme = delivery.catalog[1]!;
    expect(theme.dependsOn).toEqual(['shared']);
    expect(theme.revision).toBe('1');
    expect(theme.assets[0]!.integrity?.texture).toEqual({
      bytes: pngBytes.byteLength, sha256: sha256(pngBytes),
    });
    delivery.dispose();
  });

  it('keeps the verification basis after caller manifest mutation', async () => {
    const origin = await startOrigin();
    servers.push(origin);
    const { manifest, packFiles } = buildManifest([
      { id: 'solo', delivery: 'files' },
    ]);
    for (const [path, file] of packFiles) {
      origin.files.set(path, file);
    }
    const delivery = createPhaserPackDelivery(manifest, {
      baseUrl: origin.url,
    });
    // Mutate the caller's manifest after creation: the frozen snapshot,
    // not the live object, keeps driving verification.
    const firstPack = (manifest as { packs: { assets: { files: { sha256: string }[] }[] }[] }).packs[0]!;
    firstPack.assets[0]!.files[0]!.sha256 = '0'.repeat(64);
    const opened = await delivery.fileSource.open(openRequest('solo'), { signal: new AbortController().signal, budgets: budgets() });
    const body = await opened.read();
    expect(body.bytes.size).toBe(pngBytes.byteLength);
    opened.close();
    delivery.dispose();
  });

  it('prepares files-only closures without any archive or worker work', async () => {
    const origin = await startOrigin();
    servers.push(origin);
    const { manifest } = buildManifest([{ id: 'solo', delivery: 'files' }]);
    const createWorker = vi.fn((): Worker => undefined as unknown as Worker);
    const delivery = createPhaserPackDelivery(manifest, { baseUrl: origin.url, createWorker });
    const prepared = await delivery.prepare('solo');
    expect(origin.requests).toEqual([]);
    expect(createWorker).not.toHaveBeenCalled();
    expect(delivery.snapshot().staging).toEqual([]);
    prepared.release();
    delivery.dispose();
  });

  it('serves staged zip entries and plain HTTP files from one source', async () => {
    const origin = await startOrigin();
    servers.push(origin);
    const { manifest, packFiles } = buildManifest([
      { id: 'shared', delivery: 'files' },
      { id: 'theme', dependsOn: ['shared'], delivery: 'zip', zip: zipFixture() },
    ]);
    for (const [path, file] of packFiles) {
      origin.files.set(path, file);
    }
    const { factory } = createFakeWorkerFactory();
    const delivery = createPhaserPackDelivery(manifest, {
      baseUrl: origin.url,
      createWorker: factory,
    });
    const prepared = await delivery.prepare('theme');
    // One archive request for the theme; the shared dependency stays HTTP.
    expect(origin.requests.filter((path) => path.endsWith('.zip'))).toEqual(['packs/theme@1.zip']);
    const zipOpened = await delivery.fileSource.open(openRequest('theme'), {
      signal: new AbortController().signal, budgets: budgets(),
    });
    const zipBody = await zipOpened.read();
    expect(new Uint8Array(await zipBody.bytes.arrayBuffer())).toEqual(pngBytes);
    const httpOpened = await delivery.fileSource.open(openRequest('shared'), {
      signal: new AbortController().signal, budgets: budgets(),
    });
    const httpBody = await httpOpened.read();
    expect(new Uint8Array(await httpBody.bytes.arrayBuffer())).toEqual(pngBytes);
    expect(origin.requests).toContain('packs/shared@1/pilot.png');
    zipOpened.close();
    httpOpened.close();
    prepared.release();
    delivery.dispose();
  });

  it('encodes each URL path segment exactly once', async () => {
    const origin = await startOrigin();
    servers.push(origin);
    const tricky = 'a%b #c?d ünïcode.png';
    const artifactPath = `packs/tricky@r~1/${tricky}`;
    origin.files.clear();
    origin.files.set(artifactPath, { bytes: pngBytes, mediaType: 'image/png' });
    const manifest = {
      format: 'mpgd-asset-packs',
      version: 1,
      packs: [{
        packId: 'tricky',
        revision: 'r~1',
        dependencies: [],
        delivery: 'files',
        assets: [{
          assetKey: 'pilot',
          kind: 'spritesheet',
          frameConfig: { frameWidth: 8, frameHeight: 8 },
          files: [{
            role: 'texture',
            mediaType: 'image/png',
            bytes: pngBytes.byteLength,
            sha256: sha256(pngBytes),
            path: artifactPath,
          }],
        }],
      }],
    };
    const delivery = createPhaserPackDelivery(manifest, { baseUrl: origin.url });
    const opened = await delivery.fileSource.open({
      packId: 'tricky',
      revision: 'r~1',
      assetKey: 'pilot',
      role: 'texture',
      url: artifactPath,
      integrity: { bytes: pngBytes.byteLength, sha256: sha256(pngBytes) },
    }, { signal: new AbortController().signal, budgets: budgets() });
    const body = await opened.read();
    expect(body.bytes.size).toBe(pngBytes.byteLength);
    // The server decodes once: the recorded path is the original name, so
    // the client encoded exactly once.
    expect(origin.requests).toEqual([artifactPath]);
    opened.close();
    delivery.dispose();
  });

  it('rejects zip reads before preparation with not-prepared', async () => {
    const origin = await startOrigin();
    servers.push(origin);
    const { manifest } = buildManifest([{ id: 'solo', delivery: 'zip', zip: zipFixture() }]);
    const delivery = createPhaserPackDelivery(manifest, {
      baseUrl: origin.url,
      createWorker: createFakeWorkerFactory().factory,
    });
    await expect(delivery.fileSource.open(openRequest('solo'), {
      signal: new AbortController().signal, budgets: budgets(),
    })).rejects.toMatchObject({ code: 'not-prepared' });
    delivery.dispose();
  });

  it('rejects use after dispose and repeated release stays safe', async () => {
    const origin = await startOrigin();
    servers.push(origin);
    const { manifest, packFiles } = buildManifest([
      { id: 'shared', delivery: 'files' },
      { id: 'theme', dependsOn: ['shared'], delivery: 'zip', zip: zipFixture() },
    ]);
    for (const [path, file] of packFiles) {
      origin.files.set(path, file);
    }
    const delivery = createPhaserPackDelivery(manifest, {
      baseUrl: origin.url,
      createWorker: createFakeWorkerFactory().factory,
    });
    const prepared = await delivery.prepare('theme');
    prepared.release();
    prepared.release();
    expect(delivery.snapshot().staging).toEqual([]);
    delivery.dispose();
    await expect(delivery.prepare('theme')).rejects.toMatchObject({ code: 'disposed' });
  });

  it('keeps staged bytes alive for open readers after handle release', async () => {
    const origin = await startOrigin();
    servers.push(origin);
    const { manifest, packFiles } = buildManifest([{ id: 'solo', delivery: 'zip', zip: zipFixture() }]);
    for (const [path, file] of packFiles) {
      origin.files.set(path, file);
    }
    const delivery = createPhaserPackDelivery(manifest, {
      baseUrl: origin.url,
      createWorker: createFakeWorkerFactory().factory,
    });
    const prepared = await delivery.prepare('solo');
    const opened = await delivery.fileSource.open(openRequest('solo'), {
      signal: new AbortController().signal, budgets: budgets(),
    });
    prepared.release();
    // The open reader keeps the bytes alive past the handle release.
    expect(delivery.snapshot().staging).toHaveLength(1);
    expect(delivery.snapshot().staging[0]!.openReaders).toBe(1);
    const body = await opened.read();
    expect(body.bytes.size).toBe(pngBytes.byteLength);
    opened.close();
    expect(delivery.snapshot().staging).toEqual([]);
    delivery.dispose();
  });

  it('cleans partial staging when the caller cancels mid-preparation', async () => {
    const origin = await startOrigin();
    servers.push(origin);
    const { manifest, packFiles } = buildManifest([
      { id: 'dep', delivery: 'zip', zip: zipFixture() },
      { id: 'top', dependsOn: ['dep'], delivery: 'zip', zip: zipFixture() },
    ]);
    for (const [path, file] of packFiles) {
      origin.files.set(path, file);
    }
    const delivery = createPhaserPackDelivery(manifest, {
      baseUrl: origin.url,
      createWorker: createFakeWorkerFactory().factory,
    });
    const controller = new AbortController();
    const preparing = delivery.prepare('top', { signal: controller.signal });
    controller.abort();
    await expect(preparing).rejects.toMatchObject({ code: 'cancelled' });
    expect(delivery.snapshot().staging).toEqual([]);
    expect(delivery.snapshot().stagingUsedBytes).toBe(0);
    delivery.dispose();
  });

  it('reports the deadline when the whole prepare budget expires', async () => {
    const origin = await startOrigin();
    servers.push(origin);
    const { manifest, packFiles } = buildManifest([{ id: 'solo', delivery: 'zip', zip: zipFixture() }]);
    for (const [path, file] of packFiles) {
      origin.files.set(path, file);
    }
    const delivery = createPhaserPackDelivery(manifest, {
      baseUrl: origin.url,
      createWorker: createFakeWorkerFactory().factory,
      prepareTimeoutMs: 1,
    });
    // With a 1 ms whole-prepare budget, the archive fetch or the decode
    // deadline rejects with the deadline category — never a silent hang.
    await expect(delivery.prepare('solo')).rejects.toMatchObject({
      code: expect.stringMatching(/^(deadline|transport)$/),
    });
    expect(delivery.snapshot().staging).toEqual([]);
    delivery.dispose();
  });

  it('rejects oversized closures before any network request', async () => {
    const origin = await startOrigin();
    servers.push(origin);
    const { manifest } = buildManifest([{ id: 'solo', delivery: 'zip', zip: zipFixture() }]);
    const delivery = createPhaserPackDelivery(manifest, {
      baseUrl: origin.url,
      createWorker: createFakeWorkerFactory().factory,
      stagingBudgetBytes: 8,
    });
    await expect(delivery.prepare('solo')).rejects.toMatchObject({ code: 'budget' });
    expect(origin.requests).toEqual([]);
    delivery.dispose();
  });

  it('serves staged entries in any read order', async () => {
    const origin = await startOrigin();
    servers.push(origin);
    const atlasBytes = new TextEncoder().encode('{"frames":{}}');
    const zip = withZipBytes([
      { path: 'pilot.png', data: pngBytes, method: 'store' },
      { path: 'pilot.json', data: atlasBytes, method: 'deflate' },
    ]);
    const { manifest, packFiles } = buildManifest([{ id: 'solo', delivery: 'zip', zip }]);
    for (const [path, file] of packFiles) {
      origin.files.set(path, file);
    }
    interface MutFile { role: string; mediaType: string; bytes: number; sha256: string; path: string; method?: string }
    interface MutAsset { assetKey: string; kind: string; frameConfig?: { frameWidth: number; frameHeight: number }; files: MutFile[] }
    const manifestDoc = manifest as { packs: { assets: MutAsset[] }[] };
    const soloAsset = manifestDoc.packs[0]!.assets[0]!;
    soloAsset.files.push({
      role: 'atlas',
      mediaType: 'application/json',
      bytes: atlasBytes.byteLength,
      sha256: sha256(atlasBytes),
      path: 'pilot.json',
      method: 'deflate',
    });
    soloAsset.kind = 'atlas';
    delete soloAsset.frameConfig;
    const delivery = createPhaserPackDelivery(manifest, {
      baseUrl: origin.url,
      createWorker: createFakeWorkerFactory().factory,
    });
    await delivery.prepare('solo');
    // Open the atlas before the texture: read order never depends on the
    // archive's entry order.
    const atlas = await delivery.fileSource.open({
      packId: 'solo', revision: '1', assetKey: 'pilot', role: 'atlas',
      url: 'pilot.json', integrity: { bytes: atlasBytes.byteLength, sha256: sha256(atlasBytes) },
    }, { signal: new AbortController().signal, budgets: budgets() });
    const atlasBody = await atlas.read();
    atlas.close();
    const texture = await delivery.fileSource.open(openRequest('solo'), {
      signal: new AbortController().signal, budgets: budgets(),
    });
    const textureBody = await texture.read();
    texture.close();
    expect(new Uint8Array(await atlasBody.bytes.arrayBuffer())).toEqual(atlasBytes);
    expect(new Uint8Array(await textureBody.bytes.arrayBuffer())).toEqual(pngBytes);
    delivery.dispose();
  });

  it('preserves decoder failures as integrity errors with their status', async () => {
    const origin = await startOrigin();
    servers.push(origin);
    const zip = zipFixture();
    const corrupt = zip.archive.slice();
    corrupt[5] = (corrupt[5] ?? 0) ^ 0xff;
    const files = new Map<string, ServedFile>([
      ['packs/solo@1.zip', { bytes: corrupt, mediaType: 'application/zip' }],
    ]);
    origin.files.clear();
    for (const [path, file] of files) {
      origin.files.set(path, file);
    }
    const { manifest } = buildManifest([{ id: 'solo', delivery: 'zip', zip }]);
    const delivery = createPhaserPackDelivery(manifest, {
      baseUrl: origin.url,
      createWorker: createFakeWorkerFactory().factory,
    });
    // The served bytes digest away from the manifest, so the archive is
    // rejected before decoding even starts.
    await expect(delivery.prepare('solo')).rejects.toMatchObject({ code: 'integrity' });
    delivery.dispose();
  });

  it('requires WebCrypto for files-only manifests at creation', async () => {
    const origin = await startOrigin();
    servers.push(origin);
    const { manifest } = buildManifest([{ id: 'solo', delivery: 'files' }]);
    const subtle = crypto.subtle;
    vi.stubGlobal('crypto', { subtle: undefined });
    try {
      expect(() => createPhaserPackDelivery(manifest, { baseUrl: origin.url })).toThrow(
        /WebCrypto/,
      );
    } finally {
      vi.unstubAllGlobals();
    }
    void subtle;
  });

  it('classifies worker-environment failures as configuration errors', async () => {
    const origin = await startOrigin();
    servers.push(origin);
    const { manifest, packFiles } = buildManifest([{ id: 'solo', delivery: 'zip', zip: zipFixture() }]);
    for (const [path, file] of packFiles) {
      origin.files.set(path, file);
    }
    const delivery = createPhaserPackDelivery(manifest, {
      baseUrl: origin.url,
      createWorker: (): Worker => {
        throw new Error('no workers under this CSP');
      },
    });
    const failure = await delivery.prepare('solo').catch((error: unknown): unknown => error);
    expect(failure).toBeInstanceOf(PhaserPackDeliveryError);
    expect((failure as PhaserPackDeliveryError).code).toBe('config');
    expect((failure as PhaserPackDeliveryError).message).toContain('no workers under this CSP');
    delivery.dispose();
  });

  it('settles a queued file read as disposed when dispose lands first', async () => {
    const origin = await startOrigin();
    servers.push(origin);
    const { manifest, packFiles } = buildManifest([{ id: 'solo', delivery: 'files' }]);
    for (const [path, file] of packFiles) {
      origin.files.set(path, file);
    }
    const delivery = createPhaserPackDelivery(manifest, { baseUrl: origin.url });
    const context = new AbortController();
    let releasePermit: (() => void) | undefined;
    const budgets = {
      transfers: {
        acquire: (signal: AbortSignal): Promise<() => void> => new Promise((resolve, reject) => {
          const forward = (): void => reject(signal.reason);
          if (signal.aborted) {
            forward();
            return;
          }
          signal.addEventListener('abort', forward, { once: true });
          releasePermit = (): void => {
            signal.removeEventListener('abort', forward);
            resolve(() => undefined);
          };
        }),
      },
      bytes: {
        acquire: async (): Promise<() => void> => () => undefined,
      },
    };
    const opened = await delivery.fileSource.open(openRequest('solo'), {
      signal: context.signal, budgets,
    });
    const reading = opened.read();
    const failure = reading.catch((error: unknown): unknown => error);
    // Dispose while the read still queues behind the transfer permit.
    await new Promise<void>((resolve) => {
      for (let attempt = 0; attempt < 100 && releasePermit === undefined; attempt++) {
        setTimeout(resolve, 0);
        break;
      }
      resolve();
    });
    delivery.dispose();
    const settled = await failure;
    expect(settled).toBeInstanceOf(PhaserPackDeliveryError);
    expect((settled as PhaserPackDeliveryError).code).toBe('disposed');
    void releasePermit;
  });

  it('enforces the byte cap while streaming and cancels on overrun', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(new Uint8Array(1024));
        controller.enqueue(new Uint8Array(1024));
      },
    });
    const response = new Response(stream, { headers: { 'Content-Type': 'application/json' } });
    await expect(readCappedDeliveryBody(response, 1024)).rejects.toThrow(/exceeds 1024/);
  });

  it('fails closed without a stream and an honest content length', async () => {
    // An explicit reader: undefined selects the no-stream path by contract.
    const bodyless = {
      headers: new Headers(),
      arrayBuffer: async (): Promise<ArrayBuffer> => new ArrayBuffer(64),
    } as unknown as Response;
    await expect(readCappedDeliveryBody(bodyless, 16, { reader: undefined })).rejects.toThrow(
      /exceeds 16/,
    );
  });

  it('wraps a throwing custom resolver as a config error for both modes', async () => {
    const origin = await startOrigin();
    servers.push(origin);
    const { manifest } = buildManifest([{ id: 'solo', delivery: 'files' }]);
    const zipManifest = buildManifest([{ id: 'zippy', delivery: 'zip', zip: zipFixture() }]);
    const resolver = (): string => {
      throw new Error('resolver exploded');
    };
    const filesDelivery = createPhaserPackDelivery(manifest, {
      resolveURL: resolver,
    });
    const filesOpened = await filesDelivery.fileSource.open(openRequest('solo'), {
      signal: new AbortController().signal, budgets: budgets(),
    });
    await expect(filesOpened.read()).rejects.toMatchObject({ code: 'config' });
    const zipDelivery = createPhaserPackDelivery(zipManifest.manifest, {
      resolveURL: resolver,
      createWorker: createFakeWorkerFactory().factory,
    });
    await expect(zipDelivery.prepare('zippy')).rejects.toMatchObject({ code: 'config' });
    filesDelivery.dispose();
    zipDelivery.dispose();
  });

  it('starts no archive request when the resolver spends the budget', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const clock = useMonotonicFakeClock();
    try {
      const origin = await startGatedOrigin();
      servers.push(origin);
      const { manifest, packFiles } = buildManifest([{ id: 'solo', delivery: 'zip', zip: zipFixture() }]);
      for (const [path, file] of packFiles) {
        origin.files.set(path, file);
      }
      const workers = createFakeWorkerFactory();
      const delivery = createPhaserPackDelivery(manifest, {
        // The resolver is synchronous user code; it burns the whole
        // budget before the archive request could start.
        resolveURL: (path): string => {
          clock.set(10_001);
          return new URL(path, origin.url).href;
        },
        createWorker: workers.factory,
        prepareTimeoutMs: 10_000,
      });
      await expect(delivery.prepare('solo')).rejects.toMatchObject({ code: 'deadline' });
      expect(origin.requests).toHaveLength(0);
      expect(workers.posted.filter((message) => message.type === 'decode')).toHaveLength(0);
      delivery.dispose();
    } finally {
      vi.restoreAllMocks();
      clock.restore();
      vi.useRealTimers();
    }
  });

  it('keeps the preparation budget when the wall clock jumps forward', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const clock = useMonotonicFakeClock();
    try {
      const origin = await startGatedOrigin();
      servers.push(origin);
      const { manifest, packFiles } = buildManifest([{ id: 'solo', delivery: 'zip', zip: zipFixture() }]);
      for (const [path, file] of packFiles) {
        origin.files.set(path, file);
      }
      const workers = createFakeWorkerFactory();
      const delivery = createPhaserPackDelivery(manifest, {
        baseUrl: origin.url,
        createWorker: workers.factory,
        prepareTimeoutMs: 10_000,
      });
      const archivePath = 'packs/solo@1.zip';
      origin.hold(archivePath);
      const dateNow = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
      const preparing = delivery.prepare('solo');
      await waitForRequest(origin.requests, archivePath);
      // An hour-long forward wall-clock correction mid-download: the
      // monotonic budget must not notice.
      dateNow.mockReturnValue(1_700_000_000_000 + 3_600_000);
      origin.release(archivePath);
      const handles = await preparing;
      handles.release();
      // The decode still received the full unspent budget on the
      // monotonic clock, ten seconds, despite the jump.
      expect(decodeRequest(workers.posted, 0)?.limits.decodeDeadlineMs).toBe(10_000);
      delivery.dispose();
    } finally {
      vi.restoreAllMocks();
      clock.restore();
      vi.useRealTimers();
    }
  });

  it('expires the preparation budget when the wall clock jumps backward', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const clock = useMonotonicFakeClock();
    try {
      const origin = await startOrigin();
      servers.push(origin);
      const { manifest, packFiles } = buildManifest([{ id: 'solo', delivery: 'zip', zip: zipFixture() }]);
      for (const [path, file] of packFiles) {
        origin.files.set(path, file);
      }
      const stallingWorker = (): Worker => ({
        postMessage(): void {
        },
        addEventListener(): void {
        },
        terminate(): void {
        },
      } as unknown as Worker);
      const delivery = createPhaserPackDelivery(manifest, {
        baseUrl: origin.url,
        createWorker: stallingWorker,
        prepareTimeoutMs: 10_000,
      });
      const dateNow = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
      const preparing = delivery.prepare('solo');
      const expectation = expect(preparing).rejects.toMatchObject({ code: 'deadline' });
      // The wall clock falls back an hour; the budget does not grow.
      dateNow.mockReturnValue(0);
      await vi.advanceTimersByTimeAsync(10_000 + 50);
      await expectation;
      delivery.dispose();
    } finally {
      vi.restoreAllMocks();
      clock.restore();
      vi.useRealTimers();
    }
  });

  it('spends one shared budget across dependency archives', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const clock = useMonotonicFakeClock();
    try {
      const origin = await startGatedOrigin();
      servers.push(origin);
      const { manifest, packFiles } = buildManifest([
        { id: 'shared', delivery: 'zip', zip: zipFixture() },
        { id: 'theme', dependsOn: ['shared'], delivery: 'zip', zip: zipFixture() },
      ]);
      for (const [path, file] of packFiles) {
        origin.files.set(path, file);
      }
      const workers = createFakeWorkerFactory();
      const delivery = createPhaserPackDelivery(manifest, {
        baseUrl: origin.url,
        createWorker: workers.factory,
        prepareTimeoutMs: 10_000,
      });
      const sharedPath = 'packs/shared@1.zip';
      const themePath = 'packs/theme@1.zip';
      origin.hold(sharedPath);
      origin.hold(themePath);
      // Always-handled settlement: a transport failure fails the final
      // assertion loudly instead of floating as an unhandled rejection
      // while a gate wait below still spins.
      const settled = delivery.prepare('theme').then(
        (result): { ok: true; release: () => void } => ({ ok: true, release: result.release }),
        (error: unknown): { ok: false; error: unknown } => ({ ok: false, error }),
      );
      await waitForRequest(origin.requests, sharedPath);
      clock.advance(6_000);
      origin.release(sharedPath);
      await waitForRequest(origin.requests, themePath);
      origin.release(themePath);
      const outcome = await settled;
      if (!outcome.ok) {
        throw outcome.error;
      }
      outcome.release();
      // The first archive consumed six seconds of the one budget; the
      // second decode starts from the remainder, not a fresh budget.
      expect(decodeRequest(workers.posted, 0)?.limits.decodeDeadlineMs).toBe(4_000);
      expect(decodeRequest(workers.posted, 1)?.limits.decodeDeadlineMs).toBe(4_000);
      delivery.dispose();
    } finally {
      vi.restoreAllMocks();
      clock.restore();
      vi.useRealTimers();
    }
  });

  it('reduces the decoder budget by the time the download consumed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const clock = useMonotonicFakeClock();
    try {
      const origin = await startGatedOrigin();
      servers.push(origin);
      const { manifest, packFiles } = buildManifest([{ id: 'solo', delivery: 'zip', zip: zipFixture() }]);
      for (const [path, file] of packFiles) {
        origin.files.set(path, file);
      }
      const workers = createFakeWorkerFactory();
      const delivery = createPhaserPackDelivery(manifest, {
        baseUrl: origin.url,
        createWorker: workers.factory,
        prepareTimeoutMs: 10_000,
      });
      const archivePath = 'packs/solo@1.zip';
      origin.hold(archivePath);
      const preparing = delivery.prepare('solo');
      await waitForRequest(origin.requests, archivePath);
      clock.advance(5_000);
      origin.release(archivePath);
      const handles = await preparing;
      handles.release();
      expect(decodeRequest(workers.posted, 0)?.limits.decodeDeadlineMs).toBe(5_000);
      delivery.dispose();
    } finally {
      vi.restoreAllMocks();
      clock.restore();
      vi.useRealTimers();
    }
  });

  it('posts no decode once the shared budget is spent', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const clock = useMonotonicFakeClock();
    try {
      const origin = await startGatedOrigin();
      servers.push(origin);
      const { manifest, packFiles } = buildManifest([{ id: 'solo', delivery: 'zip', zip: zipFixture() }]);
      for (const [path, file] of packFiles) {
        origin.files.set(path, file);
      }
      const workers = createFakeWorkerFactory();
      const delivery = createPhaserPackDelivery(manifest, {
        baseUrl: origin.url,
        createWorker: workers.factory,
        prepareTimeoutMs: 10_000,
      });
      const archivePath = 'packs/solo@1.zip';
      origin.hold(archivePath);
      const preparing = delivery.prepare('solo');
      await waitForRequest(origin.requests, archivePath);
      // The monotonic budget is gone while the abort timer callback is
      // still queued: no decode may start on the spent budget.
      clock.set(10_001);
      origin.release(archivePath);
      await expect(preparing).rejects.toMatchObject({ code: 'deadline' });
      expect(workers.posted.filter((message) => message.type === 'decode')).toHaveLength(0);
      delivery.dispose();
    } finally {
      vi.restoreAllMocks();
      clock.restore();
      vi.useRealTimers();
    }
  });

  it('refuses success handles when the budget ends after the final decode', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const clock = useMonotonicFakeClock();
    try {
      const origin = await startOrigin();
      servers.push(origin);
      const { manifest, packFiles } = buildManifest([{ id: 'solo', delivery: 'zip', zip: zipFixture() }]);
      for (const [path, file] of packFiles) {
        origin.files.set(path, file);
      }
      const workers = createDeferredWorkerFactory();
      const delivery = createPhaserPackDelivery(manifest, {
        baseUrl: origin.url,
        createWorker: workers.factory,
        prepareTimeoutMs: 10_000,
      });
      const preparing = delivery.prepare('solo');
      // The decode exchange runs one message at a time: the entry lands,
      // the client stages it and queues its release, and the terminal
      // reply is still pending when the whole prepare budget is spent.
      while (!workers.step()) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      // Let the client stage the entry and post its release.
      await new Promise<void>((resolve) => setImmediate(resolve));
      const expectation = expect(preparing).rejects.toMatchObject({ code: 'deadline' });
      // Deliver the release: the worker replies 'done' synchronously, the
      // decode completes with every deadline observation still inside the
      // budget — and only then does the monotonic clock cross it.
      workers.step();
      clock.set(10_001);
      await expectation;
      expect(delivery.snapshot().staging).toHaveLength(0);
      delivery.dispose();
    } finally {
      vi.restoreAllMocks();
      clock.restore();
      vi.useRealTimers();
    }
  });

  it('classifies a decoder-side deadline from the entries iterator', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      const origin = await startOrigin();
      servers.push(origin);
      const { manifest, packFiles } = buildManifest([
        { id: 'solo', delivery: 'zip', zip: zipFixture() },
      ]);
      for (const [path, file] of packFiles) {
        origin.files.set(path, file);
      }
      const stallingWorker = (): Worker => {
        const listeners: ((event: { data: unknown }) => void)[] = [];
        return {
          postMessage(): void {
            // Swallow the decode request: the worker never answers, so
            // the decoder deadline inside the tiny prepare budget fires.
          },
          addEventListener(type: string, listener: (event: { data: unknown }) => void): void {
            if (type === 'message') {
              listeners.push(listener);
            }
          },
          terminate(): void {
          },
        } as unknown as Worker;
      };
      const delivery = createPhaserPackDelivery(manifest, {
        baseUrl: origin.url,
        createWorker: stallingWorker,
        prepareTimeoutMs: 10_000,
      });
      const preparing = delivery.prepare('solo');
      const expectation = expect(preparing).rejects.toMatchObject({ code: 'deadline' });
      await vi.advanceTimersByTimeAsync(10_000 + 50);
      await expectation;
      delivery.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects invalid caps in the exported bounded read', async () => {
    const response = new Response(new Blob([new Uint8Array(4)]));
    await expect(readCappedDeliveryBody(response, Number.NaN)).rejects.toMatchObject({
      code: 'config',
      message: expect.stringMatching(/positive integer/),
    });
    await expect(readCappedDeliveryBody(response, Number.POSITIVE_INFINITY)).rejects.toMatchObject({
      code: 'config',
    });
    await expect(readCappedDeliveryBody(response, 0)).rejects.toMatchObject({ code: 'config' });
  });

  it('rejects opened zip reads after disposal', async () => {
    const origin = await startOrigin();
    servers.push(origin);
    const { manifest, packFiles } = buildManifest([{ id: 'solo', delivery: 'zip', zip: zipFixture() }]);
    for (const [path, file] of packFiles) {
      origin.files.set(path, file);
    }
    const delivery = createPhaserPackDelivery(manifest, {
      baseUrl: origin.url,
      createWorker: createFakeWorkerFactory().factory,
    });
    await delivery.prepare('solo');
    const opened = await delivery.fileSource.open(openRequest('solo'), {
      signal: new AbortController().signal, budgets: budgets(),
    });
    delivery.dispose();
    await expect(opened.read()).rejects.toMatchObject({ code: 'disposed' });
  });

  it('classifies a request timeout over a later caller abort', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      // An origin that accepts the request and never finishes the body.
      const { createServer: hangServer } = await import('node:http');
      const server = hangServer((request, response): void => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.write(new Uint8Array(16));
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      const url = `http://127.0.0.1:${(address as { port: number }).port}/`;
      const manifest = {
        format: 'mpgd-asset-packs', version: 1,
        packs: [{
          packId: 'solo', revision: '1', dependencies: [], delivery: 'files',
          assets: [{
            assetKey: 'pilot', kind: 'spritesheet',
            frameConfig: { frameWidth: 8, frameHeight: 8 },
            files: [{
              role: 'texture', mediaType: 'image/png',
              bytes: pngBytes.byteLength, sha256: sha256(pngBytes), path: 'pilot.png',
            }],
          }],
        }],
      };
      const delivery = createPhaserPackDelivery(manifest, {
        baseUrl: url, requestTimeoutMs: 100,
      });
      const context = new AbortController();
      const opened = await delivery.fileSource.open(openRequest('solo'), {
        signal: context.signal, budgets: budgets(),
      });
      const reading = opened.read();
      const rejection = expect(reading).rejects.toMatchObject({
        code: 'transport',
        message: expect.stringMatching(/timed out/),
      });
      // The request timeout fires first; the caller aborts later in the
      // same turn — the first cause must win.
      await vi.advanceTimersByTimeAsync(100);
      context.abort();
      await rejection;
      delivery.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    } finally {
      vi.useRealTimers();
    }
  });

  it('validates configuration before any work', () => {
    const { manifest } = buildManifest([{ id: 'solo', delivery: 'files' }]);
    expect(() => createPhaserPackDelivery(manifest, {})).toThrow(PhaserPackDeliveryError);
    expect(() => createPhaserPackDelivery(manifest, {
      baseUrl: 'http://127.0.0.1:1/',
      resolveURL: (path): string => path,
    })).toThrow(/exactly one/);
    expect(() => createPhaserPackDelivery(manifest, {
      baseUrl: 'http://127.0.0.1:1/',
      stagingBudgetBytes: 0,
    })).toThrow(/positive integer/);
    expect(() => createPhaserPackDelivery(manifest, {
      baseUrl: 'http://127.0.0.1:1/',
      prepareTimeoutMs: 2 ** 31,
    })).toThrow(/platform timer range/);
    const { manifest: zipManifest } = buildManifest([{ id: 'solo', delivery: 'zip', zip: zipFixture() }]);
    expect(() => createPhaserPackDelivery(zipManifest, {
      baseUrl: 'http://127.0.0.1:1/',
    })).toThrow(/createWorker/);
    expect(() => createPhaserPackDelivery({ format: 'mpgd-asset-packs' }, {
      baseUrl: 'http://127.0.0.1:1/',
    })).toThrow(PhaserPackDeliveryError);
  });
});
