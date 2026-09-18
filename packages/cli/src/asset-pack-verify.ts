import { createHash, type Hash } from 'node:crypto';
import { createReadStream, type ReadStream } from 'node:fs';
import { lstat, open, opendir, realpath, stat, type FileHandle } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  verifyZipV1Archive,
  ZipDecodeError,
  type ExpectedZipArchive,
} from '@mpgd/phaser-assets/archive-validation';
import { defaultArchiveWorkerLimits } from '@mpgd/phaser-assets/archives';
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
  /** Referenced objects as declared by the chosen manifest; verification
   * outcomes live in `failures`, so these totals stay meaningful even
   * when artifacts are missing or unreadable. */
  readonly referenced: {
    readonly files: number;
    readonly bytes: number;
  };
  /** Root inventory: every regular file physically under --root. Only
   * computed when host limits are requested. `largest` is the biggest
   * regular file seen; on a truncated walk it is a lower bound. */
  readonly inventory?: {
    readonly files: number;
    readonly bytes: number;
    readonly largest: number;
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
  /** Independent cap on one expanded zip entry, whatever the manifest
   * declares; default 256 MiB. Larger declared entries fail at the limits
   * stage before any decompression allocation. */
  readonly maxEntryBytes?: number | undefined;
  /** Independent cap on one archive's total expanded bytes, whatever the
   * manifest declares; default 1 GiB. Larger declared totals fail at the
   * limits stage before any decompression allocation. */
  readonly maxExpandedBytes?: number | undefined;
}

const DEFAULT_MANIFEST_BYTE_CAP = 32 * 1024 * 1024;
const DEFAULT_VERIFY_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_ENTRY_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_EXPANDED_BYTES = 1024 * 1024 * 1024;
const STREAM_CHUNK_BYTES = 1024 * 1024;
/** Inventory walking stops beyond this many files so an accidental root
 * choice cannot turn verification into an unbounded traversal; the report
 * marks the count truncated instead of failing silently. */
const INVENTORY_FILE_CAP = 1_000_000;
/** Same manifest artifact colliding under case folding means the deployment
 * is ambiguous on case-insensitive hosts. */
/** Case-fold the collision key unconditionally: the verifier's host is not
 * the deployment's consumers, and case-duplicate artifacts are ambiguous
 * for any case-insensitive host or CDN regardless of where this runs.
 * The fold mirrors the upcase tables of the case-insensitive filesystems
 * deployments actually target (NTFS, APFS): simple case mapping, under
 * which "Straße.png" and "STRASSE.png" stay distinct. Full Unicode case
 * folding (ext4/F2FS casefold directories) is a different equivalence —
 * recorded in `notVerified` rather than approximated here, so valid
 * NTFS/APFS deployments are not falsely rejected. */
const caseKeyOf = (resolvedPath: string): string => resolvedPath.toLowerCase();

