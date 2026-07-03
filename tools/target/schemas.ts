import typia from 'typia';

export type TargetKind = 'web' | 'capacitor-android' | 'capacitor-ios' | 'apps-in-toss';

export interface BaseTargetConfig {
  readonly kind: TargetKind;
  readonly gameApp: string;
  readonly adapter: string;
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

export type PlatformTargetConfig =
  | WebTargetConfig
  | CapacitorTargetConfig
  | AppsInTossTargetConfig;

export interface PlatformTargetsConfig {
  readonly targets: Record<string, PlatformTargetConfig>;
}

export const assertPlatformTargetsConfig = typia.createAssert<PlatformTargetsConfig>();
