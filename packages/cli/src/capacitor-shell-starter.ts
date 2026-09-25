import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DOMParser, type Document, type Element } from '@xmldom/xmldom';

import { isNonPublicServiceHostname } from './production-target-readiness.js';
import {
  assertAndroidSettingsAppProject,
  assertAndroidSettingsNoAppRemap,
  assertIosReleaseInfoPlistExpansion,
  assertIosReleaseProductName,
  assertNativeShellIdentity,
  hasAndroidDisplayNameResourceOverride,
  hasAndroidManifestSourceSetOverride,
  hasAndroidResourceSourceSetOverride,
  hasGradleIdentityMutation,
  hasGradleTaskAction,
  maskGradleStrings,
  readIosAppTargetId,
  readIosReleaseInfoPlist,
  stripGradleComments,
} from './native-shell-identity.js';

const shellPath = 'apps/mobile-capacitor';
const webPath = `${shellPath}/www`;
const referenceShellPath = '${MPGD_KIT_PATH}/apps/mobile-capacitor';
const providerIdPattern = /^[a-z][a-z0-9-]*$/u;
const appIdPattern = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/u;
const javaKeywords = new Set(`
  abstract assert boolean break byte case catch char class const continue default do double
  else enum extends final finally float for goto if implements import instanceof int interface
  long native new package private protected public return short static strictfp super switch
  synchronized this throw throws transient try void volatile while true false null record sealed
  permits var yield
`.trim().split(/\s+/u));

interface PlannedFile {
  readonly path: string;
  readonly content: string;
}

export interface CapacitorShellStarterInput {
  readonly gameRoot: string;
  readonly appId: string;
  readonly displayName: string;
  readonly iconSource?: string;
  readonly backendUrl?: string;
  /** Selection metadata only; a provider SDK is not installed or enabled here. */
  readonly providerIds?: readonly string[];
}

export interface CapacitorShellStarterPlan {
  readonly gameRoot: string;
  readonly input: CapacitorShellStarterInput;
  readonly changedFiles: readonly string[];
  readonly nativePlatformsToAdd: readonly ('android' | 'ios')[];
  readonly files: readonly PlannedFile[];
}

/**
 * Produce the complete game-owned shell change list before writing anything.
 * Existing Android/iOS projects, signing files, and custom controllers are
 * never rewritten by this initializer.
 */
