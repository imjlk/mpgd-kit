import {
  createPhaserAssetUrl,
  definePhaserAssetManifest,
  type PhaserAssetManifest,
} from '@mpgd/phaser-assets';

export const starterAssetKeys = {
  marker: '__GAME_NAME__.marker',
} as const;

export const starterAssets = definePhaserAssetManifest([
  {
    kind: 'image',
    key: starterAssetKeys.marker,
    url: createPhaserAssetUrl('./marker.svg', import.meta.url),
  },
] as const satisfies PhaserAssetManifest);
