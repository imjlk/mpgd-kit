import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { TargetReleaseMetadata } from './schemas';

export interface NativeReleaseIdentityInput {
  readonly platform: 'android' | 'ios';
  readonly shellApp: string;
  readonly metadata: TargetReleaseMetadata | undefined;
  readonly environment: NodeJS.ProcessEnv;
  readonly required: boolean;
}

/**
 * Checks the game-owned Capacitor shell before a production build. The actual
 * Gradle/Xcode values remain the source of truth; the target tool does not
 * silently rewrite a product identity during release packaging.
 */
export function assertNativeReleaseIdentity(input: NativeReleaseIdentityInput): void {
  const expected = resolveExpectedNativeIdentity(
    input.platform,
    input.metadata,
    input.environment,
    input.required,
  );

  if (expected === undefined) {
    return;
  }

  assertNativeVersionMatchesGameVersion(expected, input.environment, input.required);

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
  required: boolean,
): NativeIdentity | undefined {
  if (platform === 'android') {
    const versionName = optional(environment.MPGD_TARGET_VERSION_NAME);
    const versionCode = optional(environment.MPGD_TARGET_VERSION_CODE);

    if (versionName === undefined && versionCode === undefined && !required) {
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

  if (marketingVersion === undefined && buildNumber === undefined && !required) {
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

  assertNoAndroidReleaseIdentitySuffix(source, file);
  assertSetting(source, /\bapplicationId\s*(?:=\s*)?["']([^"']+)["']/u, expected.packageId, file);
  assertSetting(source, /\bversionCode\s*(?:=\s*)?(\d+)/u, expected.versionCode, file);
  assertSetting(source, /\bversionName\s*(?:=\s*)?["']([^"']+)["']/u, expected.versionName, file);
}

function assertIosIdentity(file: string, expected: IosIdentity): void {
  const source = readRequiredFile(file, 'iOS Xcode project configuration');
  const appReleaseSettings = readIosAppReleaseBuildSettings(source, file);

  assertSetting(
    appReleaseSettings,
    /\bPRODUCT_BUNDLE_IDENTIFIER\s*=\s*([^;]+);/u,
    expected.bundleId,
    file,
  );
  assertSetting(
    appReleaseSettings,
    /\bMARKETING_VERSION\s*=\s*([^;]+);/u,
    expected.marketingVersion,
    file,
  );
  assertSetting(
    appReleaseSettings,
    /\bCURRENT_PROJECT_VERSION\s*=\s*([^;]+);/u,
    expected.buildNumber,
    file,
  );
}

function assertSetting(source: string, expression: RegExp, expected: string, file: string): void {
  const globalExpression = expression.global
    ? expression
    : new RegExp(expression.source, `${expression.flags}g`);
  const values = [...source.matchAll(globalExpression)].map((match) => match[1]?.trim());

  if (values.length === 0) {
    throw new Error(`Native release preflight could not find ${expression.source} in ${file}.`);
  }

  if (values.some((value) => value !== expected)) {
    throw new Error(
      `Native release identity mismatch in ${file}: expected ${expected}, received ${values.join(', ')}.`,
    );
  }
}

function assertNativeVersionMatchesGameVersion(
  expected: NativeIdentity,
  environment: NodeJS.ProcessEnv,
  required: boolean,
): void {
  const configuredGameVersion = optional(environment.APP_VERSION);

  if (configuredGameVersion === undefined || configuredGameVersion === '0.0.0') {
    if (required) {
      throw new Error(
        'APP_VERSION must be a non-default final SemVer for production native release versioning.',
      );
    }

    return;
  }

  const gameVersion = requireFinalSemVer(configuredGameVersion, 'APP_VERSION');
  const nativeVersion = expected.kind === 'android'
    ? expected.versionName
    : expected.marketingVersion;

  if (nativeVersion !== gameVersion) {
    throw new Error(
      `Native release version mismatch: APP_VERSION is ${gameVersion}, received ${nativeVersion}.`,
    );
  }
}

function assertNoAndroidReleaseIdentitySuffix(source: string, file: string): void {
  const releaseBlocks = readAndroidReleaseBlocks(source, file);

  for (const releaseBlock of releaseBlocks) {
    if (/\b(?:applicationIdSuffix|versionNameSuffix)\b/u.test(releaseBlock)) {
      throw new Error(
        `Native release preflight does not support applicationIdSuffix or versionNameSuffix in Android release builds: ${file}.`,
      );
    }
  }
}

function readIosAppReleaseBuildSettings(source: string, file: string): string {
  const appTarget = findIosAppTargetBlock(source, file);

  if (appTarget === undefined) {
    throw new Error(`Native release preflight could not find the App target in ${file}.`);
  }

  const configurationListId = readPbxReference(
    appTarget,
    /\bbuildConfigurationList\s*=\s*([A-F0-9]+)\b/u,
    'the App target build configuration list',
    file,
  );
  const configurationList = readPbxObject(source, configurationListId, file);
  const releaseConfigurationId = readPbxReference(
    configurationList,
    /\b([A-F0-9]+)\s*\/\*\s*Release\s*\*\//u,
    'the App Release build configuration',
    file,
  );
  const releaseConfiguration = readPbxObject(source, releaseConfigurationId, file);
  const buildSettingsIndex = releaseConfiguration.search(/\bbuildSettings\s*=\s*\{/u);

  if (buildSettingsIndex === -1) {
    throw new Error(
      `Native release preflight could not find App Release build settings in ${file}.`,
    );
  }

  return readBracedBlock(
    releaseConfiguration,
    releaseConfiguration.indexOf('{', buildSettingsIndex),
    'App Release build settings',
    file,
  );
}

function findIosAppTargetBlock(source: string, file: string): string | undefined {
  for (const match of source.matchAll(/\b([A-F0-9]+)\s*\/\*\s*[^*]+\s*\*\/\s*=\s*\{/gu)) {
    const id = match[1];

    if (id === undefined || match.index === undefined) {
      continue;
    }

    const block = readBracedBlock(
      source,
      source.indexOf('{', match.index),
      `Xcode object ${id}`,
      file,
    );

    if (
      /\bisa\s*=\s*PBXNativeTarget;/u.test(block)
      && /\bname\s*=\s*"?App"?\s*;/u.test(block)
    ) {
      return block;
    }
  }

  return undefined;
}

function readAndroidReleaseBlocks(source: string, file: string): readonly string[] {
  const releaseBlockExpressions = [
    /\brelease\s*\{/gu,
    /\b(?:getByName|named)\s*\(\s*["']release["']\s*\)\s*\{/gu,
    /\bbuildTypes\s*\.\s*release\s*\{/gu,
  ];

  return releaseBlockExpressions.flatMap((expression) => [...source.matchAll(expression)]
    .map((match) => {
      if (match.index === undefined) {
        return undefined;
      }

      return readBracedBlock(
        source,
        source.indexOf('{', match.index),
        'Android release Gradle block',
        file,
      );
    })
    .filter((block): block is string => block !== undefined));
}

function readPbxObject(source: string, id: string, file: string): string {
  const marker = source.match(new RegExp(`\\b${id}\\s*\\/\\*\\s*[^*]+\\s*\\*\\/\\s*=\\s*\\{`, 'u'));

  if (marker?.index === undefined) {
    throw new Error(`Native release preflight could not find Xcode object ${id} in ${file}.`);
  }

  return readBracedBlock(source, source.indexOf('{', marker.index), `Xcode object ${id}`, file);
}

function readPbxReference(source: string, expression: RegExp, label: string, file: string): string {
  const match = source.match(expression);
  const value = match?.[1];

  if (value === undefined) {
    throw new Error(`Native release preflight could not find ${label} in ${file}.`);
  }

  return value;
}

function readBracedBlock(source: string, openingBrace: number, label: string, file: string): string {
  if (openingBrace === -1) {
    throw new Error(`Native release preflight could not find ${label} in ${file}.`);
  }

  let depth = 0;

  for (let index = openingBrace; index < source.length; index += 1) {
    const character = source[index];

    if (character === '{') {
      depth += 1;
      continue;
    }

    if (character === '}') {
      depth -= 1;

      if (depth === 0) {
        return source.slice(openingBrace + 1, index);
      }
    }
  }

  throw new Error(`Native release preflight found an unclosed ${label} in ${file}.`);
}

function readRequiredFile(file: string, label: string): string {
  if (!existsSync(file)) {
    throw new Error(`Missing ${label}: ${file}`);
  }

  return readFileSync(file, 'utf8');
}

function requireFinalSemVer(value: string | undefined, label: string): string {
  const normalized = requireValue(value, label);

  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(normalized)) {
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
