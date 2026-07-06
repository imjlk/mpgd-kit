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

    const iconPath = resolve(dirname(manifestPath), icon.src);

    assertPathInside(
      iconPath,
      artifactPath,
      `Microsoft Store PWA manifest icon ${index} must stay inside artifact`,
    );
    assertFileExists(iconPath, `Microsoft Store PWA manifest icon ${index}`);
  }
}

function hasManifestLink(html: string): boolean {
  const linkTags = html.match(/<link\b[^>]*>/giu) ?? [];

  return linkTags.some(
    (tag) =>
      /\brel=["']manifest["']/iu.test(tag)
      && /\bhref=["']\/?manifest\.webmanifest["']/iu.test(tag),
  );
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
