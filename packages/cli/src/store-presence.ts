import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

import {
  assertStorePresence,
  assertStorePresenceImage,
  readStoreImageInfo,
  type StoreImageInfo,
  type StorePresence,
  type StorePresenceImageSlot,
} from '@mpgd/catalog';

import { readJsonFile, StorePlanStaleError } from './store-sync.js';

/**
 * The game side of `mpgd store presence plan|apply`: the store presence
 * file and the graphics it names, read and checked against the store rules
 * before anything talks to a store.
 */

export const defaultStorePresenceFileName = 'mpgd.store-presence.json';
export const storePresencePlanCommand = 'mpgd store presence plan';

export interface StorePresenceSource {
  readonly file: string;
  /** Graphics paths resolve against this directory. */
  readonly directory: string;
  readonly presence: StorePresence;
}

/**
 * Read and validate the store presence file. A given path resolves against
 * the current directory, like the other mpgd file flags; the default is the
 * game's own file.
 */
export function readStorePresenceSource(input: {
  readonly gameRoot: string;
  readonly presenceFile?: string;
}): StorePresenceSource {
  const file = input.presenceFile === undefined
    ? path.join(path.resolve(input.gameRoot), defaultStorePresenceFileName)
    : path.resolve(input.presenceFile);
  if (!existsSync(file)) {
    throw new Error(`Store presence sync needs ${file}.`);
  }
  return { file, directory: path.dirname(file), presence: assertStorePresence(readJsonFile(file)) };
}

/** One graphic the file names, read from this checkout. */
export interface LocalStoreImage {
  /** Path relative to the store presence file, as the file names it. */
  readonly path: string;
  /** Absolute path on this checkout. */
  readonly file: string;
  readonly sha256: string;
  readonly md5: string;
  readonly byteLength: number;
  readonly info: StoreImageInfo;
}

/**
 * Read one graphic: it must stay inside the file's directory (symbolic links
 * included), be the PNG or JPEG its extension says, and meet the store's
 * rules for its slot.
 */
export function readLocalStoreImage(
  directory: string,
  relative: string,
  target: StorePresenceImageSlot,
  label: string,
): LocalStoreImage {
  const file = path.resolve(directory, relative);
  if (!existsSync(file) || !statSync(file).isFile()) {
    throw new Error(`${label}: ${relative} is missing.`);
  }
  const real = path.relative(realpathSync(directory), realpathSync(file));
  if (real === '..' || real.startsWith(`..${path.sep}`) || path.isAbsolute(real)) {
    throw new Error(`${label}: ${relative} resolves outside the store presence file's directory.`);
  }
  const bytes = readFileSync(file);
  let info: StoreImageInfo;
  try {
    info = readStoreImageInfo(bytes);
  } catch (error) {
    throw new Error(`${label}: ${relative} is ${(error as Error).message}.`);
  }
  const extensionFormat = /\.png$/iu.test(relative) ? 'png' : 'jpeg';
  if (info.format !== extensionFormat) {
    throw new Error(
      `${label}: ${relative} is a ${info.format} file with a .${path.extname(relative).slice(1)} name.`,
    );
  }
  assertStorePresenceImage(target, info, bytes.byteLength, `${label}: ${relative}`);
  return {
    path: relative,
    file,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    md5: createHash('md5').update(bytes).digest('hex'),
    byteLength: bytes.byteLength,
    info,
  };
}

/** Refuse to upload a graphic whose bytes changed after the plan was checked. */
export function assertLocalStoreImageUnchanged(file: string, sha256: string): void {
  const current = createHash('sha256').update(readFileSync(file)).digest('hex');
  if (current !== sha256) {
    throw new StorePlanStaleError(`${file} changed since the plan.`, storePresencePlanCommand);
  }
}

export function imageMimeType(info: StoreImageInfo): 'image/png' | 'image/jpeg' {
  return info.format === 'png' ? 'image/png' : 'image/jpeg';
}

/**
 * A text field change for the plan output: lengths always, the texts
 * themselves only while both are short.
 */
export interface StorePresenceTextChange {
  readonly field: string;
  readonly fromLength: number | null;
  readonly toLength: number;
  readonly from?: string;
  readonly to?: string;
}

const shortText = 80;

export function describeTextChange(
  field: string,
  from: string | null | undefined,
  to: string,
): StorePresenceTextChange | undefined {
  const before = typeof from === 'string' ? from : null;
  if (before === to) {
    return undefined;
  }
  const short = (value: string | null): boolean => value === null || [...value].length <= shortText;
  return {
    field,
    fromLength: before === null ? null : [...before].length,
    toLength: [...to].length,
    ...(short(before) && short(to) ? { ...(before === null ? {} : { from: before }), to } : {}),
  };
}

export function formatTextChange(change: StorePresenceTextChange): string {
  const lengths = `${change.fromLength === null ? 'new' : `${change.fromLength} chars`} -> ${change.toLength} chars`;
  if (change.to === undefined) {
    return `${change.field}: ${lengths}`;
  }
  return `${change.field}: ${JSON.stringify(change.from ?? null)} -> ${JSON.stringify(change.to)}`;
}
