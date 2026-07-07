import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';

import { assertReleaseManifest, type ReleaseManifest } from '@mpgd/release-manifest';

import { readJsonFile } from '../io';
import {
  assertEmbeddedTargetConfig,
  embeddedTargetConfigFileName,
  readEmbeddedTargetConfigFromDirectory,
  readEmbeddedTargetConfigFromFile,
  readEmbeddedTargetConfigFromZip,
  type EmbeddedTargetConfigEvidence,
} from './embedded-target-config';

interface SmokePlatformTargetConfig {
  readonly kind: 'web' | 'capacitor-android' | 'capacitor-ios' | 'apps-in-toss' | 'devvit-web';
  readonly gameApp: string;
  readonly adapter: string;
  readonly output?: string;
  readonly shellApp?: string;
  readonly wrapperApp?: string;
  readonly webDir?: string;
  readonly artifact?: string;
}

interface SmokePlatformTargetsConfig {
  readonly targets: Record<string, SmokePlatformTargetConfig>;
}

const platformTargetsFileEnv = 'MPGD_PLATFORM_TARGETS_FILE';
const releaseManifestFileEnv = 'MPGD_RELEASE_MANIFEST_FILE';

const loadedPlatformTargets = loadSmokePlatformTargetsConfig();
const configuredTargets = Object.keys(loadedPlatformTargets.config.targets);
const knownTargets = new Set<string>(configuredTargets);

export function verifyTargetArtifacts(targets: readonly string[] = configuredTargets): void {
  const manifest = readSmokeReleaseManifest(releaseManifestPath(loadedPlatformTargets.baseDir));

  for (const target of targets) {
    const entry = manifest.targets[target];
    const targetConfig = loadedPlatformTargets.config.targets[target];

    if (entry === undefined) {
      throw new Error(`Missing release manifest target: ${target}`);
    }

    if (targetConfig === undefined) {
      throw new Error(`Missing platform target config: ${target}`);
    }

    if (entry.artifact.length === 0) {
      throw new Error(`Release manifest target ${target} has an empty artifact path.`);
    }

    const artifactPath = resolveArtifactPath(entry.artifact);
    const effectiveConfigPath = resolveArtifactPath(entry.effectiveConfig.path);

    assertPathInsideTargetBase(artifactPath, `${target} artifact`);
    assertPathExists(artifactPath, `${target} artifact`);
    assertPathInsideTargetBase(effectiveConfigPath, `${target} effective target config`);
    assertPathExists(effectiveConfigPath, `${target} effective target config`);

    for (const requiredFile of requiredFilesForTarget(target, targetConfig, artifactPath)) {
      assertFileExists(requiredFile, `${target} required file`);
    }

    for (const extraFile of extraRequiredFilesForTarget(targetConfig, artifactPath)) {
      assertFileExists(extraFile, `${target} required file`);
    }

    for (const extraArtifact of extraRequiredPathsForTarget(targetConfig, artifactPath)) {
      assertPathExists(extraArtifact, `${target} required artifact`);
    }

    if (target === 'microsoft-store') {
      verifyMicrosoftStorePwaManifest(artifactPath);
    }

    if (targetConfig.kind === 'devvit-web') {
      verifyDevvitWebManifest(target, targetConfig, artifactPath);
    }

    assertEmbeddedTargetConfig(
      readEmbeddedTargetConfigFromFile(
        effectiveConfigPath,
        `${target} effective target config artifact`,
      ),
      {
        target,
        digest: entry.effectiveConfig.digest,
      },
    );
    assertEmbeddedTargetConfig(
      readReleaseEmbeddedTargetConfig(target, targetConfig, artifactPath),
      {
        target,
        digest: entry.effectiveConfig.digest,
      },
    );
  }

  console.log(`Target smoke passed: ${targets.join(', ')}`);
}

function readReleaseEmbeddedTargetConfig(
  target: string,
  targetConfig: SmokePlatformTargetConfig,
  artifactPath: string,
): EmbeddedTargetConfigEvidence {
  switch (targetConfig.kind) {
    case 'web':
      return readEmbeddedTargetConfigFromFile(
        `${artifactPath}/${embeddedTargetConfigFileName}`,
        'web-preview artifact',
      );
    case 'capacitor-android':
      return readEmbeddedTargetConfigFromZip(artifactPath, `${target} release AAB`);
    case 'capacitor-ios':
      return readEmbeddedTargetConfigFromDirectory(artifactPath, `${target} native artifact`);
    case 'apps-in-toss':
      if (artifactPath.endsWith('.ait')) {
        return readEmbeddedTargetConfigFromZip(artifactPath, `${target} release artifact`);
      }

      return readEmbeddedTargetConfigFromDirectory(
        `${artifactPath}/game`,
        `${target} wrapper game artifact`,
      );
    case 'devvit-web':
      return readEmbeddedTargetConfigFromDirectory(
        `${artifactPath}/client`,
        `${target} Devvit client artifact`,
      );
  }
}

