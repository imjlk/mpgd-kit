import { createHash, type Hash } from 'node:crypto';
import { createReadStream, type ReadStream } from 'node:fs';
import { lstat, open, readdir, realpath, stat, type FileHandle } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  verifyZipV1Archive,
  ZipDecodeError,
  type ExpectedZipArchive,
} from '@mpgd/phaser-assets/archive-validation';
import {
  validatePhaserPackDeliveryManifest,
  type PhaserPackDeliveryManifest,
  type PhaserPackDeliveryPack,
} from '@mpgd/phaser-assets/pack-format';

/** One verification failure with the stage and stable code it surfaced at. */
export interface AssetPackVerifyFailure {
  readonly stage: 'args' | 'manifest' | 'paths' | 'files' | 'archive' | 'limits';
  readonly code: string;
  readonly message: string;
  readonly packId?: string | undefined;
}

/** Optional static-host object limits; all finite positive safe integers. */
export interface AssetPackVerifyHostLimits {
  readonly maxObjectBytes?: number | undefined;
  readonly maxFiles?: number | undefined;
  readonly maxTotalBytes?: number | undefined;
}

export interface AssetPackVerifyReport {
  readonly ok: boolean;
  readonly manifest: {
    readonly sha256: string;
    readonly bytes: number;
    readonly format: string;
    readonly version: number;
    readonly packs: number;
  };
  /** Referenced objects: exactly what the chosen manifest requires. */
  readonly referenced: {
    readonly files: number;
    readonly bytes: number;
  };
  /** Root inventory: every regular file physically under --root. Only
   * computed when host limits are requested. */
  readonly inventory?: {
    readonly files: number;
    readonly bytes: number;
    readonly truncated: boolean;
  } | undefined;
  readonly archives: readonly {
    readonly packId: string;
    readonly entries: number;
    readonly expandedBytes: number;
  }[];
  readonly limits?: AssetPackVerifyHostLimits | undefined;
  readonly failures: readonly AssetPackVerifyFailure[];
  /** Conditions this local, read-only check cannot verify. */
  readonly notVerified: readonly string[];
}

export interface AssetPackVerifyOptions {
  /** Path to the delivery manifest JSON document. */
  readonly manifestPath: string;
  /** Deployment root the manifest artifact paths resolve against. */
  readonly root: string;
  readonly hostLimits?: AssetPackVerifyHostLimits | undefined;
  /** Cap on the manifest document itself; default 32 MiB. */
  readonly manifestByteCap?: number | undefined;
  /** Whole-verification wall-clock budget in milliseconds; default 120000. */
  readonly verifyTimeoutMs?: number | undefined;
  /** Cap on a single zip archive materialized for decode; default 512 MiB.
   * Larger declared archives fail at the limits stage before buffering. */
  readonly maxArchiveBytes?: number | undefined;
}

const DEFAULT_MANIFEST_BYTE_CAP = 32 * 1024 * 1024;
const DEFAULT_VERIFY_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const STREAM_CHUNK_BYTES = 1024 * 1024;
/** Inventory walking stops beyond this many files so an accidental root
 * choice cannot turn verification into an unbounded traversal; the report
 * marks the count truncated instead of failing silently. */
const INVENTORY_FILE_CAP = 1_000_000;
/** Same manifest artifact colliding under case folding means the deployment
 * is ambiguous on case-insensitive hosts. */
/** Case-fold the collision key unconditionally: the verifier's host is not
 * the deployment's consumers, and case-duplicate artifacts are ambiguous
 * for any case-insensitive host or CDN regardless of where this runs. */
const caseKeyOf = (resolvedPath: string): string => resolvedPath.toLowerCase();

const NOT_VERIFIED: readonly string[] = [
  'CDN cache state and origin preservation',
  'HTTP CORS and Content-Type responses',
  'Application image display and device compatibility',
  'Server access control',
  'Atomic multi-file deployment swaps',
];

type FailureSink = AssetPackVerifyFailure[];

