import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * One output path written by more than one source in a Devvit web build.
 *
 * `public` means a file from a public directory was silently replaced by a
 * Vite-emitted file of the same name (Vite copies `publicDir` first and then
 * writes the bundle over it). `case` means two output files differ only by
 * letter case, which collapse into one on case-insensitive filesystems and in
 * the Devvit upload.
 */
export interface DevvitOutputCollision {
  readonly kind: 'public' | 'case';
  readonly path: string;
  readonly sources: readonly string[];
}

function listFiles(root: string): string[] {
  const out: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop() as string;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(absolute);
      } else if (entry.isFile() || (entry.isSymbolicLink() && !lstatSync(absolute).isDirectory())) {
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
  if (collisions.length === 0) {
    return;
  }
  const lines = collisions.map((collision) => collision.kind === 'public'
    ? `  - ${collision.path}: ${collision.sources[0]} was overwritten by a bundle file of the same name`
    : `  - ${collision.sources.join(', ')}: names differ only by case`);
  throw new Error([
    `Devvit build output has ${collisions.length} conflicting file name(s) in ${outDir}:`,
    ...lines,
    'Rename the public file or the entry/chunk (Devvit client output uses unhashed [name].js names),'
      + ' then rebuild.',
  ].join('\n'));
}
