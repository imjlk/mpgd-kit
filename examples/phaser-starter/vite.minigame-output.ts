import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

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
    && !path.startsWith('../')
    && !isAbsolute(path);
}

function pathsOverlap(left: string, right: string): boolean {
  return isInsideOrEqual(left, right) || isInsideOrEqual(right, left);
}

function isInsideOrEqual(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path.length === 0 || (path !== '..' && !path.startsWith('../') && !isAbsolute(path));
}