export function planCapacitorShellStarter(input: CapacitorShellStarterInput): CapacitorShellStarterPlan {
  if (!existsSync(input.gameRoot)) {
    throw new Error(`Game root does not exist: ${input.gameRoot}`);
  }
  const gameRoot = realpathSync(input.gameRoot);
  if (!lstatSync(gameRoot).isDirectory()) {
    throw new Error('Capacitor shell game root must be a directory.');
  }
  if (!appIdPattern.test(input.appId)) {
    throw new Error('Capacitor app ID must be a lowercase reverse-domain identifier.');
  }
  if (input.appId.split('.').some((segment) => javaKeywords.has(segment))) {
    throw new Error('Capacitor app ID cannot contain Java keyword segments.');
  }
  if (input.displayName.trim() !== input.displayName
    || input.displayName.length === 0 || input.displayName.length > 80) {
    throw new Error('Capacitor display name must be 1-80 characters without outer whitespace.');
  }
  if (/\$\(|\$\{/u.test(input.displayName)) {
    throw new Error('Capacitor display name cannot contain Xcode build-setting expansions.');
  }
  if (/[\t\n]/u.test(input.displayName)) {
    throw new Error('Capacitor display name cannot contain native whitespace controls.');
  }
  for (const scalar of input.displayName) {
    const point = scalar.codePointAt(0) ?? 0;
    if (point !== 0x9 && point !== 0xa
      && !(point >= 0x20 && point <= 0xd7ff)
      && !(point >= 0xe000 && point <= 0xfffd)
      && !(point >= 0x10000 && point <= 0x10ffff)) {
      throw new Error('Capacitor display name contains a character invalid in native XML.');
    }
  }
  const providerIds = [...new Set(input.providerIds ?? [])].sort();
  if (providerIds.some((id) => !providerIdPattern.test(id))) {
    throw new Error('Capacitor provider IDs must be lowercase hyphenated names.');
  }
  const backendUrl = input.backendUrl === undefined
    ? undefined
    : normalizeBackendUrl(input.backendUrl);
  const iconSource = input.iconSource === undefined
    ? undefined
    : relativeGameFile(gameRoot, input.iconSource);
  for (const managedPath of [
    'mpgd.targets.json',
    shellPath,
    `${shellPath}/package.json`,
    `${shellPath}/capacitor.config.ts`,
    `${shellPath}/mpgd.native-shell.json`,
    `${shellPath}/README.md`,
    `${shellPath}/www/index.html`,
    `${shellPath}/android`,
    `${shellPath}/ios`,
  ]) {
    safeDestination(gameRoot, managedPath);
  }
  const gamePackageFile = path.join(gameRoot, 'package.json');
  if (!existsSync(gamePackageFile)) {
    throw new Error('Game root must contain package.json.');
  }
  const gamePackage = readJsonObject(gamePackageFile);
  const gamePackageName = requireString(gamePackage.name, 'game package name');
  const gameDependencies = requireObject(gamePackage.dependencies, 'game dependencies');
  const capacitorVersion = requireString(gameDependencies['@capacitor/core'], '@capacitor/core');
  const appVersion = requireString(gameDependencies['@capacitor/app'], '@capacitor/app');
  if (!/^\d+\.\d+\.\d+$/u.test(capacitorVersion)
    || !/^\d+\.\d+\.\d+$/u.test(appVersion)) {
    throw new Error('Capacitor shell requires exact @capacitor/core and @capacitor/app versions.');
  }
  if (!capacitorVersion.startsWith('8.') || !appVersion.startsWith('8.')) {
    throw new Error('Capacitor shell requires Capacitor 8.x for core and app.');
  }
  const adapterFile = path.join(gameRoot, 'node_modules/@mpgd/adapter-capacitor/package.json');
  if (!existsSync(adapterFile)) {
    throw new Error('Install game dependencies before initializing the Capacitor shell.');
  }
  const adapter = readJsonObject(adapterFile);
  const adapterDependencies = requireObject(adapter.dependencies, 'Capacitor adapter dependencies');
  const pluginRequirement = requireString(
    adapterDependencies['@mpgd/capacitor-game-services'],
    '@mpgd/capacitor-game-services',
  );
  const pluginVersion = resolveInstalledPluginVersion(gameRoot, pluginRequirement);

  const targetsFile = path.join(gameRoot, 'mpgd.targets.json');
  if (!existsSync(targetsFile)) {
    throw new Error('Game root must contain mpgd.targets.json.');
  }
  const targets = readJsonObject(targetsFile);
  const cliPackage = readJsonObject(fileURLToPath(new URL('../package.json', import.meta.url)));
  const cliDevelopmentDependencies = requireObject(
    cliPackage.devDependencies,
    'CLI dev dependencies',
  );
  const typescriptVersion = requireString(
    cliDevelopmentDependencies.typescript,
    'CLI TypeScript version',
  );
  const targetMap = requireObject(targets.targets, 'targets');
  for (const [targetName, kind, identityKey] of [
    ['android', 'capacitor-android', 'packageId'],
    ['ios', 'capacitor-ios', 'bundleId'],
  ] as const) {
    if (targetMap[targetName] === undefined) {
      throw new Error(
        `Capacitor initialization requires the canonical ${targetName} target name used by the build CLI.`,
      );
    }
    const target = requireObject(targetMap[targetName], `${targetName} target`);
    if (target.kind !== kind) {
      throw new Error(`${targetName} must be a ${kind} target.`);
    }
    const configuredGame = requireString(target.gameApp, `${targetName}.gameApp`);
    if (path.resolve(gameRoot, configuredGame) !== gameRoot) {
      throw new Error(`${targetName}.gameApp must select this game root.`);
    }
    if (requireString(target.adapter, `${targetName}.adapter`) !== 'capacitor') {
      throw new Error(`${targetName}.adapter must be capacitor.`);
    }
    const configuredShell = requireString(target.shellApp, `${targetName}.shellApp`);
    if (configuredShell !== shellPath && configuredShell !== referenceShellPath) {
      throw new Error(`${targetName} already points at another shell; refusing to replace it.`);
    }
    const metadata = target.metadata === undefined
      ? {}
      : requireObject(target.metadata, `${targetName}.metadata`);
    if (metadata[identityKey] !== undefined && metadata[identityKey] !== input.appId) {
      throw new Error(`${targetName} ${identityKey} conflicts with the requested app ID.`);
    }
    if (metadata.displayName !== undefined && metadata.displayName !== input.displayName) {
      throw new Error(`${targetName} display name conflicts with the requested name.`);
    }
    const expectedArtifact = targetName === 'android' ? 'aab' : 'ipa';
    if (target.artifact === undefined) {
      target.artifact = expectedArtifact;
    } else if (target.artifact !== expectedArtifact) {
      throw new Error(`${targetName}.artifact must be ${expectedArtifact} for this native shell.`);
    }
    target.shellApp = shellPath;
    target.webDir = webPath;
    target.metadata = { ...metadata, [identityKey]: input.appId, displayName: input.displayName };
    if (iconSource !== undefined) {
      const icon = target.icon === undefined
        ? {}
        : requireObject(target.icon, `${targetName}.icon`);
      target.icon = { ...icon, source: iconSource };
    }
  }

  const packageFile = path.join(gameRoot, shellPath, 'package.json');
  const configFile = path.join(gameRoot, shellPath, 'capacitor.config.ts');
  const manifestFile = path.join(gameRoot, shellPath, 'mpgd.native-shell.json');
  const packageContent = readExisting(packageFile);
  const configContent = readExisting(configFile);
  const manifestContent = readExisting(manifestFile);
  const existingManifest = manifestContent === undefined
    ? undefined
    : parseJsonObject(manifestContent, 'existing native shell manifest');
  if (existingManifest !== undefined && existingManifest.schemaVersion !== 1) {
    throw new Error(
      'Existing native shell manifest schema is unsupported; refusing to downgrade it.',
    );
  }
  if (existingManifest !== undefined
    && (existingManifest.appId !== input.appId
      || existingManifest.displayName !== input.displayName)) {
    throw new Error('Existing native shell identity differs; refusing to overwrite it.');
  }
  const requestedProviderIds = input.providerIds === undefined
    && Array.isArray(existingManifest?.requestedProviderIds)
    ? existingManifest.requestedProviderIds : providerIds;
  const requestedBackendUrl = backendUrl ?? (typeof existingManifest?.backendUrl === 'string'
    ? existingManifest.backendUrl : undefined);
  if (packageContent !== undefined) {
    assertCompatibleExistingPackage(
      packageContent,
      capacitorVersion,
      appVersion,
      pluginVersion,
      typescriptVersion,
    );
  }
  if (configContent !== undefined) {
    const safeConfig = requireStaticCapacitorConfig(configContent);
    const existingAppId = readCapacitorConfigLiteral(safeConfig, 'appId');
    if (existingAppId === undefined) {
      throw new Error('Existing Capacitor shell app ID could not be read safely.');
    }
    if (existingAppId !== input.appId) {
      throw new Error('Existing Capacitor shell app ID differs; refusing to overwrite it.');
    }
    const existingAppName = readCapacitorConfigLiteral(safeConfig, 'appName');
    if (existingAppName === undefined) {
      throw new Error('Existing Capacitor shell display name could not be read safely.');
    }
    if (existingAppName !== input.displayName) {
      throw new Error('Existing Capacitor shell display name differs; refusing to overwrite it.');
    }
    const existingWebDir = readCapacitorConfigLiteral(safeConfig, 'webDir');
    if (existingWebDir !== 'www') {
      throw new Error('Existing Capacitor shell webDir differs; refusing to overwrite it.');
    }
  }
  const requestedFiles: PlannedFile[] = [
    { path: 'mpgd.targets.json', content: json(targets) },
    {
      path: `${shellPath}/package.json`,
      content: packageContent ?? json({
        name: `${gamePackageName}-native-shell`,
        private: true,
        version: '0.0.0',
        type: 'module',
        scripts: {
          cap: 'cap',
          'sync:android': 'cap sync android',
          'sync:ios': 'cap sync ios',
        },
        dependencies: {
          '@capacitor/android': capacitorVersion,
          '@capacitor/app': appVersion,
          '@capacitor/core': capacitorVersion,
          '@capacitor/ios': capacitorVersion,
          '@mpgd/capacitor-game-services': pluginVersion,
        },
        devDependencies: {
          '@capacitor/cli': capacitorVersion,
          typescript: typescriptVersion,
        },
      }),
    },
    {
      path: `${shellPath}/capacitor.config.ts`,
      content: configContent ?? [
        "import type { CapacitorConfig } from '@capacitor/cli';",
        '',
        'const config: CapacitorConfig = {',
        `  appId: ${JSON.stringify(input.appId)},`,
        `  appName: ${JSON.stringify(input.displayName)},`,
        "  webDir: 'www',",
        "  server: { androidScheme: 'https' },",
        "  ios: { contentInset: 'automatic' },",
        '  android: { allowMixedContent: false },',
        '};',
        '',
        'export default config;',
        '',
      ].join('\n'),
    },
    {
      path: `${shellPath}/mpgd.native-shell.json`,
      content: json({
        schemaVersion: 1,
        appId: input.appId,
        displayName: input.displayName,
        requestedProviderIds,
        ...(requestedBackendUrl === undefined ? {} : { backendUrl: requestedBackendUrl }),
      }),
    },
    {
      path: `${shellPath}/README.md`,
      content: readExisting(path.join(gameRoot, shellPath, 'README.md')) ?? [
        '# Game-owned Capacitor shell',
        '',
        'This private shell belongs to this game. The initializer installs game',
        'dependencies and uses the pinned Capacitor CLI to add missing Android',
        'and iOS projects. Rerun it after an interrupted dependency install.',
        'If cap add left an incomplete native directory, repair or remove only',
        'that game-owned directory before retrying; it is never overwritten.',
        'Existing native files, signing settings, and custom',
        'ViewControllers are never replaced by mpgd target init capacitor.',
        '',
        'requestedProviderIds is selection metadata only: it does not install an',
        'SDK or report a feature as available. Register provider modules explicitly.',
        'Production builds require a real game-owned backend when grants are enabled.',
        '',
      ].join('\n'),
    },
    {
      path: `${shellPath}/www/index.html`,
      content: readExisting(path.join(gameRoot, shellPath, 'www/index.html')) ?? [
        '<!doctype html>',
        '<html lang="en"><head><meta charset="utf-8"><title>Native shell setup</title></head>',
        '<body>Run mpgd target build to replace this setup page with the game bundle.</body></html>',
        '',
      ].join('\n'),
    },
  ];
  if (requestedBackendUrl !== undefined) {
    safeDestination(gameRoot, '.env.production');
    safeDestination(gameRoot, '.env.production.local');
    const validatedBackendUrl = normalizeBackendUrl(requestedBackendUrl);
    const localEnv = readExisting(path.join(gameRoot, '.env.production.local')) ?? '';
    const localDefinitions = [...localEnv.replace(/^\uFEFF/u, '').matchAll(
      /^[ \t]*(?:export[ \t]+)?VITE_MPGD_GAME_SERVICES_URL[ \t]*=[ \t]*(.*)$/gmu,
    )];
    if (localDefinitions.length > 1) {
      throw new Error('Duplicate production-local Game Services URLs are not allowed.');
    }
    if (localDefinitions[0]?.[1] !== undefined
      && normalizeBackendUrl(readDotenvValue(localDefinitions[0][1] ?? ''))
        !== validatedBackendUrl) {
      throw new Error('Production-local Game Services URL conflicts with the requested shell.');
    }
    const envFile = path.join(gameRoot, '.env.production');
    const current = readExisting(envFile) ?? '';
    const definitions = [...current.replace(/^\uFEFF/u, '').matchAll(
      /^[ \t]*(?:export[ \t]+)?VITE_MPGD_GAME_SERVICES_URL[ \t]*=[ \t]*(.*)$/gmu,
    )];
    if (definitions.length > 1) {
      throw new Error('Duplicate production Game Services URLs are not allowed.');
    }
    const existing = definitions[0]?.[1] === undefined
      ? undefined
      : readDotenvValue(definitions[0][1] ?? '');
    if (existing !== undefined && normalizeBackendUrl(existing) !== validatedBackendUrl) {
      throw new Error('Existing production Game Services URL differs; refusing to overwrite it.');
    }
    requestedFiles.push({
      path: '.env.production',
      content: existing === undefined
        ? appendEnvLine(current, `VITE_MPGD_GAME_SERVICES_URL=${validatedBackendUrl}`)
        : current,
    });
  }
  const nativePlatformsToAdd = (['android', 'ios'] as const).filter((platform) => {
    const nativeDirectory = path.join(gameRoot, shellPath, platform);
    if (!existsSync(nativeDirectory)) {
      return true;
    }
    assertNativePlatformComplete(gameRoot, platform, input.appId, input.displayName);
    return false;
  });
  const smokePath = `${shellPath}/ios/App/App/Info-Smoke.plist`;
  safeDestination(gameRoot, smokePath);
  if (readExisting(path.join(gameRoot, smokePath)) === undefined) {
    requestedFiles.push({ path: smokePath, content: smokeInfoPlist(input.displayName) });
  }
  const files = requestedFiles.filter(
    (file) => readExisting(path.join(gameRoot, file.path)) !== file.content,
  );
  return {
    gameRoot,
    input: {
      ...input,
      gameRoot,
      ...(input.providerIds === undefined ? {} : { providerIds: [...input.providerIds] }),
    },
    files,
    changedFiles: files.map((file) => file.path),
    nativePlatformsToAdd,
  };
}

export function applyCapacitorShellStarter(
  plan: CapacitorShellStarterPlan,
  installStagedFile: (temporary: string, destination: string) => void = renameSync,
): void {
  const staged = plan.files.filter((file) => !plan.nativePlatformsToAdd.some((platform) =>
    file.path.startsWith(`${shellPath}/${platform}/`))).map((file) => {
    const destination = safeDestination(plan.gameRoot, file.path);
    mkdirSync(path.dirname(destination), { recursive: true });
    assertNotSymlink(destination);
    const previous = existsSync(destination) ? lstatSync(destination) : undefined;
    if (previous !== undefined && !previous.isFile()) {
      throw new Error(`Managed shell destination must be a file: ${destination}`);
    }
    const temporary = `${destination}.mpgd-${randomUUID()}.tmp`;
    return {
      destination,
      temporary,
      previousMode: previous === undefined ? undefined : previous.mode & 0o7777,
      content: file.content,
    };
  });
  const installed: { destination: string; backup?: string }[] = [];
  try {
    for (const file of staged) {
      writeFileSync(file.temporary, file.content, {
        flag: 'wx',
        mode: file.previousMode ?? 0o666,
      });
      if (file.previousMode !== undefined) {
        chmodSync(file.temporary, file.previousMode);
      }
    }
    for (const file of staged) {
      const entry: { destination: string; backup?: string } = { destination: file.destination };
      if (file.previousMode !== undefined) {
        entry.backup = `${file.destination}.mpgd-${randomUUID()}.backup`;
        renameSync(file.destination, entry.backup);
      }
      installed.push(entry);
      installStagedFile(file.temporary, file.destination);
    }
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    for (const entry of installed.reverse()) {
      try {
        if (existsSync(entry.destination)) {
          unlinkSync(entry.destination);
        }
        if (entry.backup !== undefined && existsSync(entry.backup)) {
          renameSync(entry.backup, entry.destination);
        }
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError([error, ...rollbackErrors], 'Capacitor shell rollback failed.');
    }
    throw error;
  } finally {
    for (const file of staged) {
      if (existsSync(file.temporary)) {
        unlinkSync(file.temporary);
      }
    }
  }
  for (const entry of installed) {
    if (entry.backup !== undefined) {
      unlinkSync(entry.backup);
    }
  }
}

function safeDestination(gameRoot: string, relative: string): string {
  if (relative === '' || path.isAbsolute(relative)) {
    throw new Error('Managed shell path must be relative to the game.');
  }
  const canonicalRoot = realpathSync(gameRoot);
  const destination = path.resolve(canonicalRoot, relative);
  const within = path.relative(canonicalRoot, destination);
  if (within === '' || within.startsWith('..') || path.isAbsolute(within)) {
    throw new Error('Managed shell path must stay inside the game.');
  }
  let current = canonicalRoot;
  for (const segment of within.split(path.sep)) {
    current = path.join(current, segment);
    assertNotSymlink(current);
  }
  return destination;
}

export interface CapacitorShellCommandRunner {
  run(command: string, args: readonly string[], cwd: string): void;
}

/** Materialize only missing native projects after the non-destructive plan is applied. */
export function materializeCapacitorShellStarter(
  plan: CapacitorShellStarterPlan,
  runner: CapacitorShellCommandRunner = { run: runCommand },
): void {
  applyCapacitorShellStarter(plan);
  // Native projects are generated by the pinned Capacitor CLI within the
  // game workspace. An existing game may exclude the new shell from its
  // workspace globs. Always retry its standalone install: a CLI shim alone
  // does not prove that an interrupted dependency install completed.
  runner.run('pnpm', ['install', '--no-frozen-lockfile'], plan.gameRoot);
  runner.run(
    'pnpm',
    ['--dir', shellPath, 'install', '--ignore-workspace', '--no-frozen-lockfile'],
    plan.gameRoot,
  );
  for (const platform of plan.nativePlatformsToAdd) {
    if (!existsSync(path.join(plan.gameRoot, shellPath, platform))) {
      runner.run('pnpm', ['--dir', shellPath, 'cap', 'add', platform], plan.gameRoot);
    }
    const manifest = readJsonObject(path.join(plan.gameRoot, shellPath, 'mpgd.native-shell.json'));
    if (platform === 'ios') {
      materializeIosArchiveScheme(plan.gameRoot);
      const relative = `${shellPath}/ios/App/App/Info-Smoke.plist`;
      const destination = safeDestination(plan.gameRoot, relative);
      if (!existsSync(destination)) {
        const planned = plan.files.find((file) => file.path === relative);
        if (planned === undefined) {
          throw new Error('New ios project simulator Info.plist was not planned.');
        }
        writeFileSync(destination, planned.content, { flag: 'wx' });
      }
    }
    assertNativePlatformComplete(
      plan.gameRoot,
      platform,
      requireString(manifest.appId, 'shell app ID'),
      requireString(manifest.displayName, 'shell display name'),
    );
  }
  const afterInstall = planCapacitorShellStarter(plan.input);
  if (afterInstall.changedFiles.length > 0 || afterInstall.nativePlatformsToAdd.length > 0) {
    throw new Error('Capacitor shell changed during installation; rerun the initializer.');
  }
}

function materializeIosArchiveScheme(gameRoot: string): void {
  const schemeRelative = `${shellPath}/ios/App/App.xcodeproj/xcshareddata/xcschemes/App.xcscheme`;
  const schemeFile = safeDestination(gameRoot, schemeRelative);
  if (existsSync(schemeFile)) {
    return;
  }
  const projectRelative = `${shellPath}/ios/App/App.xcodeproj/project.pbxproj`;
  const projectFile = safeDestination(gameRoot, projectRelative);
  const appTargetId = readIosAppTargetId(readFileSync(projectFile, 'utf8'));
  const scheme = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Scheme LastUpgradeVersion="2600" version="1.7">',
    '<BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES">',
    '<BuildActionEntries>',
    '<BuildActionEntry buildForTesting="YES" buildForRunning="YES"',
    ' buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES">',
    `<BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="${appTargetId}"`,
    ' BuildableName="App.app" BlueprintName="App"',
    ' ReferencedContainer="container:App.xcodeproj"/>',
    '</BuildActionEntry>',
    '</BuildActionEntries>',
    '</BuildAction>',
    '<ArchiveAction buildConfiguration="Release" revealArchiveInOrganizer="YES"/>',
    '</Scheme>',
  ].join('\n');
  mkdirSync(path.dirname(schemeFile), { recursive: true });
  writeFileSync(schemeFile, `${scheme}\n`, { flag: 'wx' });
}

function assertNativePlatformComplete(
  gameRoot: string,
  platform: 'android' | 'ios',
  expectedAppId: string,
  expectedDisplayName: string,
): void {
  const nativeDirectory = path.join(gameRoot, shellPath, platform);
  if (!existsSync(nativeDirectory) || !lstatSync(nativeDirectory).isDirectory()) {
    throw new Error(
      `Existing ${platform} project is incomplete; repair or remove only that game-owned directory before retrying.`,
    );
  }
  const required = platform === 'android'
    ? requireOneNativeFile(nativeDirectory, ['app/build.gradle', 'app/build.gradle.kts'], platform)
    : requireOneNativeFile(nativeDirectory, ['App/App.xcodeproj/project.pbxproj'], platform);
  if (platform === 'android') {
    const rootBuild = requireOneNativeFile(
      nativeDirectory,
      ['build.gradle', 'build.gradle.kts'],
      platform,
    );
    const settings = requireOneNativeFile(
      nativeDirectory,
      ['settings.gradle', 'settings.gradle.kts'],
      platform,
    );
    const rootSource = stripGradleComments(
      readFileSync(path.join(nativeDirectory, rootBuild), 'utf8'),
    );
    const settingsSource = stripGradleComments(
      readFileSync(path.join(nativeDirectory, settings), 'utf8'),
    );
    assertAndroidSettingsAppProject(settingsSource);
    const rootCode = maskGradleStrings(rootSource);
    const settingsCode = maskGradleStrings(settingsSource);
    if (/\b(?:afterEvaluate|projectsEvaluated)\b/u.test(rootCode)
      && /\b(?:project|subprojects|allprojects|android)\b/u.test(rootCode)) {
      throw new Error('Existing android project has unsupported root Gradle app callbacks.');
    }
    if (/\b(?:beforeProject|afterProject|beforeEvaluate|afterEvaluate|projectsEvaluated)\b/u
      .test(settingsCode)) {
      throw new Error('Existing android project has unsupported settings Gradle callbacks.');
    }
    const visited = new Set<string>();
    const inspectedScripts = new Set<string>();
    for (const script of [settings, rootBuild, required]) {
      const ownerDirectory = script === required
        ? path.join(nativeDirectory, 'app')
        : nativeDirectory;
      assertAppliedGradleScripts(
        nativeDirectory,
        script,
        visited,
        inspectedScripts,
        script === settings,
        ownerDirectory,
      );
    }
    for (const script of inspectedScripts) {
      const source = stripGradleComments(readFileSync(path.join(nativeDirectory, script), 'utf8'));
      if (hasAndroidDisplayNameResourceOverride(source)) {
        throw new Error('Existing android project generates an unsupported app_name resource.');
      }
      if (hasAndroidResourceSourceSetOverride(source)) {
        throw new Error('Existing android project custom resource sourceSets are unsupported.');
      }
      if (hasAndroidManifestSourceSetOverride(source)) {
        throw new Error('Existing android project custom manifest sourceSets are unsupported.');
      }
      if (hasGradleTaskAction(source)) {
        throw new Error('Existing android project Gradle task actions are unsupported.');
      }
      if (script === required) {
        continue;
      }
      if (/\bproductFlavors\b/u.test(maskGradleStrings(source))) {
        throw new Error('Existing android project product flavors are unsupported by the builder.');
      }
      if (hasGradleIdentityMutation(source)) {
        throw new Error(
          `Existing android project applied Gradle script changes identity: ${script}`,
        );
      }
    }
  } else {
    const hasSpm = isNativeFile(nativeDirectory, 'App/CapApp-SPM/Package.swift');
    if (!hasSpm) {
      throw new Error('Existing ios project is incomplete; SPM files are required by the builder.');
    }
  }
  const additional = platform === 'android'
    ? [
        'gradlew',
        'gradle/wrapper/gradle-wrapper.jar',
        'gradle/wrapper/gradle-wrapper.properties',
        'app/src/main/AndroidManifest.xml',
      ]
    : ['App/App/AppDelegate.swift'];
  if (additional.some((relative) => !isNativeFile(nativeDirectory, relative))) {
    throw new Error(
      `Existing ${platform} project is incomplete; required native files are missing.`,
    );
  }
  if (platform === 'android' && process.platform !== 'win32'
    && (lstatSync(path.join(nativeDirectory, 'gradlew')).mode & 0o111) === 0) {
    throw new Error('Existing android project Gradle wrapper is not executable.');
  }
  const content = readFileSync(path.join(nativeDirectory, required), 'utf8');
  assertNativeShellIdentity(platform, content, expectedAppId);
  if (platform === 'ios') {
    assertIosReleaseProductName(content);
    assertIosReleaseInfoPlistExpansion(content);
    const infoPlist = readIosReleaseInfoPlist(content);
    const infoRelative = path.join('App', infoPlist);
    if (!isNativeFile(nativeDirectory, infoRelative)) {
      throw new Error('Existing ios project Release Info.plist is missing or unsafe.');
    }
    const compiledSources = assertReferencedIosFiles(nativeDirectory, content, infoRelative);
    assertNativeDisplayName(nativeDirectory, platform, expectedDisplayName, infoRelative);
    assertIosReleasePlistIdentity(readFileSync(path.join(nativeDirectory, infoRelative), 'utf8'));
    assertNoIosLocalizedDisplayNameOverride(nativeDirectory, content);
    assertIosArchiveScheme(path.join(gameRoot, shellPath));
    const smokeRelative = 'App/App/Info-Smoke.plist';
    if (existsSync(path.join(nativeDirectory, smokeRelative))) {
      if (!isNativeFile(nativeDirectory, smokeRelative)) {
        throw new Error('Existing ios project simulator Info.plist is unsafe.');
      }
      const smoke = readFileSync(path.join(nativeDirectory, smokeRelative), 'utf8');
      assertSmokeInfoPlist(smoke, expectedDisplayName);
      assertSceneDelegateFiles(nativeDirectory, smoke, 'simulator', compiledSources);
    } else {
      const generatedSmoke = smokeInfoPlist(expectedDisplayName);
      assertSceneDelegateFiles(nativeDirectory, generatedSmoke, 'simulator', compiledSources);
    }
  } else {
    if (/\bproductFlavors\b/u.test(maskGradleStrings(stripGradleComments(content)))) {
      throw new Error('Existing android project product flavors are unsupported by the builder.');
    }
    assertAndroidManifestResources(nativeDirectory);
    assertNativeDisplayName(nativeDirectory, platform, expectedDisplayName);
    assertAndroidLauncherClasses(nativeDirectory, content);
  }
}

function assertAndroidLauncherClasses(nativeDirectory: string, gradle: string): void {
  const application = readAndroidApplication(
    path.join(nativeDirectory, 'app/src/main/AndroidManifest.xml'),
  );
  if (application === undefined) {
    throw new Error('Existing android project launcher activity is missing.');
  }
  assertAndroidLauncherEnabled(application, 'main application');
  const manifestRoot = application.parentNode as Element | null;
  const manifestPackage = manifestRoot?.getAttribute('package');
  const namespace = /\bnamespace\s*(?:=\s*)?["']([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)+)["']/u
    .exec(stripGradleComments(gradle))?.[1]
    ?? (manifestPackage === null || manifestPackage === '' ? undefined : manifestPackage);
  const releaseFile = path.join(nativeDirectory, 'app/src/release/AndroidManifest.xml');
  const release = existsSync(releaseFile) ? readAndroidApplication(releaseFile, false) : undefined;
  if (release !== undefined) {
    assertAndroidLauncherEnabled(release, 'Release application');
  }
  assertAndroidApplicationClasses(nativeDirectory, application, release, namespace);
  const launchers = [
    ...readAndroidLaunchers(application).map((element) => ({ element, release: false })),
    ...(release === undefined ? [] : readAndroidLaunchers(release)
      .map((element) => ({ element, release: true }))),
  ];
  if (launchers.length === 0) {
    throw new Error('Existing android project launcher activity is missing.');
  }
  for (const { element: launcher, release: releaseLauncher } of launchers) {
    assertAndroidLauncherEnabled(launcher, 'launcher');
    const isAlias = launcher.tagName === 'activity-alias';
    const attribute = isAlias ? 'android:targetActivity' : 'android:name';
    const name = launcher.getAttribute(attribute) ?? undefined;
    if (name === undefined || (name.startsWith('.') || !name.includes('.'))
      && namespace === undefined) {
      throw new Error('Existing android project launcher class cannot be resolved.');
    }
    let qualified = name;
    if (name.startsWith('.')) {
      qualified = `${namespace}${name}`;
    } else if (!name.includes('.')) {
      qualified = `${namespace}.${name}`;
    }
    if (!/^[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)+$/u.test(qualified)) {
      throw new Error('Existing android project launcher class cannot be resolved.');
    }
    const launcherName = qualifyAndroidActivityName(
      launcher.getAttribute('android:name'),
      namespace,
    );
    const inheritedExported = releaseLauncher
      ? readAndroidLaunchers(application).find((item) => qualifyAndroidActivityName(
        item.getAttribute('android:name'),
        namespace,
      ) === launcherName)?.getAttribute('android:exported')
      : null;
    if ((launcher.getAttribute('android:exported') ?? inheritedExported) !== 'true') {
      throw new Error('Existing android project launcher must declare android:exported="true".');
    }
    if (isAlias) {
      const targetInRelease = release === undefined ? [] : childElements(release)
        .filter((activity) => activity.tagName === 'activity');
      const changedTarget = targetInRelease.some((activity) =>
        qualifyAndroidActivityName(activity.getAttribute('android:name'), namespace) === qualified
        && hasAndroidMergerDirectiveDeep(activity));
      if (changedTarget) {
        throw new Error(
          `Existing android launcher alias target ${qualified} is changed by Release.`,
        );
      }
      const activities = childElements(application)
        .concat(release === undefined ? [] : childElements(release));
      const declared = activities.some((activity) => {
        const activityName = activity.getAttribute('android:name');
        if (activity.tagName !== 'activity' || activityName === null
          || hasAndroidMergerDirective(activity)) {
          return false;
        }
        const resolved = qualifyAndroidActivityName(activityName, namespace);
        return resolved === qualified;
      });
      if (!declared) {
        throw new Error(`Existing android launcher alias target ${qualified} is undeclared.`);
      }
    }
    const sourceSets = releaseLauncher ? ['main', 'release'] : ['main'];
    const sources = [...new Set(sourceSets.flatMap((sourceSet) =>
      ['java', 'kotlin'].flatMap((language) =>
        ['.java', '.kt'].flatMap((extension) => listNativeFiles(
          nativeDirectory,
          `app/src/${sourceSet}/${language}`,
          extension,
        )))))];
    const validActivity = resolvesAndroidClass(
      nativeDirectory,
      qualified,
      sources,
      new Set(),
      androidActivityBases,
    );
    if (!validActivity) {
      throw new Error(
        `Existing android project launcher class ${qualified} is missing or not an Android Activity.`,
      );
    }
  }
}

const androidActivityBases = new Set([
  'android.app.Activity',
  'com.getcapacitor.BridgeActivity',
  'androidx.activity.ComponentActivity',
  'androidx.appcompat.app.AppCompatActivity',
  'androidx.fragment.app.FragmentActivity',
]);

const androidApplicationBases = new Set([
  'android.app.Application',
  'androidx.multidex.MultiDexApplication',
]);

function assertAndroidApplicationClasses(
  nativeDirectory: string,
  main: Element,
  release: Element | undefined,
  namespace: string | undefined,
): void {
  const variants = [
    { application: main, sourceSets: ['main'] },
    ...(release === undefined ? [] : [
      { application: release, sourceSets: ['main', 'release'] },
    ]),
  ];
  for (const { application, sourceSets } of variants) {
    const name = application.getAttribute('android:name');
    if (name === null) {
      continue;
    }
    const qualified = qualifyAndroidActivityName(name, namespace);
    if (qualified === undefined) {
      throw new Error('Existing android project Application class cannot be resolved.');
    }
    const sources = [...new Set(sourceSets.flatMap((sourceSet) =>
      ['java', 'kotlin'].flatMap((language) =>
        ['.java', '.kt'].flatMap((extension) => listNativeFiles(
          nativeDirectory, `app/src/${sourceSet}/${language}`, extension,
        )))))];
    const validApplication = resolvesAndroidClass(
      nativeDirectory,
      qualified,
      sources,
      new Set(),
      androidApplicationBases,
    );
    if (!validApplication) {
      throw new Error(
        `Existing android project Application class ${qualified} is missing or invalid.`,
      );
    }
  }
}

function resolvesAndroidClass(
  nativeDirectory: string,
  qualified: string,
  sourceFiles: readonly string[],
  visited: Set<string>,
  bases: ReadonlySet<string>,
): boolean {
  if (bases.has(qualified)) {
    return true;
  }
  if (visited.has(qualified)) {
    return false;
  }
  visited.add(qualified);
  const separator = qualified.lastIndexOf('.');
  const packageName = qualified.slice(0, separator);
  const className = qualified.slice(separator + 1);
  for (const relative of sourceFiles) {
    if (!isNativeFile(nativeDirectory, relative)) {
      continue;
    }
    const source = stripSourceCommentsAndStrings(
      readFileSync(path.join(nativeDirectory, relative), 'utf8'),
    );
    const declaredPackage = /\bpackage\s+([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)+)\s*;?/u
      .exec(source)?.[1];
    if (declaredPackage !== packageName) {
      continue;
    }
    const base = readTopLevelAndroidSuperclass(source, className);
    if (base === undefined) {
      continue;
    }
    const imported = [...source.matchAll(/\bimport\s+([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)+)\s*;?/gu)]
      .map((match) => match[1] ?? '')
      .find((name) => name.endsWith(`.${base}`));
    const resolved = base.includes('.') ? base : (imported ?? `${packageName}.${base}`);
    if (resolvesAndroidClass(nativeDirectory, resolved, sourceFiles, visited, bases)) {
      return true;
    }
  }
  return false;
}

function readTopLevelAndroidSuperclass(source: string, className: string): string | undefined {
  const expression = new RegExp(`\\bclass\\s+${className}\\b([^{};\\r\\n]*)(?:\\{|$)`, 'gmu');
  for (const match of source.matchAll(expression)) {
    let depth = 0;
    for (const character of source.slice(0, match.index)) {
      depth += character === '{' ? 1 : character === '}' ? -1 : 0;
    }
    if (depth !== 0) {
      continue;
    }
    const header = match[1] ?? '';
    return /\bextends\s+([A-Za-z_][\w.]*)/u.exec(header)?.[1]
      ?? /:\s*([A-Za-z_][\w.]*)\s*\(/u.exec(header)?.[1];
  }
  return undefined;
}

function qualifyAndroidActivityName(
  name: string | null,
  namespace: string | undefined,
): string | undefined {
  if (name === null) {
    return undefined;
  }
  if (name.startsWith('.')) {
    return namespace === undefined ? undefined : `${namespace}${name}`;
  }
  return name.includes('.') ? name : namespace === undefined ? undefined : `${namespace}.${name}`;
}

function listNativeFiles(
  nativeDirectory: string,
  relativeRoot: string,
  extension: string,
): string[] {
  const pending = [relativeRoot];
  const files: string[] = [];
  while (pending.length > 0) {
    const relative = pending.pop() ?? '';
    const full = path.join(nativeDirectory, relative);
    if (!existsSync(full) || lstatSync(full).isSymbolicLink()) {
      continue;
    }
    for (const entry of readdirSync(full, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) {
        continue;
      }
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) {
        pending.push(child);
      } else if (entry.isFile() && entry.name.endsWith(extension)) {
        files.push(child);
        if (files.length > 10_000) {
          throw new Error('Existing native project has too many source files to inspect.');
        }
      }
    }
  }
  return files;
}

function assertAndroidLauncherEnabled(element: Element, label: string): void {
  for (const attribute of ['android:enabled', 'android:exported']) {
    const value = element.getAttribute(attribute);
    if (value !== null && value !== 'true') {
      throw new Error(`Existing android project ${label} ${attribute} is unsupported.`);
    }
  }
}

function stripSourceCommentsAndStrings(source: string): string {
  let output = '';
  let quote: '"' | "'" | undefined;
  let blockComment = false;
  let lineComment = false;
  let rawString = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? '';
    const next = source[index + 1] ?? '';
    if (lineComment) {
      if (character === '\n') {
        lineComment = false;
        output += '\n';
      } else {
        output += ' ';
      }
      continue;
    }
    if (blockComment) {
      if (character === '*' && next === '/') {
        blockComment = false;
        output += '  ';
        index += 1;
      } else {
        output += character === '\n' ? '\n' : ' ';
      }
      continue;
    }
    if (rawString) {
      if (source.startsWith('"""', index)) {
        rawString = false;
        output += '   ';
        index += 2;
      } else {
        output += character === '\n' ? '\n' : ' ';
      }
      continue;
    }
    if (quote !== undefined) {
      if (character === '\\' && next !== '') {
        output += '  ';
        index += 1;
      } else if (character === quote) {
        quote = undefined;
        output += ' ';
      } else {
        output += character === '\n' ? '\n' : ' ';
      }
      continue;
    }
    if (character === '/' && next === '/') {
      lineComment = true;
      output += '  ';
      index += 1;
    } else if (character === '/' && next === '*') {
      blockComment = true;
      output += '  ';
      index += 1;
    } else if (source.startsWith('"""', index)) {
      rawString = true;
      output += '   ';
      index += 2;
    } else if (character === '"' || character === "'") {
      quote = character;
      output += ' ';
    } else {
      output += character;
    }
  }
  return output;
}

function assertSmokeInfoPlist(source: string, expectedDisplayName: string): void {
  const values = parsePlistDictionary(source, 'simulator');
  const required: readonly [string, string][] = [
    ['CFBundleDisplayName', expectedDisplayName],
    ['CFBundleExecutable', '$(EXECUTABLE_NAME)'],
    ['CFBundleIdentifier', '$(PRODUCT_BUNDLE_IDENTIFIER)'],
    ['CFBundleName', '$(PRODUCT_NAME)'],
    ['CFBundlePackageType', 'APPL'],
    ['CFBundleShortVersionString', '$(MARKETING_VERSION)'],
    ['CFBundleVersion', '$(CURRENT_PROJECT_VERSION)'],
  ];
  for (const [key, expected] of required) {
    const actual = values.get(key);
    if (actual?.tagName !== 'string' || actual.textContent !== expected) {
      throw new Error(`Existing ios project simulator Info.plist ${key} differs or is missing.`);
    }
  }
  if ([...values.keys()].some((key) => ['UIMainStoryboardFile', 'UILaunchStoryboardName']
    .some((name) => key === name || key.startsWith(`${name}~`) || key.startsWith(`${name}-`)))) {
    throw new Error('Existing ios project simulator Info.plist references excluded storyboards.');
  }
}

function parseXml(source: string, label: string): Document {
  try {
    return new DOMParser({
      onError(_level, message) { throw new Error(message); },
    }).parseFromString(source, 'application/xml');
  } catch {
    throw new Error(`Existing ${label} is malformed.`);
  }
}

function childElements(element: Element): Element[] {
  return Array.from(element.childNodes)
    .filter((node): node is Element => node.nodeType === 1);
}

function parsePlistDictionary(source: string, label: string): Map<string, Element> {
  const plist = parseXml(source, `ios project ${label} Info.plist`).documentElement;
  const children = plist === null ? [] : childElements(plist);
  const dictionary = children[0];
  if (plist?.tagName !== 'plist' || children.length !== 1
    || dictionary?.tagName !== 'dict' || hasNonWhitespaceText(plist)) {
    throw new Error(`Existing ios project ${label} Info.plist is malformed.`);
  }
  return parsePlistEntries(dictionary, label);
}

/** Fail closed when a Release plist hardcodes values independently of Xcode build settings. */
export function assertIosReleasePlistIdentity(source: string): void {
  const values = parsePlistDictionary(source, 'Release');
  const required: readonly [string, string][] = [
    ['CFBundleExecutable', '$(EXECUTABLE_NAME)'],
    ['CFBundleIdentifier', '$(PRODUCT_BUNDLE_IDENTIFIER)'],
    ['CFBundleName', '$(PRODUCT_NAME)'],
    ['CFBundlePackageType', 'APPL'],
    ['CFBundleShortVersionString', '$(MARKETING_VERSION)'],
    ['CFBundleVersion', '$(CURRENT_PROJECT_VERSION)'],
  ];
  for (const [key, expected] of required) {
    const value = values.get(key);
    if (value?.tagName !== 'string' || value.textContent !== expected) {
      throw new Error(`Existing ios project Release Info.plist ${key} differs or is missing.`);
    }
  }
}

function parsePlistEntries(dictionary: Element, label: string): Map<string, Element> {
  const children = childElements(dictionary);
  if (children.length % 2 !== 0 || hasNonWhitespaceText(dictionary)) {
    throw new Error(`Existing ios project ${label} Info.plist is malformed.`);
  }
  const entries = new Map<string, Element>();
  for (let index = 0; index < children.length; index += 2) {
    const key = children[index];
    const value = children[index + 1];
    const name = key?.textContent ?? '';
    if (key?.tagName !== 'key' || childElements(key).length > 0
      || value === undefined || name.length === 0
      || entries.has(name)) {
      throw new Error(`Existing ios project ${label} Info.plist is malformed.`);
    }
    assertPlistValue(value, label);
    entries.set(name, value);
  }
  return entries;
}

function assertPlistValue(value: Element, label: string): void {
  if (value.tagName === 'dict') {
    parsePlistEntries(value, label);
    return;
  }
  if (value.tagName === 'array') {
    if (hasNonWhitespaceText(value)) {
      throw new Error(`Existing ios project ${label} Info.plist is malformed.`);
    }
    for (const child of childElements(value)) {
      assertPlistValue(child, label);
    }
    return;
  }
  if (childElements(value).length === 0) {
    const text = value.textContent ?? '';
    if (value.tagName === 'string') {
      return;
    }
    if (value.tagName === 'integer' && /^-?\d+$/u.test(text)) {
      return;
    }
    if (value.tagName === 'real'
      && /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u.test(text)
      && Number.isFinite(Number(text))) {
      return;
    }
    if (value.tagName === 'date'
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(text)
      && Number.isFinite(Date.parse(text))) {
      return;
    }
    if (value.tagName === 'data'
      && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u
        .test(text.replace(/\s+/gu, ''))) {
      return;
    }
    if ((value.tagName === 'true' || value.tagName === 'false') && text === '') {
      return;
    }
  }
  throw new Error(`Existing ios project ${label} Info.plist has an unsupported value node.`);
}

function hasNonWhitespaceText(element: Element): boolean {
  return Array.from(element.childNodes).some((node) =>
    (node.nodeType === 3 || node.nodeType === 4)
    && (node.textContent?.trim().length ?? 0) > 0);
}

function assertReferencedIosFiles(
  nativeDirectory: string,
  project: string,
  infoRelative: string,
): Set<string> {
  const compiledSources = assertAppBuildPhaseInputs(nativeDirectory, project);
  const references: readonly [RegExp, string][] = [
    [/\/\*\s*SceneDelegate\.swift in Sources\s*\*\//u, 'App/App/SceneDelegate.swift'],
    [/\/\*\s*Main\.storyboard in Resources\s*\*\//u, 'App/App/Base.lproj/Main.storyboard'],
    [
      /\/\*\s*LaunchScreen\.storyboard in Resources\s*\*\//u,
      'App/App/Base.lproj/LaunchScreen.storyboard',
    ],
    [/\/\*\s*Assets\.xcassets in Resources\s*\*\//u, 'App/App/Assets.xcassets/Contents.json'],
  ];
  for (const [marker, relative] of references) {
    if (marker.test(project) && !isNativeFile(nativeDirectory, relative)) {
      throw new Error(
        `Existing ios project is incomplete; referenced app file ${relative} is missing.`,
      );
    }
  }
  const info = readFileSync(path.join(nativeDirectory, infoRelative), 'utf8');
  assertSceneDelegateFiles(nativeDirectory, info, 'Release', compiledSources);
  return compiledSources;
}

function assertAppBuildPhaseInputs(nativeDirectory: string, project: string): Set<string> {
  const parentGroups = readPbxParentGroups(project);
  const compiledSources = new Set<string>();
  const targetId = readIosAppTargetId(project);
  assertNoIosTargetScriptPhases(project, targetId, new Set());
  const target = readPbxObjectBody(project, targetId);
  const phaseIds = readPbxIds(target, 'buildPhases');
  for (const phaseId of phaseIds) {
    const phase = readPbxObjectBody(project, phaseId);
    if (/\bisa\s*=\s*PBXShellScriptBuildPhase\s*;/u.test(phase)) {
      throw new Error('Existing ios project App shell script build phases are unsupported.');
    }
    const isSources = /\bisa\s*=\s*PBXSourcesBuildPhase\s*;/u.test(phase);
    if (!isSources && !/\bisa\s*=\s*PBXResourcesBuildPhase\s*;/u.test(phase)) {
      continue;
    }
    for (const buildId of readPbxIds(phase, 'files')) {
      const build = readPbxObjectBody(project, buildId);
      const referenceId = /\bfileRef\s*=\s*([A-F0-9]+)\b/u.exec(build)?.[1];
      if (referenceId === undefined) {
        throw new Error('Existing ios project App build input has no file reference.');
      }
      const files = assertPbxFileReference(nativeDirectory, project, referenceId, parentGroups);
      if (isSources) {
        files.forEach((file) => compiledSources.add(file));
      }
    }
  }
  return compiledSources;
}

function assertNoIosTargetScriptPhases(
  project: string,
  targetId: string,
  visited: Set<string>,
): void {
  if (visited.has(targetId)) {
    return;
  }
  visited.add(targetId);
  const target = readPbxObjectBody(project, targetId);
  if (!/\bisa\s*=\s*PBX(?:Native|Aggregate)Target\s*;/u.test(target)) {
    throw new Error('Existing ios project App target dependency is unsupported.');
  }
  if (readPbxIds(target, 'buildRules').length > 0) {
    throw new Error('Existing ios project App executable build rules are unsupported.');
  }
  for (const phaseId of readPbxIds(target, 'buildPhases')) {
    const phase = readPbxObjectBody(project, phaseId);
    if (/\bisa\s*=\s*PBXShellScriptBuildPhase\s*;/u.test(phase)) {
      throw new Error('Existing ios project App shell script build phases are unsupported.');
    }
  }
  for (const dependencyId of readPbxIds(target, 'dependencies')) {
    const dependency = readPbxObjectBody(project, dependencyId);
    const childId = /\btarget\s*=\s*([A-F0-9]+)\b/u.exec(dependency)?.[1];
    if (!/\bisa\s*=\s*PBXTargetDependency\s*;/u.test(dependency)
      || childId === undefined) {
      throw new Error('Existing ios project App target dependency is unsupported.');
    }
    assertNoIosTargetScriptPhases(project, childId, visited);
  }
}

function readPbxObjectBody(project: string, id: string): string {
  const marker = new RegExp(`\\b${id}\\s*(?:/\\*[^*]*\\*/)?\\s*=\\s*\\{([\\s\\S]*?)\\};`, 'u');
  const body = marker.exec(project)?.[1];
  if (body === undefined) {
    throw new Error(`Existing ios project build object ${id} is missing.`);
  }
  return body;
}

function readPbxIds(object: string, key: string): string[] {
  const list = new RegExp(`\\b${key}\\s*=\\s*\\(([^)]*)\\)\\s*;`, 'u').exec(object)?.[1];
  const uncommented = list?.replace(/\/\*[\s\S]*?\*\//gu, '') ?? '';
  return [...uncommented.matchAll(/\b([A-F0-9]{8,24})\b/gu)]
    .map((match) => match[1] ?? '');
}

function readPbxParentGroups(project: string): Map<string, string> {
  const parents = new Map<string, string>();
  const groupObjectPattern = /\b([A-F0-9]+)\s*(?:\/\*[^*]*\*\/)?\s*=\s*\{([\s\S]*?)\};/gu;
  const objects = project.matchAll(groupObjectPattern);
  for (const match of objects) {
    const id = match[1] ?? '';
    const body = match[2] ?? '';
    if (!/\bisa\s*=\s*PBX(?:Variant)?Group\s*;/u.test(body)) {
      continue;
    }
    for (const child of readPbxIds(body, 'children')) {
      if (parents.has(child)) {
        throw new Error(`Existing ios project build input ${child} has ambiguous groups.`);
      }
      parents.set(child, id);
    }
  }
  return parents;
}

function readPbxGroupPath(
  project: string,
  parents: Map<string, string>,
  referenceId: string,
): string | undefined {
  const chain: string[] = [];
  const seen = new Set<string>();
  let parent = parents.get(referenceId);
  if (parent === undefined) {
    return undefined;
  }
  while (parent !== undefined) {
    if (seen.has(parent)) {
      throw new Error('Existing ios project build input group cycle is unsupported.');
    }
    seen.add(parent);
    chain.unshift(parent);
    parent = parents.get(parent);
  }
  const parts: string[] = [];
  for (const groupId of chain) {
    const group = readPbxObjectBody(project, groupId);
    const sourceTree = /\bsourceTree\s*=\s*(?:"([^"]+)"|([^;]+))\s*;/u.exec(group);
    const tree = (sourceTree?.[1] ?? sourceTree?.[2])?.trim();
    if (tree === 'SOURCE_ROOT') {
      parts.length = 0;
    } else if (tree !== undefined && tree !== '<group>') {
      throw new Error('Existing ios project build input group sourceTree is unsupported.');
    }
    const groupPath = /\bpath\s*=\s*(?:"([^"]+)"|([^;]+))\s*;/u.exec(group);
    const value = (groupPath?.[1] ?? groupPath?.[2])?.trim();
    if (value !== undefined) {
      if (value.includes('$') || path.isAbsolute(value)) {
        throw new Error('Existing ios project build input group path is unsupported.');
      }
      parts.push(value);
    }
  }
  return parts.join('/');
}

function assertPbxFileReference(
  nativeDirectory: string,
  project: string,
  referenceId: string,
  parentGroups: Map<string, string>,
): string[] {
  const reference = readPbxObjectBody(project, referenceId);
  if (/\bisa\s*=\s*PBXVariantGroup\s*;/u.test(reference)) {
    const files: string[] = [];
    for (const child of readPbxIds(reference, 'children')) {
      files.push(...assertPbxFileReference(nativeDirectory, project, child, parentGroups));
    }
    return files;
  }
  if (!/\bisa\s*=\s*PBXFileReference\s*;/u.test(reference)) {
    throw new Error('Existing ios project App build input has an unsupported file reference.');
  }
  const relative = /\bpath\s*=\s*(?:"([^"]+)"|([^;]+))\s*;/u.exec(reference);
  const filePath = (relative?.[1] ?? relative?.[2])?.trim();
  if (filePath === undefined || filePath.includes('$') || path.isAbsolute(filePath)) {
    throw new Error('Existing ios project App build input path is unsupported.');
  }
  if (filePath === 'public' || filePath === 'capacitor.config.json') {
    return []; // cap sync creates these inputs in the staged shell.
  }
  const sourceTree = /\bsourceTree\s*=\s*(?:"([^"]+)"|([^;]+))\s*;/u.exec(reference);
  const tree = (sourceTree?.[1] ?? sourceTree?.[2])?.trim();
  if (tree !== undefined && tree !== '<group>' && tree !== 'SOURCE_ROOT') {
    throw new Error('Existing ios project App build input sourceTree is unsupported.');
  }
  const groupPath = readPbxGroupPath(project, parentGroups, referenceId);
  let candidates: string[];
  if (tree === 'SOURCE_ROOT') {
    candidates = [`App/${filePath}`];
  } else if (groupPath === undefined) {
    candidates = [`App/App/${filePath}`, `App/${filePath}`];
  } else {
    candidates = [`App/${groupPath}/${filePath}`];
  }
  const resolved = candidates.find((candidate) => isNativeEntry(nativeDirectory, candidate));
  if (resolved === undefined) {
    throw new Error(`Existing ios project App build input ${filePath} is missing.`);
  }
  return [resolved];
}

function isNativeEntry(directory: string, relative: string): boolean {
  const file = path.resolve(directory, relative);
  const within = path.relative(directory, file);
  if (within === '' || within.startsWith('..') || path.isAbsolute(within)) {
    return false;
  }
  let current = directory;
  for (const segment of within.split(path.sep)) {
    current = path.join(current, segment);
    if (!existsSync(current) || lstatSync(current).isSymbolicLink()) {
      return false;
    }
  }
  return lstatSync(file).isFile() || lstatSync(file).isDirectory();
}

function assertSceneDelegateFiles(
  nativeDirectory: string,
  source: string,
  label: string,
  compiledSources: Set<string>,
): void {
  const values = parsePlistDictionary(source, label);
  const delegates: string[] = [];
  const visit = (value: Element): void => {
    if (value.tagName === 'dict') {
      for (const [key, child] of parsePlistEntries(value, label)) {
        if (key === 'UISceneDelegateClassName') {
          if (child.tagName !== 'string') {
            throw new Error(`Existing ios project ${label} scene delegate is invalid.`);
          }
          delegates.push(child.textContent ?? '');
        } else {
          visit(child);
        }
      }
    } else if (value.tagName === 'array') {
      childElements(value).forEach(visit);
    }
  };
  [...values.values()].forEach(visit);
  const sources = listNativeFiles(nativeDirectory, 'App/App', '.swift');
  for (const delegate of delegates) {
    const className = /^(?:\$\(PRODUCT_MODULE_NAME\)|[A-Za-z_]\w*)\.([A-Za-z_]\w*)$/u
      .exec(delegate)?.[1];
    if (className === undefined || !sources.some((relative) => {
      if (!compiledSources.has(relative)) {
        return false;
      }
      const text = stripSourceCommentsAndStrings(
        readFileSync(path.join(nativeDirectory, relative), 'utf8'),
      );
      return hasUsableTopLevelSwiftSceneDelegate(text, className);
    })) {
      throw new Error(
        `Existing ios project ${label} scene delegate ${delegate} is missing from App Sources.`,
      );
    }
  }
}

function hasUsableTopLevelSwiftSceneDelegate(source: string, className: string): boolean {
  const declaration = new RegExp(`\\bclass\\s+${className}\\b([^{};]*)\\{`, 'gu');
  let cursor = 0;
  let depth = 0;
  for (const match of source.matchAll(declaration)) {
    const index = match.index ?? 0;
    for (; cursor < index; cursor += 1) {
      depth += source[cursor] === '{' ? 1 : source[cursor] === '}' ? -1 : 0;
    }
    const inheritance = match[1] ?? '';
    const supported = /:\s*(?:UIResponder|NSObject)\s*,\s*(?:UIWindowSceneDelegate|UISceneDelegate)(?:\s*,|\s*$)/u
      .test(inheritance.trim());
    if (depth === 0 && supported) {
      return true;
    }
  }
  return false;
}

function assertAndroidManifestResources(nativeDirectory: string): void {
  const manifestFiles = ['main', 'release']
    .map((sourceSet) => path.join(nativeDirectory, `app/src/${sourceSet}/AndroidManifest.xml`))
    .filter((file) => existsSync(file));
  const resourceRoots = ['main', 'release']
    .map((sourceSet) => path.join(nativeDirectory, `app/src/${sourceSet}/res`));
  const references = manifestFiles.flatMap((file) => {
    const manifest = readFileSync(file, 'utf8').replace(/<!--[\s\S]*?-->/gu, '');
    return [...manifest.matchAll(/(?<![\w+])@([a-z]+)\/([A-Za-z_][A-Za-z0-9_.]*)/gu)];
  });
  for (const reference of references) {
    const type = reference[1] ?? '';
    const name = reference[2] ?? '';
    const found = resourceRoots.some((resourceRoot) => {
      if (!existsSync(resourceRoot)) {
        return false;
      }
      const folders = readdirSync(resourceRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory()).map((entry) => entry.name);
      return folders.some((folder) => {
        const densityFallback = (type === 'mipmap' || type === 'drawable')
          && new RegExp(`^${type}-(?:ldpi|mdpi|hdpi|xhdpi|xxhdpi|xxxhdpi|nodpi|anydpi)$`, 'u')
            .test(folder);
        if (folder === type || densityFallback) {
          return readdirSync(path.join(resourceRoot, folder)).some((file) =>
            file === `${name}.xml` || file.startsWith(`${name}.`));
        }
        if (folder !== 'values') {
          return false;
        }
        return readdirSync(path.join(resourceRoot, folder)).some((file) =>
          file.endsWith('.xml') && readAndroidValueResource(
            path.join(resourceRoot, folder, file), type, name,
          ).length > 0);
      });
    });
    if (!found) {
      throw new Error(`Existing android project manifest resource @${type}/${name} is missing.`);
    }
  }
}

function smokeInfoPlist(displayName: string): string {
  const name = displayName.replace(/&/gu, '&amp;').replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;').replace(/"/gu, '&quot;').replace(/'/gu, '&apos;');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    '<key>CFBundleDisplayName</key>', `<string>${name}</string>`,
    '<key>CFBundleExecutable</key><string>$(EXECUTABLE_NAME)</string>',
    '<key>CFBundleIdentifier</key><string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>',
    '<key>CFBundleName</key><string>$(PRODUCT_NAME)</string>',
    '<key>CFBundlePackageType</key><string>APPL</string>',
    '<key>CFBundleShortVersionString</key><string>$(MARKETING_VERSION)</string>',
    '<key>CFBundleVersion</key><string>$(CURRENT_PROJECT_VERSION)</string>',
    '<key>UIApplicationSceneManifest</key><dict>',
    '<key>UIApplicationSupportsMultipleScenes</key><false/>',
    '<key>UISceneConfigurations</key><dict>',
    '<key>UIWindowSceneSessionRoleApplication</key><array><dict>',
    '<key>UISceneConfigurationName</key><string>Default Configuration</string>',
    '<key>UISceneDelegateClassName</key><string>$(PRODUCT_MODULE_NAME).SceneDelegate</string>',
    '</dict></array></dict></dict>',
    '<key>UILaunchScreen</key><dict/>',
    '</dict></plist>',
    '',
  ].join('\n');
}

