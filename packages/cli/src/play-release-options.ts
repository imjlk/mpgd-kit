import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import type { PlayLocalizedText, PlayTrackRelease } from './play-publisher-port.js';

/**
 * Android Publisher v3 `Release.status` values the kit writes. `halted` is set
 * only on an existing rollout (`mpgd deploy rollout --action halt`): a new
 * bundle cannot start out halted.
 * https://developers.google.com/android-publisher/api-ref/rest/v3/edits.tracks#status
 */
export type PlayReleaseStatus = 'draft' | 'completed' | 'inProgress' | 'halted';
export type PlayNewReleaseStatus = Exclude<PlayReleaseStatus, 'halted'>;

/** The kit's original destination; Play's tracks guide also lists this track as `qa`. */
export const defaultPlayTrack = 'internal';
/** Play Console: "up to 500 Unicode characters per language". */
export const maximumPlayReleaseNoteCharacters = 500;
const maximumReleaseNotesFileBytes = 256 * 1024;
// A default name (`production`, `beta`, `alpha`, `internal`, `qa`), a custom
// closed-testing track name, or either behind a form-factor prefix
// (`wear:production`). Path-unsafe characters are refused before any request.
const trackNamePattern = /^(?:[a-z][a-z0-9_]{0,31}:)?[A-Za-z0-9](?:[A-Za-z0-9 ._-]{0,98}[A-Za-z0-9._-])?$/u;
const wellKnownTrackPattern = /^(?:[a-z][a-z0-9_]*:)?(?:internal|qa|alpha|beta|production)$/iu;
const languageTagPattern = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;

/** What one `deploy submit`/`deploy run` asks Play to do with the new bundle. */
export interface PlayReleaseRequest {
  readonly track: string;
  readonly status: PlayNewReleaseStatus;
  /** Required for `inProgress`: 0 < fraction < 1. */
  readonly userFraction?: number;
  readonly releaseNotes?: readonly PlayReleaseNote[];
  /** Absolute path of an R8/ProGuard `mapping.txt` for this exact build. */
  readonly mappingFile?: string;
  /** SHA-256 of `mappingFile`, fixed when the request is created. */
  readonly mappingSha256?: string;
}

export interface PlayReleaseNote {
  readonly language: string;
  readonly text: string;
}

export const defaultPlayReleaseRequest: PlayReleaseRequest = Object.freeze({
  track: defaultPlayTrack,
  status: 'completed',
});

export interface CreatePlayReleaseRequestInput {
  readonly track?: string | undefined;
  readonly status?: string | undefined;
  readonly userFraction?: string | number | undefined;
  readonly releaseNotesFile?: string | undefined;
  readonly mappingFile?: string | undefined;
}

/** Validate CLI release options; with none it returns the internal/completed default. */
export async function createPlayReleaseRequest(
  input: CreatePlayReleaseRequestInput,
): Promise<PlayReleaseRequest> {
  const track = input.track ?? defaultPlayTrack;
  const status = input.status ?? 'completed';
  if (status === 'halted') {
    throw new Error(
      'A new Google Play release cannot start halted; use "mpgd deploy rollout --action halt" '
      + 'on the release once it is in progress.',
    );
  }
  if (status !== 'draft' && status !== 'completed' && status !== 'inProgress') {
    throw new Error('--status must be draft, completed or inProgress.');
  }
  const userFraction = input.userFraction === undefined
    ? undefined
    : parsePlayUserFraction(input.userFraction);
  const releaseNotes = input.releaseNotesFile === undefined
    ? undefined
    : readPlayReleaseNotesFile(input.releaseNotesFile);
  let mapping: { readonly mappingFile: string; readonly mappingSha256: string } | undefined;
  if (input.mappingFile !== undefined) {
    const mappingFile = path.resolve(input.mappingFile);
    mapping = { mappingFile, mappingSha256: await hashMappingFile(mappingFile) };
  }
  const request: PlayReleaseRequest = {
    track,
    status,
    ...(userFraction === undefined ? {} : { userFraction }),
    ...(releaseNotes === undefined ? {} : { releaseNotes }),
    ...(mapping ?? {}),
  };
  assertPlayReleaseRequest(request);
  return request;
}

