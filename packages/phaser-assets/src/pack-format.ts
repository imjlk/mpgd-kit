/**
 * Pure pack delivery-format contract shared by producers and consumers.
 * This module must stay free of Node, DOM, Phaser and compression work:
 * it only describes, validates and normalizes data.
 */
export const PHASER_PACK_DELIVERY_FORMAT = 'mpgd-asset-packs';
export const PHASER_PACK_DELIVERY_VERSION = 1;
export type PhaserPackDeliveryKind = 'files' | 'zip';
export type PhaserPackEntryMethod = 'store' | 'deflate';
export type PhaserPackBuildAssetKind = 'image' | 'spritesheet' | 'atlas';
/** Mirrors the loader's file roles; an atlas asset uses both. */
export type PhaserPackFormatFileRole = 'texture' | 'atlas';
/** Structurally compatible with Phaser's spritesheet frame config. */
export interface PhaserPackFrameConfig {
  readonly frameWidth: number;
  readonly frameHeight: number;
  readonly startFrame?: number | undefined;
  readonly endFrame?: number | undefined;
  readonly margin?: number | undefined;
  readonly spacing?: number | undefined;
}
export interface PhaserPackBuildConfig {
  /** Project root that relative source paths resolve against. */
  readonly root: string;
  readonly packs: readonly PhaserPackBuildPack[];
}
export interface PhaserPackBuildPack {
  readonly id: string;
  /** Logical content revision; independent of delivery artifact digests. */
  readonly revision: string;
  readonly dependsOn?: readonly string[];
  readonly delivery: PhaserPackDeliveryKind;
  readonly assets: readonly PhaserPackBuildAsset[];
}
export interface PhaserPackBuildAssetBase {
  readonly key: string;
  /** Per-asset compression override; unsupported methods are rejected. */
  readonly compression?: PhaserPackEntryMethod | undefined;
}
export interface PhaserPackBuildImageAsset extends PhaserPackBuildAssetBase {
  readonly kind: 'image';
  readonly file: string;
}
export interface PhaserPackBuildSpritesheetAsset extends PhaserPackBuildAssetBase {
  readonly kind: 'spritesheet';
  readonly file: string;
  readonly frameConfig: PhaserPackFrameConfig;
}
export interface PhaserPackBuildAtlasAsset extends PhaserPackBuildAssetBase {
  readonly kind: 'atlas';
  readonly texture: string;
  readonly atlas: string;
}
export type PhaserPackBuildAsset =
  | PhaserPackBuildImageAsset
  | PhaserPackBuildSpritesheetAsset
  | PhaserPackBuildAtlasAsset;
export interface PhaserPackDeliveryManifest {
  readonly format: typeof PHASER_PACK_DELIVERY_FORMAT;
  readonly version: typeof PHASER_PACK_DELIVERY_VERSION;
  readonly packs: readonly PhaserPackDeliveryPack[];
}
export interface PhaserPackDeliveryPack {
  readonly packId: string;
  /** Logical content revision from the build input, not an artifact digest. */
  readonly revision: string;
  readonly dependencies: readonly PhaserPackDeliveryDependency[];
  readonly delivery: PhaserPackDeliveryKind;
  readonly assets: readonly PhaserPackDeliveryAsset[];
  /** Present for zip delivery only. */
  readonly archive?: PhaserPackDeliveryArchive | undefined;
}
export interface PhaserPackDeliveryDependency {
  readonly packId: string;
  readonly revision: string;
}
export interface PhaserPackDeliveryAsset {
  readonly assetKey: string;
  readonly kind: PhaserPackBuildAssetKind;
  readonly frameConfig?: PhaserPackFrameConfig | undefined;
  readonly files: readonly PhaserPackDeliveryFile[];
}
export interface PhaserPackDeliveryFile {
  readonly role: PhaserPackFormatFileRole;
  readonly mediaType: string;
  /** Uncompressed source file bytes and digest, never pixel memory. */
  readonly bytes: number;
  readonly sha256: string;
  /** files delivery: artifact path. zip delivery: archive entry path. */
  readonly path: string;
  /** zip delivery only: how the entry is stored in the archive. */
  readonly method?: PhaserPackEntryMethod | undefined;
}
export interface PhaserPackDeliveryArchive {
  /** Archive artifact path relative to the delivery output root. */
  readonly path: string;
  /** Archive artifact bytes and digest; distinct from any entry's bytes. */
  readonly bytes: number;
  readonly sha256: string;
  readonly entryCount: number;
}
const digestPattern = /^[0-9a-f]{64}$/u;
/** Case-insensitive filesystems and extractors treat case-folded pack ids and
 * paths as the same file; NFC alone does not encode that equivalence. */
