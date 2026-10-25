import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface LegalSiteFile {
  readonly file: string;
  readonly content: string;
}

/**
 * Legal-site paths are contained only after the nearest existing ancestor is
 * canonicalized. A lexical `path.relative` check treats a symlinked `artifacts`
 * directory as inside the project while later writes follow the link.
 */
export function assertLegalProjectPath(label: string, resolved: string): void {
  const lexicalRoot = process.cwd();
  const lexical = path.relative(lexicalRoot, resolved);
  if (lexical.startsWith('..') || path.isAbsolute(lexical)) {
    throw new Error(`${label} must be inside the project root: ${resolved}`);
  }
  assertNoLegalSymlink(lexicalRoot, resolved, label);
  const canonicalRoot = realpathSync(lexicalRoot);
  const canonical = realpathBestEffort(resolved);
  const canonicalRelative = path.relative(canonicalRoot, canonical);
  if (canonicalRelative.startsWith('..') || path.isAbsolute(canonicalRelative)) {
    throw new Error(`${label} must be inside the project root: ${resolved}`);
  }
}

/** Stage the site beside the destination, then publish with rename. */
export function publishLegalSiteFiles(outDir: string, outputs: readonly LegalSiteFile[]): void {
  assertLegalProjectPath('out-dir', outDir);
  // A temp dir on the project root is a different filesystem when out-dir is a
  // mount or sits under a bind-mounted artifacts directory. Rename then fails
  // with EXDEV. Stage on the destination filesystem instead.
  const staging = path.join(legalStagingParent(outDir), `.mpgd-legal-${randomUUID()}`);
  let publishedDirectory = false;
  try {
    for (const output of outputs) {
      const relative = path.relative(outDir, output.file);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`Legal site output escapes the output directory: ${output.file}`);
      }
      const staged = path.join(staging, relative);
      mkdirSync(path.dirname(staged), { recursive: true });
      writeFileSync(staged, output.content, { flag: 'wx' });
    }
    assertLegalProjectPath('out-dir', outDir);
    let existing: ReturnType<typeof lstatSync> | undefined;
    try {
      existing = lstatSync(outDir);
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) {
        throw error;
      }
    }
    if (existing?.isSymbolicLink() === true) {
      throw new Error(`Refusing to write legal site output through a symbolic link: ${outDir}`);
    }
    if (existing === undefined) {
      ensureLegalDirectory(path.dirname(outDir));
      assertLegalProjectPath('out-dir', outDir);
      renameSync(staging, outDir);
      publishedDirectory = true;
      return;
    }
    if (!existing.isDirectory()) {
      throw new Error(`Legal site output path is not a directory: ${outDir}`);
    }
    for (const output of outputs) {
      assertNoLegalSymlink(process.cwd(), output.file, 'out-dir');
      ensureLegalDirectory(path.dirname(output.file));
      assertNoLegalSymlink(process.cwd(), output.file, 'out-dir');
      renameSync(path.join(staging, path.relative(outDir, output.file)), output.file);
    }
  } finally {
    if (!publishedDirectory) {
      rmSync(staging, { recursive: true, force: true });
    }
  }
}

/**
 * Parent for the staging directory. An existing out-dir may itself be a mount,
 * so stage inside it. A missing out-dir is created on its nearest existing
 * ancestor, which is the filesystem the later rename must stay on.
 */
function legalStagingParent(outDir: string): string {
  const existing = lstatIfPresent(outDir);
  if (existing !== undefined) {
    if (existing.isSymbolicLink()) {
      throw new Error(`Refusing to write legal site output through a symbolic link: ${outDir}`);
    }
    if (!existing.isDirectory()) {
      throw new Error(`Legal site output path is not a directory: ${outDir}`);
    }
    return outDir;
  }
  let current = path.dirname(outDir);
  for (;;) {
    const stat = lstatIfPresent(current);
    if (stat !== undefined) {
      if (stat.isSymbolicLink()) {
        throw new Error(`Refusing to write legal site output through a symbolic link: ${current}`);
      }
      if (!stat.isDirectory()) {
        throw new Error(`Legal site output path is not a directory: ${current}`);
      }
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`out-dir must be inside the project root: ${outDir}`);
    }
    current = parent;
  }
}

function lstatIfPresent(target: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(target);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      return undefined;
    }
    throw error;
  }
}

