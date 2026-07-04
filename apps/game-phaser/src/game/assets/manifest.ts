export interface GameImageAsset {
  readonly key: string;
  readonly path: string;
  readonly loader: 'svg';
  readonly width: number;
  readonly height: number;
}

export interface GameAssetEntry {
  readonly category: 'images';
  readonly key: string;
  readonly path: string;
}

export const gameImageAssets = {
  orb: {
    key: 'orb',
    path: '/assets/ui/orb.svg',
    loader: 'svg',
    width: 96,
    height: 96,
  },
} as const satisfies Record<string, GameImageAsset>;

export const gameAssetManifest = {
  images: gameImageAssets,
} as const;

export type GameImageAssetKey = keyof typeof gameImageAssets;

export function listGameAssets(): readonly GameAssetEntry[] {
  return Object.values(gameImageAssets).map((asset) => ({
    category: 'images',
    key: asset.key,
    path: asset.path,
  }));
}
