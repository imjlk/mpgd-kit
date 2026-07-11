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
  readonly integrations?: Partial<TargetIntegrationConfig>;
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
