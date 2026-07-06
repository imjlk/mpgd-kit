import { definePhaserAssetManifest, type PhaserAssetManifest } from '@mpgd/phaser-assets';

import markerUrl from './marker.svg?url';

export const starterAssetKeys = {
  marker: '__GAME_NAME__.marker',
} as const;

export const starterAssets = definePhaserAssetManifest([
  {
    kind: 'image',
    key: starterAssetKeys.marker,
    url: markerUrl,
  },
] as const satisfies PhaserAssetManifest);