/** Re-check a programmatic request; the CLI path builds it with createPlayReleaseRequest. */
export function assertPlayReleaseRequest(request: PlayReleaseRequest): void {
  assertPlayTrackName(request.track);
  if (request.status !== 'draft' && request.status !== 'completed'
    && request.status !== 'inProgress') {
    throw new Error('Google Play release status must be draft, completed or inProgress.');
  }
  if (request.status === 'inProgress') {
    if (request.userFraction === undefined) {
      throw new Error('An inProgress (staged) Google Play release needs --user-fraction.');
    }
    assertPlayUserFraction(request.userFraction);
  } else if (request.userFraction !== undefined) {
    throw new Error('--user-fraction applies only to an inProgress (staged) release.');
  }
  if (request.releaseNotes !== undefined) {
    assertPlayReleaseNotes(request.releaseNotes);
  }
  if ((request.mappingFile === undefined) !== (request.mappingSha256 === undefined)
    || (request.mappingFile !== undefined && !path.isAbsolute(request.mappingFile))
    || (request.mappingSha256 !== undefined && !sha256Pattern.test(request.mappingSha256))) {
    throw new Error('Google Play mapping file must be an absolute path with its SHA-256.');
  }
}

export function assertPlayTrackName(track: string): void {
  if (!trackNamePattern.test(track)) {
    throw new Error(
      'Google Play track must be internal, alpha, beta, production, or a closed-testing '
      + 'track name (letters, digits, space, ".", "_", "-"; optional form-factor prefix).',
    );
  }
}

/** `production` and form-factor production tracks such as `wear:production`. */
export function isProductionTrack(track: string): boolean {
  // Case-insensitive, so `Production` is never treated as a testing track.
  return /^(?:[a-z][a-z0-9_]*:)?production$/iu.test(track.trim());
}

/**
 * A default track (`internal`/`qa`, `alpha`, `beta`, `production`, optionally
 * form-factor prefixed). Other names are closed-testing tracks, which "are
 * created manually", so a missing one is a typo rather than an empty track.
 */
export function isWellKnownPlayTrack(track: string): boolean {
  return wellKnownTrackPattern.test(track);
}

/** Production releases and every staged rollout need an explicit confirmation flag. */
export function playReleaseNeedsConfirmation(request: Pick<PlayReleaseRequest, 'track' | 'status'>): boolean {
  return isProductionTrack(request.track) || request.status === 'inProgress';
}

export function assertPlayReleaseConfirmed(
  request: Pick<PlayReleaseRequest, 'track' | 'status'>,
  confirmed: boolean,
): void {
  if (playReleaseNeedsConfirmation(request) && !confirmed) {
    throw new Error(
      `Google Play ${request.track} ${request.status} release needs --confirm-production: `
      + 'production releases and staged rollouts are never made without it.',
    );
  }
}

export function isDefaultPlayReleaseRequest(request: PlayReleaseRequest): boolean {
  return request.track === defaultPlayTrack && request.status === 'completed'
    && request.userFraction === undefined && request.releaseNotes === undefined
    && request.mappingFile === undefined;
}

/**
 * Binds a submission checkpoint to the release options that started it, so a
 * resumed edit is never committed with another track or status. The original
 * internal/completed request has no digest, which keeps its checkpoints as before.
 */
export function playReleaseRequestDigest(request: PlayReleaseRequest): string | undefined {
  if (isDefaultPlayReleaseRequest(request)) {
    return undefined;
  }
  return createHash('sha256').update(JSON.stringify({
    track: request.track,
    status: request.status,
    userFraction: request.userFraction ?? null,
    releaseNotes: request.releaseNotes ?? [],
    mappingSha256: request.mappingSha256 ?? null,
  })).digest('hex');
}

