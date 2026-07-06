import type Phaser from 'phaser';

export type PhaserAssetKind =
  | 'image'
  | 'spritesheet'
  | 'atlas'
  | 'audio'
  | 'json'
  | 'binary';

export interface PhaserImageAsset<TKey extends string = string> {
  readonly kind: 'image';
  readonly key: TKey;
  readonly url: string;
}

export interface PhaserSpritesheetAsset<TKey extends string = string> {
  readonly kind: 'spritesheet';
  readonly key: TKey;
  readonly url: string;
  readonly frameConfig: Phaser.Types.Loader.FileTypes.ImageFrameConfig;
}

export interface PhaserAtlasAsset<TKey extends string = string> {
  readonly kind: 'atlas';
  readonly key: TKey;
  readonly textureUrl: string;
  readonly atlasUrl: string;
}

export interface PhaserAudioAsset<TKey extends string = string> {
  readonly kind: 'audio';
  readonly key: TKey;
  readonly urls: string | readonly string[];
}

export interface PhaserJsonAsset<TKey extends string = string> {
  readonly kind: 'json';
  readonly key: TKey;
  readonly url: string;
}

export interface PhaserBinaryAsset<TKey extends string = string> {
  readonly kind: 'binary';
  readonly key: TKey;
  readonly url: string;
  readonly dataType?: unknown;
}

export type PhaserAsset<TKey extends string = string> =
  | PhaserImageAsset<TKey>
  | PhaserSpritesheetAsset<TKey>
  | PhaserAtlasAsset<TKey>
  | PhaserAudioAsset<TKey>
  | PhaserJsonAsset<TKey>
  | PhaserBinaryAsset<TKey>;

export type PhaserAssetManifest<TAsset extends PhaserAsset = PhaserAsset> = readonly TAsset[];

export function definePhaserAssetManifest<const TAsset extends PhaserAssetManifest>(
  assets: TAsset,
): TAsset {
  assertUniqueAssetKeys(assets);

  return assets;
}

export function loadPhaserAssets(scene: Phaser.Scene, assets: PhaserAssetManifest): void {
  for (const asset of assets) {
    loadPhaserAsset(scene, asset);
  }
}

export function loadPhaserAsset(scene: Phaser.Scene, asset: PhaserAsset): void {
  switch (asset.kind) {
    case 'image':
      scene.load.image(asset.key, asset.url);
      return;
    case 'spritesheet':
      scene.load.spritesheet(asset.key, asset.url, asset.frameConfig);
      return;
    case 'atlas':
      scene.load.atlas(asset.key, asset.textureUrl, asset.atlasUrl);
      return;
    case 'audio':
      scene.load.audio(asset.key, toUrlArray(asset.urls));
      return;
    case 'json':
      scene.load.json(asset.key, asset.url);
      return;
    case 'binary':
      scene.load.binary(asset.key, asset.url, asset.dataType);
      return;
  }

  assertNeverAsset(asset);
}

function assertUniqueAssetKeys(assets: PhaserAssetManifest): void {
  const keys = new Set<string>();

  for (const asset of assets) {
    if (keys.has(asset.key)) {
      throw new Error(`Duplicate Phaser asset key: ${asset.key}`);
    }

    keys.add(asset.key);
  }
}

function toUrlArray(value: string | readonly string[]): string[] {
  return typeof value === 'string' ? [value] : [...value];
}

function assertNeverAsset(asset: never): never {
  throw new Error(`Unhandled Phaser asset: ${JSON.stringify(asset)}`);
}
