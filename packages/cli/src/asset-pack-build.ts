import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { deflateRawSync } from 'node:zlib';

import {
  PHASER_PACK_DELIVERY_FORMAT,
  PHASER_PACK_DELIVERY_VERSION,
  phaserPackMediaTypeForPath,
  validatePhaserPackBuildConfig,
  validatePhaserPackDeliveryManifest,
  type PhaserPackBuildAsset,
  type PhaserPackBuildConfig,
  type PhaserPackDeliveryAsset,
  type PhaserPackDeliveryFile,
  type PhaserPackDeliveryManifest,
  type PhaserPackDeliveryPack,
  type PhaserPackEntryMethod,
  type PhaserPackFormatFileRole,
} from '@mpgd/phaser-assets/pack-format';

import { createDeterministicZip, type DeterministicZipEntry } from './asset-pack-zip.js';

export interface AssetPackBuildReport {
  readonly outDir: string;
  readonly manifestPath: string;
  readonly outputs: readonly {
    readonly path: string;
    readonly bytes: number;
    readonly sha256: string;
    readonly action: 'written' | 'unchanged';
  }[];
  readonly archives: readonly {
    readonly packId: string;
    readonly path: string;
    readonly entryCount: number;
    readonly storeEntries: number;
    readonly deflateEntries: number;
    readonly sourceBytes: number;
    readonly archiveBytes: number;
    readonly sha256: string;
  }[];
}

const manifestFileName = 'asset-pack-delivery.json';
const sha256Of = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

interface PlannedFile {
  readonly role: PhaserPackFormatFileRole;
  readonly entryPath: string;
  readonly data: Buffer;
  readonly mediaType: string;
  readonly method: PhaserPackEntryMethod;
}

function readJsonConfig(configPath: string): PhaserPackBuildConfig {
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch {
    throw new Error(`Cannot read asset pack build config: ${configPath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Asset pack build config is not valid JSON (${configPath}): ${String(error)}`);
  }
  return validatePhaserPackBuildConfig(parsed);
}

/** Reject symlinks and any path component escaping the source root. */
function readSourceFile(rootPath: string, entryPath: string): Buffer {
  let current = rootPath;
  for (const component of entryPath.split('/')) {
    current = join(current, component);
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      throw new Error(`Missing pack source file: ${entryPath}`);
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`Pack source path must not contain symbolic links: ${entryPath}`);
    }
  }
  if (!lstatSync(current).isFile()) {
    throw new Error(`Pack source path is not a regular file: ${entryPath}`);
  }
  const relativeToRoot = relative(realpathSync(rootPath), realpathSync(current));
  if (relativeToRoot.startsWith('..') || isAbsolute(relativeToRoot)) {
    throw new Error(`Pack source path escapes the source root: ${entryPath}`);
  }
  return readFileSync(current);
}

function planAssetFiles(asset: PhaserPackBuildAsset, rootPath: string): PlannedFile[] {
  const sources: { role: PhaserPackFormatFileRole; entryPath: string }[] = asset.kind === 'atlas'
    ? [
        { role: 'texture', entryPath: asset.texture },
        { role: 'atlas', entryPath: asset.atlas },
      ]
    : [{ role: 'texture', entryPath: asset.file }];
  return sources.map(({ role, entryPath }) => {
    const media = phaserPackMediaTypeForPath(entryPath);
    if (media === null) {
      throw new Error(`Unsupported pack source extension: ${asset.key}/${entryPath}`);
    }
    const data = readSourceFile(rootPath, entryPath);
    let method: PhaserPackEntryMethod = asset.compression ?? media.defaultMethod;
    if (method === 'deflate' && asset.compression === undefined) {
      // Default policy may fall back to STORE when DEFLATE is not smaller;
      // an explicit per-asset override forces its method.
      if (deflateRawSync(data, { level: 9 }).length >= data.length) {
        method = 'store';
      }
    }
    return {
      role, entryPath, data, mediaType: media.mediaType, method,
    };
  });
}

function deliveryAsset(
  asset: PhaserPackBuildAsset,
  files: readonly PlannedFile[],
  pack: PhaserPackBuildConfig['packs'][number],
): PhaserPackDeliveryAsset {
  const outputPrefix = `packs/${pack.id}@${pack.revision}`;
  const deliveryFiles: PhaserPackDeliveryFile[] = files.map((file) => ({
    role: file.role,
    mediaType: file.mediaType,
    bytes: file.data.length,
    sha256: sha256Of(file.data),
    path: pack.delivery === 'files' ? `${outputPrefix}/${file.entryPath}` : file.entryPath,
    ...(pack.delivery === 'zip' ? { method: file.method } : {}),
  }));
  return {
    assetKey: asset.key,
    kind: asset.kind,
    ...(asset.kind === 'spritesheet' ? { frameConfig: asset.frameConfig } : {}),
    files: deliveryFiles,
  };
}

/**
 * Build files or ZIP delivery artifacts for the configured packs. The same
 * inputs, options and Node/zlib build produce byte-identical outputs; builds
 * never modify sources, never delete existing output, reject different bytes
 * at existing output paths, and write the manifest only after every artifact
 * is in place.
 */
