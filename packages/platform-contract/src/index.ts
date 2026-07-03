import type { LeaderboardAdapter } from '@mpgd/leaderboard-contract';
import type { AdAdapter, CommerceAdapter } from '@mpgd/monetization-contract';

export type PlatformTarget = 'browser' | 'android' | 'ios' | 'ait' | 'reddit' | 'telegram' | 'tauri';

export interface PlatformCapabilities {
  readonly nativeIap: boolean;
  readonly nativeAds: boolean;
  readonly rewardedAds: boolean;
  readonly interstitialAds: boolean;
  readonly nativeLeaderboard: boolean;
  readonly achievements: boolean;
  readonly cloudSave: boolean;
  readonly socialShare: boolean;
  readonly haptics: boolean;
  readonly localizedContent: boolean;
}

export interface PlayerIdentity {
  readonly playerId: string;
  readonly displayName?: string;
  readonly avatarUrl?: string;
}

export interface IdentityAdapter {
  getPlayer(): Promise<PlayerIdentity | null>;
}

export interface LifecycleAdapter {
  onPause(callback: () => void): () => void;
  onResume(callback: () => void): () => void;
}

export interface StorageAdapter {
  load(input: { readonly key: string }): Promise<unknown | null>;
  save(input: { readonly key: string; readonly value: unknown }): Promise<void>;
}

export interface PlatformGateway {
  readonly target: PlatformTarget;
  getCapabilities(): Promise<PlatformCapabilities>;
  readonly identity: IdentityAdapter;
  readonly commerce: CommerceAdapter;
  readonly ads: AdAdapter;
  readonly leaderboard: LeaderboardAdapter;
  readonly lifecycle: LifecycleAdapter;
  readonly storage: StorageAdapter;
}

export function createUnsupportedCapabilities(): PlatformCapabilities {
  return {
    nativeIap: false,
    nativeAds: false,
    rewardedAds: false,
    interstitialAds: false,
    nativeLeaderboard: false,
    achievements: false,
    cloudSave: false,
    socialShare: false,
    haptics: false,
    localizedContent: false,
  };
}
