import type { PlatformTargetConfig } from '../target/schemas';

export const iconManifestSchemaVersion = 1 as const;
export const iconGeneratorVersion = '1.0.0';

export type BrandImageVariant =
  | 'maskable'
  | 'androidForeground'
  | 'monochrome'
  | 'background';

export interface BrandAppIconConfig {
  readonly source: string;
  readonly backgroundColor?: string;
  readonly variants?: Partial<Record<BrandImageVariant, string>>;
}

export interface GameBrandConfig {
  readonly appIcon: BrandAppIconConfig;
}

export interface LoadedGameBrandConfig {
  readonly appIcon: BrandAppIconConfig;
  readonly warnings: readonly string[];
}

export interface IconOutputProfile {
  readonly purpose: string;
  readonly file: string;
  readonly width: number;
  readonly height: number;
  readonly sourceVariant?: BrandImageVariant;
  readonly fallbackVariant?: BrandImageVariant;
  readonly safeZone: number;
  readonly opaque: boolean;
  readonly requiredVariant?: boolean;
}

export interface TargetIconProfile {
  readonly id: string;
  readonly version: string;
  readonly outputs: readonly IconOutputProfile[];
}

export interface IconManifestSource {
  readonly path: string;
  readonly sha256: string;
  readonly format: 'png' | 'svg';
}

export interface IconManifestOutput {
  readonly target: string;
  readonly purpose: string;
  readonly path: string;
  readonly width: number;
  readonly height: number;
  readonly format: 'png';
  readonly opaque: boolean;
  readonly sha256: string;
  readonly pixelSha256: string;
}

export interface IconManifest {
  readonly schemaVersion: typeof iconManifestSchemaVersion;
  readonly canonicalSource: IconManifestSource;
  readonly renderSource: IconManifestSource;
  readonly variantSources: Partial<Record<BrandImageVariant, IconManifestSource>>;
  readonly renderConfigSha256: string;
  readonly generatorVersion: string;
  readonly targetProfile: string;
  readonly targetProfileVersion: string;
  readonly outputs: readonly IconManifestOutput[];
  readonly warnings: readonly string[];
  readonly readiness?: {
    readonly state: 'ready' | 'console-upload-required';
    readonly message: string;
    readonly externalUrl?: string;
  };
}

export interface GeneratedTargetIcons {
  readonly gameRoot: string;
  readonly target: string;
  readonly targetConfig: PlatformTargetConfig;
  readonly profile: TargetIconProfile;
  readonly manifest: IconManifest;
  readonly manifestPath: string;
  readonly manifestSha256: string;
  readonly outputDir: string;
  readonly aitBrandIcon?: string;
}
