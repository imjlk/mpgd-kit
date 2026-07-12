import type { PlatformTargetConfig } from '../target/schemas';
import type { IconOutputProfile, TargetIconProfile } from './types';

const png = (
  purpose: string,
  file: string,
  size: number,
  options: Omit<IconOutputProfile, 'purpose' | 'file' | 'width' | 'height'>,
): IconOutputProfile => ({ purpose, file, width: size, height: size, ...options });

const profiles = {
  'web-preview': {
    id: 'web-preview',
    version: '1.0.0',
    outputs: [
      png('favicon', 'favicon-32.png', 32, { safeZone: 0.9, opaque: false }),
      png('app-icon', 'icon-192.png', 192, { safeZone: 0.9, opaque: false }),
      png('app-icon', 'icon-512.png', 512, { safeZone: 0.9, opaque: false }),
    ],
  },
  'microsoft-pwa': {
    id: 'microsoft-pwa',
    version: '1.0.0',
    outputs: [
      png('any', 'icon-any-192.png', 192, { safeZone: 0.9, opaque: false }),
      png('any', 'icon-any-512.png', 512, { safeZone: 0.9, opaque: false }),
      png('maskable', 'icon-maskable-192.png', 192, {
        sourceVariant: 'maskable',
        safeZone: 0.8,
        opaque: true,
      }),
      png('maskable', 'icon-maskable-512.png', 512, {
        sourceVariant: 'maskable',
        safeZone: 0.8,
        opaque: true,
      }),
    ],
  },
  devvit: {
    id: 'devvit',
    version: '1.0.0',
    outputs: [png('app-icon', 'marketing-icon-1024.png', 1024, {
      safeZone: 0.9,
      opaque: false,
    })],
  },
  ait: {
    id: 'ait',
    version: '1.0.0',
    outputs: [png('console-icon', 'console-icon-600.png', 600, {
      safeZone: 0.8,
      opaque: true,
    })],
  },
  android: {
    id: 'android-adaptive',
    version: '1.0.0',
    outputs: [
      png('adaptive-foreground', 'adaptive-foreground-432.png', 432, {
        sourceVariant: 'androidForeground',
        safeZone: 0.611,
        opaque: false,
      }),
      png('adaptive-background', 'adaptive-background-432.png', 432, {
        sourceVariant: 'background',
        safeZone: 1,
        opaque: true,
      }),
      png('adaptive-monochrome', 'adaptive-monochrome-432.png', 432, {
        sourceVariant: 'monochrome',
        safeZone: 0.611,
        opaque: false,
        requiredVariant: true,
      }),
      png('legacy', 'legacy-48.png', 48, { safeZone: 0.8, opaque: true }),
      png('legacy', 'legacy-72.png', 72, { safeZone: 0.8, opaque: true }),
      png('legacy', 'legacy-96.png', 96, { safeZone: 0.8, opaque: true }),
      png('legacy', 'legacy-144.png', 144, { safeZone: 0.8, opaque: true }),
      png('legacy', 'legacy-192.png', 192, { safeZone: 0.8, opaque: true }),
    ],
  },
  ios: {
    id: 'ios-app-icon',
    version: '1.0.0',
    outputs: [png('app-icon', 'AppIcon-1024.png', 1024, {
      safeZone: 0.9,
      opaque: true,
    })],
  },
} as const satisfies Record<string, TargetIconProfile>;

export type BuiltInIconProfileName = keyof typeof profiles;

export function resolveTargetIconProfile(
  targetName: string,
  target: PlatformTargetConfig,
): TargetIconProfile {
  const configuredProfile = target.icon?.profile;
  const profileName = configuredProfile ?? inferProfileName(targetName, target);
  const profile = profiles[profileName as BuiltInIconProfileName];

  if (profile === undefined) {
    throw new Error(
      `Unknown icon profile ${profileName} for ${targetName}. Add a versioned profile to tools/icons/profiles.ts before using it.`,
    );
  }

  return profile;
}

function inferProfileName(
  targetName: string,
  target: PlatformTargetConfig,
): BuiltInIconProfileName {
  switch (target.kind) {
    case 'web':
      return targetName === 'microsoft-store' ? 'microsoft-pwa' : 'web-preview';
    case 'capacitor-android':
      return 'android';
    case 'capacitor-ios':
      return 'ios';
    case 'apps-in-toss':
      return 'ait';
    case 'devvit-web':
      return 'devvit';
  }
}

export function listTargetIconProfiles(): readonly TargetIconProfile[] {
  return Object.values(profiles);
}
