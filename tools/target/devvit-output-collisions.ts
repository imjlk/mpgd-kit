import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import type { Plugin } from 'vite';

/**
 * One output path written by more than one source in a Devvit web build.
 *
 * `public` means a file from a public directory was silently replaced by a
 * Vite-emitted file of the same name (Vite copies `publicDir` first and then
 * writes the bundle over it). `case` means two output files differ only by
 * letter case. The build plugin checks bundle names before writing so this
 * also works on case-insensitive filesystems.
 */
export interface DevvitOutputCollision {
  readonly kind: 'public' | 'case';
  readonly path: string;
  readonly sources: readonly string[];
}

/** Validate logical output names before the filesystem can collapse them. */
export function assertDevvitOutputNames(
  bundleNames: readonly string[],
  publicNames: readonly string[],
  outDir: string,
): void {
  const collisions: DevvitOutputCollision[] = [];
  const names = new Map<string, string>();
  for (const name of [...publicNames, ...bundleNames]) {
    const previous = names.get(name.toLowerCase());
    if (previous !== undefined) {
      collisions.push({
        kind: previous === name ? 'public' : 'case',
        path: name,
        sources: [previous, name],
      });
    }
    names.set(name.toLowerCase(), name);
  }
  throwCollisions(collisions, outDir);
}

export function devvitOutputCollisionPlugin(): Plugin {
  let publicDir = '';
  return {
    name: 'mpgd-devvit-output-collisions',
    apply: 'build',
    enforce: 'post',
    configResolved(config) {
      publicDir = config.publicDir;
    },
    generateBundle: {
      order: 'post',
      handler(options, bundle) {
        const publicNames = this.environment.config.build.copyPublicDir
          && publicDir !== '' && existsSync(publicDir) ? listFiles(publicDir) : [];
        assertDevvitOutputNames(
          Object.values(bundle).map((output) => output.fileName),
          publicNames,
          options.dir ?? this.environment.config.build.outDir,
        );
      },
    },
  };
}

function listFiles(root: string): string[] {
  const out: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop() as string;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      // Follow symlinks: a linked directory is traversed, a linked file listed.
      const stats = entry.isSymbolicLink() ? statSync(absolute, { throwIfNoEntry: false }) : entry;
      if (stats === undefined) {
        continue;
      }
      if (stats.isDirectory()) {
        pending.push(absolute);
      } else if (stats.isFile()) {
        out.push(relative(root, absolute).split(sep).join('/'));
      }
    }
  }
  return out.sort();
}

/**
 * Finds output files of a Devvit client build that were overwritten or that
 * collide by case. `publicDirs` are the directories Vite copied verbatim.
 */
export function findDevvitOutputCollisions(
  outDir: string,
  publicDirs: readonly string[],
): DevvitOutputCollision[] {
  if (!existsSync(outDir)) {
    return [];
  }
  const outputs = listFiles(outDir);
  const collisions: DevvitOutputCollision[] = [];

  for (const publicDir of publicDirs) {
    if (!existsSync(publicDir)) {
      continue;
    }
    for (const file of listFiles(publicDir)) {
      const output = join(outDir, file);
      if (!existsSync(output)) {
        continue;
      }
      if (!readFileSync(output).equals(readFileSync(join(publicDir, file)))) {
        collisions.push({
          kind: 'public',
          path: file,
          sources: [join(publicDir, file), 'vite bundle output'],
        });
      }
    }
  }

  const byLowerCase = new Map<string, string[]>();
  for (const file of outputs) {
    const key = file.toLowerCase();
    byLowerCase.set(key, [...(byLowerCase.get(key) ?? []), file]);
  }
  for (const files of byLowerCase.values()) {
    if (files.length > 1) {
      collisions.push({ kind: 'case', path: files[0] as string, sources: files });
    }
  }
  return collisions;
}

/** Throws a single readable error listing every collision. */
export function assertNoDevvitOutputCollisions(
  outDir: string,
  publicDirs: readonly string[],
): void {
  const collisions = findDevvitOutputCollisions(outDir, publicDirs);
  throwCollisions(collisions, outDir);
}

function throwCollisions(collisions: readonly DevvitOutputCollision[], outDir: string): void {
  if (collisions.length === 0) {
    return;
  }
  const lines = collisions.map((collision) =>
    collision.kind === 'public'
      ? `  - ${collision.path}: public and bundle files use the same output name`
      : `  - ${collision.sources.join(', ')}: names differ only by case`,
  );
  throw new Error([
    `Devvit build output has ${collisions.length} conflicting file name(s) in ${outDir}:`,
    ...lines,
    'Rename the public file or the entry/chunk (Devvit client output uses unhashed [name].js names),'
      + ' then rebuild.',
  ].join('\n'));
}
