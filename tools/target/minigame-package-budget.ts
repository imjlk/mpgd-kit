import { lstatSync, readdirSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import type { MiniGamePackageBudget } from './schemas';

export const miniGameMainPackageLimitBytes = 4 * 1024 * 1024;

export interface MiniGameSubpackageSize {
  readonly root: string;
  readonly independent: boolean;
  readonly bytes: number;
}

export interface MiniGamePackageSizeResult {
  readonly mainBytes: number;
  readonly totalBytes: number;
  readonly subpackages: readonly MiniGameSubpackageSize[];
}

export function assertMiniGamePackageBudget(input: Readonly<{
  readonly artifactRoot: string;
  readonly gameConfig: unknown;
  readonly budget: MiniGamePackageBudget;
}>): MiniGamePackageSizeResult {
  const artifactRoot = resolve(input.artifactRoot);
  const rootStat = lstatSync(artifactRoot);

  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`Mini-game artifact root must be a real directory: ${artifactRoot}`);
  }

  const subpackages = readMiniGameSubpackages(input.gameConfig);
  assertSubpackageRoots(subpackages);
  const files = listMiniGameArtifactFiles(artifactRoot);
  const bytesByRoot = new Map(subpackages.map((subpackage) => [subpackage.root, 0]));
  let mainBytes = 0;
  let totalBytes = 0;

  for (const file of files) {
    totalBytes += file.bytes;
    const subpackage = subpackages.find((candidate) => isInsideRoot(file.path, candidate.root));

    if (subpackage === undefined) {
      mainBytes += file.bytes;
    } else {
      bytesByRoot.set(subpackage.root, (bytesByRoot.get(subpackage.root) ?? 0) + file.bytes);
    }
  }

  for (const subpackage of subpackages) {
    const directory = resolveArtifactPath(artifactRoot, subpackage.root);

    if (!lstatSync(directory).isDirectory()) {
      throw new Error(`Mini-game subpackage root must be a directory: ${subpackage.root}`);
    }
  }

  const measuredSubpackages = subpackages.map((subpackage) => ({
    ...subpackage,
    bytes: bytesByRoot.get(subpackage.root) ?? 0,
  }));

  assertWithinBudget(mainBytes, input.budget.mainBytes, 'main package');
  assertWithinBudget(totalBytes, input.budget.totalBytes, 'total package');

  for (const subpackage of measuredSubpackages) {
    if (!subpackage.independent) {
      continue;
    }

    if (input.budget.independentSubpackageBytes === undefined) {
      throw new Error(
        `Mini-game independent subpackage ${subpackage.root} requires independentSubpackageBytes.`,
      );
    }

    assertWithinBudget(
      subpackage.bytes,
      input.budget.independentSubpackageBytes,
      `independent subpackage ${subpackage.root}`,
    );
  }

  return {
    mainBytes,
    totalBytes,
    subpackages: measuredSubpackages,
  };
}

export interface MiniGameArtifactFile {
  readonly path: string;
  readonly bytes: number;
}

export function listMiniGameArtifactFiles(artifactRoot: string): readonly MiniGameArtifactFile[] {
  const root = resolve(artifactRoot);
  const files: MiniGameArtifactFile[] = [];
  const pending = [root];

  while (pending.length > 0) {
    const directory = pending.pop();

    if (directory === undefined) {
      throw new Error('Mini-game artifact traversal lost its current directory.');
    }

    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      const stat = lstatSync(path);

      if (stat.isSymbolicLink()) {
        throw new Error(`Mini-game artifacts must not contain symbolic links: ${path}`);
      }

      if (stat.isDirectory()) {
        pending.push(path);
        continue;
      }

      if (!stat.isFile()) {
        throw new Error(`Mini-game artifacts must contain regular files only: ${path}`);
      }

      const artifactPath = toArtifactRelativePath(root, path);
      assertMiniGameArtifactFileAllowed(artifactPath);
      files.push({ path: artifactPath, bytes: stat.size });
    }
  }

  return files.sort((left, right) => left.path.localeCompare(right.path));
}

export function assertMiniGameArtifactRelativePath(path: string, label: string): void {
  if (
    path.length === 0
    || path.includes('\\')
    || path.startsWith('/')
    || /^[A-Za-z]:/u.test(path)
    || isAbsolute(path)
    || path.split('/').some(
      (segment) => segment.length === 0 || segment === '.' || segment === '..',
    )
  ) {
    throw new Error(`${label} must be a safe artifact-relative path: ${path}`);
  }
}