function extraRequiredFilesForTarget(
  targetConfig: SmokePlatformTargetConfig,
  artifactPath: string,
): readonly string[] {
  if (targetConfig.kind === 'devvit-web') {
    return [`${artifactPath}/server/index.cjs`];
  }

  return [];
}

function extraRequiredPathsForTarget(
  targetConfig: SmokePlatformTargetConfig,
  artifactPath: string,
): readonly string[] {
  if (targetConfig.kind === 'capacitor-ios') {
    return localSwiftPackagePathsForIosArtifact(artifactPath);
  }

  return [];
}

function localSwiftPackagePathsForIosArtifact(artifactPath: string): readonly string[] {
  const packageFile = `${artifactPath}/App/CapApp-SPM/Package.swift`;

  if (!existsSync(packageFile)) {
    if (isIosSyncArtifact(artifactPath) || existsSync(`${artifactPath}/App/App.xcodeproj`)) {
      throw new Error(`Missing iOS Swift package manifest: ${packageFile}`);
    }

    return [];
  }

  const packageFileDir = dirname(packageFile);
  const packageFileContents = readFileSync(packageFile, 'utf8');

  const packageMatches = packageFileContents.matchAll(/\.package\([^)]*\bpath:\s*"([^"]+)"/gu);
  const packagePaths = [...packageMatches].map((match) =>
    resolve(packageFileDir, requireStringMatch(match[1], packageFile)),
  );

  if (isIosSyncArtifact(artifactPath)) {
    for (const packagePath of packagePaths) {
      assertPathInside(packagePath, artifactPath, 'iOS sync Swift package');
    }
  }

  return packagePaths;
}

function isIosSyncArtifact(artifactPath: string): boolean {
  return basename(artifactPath) === 'capacitor-sync';
}

function requiredFilesForTarget(
  target: string,
  targetConfig: SmokePlatformTargetConfig,
  artifactPath: string,
): readonly string[] {
  switch (targetConfig.kind) {
    case 'web':
      return target === 'microsoft-store'
        ? [`${artifactPath}/index.html`, `${artifactPath}/manifest.webmanifest`]
        : [`${artifactPath}/index.html`];
    case 'apps-in-toss':
      if (artifactPath.endsWith('.ait')) {
        return [];
      }

      return [`${artifactPath}/index.html`, `${artifactPath}/game/index.html`];
    case 'devvit-web':
      return [`${artifactPath}/client/index.html`];
    case 'capacitor-android':
    case 'capacitor-ios':
      return [];
  }
}

function verifyMicrosoftStorePwaManifest(artifactPath: string): void {
  const indexPath = `${artifactPath}/index.html`;
  const manifestPath = `${artifactPath}/manifest.webmanifest`;
  const indexHtml = readFileSync(indexPath, 'utf8');

  if (!hasManifestLink(indexHtml)) {
    throw new Error(`Microsoft Store artifact must link manifest.webmanifest from ${indexPath}.`);
  }

  const manifest = readJsonFile(manifestPath);

  assertRecord(manifest, 'Microsoft Store PWA manifest');
  assertString(manifest.name, 'Microsoft Store PWA manifest name');
  assertString(manifest.short_name, 'Microsoft Store PWA manifest short_name');
  assertString(manifest.description, 'Microsoft Store PWA manifest description');
  assertString(manifest.start_url, 'Microsoft Store PWA manifest start_url');
  assertString(manifest.scope, 'Microsoft Store PWA manifest scope');

  if (manifest.display !== 'standalone') {
    throw new Error('Microsoft Store PWA manifest display must be standalone.');
  }

  assertArray(manifest.icons, 'Microsoft Store PWA manifest icons');

  if (manifest.icons.length === 0) {
    throw new Error('Microsoft Store PWA manifest must include at least one icon.');
  }

  for (const [index, icon] of manifest.icons.entries()) {
    assertRecord(icon, `Microsoft Store PWA manifest icon ${index}`);
    assertString(icon.src, `Microsoft Store PWA manifest icon ${index} src`);
    assertString(icon.sizes, `Microsoft Store PWA manifest icon ${index} sizes`);

    const iconPath = resolveArtifactWebFilePath(artifactPath, dirname(manifestPath), icon.src);

    assertPathInside(
      iconPath,
      artifactPath,
      `Microsoft Store PWA manifest icon ${index} must stay inside artifact`,
    );
    assertFileExists(iconPath, `Microsoft Store PWA manifest icon ${index}`);
  }
}

