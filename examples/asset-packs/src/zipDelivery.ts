import {
  createBoundedZipDecoder,
  defaultArchiveWorkerLimits,
  type ArchiveWorkerExpected,
} from '@mpgd/phaser-assets/archives';
import {
  PHASER_PACK_DELIVERY_VERSION,
  validatePhaserPackDeliveryManifest,
  type PhaserPackDeliveryManifest,
  type PhaserPackDeliveryPack,
} from '@mpgd/phaser-assets/pack-format';
import type {
  PhaserAssetPack,
  PhaserPackAsset,
  PhaserPackFileBody,
  PhaserPackFileIntegrity,
  PhaserPackFileSource,
} from '@mpgd/phaser-assets/packs';

/** Options are validated once, before any async work: later caller mutation
 * of the options object cannot change an in-flight delivery. */
export interface ZipPackDeliveryOptions {
  /** Delivery manifest URL; artifact paths resolve against its directory. */
  readonly manifestUrl: string;
  /** Factory for the application-deployed module worker (#191 contract). */
  readonly createWorker: () => Worker;
  /** Finite cap on simultaneously staged archive+expanded bytes. */
  readonly stagingBudgetBytes: number;
  /** Deadline for one whole prepare; stages and retries never restart it. */
  readonly prepareTimeoutMs: number;
  /** Per HTTP attempt deadline: manifest, each archive, each files file. */
  readonly requestTimeoutMs: number;
  /** Per-file transport cap for files-delivery packs. */
  readonly maxFileBytes: number;
}

export interface PreparedZipPack {
  /** Return this preparation's stake in the staged packs. Bytes survive
   * while another handle or an open reader still references them. */
  release(): void;
}

export interface ZipDeliveryStaging {
  readonly packId: string;
  readonly revision: string;
  readonly handles: number;
  readonly openReaders: number;
  readonly reservationBytes: number;
}

export interface ZipDeliverySnapshot {
  readonly stagingUsedBytes: number;
  readonly stagingBudgetBytes: number;
  readonly archiveRequests: number;
  readonly fileRequests: number;
  readonly staging: readonly ZipDeliveryStaging[];
}

export interface ZipPackDelivery {
  /** Loader catalog derived once from the delivery manifest. */
  readonly catalog: readonly PhaserAssetPack[];
  /** Supplies staged ZIP entries; files-delivery packs stay plain HTTP. */
  readonly fileSource: PhaserPackFileSource;
  /** Stage a pack and its dependency closure. Single-flight: a concurrent
   * prepare rejects with a busy error instead of racing the budget. */
  prepare(packId: string, options?: { readonly signal?: AbortSignal }): Promise<PreparedZipPack>;
  /** Stop everything: aborts an active prepare and drops all staging. */
  dispose(): void;
  snapshot(): ZipDeliverySnapshot;
}

interface RoleFile {
  readonly mediaType: string;
  readonly path: string;
}

interface PackIndexEntry {
  readonly pack: PhaserPackDeliveryPack;
  /** `${assetKey}\u0000${role}` → media type and delivery file path. */
  readonly roles: ReadonlyMap<string, RoleFile>;
}

interface StagedPack {
  readonly pack: PhaserPackDeliveryPack;
  readonly files: ReadonlyMap<string, { readonly bytes: Uint8Array; readonly mediaType: string }>;
  readonly reservationBytes: number;
  handles: number;
  openReaders: number;
}

/** View-safe Blob part: copies the exact visible range, so a subarray
 * view over a larger buffer cannot leak unrelated bytes into a Blob. */
const blobPart = (bytes: Uint8Array): BlobPart => bytes.slice();

/** One HTTP attempt whose window ends with the body: headers, capped
 * stream and settle semantics in a single place for every call site. */
const fetchDeliveryBytes = async (
  url: string,
  timeoutMs: number,
  signal: AbortSignal,
  cap: number,
  describeFailure: (status: number) => string,
): Promise<Uint8Array> => {
  const attempt = fetchWithin(url, timeoutMs, signal);
  try {
    const response = await attempt.response;
    if (!response.ok) {
      throw new Error(describeFailure(response.status));
    }
    return await attempt.body(cap);
  } finally {
    attempt.settle();
  }
};