export function parsePlayUserFraction(value: string | number): number {
  const fraction = typeof value === 'number'
    ? value
    : /^(?:0(?:\.\d+)?|\.\d+|1(?:\.0+)?)$/u.test(value.trim())
      ? Number(value)
      : Number.NaN;
  assertPlayUserFraction(fraction);
  return fraction;
}

/** Android Publisher v3 `Release.userFraction`: "0 < fraction < 1". */
export function assertPlayUserFraction(fraction: number): void {
  if (!Number.isFinite(fraction) || fraction <= 0 || fraction >= 1) {
    throw new Error(
      '--user-fraction must be a number greater than 0 and less than 1 (for example 0.05); '
      + 'use --status completed (or --action complete) for 100%.',
    );
  }
}

export function readPlayReleaseNotesFile(file: string): PlayReleaseNote[] {
  const notes = readLocalizedNotesFile(file);
  assertPlayReleaseNoteLengths(notes);
  return notes;
}

/**
 * A per-language notes file in the release-notes format below, without a
 * store's length limit; `label` names the notes in errors. TestFlight's
 * "What to Test" (`mpgd deploy testflight distribute --what-to-test`) reads
 * the same file format as Google Play release notes.
 */
export function readLocalizedNotesFile(file: string, label = 'Release notes'): PlayReleaseNote[] {
  const resolved = path.resolve(file);
  if (!existsSync(resolved) || !statSync(resolved).isFile()) {
    throw new Error(`${label} file is missing: ${resolved}`);
  }
  if (statSync(resolved).size > maximumReleaseNotesFileBytes) {
    throw new Error(`${label} file is larger than 256 KiB.`);
  }
  return parseLocalizedNotes(readFileSync(resolved, 'utf8'), label);
}

/**
 * Accepts the Play Console's own language-tag format, one block per language:
 *
 *     <en-US>
 *     Bug fixes.
 *     </en-US>
 *
 * or JSON: `{ "en-US": "Bug fixes." }` or `[{ "language": "en-US", "text": "Bug fixes." }]`.
 */
export function parsePlayReleaseNotes(source: string): PlayReleaseNote[] {
  const notes = parseLocalizedNotes(source);
  assertPlayReleaseNoteLengths(notes);
  return notes;
}

/** `parsePlayReleaseNotes` without Google Play's length limit. */
export function parseLocalizedNotes(source: string, label = 'Release notes'): PlayReleaseNote[] {
  const content = source.replace(/^﻿/u, '');
  const trimmed = content.trim();
  if (trimmed === '') {
    throw new Error(`${label} file is empty.`);
  }
  let notes: PlayReleaseNote[];
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error(`${label} JSON is malformed.`);
    }
    notes = Array.isArray(parsed)
      ? parsed.map((entry) => {
        if (typeof entry !== 'object' || entry === null
          || typeof (entry as { language?: unknown }).language !== 'string'
          || typeof (entry as { text?: unknown }).text !== 'string'
          || Object.keys(entry).some((key) => key !== 'language' && key !== 'text')) {
          throw new Error(`${label} JSON array entries need only string language and text.`);
        }
        const { language, text } = entry as { language: string; text: string };
        return { language, text: text.trim() };
      })
      : typeof parsed === 'object' && parsed !== null
        ? Object.entries(parsed).map(([language, text]) => {
          if (typeof text !== 'string') {
            throw new Error(`${label} for ${language} must be a string.`);
          }
          return { language, text: text.trim() };
        })
        : [];
  } else {
    notes = [];
    const block = /<([A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*)>([\s\S]*?)<\/\1>/gu;
    let consumed = 0;
    for (const match of content.matchAll(block)) {
      if (content.slice(consumed, match.index).trim() !== '') {
        throw new Error(`${label} text must sit between <language> and </language> tags.`);
      }
      notes.push({ language: match[1] ?? '', text: (match[2] ?? '').trim() });
      consumed = match.index + match[0].length;
    }
    if (content.slice(consumed).trim() !== '') {
      throw new Error(`${label} text must sit between <language> and </language> tags.`);
    }
  }
  assertLocalizedNotes(notes, label);
  return notes;
}

