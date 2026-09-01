export interface StarterImageAsset {
  readonly key: string;
  readonly path: string;
}

export const starterImageAssets = [
  {
    key: 'starter-logo',
    path: starterLogoUrl,
  },
] as const satisfies readonly StarterImageAsset[];
import starterLogoUrl from '../../assets/starter-logo.png?url';