const MANIFEST_BYTE_CAP = 4 * 1024 * 1024;

const sha256Hex = async (data: Uint8Array): Promise<string> => {
  // Hash the exact visible range: a view over a larger buffer must not
  // digest bytes outside its own span.
  const view: BufferSource = data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
    ? (data.buffer instanceof ArrayBuffer ? data.buffer : new Uint8Array(data))
    : data.slice();
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', view));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

const positiveInteger = (value: number, label: string): void => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Zip delivery ${label} must be a positive integer`);
  }
};

/** Timeouts feed platform timers: delays beyond 2^31-1 clamp or wrap into
 * firing immediately, so oversized values must fail validation instead of
 * producing instant, misleading deadline errors. */
const timerRangeInteger = (value: number, label: string): void => {
  positiveInteger(value, label);
  if (value > 2 ** 31 - 1) {
    throw new Error(`Zip delivery ${label} exceeds the platform timer range`);
  }
};

/** One HTTP GET under an explicit timeout; the outer signal (caller abort or
 * the whole-delivery shutdown) aborts it too. This fixture retries nothing. */
const fetchWithin = (url: string, timeoutMs: number, signal: AbortSignal): {
  readonly response: Promise<Response>;
  readonly body: (cap: number) => Promise<Uint8Array>;
  readonly settle: () => void;
} => {
  const controller = new AbortController();
  const timer = setTimeout((): void => controller.abort(
    new Error('Delivery request timed out'),
  ), timeoutMs);
  // Forward the outer abort's reason (caller cancel, whole-prepare deadline,
  // delivery shutdown) instead of degrading it to a generic AbortError.
  const forward = (): void => controller.abort(signal.reason);
  signal.addEventListener('abort', forward, { once: true });
  // The HTTP window ends with the body, not the headers: the attempt
  // controller stays armed while the body streams, and an abort cancels
  // the reader instead of leaving it pending forever.
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const attempt = fetch(url, { signal: controller.signal, cache: 'no-store' }).then(
    (response) => {
      reader = response.body?.getReader();
      return response;
    },
    (error) => {
      if (signal.aborted) throw error;
      throw new Error(`Delivery request timed out or failed (${url})`);
    },
  );
  const settle = (): void => {
    clearTimeout(timer);
    signal.removeEventListener('abort', forward);
    // A caller that threw on !response.ok never drains the body: cancel the
    // locked reader so the connection returns to the pool. Cancelling an
    // already-drained reader is a no-op.
    void reader?.cancel().catch(() => undefined);
  };
  return {
    response: attempt,
    body: async (cap: number) => {
      try {
        const response = await attempt;
        return await readCapped(url, response, reader, cap);
      } finally {
        settle();
      }
    },
    settle,
  };
};

const readCapped = async (
  url: string,
  response: Response,
  reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
  cap: number,
): Promise<Uint8Array> => {
  if (reader === undefined) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > cap) {
      throw new Error(`Delivery response exceeds its declared size: ${url}`);
    }
    return new Uint8Array(buffer);
  }
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > cap) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`Delivery response exceeds its declared size: ${url}`);
    }
    chunks.push(value);
  }
  const whole = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    whole.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return whole;
};


/** Uncompressed file bytes of a pack: the single source for the staging
 * reservation, the pre-network budget check and the decoder's total
 * expanded limit, so the three can never drift apart. */
const expandedBytesOf = (pack: PhaserPackDeliveryPack): number => pack.assets
  .flatMap((asset) => asset.files)
  .reduce((sum, file) => sum + file.bytes, 0);

const integrityOf = (file: { readonly bytes: number; readonly sha256: string }): PhaserPackFileIntegrity => ({
  bytes: file.bytes,
  sha256: file.sha256,
});

const loaderAsset = (
  pack: PhaserPackDeliveryPack,
  asset: PhaserPackDeliveryPack['assets'][number],
): PhaserPackAsset => {
  const fileFor = (role: 'texture' | 'atlas') => {
    const file = asset.files.find((candidate) => candidate.role === role);
    if (file === undefined) {
      throw new Error(`Delivery pack ${pack.packId} lacks a ${role} file for ${asset.assetKey}`);
    }
    return file;
  };
  const texture = fileFor('texture');
  if (asset.kind === 'atlas') {
    const atlas = fileFor('atlas');
    return {
      kind: 'atlas',
      key: asset.assetKey,
      textureUrl: texture.path,
      atlasUrl: atlas.path,
      integrity: { texture: integrityOf(texture), atlas: integrityOf(atlas) },
    };
  }
  if (asset.kind === 'spritesheet') {
    if (asset.frameConfig === undefined) {
      throw new Error(`Delivery pack ${pack.packId} lacks frame config for ${asset.assetKey}`);
    }
    return {
      kind: 'spritesheet',
      key: asset.assetKey,
      url: texture.path,
      frameConfig: {
        frameWidth: asset.frameConfig.frameWidth,
        frameHeight: asset.frameConfig.frameHeight,
        ...(asset.frameConfig.startFrame === undefined ? {} : { startFrame: asset.frameConfig.startFrame }),
        ...(asset.frameConfig.endFrame === undefined ? {} : { endFrame: asset.frameConfig.endFrame }),
        ...(asset.frameConfig.margin === undefined ? {} : { margin: asset.frameConfig.margin }),
        ...(asset.frameConfig.spacing === undefined ? {} : { spacing: asset.frameConfig.spacing }),
      },
      integrity: { texture: integrityOf(texture) },
    };
  }
  return {
    kind: 'image',
    key: asset.assetKey,
    url: texture.path,
    integrity: { texture: integrityOf(texture) },
  };
};

/** Expected description handed to the #191 decoder: entries in manifest
 * order, which is the deterministic writer's archive order. */
const expectedFor = (pack: PhaserPackDeliveryPack): ArchiveWorkerExpected => ({
  formatVersion: PHASER_PACK_DELIVERY_VERSION,
  archive: {
    bytes: pack.archive!.bytes,
    sha256: pack.archive!.sha256,
  },
  entries: pack.assets.flatMap((asset) => asset.files.map((file) => ({
    path: file.path,
    method: file.method!,
    bytes: file.bytes,
    sha256: file.sha256,
  }))),
});

export async function createZipPackDelivery(options: ZipPackDeliveryOptions): Promise<ZipPackDelivery> {
  positiveInteger(options.stagingBudgetBytes, 'staging budget');
  timerRangeInteger(options.prepareTimeoutMs, 'prepare timeout');
  timerRangeInteger(options.requestTimeoutMs, 'request timeout');
  positiveInteger(options.maxFileBytes, 'file byte cap');
  const manifestUrl = new URL(options.manifestUrl, globalThis.location.href);
  const manifestRoot = new URL('./', manifestUrl);
  const shutdown = new AbortController();

  const manifestBytes = await fetchDeliveryBytes(
    manifestUrl.href,
    options.requestTimeoutMs,
    shutdown.signal,
    MANIFEST_BYTE_CAP,
    (status): string => `Delivery manifest request failed with HTTP ${status}`,
  );
  // The manifest is validated and cloned once: it is the single source of
  // catalog, staging and verification truth for the delivery's lifetime.
  const manifest: PhaserPackDeliveryManifest = validatePhaserPackDeliveryManifest(
    structuredClone(JSON.parse(new TextDecoder().decode(manifestBytes))),
  );

  const packIndex = new Map<string, PackIndexEntry>();
  for (const pack of manifest.packs) {
    const roles = new Map<string, RoleFile>();
    for (const asset of pack.assets) {
      for (const file of asset.files) {
        roles.set(`${asset.assetKey}\u0000${file.role}`, { mediaType: file.mediaType, path: file.path });
      }
    }
    packIndex.set(pack.packId, { pack, roles });
  }
  const catalog: PhaserAssetPack[] = manifest.packs.map((pack) => ({
    id: pack.packId,
    revision: pack.revision,
    dependsOn: pack.dependencies.map((dependency) => dependency.packId),
    assets: pack.assets.map((asset) => loaderAsset(pack, asset)),
  }));

  const staged = new Map<string, StagedPack>();
  let stagingUsedBytes = 0;
  let archiveRequests = 0;
  let fileRequests = 0;
  let disposed = false;
  let activePrepare = false;

  const assertLive = (): void => {
    if (disposed) throw new Error('Zip pack delivery is disposed');
  };

  const closureOf = (packId: string): PhaserPackDeliveryPack[] => {
    const ordered: PhaserPackDeliveryPack[] = [];
    const visited = new Set<string>();
    const visit = (id: string): void => {
      if (visited.has(id)) return;
      visited.add(id);
      const entry = packIndex.get(id);
      if (entry === undefined) throw new Error(`Unknown delivery pack: ${id}`);
      for (const dependency of entry.pack.dependencies) visit(dependency.packId);
      ordered.push(entry.pack);
    };
    visit(packId);
    return ordered;
  };

  const unstage = (pack: StagedPack): void => {
    if (pack.handles > 0 || pack.openReaders > 0) return;
    // Identity guards the accounting: a newer prepare may have restaged the
    // same pack id, and a dispose may have cleared the map entirely —
    // neither may drive the mirror counter for this older instance.
    if (staged.get(pack.pack.packId) !== pack) return;
    staged.delete(pack.pack.packId);
    stagingUsedBytes -= pack.reservationBytes;
  };

  const decoder = createBoundedZipDecoder({ createWorker: options.createWorker });

  const stagePack = async (
    pack: PhaserPackDeliveryPack,
    deadlineAt: number,
    signal: AbortSignal,
  ): Promise<StagedPack> => {
    const archive = pack.archive;
    if (archive === undefined) {
      throw new Error(`Delivery pack ${pack.packId} has no archive description`);
    }
    const url = new URL(archive.path, manifestRoot);
    archiveRequests++;
    const bytes = await fetchDeliveryBytes(
      url.href,
      options.requestTimeoutMs,
      signal,
      archive.bytes,
      (status): string => `Delivery archive request failed with HTTP ${status} (${pack.packId})`,
    );
    if (bytes.byteLength !== archive.bytes) {
      throw new Error(`Delivery archive size mismatch for ${pack.packId}: ${bytes.byteLength} of ${archive.bytes}`);
    }
    if (await sha256Hex(bytes) !== archive.sha256) {
      throw new Error(`Delivery archive digest mismatch for ${pack.packId}`);
    }
    const expected = expectedFor(pack);
    const expandedBytes = expandedBytesOf(pack);
    // The whole-prepare deadline is never restarted; the decoder only ever
    // receives the unspent remainder, exactly as #191 prescribes.
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) {
      throw new Error('Zip pack preparation exceeded its deadline');
    }
    const job = decoder.decode({
      archive: bytes,
      expected,
      limits: {
        archiveBytes: archive.bytes,
        entryBytes: Math.max(...expected.entries.map((entry) => entry.bytes)),
        totalExpandedBytes: expandedBytes,
        entryCount: expected.entries.length,
        maxPathLength: defaultArchiveWorkerLimits().maxPathLength,
        decodeDeadlineMs: remainingMs,
      },
    });
    const mediaByPath = new Map(pack.assets.flatMap((asset) => asset.files.map((file) => [file.path, file.mediaType] as const)));
    const files = new Map<string, { readonly bytes: Uint8Array; readonly mediaType: string }>();
    try {
      for await (const entry of job.entries) {
        // Caller cancel and dispose() stop the decode promptly: without this
        // check the worker keeps burning CPU until the unspent decode
        // deadline, and a superseded enter delays its successor by that
        // much.
        if (signal.aborted) {
          throw new Error('Zip pack preparation was cancelled');
        }
        if (!mediaByPath.has(entry.path)) {
          throw new Error(`Delivery archive ${pack.packId} delivered an unlisted entry: ${entry.path}`);
        }
        files.set(entry.path, { bytes: entry.bytes, mediaType: mediaByPath.get(entry.path)! });
      }
      const status = await job.result;
      if (status.status !== 'completed') {
        throw new Error(`Delivery archive ${pack.packId} did not decode completely: ${status.status}${status.code === undefined ? '' : ` (${status.code})`}`);
      }
      if (files.size !== expected.entries.length) {
        throw new Error(`Delivery archive ${pack.packId} staged ${files.size} of ${expected.entries.length} entries`);
      }
    } catch (error) {
      void job.cancel().catch(() => undefined);
      throw error;
    }
    const stagedPack: StagedPack = {
      pack,
      files,
      reservationBytes: archive.bytes + expandedBytes,
      handles: 0,
      openReaders: 0,
    };
    staged.set(pack.packId, stagedPack);
    stagingUsedBytes += stagedPack.reservationBytes;
    return stagedPack;
  };

  const fileSource: PhaserPackFileSource = {
    async open(request, context) {
      assertLive();
      const entry = packIndex.get(request.packId);
      if (entry === undefined) throw new Error(`Unknown delivery pack: ${request.packId}`);
      if (request.revision !== entry.pack.revision) {
        throw new Error(`Delivery pack revision mismatch for ${request.packId}: ${request.revision}`);
      }
      const role = entry.roles.get(`${request.assetKey}\u0000${request.role}`);
      if (role === undefined) {
        throw new Error(`Delivery pack ${request.packId} has no ${request.role} file for ${request.assetKey}`);
      }
      if (entry.pack.delivery === 'files') {
        let readOnce = false;
        let transfer: (() => void) | undefined;
        return {
          async read(): Promise<PhaserPackFileBody> {
            if (readOnce) throw new Error('Delivery file body was already read');
            readOnce = true;
            try {
              transfer = await context.budgets.transfers.acquire(context.signal);
              fileRequests++;
              const url = new URL(role.path, manifestRoot);
              const bytes = await fetchDeliveryBytes(
                url.href,
                options.requestTimeoutMs,
                context.signal,
                options.maxFileBytes,
                (status): string => `Delivery file request failed with HTTP ${status} (${request.packId})`,
              );
              return {
                bytes: new Blob([blobPart(bytes)], { type: role.mediaType }),
                release(): void {
                },
              };
            } catch (error) {
              readOnce = false;
              throw error;
            } finally {
              transfer?.();
            }
          },
          close(): void {
          },
        };
      }
      const stagedPack = staged.get(request.packId);
      if (stagedPack === undefined) {
        throw new Error(`Zip delivery pack is not prepared: ${request.packId}`);
      }
      const stagedFile = stagedPack.files.get(role.path);
      if (stagedFile === undefined) {
        throw new Error(`Zip delivery pack ${request.packId} is missing staged entry ${role.path}`);
      }
      // One reader claim per open; the claim returns when the loader closes
      // the file, whether or not the body was read.
      stagedPack.openReaders++;
      let readOnce = false;
      let closed = false;
      return {
        async read(): Promise<PhaserPackFileBody> {
          if (closed) throw new Error('Delivery file was already closed');
          if (readOnce) throw new Error('Delivery file body was already read');
          readOnce = true;
          return {
            bytes: new Blob([blobPart(stagedFile.bytes)], { type: stagedFile.mediaType }),
            release(): void {
            },
          };
        },
        close(): void {
          if (closed) return;
          closed = true;
          if (disposed) return;
          stagedPack.openReaders--;
          unstage(stagedPack);
        },
      };
    },
  };

  return {
    catalog,
    fileSource,
    async prepare(packId, prepareOptions = {}) {
      assertLive();
      if (activePrepare) throw new Error('Another zip pack preparation is already running');
      const closure = closureOf(packId);
      const zipPacks = closure.filter((pack) => pack.delivery === 'zip');
      const missing = zipPacks.filter((pack) => !staged.has(pack.packId));
      // Reservation is archive bytes plus every expanded file byte, computed
      // for the whole closure before any network work: an oversized prepare
      // is rejected without a single request.
      const need = missing.reduce((sum, pack) => sum + pack.archive!.bytes + expandedBytesOf(pack), 0);
      if (stagingUsedBytes + need > options.stagingBudgetBytes) {
        throw new Error(`Zip staging budget exceeded: preparing ${packId} needs ${need} bytes with ${stagingUsedBytes} staged, over the ${options.stagingBudgetBytes} byte budget`);
      }
      activePrepare = true;
      const controller = new AbortController();
      const deadlineAt = Date.now() + options.prepareTimeoutMs;
      const timer = setTimeout(
        (): void => controller.abort(new Error('Zip pack preparation exceeded its deadline')),
        options.prepareTimeoutMs,
      );
      // Caller cancel and delivery shutdown forward the triggering signal's
      // own reason (the event target is whichever of the two fired), so the
      // surfaced message stays the intended one; the deadline passes its
      // reason directly through the timer abort above.
      const forward = (event: Event): void => {
        const reason = (event.target as AbortSignal).reason;
        controller.abort(reason instanceof Error ? reason : new Error('Zip pack preparation was cancelled'));
      };
      prepareOptions.signal?.addEventListener('abort', forward, { once: true });
      // dispose() stops an in-flight prepare too, not just future calls.
      shutdown.signal.addEventListener('abort', forward, { once: true });
      const newlyStaged: StagedPack[] = [];
      const acquired: StagedPack[] = [];
      try {
        if (prepareOptions.signal?.aborted || shutdown.signal.aborted) {
          throw new Error('Zip pack preparation was cancelled');
        }
        for (const pack of missing) {
          const stagedPack = await stagePack(pack, deadlineAt, controller.signal);
          // dispose() during an await drops everything: a late stagePack
          // result must not repopulate a cleared delivery.
          if (disposed) {
            unstage(stagedPack);
            throw new Error('Zip pack delivery was disposed during preparation');
          }
          newlyStaged.push(stagedPack);
        }
        // Hoisted so a lost-staging throw partway through the acquisition
        // loop rolls back the handles already taken (see the catch below).
        let handleReleased = false;
        for (const pack of zipPacks) {
          const stagedPack = staged.get(pack.packId);
          if (stagedPack === undefined) {
            // A handle released while this prepare awaited staging dropped
            // the last reference; the loader will report not-prepared.
            throw new Error(`Zip delivery pack lost its staging during preparation: ${pack.packId}`);
          }
          stagedPack.handles++;
          acquired.push(stagedPack);
        }
        return {
          release(): void {
            if (handleReleased) return;
            handleReleased = true;
            // Release only the instances this prepare acquired, so a newer
            // restage of the same pack id keeps its own staging.
            for (const stagedPack of acquired) {
              stagedPack.handles--;
              unstage(stagedPack);
            }
          },
        };
      } catch (error) {
        for (const stagedPack of acquired) {
          stagedPack.handles--;
          unstage(stagedPack);
        }
        for (const stagedPack of newlyStaged) unstage(stagedPack);
        throw error;
      } finally {
        clearTimeout(timer);
        prepareOptions.signal?.removeEventListener('abort', forward);
        shutdown.signal.removeEventListener('abort', forward);
        activePrepare = false;
      }
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      shutdown.abort();
      for (const stagedPack of staged.values()) {
        stagedPack.handles = 0;
        stagedPack.openReaders = 0;
      }
      staged.clear();
      stagingUsedBytes = 0;
    },
    snapshot(): ZipDeliverySnapshot {
      return {
        stagingUsedBytes,
        stagingBudgetBytes: options.stagingBudgetBytes,
        archiveRequests,
        fileRequests,
        staging: [...staged.values()].map((stagedPack) => ({
          packId: stagedPack.pack.packId,
          revision: stagedPack.pack.revision,
          handles: stagedPack.handles,
          openReaders: stagedPack.openReaders,
          reservationBytes: stagedPack.reservationBytes,
        })),
      };
    },
  };
}
