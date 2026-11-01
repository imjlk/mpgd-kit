import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { join, relative } from 'node:path';

import type { WorkspacePackage } from './workspace';

/**
 * Repository files that change every package build: the build scripts, the
 * lockfile and root manifest, the shared tsconfig, and the ttsc configs that
 * ttsc loads from the root (`@ttsc/lint` and `@ttsc/strip`).
 */
export const packageBuildToolchainFiles = [
  'tools/package/build-packages.ts',
  'tools/package/build-plan.ts',
  'tools/package/build-fingerprint.ts',
  'tools/package/build-scheduler.ts',
  'tools/package/workspace.ts',
  'pnpm-lock.yaml',
  'package.json',
  'tsconfig.base.json',
  'tsconfig.tools.json',
  'tsconfig.package-tools.json',
  'tsconfig.native-build-package.json',
  'lint.config.ts',
  'lint.source.config.ts',
  'strip.config.js',
] as const;

/**
 * Gitignored native build output skipped at any depth of a package's input:
 * a SwiftPM `.build` directory, and a Gradle module's `build` directory (one
 * next to `build.gradle` or `build.gradle.kts`). It is large, depends on local
 * build state and can hold symlinks that do not resolve. A `build` directory
 * anywhere else (`src/build`) is source and stays in the input.
 */
export function isPackageBuildOutputDirectory(parent: string, entry: string): boolean {
  return entry === '.build'
    || (entry === 'build'
      && (existsSync(join(parent, 'build.gradle')) || existsSync(join(parent, 'build.gradle.kts'))));
}

export interface InputFingerprintOptions {
  /** Repository files whose content changes every package build. */
  readonly toolchainFiles: readonly string[];
  /** Extra state for @mpgd/cli; `undefined` means it must always be rebuilt. */
  readonly kitHead: () => string | undefined;
  /** Runtime identity folded into the toolchain hash (defaults to the Node version). */
  readonly runtime?: string;
}

/**
 * Source fingerprints for package builds, computed before anything is built. A
 * package's input covers its own files (without dist, node_modules and native
 * build output), the toolchain files and the fingerprints of its workspace
 * dependencies.
 * `undefined` means "always rebuild" and propagates to dependents.
 */
export function createInputFingerprints(
  available: readonly WorkspacePackage[],
  options: InputFingerprintOptions,
): (name: string) => string | undefined {
  const byName = new Map(
    available.map((workspacePackage) => [workspacePackage.name, workspacePackage]),
  );
  const toolchain = hashParts([
    options.runtime ?? process.version,
    ...options.toolchainFiles.map((path) =>
      `${path}\0${existsSync(path) ? hashFile(path) : 'missing'}`),
  ]);
  const memo = new Map<string, string | undefined>();
  const visiting = new Set<string>();

  return function fingerprint(name: string): string | undefined {
    if (memo.has(name)) {
      return memo.get(name);
    }
    const workspacePackage = byName.get(name);
    if (workspacePackage === undefined || visiting.has(name)) {
      return undefined;
    }

    visiting.add(name);
    const parts = [toolchain];
    let reusable = true;
    if (name === '@mpgd/cli') {
      const kitHead = options.kitHead();
      if (kitHead === undefined) {
        reusable = false;
      } else {
        parts.push(`kit\0${kitHead}`);
      }
    }
    for (const dependency of workspaceDependencyNames(workspacePackage).sort()) {
      if (!reusable || !byName.has(dependency)) {
        continue;
      }
      const dependencyFingerprint = fingerprint(dependency);
      if (dependencyFingerprint === undefined) {
        reusable = false;
      } else {
        parts.push(`${dependency}\0${dependencyFingerprint}`);
      }
    }
    const result = reusable
      ? hashParts([
          ...parts,
          hashTree(workspacePackage.dir, ['dist'], isPackageBuildOutputDirectory),
        ])
      : undefined;
    visiting.delete(name);
    memo.set(name, result);
    return result;
  };
}

export function workspaceDependencyNames(workspacePackage: WorkspacePackage): string[] {
  const { dependencies, devDependencies } = workspacePackage.packageJson;
  const { peerDependencies } = workspacePackage.packageJson as {
    readonly peerDependencies?: Record<string, string>;
  };
  return [
    ...new Set(
      [dependencies, devDependencies, peerDependencies]
        .flatMap((section) => Object.entries(section ?? {}))
        .filter(([, version]) => version.startsWith('workspace:'))
        .map(([dependency]) => dependency),
    ),
  ];
}

/** A recorded build is reusable while its input matches and its dist is untouched. */
export function isReusableBuild(
  recordFile: string,
  inputFingerprint: string | undefined,
  distDir: string,
): boolean {
  if (inputFingerprint === undefined || !existsSync(distDir) || !existsSync(recordFile)) {
    return false;
  }
  try {
    const record = JSON.parse(readFileSync(recordFile, 'utf8')) as {
      readonly input?: unknown;
      readonly dist?: unknown;
    };
    return record.input === inputFingerprint && record.dist === hashTree(distDir);
  } catch {
    return false;
  }
}

export function recordBuild(
  recordFile: string,
  inputFingerprint: string | undefined,
  distDir: string,
): void {
  if (inputFingerprint === undefined) {
    return;
  }
  writeFileSync(
    recordFile,
    `${JSON.stringify({ input: inputFingerprint, dist: hashTree(distDir) }, null, 2)}\n`,
  );
}

/**
 * Hashes every file under root. A symlink that resolves is read through, as a
 * file or a directory, so a change to what it points at changes the hash; a
 * symlink that does not resolve contributes its target string instead of
 * failing the walk. `skip` names top-level entries to leave out and
 * `skipDirectory` picks directories to leave out at any depth.
 */
export function hashTree(
  root: string,
  skip: readonly string[] = [],
  skipDirectory: (parent: string, entry: string) => boolean = () => false,
): string {
  const parts: string[] = [];
  visit(root);
  return hashParts(parts);

  function visit(dir: string): void {
    for (const entry of readdirSync(dir).sort()) {
      if (entry === 'node_modules' || (dir === root && skip.includes(entry))) {
        continue;
      }
      const path = join(dir, entry);
      const relativePath = relative(root, path).split('\\').join('/');
      let stats: Stats;
      try {
        stats = statSync(path);
      } catch (error) {
        if (lstatSync(path).isSymbolicLink()) {
          // A link that does not resolve (SwiftPM leaves some in resource bundles).
          parts.push(`${relativePath}\0link\0${readlinkSync(path)}`);
          continue;
        }
        throw error;
      }
      if (stats.isDirectory()) {
        if (!skipDirectory(dir, entry)) {
          visit(path);
        }
        continue;
      }
      parts.push(`${relativePath}\0${hashFile(path)}`);
    }
  }
}

function hashFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function hashParts(parts: readonly string[]): string {
  const hash = createHash('sha256');
  for (const part of parts) {
    hash.update(part);
    hash.update('\n');
  }
  return hash.digest('hex');
}