function verifyDevvitWebManifest(
  target: string,
  targetConfig: SmokePlatformTargetConfig,
  artifactPath: string,
): void {
  const wrapperAppConfigPath = requireStringMatch(targetConfig.wrapperApp, `${target}.wrapperApp`);
  const wrapperApp = resolveFromPlatformTargetsBase(
    loadedPlatformTargets.baseDir,
    wrapperAppConfigPath,
  );
  const manifestPath = `${wrapperApp}/devvit.json`;
  const manifest = readJsonFile(manifestPath);
  const label = `${target} Devvit manifest`;

  assertRecord(manifest, label);
  assertNoTemplatePlaceholders(manifest, label);
  assertString(manifest.name, `${label} name`);
  assertDevvitAppName(manifest.name, `${label} name`);

  const post = manifest.post;
  assertRecord(post, `${label} post`);
  assertString(post.dir, `${label} post.dir`);
  const postDir = resolveDevvitManifestDirectory(wrapperApp, post.dir, `${label} post.dir`);
  const expectedPostDir = resolve(artifactPath, 'client');
  assertPathEqual(postDir, expectedPostDir, `${label} post.dir must target the built client`);

  const entrypoints = post.entrypoints;
  assertRecord(entrypoints, `${label} post.entrypoints`);
  const defaultEntrypoint = entrypoints.default;
  assertRecord(defaultEntrypoint, `${label} default post entrypoint`);
  const defaultPostEntry = defaultEntrypoint.entry ?? 'index.html';
  assertString(defaultPostEntry, `${label} default post entry`);
  const defaultPostEntryPath = resolveDevvitManifestFile(
    postDir,
    defaultPostEntry,
    `${label} default post entry`,
    {
      allowQueryString: true,
    },
  );

  assertPathEqual(
    defaultPostEntryPath,
    resolve(expectedPostDir, 'index.html'),
    `${label} default post entry must target the built client index`,
  );
  assertFileExists(defaultPostEntryPath, `${label} default post entry`);

  const server = manifest.server;
  assertRecord(server, `${label} server`);
  const serverDirConfig = server.dir === undefined ? 'dist/server' : server.dir;

  assertString(serverDirConfig, `${label} server.dir`);
  assertString(server.entry, `${label} server.entry`);
  const serverDir = resolveDevvitManifestDirectory(
    wrapperApp,
    serverDirConfig,
    `${label} server.dir`,
  );
  const expectedServerDir = resolve(artifactPath, 'server');
  assertPathEqual(serverDir, expectedServerDir, `${label} server.dir must target the built server`);
  const serverEntryPath = resolveDevvitManifestFile(
    serverDir,
    server.entry,
    `${label} server entry`,
  );

  assertPathEqual(
    serverEntryPath,
    resolve(expectedServerDir, 'index.cjs'),
    `${label} server entry must target the built CommonJS server`,
  );
  assertFileExists(serverEntryPath, `${label} server entry`);

  const permissions = manifest.permissions;
  assertRecord(permissions, `${label} permissions`);
  assertBooleanValue(permissions.redis, true, `${label} permissions.redis`);
  assertDisabledDevvitPermission(permissions.payments, `${label} permissions.payments`);
  assertDisabledDevvitPermission(permissions.realtime, `${label} permissions.realtime`);
  assertEnabledRedditPermission(permissions.reddit, `${label} permissions.reddit`);

  const menu = manifest.menu;
  assertRecord(menu, `${label} menu`);
  assertArray(menu.items, `${label} menu.items`);

  if (!menu.items.some(isCreatePostMenuItem)) {
    throw new Error(`${label} must expose a subreddit create-post menu item.`);
  }
}

function hasManifestLink(html: string): boolean {
  const linkTags = html.match(/<link\b[^>]*>/giu) ?? [];

  return linkTags.some((tag) => {
    const rel = readHtmlAttribute(tag, 'rel');
    const href = readHtmlAttribute(tag, 'href');

    return (
      rel?.split(/\s+/u).some((token) => token.toLowerCase() === 'manifest') === true
      && normalizeLocalWebPath(href ?? '') === 'manifest.webmanifest'
    );
  });
}