export function buildAssetPacks(options: {
  readonly configPath: string;
  readonly outDir: string;
  readonly cwd?: string;
}): AssetPackBuildReport {
  const cwd = options.cwd ?? process.cwd();
  const configPath = resolve(cwd, options.configPath);
  const config = readJsonConfig(configPath);
  const rootPath = resolve(dirname(configPath), config.root);
  if (!existsSync(rootPath)) {
    throw new Error(`Pack source root does not exist: ${rootPath}`);
  }
  const outPath = resolve(cwd, options.outDir);
  const rootRelativeToOut = relative(outPath, rootPath);
  const outRelativeToRoot = relative(rootPath, outPath);
  if (
    rootRelativeToOut === ''
    || outRelativeToRoot === ''
    || !rootRelativeToOut.startsWith('..')
    || !outRelativeToRoot.startsWith('..')
  ) {
    throw new Error(
      `Output directory must be outside the pack source root: ${outPath} vs ${rootPath}`,
    );
  }
  const revisions = new Map(config.packs.map((pack) => [pack.id, pack.revision]));
  const outputs = new Map<string, Buffer>();
  const archives: {
    packId: string;
    path: string;
    entryCount: number;
    storeEntries: number;
    deflateEntries: number;
    sourceBytes: number;
    archiveBytes: number;
    sha256: string;
  }[] = [];
  const deliveryPacks: PhaserPackDeliveryPack[] = [];
  for (const pack of config.packs) {
    const packOutputPrefix = `packs/${pack.id}@${pack.revision}`;
    const planned: { asset: PhaserPackBuildAsset; files: PlannedFile[] }[] = [];
    for (const asset of pack.assets) {
      const files = planAssetFiles(asset, rootPath);
      if (pack.delivery === 'files') {
        for (const file of files) {
          outputs.set(`${packOutputPrefix}/${file.entryPath}`, file.data);
        }
      }
      planned.push({ asset, files });
    }
    let archive: PhaserPackDeliveryPack['archive'];
    if (pack.delivery === 'zip') {
      const entries: DeterministicZipEntry[] = [];
      let sourceBytes = 0;
      let storeEntries = 0;
      let deflateEntries = 0;
      for (const { files } of planned) {
        for (const file of files) {
          entries.push({
            path: file.entryPath,
            data: file.data,
            method: file.method,
          });
          sourceBytes += file.data.length;
          if (file.method === 'store') {
            storeEntries++;
          } else {
            deflateEntries++;
          }
        }
      }
      const archiveBytes = createDeterministicZip(entries);
      const archivePath = `${packOutputPrefix}.zip`;
      outputs.set(archivePath, archiveBytes);
      archive = {
        path: archivePath,
        bytes: archiveBytes.length,
        sha256: sha256Of(archiveBytes),
        entryCount: entries.length,
      };
      archives.push({
        packId: pack.id,
        path: archivePath,
        entryCount: entries.length,
        storeEntries,
        deflateEntries,
        sourceBytes,
        archiveBytes: archiveBytes.length,
        sha256: archive.sha256,
      });
    }
    deliveryPacks.push({
      packId: pack.id,
      revision: pack.revision,
      dependencies: (pack.dependsOn ?? []).map((dependency) => ({
        packId: dependency, revision: revisions.get(dependency)!,
      })),
      delivery: pack.delivery,
      assets: planned.map(({ asset, files }) => deliveryAsset(asset, files, pack)),
      ...(archive === undefined ? {} : { archive }),
    });
  }
  const manifest: PhaserPackDeliveryManifest = {
    format: PHASER_PACK_DELIVERY_FORMAT,
    version: PHASER_PACK_DELIVERY_VERSION,
    packs: deliveryPacks,
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  // The manifest describes the artifacts; it never travels inside them, and
  // consumers verify archives and entries against these external digests.
  validatePhaserPackDeliveryManifest(JSON.parse(manifestBytes.toString('utf8')));
  // Pack artifacts under packs/ are immutable: a rebuild refuses to overwrite
  // different bytes at an existing artifact path. The manifest at the output
  // root is the replaceable summary of the latest successful build; it is
  // only written after every artifact is in place.
  const outputRecords: {
    path: string;
    bytes: number;
    sha256: string;
    action: 'written' | 'unchanged';
  }[] = [];
  for (const [path, data] of outputs) {
    const target = join(outPath, path);
    if (!existsSync(target)) {
      outputRecords.push({
        path,
        bytes: data.length,
        sha256: sha256Of(data),
        action: 'written',
      });
      continue;
    }
    let existing: Buffer;
    try {
      existing = readFileSync(target);
    } catch {
      throw new Error(`Output path is not a readable file: ${path}`);
    }
    if (!existing.equals(data)) {
      throw new Error(
        `Output path already holds different bytes (immutable conflict): ${path}. `
          + 'Change the pack content or revision, or build into a new directory.',
      );
    }
    outputRecords.push({
      path,
      bytes: data.length,
      sha256: sha256Of(data),
      action: 'unchanged',
    });
  }
  const manifestTarget = join(outPath, manifestFileName);
  const manifestUnchanged = existsSync(manifestTarget)
    && (() => {
      try {
        return readFileSync(manifestTarget).equals(manifestBytes);
      } catch {
        return false;
      }
    })();
  outputRecords.push({
    path: manifestFileName,
    bytes: manifestBytes.length,
    sha256: sha256Of(manifestBytes),
    action: manifestUnchanged ? 'unchanged' : 'written',
  });
  for (const record of outputRecords) {
    if (record.action === 'unchanged') {
      continue;
    }
    const target = join(outPath, record.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, outputs.get(record.path) ?? manifestBytes);
  }
  return {
    outDir: outPath,
    manifestPath: manifestTarget,
    outputs: outputRecords,
    archives,
  };
}