const NOT_VERIFIED: readonly string[] = [
  'CDN cache state and origin preservation',
  'HTTP CORS and Content-Type responses',
  'Application image display and device compatibility',
  'Server access control',
  'Atomic multi-file deployment swaps',
  'Full Unicode case-fold ambiguity (ext4/F2FS casefold directories): '
    + 'collision detection folds like NTFS and APFS, under which '
    + '"Straße.png" and "STRASSE.png" remain distinct files',
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
 * mid-read; the failure itself is recorded exactly once by the deadline
 * control before this sentinel propagates. */
class VerifyDeadlineError extends Error {}

/** The single whole-verification budget, enforced at every blocking
 * filesystem wait: entry sampling, stream watchdogs and raced promises
 * all share one clock, and the deadline instant itself counts as still
 * within budget (so enforcement arms one millisecond past it). */
interface VerifyDeadline {
  /** Elapsed time exceeds the budget; records the failure exactly once
   * and reports whether the budget is spent. */
  breach(): boolean;
  /** Unspent budget in milliseconds; zero or less once spent. */
  remainingMs(): number;
  /** Throws once the budget is spent; for granular work like inventory
   * entries and manifest chunks. */
  sample(): void;
  /** Destroys a read stream just past the deadline, so a source that
   * stops delivering chunks (FIFO, stalled mount) cannot outlive the
   * budget. Returns the armed timer for the caller to clear. */
  armStream(stream: ReadStream): NodeJS.Timeout;
  /** Bounds one filesystem promise (readdir, lstat, open, ...) by the
   * same deadline; a stalled call rejects with the deadline sentinel. */
  race<T>(operation: Promise<T>): Promise<T>;
}

/** Streaming SHA-256 over an already-opened descriptor: never buffers the
 * whole file, the hash reads every actual byte rather than trusting stat
 * or Content-Length alone, and the bytes hashed are the same inode the
 * path checks validated — a component swapped for a symlink after the
 * check cannot redirect this read. */
const streamSha256 = async (
  path: string,
  handle: FileHandle,
  hasher: Hash,
  deadline: VerifyDeadline,
): Promise<{ bytes: number; sha256: string }> => {
  let bytes = 0;
  const stream = handle.createReadStream({ highWaterMark: STREAM_CHUNK_BYTES });
  const timer = deadline.armStream(stream);
  try {
    for await (const chunk of stream) {
      const view = chunk as Buffer;
      bytes += view.byteLength;
      hasher.update(view);
    }
  } catch (error) {
    if (error instanceof VerifyDeadlineError) {
      throw error;
    }
    // A file changing mid-verification (size or content) surfaces as a
    // read failure rather than a digest mismatch.
    throw new Error(`Could not read ${path}: ${errorText(error)}`);
  } finally {
    clearTimeout(timer);
  }
  return { bytes, sha256: hasher.digest('hex') };
};

/** Resolve one manifest artifact path under the root, rejecting absolute
 * paths, traversal, symlinks and non-regular files — checking each path
 * component by lstat so a symlink cannot hide mid-path. */
interface ResolvedArtifact {
  readonly path: string;
  readonly dev: bigint;
  readonly ino: bigint;
}

const resolveArtifactPath = async (
  root: string,
  realRoot: string,
  artifactPath: string,
  deadline: VerifyDeadline,
): Promise<ResolvedArtifact> => {
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
      // bigint identity stays exact on filesystems whose device or inode
      // numbers exceed Number.MAX_SAFE_INTEGER.
      stat = await deadline.race(lstat(current, { bigint: true }));
    } catch (error) {
      if (error instanceof VerifyDeadlineError) {
        throw error;
      }
      throw new Error(`Artifact path is missing: ${artifactPath}`);
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`Artifact path must not contain symbolic links: ${artifactPath}`);
    }
  }
  const stat = await deadline.race(lstat(current, { bigint: true }));
  if (!stat.isFile()) {
    throw new Error(`Artifact path is not a regular file: ${artifactPath}`);
  }
  const rel = relative(realRoot, await deadline.race(realpath(current)));
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Artifact path escapes the root: ${artifactPath}`);
  }
  // The lstat identity travels with the path so the later open() can bind
  // to this exact inode; a component swapped for a symlink between the
  // check and the open surfaces as a mismatch instead of a redirect.
  return { path: current, dev: stat.dev, ino: stat.ino };
};

/** Count every regular file under the root for host-limit accounting.
 * Symlinks are skipped: they are not deployed objects, and manifest
 * artifacts reject them independently. */
const inventoryRoot = async (
  root: string,
  deadline: VerifyDeadline,
): Promise<{ files: number; bytes: number; largest: number; truncated: boolean }> => {
  let files = 0;
  let bytes = 0;
  let largest = 0;
  let truncated = false;
  const walk = async (directory: string): Promise<void> => {
    // opendir streams entries in bounded batches, so a single directory
    // holding more than the cap cannot materialize every dirent first;
    // each batch read is raced against the deadline like every other
    // blocking wait.
    const dir = await deadline.race(opendir(directory));
    let stalled = false;
    try {
      for (;;) {
        const entry = await deadline.race(dir.read());
        if (entry === null) {
          return;
        }
        deadline.sample();
        const child = join(directory, entry.name);
        if (entry.isSymbolicLink()) {
          continue;
        }
        if (
          entry.isBlockDevice() || entry.isCharacterDevice()
          || entry.isFIFO() || entry.isSocket()
        ) {
          continue;
        }
        // Directories, regular files and unknown dirent types
        // (UV_DIRENT_UNKNOWN on some network and FUSE filesystems) are
        // all classified by a fresh lstat rather than the possibly stale
        // dirent, so an entry swapped for a symlink between the readdir
        // and the descent can neither steer the walk outside the root
        // nor be counted as a deployed file.
        const stat = await deadline.race(lstat(child));
        if (stat.isSymbolicLink()) {
          continue;
        }
        if (stat.isDirectory()) {
          await walk(child);
          // A truncated descendant stops the entire walk, not just that
          // subtree: ancestors must not keep scanning siblings once the
          // cap verdict is known.
          if (truncated) {
            return;
          }
          continue;
        }
        if (!stat.isFile()) {
          continue;
        }
        // Truncation is only marked for an entry that actually counts:
        // a root of exactly the cap whose next entry is a skipped
        // symlink or device does not claim to be truncated.
        if (files >= INVENTORY_FILE_CAP) {
          truncated = true;
          return;
        }
        files++;
        bytes += stat.size;
        if (stat.size > largest) {
          largest = stat.size;
        }
      }
    } catch (error) {
      if (error instanceof VerifyDeadlineError) {
        stalled = true;
      }
      throw error;
    } finally {
      await closeBounded(() => dir.close(), stalled, deadline);
    }
  };
  await walk(root);
  return { files, bytes, largest, truncated };
};

const readManifestCapped = async (
  manifestPath: string,
  cap: number,
  deadline: VerifyDeadline,
): Promise<Buffer> => {
  // Open through the deadline: a FIFO with no writer blocks inside
  // open(2) before any stream event exists, and destroying a stream
  // cannot cancel that pending open.
  const handle = await deadline.race(open(resolve(manifestPath), 'r'));
  const stream: ReadStream = handle.createReadStream({ highWaterMark: STREAM_CHUNK_BYTES });
  // A stalled source (a FIFO whose writer never writes, a hung network
  // mount) delivers no chunk to sample, so the watchdog enforces the
  // budget even while the read pends; the recorded failure travels on
  // the destroy error.
  const timer = deadline.armStream(stream);
  const chunks: Buffer[] = [];
  let received = 0;
  let stalled = false;
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
    if (error instanceof VerifyDeadlineError) {
      stalled = true;
      throw error;
    }
    if (received > cap) {
      throw error;
    }
    throw new Error(`Could not read the delivery manifest: ${errorText(error)}`);
  } finally {
    clearTimeout(timer);
    await closeBounded(() => handle.close(), stalled, deadline);
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
  deadline: VerifyDeadline,
): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  let received = 0;
  const stream = handle.createReadStream({ highWaterMark: STREAM_CHUNK_BYTES });
  const timer = deadline.armStream(stream);
  try {
    for await (const chunk of stream) {
      const view = chunk as Buffer;
      received += view.byteLength;
      if (received > bytes) {
        stream.destroy();
        throw new Error(`Archive grew while being read: ${path}`);
      }
      chunks.push(view);
    }
  } catch (error) {
    if (error instanceof VerifyDeadlineError) {
      throw error;
    }
    throw new Error(`Could not read the archive at ${path}: ${errorText(error)}`);
  } finally {
    clearTimeout(timer);
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

/** The ZIP entry path bound mirrors runtime delivery: the default worker
 * limit raised to this pack's longest declared entry path, so a manifest
 * the builder, validator and runtime accept never fails here. */
const longestDeclaredPathOf = (pack: PhaserPackDeliveryPack): number => {
  let longest = defaultArchiveWorkerLimits().maxPathLength;
  for (const asset of pack.assets) {
    for (const file of asset.files) {
      if (file.path.length > longest) {
        longest = file.path.length;
      }
    }
  }
  return longest;
};

/** Core decode limits follow the manifest's own declarations: the archive
 * byte limit is the declared archive size (already verified by hash), the
 * expanded limits are the manifest's file byte sums, and the deadline is
 * the unspent remainder of the whole-verification budget. */
const coreLimitsOf = (
  pack: PhaserPackDeliveryPack,
  maxEntryBytes: number,
  maxExpandedBytes: number,
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
    // Declared sizes remain the operative limits — tighter than the caps —
    // but never exceed the independent bounds, whatever the manifest says.
    entryBytes: Math.min(
      maxEntryBytes,
      Math.max(
        1,
        pack.assets.reduce(
          (max, asset) => asset.files.reduce((inner, file) => Math.max(inner, file.bytes), max),
          1,
        ),
      ),
    ),
    totalExpandedBytes: Math.min(maxExpandedBytes, Math.max(1, expanded)),
    entryCount: Math.max(1, pack.archive?.entryCount ?? 0),
    maxPathLength: longestDeclaredPathOf(pack),
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
  const maxEntryBytes = options.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES;
  const maxExpandedBytes = options.maxExpandedBytes ?? DEFAULT_MAX_EXPANDED_BYTES;
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
    positiveIntegerOption(failures, 'maxEntryBytes', maxEntryBytes),
    positiveIntegerOption(failures, 'maxExpandedBytes', maxExpandedBytes),
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
  /** The shared budget control: every blocking filesystem wait below goes
   * through it, so no single stalled call can outlive the budget. */
  const deadline: VerifyDeadline = {
    breach: deadlineBreached,
    remainingMs: (): number => verifyTimeoutMs - (Date.now() - startedAt),
    sample: (): void => {
      if (deadlineBreached()) {
        throw new VerifyDeadlineError();
      }
    },
    // Fires one millisecond past the deadline instant — the breach
    // predicate treats the deadline itself as still within budget — so a
    // source that never delivers another chunk (FIFO, stalled mount)
    // cannot outlive the budget; the recorded failure travels on the
    // destroy error.
    armStream: (stream: ReadStream): NodeJS.Timeout =>
      setTimeout(() => {
        if (deadlineBreached()) {
          stream.destroy(new VerifyDeadlineError());
        }
      }, Math.max(1, verifyTimeoutMs - (Date.now() - startedAt) + 1)),
    race: async <T,>(operation: Promise<T>): Promise<T> => {
      let timer: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          operation,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              if (deadlineBreached()) {
                reject(new VerifyDeadlineError());
              }
            }, Math.max(1, verifyTimeoutMs - (Date.now() - startedAt) + 1));
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
  };

  // ---- Stage: manifest -------------------------------------------------
  let manifestBytes: Buffer | undefined;
  let manifest: PhaserPackDeliveryManifest | undefined;
  try {
    manifestBytes = await readManifestCapped(options.manifestPath, manifestByteCap, deadline);
  } catch (error) {
    if (!(error instanceof VerifyDeadlineError)) {
      failWith(failures, 'manifest', 'manifest-unreadable', errorText(error));
    }
  }
  if (manifestBytes !== undefined) {
    try {
      manifest = validatePhaserPackDeliveryManifest(JSON.parse(manifestBytes.toString('utf8')));
    } catch (error) {
      failWith(failures, 'manifest', 'manifest-invalid', errorText(error));
    }
  }

  /** What the chosen manifest requires, independent of verification
   * outcomes: distinct artifact objects and their declared bytes. */
  let declaredTotals = { files: 0, bytes: 0 };
  if (manifest !== undefined) {
    for (const pack of manifest.packs) {
      if (pack.delivery === 'zip') {
        declaredTotals = {
          files: declaredTotals.files + 1,
          bytes: declaredTotals.bytes + (pack.archive?.bytes ?? 0),
        };
        continue;
      }
      for (const asset of pack.assets) {
        declaredTotals = {
          files: declaredTotals.files + asset.files.length,
          bytes: declaredTotals.bytes
            + asset.files.reduce((sum, file) => sum + file.bytes, 0),
        };
      }
    }
  }

  const root = resolve(options.root);
  let rootIsDirectory = false;
  try {
    // The deployment root may itself be a symlink (release directories
    // often are); follow it, unlike the per-component artifact checks.
    rootIsDirectory = (await deadline.race(stat(root))).isDirectory();
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

  const archives: {
    packId: string;
    entries: number;
    expandedBytes: number;
  }[] = [];
  const seenResolved = new Map<string, string>();

  let realRoot = root;
  let rootUsable = rootIsDirectory;
  if (rootIsDirectory) {
    try {
      realRoot = await deadline.race(realpath(root));
    } catch (error) {
      // A root that stops resolving mid-verification (a release symlink
      // swapped between the stat and this call, or the spent budget)
      // becomes a structured failure — never an escaping rejection that
      // would cost the caller its report.
      rootUsable = false;
      if (!(error instanceof VerifyDeadlineError)) {
        failWith(
          failures,
          'paths',
          'root-unresolvable',
          `Could not resolve the verification root: ${errorText(error)}`,
        );
      }
    }
  }
  /** Verified on-disk objects keyed by resolved path. The manifest
   * validator already rejects duplicate references, so this is
   * defense in depth for distinct manifest paths that alias the same
   * file on case-insensitive filesystems: they re-check the new
   * declaration without re-reading or re-counting the object. */
  const verifiedArtifacts = new Map<string, { bytes: number; sha256: string }>();
  if (manifest !== undefined && rootUsable && argsValid) {
    try {
      for (const pack of manifest.packs) {
        if (deadline.breach()) {
          break;
        }
        if (pack.delivery === 'files') {
          for (const asset of pack.assets) {
            for (const file of asset.files) {
              if (deadline.breach()) {
                break;
              }
              await verifyReferencedFile(
                failures,
                pack,
                file,
                root,
                realRoot,
                seenResolved,
                verifiedArtifacts,
                deadline,
                hostLimits?.maxObjectBytes,
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
          verifiedArtifacts,
          archives,
          deadline,
          maxArchiveBytes,
          maxEntryBytes,
          maxExpandedBytes,
          hostLimits?.maxObjectBytes,
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
  let inventory: { files: number; bytes: number; largest: number; truncated: boolean } | undefined;
  const limitsRequested = hostLimits !== undefined
    && Object.values(hostLimits).some((value) => value !== undefined);
  if (limitsRequested && rootUsable && argsValid && !deadline.breach()) {
    try {
      inventory = await inventoryRoot(root, deadline);
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
      const maxObjectBytes = hostLimits?.maxObjectBytes;
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
      // Object size covers the whole deployment root — unreferenced stale
      // revisions included — exactly like the count and total limits.
      if (maxObjectBytes !== undefined && inventory.largest > maxObjectBytes) {
        failWith(
          failures,
          'limits',
          'max-object-bytes',
          `Root inventory holds an object of ${inventory.largest} bytes, `
            + `over the limit ${maxObjectBytes}`,
        );
      }
      if (inventory.truncated) {
        // The walk stopped at the cap, so the limits above were only
        // checked against a lower bound; refuse to certify the deployment.
        failWith(
          failures,
          'limits',
          'inventory-truncated',
          `Root inventory exceeded ${INVENTORY_FILE_CAP} files; `
            + 'host limits could not be fully verified',
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
    referenced: declaredTotals,
    ...(inventory === undefined ? {} : { inventory }),
    archives,
    ...(limitsRequested ? { limits: usedLimits } : {}),
    failures: [...failures],
    notVerified: NOT_VERIFIED,
  };
}

/** Resolve one manifest artifact path under the root and register it
 * against case-folded collisions — the single security-critical
 * resolve/register path shared by files and zip packs. */
const resolveAndRegister = async (
  failures: FailureSink,
  pack: PhaserPackDeliveryPack,
  root: string,
  realRoot: string,
  artifactPath: string,
  seenResolved: Map<string, string>,
  deadline: VerifyDeadline,
): Promise<ResolvedArtifact | undefined> => {
  let resolved: ResolvedArtifact;
  try {
    resolved = await resolveArtifactPath(root, realRoot, artifactPath, deadline);
  } catch (error) {
    if (error instanceof VerifyDeadlineError) {
      // The budget expired mid-resolution; the deadline failure is
      // already recorded, so propagate the sentinel instead of adding a
      // misleading path failure.
      throw error;
    }
    failWith(failures, 'paths', 'path-invalid', errorText(error), pack.packId);
    return undefined;
  }
  const caseKey = caseKeyOf(resolved.path);
  const prior = seenResolved.get(caseKey);
  if (prior !== undefined) {
    if (prior !== resolved.path) {
      failWith(
        failures,
        'paths',
        'path-collision',
        `Manifest paths ${prior} and ${resolved.path} resolve to the same file`,
        pack.packId,
      );
      return undefined;
    }
    // Duplicate reference to an already-registered object: the caller
    // re-checks the new declaration but the object counts once.
    return resolved;
  }
  seenResolved.set(caseKey, resolved.path);
  return resolved;
};

/** Close a filesystem handle under the deadline: a close following an
 * already-timed-out operation queues behind uncancellable work and is
 * fired and forgotten (the CLI's forced exit releases whatever the queue
 * still holds), while even a clean-path close is raced, because a stalled
 * close on a network or FUSE mount would otherwise stop the report from
 * ever returning. */
const closeBounded = async (
  close: () => Promise<void>,
  stalled: boolean,
  deadline: VerifyDeadline,
): Promise<void> => {
  if (stalled) {
    void close().catch(() => {});
    return;
  }
  await deadline.race(close());
};

/** Bind an opened descriptor to the identity the path checks validated:
 * the same inode, or the component was swapped between check and open. */
const bindsToValidated = (
  info: { dev: bigint; ino: bigint },
  resolved: ResolvedArtifact,
): boolean => info.dev === resolved.dev && info.ino === resolved.ino;

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
  verifiedArtifacts: Map<string, { bytes: number; sha256: string }>,
  deadline: VerifyDeadline,
  maxObjectBytes: number | undefined,
): Promise<void> => {
  const resolved = await resolveAndRegister(
    failures,
    pack,
    root,
    realRoot,
    file.path,
    seenResolved,
    deadline,
  );
  if (resolved === undefined) {
    return;
  }
  const resolvedPath = resolved.path;
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
    const handle = await deadline.race(open(resolvedPath, 'r'));
    let stalled = false;
    let hashed: { bytes: number; sha256: string };
    try {
      const info = await deadline.race(handle.stat({ bigint: true }));
      if (!bindsToValidated(info, resolved)) {
        failWith(
          failures,
          'paths',
          'path-invalid',
          `Artifact path changed during verification: ${file.path}`,
          pack.packId,
        );
        return;
      }
      // Size from the bound descriptor fails closed before the hash, so a
      // huge replacement cannot consume the budget streaming bytes that
      // were already known not to match.
      if (info.size !== BigInt(file.bytes)) {
        failWith(
          failures,
          'files',
          'size-mismatch',
          `File ${file.path} is ${info.size} bytes, manifest declares ${file.bytes}`,
          pack.packId,
        );
        return;
      }
      // The object cap applies before streaming too: a valid but oversized
      // artifact must fail as max-object-bytes here rather than consuming
      // the whole budget and surfacing only a deadline failure.
      if (maxObjectBytes !== undefined && info.size > BigInt(maxObjectBytes)) {
        failWith(
          failures,
          'limits',
          'max-object-bytes',
          `File ${file.path} is ${info.size} bytes, over the limit ${maxObjectBytes}`,
          pack.packId,
        );
        return;
      }
      hashed = await streamSha256(resolvedPath, handle, createHash('sha256'), deadline);
    } catch (error) {
      if (error instanceof VerifyDeadlineError) {
        stalled = true;
      }
      throw error;
    } finally {
      await closeBounded(() => handle.close(), stalled, deadline);
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
  verifiedArtifacts: Map<string, { bytes: number; sha256: string }>,
  archives: { packId: string; entries: number; expandedBytes: number }[],
  deadline: VerifyDeadline,
  maxArchiveBytes: number,
  maxEntryBytes: number,
  maxExpandedBytes: number,
  maxObjectBytes: number | undefined,
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
  const resolved = await resolveAndRegister(
    failures,
    pack,
    root,
    realRoot,
    archivePath,
    seenResolved,
    deadline,
  );
  if (resolved === undefined) {
    return;
  }
  const resolvedPath = resolved.path;
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
  // Decompression bounds are independent of the manifest's own numbers: a
  // self-consistent manifest can still declare gigabytes of expansion, and
  // these caps reject that before any allocation, not after.
  const declaredEntryBytes = pack.assets.reduce(
    (max, asset) => asset.files.reduce((inner, file) => Math.max(inner, file.bytes), max),
    0,
  );
  const declaredExpandedBytes = pack.assets.reduce(
    (sum, asset) => sum + asset.files.reduce((inner, file) => inner + file.bytes, 0),
    0,
  );
  if (declaredEntryBytes > maxEntryBytes) {
    failWith(
      failures,
      'limits',
      'max-entry-bytes',
      `Pack ${pack.packId} declares an entry of ${declaredEntryBytes} bytes, `
        + `over the limit ${maxEntryBytes}`,
      pack.packId,
    );
    return;
  }
  if (declaredExpandedBytes > maxExpandedBytes) {
    failWith(
      failures,
      'limits',
      'max-expanded-bytes',
      `Pack ${pack.packId} declares ${declaredExpandedBytes} expanded bytes, `
        + `over the limit ${maxExpandedBytes}`,
      pack.packId,
    );
    return;
  }
  let archiveBytes: Buffer;
  try {
    // One descriptor serves the size check, the digest and the decode, so
    // every check sees the same inode the path checks validated.
    const handle = await deadline.race(open(resolvedPath, 'r'));
    let stalled = false;
    try {
      const { size, dev, ino } = await deadline.race(handle.stat({ bigint: true }));
      if (!bindsToValidated({ dev, ino }, resolved)) {
        failWith(
          failures,
          'paths',
          'path-invalid',
          `Artifact path changed during verification: ${archivePath}`,
          pack.packId,
        );
        return;
      }
      const cached = verifiedArtifacts.get(resolvedPath);
      if (cached === undefined) {
        if (pack.archive !== undefined && size !== BigInt(pack.archive.bytes)) {
          failWith(
            failures,
            'archive',
            'size-mismatch',
            `Archive ${archivePath} is ${size} bytes, manifest declares ${pack.archive.bytes}`,
            pack.packId,
          );
          return;
        }
        if (size > BigInt(maxArchiveBytes)) {
          failWith(
            failures,
            'limits',
            'max-archive-bytes',
            `Archive ${archivePath} is ${size} bytes, over the limit ${maxArchiveBytes}`,
            pack.packId,
          );
          return;
        }
        if (maxObjectBytes !== undefined && size > BigInt(maxObjectBytes)) {
          failWith(
            failures,
            'limits',
            'max-object-bytes',
            `Archive ${archivePath} is ${size} bytes, over the limit ${maxObjectBytes}`,
            pack.packId,
          );
          return;
        }
        archiveBytes = await readExact(resolvedPath, handle, declaredBytes, deadline);
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
        archiveBytes = await readExact(resolvedPath, handle, declaredBytes, deadline);
      }
    } catch (error) {
      if (error instanceof VerifyDeadlineError) {
        stalled = true;
      }
      throw error;
    } finally {
      await closeBounded(() => handle.close(), stalled, deadline);
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
      coreLimitsOf(pack, maxEntryBytes, maxExpandedBytes, deadline.remainingMs()),
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
