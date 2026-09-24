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

import { isNonPublicServiceHostname } from './production-target-readiness.js';
import { assertNativeShellIdentity } from './native-shell-identity.js';

const shellPath = 'apps/mobile-capacitor';
const webPath = `${shellPath}/www`;
const referenceShellPath = '${MPGD_KIT_PATH}/apps/mobile-capacitor';
const providerIdPattern = /^[a-z][a-z0-9-]*$/u;
const appIdPattern = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*){2,}$/u;

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
  if (input.displayName.trim() !== input.displayName
    || input.displayName.length === 0 || input.displayName.length > 80) {
    throw new Error('Capacitor display name must be 1-80 characters without outer whitespace.');
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
    const validatedBackendUrl = normalizeBackendUrl(requestedBackendUrl);
    const envFile = path.join(gameRoot, '.env.production');
    const current = readExisting(envFile) ?? '';
    const definitions = [...current.matchAll(
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
  const files = requestedFiles.filter(
    (file) => readExisting(path.join(gameRoot, file.path)) !== file.content,
  );
  const nativePlatformsToAdd = (['android', 'ios'] as const).filter((platform) => {
    const nativeDirectory = path.join(gameRoot, shellPath, platform);
    if (!existsSync(nativeDirectory)) {
      return true;
    }
    assertNativePlatformComplete(gameRoot, platform, input.appId);
    return false;
  });
  return {
    gameRoot,
    files,
    changedFiles: files.map((file) => file.path),
    nativePlatformsToAdd,
  };
}

export function applyCapacitorShellStarter(
  plan: CapacitorShellStarterPlan,
  installStagedFile: (temporary: string, destination: string) => void = renameSync,
): void {
  const staged = plan.files.map((file) => {
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
    assertNativePlatformComplete(
      plan.gameRoot,
      platform,
      requireString(manifest.appId, 'shell app ID'),
    );
  }
}

function assertNativePlatformComplete(
  gameRoot: string,
  platform: 'android' | 'ios',
  expectedAppId: string,
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
    requireOneNativeFile(nativeDirectory, ['build.gradle', 'build.gradle.kts'], platform);
    requireOneNativeFile(nativeDirectory, ['settings.gradle', 'settings.gradle.kts'], platform);
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
    : ['App/App/AppDelegate.swift', 'App/App/Info.plist'];
  if (additional.some((relative) => !isNativeFile(nativeDirectory, relative))) {
    throw new Error(
      `Existing ${platform} project is incomplete; required native files are missing.`,
    );
  }
  if (platform === 'android') {
    const sourceRoots = ['java', 'kotlin'].map((language) =>
      path.join(nativeDirectory, 'app/src/main', language),
    );
    if (!sourceRoots.some((sourceRoot) => existsSync(sourceRoot)
      && readdirSync(sourceRoot, { recursive: true })
        .some((name) => typeof name === 'string'
          && /(?:^|[\\/])MainActivity\.(?:java|kt)$/u.test(name)))) {
      throw new Error('Existing android project is incomplete; MainActivity is missing.');
    }
  }
  const content = readFileSync(path.join(nativeDirectory, required), 'utf8');
  assertNativeShellIdentity(platform, content, expectedAppId);
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
  const file = path.join(directory, relative);
  return existsSync(file) && lstatSync(file).isFile();
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
  const configReferences = [...codeOnly.matchAll(/\bconfig\b/gu)].length;
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
  if (configReferences !== 2 || topLevelCode.includes('...') || hasComputedKey
    || !identityKeysAreUnique
    || /^[ \t]*["'](?:appId|appName|webDir)["'][ \t]*:/mu.test(topLevelSource)
    || !/\bexport\s+default\s+config\s*;/u.test(codeOnly)) {
    throw new Error('Existing Capacitor config has ambiguous dynamic syntax.');
  }
  return topLevelSource;
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
