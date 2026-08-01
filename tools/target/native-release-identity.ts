import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { isMpgdFinalSemVer } from '@mpgd/target-config';

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

interface IosReleaseBuildSettings {
  readonly project: string;
  readonly target: string;
}

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
  const source = stripComments(readRequiredFile(file, 'Android Gradle configuration'));

  assertNoAndroidReleaseIdentitySuffix(source, file);
  assertSetting(source, /\bapplicationId\s*(?:=\s*)?["']([^"']+)["']/u, expected.packageId, file);
  assertSetting(source, /\bversionCode\s*(?:=\s*)?(\d+)/u, expected.versionCode, file);
  assertSetting(source, /\bversionName\s*(?:=\s*)?["']([^"']+)["']/u, expected.versionName, file);
}

function assertIosIdentity(file: string, expected: IosIdentity): void {
  const source = readRequiredFile(file, 'iOS Xcode project configuration');
  const releaseSettings = readIosAppReleaseSettings(source, file);

  assertIosSetting(
    releaseSettings,
    /\bPRODUCT_BUNDLE_IDENTIFIER\s*=\s*([^;]+);/u,
    expected.bundleId,
    file,
  );
  assertIosSetting(
    releaseSettings,
    /\bMARKETING_VERSION\s*=\s*([^;]+);/u,
    expected.marketingVersion,
    file,
  );
  assertIosSetting(
    releaseSettings,
    /\bCURRENT_PROJECT_VERSION\s*=\s*([^;]+);/u,
    expected.buildNumber,
    file,
  );
}

function assertSetting(source: string, expression: RegExp, expected: string, file: string): void {
  assertSettingValues(readSettingValues(source, expression), expression, expected, file);
}

function assertIosSetting(
  settings: IosReleaseBuildSettings,
  expression: RegExp,
  expected: string,
  file: string,
): void {
  const targetValues = readSettingValues(settings.target, expression)
    .filter((value) => value !== '$(inherited)');
  const values = targetValues.length > 0
    ? targetValues
    : readSettingValues(settings.project, expression);

  assertSettingValues(values, expression, expected, file);
}

function assertSettingValues(
  values: readonly string[],
  expression: RegExp,
  expected: string,
  file: string,
): void {
  if (values.length === 0) {
    throw new Error(`Native release preflight could not find ${expression.source} in ${file}.`);
  }

  if (values.some((value) => value !== expected)) {
    throw new Error(
      `Native release identity mismatch in ${file}: expected ${expected}, received ${values.join(', ')}.`,
    );
  }
}

