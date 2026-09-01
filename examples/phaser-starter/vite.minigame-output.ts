import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';

import type { Plugin } from 'vite';

const runtimeAssetOriginsProperty = '__MPGD_MINIGAME_RUNTIME_ASSET_ORIGINS__';
const forbiddenInstalledGameBundleModuleMarkers = [
  '/@mpgd/adapter-',
  '/@mpgd/phaser-minigame-runtime/',
] as const;
const forbiddenPlatformSdkPackagePrefixes = [
  '@apps-in-toss/',
  '@capacitor/',
  '@devvit/',
  '@tauri-apps/',
  '@telegram-apps/',
  '@tiktok/',
  '@ttmg/',
  '@verse8/',
] as const;

export interface MiniGameGameModuleBoundaryInput {
  readonly gameRoot: string;
  readonly workspaceRoot: string;
}

interface MiniGameModulePackageMetadata {
  readonly installedPackageRoot?: true;
  readonly manifestDirectory: string;
  readonly name?: string;
  readonly repositoryDirectory?: string;
  readonly repositoryUrl?: string;
}

/**
 * Enforces the source-module boundary that keeps native SDK adapters in runtime.js.
 * Game code and dependencies are trusted build inputs; artifact AST checks are defense in depth,
 * not a JavaScript sandbox for adversarially obfuscated source.
 */
export function createMiniGameGameModuleBoundaryPlugin(
  input: MiniGameGameModuleBoundaryInput,
): Plugin {
  return {
    name: 'mpgd-minigame-game-module-boundary',
    generateBundle(_options, bundle) {
      const moduleIds = new Set<string>();

      for (const output of Object.values(bundle)) {
        if (output.type === 'chunk') {
          for (const moduleId of Object.keys(output.modules)) {
            moduleIds.add(moduleId);
          }
        }
      }

      assertMiniGameGameBundleModules(moduleIds, input);
    },
  };
}

export function assertMiniGameGameBundleModules(
  moduleIds: Iterable<string>,
  input: MiniGameGameModuleBoundaryInput,
): void {
  const workspaceRoot = normalizeModuleId(resolve(input.workspaceRoot));
  const gameRoot = normalizeModuleId(resolve(input.gameRoot));
  const forbiddenWorkspaceMarkers = [
    `${workspaceRoot}/adapters/`,
    `${workspaceRoot}/native-plugins/`,
    `${workspaceRoot}/apps/target-`,
    `${workspaceRoot}/packages/phaser-minigame-runtime/`,
    `${gameRoot}/src/platform/minigameruntime/`,
  ];
  const forbiddenMarkers = [
    ...forbiddenInstalledGameBundleModuleMarkers,
    ...forbiddenWorkspaceMarkers,
  ];

  for (const moduleId of moduleIds) {
    const normalized = normalizeModuleId(moduleId);
    const packageMetadata = readMiniGameModulePackageMetadataChain(moduleId);

    if (
      isForbiddenMiniGameModulePackageChain(packageMetadata)
      || forbiddenMarkers.some((marker) => {
        return normalized.includes(marker);
      })
    ) {
      throw new Error(
        `Mini-game game.bundle.js must not include platform runtime module: ${normalized}`,
      );
    }
  }
}

export function createRuntimeAssetOriginsBootstrap(serializedOrigins: string): string {
  return 'globalThis.Object.defineProperty(globalThis,'
    + `"${runtimeAssetOriginsProperty}",`
    + '{configurable:false,enumerable:false,writable:false,'
    + 'value:globalThis.Object.freeze('
    + `globalThis.${runtimeAssetOriginsProperty}??${serializedOrigins}`
    + ')});';
}

export function resolveMiniGameBundleOutput(input: Readonly<{
  readonly gameRoot: string;
  readonly outputDir: string;
  readonly stagingRoot: string;
}>): string {
  const gameRoot = readRealDirectory(resolve(input.gameRoot), 'Mini-game game root');
  const unresolvedStagingRoot = resolve(gameRoot, input.stagingRoot);
  const stagingRoot = readRealDirectory(
    unresolvedStagingRoot,
    'Mini-game bundle staging root',
  );
  const unresolvedOutput = resolve(gameRoot, input.outputDir);
  const stagingRelativeOutput = relative(unresolvedStagingRoot, unresolvedOutput);

  if (!isDedicatedChildPath(stagingRelativeOutput)) {
    throw new Error('Mini-game bundle output must be a dedicated child of its staging root.');
  }

  assertNoSymbolicLink(unresolvedOutput, unresolvedStagingRoot);
  const output = resolve(stagingRoot, stagingRelativeOutput);

  if (pathsOverlap(stagingRoot, gameRoot) || pathsOverlap(output, gameRoot)) {
    throw new Error(
      'Mini-game bundle staging and output directories must not overlap the game project.',
    );
  }

  return output;
}