function readMiniGameSubpackages(
  gameConfig: unknown,
): readonly Readonly<{ readonly root: string; readonly independent: boolean }>[] {
  if (!isRecord(gameConfig)) {
    throw new Error('Mini-game game.json must contain a JSON object.');
  }

  if (gameConfig.subpackages === undefined) {
    return [];
  }

  if (!Array.isArray(gameConfig.subpackages)) {
    throw new Error('Mini-game game.json subpackages must be an array.');
  }

  return gameConfig.subpackages.map((input, index) => {
    if (!isRecord(input) || typeof input.root !== 'string') {
      throw new Error(`Mini-game subpackage ${String(index)} must define a string root.`);
    }
    if (input.independent !== undefined && typeof input.independent !== 'boolean') {
      throw new Error(`Mini-game subpackage ${input.root} independent must be a boolean.`);
    }

    assertMiniGameArtifactRelativePath(input.root, `Mini-game subpackage ${String(index)} root`);
    return { root: input.root, independent: input.independent === true };
  });
}

function assertSubpackageRoots(
  subpackages: readonly Readonly<{ readonly root: string }>[],
): void {
  for (const [index, left] of subpackages.entries()) {
    for (const right of subpackages.slice(index + 1)) {
      if (
        left.root === right.root
        || isInsideRoot(left.root, right.root)
        || isInsideRoot(right.root, left.root)
      ) {
        throw new Error(
          `Mini-game subpackage roots must be unique and non-overlapping: ${left.root}, ${right.root}`,
        );
      }
    }
  }
}

function resolveArtifactPath(root: string, path: string): string {
  const resolved = resolve(root, path);
  const relativePath = relative(root, resolved);

  if (
    relativePath.length === 0
    || relativePath === '..'
    || relativePath.startsWith(`..${sep}`)
    || isAbsolute(relativePath)
  ) {
    throw new Error(`Mini-game path escapes its artifact root: ${path}`);
  }

  try {
    const stat = lstatSync(resolved);

    if (stat.isSymbolicLink()) {
      throw new Error(`Mini-game path must not be a symbolic link: ${path}`);
    }
  } catch (error) {
    throw new Error(`Mini-game subpackage root does not exist: ${path} (${formatError(error)})`);
  }

  return resolved;
}

function toArtifactRelativePath(root: string, path: string): string {
  const artifactPath = relative(root, path).replaceAll('\\', '/');
  assertMiniGameArtifactRelativePath(artifactPath, 'Mini-game artifact file');
  return artifactPath;
}

function isInsideRoot(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function assertWithinBudget(actual: number, maximum: number, label: string): void {
  if (actual > maximum) {
    throw new Error(
      `Mini-game ${label} exceeds its package budget: ${String(actual)} > ${String(maximum)} bytes.`,
    );
  }
}

function assertMiniGameArtifactFileAllowed(path: string): void {
  const segments = path.split('/');
  const fileName = segments.at(-1) ?? '';
  const normalizedFileName = fileName.toLowerCase();
  const normalizedSegments = segments.map((segment) => segment.toLowerCase());
  const forbiddenSegments = new Set([
    '.git',
    '__macosx',
    '__fixtures__',
    'fixtures',
    'node_modules',
    'test',
    'tests',
  ]);

  if (normalizedSegments.some((segment) => forbiddenSegments.has(segment))) {
    throw new Error(`Mini-game artifact contains a forbidden development path: ${path}`);
  }

  if (
    normalizedFileName === '.ds_store'
    || normalizedFileName === '.env'
    || normalizedFileName.startsWith('.env.')
    || normalizedFileName === '.npmrc'
    || normalizedFileName === 'credentials.json'
    || normalizedFileName === 'project.private.config.json'
    || /^service-account.*\.json$/iu.test(fileName)
    || /\.(?:map|jsx|ts|tsx|mts|cts|pem|key|p12|pfx)$/iu.test(fileName)
  ) {
    throw new Error(
      `Mini-game artifact contains a forbidden development or credential file: ${path}`,
    );
  }

  if (/\.(?:html?|css|svg)$/iu.test(fileName)) {
    throw new Error(`Mini-game artifact contains a browser-only asset: ${path}`);
  }

  if (/\.(?:aac|m4a|mp3|ogg|opus|wav|webm)$/iu.test(fileName)) {
    throw new Error(`Mini-game Canvas MVP does not support audio assets yet: ${path}`);
  }
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
