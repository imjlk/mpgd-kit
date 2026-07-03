export const assetManifest = {
  images: {
    orb: {
      key: 'orb',
      path: '/assets/ui/orb.svg',
    },
  },
} as const;

export type ImageAssetKey = keyof typeof assetManifest.images;