function rejectFoldedDuplicate(seen: Set<string>, value: string, error: (input: string) => Error): void {
  const folded = value.toLowerCase();
  if (seen.has(folded)) {
    throw error(value);
  }
  seen.add(folded);
}
const knownMediaTypes: ReadonlyMap<string, { mediaType: string; defaultMethod: PhaserPackEntryMethod }> = new Map(
  [
    ['png', { mediaType: 'image/png', defaultMethod: 'store' }],
    ['jpg', { mediaType: 'image/jpeg', defaultMethod: 'store' }],
    ['jpeg', { mediaType: 'image/jpeg', defaultMethod: 'store' }],
    ['webp', { mediaType: 'image/webp', defaultMethod: 'store' }],
    ['svg', { mediaType: 'image/svg+xml', defaultMethod: 'deflate' }],
    ['json', { mediaType: 'application/json', defaultMethod: 'deflate' }],
  ],
);
/** Media type and default ZIP entry method for a supported source path. */
export function phaserPackMediaTypeForPath(path: string): {
  readonly mediaType: string;
  readonly defaultMethod: PhaserPackEntryMethod;
} | null {
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return knownMediaTypes.get(extension) ?? null;
}
/**
 * Validate one normalized relative file path for pack sources and archive
 * entries: UTF-8 NFC, forward slashes only, no absolute or drive paths, no
 * NUL, "." or ".." components and no empty components. Deployment URL
 * encoding is deliberately not handled here; ZIP entry names and served URL
 * paths are separate concerns.
 */
