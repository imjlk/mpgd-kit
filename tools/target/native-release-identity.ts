import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { isMpgdFinalSemVer } from '@mpgd/target-config';
import {
  assertAndroidReleaseDisplayName,
  assertAndroidReleaseLauncherIntegrity,
  assertIosArchiveScheme,
  assertIosReleaseDisplayName,
  assertIosReleasePlistIdentity,
} from '../../packages/cli/src/capacitor-shell-starter.js';
import {
  assertAndroidSettingsAppProject,
  assertAndroidSettingsNoAppRemap,
  assertIosReleaseInfoPlistExpansion,
  assertIosReleasePackagingSettings,
  assertIosReleaseProductName,
  countGradleIdentityWrites,
  hasAndroidDisplayNameResourceOverride,
  hasAndroidManifestSourceSetOverride,
  hasAndroidResourceSourceSetOverride,
  hasGradleBracketIdentityWrite,
  hasGradleIdentityMutation,
  hasGradlePropertySetter,
  hasGradleTaskAction,
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
  /**
   * `stamped`: the reserved version numbers are written into the staged copy
   * of the shell by `stampNativeReleaseVersions` before packaging, so the
   * game-owned source only has to keep every version assignment readable.
   * The package ID / bundle ID are always checked against the source.
   * Defaults to `source`, where the source must already hold the values.
   */
  readonly versionSource?: NativeVersionSource;
}

export type NativeVersionSource = 'source' | 'stamped';

/** `MPGD_NATIVE_VERSION_STAMP=1` stamps the reserved numbers into the staged shell. */
export const nativeVersionStampEnvironmentName = 'MPGD_NATIVE_VERSION_STAMP';

export function resolveNativeVersionSource(environment: NodeJS.ProcessEnv): NativeVersionSource {
  const value = environment[nativeVersionStampEnvironmentName]?.trim();
  if (value === undefined || value === '' || value === '0') {
    return 'source';
  }
  if (value === '1') {
    return 'stamped';
  }
  throw new Error(`${nativeVersionStampEnvironmentName} must be 1 or 0, received ${value}.`);
}

/**
 * Checks the game-owned Capacitor shell before a production build. The actual
 * Gradle/Xcode values remain the source of truth for the product identity;
 * the target tool never rewrites a package or bundle ID. Version numbers are
 * either read from the source (`versionSource: 'source'`) or stamped into the
 * staged copy from the release reservation (`'stamped'`) and checked there.
 */
