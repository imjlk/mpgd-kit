import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { isMpgdFinalSemVer } from '@mpgd/target-config';
import {
  assertAndroidReleaseDisplayName,
  assertIosArchiveScheme,
  assertIosReleaseDisplayName,
  assertIosReleasePlistIdentity,
} from '../../packages/cli/src/capacitor-shell-starter.js';
import {
  assertAndroidSettingsAppProject,
  assertAndroidSettingsNoAppRemap,
  assertIosReleaseProductName,
  countGradleIdentityWrites,
  hasAndroidDisplayNameResourceOverride,
  hasGradleBracketIdentityWrite,
  hasGradleIdentityMutation,
  hasGradlePropertySetter,
  maskGradleStrings,
  readIosReleaseInfoPlist,
} from '../../packages/cli/src/native-shell-identity.js';

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
    const candidates = [
      join(input.shellApp, 'android/app/build.gradle'),
      join(input.shellApp, 'android/app/build.gradle.kts'),
    ].filter((file) => existsSync(file));
    if (candidates.length !== 1) {
      throw new Error('Android native release requires exactly one Gradle app build file.');
    }
    assertAndroidIdentity(candidates[0] ?? '', expected);
    assertAndroidAppliedScripts(candidates[0] ?? '', join(input.shellApp, 'android'));
    if (input.required) {
      const name = requireValue(input.metadata?.displayName, 'Android target metadata displayName');
      assertAndroidReleaseDisplayName(input.shellApp, name);
    }
    return;
  }

  assertIosIdentity(join(input.shellApp, 'ios/App/App.xcodeproj/project.pbxproj'), expected);
  if (input.required) {
    const name = requireValue(input.metadata?.displayName, 'iOS target metadata displayName');
    assertIosReleaseDisplayName(input.shellApp, name);
    assertIosArchiveScheme(input.shellApp);
  }
}