const failWith = (
  failures: FailureSink,
  stage: AssetPackVerifyFailure['stage'],
  code: string,
  message: string,
  packId?: string,
): void => {
  failures.push(packId === undefined ? { stage, code, message } : { stage, code, message, packId });
};

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const positiveIntegerOption = (
  failures: FailureSink,
  name: string,
  value: number | undefined,
): boolean => {
  if (value === undefined) {
    return true;
  }
  if (!Number.isSafeInteger(value) || value <= 0) {
    failWith(failures, 'args', 'invalid-option', `${name} must be a positive integer`);
    return false;
  }
  return true;
};

/** Thrown by I/O helpers when the whole-verification budget expires
 * mid-read; the failure itself is recorded exactly once by
 * `deadlineBreached` before this sentinel propagates. */
class VerifyDeadlineError extends Error {}

/** Streaming SHA-256 over an already-opened descriptor: never buffers the
 * whole file, the hash reads every actual byte rather than trusting stat
 * or Content-Length alone, and the bytes hashed are the same inode the
 * path checks validated — a component swapped for a symlink after the
 * check cannot redirect this read. */
const streamSha256 = async (
  path: string,
  handle: FileHandle,
  hasher: Hash,
  onChunk?: () => void,
): Promise<{ bytes: number; sha256: string }> => {
  let bytes = 0;
  const stream = handle.createReadStream({ highWaterMark: STREAM_CHUNK_BYTES });
  try {
    for await (const chunk of stream) {
      const view = chunk as Buffer;
      bytes += view.byteLength;
      hasher.update(view);
      onChunk?.();
    }
  } catch (error) {
    if (error instanceof VerifyDeadlineError) {
      throw error;
    }
    // A file changing mid-verification (size or content) surfaces as a
    // read failure rather than a digest mismatch.
    throw new Error(`Could not read ${path}: ${errorText(error)}`);
  }
  return { bytes, sha256: hasher.digest('hex') };
};

/** Resolve one manifest artifact path under the root, rejecting absolute
 * paths, traversal, symlinks and non-regular files — checking each path
 * component by lstat so a symlink cannot hide mid-path. */