export function assertNativeReleaseIdentity(input: NativeReleaseIdentityInput): void {
  const expected = resolveExpectedNativeIdentity(
    input.platform,
    input.metadata,
    input.environment,
    input.required,
  );

  if (expected === undefined) {
    if (input.versionSource === 'stamped') {
      throw new Error(
        `${nativeVersionStampEnvironmentName}=1 requires the reserved native version numbers.`,
      );
    }
    return;
  }

  assertNativeVersionMatchesGameVersion(expected, input.environment, input.required);
  const checkVersions = input.versionSource !== 'stamped';

  if (expected.kind === 'android') {
    const candidates = [
      join(input.shellApp, 'android/app/build.gradle'),
      join(input.shellApp, 'android/app/build.gradle.kts'),
    ].filter((file) => existsSync(file));
    if (candidates.length !== 1) {
      throw new Error('Android native release requires exactly one Gradle app build file.');
    }
    assertAndroidIdentity(candidates[0] ?? '', expected, checkVersions);
    assertAndroidAppliedScripts(candidates[0] ?? '', join(input.shellApp, 'android'));
    if (input.required) {
      const name = requireValue(input.metadata?.displayName, 'Android target metadata displayName');
      assertAndroidReleaseDisplayName(input.shellApp, name);
      assertAndroidReleaseLauncherIntegrity(input.shellApp);
    }
    return;
  }

  assertIosIdentity(
    join(input.shellApp, 'ios/App/App.xcodeproj/project.pbxproj'),
    expected,
    checkVersions,
  );
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

/**
 * Writes the reserved version numbers into a staged copy of the shell
 * (never the game-owned source): Android `versionCode`/`versionName` in the
 * app Gradle file, iOS `MARKETING_VERSION`/`CURRENT_PROJECT_VERSION` in the
 * App target's Release build settings. Run it after the source passed
 * `assertNativeReleaseIdentity` with `versionSource: 'stamped'`, then check
 * the stage with `versionSource: 'source'`; the signed-artifact inspections
 * compare the emitted numbers with the same reservation afterwards.
 */
export function stampNativeReleaseVersions(input: {
  readonly platform: 'android' | 'ios';
  readonly stagedShellApp: string;
  readonly environment: NodeJS.ProcessEnv;
}): void {
  if (input.platform === 'android') {
    const versionCode = requirePositiveInteger(
      optional(input.environment.MPGD_TARGET_VERSION_CODE),
      'MPGD_TARGET_VERSION_CODE',
    );
    const versionName = requireFinalSemVer(
      optional(input.environment.MPGD_TARGET_VERSION_NAME),
      'MPGD_TARGET_VERSION_NAME',
    );
    const candidates = [
      join(input.stagedShellApp, 'android/app/build.gradle'),
      join(input.stagedShellApp, 'android/app/build.gradle.kts'),
    ].filter((file) => existsSync(file));
    if (candidates.length !== 1) {
      throw new Error('Android native release requires exactly one Gradle app build file.');
    }
    const file = candidates[0] ?? '';
    writeFileSync(
      file,
      stampAndroidGradleVersions(
        readFileSync(file, 'utf8'),
        {
          versionCode,
          versionName,
        },
        file,
      ),
    );
    return;
  }
  const marketingVersion = requireFinalSemVer(
    optional(input.environment.MPGD_TARGET_MARKETING_VERSION),
    'MPGD_TARGET_MARKETING_VERSION',
  );
  const buildNumber = requirePositiveInteger(
    optional(input.environment.MPGD_TARGET_BUILD_NUMBER),
    'MPGD_TARGET_BUILD_NUMBER',
  );
  const file = join(input.stagedShellApp, 'ios/App/App.xcodeproj/project.pbxproj');
  writeFileSync(
    file,
    stampIosProjectVersions(
      readRequiredFile(file, 'iOS Xcode project configuration'),
      { marketingVersion, buildNumber },
      file,
    ),
  );
}

/** Replaces every literal `versionCode`/`versionName` assignment of an app Gradle file. */
export function stampAndroidGradleVersions(
  source: string,
  versions: { readonly versionCode: string; readonly versionName: string },
  file: string,
): string {
  const end = '(?=\\s*(?:;|\\r?\\n|\\}|$))';
  const code = new RegExp(`(\\bversionCode\\s*(?:=\\s*)?)\\d+${end}`, 'gu');
  const name = new RegExp(`(\\bversionName\\s*(?:=\\s*)?)(?:"[^"']+"|'[^"']+')${end}`, 'gu');
  // Matching runs on a copy whose comments are blanked, as the identity check
  // reads the source without comments: a commented-out assignment is never
  // stamped, and a trailing comment does not hide the real one.
  const masked = blankComments(source);
  const codeEdits = [...masked.matchAll(code)].map((match) => ({
    start: (match.index ?? 0) + (match[1]?.length ?? 0),
    end: (match.index ?? 0) + match[0].length,
    text: versions.versionCode,
  }));
  const nameEdits = [...masked.matchAll(name)].map((match) => ({
    start: (match.index ?? 0) + (match[1]?.length ?? 0) + 1,
    end: (match.index ?? 0) + match[0].length - 1,
    text: versions.versionName,
  }));
  if (codeEdits.length === 0 || nameEdits.length === 0) {
    throw new Error(
      `Native version stamping found no literal versionCode and versionName in ${file}.`,
    );
  }
  const edits = [...codeEdits, ...nameEdits];
  return applyTextEdits(source, edits);
}

/**
 * Sets `MARKETING_VERSION` and `CURRENT_PROJECT_VERSION` in the App target's
 * Release build settings, which take precedence over the project level and
 * any xcconfig file, adding them when the target inherits them.
 */
export function stampIosProjectVersions(
  source: string,
  versions: { readonly marketingVersion: string; readonly buildNumber: string },
  file: string,
): string {
  const { appTarget } = findIosBlocks(source, file);
  if (appTarget === undefined) {
    throw new Error(`Native release preflight could not find the App target in ${file}.`);
  }
  const listId = readPbxReference(
    appTarget,
    /\bbuildConfigurationList\s*=\s*([A-F0-9]+)\b/u,
    'the App target build configuration list',
    file,
  );
  const releaseId = readPbxReference(
    readPbxObject(source, listId, file),
    /\b([A-F0-9]+)\s*\/\*\s*Release\s*\*\//u,
    'App target Release build configuration',
    file,
  );
  const marker = source.match(
    new RegExp(`\\b${releaseId}\\s*\\/\\*\\s*[^*]+\\s*\\*\\/\\s*=\\s*\\{`, 'u'),
  );
  if (marker?.index === undefined) {
    throw new Error(
      `Native release preflight could not find Xcode object ${releaseId} in ${file}.`,
    );
  }
  const objectOpen = source.indexOf('{', marker.index);
  const objectBody = readBracedBlock(source, objectOpen, `Xcode object ${releaseId}`, file);
  const settingsIndex = objectBody.search(/\bbuildSettings\s*=\s*\{/u);
  if (settingsIndex === -1) {
    throw new Error(
      `Native release preflight could not find App target Release build settings in ${file}.`,
    );
  }
  const settingsOpen = objectOpen + 1 + objectBody.indexOf('{', settingsIndex);
  const settings = readBracedBlock(source, settingsOpen, 'App target Release build settings', file);
  const masked = blankComments(settings);
  const edits: TextEdit[] = [];
  const additions: string[] = [];
  for (const [key, value] of [
    ['MARKETING_VERSION', versions.marketingVersion],
    ['CURRENT_PROJECT_VERSION', versions.buildNumber],
  ] as const) {
    const assignment = new RegExp(`((?:^|[\\s{;])["']?${key}["']?\\s*=\\s*)[^;]+;`, 'gu');
    const matches = [...masked.matchAll(assignment)];
    for (const match of matches) {
      edits.push({
        start: (match.index ?? 0) + (match[1]?.length ?? 0),
        end: (match.index ?? 0) + match[0].length - 1,
        text: value,
      });
    }
    if (matches.length === 0) {
      additions.push(`${key} = ${value};`);
    }
  }
  const indentation = /\n([ \t]*)\S/u.exec(settings)?.[1] ?? '\t\t\t\t';
  const stamped = `${additions.map((line) => `\n${indentation}${line}`).join('')}${
    applyTextEdits(settings, edits)}`;
  return `${source.slice(0, settingsOpen + 1)}${stamped}${
    source.slice(settingsOpen + 1 + settings.length)}`;
}

interface TextEdit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

function applyTextEdits(source: string, edits: readonly TextEdit[]): string {
  let result = source;
  for (const edit of [...edits].sort((left, right) => right.start - left.start)) {
    result = `${result.slice(0, edit.start)}${edit.text}${result.slice(edit.end)}`;
  }
  return result;
}

/** A same-length copy with comment bodies replaced by spaces, so offsets map onto the source. */
function blankComments(source: string): string {
  const stripped = stripComments(source);
  if (stripped.length === source.length) {
    return source;
  }
  let result = '';
  let quote: '"' | "'" | undefined;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? '';
    const next = source[index + 1];
    if (lineComment) {
      if (character === '\n') {
        lineComment = false;
        result += character;
      } else {
        result += character === '\r' ? character : ' ';
      }
      continue;
    }
    if (blockComment) {
      if (character === '*' && next === '/') {
        blockComment = false;
        result += '  ';
        index += 1;
      } else {
        result += character === '\n' || character === '\r' ? character : ' ';
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
      result += '  ';
      index += 1;
      continue;
    }
    if (character === '/' && next === '*') {
      blockComment = true;
      result += '  ';
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

function assertAndroidIdentity(
  file: string,
  expected: AndroidIdentity,
  checkVersions: boolean,
): void {
  const source = stripComments(readRequiredFile(file, 'Android Gradle configuration'));

  const code = maskGradleStrings(source);
  if (hasGradleBracketIdentityWrite(source)) {
    throw new Error(`Native release preflight cannot resolve bracket identity writes in ${file}.`);
  }
  if (hasAndroidDisplayNameResourceOverride(source)) {
    throw new Error(`Native release preflight cannot resolve generated app_name in ${file}.`);
  }
  if (hasAndroidResourceSourceSetOverride(source)) {
    throw new Error(
      `Native release preflight cannot resolve custom resource sourceSets in ${file}.`,
    );
  }
  if (hasAndroidManifestSourceSetOverride(source)) {
    throw new Error(
      `Native release preflight cannot resolve custom manifest sourceSets in ${file}.`,
    );
  }
  if (hasGradleTaskAction(source)) {
    throw new Error(`Native release preflight cannot resolve Gradle task actions in ${file}.`);
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
  assertAndroidSetting(
    source,
    'versionCode',
    codePattern,
    checkVersions ? expected.versionCode : undefined,
    file,
  );
  assertAndroidSetting(
    source,
    'versionName',
    namePattern,
    checkVersions ? expected.versionName : undefined,
    file,
  );
}

/** `expected: undefined` only requires every assignment to be a readable literal (stamping). */
function assertAndroidSetting(
  source: string,
  key: string,
  expression: RegExp,
  expected: string | undefined,
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
  const inspect = (file: string, isSettingsScript: boolean, ownerDirectory: string): void => {
    const visitKey = `${ownerDirectory}\0${isSettingsScript}\0${file}`;
    if (visited.has(visitKey)) {
      return;
    }
    visited.add(visitKey);
    const source = stripComments(readRequiredFile(file, 'applied Android Gradle script'));
    const code = maskGradleStrings(source);
    if (/(?:^|[\s;{])apply\s*\{/u.test(code)) {
      throw new Error('Native release preflight cannot resolve an applied Gradle script.');
    }
    if (hasAndroidDisplayNameResourceOverride(source)) {
      throw new Error('Native release preflight cannot resolve generated app_name resources.');
    }
    if (hasAndroidResourceSourceSetOverride(source)) {
      throw new Error('Native release preflight cannot resolve custom resource sourceSets.');
    }
    if (hasAndroidManifestSourceSetOverride(source)) {
      throw new Error('Native release preflight cannot resolve custom manifest sourceSets.');
    }
    if (hasGradleTaskAction(source)) {
      throw new Error('Native release preflight cannot resolve Gradle task actions.');
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
        // Applied script paths stay relative to the owning Gradle project or settings.
        const resolved = resolve(ownerDirectory, requested);
        const within = relative(androidRoot, resolved);
        if (requested.includes('$') || within === '' || within.startsWith('..')
          || isAbsolute(within)) {
          throw new Error('Native release preflight cannot resolve an applied Gradle script.');
        }
        inspect(resolved, isSettingsScript, ownerDirectory);
      }
    }
    const applies = [ /\bapply\s+from\s*:/gu, /\bapply\s*\(/gu ];
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
  inspect(settingsFile, true, androidRoot);
  inspect(rootFile, false, androidRoot);
  inspect(appBuild, false, dirname(appBuild));
}

function assertIosIdentity(file: string, expected: IosIdentity, checkVersions: boolean): void {
  const source = readRequiredFile(file, 'iOS Xcode project configuration');
  assertIosReleaseProductName(source);
  assertIosReleaseInfoPlistExpansion(source);
  assertIosReleasePackagingSettings(source);
  const releaseSettings = readIosAppReleaseSettings(source, file);
  assertIosSetting(releaseSettings, 'PRODUCT_BUNDLE_IDENTIFIER', expected.bundleId, file);
  assertIosSetting(
    releaseSettings,
    'MARKETING_VERSION',
    checkVersions ? expected.marketingVersion : undefined,
    file,
  );
  assertIosSetting(
    releaseSettings,
    'CURRENT_PROJECT_VERSION',
    checkVersions ? expected.buildNumber : undefined,
    file,
  );
  const plistRelative = readIosReleaseInfoPlist(source);
  const plist = join(dirname(dirname(file)), plistRelative);
  assertIosReleasePlistIdentity(readRequiredFile(plist, 'iOS Release Info.plist'));
}

function assertIosSetting(
  settings: IosReleaseBuildSettings,
  key: 'PRODUCT_BUNDLE_IDENTIFIER' | 'MARKETING_VERSION' | 'CURRENT_PROJECT_VERSION',
  expected: string | undefined,
  file: string,
): void {
  const expression = new RegExp(`(?:^|[\\s{;])["']?${key}["']?\\s*=\\s*([^;]+);`, 'u');
  const conditionalPattern = `(?:^|[\\s{;])["']?${key}(?:\\[[^\\]\\r\\n]+\\])+["']?\\s*=`;
  const conditional = new RegExp(conditionalPattern, 'u');
  const target = stripComments(settings.target.values);
  const project = stripComments(settings.project.values);
  if (expected === undefined && key !== 'PRODUCT_BUNDLE_IDENTIFIER') {
    // Stamping writes an unconditional value into the App target's Release
    // settings, which overrides the project level and any xcconfig. A
    // conditional assignment at either level is rejected rather than relying
    // on how Xcode orders it against that value, and so are duplicates.
    if (conditional.test(target) || conditional.test(project)) {
      throw new Error(`Native release preflight does not support conditional ${key} in ${file}.`);
    }
    if (readSettingValues(target, expression).length > 1) {
      throw new Error(`Native release preflight has ambiguous App Release ${key} in ${file}.`);
    }
    return;
  }
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
  expected: string | undefined,
  file: string,
): void {
  if (values.length === 0) {
    throw new Error(`Native release preflight could not find ${expression.source} in ${file}.`);
  }
  if (expected === undefined) {
    return;
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
    /\brelease\s*\.\s*(?:apply|configure)\s*\{/gu,
    /\b(?:getByName|named)\s*\(\s*["']release["']\s*\)\s*\{/gu,
    /\b(?:getByName|named)\s*\(\s*["']release["']\s*\)\s*\.\s*(?:apply|configure)\s*\{/gu,
    /\bbuildTypes\s*\[\s*["']release["']\s*\]\s*\{/gu,
    /\bbuildTypes\s*\[\s*["']release["']\s*\]\s*\.\s*(?:apply|configure)\s*\{/gu,
  ];
  const qualifiedReleaseBlockExpressions = [
    /\bbuildTypes\s*\.\s*release\s*\{/gu,
    /\bbuildTypes\s*\.\s*release\s*\.\s*(?:apply|configure)\s*\{/gu,
    /\bbuildTypes\s*\[\s*["']release["']\s*\]\s*\.\s*(?:apply|configure)\s*\{/gu,
    /\bbuildTypes\s*\.\s*(?:getByName|named)\s*\(\s*["']release["']\s*\)\s*\{/gu,
    /\bbuildTypes\s*\.\s*(?:getByName|named)\s*\(\s*["']release["']\s*\)\s*\.\s*(?:apply|configure)\s*\{/gu,
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
