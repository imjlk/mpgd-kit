import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { TargetReleaseMetadata } from './schemas';

export interface NativeReleaseIdentityInput {
  readonly platform: 'android' | 'ios';
  readonly shellApp: string;
  readonly metadata: TargetReleaseMetadata | undefined;
  readonly environment: NodeJS.ProcessEnv;
}

/**
 * Checks the game-owned Capacitor shell before a production build. The actual
 * Gradle/Xcode values remain the source of truth; the target tool does not
 * silently rewrite a product identity during release packaging.
 */
export function assertNativeReleaseIdentity(input: NativeReleaseIdentityInput): void {
  const expected = resolveExpectedNativeIdentity(input.platform, input.metadata, input.environment);

  if (expected === undefined) {
    return;
  }

  if (expected.kind === 'android') {
    assertAndroidIdentity(join(input.shellApp, 'android/app/build.gradle'), expected);
    return;
  }

  assertIosIdentity(join(input.shellApp, 'ios/App/App.xcodeproj/project.pbxproj'), expected);
}

interface AndroidIdentity {
  readonly kind: 'android';
  readonly packageId: string;
  readonly versionCode: string;
  readonly versionName: string;
}

interface IosIdentity {
  readonly buildNumber: string;
  readonly bundleId: string;
  readonly kind: 'ios';
  readonly marketingVersion: string;
}

type NativeIdentity = AndroidIdentity | IosIdentity;

function resolveExpectedNativeIdentity(
  platform: 'android' | 'ios',
  metadata: TargetReleaseMetadata | undefined,
  environment: NodeJS.ProcessEnv,
): NativeIdentity | undefined {
  if (platform === 'android') {
    const versionName = optional(environment.MPGD_TARGET_VERSION_NAME);
    const versionCode = optional(environment.MPGD_TARGET_VERSION_CODE);

    if (versionName === undefined && versionCode === undefined) {
      return undefined;
    }

    return {
      kind: 'android',
      packageId: requireValue(metadata?.packageId, 'Android target metadata packageId'),
      versionCode: requirePositiveInteger(versionCode, 'MPGD_TARGET_VERSION_CODE'),
      versionName: requireFinalSemVer(versionName, 'MPGD_TARGET_VERSION_NAME'),
    };
  }

  const marketingVersion = optional(environment.MPGD_TARGET_MARKETING_VERSION);
  const buildNumber = optional(environment.MPGD_TARGET_BUILD_NUMBER);

  if (marketingVersion === undefined && buildNumber === undefined) {
    return undefined;
  }

  return {
    buildNumber: requirePositiveInteger(buildNumber, 'MPGD_TARGET_BUILD_NUMBER'),
    bundleId: requireValue(metadata?.bundleId, 'iOS target metadata bundleId'),
    kind: 'ios',
    marketingVersion: requireFinalSemVer(marketingVersion, 'MPGD_TARGET_MARKETING_VERSION'),
  };
}

function assertAndroidIdentity(file: string, expected: AndroidIdentity): void {
  const source = readRequiredFile(file, 'Android Gradle configuration');

  assertSetting(source, /\bapplicationId\s*(?:=\s*)?["']([^"']+)["']/u, expected.packageId, file);
  assertSetting(source, /\bversionCode\s*(?:=\s*)?(\d+)/u, expected.versionCode, file);
  assertSetting(source, /\bversionName\s*(?:=\s*)?["']([^"']+)["']/u, expected.versionName, file);
}

function assertIosIdentity(file: string, expected: IosIdentity): void {
  const source = readRequiredFile(file, 'iOS Xcode project configuration');

  assertSetting(source, /\bPRODUCT_BUNDLE_IDENTIFIER\s*=\s*([^;]+);/u, expected.bundleId, file);
  assertSetting(source, /\bMARKETING_VERSION\s*=\s*([^;]+);/u, expected.marketingVersion, file);
  assertSetting(source, /\bCURRENT_PROJECT_VERSION\s*=\s*([^;]+);/u, expected.buildNumber, file);
}

function assertSetting(source: string, expression: RegExp, expected: string, file: string): void {
  const values = [...source.matchAll(expression)].map((match) => match[1]?.trim());

  if (values.length === 0) {
    throw new Error(`Native release preflight could not find ${expression.source} in ${file}.`);
  }

  if (values.some((value) => value !== expected)) {
    throw new Error(
      `Native release identity mismatch in ${file}: expected ${expected}, received ${values.join(', ')}.`,
    );
  }
}

function readRequiredFile(file: string, label: string): string {
  if (!existsSync(file)) {
    throw new Error(`Missing ${label}: ${file}`);
  }

  return readFileSync(file, 'utf8');
}

function requireFinalSemVer(value: string | undefined, label: string): string {
  const normalized = requireValue(value, label);

  if (!/^\d+\.\d+\.\d+$/u.test(normalized)) {
    throw new Error(`${label} must be a final SemVer.`);
  }

  return normalized;
}

function requirePositiveInteger(value: string | undefined, label: string): string {
  const normalized = requireValue(value, label);

  if (!/^[1-9]\d*$/u.test(normalized)) {
    throw new Error(`${label} must be a positive integer.`);
  }

  return normalized;
}

function requireValue(value: string | undefined, label: string): string {
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${label} is required for native release versioning.`);
  }

  return value.trim();
}

function optional(value: string | undefined): string | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }

  return value.trim();
}