export function runNativeSyncWithIdentityCheck(
  input: NativeReleaseIdentityInput,
  synchronize: () => void,
): void {
  synchronize();
  assertNativeReleaseIdentity(input);
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

interface IosBuildSettings {
  readonly values: string;
  readonly hasBaseConfiguration: boolean;
}

interface IosReleaseBuildSettings {
  readonly project: IosBuildSettings;
  readonly target: IosBuildSettings;
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

  const code = maskGradleStrings(source);
  if (hasGradleBracketIdentityWrite(source)) {
    throw new Error(`Native release preflight cannot resolve bracket identity writes in ${file}.`);
  }
  if (hasAndroidDisplayNameResourceOverride(source)) {
    throw new Error(`Native release preflight cannot resolve generated app_name in ${file}.`);
  }
  if (/\bproductFlavors\b/u.test(code)) {
    throw new Error('Native release preflight does not support Android product flavors.');
  }
  assertNoAndroidReleaseIdentitySuffix(source, file);
  if (/\bset(?:ApplicationId|VersionCode|VersionName)\s*\(/u.test(code)
    || hasGradlePropertySetter(source)) {
    throw new Error(`Native release preflight cannot resolve Android identity setters in ${file}.`);
  }
  const end = '(?=\\s*(?:;|\\r?\\n|\\}|$))';
  const appIdPattern = new RegExp(`\\bapplicationId\\s*(?:=\\s*)?["']([^"']+)["']${end}`, 'u');
  const codePattern = new RegExp(`\\bversionCode\\s*(?:=\\s*)?(\\d+)${end}`, 'u');
  const namePattern = new RegExp(`\\bversionName\\s*(?:=\\s*)?["']([^"']+)["']${end}`, 'u');
  assertAndroidSetting(source, 'applicationId', appIdPattern, expected.packageId, file);
  assertAndroidSetting(source, 'versionCode', codePattern, expected.versionCode, file);
  assertAndroidSetting(source, 'versionName', namePattern, expected.versionName, file);
}

function assertAndroidSetting(
  source: string,
  key: string,
  expression: RegExp,
  expected: string,
  file: string,
): void {
  const mentions = countGradleIdentityWrites(source, key);
  const values = readSettingValues(source, expression);
  if (values.length !== mentions) {
    throw new Error(`Native release preflight cannot read every ${key} assignment in ${file}.`);
  }
  assertSettingValues(values, expression, expected, file);
}

function assertAndroidAppliedScripts(appBuild: string, androidRoot: string): void {
  const visited = new Set<string>();
  const inspect = (file: string, isSettingsScript = false): void => {
    if (visited.has(file)) {
      return;
    }
    visited.add(file);
    const source = stripComments(readRequiredFile(file, 'applied Android Gradle script'));
    const code = maskGradleStrings(source);
    if (/(?:^|[\s;{])apply\s*\{/u.test(code)) {
      throw new Error('Native release preflight cannot resolve an applied Gradle script.');
    }
    if (hasAndroidDisplayNameResourceOverride(source)) {
      throw new Error('Native release preflight cannot resolve generated app_name resources.');
    }
    if (isSettingsScript) {
      assertAndroidSettingsNoAppRemap(source);
    }
    if (/\bproductFlavors\b/u.test(code)) {
      throw new Error('Native release preflight does not support Android product flavors.');
    }
    if (file !== appBuild && hasGradleIdentityMutation(source)) {
      throw new Error(
        `Native release preflight found identity override in applied Gradle script: ${file}.`,
      );
    }
    const expressions = [
      /\bapply\s+from\s*:\s*["']([^"']+)["']/gu,
      /\bapply\s*\(\s*from\s*=\s*["']([^"']+)["']\s*\)/gu,
      /\bapply\s+from\s*:\s*file\s*\(\s*["']([^"']+)["']\s*\)/gu,
      /\bapply\s*\(\s*from\s*=\s*file\s*\(\s*["']([^"']+)["']\s*\)\s*\)/gu,
    ];
    const matched = new Set<number>();
    for (const expression of expressions) {
      for (const match of source.matchAll(expression)) {
        if (match.index === undefined || code.slice(match.index, match.index + 5) !== 'apply') {
          continue;
        }
        matched.add(match.index);
        const requested = match[1] ?? '';
        const resolved = resolve(dirname(file), requested);
        const within = relative(androidRoot, resolved);
        if (requested.includes('$') || within === '' || within.startsWith('..')
          || isAbsolute(within)) {
          throw new Error('Native release preflight cannot resolve an applied Gradle script.');
        }
        inspect(resolved, isSettingsScript);
      }
    }
    const applies = [ /\bapply\s+from\s*:/gu, /\bapply\s*\(\s*from\s*=/gu ];
    if (applies.some((expression) => [...source.matchAll(expression)]
      .some((match) => match.index !== undefined
        && code.slice(match.index, match.index + 5) === 'apply'
        && !matched.has(match.index)))) {
      throw new Error('Native release preflight cannot resolve an applied Gradle script.');
    }
  };
  const rootFiles = ['build.gradle', 'build.gradle.kts']
    .map((name) => join(androidRoot, name)).filter((file) => existsSync(file));
  if (rootFiles.length !== 1) {
    throw new Error('Native release preflight requires one Android root Gradle build file.');
  }
  const rootFile = rootFiles[0] ?? '';
  const rootSource = stripComments(readRequiredFile(rootFile, 'Android root Gradle build file'));
  const rootCode = maskGradleStrings(rootSource);
  if (/\b(?:afterEvaluate|projectsEvaluated)\b/u.test(rootCode)
    && /\b(?:project|subprojects|allprojects|android)\b/u.test(rootCode)) {
    throw new Error('Native release preflight cannot resolve root Gradle app callbacks.');
  }
  const settingsFiles = ['settings.gradle', 'settings.gradle.kts']
    .map((name) => join(androidRoot, name)).filter((file) => existsSync(file));
  if (settingsFiles.length !== 1) {
    throw new Error('Native release preflight requires one Android settings Gradle file.');
  }
  const settingsFile = settingsFiles[0] ?? '';
  const settingsSource = stripComments(
    readRequiredFile(settingsFile, 'Android settings Gradle file'),
  );
  assertAndroidSettingsAppProject(settingsSource);
  if (/\b(?:beforeProject|afterProject|beforeEvaluate|afterEvaluate|projectsEvaluated)\b/u
    .test(maskGradleStrings(settingsSource))) {
    throw new Error('Native release preflight cannot resolve settings Gradle project callbacks.');
  }
  inspect(settingsFile, true);
  inspect(rootFile);
  inspect(appBuild);
}

function assertIosIdentity(file: string, expected: IosIdentity): void {
  const source = readRequiredFile(file, 'iOS Xcode project configuration');
  assertIosReleaseProductName(source);
  const releaseSettings = readIosAppReleaseSettings(source, file);
  assertIosSetting(releaseSettings, 'PRODUCT_BUNDLE_IDENTIFIER', expected.bundleId, file);
  assertIosSetting(releaseSettings, 'MARKETING_VERSION', expected.marketingVersion, file);
  assertIosSetting(releaseSettings, 'CURRENT_PROJECT_VERSION', expected.buildNumber, file);
  const plistRelative = readIosReleaseInfoPlist(source);
  const plist = join(dirname(dirname(file)), plistRelative);
  assertIosReleasePlistIdentity(readRequiredFile(plist, 'iOS Release Info.plist'));
}

function assertIosSetting(
  settings: IosReleaseBuildSettings,
  key: 'PRODUCT_BUNDLE_IDENTIFIER' | 'MARKETING_VERSION' | 'CURRENT_PROJECT_VERSION',
  expected: string,
  file: string,
): void {
  const expression = new RegExp(`(?:^|[\\s{;])["']?${key}["']?\\s*=\\s*([^;]+);`, 'u');
  const conditionalPattern = `(?:^|[\\s{;])["']?${key}(?:\\[[^\\]\\r\\n]+\\])+["']?\\s*=`;
  const conditional = new RegExp(conditionalPattern, 'u');
  const target = stripComments(settings.target.values);
  const project = stripComments(settings.project.values);
  const targetRaw = readSettingValues(target, expression);
  if (targetRaw.length > 1) {
    throw new Error(`Native release preflight has ambiguous App Release ${key} in ${file}.`);
  }
  const targetValues = targetRaw
    .filter((value) => value !== '$(inherited)');
  if (conditional.test(target) || (targetValues.length === 0 && conditional.test(project))) {
    throw new Error(`Native release preflight does not support conditional ${key} in ${file}.`);
  }
  if (targetValues.length === 0 && settings.target.hasBaseConfiguration) {
    throw new Error(`Native release preflight cannot resolve Release xcconfig ${key} in ${file}.`);
  }
  const projectRaw = readSettingValues(project, expression);
  if (targetValues.length === 0 && projectRaw.length > 1) {
    throw new Error(`Native release preflight has ambiguous project Release ${key} in ${file}.`);
  }
  const projectValues = projectRaw
    .filter((value) => value !== '$(inherited)');
  if (targetValues.length === 0 && projectValues.length === 0
    && settings.project.hasBaseConfiguration) {
    throw new Error(`Native release preflight cannot resolve Release xcconfig ${key} in ${file}.`);
  }
  const values = targetValues.length > 0 ? targetValues : projectValues;

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
  const code = maskGradleStrings(source);
  const suffix = '(?:applicationIdSuffix|versionNameSuffix|setApplicationIdSuffix|setVersionNameSuffix)';
  const qualifiedReleasePrefixes = [
    '\\bbuildTypes\\s*\\.\\s*release',
    '\\bbuildTypes\\s*\\[\\s*["\']release["\']\\s*\\]',
    '\\bbuildTypes\\s*\\.\\s*(?:getByName|named)\\s*\\(\\s*["\']release["\']\\s*\\)',
    '\\b(?:getByName|named)\\s*\\(\\s*["\']release["\']\\s*\\)',
    '\\brelease',
  ];
  const qualifiedReleaseSuffixes = qualifiedReleasePrefixes.map(
    (prefix) => new RegExp(`${prefix}\\s*\\.\\s*${suffix}\\b`, 'u'),
  );

  const qualifiedSuffix = qualifiedReleaseSuffixes.some((expression) => {
    const global = new RegExp(expression.source, `${expression.flags}g`);
    return [...source.matchAll(global)].some((match) => {
      const matchedSuffix = new RegExp(`${suffix}$`, 'u').exec(match[0])?.[0] ?? '';
      const offset = (match.index ?? 0) + match[0].lastIndexOf(matchedSuffix);
      return matchedSuffix !== ''
        && code.slice(offset, offset + matchedSuffix.length) === matchedSuffix;
    });
  });
  if (qualifiedSuffix) {
    throw new Error(
      `Native release preflight does not support applicationIdSuffix or versionNameSuffix in Android release builds: ${file}.`,
    );
  }

  for (const releaseBlock of releaseBlocks) {
    if (/\b(?:applicationIdSuffix|versionNameSuffix|setApplicationIdSuffix|setVersionNameSuffix)\b/u
      .test(maskGradleStrings(releaseBlock))) {
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
      ? { values: '', hasBaseConfiguration: false }
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
): IosBuildSettings {
  const configurationList = readPbxObject(source, configurationListId, file);
  const releaseConfigurationId = readPbxReference(
    configurationList,
    /\b([A-F0-9]+)\s*\/\*\s*Release\s*\*\//u,
    `${label} Release build configuration`,
    file,
  );
  const releaseConfiguration = readPbxObject(source, releaseConfigurationId, file);

  return {
    values: readPbxBuildSettings(releaseConfiguration, `${label} Release build settings`, file),
    hasBaseConfiguration: /\bbaseConfigurationReference\s*=/u.test(releaseConfiguration),
  };
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
    /\brelease\s+by\s+getting\s*\{/gu,
    /\brelease\s*\.\s*apply\s*\{/gu,
    /\b(?:getByName|named)\s*\(\s*["']release["']\s*\)\s*\{/gu,
    /\b(?:getByName|named)\s*\(\s*["']release["']\s*\)\s*\.\s*apply\s*\{/gu,
    /\bbuildTypes\s*\[\s*["']release["']\s*\]\s*\{/gu,
    /\bbuildTypes\s*\[\s*["']release["']\s*\]\s*\.\s*apply\s*\{/gu,
  ];
  const qualifiedReleaseBlockExpressions = [
    /\bbuildTypes\s*\.\s*release\s*\{/gu,
    /\bbuildTypes\s*\.\s*release\s*\.\s*apply\s*\{/gu,
    /\bbuildTypes\s*\[\s*["']release["']\s*\]\s*\.\s*apply\s*\{/gu,
    /\bbuildTypes\s*\.\s*(?:getByName|named)\s*\(\s*["']release["']\s*\)\s*\{/gu,
    /\bbuildTypes\s*\.\s*(?:getByName|named)\s*\(\s*["']release["']\s*\)\s*\.\s*apply\s*\{/gu,
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