const resolveArtifactPath = async (
  root: string,
  realRoot: string,
  artifactPath: string,
): Promise<string> => {
  if (artifactPath.length === 0) {
    throw new Error('Artifact path is empty');
  }
  if (
    isAbsolute(artifactPath)
    || /^[a-zA-Z]:[/\\]/u.test(artifactPath)
    || artifactPath.startsWith('\\\\')
  ) {
    throw new Error(`Artifact path must be relative: ${artifactPath}`);
  }
  let current = root;
  for (const segment of artifactPath.split(/[\\/]/u)) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      throw new Error(`Artifact path escapes the root: ${artifactPath}`);
    }
    current = join(current, segment);
    let stat;
    try {
      stat = await lstat(current);
    } catch {
      throw new Error(`Artifact path is missing: ${artifactPath}`);
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`Artifact path must not contain symbolic links: ${artifactPath}`);
    }
  }
  const stat = await lstat(current);
  if (!stat.isFile()) {
    throw new Error(`Artifact path is not a regular file: ${artifactPath}`);
  }
  const rel = relative(realRoot, await realpath(current));
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Artifact path escapes the root: ${artifactPath}`);
  }
  return current;
};

/** Count every regular file under the root for host-limit accounting.
 * Symlinks are skipped: they are not deployed objects, and manifest
 * artifacts reject them independently. */
const inventoryRoot = async (
  root: string,
  onEntry?: () => void,
): Promise<{ files: number; bytes: number; truncated: boolean }> => {
  let files = 0;
  let bytes = 0;
  let truncated = false;
  const walk = async (directory: string): Promise<void> => {
    if (files >= INVENTORY_FILE_CAP) {
      truncated = true;
      return;
    }
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      onEntry?.();
      if (files >= INVENTORY_FILE_CAP) {
        truncated = true;
        return;
      }
      const child = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        await walk(child);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const stat = await lstat(child);
      files++;
      bytes += stat.size;
    }
  };
  await walk(root);
  return { files, bytes, truncated };
};

const readManifestCapped = async (
  manifestPath: string,
  cap: number,
): Promise<Buffer> => {
  const stream: ReadStream = createReadStream(resolve(manifestPath), {
    highWaterMark: STREAM_CHUNK_BYTES,
  });
  const chunks: Buffer[] = [];
  let received = 0;
  try {
    for await (const chunk of stream) {
      const view = chunk as Buffer;
      received += view.byteLength;
      if (received > cap) {
        stream.destroy();
        throw new Error(`Delivery manifest exceeds ${cap} bytes`);
      }
      chunks.push(view);
    }
  } catch (error) {
    if (received > cap) {
      throw error;
    }
    throw new Error(`Could not read the delivery manifest: ${errorText(error)}`);
  }
  return Buffer.concat(chunks);
};

/** Read exactly `bytes` bytes from the same descriptor the hash read —
 * a file changing size between the hash and this read fails instead of
 * verifying different bytes. */
const readExact = async (
  path: string,
  handle: FileHandle,
  bytes: number,
  onChunk?: () => void,
): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  let received = 0;
  const stream = handle.createReadStream({ highWaterMark: STREAM_CHUNK_BYTES });
  try {
    for await (const chunk of stream) {
      const view = chunk as Buffer;
      received += view.byteLength;
      if (received > bytes) {
        stream.destroy();
        throw new Error(`Archive grew while being read: ${path}`);
      }
      chunks.push(view);
      onChunk?.();
    }
  } catch (error) {
    if (error instanceof VerifyDeadlineError) {
      throw error;
    }
    throw new Error(`Could not read the archive at ${path}: ${errorText(error)}`);
  }
  if (received !== bytes) {
    throw new Error(`Archive shrank while being read: ${path}`);
  }
  return Buffer.concat(chunks);
};

const expectedOf = (pack: PhaserPackDeliveryPack): ExpectedZipArchive => ({
  formatVersion: 1,
  archive: {
    bytes: pack.archive?.bytes ?? 0,
    sha256: pack.archive?.sha256 ?? '',
  },
  entries: pack.assets.flatMap((asset) => asset.files.map((file) => ({
    path: file.path,
    method: file.method ?? 'store',
    bytes: file.bytes,
    sha256: file.sha256,
  }))),
});

/** Core decode limits follow the manifest's own declarations: the archive
 * byte limit is the declared archive size (already verified by hash), the
 * expanded limits are the manifest's file byte sums, and the deadline is
 * the unspent remainder of the whole-verification budget. */
const coreLimitsOf = (
  pack: PhaserPackDeliveryPack,
  remainingMs: number,
): {
  archiveBytes: number;
  entryBytes: number;
  totalExpandedBytes: number;
  entryCount: number;
  maxPathLength: number;
  decodeDeadlineMs: number;
} => {
  const expanded = pack.assets.reduce(
    (sum, asset) => sum + asset.files.reduce((n, file) => n + file.bytes, 0),
    0,
  );
  return {
    archiveBytes: pack.archive?.bytes ?? 0,
    entryBytes: Math.max(
      1,
      pack.assets.reduce(
        (max, asset) => asset.files.reduce((inner, file) => Math.max(inner, file.bytes), max),
        1,
      ),
    ),
    totalExpandedBytes: Math.max(1, expanded),
    entryCount: Math.max(1, pack.archive?.entryCount ?? 0),
    maxPathLength: 4096,
    decodeDeadlineMs: Math.max(1, remainingMs),
  };
};

/** Verify a delivery manifest's referenced artifacts against a deployment
 * root: read-only, deterministic, no network and no extraction. Every
 * referenced byte is read and hashed; zip archives are additionally decoded
 * through the shared pure core. Verification continues after the first
 * failure so one report can carry every distinct problem. */
export async function verifyAssetPackDelivery(
  options: AssetPackVerifyOptions,
): Promise<AssetPackVerifyReport> {
  const failures: FailureSink = [];
  const manifestByteCap = options.manifestByteCap ?? DEFAULT_MANIFEST_BYTE_CAP;
  const verifyTimeoutMs = options.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS;
  const maxArchiveBytes = options.maxArchiveBytes ?? DEFAULT_MAX_ARCHIVE_BYTES;
  const hostLimits = options.hostLimits;
  const usedLimits: AssetPackVerifyHostLimits = {
    ...(hostLimits?.maxObjectBytes === undefined ? {} : { maxObjectBytes: hostLimits.maxObjectBytes }),
    ...(hostLimits?.maxFiles === undefined ? {} : { maxFiles: hostLimits.maxFiles }),
    ...(hostLimits?.maxTotalBytes === undefined ? {} : { maxTotalBytes: hostLimits.maxTotalBytes }),
  };
  const argsValid = [
    positiveIntegerOption(failures, 'manifestByteCap', manifestByteCap),
    positiveIntegerOption(failures, 'verifyTimeoutMs', verifyTimeoutMs),
    positiveIntegerOption(failures, 'maxArchiveBytes', maxArchiveBytes),
    ...Object.entries(hostLimits ?? {}).map(([name, value]) =>
      positiveIntegerOption(
        failures,
        `--${name.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)}`,
        value,
      )),
  ].every((valid) => valid);
  const startedAt = Date.now();
  /** The one whole-verification budget; the pure core receives only the
   * unspent remainder so a late archive cannot restart the clock. */
  const deadlineBreached = (): boolean => {
    if (Date.now() - startedAt <= verifyTimeoutMs) {
      return false;
    }
    if (!failures.some((entry) => entry.code === 'deadline')) {
      failWith(
        failures,
        'limits',
        'deadline',
        `Delivery verification exceeded its ${verifyTimeoutMs} ms budget`,
      );
    }
    return true;
  };

  // ---- Stage: manifest -------------------------------------------------
  let manifestBytes: Buffer | undefined;
  let manifest: PhaserPackDeliveryManifest | undefined;
  try {
    manifestBytes = await readManifestCapped(options.manifestPath, manifestByteCap);
  } catch (error) {
    failWith(failures, 'manifest', 'manifest-unreadable', errorText(error));
  }
  if (manifestBytes !== undefined) {
    try {
      manifest = validatePhaserPackDeliveryManifest(JSON.parse(manifestBytes.toString('utf8')));
    } catch (error) {
      failWith(failures, 'manifest', 'manifest-invalid', errorText(error));
    }
  }

  const root = resolve(options.root);
  let rootIsDirectory = false;
  try {
    // The deployment root may itself be a symlink (release directories
    // often are); follow it, unlike the per-component artifact checks.
    rootIsDirectory = (await stat(root)).isDirectory();
  } catch {
    rootIsDirectory = false;
  }
  if (!rootIsDirectory) {
    failWith(
      failures,
      'paths',
      'root-missing',
      `Verification root is not a directory: ${options.root}`,
    );
  }

  const referencedFiles: string[] = [];
  let referencedBytes = 0;
  const archives: {
    packId: string;
    entries: number;
    expandedBytes: number;
  }[] = [];
  const seenResolved = new Map<string, string>();

  const realRoot = rootIsDirectory ? await realpath(root) : root;
  /** I/O-internal deadline sampler: long reads abort as soon as the
   * whole-verification budget expires instead of running to completion. */
  const sampleDeadline = (): void => {
    if (deadlineBreached()) {
      throw new VerifyDeadlineError();
    }
  };
  /** Verified on-disk objects keyed by resolved path. The manifest
   * validator already rejects duplicate references, so this is
   * defense in depth for distinct manifest paths that alias the same
   * file on case-insensitive filesystems: they re-check the new
   * declaration without re-reading or re-counting the object. */
  const verifiedArtifacts = new Map<string, { bytes: number; sha256: string }>();
  if (manifest !== undefined && rootIsDirectory && argsValid) {
    try {
      for (const pack of manifest.packs) {
        if (deadlineBreached()) {
          break;
        }
        if (pack.delivery === 'files') {
          for (const asset of pack.assets) {
            for (const file of asset.files) {
              if (deadlineBreached()) {
                break;
              }
              await verifyReferencedFile(
                failures,
                pack,
                file,
                root,
                realRoot,
                seenResolved,
                referencedFiles,
                verifiedArtifacts,
                (bytes: number): void => {
                  referencedBytes += bytes;
                },
                sampleDeadline,
              );
            }
          }
          continue;
        }
        await verifyZipPack(
          failures,
          pack,
          root,
          realRoot,
          seenResolved,
          referencedFiles,
          verifiedArtifacts,
          archives,
          (bytes: number): void => {
            referencedBytes += bytes;
          },
          sampleDeadline,
          maxArchiveBytes,
          startedAt,
          verifyTimeoutMs,
        );
      }
    } catch (error) {
      // The budget expired mid-I/O; the deadline failure is already
      // recorded, so stop verifying instead of reporting a read error.
      if (!(error instanceof VerifyDeadlineError)) {
        throw error;
      }
    }
  }

  // ---- Stage: limits ---------------------------------------------------
  let inventory: { files: number; bytes: number; truncated: boolean } | undefined;
  const limitsRequested = hostLimits !== undefined
    && Object.values(hostLimits).some((value) => value !== undefined);
  if (limitsRequested && rootIsDirectory && argsValid && !deadlineBreached()) {
    try {
      inventory = await inventoryRoot(root, sampleDeadline);
    } catch (error) {
      if (!(error instanceof VerifyDeadlineError)) {
        failWith(failures, 'limits', 'inventory-unreadable', errorText(error));
      }
    }
    if (inventory !== undefined) {
      // Truncated inventories still run the checks: the counts are lower
      // bounds, so any breach they show is real even though the exact
      // totals past the cap stay unknown.
      const maxFiles = hostLimits?.maxFiles;
      const maxTotalBytes = hostLimits?.maxTotalBytes;
      if (maxFiles !== undefined && inventory.files > maxFiles) {
        failWith(
          failures,
          'limits',
          'max-files',
          `Root inventory has ${inventory.files} files, over the limit ${maxFiles}`,
        );
      }
      if (maxTotalBytes !== undefined && inventory.bytes > maxTotalBytes) {
        failWith(
          failures,
          'limits',
          'max-total-bytes',
          `Root inventory holds ${inventory.bytes} bytes, over the limit ${maxTotalBytes}`,
        );
      }
    }
  }
  if (
    limitsRequested
    && argsValid
    && hostLimits?.maxObjectBytes !== undefined
    && manifest !== undefined
  ) {
    // Object sizes come from the manifest's own declarations; every
    // referenced object was also size-verified on disk.
    for (const pack of manifest.packs) {
      const objectBytes = pack.delivery === 'zip'
        ? (pack.archive?.bytes ?? 0)
        : pack.assets.reduce(
            (max, asset) => Math.max(max, ...asset.files.map((file) => file.bytes)),
            0,
          );
      if (objectBytes > hostLimits.maxObjectBytes) {
        failWith(
          failures,
          'limits',
          'max-object-bytes',
          `Pack ${pack.packId} holds an object of ${objectBytes} bytes, over the limit ${hostLimits.maxObjectBytes}`,
          pack.packId,
        );
      }
    }
  }

  return {
    ok: failures.length === 0,
    manifest: {
      sha256: manifestBytes === undefined ? '' : createHash('sha256').update(manifestBytes).digest('hex'),
      bytes: manifestBytes?.byteLength ?? 0,
      format: manifest?.format ?? '',
      version: manifest?.version ?? 0,
      packs: manifest?.packs.length ?? 0,
    },
    referenced: {
      files: referencedFiles.length,
      bytes: referencedBytes,
    },
    ...(inventory === undefined ? {} : { inventory }),
    archives,
    ...(limitsRequested ? { limits: usedLimits } : {}),
    failures: [...failures],
    notVerified: NOT_VERIFIED,
  };
}

/** Resolve one manifest artifact path under the root, register it against
 * case-folded collisions, and record the referenced object — the single
 * security-critical resolve/register path shared by files and zip packs. */
const resolveAndRegister = async (
  failures: FailureSink,
  pack: PhaserPackDeliveryPack,
  root: string,
  realRoot: string,
  artifactPath: string,
  seenResolved: Map<string, string>,
  referencedFiles: string[],
): Promise<string | undefined> => {
  let resolvedPath: string;
  try {
    resolvedPath = await resolveArtifactPath(root, realRoot, artifactPath);
  } catch (error) {
    failWith(failures, 'paths', 'path-invalid', errorText(error), pack.packId);
    return undefined;
  }
  const caseKey = caseKeyOf(resolvedPath);
  const prior = seenResolved.get(caseKey);
  if (prior !== undefined) {
    if (prior !== resolvedPath) {
      failWith(
        failures,
        'paths',
        'path-collision',
        `Manifest paths ${prior} and ${resolvedPath} resolve to the same file`,
        pack.packId,
      );
      return undefined;
    }
    // Duplicate reference to an already-registered object: the caller
    // re-checks the new declaration but the object counts once.
    return resolvedPath;
  }
  seenResolved.set(caseKey, resolvedPath);
  referencedFiles.push(resolvedPath);
  return resolvedPath;
};

interface ReferencedFile {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

const verifyReferencedFile = async (
  failures: FailureSink,
  pack: PhaserPackDeliveryPack,
  file: ReferencedFile,
  root: string,
  realRoot: string,
  seenResolved: Map<string, string>,
  referencedFiles: string[],
  verifiedArtifacts: Map<string, { bytes: number; sha256: string }>,
  onVerified: (bytes: number) => void,
  sampleDeadline: () => void,
): Promise<void> => {
  const resolvedPath = await resolveAndRegister(
    failures,
    pack,
    root,
    realRoot,
    file.path,
    seenResolved,
    referencedFiles,
  );
  if (resolvedPath === undefined) {
    return;
  }
  try {
    const cached = verifiedArtifacts.get(resolvedPath);
    if (cached !== undefined) {
      if (cached.bytes !== file.bytes) {
        failWith(
          failures,
          'files',
          'size-mismatch',
          `File ${file.path} is ${cached.bytes} bytes, manifest declares ${file.bytes}`,
          pack.packId,
        );
      } else if (cached.sha256 !== file.sha256) {
        failWith(
          failures,
          'files',
          'hash-mismatch',
          `File ${file.path} does not match its manifest digest`,
          pack.packId,
        );
      }
      return;
    }
    const handle = await open(resolvedPath, 'r');
    let hashed: { bytes: number; sha256: string };
    try {
      hashed = await streamSha256(resolvedPath, handle, createHash('sha256'), sampleDeadline);
    } finally {
      await handle.close();
    }
    if (hashed.bytes !== file.bytes) {
      failWith(
        failures,
        'files',
        'size-mismatch',
        `File ${file.path} is ${hashed.bytes} bytes, manifest declares ${file.bytes}`,
        pack.packId,
      );
      return;
    }
    if (hashed.sha256 !== file.sha256) {
      failWith(
        failures,
        'files',
        'hash-mismatch',
        `File ${file.path} does not match its manifest digest`,
        pack.packId,
      );
      return;
    }
    verifiedArtifacts.set(resolvedPath, hashed);
    onVerified(hashed.bytes);
  } catch (error) {
    if (error instanceof VerifyDeadlineError) {
      throw error;
    }
    failWith(failures, 'files', 'unreadable', errorText(error), pack.packId);
  }
};

const verifyZipPack = async (
  failures: FailureSink,
  pack: PhaserPackDeliveryPack,
  root: string,
  realRoot: string,
  seenResolved: Map<string, string>,
  referencedFiles: string[],
  verifiedArtifacts: Map<string, { bytes: number; sha256: string }>,
  archives: { packId: string; entries: number; expandedBytes: number }[],
  onVerified: (bytes: number) => void,
  sampleDeadline: () => void,
  maxArchiveBytes: number,
  startedAt: number,
  verifyTimeoutMs: number,
): Promise<void> => {
  const archivePath = pack.archive?.path;
  if (archivePath === undefined) {
    failWith(
      failures,
      'archive',
      'archive-missing',
      `Zip pack ${pack.packId} lacks an archive path`,
      pack.packId,
    );
    return;
  }
  const resolvedPath = await resolveAndRegister(
    failures,
    pack,
    root,
    realRoot,
    archivePath,
    seenResolved,
    referencedFiles,
  );
  if (resolvedPath === undefined) {
    return;
  }
  const declaredBytes = pack.archive?.bytes ?? 0;
  if (declaredBytes > maxArchiveBytes) {
    failWith(
      failures,
      'limits',
      'max-archive-bytes',
      `Archive ${archivePath} declares ${declaredBytes} bytes, over the limit ${maxArchiveBytes}`,
      pack.packId,
    );
    return;
  }
  let archiveBytes: Buffer;
  try {
    // One descriptor serves the size check, the digest and the decode, so
    // every check sees the same inode the path checks validated.
    const handle = await open(resolvedPath, 'r');
    try {
      const cached = verifiedArtifacts.get(resolvedPath);
      if (cached === undefined) {
        const { size } = await handle.stat();
        if (pack.archive !== undefined && size !== pack.archive.bytes) {
          failWith(
            failures,
            'archive',
            'size-mismatch',
            `Archive ${archivePath} is ${size} bytes, manifest declares ${pack.archive.bytes}`,
            pack.packId,
          );
          return;
        }
        if (size > maxArchiveBytes) {
          failWith(
            failures,
            'limits',
            'max-archive-bytes',
            `Archive ${archivePath} is ${size} bytes, over the limit ${maxArchiveBytes}`,
            pack.packId,
          );
          return;
        }
        archiveBytes = await readExact(resolvedPath, handle, declaredBytes, sampleDeadline);
        const hasher = createHash('sha256');
        hasher.update(archiveBytes);
        const actual = { bytes: archiveBytes.byteLength, sha256: hasher.digest('hex') };
        if (pack.archive !== undefined && actual.sha256 !== pack.archive.sha256) {
          failWith(
            failures,
            'archive',
            'hash-mismatch',
            `Archive ${archivePath} does not match its manifest digest`,
            pack.packId,
          );
          return;
        }
        verifiedArtifacts.set(resolvedPath, actual);
        onVerified(actual.bytes);
      } else {
        if (pack.archive !== undefined && cached.bytes !== pack.archive.bytes) {
          failWith(
            failures,
            'archive',
            'size-mismatch',
            `Archive ${archivePath} is ${cached.bytes} bytes, manifest declares ${pack.archive.bytes}`,
            pack.packId,
          );
          return;
        }
        if (pack.archive !== undefined && cached.sha256 !== pack.archive.sha256) {
          failWith(
            failures,
            'archive',
            'hash-mismatch',
            `Archive ${archivePath} does not match its manifest digest`,
            pack.packId,
          );
          return;
        }
        // The object is already verified and counted; re-read only what the
        // decode needs.
        archiveBytes = await readExact(resolvedPath, handle, declaredBytes, sampleDeadline);
      }
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof VerifyDeadlineError) {
      throw error;
    }
    failWith(failures, 'archive', 'unreadable', errorText(error), pack.packId);
    return;
  }
  try {
    const stats = await verifyZipV1Archive(
      archiveBytes,
      expectedOf(pack),
      coreLimitsOf(pack, verifyTimeoutMs - (Date.now() - startedAt)),
    );
    archives.push({
      packId: pack.packId,
      entries: stats.entries,
      expandedBytes: stats.expandedBytes,
    });
  } catch (error) {
    const code = error instanceof ZipDecodeError ? error.code : 'decode';
    failWith(
      failures,
      'archive',
      `zip-${code}`,
      `Archive ${archivePath} failed verification: ${errorText(error)}`,
      pack.packId,
    );
  }
};
