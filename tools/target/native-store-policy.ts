import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { readIosReleaseInfoPlist } from '../../packages/cli/src/native-shell-identity.js';
import {
  inspectAndroidManifestAds,
  inspectAndroidManifestOrientation,
  inspectIosAppPrivacyManifest,
  inspectIosInfoPlistAds,
  inspectIosInfoPlistOrientation,
  inspectIosInfoPlistStorePolicy,
  inspectIosProjectDeviceFamily,
  readGameAdvertisingIdPolicy,
  readGameNativeOrientation,
  readIosDeviceFamily,
  shellUsesAdMob,
  type NativeShellPolicyIssue,
} from '../../packages/cli/src/native-shell-store-policy.js';

/**
 * Reads the store-facing settings of the game-owned shell (never the stage)
 * before packaging. Warnings are printed for every profile; errors fail a
 * production build, where the shell would ship a binary the store rejects or
 * that crashes at launch.
 */
export function inspectNativeStorePolicy(input: {
  readonly platform: 'android' | 'ios';
  readonly shellApp: string;
  /** The game root holding mpgd.game.json; omitted when the build has none. */
  readonly gameRoot?: string;
  /** The target's metadata from mpgd.targets.json. */
  readonly metadata?: unknown;
}): readonly NativeShellPolicyIssue[] {
  const gameConfig = input.gameRoot === undefined
    ? undefined
    : join(input.gameRoot, 'mpgd.game.json');
  const gameConfigJson = gameConfig !== undefined && existsSync(gameConfig)
    ? readJson(gameConfig)
    : undefined;
  const orientation = readGameNativeOrientation(gameConfigJson);
  const shellPackage = join(input.shellApp, 'package.json');
  const usesAds = existsSync(shellPackage) && shellUsesAdMob(readJson(shellPackage));
  if (input.platform === 'ios') {
    const project = join(input.shellApp, 'ios/App/App.xcodeproj/project.pbxproj');
    if (!existsSync(project)) {
      return [];
    }
    const projectSource = readFileSync(project, 'utf8');
    const deviceFamily = readIosDeviceFamily(input.metadata);
    const issues = [
      ...inspectIosProjectDeviceFamily(projectSource, deviceFamily),
      ...inspectIosAppPrivacyManifest(projectSource),
    ];
    const plist = join(dirname(dirname(project)), readIosReleaseInfoPlist(projectSource));
    if (existsSync(plist)) {
      const plistSource = readFileSync(plist, 'utf8');
      issues.push(
        ...inspectIosInfoPlistStorePolicy(plistSource),
        ...inspectIosInfoPlistOrientation(plistSource, orientation, deviceFamily ?? 'universal'),
        ...inspectIosInfoPlistAds(plistSource, usesAds),
      );
    }
    return issues;
  }
  const manifest = join(input.shellApp, 'android/app/src/main/AndroidManifest.xml');
  if (!existsSync(manifest)) {
    return [];
  }
  const manifestSource = readFileSync(manifest, 'utf8');
  return [
    ...inspectAndroidManifestOrientation(manifestSource, orientation),
    ...inspectAndroidManifestAds(
      manifestSource,
      usesAds,
      readGameAdvertisingIdPolicy(gameConfigJson),
    ),
  ];
}

function readJson(file: string): unknown {
  const source = readFileSync(file, 'utf8');
  try {
    return JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error(
      `${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function reportNativeStorePolicy(
  issues: readonly NativeShellPolicyIssue[],
  production: boolean,
  log: (message: string) => void = (message) => console.warn(message),
): void {
  for (const issue of issues) {
    log(`[native-store-policy] ${issue.level}: ${issue.message}`);
  }
  const errors = issues.filter((issue) => issue.level === 'error');
  if (production && errors.length > 0) {
    throw new Error(`Native shell is not ready for store release:\n${errors
      .map((issue) => `- ${issue.message}`).join('\n')}`);
  }
}
