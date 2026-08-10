import typia from 'typia';

import type { TargetIntegrationConfig } from '@mpgd/target-config';

export type TargetKind =
  | 'web'
  | 'capacitor-android'
  | 'capacitor-ios'
  | 'apps-in-toss'
  | 'devvit-web';

export interface BaseTargetConfig {
  readonly kind: TargetKind;
  readonly gameApp: string;
  readonly adapter: string;
  readonly metadata?: TargetReleaseMetadata;
  /** Required when purchases or rewarded grants use a game-owned authority. */
  readonly authoritativeGameServices?: boolean;
  readonly integrations?: Partial<TargetIntegrationConfig>;
  readonly icon?: TargetIconConfig;
}

export interface TargetIconConfig {
  /** Versioned profile id. Omit to infer the built-in profile from the target kind. */
  readonly profile?: string;
  /** Optional target rendering source. The canonical source remains recorded in evidence. */
  readonly source?: string;
  readonly backgroundColor?: string;
  readonly externalUrl?: string;
  readonly variants?: {
    readonly maskable?: string;
    readonly androidForeground?: string;
    readonly monochrome?: string;
    readonly background?: string;
  };
}

export interface TargetReleaseMetadata {
  readonly appName?: string;
  readonly displayName?: string;
  readonly primaryColor?: string;
  readonly packageId?: string;
  readonly bundleId?: string;
  readonly sdkMajor?: number;
}

export interface WebTargetConfig extends BaseTargetConfig {
  readonly kind: 'web';
  readonly output: string;
  /** Whether the artifact should include an installable web app manifest. Defaults to true. */
  readonly installable?: boolean;
  /** Optional game-owned files copied over the built web artifact. */
  readonly staticDir?: string;
}

export interface CapacitorTargetConfig extends BaseTargetConfig {
  readonly kind: 'capacitor-android' | 'capacitor-ios';
  readonly shellApp: string;
  readonly webDir: string;
  readonly artifact: 'aab' | 'apk' | 'ipa';
}

export interface AppsInTossTargetConfig extends BaseTargetConfig {
  readonly kind: 'apps-in-toss';
  readonly wrapperApp: string;
  readonly webDir: string;
  readonly artifact: '.ait';
  /** Build-time Apps in Toss navigation chrome for this deployment target. */
  readonly navigationBar?: AppsInTossNavigationBarConfig;
}

export interface AppsInTossNavigationBarConfig {
  readonly withBackButton?: boolean;
  readonly withHomeButton?: boolean;
  readonly withTitle?: boolean;
  readonly transparentBackground?: boolean;
  readonly theme?: 'light' | 'dark';
}

export interface DevvitTargetConfig extends BaseTargetConfig {
  readonly kind: 'devvit-web';
  readonly wrapperApp: string;
  readonly webDir: string;
  readonly artifact: 'devvit';
}

export type PlatformTargetConfig =
  | WebTargetConfig
  | CapacitorTargetConfig
  | AppsInTossTargetConfig
  | DevvitTargetConfig;

export interface PlatformTargetsConfig {
  readonly targets: Record<string, PlatformTargetConfig>;
}

export const assertPlatformTargetsConfig = typia.createAssert<PlatformTargetsConfig>();