function readSettingValues(source: string, expression: RegExp): readonly string[] {
  const globalExpression = expression.global
    ? expression
    : new RegExp(expression.source, `${expression.flags}g`);

  return [...source.matchAll(globalExpression)]
    .map((match) => match[1]?.trim())
    .filter((value): value is string => value !== undefined)
    .map(stripOptionalQuotes);
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
  const qualifiedReleaseSuffixes = [
    /\bbuildTypes\s*\.\s*release\s*\.\s*(?:applicationIdSuffix|versionNameSuffix)\b/u,
    /\bbuildTypes\s*\.\s*(?:getByName|named)\s*\(\s*["']release["']\s*\)\s*\.\s*(?:applicationIdSuffix|versionNameSuffix)\b/u,
  ];

  if (qualifiedReleaseSuffixes.some((expression) => expression.test(source))) {
    throw new Error(
      `Native release preflight does not support applicationIdSuffix or versionNameSuffix in Android release builds: ${file}.`,
    );
  }

  for (const releaseBlock of releaseBlocks) {
    if (/\b(?:applicationIdSuffix|versionNameSuffix)\b/u.test(releaseBlock)) {
      throw new Error(
        `Native release preflight does not support applicationIdSuffix or versionNameSuffix in Android release builds: ${file}.`,
      );
    }
  }
}

function readIosAppReleaseSettings(source: string, file: string): IosReleaseBuildSettings {
  const { appTarget, project } = findIosBlocks(source, file);

  if (appTarget === undefined) {
    throw new Error(`Native release preflight could not find the App target in ${file}.`);
  }

  const targetConfigurationListId = readPbxReference(
    appTarget,
    /\bbuildConfigurationList\s*=\s*([A-F0-9]+)\b/u,
    'the App target build configuration list',
    file,
  );
  let projectConfigurationListId: string | undefined;

  if (project !== undefined) {
    projectConfigurationListId = readPbxReference(
      project,
      /\bbuildConfigurationList\s*=\s*([A-F0-9]+)\b/u,
      'the Xcode project build configuration list',
      file,
    );
  }

  return {
    project: projectConfigurationListId === undefined
      ? ''
      : readPbxReleaseBuildSettings(source, projectConfigurationListId, 'Xcode project', file),
    target: readPbxReleaseBuildSettings(source, targetConfigurationListId, 'App target', file),
  };
}

function findIosBlocks(source: string, file: string): {
  readonly appTarget: string | undefined;
  readonly project: string | undefined;
} {
  let appTarget: string | undefined;
  let project: string | undefined;

  for (const match of source.matchAll(/\b([A-F0-9]+)\s*\/\*\s*[^*]+\s*\*\/\s*=\s*\{/gu)) {
    const id = match[1];

    if (id === undefined || match.index === undefined) {
      continue;
    }

    if (appTarget !== undefined && project !== undefined) {
      break;
    }

    const block = readBracedBlock(
      source,
      source.indexOf('{', match.index),
      `Xcode object ${id}`,
      file,
    );

    if (
      appTarget === undefined
      && /\bisa\s*=\s*PBXNativeTarget;/u.test(block)
      && /\bname\s*=\s*"?App"?\s*;/u.test(block)
    ) {
      appTarget = block;
    } else if (project === undefined && /\bisa\s*=\s*PBXProject;/u.test(block)) {
      project = block;
    }
  }

  return { appTarget, project };
}

function readPbxReleaseBuildSettings(
  source: string,
  configurationListId: string,
  label: string,
  file: string,
): string {
  const configurationList = readPbxObject(source, configurationListId, file);
  const releaseConfigurationId = readPbxReference(
    configurationList,
    /\b([A-F0-9]+)\s*\/\*\s*Release\s*\*\//u,
    `${label} Release build configuration`,
    file,
  );
  const releaseConfiguration = readPbxObject(source, releaseConfigurationId, file);

  return readPbxBuildSettings(releaseConfiguration, `${label} Release build settings`, file);
}

function readPbxBuildSettings(source: string, label: string, file: string): string {
  const buildSettingsIndex = source.search(/\bbuildSettings\s*=\s*\{/u);

  if (buildSettingsIndex === -1) {
    throw new Error(`Native release preflight could not find ${label} in ${file}.`);
  }

  return readBracedBlock(source, source.indexOf('{', buildSettingsIndex), label, file);
}

function readAndroidReleaseBlocks(source: string, file: string): readonly string[] {
  const buildTypesBlocks = readGradleBlocks(
    source,
    /\bbuildTypes\s*\{/gu,
    'Android buildTypes Gradle block',
    file,
  );
  const nestedReleaseBlockExpressions = [
    /\brelease\s*\{/gu,
    /\b(?:getByName|named)\s*\(\s*["']release["']\s*\)\s*\{/gu,
  ];
  const qualifiedReleaseBlockExpressions = [
    /\bbuildTypes\s*\.\s*release\s*\{/gu,
    /\bbuildTypes\s*\.\s*(?:getByName|named)\s*\(\s*["']release["']\s*\)\s*\{/gu,
  ];

  return [
    ...buildTypesBlocks.flatMap((block) => nestedReleaseBlockExpressions.flatMap(
      (expression) => readGradleBlocks(block, expression, 'Android release Gradle block', file),
    )),
    ...qualifiedReleaseBlockExpressions.flatMap(
      (expression) => readGradleBlocks(source, expression, 'Android release Gradle block', file),
    ),
  ];
}

function readGradleBlocks(
  source: string,
  expression: RegExp,
  label: string,
  file: string,
): readonly string[] {
  return [...source.matchAll(expression)].flatMap((match) => {
    if (match.index === undefined) {
      return [];
    }

    return [readBracedBlock(source, source.indexOf('{', match.index), label, file)];
  });
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
  let quote: '"' | "'" | undefined;
  let lineComment = false;
  let blockComment = false;

  for (let index = openingBrace; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];

    if (lineComment) {
      if (character === '\n') {
        lineComment = false;
      }

      continue;
    }

    if (blockComment) {
      if (character === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }

      continue;
    }

    if (quote !== undefined) {
      if (character === '\\') {
        index += 1;
        continue;
      }

      if (character === quote) {
        quote = undefined;
      }

      continue;
    }

    if (character === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }

    if (character === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }

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

function stripComments(source: string): string {
  let result = '';
  let quote: '"' | "'" | undefined;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];

    if (lineComment) {
      if (character === '\n') {
        lineComment = false;
        result += character;
      }

      continue;
    }

    if (blockComment) {
      if (character === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }

      continue;
    }

    if (quote !== undefined) {
      result += character;

      if (character === '\\') {
        result += next ?? '';
        index += 1;
      } else if (character === quote) {
        quote = undefined;
      }

      continue;
    }

    if (character === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }

    if (character === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
    }

    result += character;
  }

  return result;
}

function stripOptionalQuotes(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }

  return value;
}

function readRequiredFile(file: string, label: string): string {
  if (!existsSync(file)) {
    throw new Error(`Missing ${label}: ${file}`);
  }

  return readFileSync(file, 'utf8');
}

function requireFinalSemVer(value: string | undefined, label: string): string {
  const normalized = requireValue(value, label);

  if (!isMpgdFinalSemVer(normalized)) {
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
