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
  /** For a store that reports only SHA-1. */
  readonly sha1: string;
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
    sha1: createHash('sha1').update(bytes).digest('hex'),
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

/** CRLF and lone CR as LF, so a file saved on Windows and the store's text compare equal. */
export function normalizeLineBreaks(value: string): string {
  return value.replace(/\r\n?/gu, '\n');
}

/**
 * Two URLs that differ only in form (host case, a trailing slash, default
 * port): a store may normalize the URL it was given.
 */
export function sameUrlForm(left: string, right: string): boolean {
  const normal = (value: string): string | undefined => {
    try {
      return new URL(value).href.replace(/\/$/u, '');
    } catch {
      return undefined;
    }
  };
  const a = normal(left);
  return a !== undefined && a === normal(right);
}

/** Compares after normalizing line breaks; `to` is expected normalized already. */
export function describeTextChange(
  field: string,
  from: string | null | undefined,
  to: string,
): StorePresenceTextChange | undefined {
  const before = typeof from === 'string' ? normalizeLineBreaks(from) : null;
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

/** One image the store holds, by its ID and the digest the store reports for it. */
export interface RemoteStoreImage {
  readonly id: string;
  /** Lowercase hex; empty when the store reports none. */
  readonly digest: string;
}

export interface StoreImageSetPlan {
  /** `add` uploads after the store's images; `replace` deletes the store's first. */
  readonly action: 'unchanged' | 'add' | 'replace';
  /** Uploads, in order. */
  readonly upload: readonly { readonly path: string; readonly digest: string }[];
  /** Digests of the store's images that stay. */
  readonly keep: readonly string[];
  /** The store's images the write removes and does not upload again. */
  readonly remove: readonly RemoteStoreImage[];
  readonly notes: readonly string[];
}

/**
 * Plan one image slot. A single-image slot (an icon) is replaced when it
 * differs. A list adds the images the store lacks after the ones it holds;
 * a complete set appends when the store holds a prefix of it, else replaces
 * the slot so the store holds exactly the set in order.
 */
export function planStoreImageSet(input: {
  readonly local: readonly { readonly path: string; readonly digest: string }[];
  readonly remote: readonly RemoteStoreImage[];
  readonly complete: boolean;
  readonly single: boolean;
  readonly maxImages: number;
  /** For messages: the slot, for example "Google Play phoneScreenshots". */
  readonly label: string;
  /** For messages: "Play" or "App Store Connect". */
  readonly storeName: string;
}): StoreImageSetPlan {
  const { local, remote, storeName } = input;
  const remoteDigests = remote.map((image) => image.digest);
  const desiredDigests = local.map((image) => image.digest);
  const notes: string[] = [];
  const unchanged = (): StoreImageSetPlan => ({
    action: 'unchanged',
    upload: [],
    keep: remoteDigests,
    remove: [],
    notes,
  });
  const replace = (): StoreImageSetPlan => ({
    action: 'replace',
    upload: local,
    keep: [],
    remove: remote.filter((image) => !desiredDigests.includes(image.digest)),
    notes,
  });
  const same = remoteDigests.length === desiredDigests.length
    && remoteDigests.every((digest, index) => digest === desiredDigests[index]);
  if (same) {
    return unchanged();
  }
  if (input.single) {
    return remote.length === 0
      ? { action: 'add', upload: local, keep: [], remove: [], notes }
      : replace();
  }
  const isPrefix = remoteDigests.length < desiredDigests.length
    && remoteDigests.every((digest, index) => digest === desiredDigests[index]);
  if (input.complete && !isPrefix) {
    if (remote.some((image) => desiredDigests.includes(image.digest))) {
      notes.push(
        `${storeName}'s images are deleted and the set uploaded again in the file's order.`,
      );
    }
    return replace();
  }
  const missing = local.filter((image) => !remoteDigests.includes(image.digest));
  if (missing.length === 0) {
    notes.push(
      `${storeName} holds the file's images in another order or with others; mark the set complete to match it.`,
    );
    return unchanged();
  }
  if (remote.length + missing.length > input.maxImages) {
    throw new Error(
      `${input.label}: ${storeName} holds ${remote.length} and the file adds ${missing.length}; a set takes at `
      + `most ${input.maxImages}. Mark the set complete to replace ${storeName}'s images.`,
    );
  }
  const kept = remote.length - (local.length - missing.length);
  if (!input.complete && kept > 0) {
    notes.push(`${storeName} keeps ${kept} image(s) the file does not list.`);
  }
  return { action: 'add', upload: missing, keep: remoteDigests, remove: [], notes };
}