/** Resolve symlinks for the longest existing ancestor, keeping the remainder. */
function realpathBestEffort(target: string): string {
  // lstat-based existence stops the walk at dangling symlinks, so realpath
  // fails closed on them instead of lexically skipping the link.
  const exists = (candidate: string): boolean => {
    try {
      lstatSync(candidate);
      return true;
    } catch {
      return false;
    }
  };
  let existing = target;
  while (!exists(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) {
      return existing;
    }
    existing = parent;
  }
  let real: string;
  try {
    real = realpathSync(existing);
  } catch (error) {
    throw new Error(`Legal site path resolves through a broken symbolic link: ${target}`, {
      cause: error,
    });
  }
  return existing === target ? real : path.resolve(real, path.relative(existing, target));
}

function assertNoLegalSymlink(root: string, target: string, label: string): void {
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} must be inside the project root: ${target}`);
  }
  const verb = label === 'out-dir' ? 'write legal site output' : 'read legal sources';
  let current = root;
  for (const part of relative.split(path.sep)) {
    if (part === '' || part === '.') {
      continue;
    }
    current = path.join(current, part);
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if (isErrno(error, 'ENOENT')) {
        return;
      }
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing to ${verb} through a symbolic link: ${current}`);
    }
  }
}

function ensureLegalDirectory(directory: string): void {
  const root = process.cwd();
  const relative = path.relative(root, directory);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`out-dir must be inside the project root: ${directory}`);
  }
  if (relative === '') {
    return;
  }
  let current = root;
  for (const part of relative.split(path.sep)) {
    if (part === '' || part === '.') {
      continue;
    }
    current = path.join(current, part);
    let stat: ReturnType<typeof lstatSync> | undefined;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) {
        throw error;
      }
      try {
        mkdirSync(current);
        continue;
      } catch (mkdirError) {
        if (!isErrno(mkdirError, 'EEXIST')) {
          throw mkdirError;
        }
        stat = lstatSync(current);
      }
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing to write legal site output through a symbolic link: ${current}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`Legal site output path is not a directory: ${current}`);
    }
  }
}

function isErrno(error: unknown, code: string): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === code;
}

/**
 * Google's AdMob line for `app-ads.txt` (`f08c47fec0942fa0` is Google's
 * certification authority ID). AdMob shows the exact line for an account
 * under Apps > View all apps > app-ads.txt; use a game-owned
 * `legal/app-ads.txt` instead when it differs or mediation partners add lines.
 */
export function admobAppAdsTxtLine(publisherId: string): string {
  if (!/^pub-\d{16}$/u.test(publisherId)) {
    throw new Error('mpgd.game.json ads.admob.publisherId must look like pub-0000000000000000.');
  }
  return `google.com, ${publisherId}, DIRECT, f08c47fec0942fa0`;
}

/**
 * The `app-ads.txt` the legal site serves at its root, or undefined: a
 * game-owned `<legal-dir>/app-ads.txt` verbatim, else the AdMob line for
 * `ads.admob.publisherId` in the game's `mpgd.game.json`. Store listings
 * name this site as the developer website (Play) or marketing URL (App
 * Store), which is where ad buyers look for the file.
 */
export function resolveAppAdsTxt(input: {
  readonly ownFile?: string;
  readonly gameConfig?: unknown;
}): string | undefined {
  if (input.ownFile !== undefined) {
    if (input.ownFile.trim().length === 0) {
      throw new Error('app-ads.txt in the legal directory is empty.');
    }
    return input.ownFile.endsWith('\n') ? input.ownFile : `${input.ownFile}\n`;
  }
  const config = input.gameConfig;
  if (typeof config !== 'object' || config === null || !('ads' in config)) {
    return undefined;
  }
  const ads = (config as { readonly ads?: unknown }).ads;
  const admob = typeof ads === 'object' && ads !== null
    ? (ads as { readonly admob?: unknown }).admob
    : undefined;
  const publisherId = typeof admob === 'object' && admob !== null
    ? (admob as { readonly publisherId?: unknown }).publisherId
    : undefined;
  if (publisherId === undefined) {
    return undefined;
  }
  if (typeof publisherId !== 'string') {
    throw new Error('mpgd.game.json ads.admob.publisherId must be a string.');
  }
  return `${admobAppAdsTxtLine(publisherId)}\n`;
}
