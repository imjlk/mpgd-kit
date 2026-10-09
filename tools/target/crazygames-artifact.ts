import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Submission limits apply to uncompressed uploaded game files. Initial download still needs portal profiling. */
export function assertCrazyGamesArtifact(root: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  function visit(directory: string): void {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (stat.isDirectory()) {
        visit(path);
      } else if (stat.isFile()) {
        files += 1;
        bytes += stat.size;
      } else {
        throw new Error('CrazyGames artifacts must contain regular files and directories.');
      }
    }
  }
  visit(root);
  if (files > 1500 || bytes > 250_000_000) {
    throw new Error('CrazyGames submission exceeds 1500 files or 250 MB.');
  }
  const index = readFileSync(join(root, 'index.html'), 'utf8');
  for (const match of index.matchAll(
    /\b(?:src|href)\s*=\s*(?:["']([^"']+)["']|([^\s"'`=<>]+))/giu,
  )) {
    const path = match[1] ?? match[2];
    if (path?.startsWith('/') || /^https?:/iu.test(path ?? '')) {
      throw new Error('CrazyGames index assets must use relative paths.');
    }
  }
  return { files, bytes };
}
