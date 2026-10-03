import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import type { WorkspacePackage } from './workspace';

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
 * package's input covers its own files (without dist and node_modules), the
 * toolchain files and the fingerprints of its workspace dependencies.
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
      ? hashParts([...parts, hashTree(workspacePackage.dir, ['dist'])])
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

/** Hashes every file under root; `skip` names top-level entries to leave out. */
export function hashTree(root: string, skip: readonly string[] = []): string {
  const parts: string[] = [];
  visit(root);
  return hashParts(parts);

  function visit(dir: string): void {
    for (const entry of readdirSync(dir).sort()) {
      if (entry === 'node_modules' || (dir === root && skip.includes(entry))) {
        continue;
      }
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        visit(path);
        continue;
      }
      parts.push(`${relative(root, path).split('\\').join('/')}\0${hashFile(path)}`);
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