function resolveArtifactWebFilePath(
  artifactPath: string,
  relativeBaseDir: string,
  path: string,
): string {
  const normalizedPath = normalizeLocalWebPath(path);

  if (normalizedPath.length === 0) {
    return resolve(relativeBaseDir, path);
  }

  if (path.trimStart().startsWith('/')) {
    return resolve(artifactPath, normalizedPath);
  }

  return resolve(relativeBaseDir, normalizedPath);
}

function normalizeLocalWebPath(path: string): string {
  const trimmedPath = path.trim();
  const pathWithoutQuery = trimmedPath.split(/[?#]/u, 1)[0] ?? '';
  const withoutLeadingRoot = pathWithoutQuery.replace(/^\/+/u, '');

  return withoutLeadingRoot.replace(/^(?:\.\/)+/u, '');
}

function resolveDevvitManifestDirectory(
  wrapperApp: string,
  path: string,
  label: string,
): string {
  const normalizedPath = normalizeDevvitManifestRelativePath(path, label);
  const directory = resolve(wrapperApp, normalizedPath);

  assertPathInside(directory, wrapperApp, `${label} must stay inside wrapper app`);

  return directory;
}

function resolveDevvitManifestFile(
  baseDir: string,
  path: string,
  label: string,
  options: { readonly allowQueryString?: boolean } = {},
): string {
  const normalizedPath = normalizeDevvitManifestRelativePath(path, label, options);
  const file = resolve(baseDir, normalizedPath);

  assertPathInside(file, baseDir, `${label} must stay inside its Devvit directory`);

  return file;
}

function normalizeDevvitManifestRelativePath(
  path: string,
  label: string,
  options: { readonly allowQueryString?: boolean } = {},
): string {
  const trimmedPath = path.trim();
  const queryIndex = trimmedPath.indexOf('?');
  const pathWithoutQuery = options.allowQueryString && queryIndex >= 0
    ? trimmedPath.slice(0, queryIndex)
    : trimmedPath;

  if (trimmedPath.length === 0 || pathWithoutQuery.length === 0) {
    throw new Error(`${label} must be a non-empty Devvit manifest path.`);
  }

  if (pathWithoutQuery.startsWith('/')) {
    throw new Error(`${label} must be a relative Devvit manifest path.`);
  }

  if (trimmedPath.includes('#') || (!options.allowQueryString && trimmedPath.includes('?'))) {
    const disallowedParts = options.allowQueryString
      ? 'hash fragments'
      : 'hash fragments or query strings';

    throw new Error(`${label} must not include ${disallowedParts}.`);
  }

  const normalizedPath = pathWithoutQuery.replace(/^(?:\.\/)+/u, '');

  if (normalizedPath.length === 0) {
    throw new Error(`${label} must include a file or directory path.`);
  }

  return normalizedPath;
}

function readHtmlAttribute(tag: string, name: string): string | undefined {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'iu'));
  return match?.[2];
}

function resolveArtifactPath(path: string): string {
  return resolveFromPlatformTargetsBase(loadedPlatformTargets.baseDir, path);
}

function assertPathExists(path: string, label: string): void {
  if (!existsSync(path)) {
    throw new Error(`Missing ${label}: ${path}`);
  }

  const stat = statSync(path);

  if (!stat.isFile() && !stat.isDirectory()) {
    throw new Error(`${label} is not a file or directory: ${path}`);
  }
}

function assertPathInsideTargetBase(path: string, label: string): void {
  assertPathInside(
    path,
    loadedPlatformTargets.baseDir,
    `${label} must stay under the target config dir`,
  );
}

function assertPathInside(path: string, baseDir: string, label: string): void {
  const relativePath = relative(baseDir, path);

  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error(`${label}: ${path}`);
  }
}

