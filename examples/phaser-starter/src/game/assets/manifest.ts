export interface StarterImageAsset {
  readonly key: string;
  readonly path: string;
}

export const starterImageAssets = [
  {
    key: 'starter-logo',
    path: '/assets/starter-logo.svg',
  },
] as const satisfies readonly StarterImageAsset[];