function readRealDirectory(path: string, label: string): string {
  if (!existsSync(path)) {
    throw new Error(`${label} does not exist: ${path}`);
  }

  const stat = lstatSync(path);

  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory: ${path}`);
  }

  return realpathSync(path);
}

function assertNoSymbolicLink(output: string, stagingRoot: string): void {
  let candidate = output;

  while (candidate !== stagingRoot) {
    if (existsSync(candidate) && lstatSync(candidate).isSymbolicLink()) {
      throw new Error(`Mini-game bundle output must not traverse a symbolic link: ${candidate}`);
    }

    const parent = dirname(candidate);

    if (parent === candidate) {
      throw new Error('Mini-game bundle output escaped its staging root.');
    }
    candidate = parent;
  }
}

function isDedicatedChildPath(path: string): boolean {
  return path.length > 0
    && path !== '..'
    && !path.startsWith(`..${sep}`)
    && !isAbsolute(path);
}

function pathsOverlap(left: string, right: string): boolean {
  return isInsideOrEqual(left, right) || isInsideOrEqual(right, left);
}

function isInsideOrEqual(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path.length === 0
    || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function normalizeModuleId(moduleId: string): string {
  return (moduleId.split('?')[0] ?? moduleId).replaceAll('\\', '/').toLowerCase();
}

function readMiniGameModulePackageMetadataChain(
  moduleId: string,
): readonly MiniGameModulePackageMetadata[] {
  const modulePath = moduleId.split('?')[0] ?? moduleId;

  if (!isAbsolute(modulePath)) {
    return [];
  }
  const isInstalledModule = normalizeModuleId(modulePath).includes('/node_modules/');
  const metadata: MiniGameModulePackageMetadata[] = [];
  let directory = dirname(modulePath);

  while (true) {
    const atInstalledPackageRoot = isInstalledModule && isInstalledPackageRoot(directory);
    const packageJsonPath = join(directory, 'package.json');

    if (existsSync(packageJsonPath)) {
      let parsed: unknown;

      try {
        parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as unknown;
      } catch (error) {
        throw new Error(
          `Mini-game module owner package.json is invalid at ${packageJsonPath}: ${String(error)}`,
        );
      }
      if (!isRecord(parsed)) {
        throw new Error(`Mini-game module owner package.json must be an object: ${packageJsonPath}`);
      }
      const repository = isRecord(parsed.repository) ? parsed.repository : undefined;
      let repositoryUrl: string | undefined;

      if (typeof parsed.repository === 'string') {
        repositoryUrl = parsed.repository;
      } else if (typeof repository?.url === 'string') {
        repositoryUrl = repository.url;
      }
      const packageMetadata = {
        ...(atInstalledPackageRoot ? { installedPackageRoot: true as const } : {}),
        manifestDirectory: directory,
        ...(typeof parsed.name === 'string' ? { name: parsed.name } : {}),
        ...(typeof repository?.directory === 'string'
          ? { repositoryDirectory: repository.directory }
          : {}),
        ...(repositoryUrl === undefined ? {} : { repositoryUrl }),
      } satisfies MiniGameModulePackageMetadata;
      metadata.push(packageMetadata);
    }

    if (atInstalledPackageRoot) {
      return metadata;
    }

    const parent = dirname(directory);
    if (parent === directory) {
      return metadata;
    }
    directory = parent;
  }
}

function isInstalledPackageRoot(directory: string): boolean {
  const parent = dirname(directory);

  if (basename(parent).toLowerCase() === 'node_modules') {
    return true;
  }
  return basename(parent).startsWith('@')
    && basename(dirname(parent)).toLowerCase() === 'node_modules';
}

function isForbiddenMiniGameModulePackageChain(
  metadata: readonly MiniGameModulePackageMetadata[],
): boolean {
  const installedOwner = metadata.find(({ installedPackageRoot }) => {
    return installedPackageRoot === true;
  });

  if (installedOwner !== undefined) {
    const isMpgdOwner = installedOwner.name?.startsWith('@mpgd/') === true
      || isMpgdKitRepositoryUrl(installedOwner.repositoryUrl);
    return isForbiddenMiniGameModulePackageName(installedOwner.name)
      || (isMpgdOwner && isForbiddenMpgdKitRepositoryDirectory(installedOwner));
  }
  if (metadata.some(({ name }) => isForbiddenMiniGameModulePackageName(name))) {
    return true;
  }
  return metadata.some((packageMetadata) => {
    if (!isForbiddenMpgdKitRepositoryDirectory(packageMetadata)) {
      return false;
    }
    const repositoryRoot = resolveDeclaredRepositoryRoot(packageMetadata);

    if (repositoryRoot === undefined) {
      return false;
    }
    const rootMetadata = metadata.find((candidate) => {
      return normalizeModuleId(resolve(candidate.manifestDirectory))
        === normalizeModuleId(repositoryRoot);
    });
    return packageMetadata.name?.startsWith('@mpgd/') === true
      || rootMetadata?.name?.startsWith('@mpgd/') === true
      || isMpgdKitRepositoryUrl(packageMetadata.repositoryUrl)
      || isMpgdKitRepositoryUrl(rootMetadata?.repositoryUrl);
  });
}

function isForbiddenMiniGameModulePackageName(name: string | undefined): boolean {
  return forbiddenPlatformSdkPackagePrefixes.some((prefix) => name?.startsWith(prefix) === true)
    || name?.startsWith('@mpgd/adapter-') === true
    || (
      name?.startsWith('@mpgd/target-') === true
      && name !== '@mpgd/target-config'
    )
    || name === '@mpgd/phaser-minigame-runtime'
    || name === '@mpgd/capacitor-game-services';
}

function isForbiddenMpgdKitRepositoryDirectory(
  metadata: MiniGameModulePackageMetadata,
): boolean {
  const repositoryDirectory = normalizeRepositoryDirectory(metadata.repositoryDirectory);
  return repositoryDirectory?.startsWith('adapters/') === true
    || repositoryDirectory?.startsWith('native-plugins/') === true
    || repositoryDirectory?.startsWith('apps/target-') === true
    || repositoryDirectory === 'packages/phaser-minigame-runtime';
}

function resolveDeclaredRepositoryRoot(
  metadata: MiniGameModulePackageMetadata,
): string | undefined {
  const repositoryDirectory = normalizeRepositoryDirectory(metadata.repositoryDirectory);

  if (repositoryDirectory === undefined) {
    return undefined;
  }
  const segments = repositoryDirectory.split('/');
  let repositoryRoot = resolve(metadata.manifestDirectory);

  for (let remaining = segments.length; remaining > 0; remaining -= 1) {
    repositoryRoot = dirname(repositoryRoot);
  }
  const declaredPackageDirectory = resolve(repositoryRoot, ...segments);
  return normalizeModuleId(declaredPackageDirectory)
    === normalizeModuleId(resolve(metadata.manifestDirectory))
      ? repositoryRoot
      : undefined;
}

function isMpgdKitRepositoryUrl(input: string | undefined): boolean {
  const repositoryUrl = input?.trim().replace(/^git\+/iu, '');

  if (repositoryUrl === undefined || repositoryUrl.length === 0) {
    return false;
  }
  const shorthandSource = repositoryUrl.split(/[?#]/u)[0] ?? repositoryUrl;
  const shorthand = shorthandSource.replace(/\.git$/iu, '').toLowerCase();

  if (shorthand === 'imjlk/mpgd-kit') {
    return true;
  }
  let repositoryPath: string;

  if (repositoryUrl.toLowerCase().startsWith('github:')) {
    repositoryPath = repositoryUrl.slice('github:'.length);
  } else if (/^git@github\.com:/iu.test(repositoryUrl)) {
    repositoryPath = repositoryUrl.replace(/^git@github\.com:/iu, '');
  } else {
    let parsed: URL;

    try {
      parsed = new URL(repositoryUrl);
    } catch {
      return false;
    }
    if (parsed.hostname.toLowerCase() !== 'github.com') {
      return false;
    }
    repositoryPath = parsed.pathname;
  }

  const repositoryPathWithoutRef = repositoryPath.split(/[?#]/u)[0] ?? repositoryPath;
  return repositoryPathWithoutRef
    .replace(/^\/+|\/+$/gu, '')
    .replace(/\.git$/iu, '')
    .toLowerCase() === 'imjlk/mpgd-kit';
}

function normalizeRepositoryDirectory(input: string | undefined): string | undefined {
  if (input === undefined) {
    return undefined;
  }
  const normalized = posix.normalize(input.replaceAll('\\', '/')).toLowerCase();

  if (
    normalized === '..'
    || normalized.startsWith('../')
    || normalized.startsWith('/')
  ) {
    return undefined;
  }
  return normalized.replace(/\/+$/u, '');
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}
