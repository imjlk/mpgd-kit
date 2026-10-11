import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

/**
 * TypeScript-Go's native compiler binary for this checkout, resolved through
 * the root `typescript` dependency so pnpm's layout is followed consistently.
 */
export function resolveTsgoBinary(repoRoot) {
  const rootRequire = createRequire(join(repoRoot, 'package.json'));
  const typescriptPackageJson = rootRequire.resolve('typescript/package.json');
  const typescriptRequire = createRequire(typescriptPackageJson);
  const platformPackage = `@typescript/typescript-${process.platform}-${process.arch}`;
  const platformRoot = dirname(typescriptRequire.resolve(`${platformPackage}/package.json`));
  return join(platformRoot, 'lib', process.platform === 'win32' ? 'tsc.exe' : 'tsc');
}

/**
 * The tsconfig file a `--project` value names. Like `tsc -p`, a directory
 * stands for its `tsconfig.json` (or `jsconfig.json`); the file's directory is
 * what `--showConfig` prints paths relative to.
 */
export function resolveProjectConfigPath(project, cwd = process.cwd()) {
  const projectPath = resolve(cwd, project);
  if (!isDirectory(projectPath)) {
    return projectPath;
  }
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    const candidate = join(projectPath, name);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  // Let tsgo report the missing config with its own diagnostic.
  return join(projectPath, 'tsconfig.json');
}

/**
 * The root file set a tsconfig selects (`files` plus matched `include` minus
 * `exclude`). This is tsgo's own answer (`--showConfig`), so it follows the
 * compiler's glob and `extends` semantics exactly. Imported files that the
 * globs do not match are deliberately not part of it: an entry must be
 * selected by the project, not merely reachable from it.
 *
 * `--showConfig` exits 0 and prints no `files` when the globs match nothing,
 * so an empty root set is reported as a project problem rather than attributed
 * to the entry. Other config errors (unreadable JSON, a missing `extends`
 * target) still produce a file set here; ttsx reports them when it builds.
 *
 * Returns `{ configPath, count, keys }`: `keys` holds every root file under
 * both the spelled and the physical config directory (macOS `/var` versus
 * `/private/var`, symlinked checkouts) in the platform's comparison form.
 */
export function resolveProjectRootFiles({ tsgoBinary, project, cwd = process.cwd() }) {
  const configPath = resolveProjectConfigPath(project, cwd);
  const result = spawnSync(tsgoBinary, ['--showConfig', '-p', configPath], {
    cwd,
    encoding: 'utf8',
    // A large project's file list must not hit Node's default 1 MiB pipe limit
    // (ENOBUFS would surface as a misleading "could not resolve" failure).
    maxBuffer: 64 * 1024 * 1024,
  });

  if (result.error !== undefined) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(
      `Could not resolve the file set of ${configPath} (tsgo --showConfig exited with ${result.status}):\n`
        + `${result.stderr || result.stdout}`.trim(),
    );
  }

  let config;
  try {
    config = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`Could not parse tsgo --showConfig output for ${configPath}: ${error.message}`);
  }

  const files = Array.isArray(config.files) ? [...new Set(config.files)] : [];
  if (files.length === 0) {
    throw new Error(
      `The project ${configPath} selected zero root files; check the tsconfig `
        + '(its "files"/"include" globs, "exclude", and every "extends" target must resolve).',
    );
  }

  const configDir = dirname(configPath);
  const realConfigDir = realPathOrSelf(configDir);
  const keys = new Set();
  for (const file of files) {
    keys.add(pathKey(resolve(configDir, file)));
    keys.add(pathKey(resolve(realConfigDir, file)));
  }
  return { configPath, count: files.length, keys };
}

/**
 * Refuse an entry that the selected project does not select.
 *
 * ttsx compiles the whole project and then looks for the entry's emitted
 * JavaScript. For an entry outside the project's file set the lookup falls back
 * to trailing-path-stem matching, so `native-plugins/x/src/foo.test.ts` can be
 * answered with the emit of `adapters/y/src/foo.test.ts` and that other file
 * runs under the requested entry's URL. Failing here, before anything is
 * compiled, makes that substitution impossible: every entry runs inside a
 * project that selects it. This is deliberately narrower than ttsc's own
 * entry-only fallback build; this repository does not use that lane.
 */
export function assertEntryInProject({ tsgoBinary, project, entry, cwd = process.cwd() }) {
  const sourceEntry = resolve(cwd, entry);
  const { configPath, count, keys } = resolveProjectRootFiles({ tsgoBinary, project, cwd });

  if (keys.has(pathKey(sourceEntry)) || keys.has(pathKey(realPathOrSelf(sourceEntry)))) {
    return;
  }

  throw new Error([
    `ttsx entry is not part of the selected project: ${displayPath(sourceEntry, cwd)}`,
    `  project: ${displayPath(configPath, cwd)} (${count} root file${count === 1 ? '' : 's'})`,
    'An entry outside its project may run another file with the same trailing path stem,',
    'so the runner refuses it. Pass --project <tsconfig that includes the entry> (or set',
    'TTSC_PROJECT), or add the entry to that project\'s "include"/"files".',
  ].join('\n'));
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function realPathOrSelf(path) {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

function pathKey(path) {
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

function displayPath(path, cwd) {
  const relativePath = relative(cwd, path);
  return relativePath === '' || relativePath.startsWith('..') || isAbsolute(relativePath) ? path : relativePath;
}