export function assertPlayReleaseNotes(notes: readonly PlayReleaseNote[]): void {
  assertLocalizedNotes(notes, 'Release notes');
  assertPlayReleaseNoteLengths(notes);
}

/** One non-empty text per BCP-47 language, each language once. */
export function assertLocalizedNotes(notes: readonly PlayReleaseNote[], label: string): void {
  if (notes.length === 0) {
    throw new Error(`${label} need at least one language.`);
  }
  const seen = new Set<string>();
  for (const note of notes) {
    if (!languageTagPattern.test(note.language)) {
      throw new Error(`${label} language is not a BCP-47 tag: ${note.language}`);
    }
    const key = note.language.toLowerCase();
    if (seen.has(key)) {
      throw new Error(`${label} repeat the language ${note.language}.`);
    }
    seen.add(key);
    if (note.text.trim() === '') {
      throw new Error(`${label} for ${note.language} are empty.`);
    }
  }
}

function assertPlayReleaseNoteLengths(notes: readonly PlayReleaseNote[]): void {
  for (const note of notes) {
    const length = [...note.text].length;
    if (length > maximumPlayReleaseNoteCharacters) {
      throw new Error(
        `Release notes for ${note.language} are ${length} characters; Google Play allows `
        + `${maximumPlayReleaseNoteCharacters} per language.`,
      );
    }
  }
}

export async function hashMappingFile(mappingFile: string): Promise<string> {
  if (!existsSync(mappingFile) || !statSync(mappingFile).isFile()) {
    throw new Error(`R8 mapping file is missing: ${mappingFile}`);
  }
  if (statSync(mappingFile).size === 0) {
    throw new Error(`R8 mapping file is empty: ${mappingFile}`);
  }
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(mappingFile)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

/** Build the Release body for a new bundle; the default matches the original body exactly. */
export function newPlayRelease(
  request: PlayReleaseRequest,
  name: string,
  versionCode: number,
): PlayTrackRelease {
  return {
    name,
    status: request.status,
    versionCodes: [String(versionCode)],
    ...(request.userFraction === undefined ? {} : { userFraction: request.userFraction }),
    ...(request.releaseNotes === undefined ? {} : {
      releaseNotes: request.releaseNotes.map((note): PlayLocalizedText => ({
        language: note.language,
        text: note.text,
      })),
    }),
  };
}

/**
 * Add a new release to the releases Play returned for the track. Every other
 * release is sent back unchanged, except the ones the new release supersedes:
 * a completed or staged release replaces an in-progress or halted rollout, and
 * a draft replaces an older draft. A track with only completed releases (the
 * usual internal track) therefore gets exactly the original appended body.
 */
export function mergeNewPlayRelease(
  current: readonly PlayTrackRelease[] | null | undefined,
  release: PlayTrackRelease,
): { readonly releases: PlayTrackRelease[]; readonly superseded: PlayTrackRelease[] } {
  const superseded: PlayTrackRelease[] = [];
  const kept: PlayTrackRelease[] = [];
  for (const existing of current ?? []) {
    const replaces = release.status === 'draft'
      ? existing.status === 'draft'
      : existing.status === 'inProgress' || existing.status === 'halted';
    (replaces ? superseded : kept).push(existing);
  }
  return { releases: [...kept, release], superseded };
}

/**
 * The Play Developer API answers "Only releases with status draft may be
 * created on draft app." while an app has never been published. Google's API
 * reference does not document it; it is reported by fastlane, the
 * upload-google-play action and others, on edits.commit. Only a definitive 4xx
 * with that text counts: the edit was not committed.
 */
export function isPlayDraftAppRejection(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const value = error as {
    code?: unknown;
    message?: unknown;
    response?: { status?: unknown; data?: { error?: { message?: unknown } } };
  };
  const raw = value.response?.status ?? value.code;
  const status = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN;
  if (!(status >= 400 && status < 500)) {
    return false;
  }
  const messages = [value.message, value.response?.data?.error?.message]
    .filter((message): message is string => typeof message === 'string');
  return messages.some((message) => /only releases with status draft may be created on draft app/iu
    .test(message));
}