export function parsePhaserPackEntryPath(input: string): string {
  if (
    typeof input !== 'string'
    || input.length === 0
    || input.includes('\0')
    || input.includes('\\')
    || input.includes('\n')
  ) {
    throw new Error(`Invalid pack file path: ${JSON.stringify(input)}`);
  }
  if (input.normalize('NFC') !== input) {
    throw new Error(`Invalid pack file path (must use Unicode NFC): ${JSON.stringify(input)}`);
  }
  const components = input.split('/');
  if (
    input.startsWith('/')
    || /^[A-Za-z]:/u.test(input)
    || components.some((component) => component === '.')
    || components.some((component) => component === '..')
    || components.some((component) => component.length === 0)
    || components.some((component) => component.includes(':'))
  ) {
    throw new Error(`Invalid pack file path: ${JSON.stringify(input)}`);
  }
  return input;
}
function expectString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid asset pack build config: ${label} must be a non-empty string`);
  }
  return value;
}
function expectStringArray(value: unknown, label: string): string[] {
  const invalid = !Array.isArray(value)
    || value.some((entry) => typeof entry !== 'string' || entry.length === 0);
  if (invalid) {
    throw new Error(
      `Invalid asset pack build config: ${label} must be an array of non-empty strings`,
    );
  }
  return [...value];
}
function expectEntryMethod(value: unknown, label: string): PhaserPackEntryMethod {
  if (value !== 'store' && value !== 'deflate') {
    throw new Error(`Invalid asset pack build config: ${label} must be 'store' or 'deflate'`);
  }
  return value;
}
function expectDeliveryKind(value: unknown, label: string): PhaserPackDeliveryKind {
  if (value !== 'files' && value !== 'zip') {
    throw new Error(`${label} delivery must be 'files' or 'zip'`);
  }
  return value;
}
function expectAssetKind(value: unknown, label: string): PhaserPackBuildAssetKind {
  if (value !== 'image' && value !== 'spritesheet' && value !== 'atlas') {
    throw new Error(`${label} kind must be image, spritesheet or atlas`);
  }
  return value;
}
function expectFileRole(value: unknown, label: string): PhaserPackFormatFileRole {
  if (value !== 'texture' && value !== 'atlas') {
    throw new Error(`${label} role must be 'texture' or 'atlas'`);
  }
  return value;
}
function parseFrameConfig(value: unknown, label: string): PhaserPackFrameConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid asset pack build config: ${label} frameConfig must be an object`);
  }
  const source = value as Record<string, unknown>;
  const frameWidth: unknown = source.frameWidth;
  const frameHeight: unknown = source.frameHeight;
  if (typeof frameWidth !== 'number' || !Number.isSafeInteger(frameWidth) || frameWidth <= 0
    || typeof frameHeight !== 'number' || !Number.isSafeInteger(frameHeight) || frameHeight <= 0) {
    throw new Error(
      `Invalid asset pack build config: ${label} frame size must be positive integers`,
    );
  }
  const optional = (name: string): number | undefined => {
    const entry: unknown = source[name];
    if (entry === undefined) {
      return undefined;
    }
    if (typeof entry !== 'number' || !Number.isSafeInteger(entry) || entry < 0) {
      throw new Error(
        `Invalid asset pack build config: ${label} frameConfig.${name} must be a non-negative integer`,
      );
    }
    return entry;
  };
  return {
    frameWidth,
    frameHeight,
    startFrame: optional('startFrame'),
    endFrame: optional('endFrame'),
    margin: optional('margin'),
    spacing: optional('spacing'),
  };
}
function parseBuildAsset(value: unknown, label: string): PhaserPackBuildAsset {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid asset pack build config: ${label} must be an object`);
  }
  const source = value as Record<string, unknown>;
  const key = expectString(source.key, `${label} key`);
  const kind = source.kind;
  const compression = source.compression === undefined
    ? undefined
    : expectEntryMethod(source.compression, `${label} compression`);
  if (kind === 'image' || kind === 'spritesheet') {
    const file = parsePhaserPackEntryPath(expectString(source.file, `${label} file`));
    if (kind === 'image') {
      return { kind, key, file, compression };
    }
    return {
      kind,
      key,
      file,
      compression,
      frameConfig: parseFrameConfig(source.frameConfig, `${label}`),
    };
  }
  if (kind === 'atlas') {
    return {
      kind,
      key,
      compression,
      texture: parsePhaserPackEntryPath(expectString(source.texture, `${label} texture`)),
      atlas: parsePhaserPackEntryPath(expectString(source.atlas, `${label} atlas`)),
    };
  }
  throw new Error(
    `Invalid asset pack build config: ${label} kind must be image, spritesheet or atlas`,
  );
}
/** Validate untrusted build input. Arrays keep their configured order. */
export function validatePhaserPackBuildConfig(input: unknown): PhaserPackBuildConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Invalid asset pack build config: expected an object');
  }
  const source = input as Record<string, unknown>;
  const root = expectString(source.root, 'root');
  if (!Array.isArray(source.packs) || source.packs.length === 0) {
    throw new Error('Invalid asset pack build config: packs must be a non-empty array');
  }
  const packs = source.packs.map((value, index) => {
    const label = `packs[${index}]`;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`Invalid asset pack build config: ${label} must be an object`);
    }
    const pack = value as Record<string, unknown>;
    const id = expectString(pack.id, `${label} id`);
    const revision = expectString(pack.revision, `${label} revision`);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(id)) {
      throw new Error(`Invalid asset pack build config: ${label} id must match [A-Za-z0-9][A-Za-z0-9._-]*`);
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._+=-]*$/u.test(revision)) {
      throw new Error(
        `Invalid asset pack build config: ${label} revision must match [A-Za-z0-9][A-Za-z0-9._+=-]*`,
      );
    }
    const delivery = expectDeliveryKind(pack.delivery, `Invalid asset pack build config: ${label}`);
    const dependsOn = pack.dependsOn === undefined ? [] : expectStringArray(pack.dependsOn, `${label} dependsOn`);
    if (new Set(dependsOn).size !== dependsOn.length) {
      throw new Error(`Invalid asset pack build config: ${label} dependsOn contains duplicates`);
    }
    if (!Array.isArray(pack.assets)) {
      throw new Error(`Invalid asset pack build config: ${label} assets must be an array`);
    }
    if (delivery === 'zip' && pack.assets.length === 0) {
      throw new Error(`Invalid asset pack build config: ${label} zip delivery requires at least one asset`);
    }
    const assets = pack.assets.map((asset, assetIndex) => parseBuildAsset(
      asset,
      `${label} assets[${assetIndex}]`,
    ));
    return { id, revision, dependsOn, delivery, assets };
  });
  const ids = new Set<string>();
  const foldedIds = new Set<string>();
  for (const pack of packs) {
    if (ids.has(pack.id)) {
      throw new Error(`Invalid asset pack build config: duplicate pack id ${pack.id}`);
    }
    ids.add(pack.id);
    // Case-insensitive filesystems and extractors treat case-folded ids and
    // paths as the same file; NFC alone does not encode that equivalence.
    rejectFoldedDuplicate(
      foldedIds,
      pack.id,
      (id) => new Error(`Invalid asset pack build config: case-colliding pack id ${id}`),
    );
    const keys = new Set<string>();
    const paths = new Set<string>();
    const foldedPaths = new Set<string>();
    for (const asset of pack.assets) {
      if (keys.has(asset.key)) {
        throw new Error(
          `Invalid asset pack build config: duplicate asset key ${pack.id}/${asset.key}`,
        );
      }
      keys.add(asset.key);
      const files = asset.kind === 'atlas' ? [asset.texture, asset.atlas] : [asset.file];
      for (const file of files) {
        if (paths.has(file)) {
          throw new Error(`Invalid asset pack build config: duplicate file ${pack.id}/${file}`);
        }
        rejectFoldedDuplicate(
          foldedPaths,
          file,
          (input) => new Error(
            `Invalid asset pack build config: case-colliding file ${pack.id}/${input}`,
          ),
        );
        paths.add(file);
      }
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(packs.map((pack) => [pack.id, pack]));
  const visit = (id: string): void => {
    if (visiting.has(id)) {
      throw new Error(`Invalid asset pack build config: cyclic dependency at ${id}`);
    }
    if (visited.has(id)) {
      return;
    }
    visiting.add(id);
    for (const dependency of byId.get(id)!.dependsOn) {
      if (!byId.has(dependency)) {
        throw new Error(
          `Invalid asset pack build config: unknown dependency ${id} -> ${dependency}`,
        );
      }
      visit(dependency);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const pack of packs) {
    visit(pack.id);
  }
  return { root, packs };
}
function expectDigest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !digestPattern.test(value)) {
    throw new Error(
      `Invalid asset pack delivery manifest: ${label} must be a lowercase SHA-256 digest`,
    );
  }
  return value;
}
function expectPositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`Invalid asset pack delivery manifest: ${label} must be a positive integer`);
  }
  return value as number;
}
/**
 * Validate an untrusted delivery manifest: format version, pack identity,
 * dependency revisions, role pairing per asset kind, path rules, digests and
 * the files/zip shape. Digests prove integrity of described bytes only; they
 * are not origin authentication.
 */
export function validatePhaserPackDeliveryManifest(input: unknown): PhaserPackDeliveryManifest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Invalid asset pack delivery manifest: expected an object');
  }
  const source = input as Record<string, unknown>;
  if (source.format !== PHASER_PACK_DELIVERY_FORMAT) {
    throw new Error(
      `Invalid asset pack delivery manifest: format must be '${PHASER_PACK_DELIVERY_FORMAT}'`,
    );
  }
  if (source.version !== PHASER_PACK_DELIVERY_VERSION) {
    throw new Error(
      `Invalid asset pack delivery manifest: unsupported version ${JSON.stringify(source.version)}`,
    );
  }
  if (!Array.isArray(source.packs) || source.packs.length === 0) {
    throw new Error('Invalid asset pack delivery manifest: packs must be a non-empty array');
  }
  const packs = source.packs.map((value, index) => {
    const label = `packs[${index}]`;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`Invalid asset pack delivery manifest: ${label} must be an object`);
    }
    const pack = value as Record<string, unknown>;
    const packId = expectString(pack.packId, `${label} packId`);
    const revision = expectString(pack.revision, `${label} revision`);
    const delivery = expectDeliveryKind(
      pack.delivery,
      `Invalid asset pack delivery manifest: ${label}`,
    );
    if (!Array.isArray(pack.dependencies)) {
      throw new Error(`Invalid asset pack delivery manifest: ${label} dependencies must be an array`);
    }
    const dependencies = pack.dependencies.map((dependency, dependencyIndex) => {
      const dependencyLabel = `${label} dependencies[${dependencyIndex}]`;
      if (!dependency || typeof dependency !== 'object' || Array.isArray(dependency)) {
        throw new Error(`Invalid asset pack delivery manifest: ${dependencyLabel} must be an object`);
      }
      const entry = dependency as Record<string, unknown>;
      return {
        packId: expectString(entry.packId, `${dependencyLabel} packId`),
        revision: expectString(entry.revision, `${dependencyLabel} revision`),
      };
    });
    if (!Array.isArray(pack.assets)) {
      throw new Error(`Invalid asset pack delivery manifest: ${label} assets must be an array`);
    }
    const assets = pack.assets.map((assetValue, assetIndex) => {
      const assetLabel = `${label} assets[${assetIndex}]`;
      if (!assetValue || typeof assetValue !== 'object' || Array.isArray(assetValue)) {
        throw new Error(`Invalid asset pack delivery manifest: ${assetLabel} must be an object`);
      }
      const asset = assetValue as Record<string, unknown>;
      const assetKey = expectString(asset.assetKey, `${assetLabel} assetKey`);
      const kind = expectAssetKind(asset.kind, `Invalid asset pack delivery manifest: ${assetLabel}`);
      const frameConfig = asset.frameConfig === undefined
        ? undefined
        : parseFrameConfig(asset.frameConfig, assetLabel);
      if (asset.kind === 'spritesheet' && frameConfig === undefined) {
        throw new Error(`Invalid asset pack delivery manifest: ${assetLabel} spritesheet requires frameConfig`);
      }
      if (asset.kind !== 'spritesheet' && frameConfig !== undefined) {
        throw new Error(`Invalid asset pack delivery manifest: ${assetLabel} frameConfig is inapplicable`);
      }
      if (!Array.isArray(asset.files) || asset.files.length === 0) {
        throw new Error(`Invalid asset pack delivery manifest: ${assetLabel} files must be a non-empty array`);
      }
      const files = asset.files.map((fileValue, fileIndex) => {
        const fileLabel = `${assetLabel} files[${fileIndex}]`;
        if (!fileValue || typeof fileValue !== 'object' || Array.isArray(fileValue)) {
          throw new Error(`Invalid asset pack delivery manifest: ${fileLabel} must be an object`);
        }
        const file = fileValue as Record<string, unknown>;
        const role = expectFileRole(file.role, `Invalid asset pack delivery manifest: ${fileLabel}`);
        const method = file.method === undefined ? undefined : expectEntryMethod(file.method, fileLabel);
        if (pack.delivery === 'zip' && method === undefined) {
          throw new Error(`Invalid asset pack delivery manifest: ${fileLabel} requires an entry method for zip delivery`);
        }
        if (pack.delivery === 'files' && method !== undefined) {
          throw new Error(`Invalid asset pack delivery manifest: ${fileLabel} method is inapplicable for files delivery`);
        }
        return {
          role,
          mediaType: expectString(file.mediaType, `${fileLabel} mediaType`),
          bytes: expectPositiveInteger(file.bytes, `${fileLabel} bytes`),
          sha256: expectDigest(file.sha256, `${fileLabel} sha256`),
          path: parsePhaserPackEntryPath(expectString(file.path, `${fileLabel} path`)),
          method,
        };
      });
      const roles = files.map((file) => file.role);
      const expectedRoles: PhaserPackFormatFileRole[] = asset.kind === 'atlas'
        ? ['texture', 'atlas']
        : ['texture'];
      if (JSON.stringify(roles) !== JSON.stringify(expectedRoles)) {
        throw new Error(
          `Invalid asset pack delivery manifest: ${assetLabel} roles must be ${expectedRoles.join(',')}`,
        );
      }
      return { assetKey, kind, frameConfig, files };
    });
    let archive: PhaserPackDeliveryArchive | undefined;
    if (pack.archive !== undefined) {
      const archiveLabel = `${label} archive`;
      if (!pack.archive || typeof pack.archive !== 'object' || Array.isArray(pack.archive)) {
        throw new Error(`Invalid asset pack delivery manifest: ${archiveLabel} must be an object`);
      }
      const archiveSource = pack.archive as Record<string, unknown>;
      archive = {
        path: parsePhaserPackEntryPath(expectString(archiveSource.path, `${archiveLabel} path`)),
        bytes: expectPositiveInteger(archiveSource.bytes, `${archiveLabel} bytes`),
        sha256: expectDigest(archiveSource.sha256, `${archiveLabel} sha256`),
        entryCount: expectPositiveInteger(archiveSource.entryCount, `${archiveLabel} entryCount`),
      };
    }
    if (pack.delivery === 'zip' && archive === undefined) {
      throw new Error(`Invalid asset pack delivery manifest: ${label} zip delivery requires an archive`);
    }
    if (pack.delivery === 'files' && archive !== undefined) {
      throw new Error(`Invalid asset pack delivery manifest: ${label} archive is inapplicable for files delivery`);
    }
    return { packId, revision, dependencies, delivery, assets, archive };
  });
  const byId = new Map(packs.map((pack) => [pack.packId, pack]));
  const archivePaths = new Set<string>();
  const foldedArchivePaths = new Set<string>();
  const seenPackIds = new Set<string>();
  const foldedPackIds = new Set<string>();
  const visitingPacks = new Set<string>();
  const visitedPacks = new Set<string>();
  const visit = (packId: string): void => {
    if (visitingPacks.has(packId)) {
      throw new Error(`Invalid asset pack delivery manifest: cyclic dependency at ${packId}`);
    }
    if (visitedPacks.has(packId)) {
      return;
    }
    const pack = byId.get(packId);
    if (pack === undefined) {
      return;
    }
    visitingPacks.add(packId);
    for (const dependency of pack.dependencies) {
      visit(dependency.packId);
    }
    visitingPacks.delete(packId);
    visitedPacks.add(packId);
  };
  for (const pack of packs) {
    if (seenPackIds.has(pack.packId)) {
      throw new Error(`Invalid asset pack delivery manifest: duplicate pack id ${pack.packId}`);
    }
    seenPackIds.add(pack.packId);
    rejectFoldedDuplicate(
      foldedPackIds,
      pack.packId,
      (id) => new Error(`Invalid asset pack delivery manifest: case-colliding pack id ${id}`),
    );
    visit(pack.packId);
    const keys = new Set<string>();
    const paths = new Set<string>();
    const foldedPaths = new Set<string>();
    for (const asset of pack.assets) {
      if (keys.has(asset.assetKey)) {
        throw new Error(
          `Invalid asset pack delivery manifest: duplicate asset key ${pack.packId}/${asset.assetKey}`,
        );
      }
      keys.add(asset.assetKey);
      for (const file of asset.files) {
        if (paths.has(file.path)) {
          throw new Error(
            `Invalid asset pack delivery manifest: duplicate path ${pack.packId}/${file.path}`,
          );
        }
        rejectFoldedDuplicate(
          foldedPaths,
          file.path,
          (input) => new Error(
            `Invalid asset pack delivery manifest: case-colliding path ${pack.packId}/${input}`,
          ),
        );
        paths.add(file.path);
      }
    }
    for (const dependency of pack.dependencies) {
      const resolved = byId.get(dependency.packId);
      if (resolved === undefined) {
        throw new Error(
          `Invalid asset pack delivery manifest: unknown dependency ${pack.packId} -> ${dependency.packId}`,
        );
      }
      if (resolved.revision !== dependency.revision) {
        throw new Error(
          `Invalid asset pack delivery manifest: stale dependency revision ${pack.packId} -> ${dependency.packId}`,
        );
      }
    }
    if (pack.archive) {
      if (archivePaths.has(pack.archive.path)) {
        throw new Error(
          `Invalid asset pack delivery manifest: duplicate archive path ${pack.archive.path}`,
        );
      }
      rejectFoldedDuplicate(
        foldedArchivePaths,
        pack.archive.path,
        (input) => new Error(
          `Invalid asset pack delivery manifest: case-colliding archive path ${input}`,
        ),
      );
      archivePaths.add(pack.archive.path);
    }
  }
  return { format: PHASER_PACK_DELIVERY_FORMAT, version: PHASER_PACK_DELIVERY_VERSION, packs };
}