function assertPathEqual(actual: string, expected: string, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}. Expected ${expected}, got ${actual}.`);
  }
}

function assertFileExists(path: string, label: string): void {
  if (!existsSync(path)) {
    throw new Error(`Missing ${label}: ${path}`);
  }

  const stat = statSync(path);

  if (!stat.isFile()) {
    throw new Error(`${label} is not a file: ${path}`);
  }
}

function requireStringMatch(input: string | undefined, source: string): string {
  if (input === undefined || input.length === 0) {
    throw new Error(`Failed to read local package path from ${source}`);
  }

  return input;
}

function loadSmokePlatformTargetsConfig(): {
  readonly baseDir: string;
  readonly config: SmokePlatformTargetsConfig;
} {
  const path = platformTargetsFilePath();
  const config = readJsonFile(path) as SmokePlatformTargetsConfig;

  assertRecord(config, 'platform targets config');
  assertRecord(config.targets, 'platform targets');

  for (const [target, targetConfig] of Object.entries(config.targets)) {
    assertRecord(targetConfig, `platform target ${target}`);
    assertTargetKind(targetConfig.kind, target);
    assertString(targetConfig.gameApp, `${target}.gameApp`);
    assertString(targetConfig.adapter, `${target}.adapter`);
  }

  return {
    baseDir: dirname(path),
    config,
  };
}

function readSmokeReleaseManifest(path: string): ReleaseManifest {
  return assertReleaseManifest(readJsonFile(path));
}

function platformTargetsFilePath(): string {
  return resolve(process.env[platformTargetsFileEnv] ?? 'platform.targets.json');
}

function releaseManifestPath(baseDir: string): string {
  return resolveFromPlatformTargetsBase(
    baseDir,
    process.env[releaseManifestFileEnv] ?? 'artifacts/release-manifest.json',
  );
}

function resolveFromPlatformTargetsBase(baseDir: string, path: string): string {
  return isAbsolute(path) ? path : resolve(baseDir, path);
}

function assertRecord(input: unknown, label: string): asserts input is Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error(`${label} must be an object.`);
  }
}

function assertString(input: unknown, label: string): asserts input is string {
  if (typeof input !== 'string' || input.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
}

function assertArray(input: unknown, label: string): asserts input is unknown[] {
  if (!Array.isArray(input)) {
    throw new Error(`${label} must be an array.`);
  }
}

function assertBooleanValue(input: unknown, expected: boolean, label: string): void {
  if (input !== expected) {
    throw new Error(`${label} must be ${String(expected)}.`);
  }
}

function assertDisabledDevvitPermission(input: unknown, label: string): void {
  if (input !== undefined && input !== false) {
    throw new Error(`${label} must be false or omitted.`);
  }
}

function assertDevvitAppName(input: string, label: string): void {
  if (input.length < 3 || input.length > 16 || !/^[a-z][a-z0-9-]*$/u.test(input)) {
    throw new Error(`${label} must be a 3-16 character lowercase slug starting with a letter.`);
  }
}

function assertNoTemplatePlaceholders(input: unknown, label: string): void {
  if (typeof input === 'string') {
    if (/__[A-Z0-9_]+__/u.test(input)) {
      throw new Error(`${label} contains an unreplaced template placeholder.`);
    }

    return;
  }

  if (Array.isArray(input)) {
    for (const [index, value] of input.entries()) {
      assertNoTemplatePlaceholders(value, `${label}[${index}]`);
    }

    return;
  }

  if (typeof input === 'object' && input !== null) {
    for (const [key, value] of Object.entries(input)) {
      assertNoTemplatePlaceholders(value, `${label}.${key}`);
    }
  }
}

function assertEnabledRedditPermission(input: unknown, label: string): void {
  if (input === true) {
    return;
  }

  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error(`${label} must enable the Reddit API.`);
  }

  const config = input as Record<string, unknown>;

  if (config.enable === undefined || config.enable === true) {
    return;
  }

  if (config.enable === false) {
    throw new Error(`${label} must enable the Reddit API.`);
  }

  throw new Error(`${label}.enable must be a boolean when present.`);
}

function isCreatePostMenuItem(input: unknown): boolean {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return false;
  }

  const item = input as Record<string, unknown>;

  return (
    isSubredditMenuLocation(item.location)
    && isNonEmptyString(item.label)
    && item.endpoint === '/internal/menu/create-post'
    && isSupportedCreatePostMenuUserType(item.forUserType)
  );
}

function isSupportedCreatePostMenuUserType(input: unknown): boolean {
  return input === undefined || input === 'moderator' || input === 'user';
}

function isNonEmptyString(input: unknown): input is string {
  return typeof input === 'string' && input.trim().length > 0;
}

function isSubredditMenuLocation(input: unknown): boolean {
  return input === 'subreddit' || (Array.isArray(input) && input.includes('subreddit'));
}

function assertTargetKind(
  input: unknown,
  target: string,
): asserts input is SmokePlatformTargetConfig['kind'] {
  if (
    input !== 'web'
    && input !== 'capacitor-android'
    && input !== 'capacitor-ios'
    && input !== 'apps-in-toss'
    && input !== 'devvit-web'
  ) {
    throw new Error(`Target ${target} has unsupported kind: ${String(input)}`);
  }
}

function readRequestedTargets(args: readonly string[]): readonly string[] {
  if (args.length === 0) {
    return configuredTargets;
  }

  return args.map((target) => {
    if (!knownTargets.has(target)) {
      throw new Error(`Unknown target smoke target: ${target}`);
    }

    return target;
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  verifyTargetArtifacts(readRequestedTargets(process.argv.slice(2)));
}