function assertAppliedGradleScripts(
  nativeDirectory: string,
  script: string,
  visited: Set<string>,
  inspectedScripts: Set<string>,
  isSettingsScript: boolean,
  ownerDirectory: string,
): void {
  const visitKey = `${ownerDirectory}\0${isSettingsScript}\0${script}`;
  if (visited.has(visitKey)) {
    return;
  }
  visited.add(visitKey);
  inspectedScripts.add(script);
  if (!isNativeFile(nativeDirectory, script)) {
    throw new Error(
      `Existing android project is incomplete; applied Gradle script ${script} is missing.`,
    );
  }
  const source = stripGradleComments(readFileSync(path.join(nativeDirectory, script), 'utf8'));
  const code = maskGradleStrings(source);
  if (/(?:^|[\s;{])apply\s*\{/u.test(code)) {
    throw new Error('Existing android project has an unsupported Gradle apply expression.');
  }
  if (isSettingsScript) {
    assertAndroidSettingsNoAppRemap(source);
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
      // Gradle resolves nested script paths against the owning project or settings directory.
      const resolved = path.resolve(ownerDirectory, requested);
      const relative = path.relative(nativeDirectory, resolved);
      if (requested.includes('$') || relative === '' || relative.startsWith('..')
        || path.isAbsolute(relative)) {
        throw new Error('Existing android project has an unsupported applied Gradle script path.');
      }
      assertAppliedGradleScripts(
        nativeDirectory,
        relative,
        visited,
        inspectedScripts,
        isSettingsScript,
        ownerDirectory,
      );
    }
  }
  const applyExpressions = [/\bapply\s+from\s*:/gu, /\bapply\s*\(/gu];
  if (applyExpressions.some((expression) => [...source.matchAll(expression)]
    .some((match) => match.index !== undefined
      && code.slice(match.index, match.index + 5) === 'apply'
      && !matched.has(match.index)))) {
    throw new Error('Existing android project has an unsupported Gradle apply expression.');
  }
}

function assertNativeDisplayName(
  nativeDirectory: string,
  platform: 'android' | 'ios',
  expectedDisplayName: string,
  iosInfoRelative?: string,
): void {
  const relative = iosInfoRelative ?? 'App/App/Info.plist';
  if (platform === 'ios' && !isNativeFile(nativeDirectory, relative)) {
    throw new Error(
      `Existing ${platform} project is incomplete; native display name resource is missing.`,
    );
  }
  const source = platform === 'ios'
    ? readFileSync(path.join(nativeDirectory, relative), 'utf8')
    : '';
  const labels = platform === 'ios'
    ? [parsePlistDictionary(source, 'Release').get('CFBundleDisplayName')]
      .filter((value) => value?.tagName === 'string')
      .map((value) => value?.textContent ?? '')
    : [];
  if (platform === 'ios' && (labels.length !== 1 || labels[0] !== expectedDisplayName)) {
    throw new Error(`Existing ${platform} project display name differs or cannot be read safely.`);
  }
  if (platform === 'android') {
    const main = readAndroidApplication(
      path.join(nativeDirectory, 'app/src/main/AndroidManifest.xml'),
    );
    if (main === undefined) {
      throw new Error('Existing android project application label is missing.');
    }
    const label = main.getAttribute('android:label');
    if (label === null) {
      throw new Error('Existing android project application label is missing.');
    }
    const effective = resolveAndroidLabel(nativeDirectory, label);
    if (effective !== expectedDisplayName) {
      throw new Error(
        'Existing android project application label differs from the requested name.',
      );
    }
    const launchers = readAndroidLaunchers(main);
    for (const launcher of launchers) {
      const launcherLabel = launcher.getAttribute('android:label');
      if (launcherLabel !== null
        && resolveAndroidLabel(nativeDirectory, launcherLabel) !== expectedDisplayName) {
        throw new Error('Existing android project launcher label differs from the requested name.');
      }
    }
    const overlayFile = path.join(nativeDirectory, 'app/src/release/AndroidManifest.xml');
    if (existsSync(overlayFile)) {
      const release = readAndroidApplication(overlayFile, false);
      if (release !== undefined) {
        if (hasAndroidMergerDirective(release)) {
          throw new Error('Existing android Release manifest changes the application node.');
        }
        const releaseLabel = release.getAttribute('android:label');
        if (releaseLabel !== null
          && resolveAndroidLabel(nativeDirectory, releaseLabel) !== expectedDisplayName) {
          throw new Error(
            'Existing android Release application label differs from the requested name.',
          );
        }
        const appBuildFile = ['app/build.gradle', 'app/build.gradle.kts']
          .map((relative) => path.join(nativeDirectory, relative))
          .find((file) => existsSync(file));
        const appGradle = appBuildFile === undefined ? '' : readFileSync(appBuildFile, 'utf8');
        const manifestPackage = (main.parentNode as Element | null)?.getAttribute('package');
        const namespace = /\bnamespace\s*(?:=\s*)?["']([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)+)["']/u
          .exec(stripGradleComments(appGradle))?.[1]
          ?? (manifestPackage === null || manifestPackage === '' ? undefined : manifestPackage);
        const launcherNames = new Set<string>();
        for (const launcher of launchers) {
          const qualified = qualifyAndroidActivityName(
            launcher.getAttribute('android:name'),
            namespace,
          );
          if (qualified !== undefined) {
            launcherNames.add(qualified);
          }
        }
        const releaseLaunchers = readAndroidLaunchers(release);
        for (const activity of childElements(release)) {
          if (activity.tagName !== 'activity' && activity.tagName !== 'activity-alias') {
            continue;
          }
          const releaseName = qualifyAndroidActivityName(
            activity.getAttribute('android:name'),
            namespace,
          );
          const sameLauncher = releaseName !== undefined && launcherNames.has(releaseName);
          const activityLabel = activity.getAttribute('android:label');
          if (sameLauncher && activity.tagName === 'activity-alias'
            && activity.hasAttribute('android:targetActivity')) {
            throw new Error(
              'Existing android Release launcher alias target override is unsupported.',
            );
          }
          if ((sameLauncher || releaseLaunchers.includes(activity))
            && hasAndroidMergerDirectiveDeep(activity)) {
            throw new Error('Existing android Release manifest changes a launcher node.');
          }
          if (sameLauncher || releaseLaunchers.includes(activity)) {
            assertAndroidLauncherEnabled(activity, 'Release launcher');
          }
          if ((sameLauncher || releaseLaunchers.includes(activity)) && activityLabel !== null
            && resolveAndroidLabel(nativeDirectory, activityLabel) !== expectedDisplayName) {
            throw new Error(
              'Existing android Release launcher label differs from the requested name.',
            );
          }
        }
      }
    }
  }
}

export function assertAndroidReleaseDisplayName(
  shellApp: string,
  expectedDisplayName: string,
): void {
  const nativeDirectory = path.join(shellApp, 'android');
  assertAndroidManifestResources(nativeDirectory);
  assertNativeDisplayName(nativeDirectory, 'android', expectedDisplayName);
}

export function assertAndroidReleaseLauncherIntegrity(shellApp: string): void {
  const nativeDirectory = path.join(shellApp, 'android');
  const gradleRelative = requireOneNativeFile(
    nativeDirectory,
    ['app/build.gradle', 'app/build.gradle.kts'],
    'android',
  );
  const gradle = readFileSync(path.join(nativeDirectory, gradleRelative), 'utf8');
  assertAndroidLauncherClasses(nativeDirectory, gradle);
}

export function assertIosReleaseDisplayName(
  shellApp: string,
  expectedDisplayName: string,
): void {
  const nativeDirectory = path.join(shellApp, 'ios');
  const projectFile = path.join(nativeDirectory, 'App/App.xcodeproj/project.pbxproj');
  const project = readFileSync(projectFile, 'utf8');
  const infoRelative = path.join('App', readIosReleaseInfoPlist(project));
  if (!isNativeFile(nativeDirectory, infoRelative)) {
    throw new Error('Existing ios project Release Info.plist is missing or unsafe.');
  }
  assertNativeDisplayName(nativeDirectory, 'ios', expectedDisplayName, infoRelative);
  assertNoIosLocalizedDisplayNameOverride(nativeDirectory, project);
  assertReferencedIosFiles(nativeDirectory, project, infoRelative);
}

function assertNoIosLocalizedDisplayNameOverride(
  nativeDirectory: string,
  project: string,
): void {
  const files = listNativeFiles(nativeDirectory, 'App/App', '.strings');
  if (/\bInfoPlist\.strings\b/u.test(project)
    || isNativeFile(nativeDirectory, 'App/InfoPlist.strings')
    || files.some((relative) => path.basename(relative) === 'InfoPlist.strings')) {
    throw new Error('Existing ios project localized InfoPlist.strings overrides are unsupported.');
  }
}

export function assertIosArchiveScheme(shellApp: string): void {
  const nativeDirectory = path.join(shellApp, 'ios');
  const projectRelative = 'App/App.xcodeproj/project.pbxproj';
  const schemeRelative = 'App/App.xcodeproj/xcshareddata/xcschemes/App.xcscheme';
  if (!isNativeFile(nativeDirectory, projectRelative)
    || !isNativeFile(nativeDirectory, schemeRelative)) {
    throw new Error('Existing ios project shared App archive scheme is missing or unsafe.');
  }
  const project = readFileSync(path.join(nativeDirectory, projectRelative), 'utf8');
  const appTargetId = readIosAppTargetId(project);
  const schemeSource = readFileSync(path.join(nativeDirectory, schemeRelative), 'utf8');
  const scheme = parseXml(schemeSource, 'ios project App archive scheme').documentElement;
  if (scheme?.tagName !== 'Scheme') {
    throw new Error('Existing ios project App archive scheme is malformed.');
  }
  const actions = childElements(scheme);
  const build = actions.filter((item) => item.tagName === 'BuildAction');
  const archive = actions.filter((item) => item.tagName === 'ArchiveAction');
  const entryGroups = build.length === 1
    ? childElements(build[0] as Element)
      .filter((item) => item.tagName === 'BuildActionEntries')
    : [];
  const entries = entryGroups.length === 1
    ? childElements(entryGroups[0] as Element)
      .filter((item) => item.tagName === 'BuildActionEntry'
        && item.getAttribute('buildForArchiving') === 'YES')
    : [];
  const references = entries.length === 1 ? childElements(entries[0] as Element) : [];
  const reference = references.length === 1 ? references[0] : undefined;
  const hasSchemeActions = (element: Element): boolean => childElements(element).some((item) =>
    item.tagName === 'PreActions' || item.tagName === 'PostActions' || hasSchemeActions(item));
  if ((build[0] !== undefined && hasSchemeActions(build[0]))
    || (archive[0] !== undefined && hasSchemeActions(archive[0]))) {
    throw new Error('Existing ios project App archive scheme actions are unsupported.');
  }
  if (archive.length !== 1 || archive[0]?.getAttribute('buildConfiguration') !== 'Release'
    || reference?.tagName !== 'BuildableReference'
    || reference.getAttribute('BlueprintIdentifier') !== appTargetId
    || reference.getAttribute('BlueprintName') !== 'App'
    || reference.getAttribute('BuildableName') !== 'App.app'
    || reference.getAttribute('ReferencedContainer') !== 'container:App.xcodeproj') {
    throw new Error('Existing ios App archive scheme does not select the App target.');
  }
}

function hasAndroidMergerDirective(element: Element): boolean {
  return ['tools:node', 'tools:remove', 'tools:replace']
    .some((attribute) => element.hasAttribute(attribute));
}

function hasAndroidMergerDirectiveDeep(element: Element): boolean {
  return hasAndroidMergerDirective(element)
    || childElements(element).some(hasAndroidMergerDirectiveDeep);
}

function readAndroidApplication(file: string, required = true): Element | undefined {
  const root = parseXml(readFileSync(file, 'utf8'), 'android manifest').documentElement;
  const application = root === null
    ? undefined
    : childElements(root).find((element) => element.tagName === 'application');
  if (root?.tagName !== 'manifest' || (required && application === undefined)) {
    throw new Error('Existing android project manifest application is missing.');
  }
  return application;
}

function readAndroidLaunchers(application: Element): Element[] {
  return childElements(application).filter((activity) => {
    if (activity.tagName !== 'activity' && activity.tagName !== 'activity-alias') {
      return false;
    }
    return childElements(activity).some((filter) => filter.tagName === 'intent-filter'
      && childElements(filter).some((item) => item.tagName === 'action'
        && item.getAttribute('android:name') === 'android.intent.action.MAIN')
      && childElements(filter).some((item) => item.tagName === 'category'
        && item.getAttribute('android:name') === 'android.intent.category.LAUNCHER'));
  });
}

function resolveAndroidLabel(nativeDirectory: string, label: string): string {
  if (label.startsWith('@string/')) {
    return readAndroidString(nativeDirectory, label.slice('@string/'.length));
  }
  if (label.startsWith('@')) {
    throw new Error('Existing android project application label resource is unsupported.');
  }
  return label;
}

function readAndroidString(nativeDirectory: string, key: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
    throw new Error('Existing android project application label is unsupported.');
  }
  const overlay = path.join(nativeDirectory, 'app/src/release/res/values');
  const overlayValues = existsSync(overlay) && lstatSync(overlay).isDirectory()
    ? readdirSync(overlay).filter((file) => file.endsWith('.xml'))
      .flatMap((file) => readAndroidValueResource(path.join(overlay, file), 'string', key))
    : [];
  const main = path.join(nativeDirectory, 'app/src/main/res/values');
  const mainValues = existsSync(main) && lstatSync(main).isDirectory()
    ? readdirSync(main).filter((file) => file.endsWith('.xml'))
      .flatMap((file) => readAndroidValueResource(path.join(main, file), 'string', key))
    : [];
  const values = overlayValues.length > 0 ? overlayValues : mainValues;
  if (values.length !== 1) {
    throw new Error('Existing android project application label resource is missing or ambiguous.');
  }
  const qualified = ['main', 'release'].flatMap((sourceSet) =>
    listNativeFiles(nativeDirectory, `app/src/${sourceSet}/res`, '.xml')
      .filter((relative) => /^values-[^/]+$/u.test(path.basename(path.dirname(relative))))
      .flatMap((relative) => readAndroidValueResource(
        path.join(nativeDirectory, relative),
        'string',
        key,
      )));
  if (qualified.some((value) => value !== values[0])) {
    throw new Error('Existing android project configuration-qualified application label differs.');
  }
  return values[0] ?? '';
}

function readAndroidValueResource(file: string, type: string, name: string): string[] {
  const root = parseXml(readFileSync(file, 'utf8'), 'android values resource').documentElement;
  if (root?.tagName !== 'resources') {
    throw new Error('Existing android values resource is malformed.');
  }
  return childElements(root)
    .filter((element) => (element.tagName === type
      || element.tagName === 'item' && element.getAttribute('type') === type)
      && element.getAttribute('name') === name)
    .map((element) => type === 'string'
      ? decodeAndroidStringResource(element.textContent ?? '')
      : (element.textContent ?? ''));
}

export function decodeAndroidStringResource(value: string): string {
  const trimmed = value.trim();
  const quoted = trimmed.startsWith('"') && trimmed.endsWith('"');
  const source = quoted ? trimmed.slice(1, -1) : trimmed;
  let decoded = '';
  let unquotedWhitespace = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? '';
    if (character !== '\\') {
      if (!quoted && /\s/u.test(character)) {
        if (!unquotedWhitespace) {
          decoded += ' ';
        }
        unquotedWhitespace = true;
      } else {
        decoded += character;
        unquotedWhitespace = false;
      }
      continue;
    }
    unquotedWhitespace = false;
    const next = source[index + 1];
    if (next === 'u' && /^[0-9a-fA-F]{4}$/u.test(source.slice(index + 2, index + 6))) {
      decoded += String.fromCharCode(Number.parseInt(source.slice(index + 2, index + 6), 16));
      index += 5;
      continue;
    }
    const escapes: Record<string, string> = {
      n: '\n',
      r: '\r',
      t: '\t',
      '\\': '\\',
      "'": "'",
      '"': '"',
      '@': '@',
      '?': '?',
      ' ': ' ',
    };
    if (next === undefined || !Object.hasOwn(escapes, next)) {
      throw new Error('Existing android string resource has an unsupported escape.');
    }
    decoded += escapes[next] ?? '';
    index += 1;
  }
  return decoded;
}

function decodeXmlLabel(value: string): string {
  const trimmed = value.trim();
  let unsupported = false;
  const decoded = trimmed.replace(/&([^;]+);/gu,
    (_match, entity: string) => {
      const named: Record<string, string> = {
        amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
      };
      if (entity.startsWith('#')) {
        const point = entity[1]?.toLowerCase() === 'x'
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
        if (Number.isInteger(point) && point > 0 && point <= 0x10ffff
          && !(point >= 0xd800 && point <= 0xdfff)) {
          return String.fromCodePoint(point);
        }
      }
      if (Object.hasOwn(named, entity)) {
        return named[entity] ?? '';
      }
      unsupported = true;
      return '';
    });
  if (unsupported || trimmed.replace(/&[^;]+;/gu, '').includes('&')) {
    throw new Error('Existing native display name contains an unsupported XML entity.');
  }
  return decoded;
}

function requireOneNativeFile(
  directory: string,
  candidates: readonly string[],
  platform: 'android' | 'ios',
): string {
  const present = candidates.filter((relative) => isNativeFile(directory, relative));
  if (present.length !== 1) {
    throw new Error(
      `Existing ${platform} project is incomplete or ambiguous: ${candidates.join(', ')}.`,
    );
  }
  return present[0] ?? '';
}

function isNativeFile(directory: string, relative: string): boolean {
  const file = path.resolve(directory, relative);
  const within = path.relative(directory, file);
  if (within === '' || within.startsWith('..') || path.isAbsolute(within)) {
    return false;
  }
  let current = directory;
  for (const segment of within.split(path.sep)) {
    current = path.join(current, segment);
    if (!existsSync(current) || lstatSync(current).isSymbolicLink()) {
      return false;
    }
  }
  return lstatSync(file).isFile();
}

function runCommand(command: string, args: readonly string[], cwd: string): void {
  const resolvedCommand = process.platform === 'win32' && command === 'pnpm' ? 'pnpm.cmd' : command;
  const result = spawnSync(resolvedCommand, [...args], {
    cwd,
    stdio: 'inherit',
    env: process.env,
    shell: process.platform === 'win32',
    timeout: 600_000,
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed. The shell files remain for a safe retry.`,
    );
  }
}

function assertCompatibleExistingPackage(
  source: string,
  capacitorVersion: string,
  appVersion: string,
  pluginVersion: string,
  typescriptVersion: string,
): void {
  const value = parseJsonObject(source, 'existing shell package');
  if (value.private !== true) {
    throw new Error('Existing Capacitor shell package must stay private.');
  }
  const dependencies = requireObject(value.dependencies, 'existing shell dependencies');
  for (const [name, version] of Object.entries({
    '@capacitor/android': capacitorVersion,
    '@capacitor/app': appVersion,
    '@capacitor/core': capacitorVersion,
    '@capacitor/ios': capacitorVersion,
    '@mpgd/capacitor-game-services': pluginVersion,
  })) {
    if (dependencies[name] !== version) {
      throw new Error(`Existing shell ${name} differs; refusing to rewrite dependencies.`);
    }
  }
  const scripts = requireObject(value.scripts, 'existing shell scripts');
  if (scripts.cap !== 'cap') {
    throw new Error('Existing shell must expose the standard cap script.');
  }
  const devDependencies = requireObject(value.devDependencies, 'existing shell dev dependencies');
  if (devDependencies['@capacitor/cli'] !== capacitorVersion
    || devDependencies.typescript !== typescriptVersion) {
    throw new Error('Existing shell must include the pinned Capacitor CLI and TypeScript.');
  }
}

function normalizeBackendUrl(value: string): string {
  if (value.includes('$')) {
    throw new Error('Backend URL cannot contain dotenv expansion syntax.');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Backend URL must be an absolute HTTPS URL.');
  }
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== ''
    || parsed.hash !== '' || parsed.search !== '') {
    throw new Error('Backend URL must be HTTPS without credentials, search, or fragment.');
  }
  if (isNonPublicServiceHostname(parsed.hostname)) {
    throw new Error('Backend URL must use a public HTTPS hostname for production.');
  }
  return parsed.href.replace(/\/$/u, '');
}

function readDotenvValue(source: string): string {
  const value = source.trim();
  if (!value.startsWith('"') && !value.startsWith("'")) {
    return value.split('#', 1)[0]?.trim() ?? '';
  }
  const quote = value[0];
  let closing = -1;
  for (let index = 1; index < value.length; index += 1) {
    if (value[index] === quote && value[index - 1] !== '\\') {
      closing = index;
      break;
    }
  }
  if (closing < 0 || (value.slice(closing + 1).trim() !== ''
    && !value.slice(closing + 1).trim().startsWith('#'))) {
    throw new Error('Production Game Services URL has malformed dotenv syntax.');
  }
  return value.slice(1, closing);
}

function readCapacitorConfigLiteral(source: string, key: 'appId' | 'appName' | 'webDir'):
  string | undefined {
  const expression = new RegExp(
    `^[ \\t]*${key}:[ \\t]*("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*')[ \\t]*,?[ \\t]*\\r?$`,
    'gmu',
  );
  const matches = [...source.matchAll(expression)];
  const literal = matches.length === 1 ? matches[0]?.[1] : undefined;
  if (literal === undefined) {
    return undefined;
  }
  if (literal.startsWith('"')) {
    try {
      return JSON.parse(literal) as string;
    } catch {
      return undefined;
    }
  }
  const body = literal.slice(1, -1);
  let value = '';
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (character !== '\\') {
      value += character;
      continue;
    }
    const escaped = body[++index];
    const replacements: Record<string, string> = {
      "'": "'",
      '"': '"',
      '\\': '\\',
      n: '\n',
      r: '\r',
      t: '\t',
    };
    if (escaped === undefined || !(escaped in replacements)) {
      return undefined;
    }
    value += replacements[escaped];
  }
  return value;
}

/** Refuse dynamic identity overrides; preserve the authored file without evaluating it. */
function requireStaticCapacitorConfig(source: string): string {
  let withoutComments = '';
  let codeOnly = '';
  for (let index = 0; index < source.length;) {
    const character = source[index];
    const next = source[index + 1];
    if (character === '`') {
      throw new Error('Existing Capacitor config has ambiguous dynamic syntax.');
    }
    if (character === '"' || character === "'") {
      const quote = character;
      const start = index;
      let closed = false;
      while (index < source.length) {
        const current = source[index] ?? '';
        withoutComments += current;
        codeOnly += current === '\n' ? '\n' : ' ';
        index += 1;
        if (current === '\\' && index < source.length) {
          withoutComments += source[index];
          codeOnly += ' ';
          index += 1;
        } else if (current === quote && index - 1 !== start) {
          closed = true;
          break;
        }
      }
      if (!closed) {
        throw new Error('Existing Capacitor config has an unterminated string.');
      }
      continue;
    }
    if (character === '/' && (next === '/' || next === '*')) {
      const block = next === '*';
      withoutComments += '  ';
      codeOnly += '  ';
      index += 2;
      while (index < source.length) {
        if (block && source[index] === '*' && source[index + 1] === '/') {
          withoutComments += '  ';
          codeOnly += '  ';
          index += 2;
          break;
        }
        if (!block && source[index] === '\n') {
          break;
        }
        const current = source[index] ?? '';
        const masked = current === '\n' ? '\n' : ' ';
        withoutComments += masked;
        codeOnly += masked;
        index += 1;
      }
      continue;
    }
    withoutComments += character;
    codeOnly += character;
    index += 1;
  }
  const configUses = [...codeOnly.matchAll(/\bconfig\b(?!\s*:)/gu)].length;
  const declaration = /\bconst\s+config\s*:\s*CapacitorConfig\s*=\s*\{/u.exec(codeOnly);
  if (declaration?.index === undefined) {
    throw new Error('Existing Capacitor config has ambiguous dynamic syntax.');
  }
  const opening = declaration.index + declaration[0].length - 1;
  const topLevelSource = maskNestedConfig(withoutComments, codeOnly, opening);
  const topLevelCode = maskNestedConfig(codeOnly, codeOnly, opening);
  const identityKeysAreUnique = (['appId', 'appName', 'webDir'] as const).every((key) =>
    [...topLevelCode.matchAll(new RegExp(`\\b${key}\\b`, 'gu'))].length === 1,
  );
  const hasComputedKey = /(?:\{|,)[ \t\n]*\[[^\]]*\][ \t\n]*:/u.test(topLevelCode);
  if (configUses !== 1 || topLevelCode.includes('...') || hasComputedKey
    || /\\u(?:[0-9a-fA-F]{4}|\{[0-9a-fA-F]+\})/u.test(topLevelCode)
    || !identityKeysAreUnique
    || /^[ \t]*["'](?:appId|appName|webDir)["'][ \t]*:/mu.test(topLevelSource)
    || !/\bexport\s+default\s+config\s*;/u.test(codeOnly)) {
    throw new Error('Existing Capacitor config has ambiguous dynamic syntax.');
  }
  assertNoCapacitorServerUrl(withoutComments, codeOnly, topLevelCode);
  return topLevelSource;
}

function assertNoCapacitorServerUrl(source: string, code: string, topLevel: string): void {
  if (/^[ \t]*["']server["']\s*:/mu.test(source)) {
    throw new Error('Existing Capacitor config server field is ambiguous.');
  }
  const quotedKeys = [...source.matchAll(/(?:\{|,)\s*(["'])((?:\\.|(?!\1)[^\\])*)\1\s*:/gu)];
  if (quotedKeys.some((match) => (match[2] ?? '').includes('\\'))) {
    throw new Error('Existing Capacitor config quoted property key is ambiguous.');
  }
  if (/\b(?:get|set)\s+server\s*\(/u.test(topLevel)
    || /(?:^|[,\s{])server\s*(?:,|\})/u.test(topLevel)) {
    throw new Error('Existing Capacitor config server field is dynamic.');
  }
  const server = /\bserver\s*:/u.exec(topLevel);
  if (server?.index === undefined) {
    return;
  }
  const afterColon = server.index + server[0].length;
  const opening = code.indexOf('{', afterColon);
  if (opening < 0 || code.slice(afterColon, opening).trim() !== '') {
    throw new Error('Existing Capacitor config server field is not a static object.');
  }
  let depth = 0;
  for (let index = opening; index < code.length; index += 1) {
    if (code[index] === '{') {
      depth += 1;
    } else if (code[index] === '}') {
      depth -= 1;
      if (depth === 0) {
        const body = source.slice(opening, index + 1);
        if (body.includes('...')
          || /\\u(?:[0-9a-fA-F]{4}|\{[0-9a-fA-F]+\})/u.test(body)
          || /(?:^|[,\s{])(?:get|set)\s+\w+\s*\(/u.test(body)
          || /(?:^|[,\s{])\[[^\]]+\]\s*:/u.test(body)) {
          throw new Error('Existing Capacitor config server field has dynamic properties.');
        }
        const bodyCode = code.slice(opening, index + 1);
        if (/(?:^|[,\s{])["']?url["']?\s*:/u.test(body)
          || /(?:^|[,\s{])url\s*(?:,|\})/u.test(bodyCode)) {
          throw new Error('Existing Capacitor config server.url is unsupported.');
        }
        return;
      }
    }
  }
  throw new Error('Existing Capacitor config server field is incomplete.');
}

function maskNestedConfig(source: string, code: string, opening: number): string {
  const output: string[] = source.split('').map((character) => character === '\n' ? '\n' : ' ');
  let depth = 0;
  for (let index = opening; index < code.length; index += 1) {
    const character = code[index];
    if (character === '{') {
      depth += 1;
      if (depth === 1) {
        output[index] = source[index] ?? ' ';
      }
    } else if (character === '}') {
      if (depth === 1) {
        output[index] = source[index] ?? ' ';
      }
      depth -= 1;
      if (depth === 0) {
        return output.join('');
      }
    } else if (depth === 1) {
      output[index] = source[index] ?? ' ';
    }
  }
  throw new Error('Existing Capacitor config object is incomplete.');
}

function appendEnvLine(current: string, line: string): string {
  const separator = current !== '' && !current.endsWith('\n') ? '\n' : '';
  return `${current}${separator}${line}\n`;
}

function relativeGameFile(gameRoot: string, file: string): string {
  const canonical = realpathSync(path.resolve(gameRoot, file));
  const relative = path.relative(gameRoot, canonical);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Icon source must be a game-owned file.');
  }
  if (!lstatSync(canonical).isFile()) {
    throw new Error('Icon source must be a file.');
  }
  return relative.split(path.sep).join('/');
}

function readExisting(file: string): string | undefined {
  if (!existsSync(file)) {
    return undefined;
  }
  assertNotSymlink(file);
  return readFileSync(file, 'utf8');
}

function assertNotSymlink(file: string): void {
  try {
    if (lstatSync(file).isSymbolicLink()) {
      throw new Error(`Refusing to write through a symbolic link: ${file}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}

function resolveInstalledPluginVersion(gameRoot: string, requirement: string): string {
  const adapterRoot = path.dirname(
    realpathSync(path.join(gameRoot, 'node_modules/@mpgd/adapter-capacitor/package.json')),
  );
  const installedPackage = path.join(
    adapterRoot,
    'node_modules/@mpgd/capacitor-game-services/package.json',
  );
  const fallbackPackage = path.join(
    gameRoot,
    'node_modules/@mpgd/capacitor-game-services/package.json',
  );
  const installedFile = existsSync(installedPackage) ? installedPackage : fallbackPackage;
  const installed = existsSync(installedFile)
    ? requireString(readJsonObject(installedFile).version, 'installed game-services plugin version')
    : undefined;
  const version = installed ?? requirement;
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new Error(
      'Install a concrete Capacitor game-services plugin before initializing the shell.',
    );
  }
  return version;
}

function readJsonObject(file: string): Record<string, unknown> {
  return parseJsonObject(readFileSync(file, 'utf8'), file);
}

function parseJsonObject(source: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error(`${label} must contain valid JSON.`);
  }
  return requireObject(parsed, label);
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
