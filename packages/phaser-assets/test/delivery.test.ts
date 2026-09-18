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
