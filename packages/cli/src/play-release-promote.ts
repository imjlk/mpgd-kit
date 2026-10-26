import { existsSync, statSync } from 'node:fs';

import {
  isDefinitiveHttpError,
  isHttpStatus,
  matchesRequestedRelease,
} from './play-internal-submission.js';
import type { PlayPublisher, PlayTrack, PlayTrackRelease } from './play-publisher-port.js';
import {
  assertPlayReleaseConfirmed,
  assertPlayReleaseNotes,
  assertPlayTrackName,
  assertPlayUserFraction,
  isWellKnownPlayTrack,
  mergeNewPlayRelease,
  type PlayNewReleaseStatus,
  type PlayReleaseNote,
} from './play-release-options.js';

/**
 * Promote a release that is already on one track to another track: the
 * target track's `edits.tracks.update` names the existing version codes, and
 * nothing is uploaded. This is the Play Console's "promote release" for the
 * build that passed testing (https://developers.google.com/android-publisher/tracks:
 * a version code uploaded once is released on a track by `Edits.tracks: update`).
 */
export interface PlayPromoteInput {
  readonly packageName: string;
  readonly fromTrack: string;
  readonly toTrack: string;
  /** Selects the source release; defaults to the source track's only completed release. */
  readonly versionCode?: number;
  /** Target release status; defaults to `completed`. */
  readonly status?: PlayNewReleaseStatus;
  /** Required for `inProgress`: 0 < fraction < 1. */
  readonly userFraction?: number;
  /** Defaults to the source release's notes. */
  readonly releaseNotes?: readonly PlayReleaseNote[];
  /** Required for production tracks and staged (inProgress) releases. */
  readonly confirmProduction?: boolean;
  /** Read both tracks in a throw-away edit and return the planned body without committing. */
  readonly dryRun?: boolean;
  readonly signal?: AbortSignal;
}

export interface PlayPromoteResult {
  /** `committed`: Play accepted the edit. `unchanged`: already promoted. `dry-run`: nothing sent. */
  readonly status: 'committed' | 'unchanged' | 'dry-run';
  readonly packageName: string;
  readonly fromTrack: string;
  readonly toTrack: string;
  readonly versionCodes: readonly string[];
  readonly release: PlayTrackRelease;
  /** Releases on the target track the promoted release replaces. */
  readonly superseded: readonly PlayTrackRelease[];
  readonly editId?: string;
  /** The `edits.tracks.update` body (dry run only). */
  readonly plannedTrack?: PlayTrack;
}

export class PlayPromoteUncertainError extends Error {
  constructor(
    readonly stage: 'track-update' | 'validate' | 'commit',
    readonly editId: string,
    readonly versionCodes: readonly string[],
  ) {
    super(
      `Google Play promote ${stage} result is uncertain for edit ${editId}. Re-run the same `
      + `command with --version-code ${versionCodes[0] ?? ''}: it reads the target track first `
      + 'and reports "unchanged" if the promotion landed.',
    );
    this.name = 'PlayPromoteUncertainError';
  }
}

// Only a release that is being served can be promoted: a draft was never
// tested, and a halted one was stopped for a reason.
const promotableStatuses: readonly string[] = ['completed', 'inProgress'];

export async function promotePlayRelease(
  input: PlayPromoteInput & { readonly serviceAccountFile: string },
): Promise<PlayPromoteResult> {
  if (!existsSync(input.serviceAccountFile) || !statSync(input.serviceAccountFile).isFile()) {
    throw new Error('Google Play service account file is missing.');
  }
  assertPlayPromoteInput(input);
  const { createServiceAccountPublisher } = await import(
    new URL('./play-sdk-adapter.js', import.meta.url).href
  ) as { createServiceAccountPublisher: (file: string) => PlayPublisher };
  return promotePlayReleaseWithPublisher(
    input,
    createServiceAccountPublisher(input.serviceAccountFile),
  );
}

export function assertPlayPromoteInput(input: PlayPromoteInput): void {
  assertPlayTrackName(input.fromTrack);
  assertPlayTrackName(input.toTrack);
  if (input.fromTrack === input.toTrack) {
    throw new Error('--from and --to must name different Google Play tracks.');
  }
  if (input.versionCode !== undefined
    && (!Number.isSafeInteger(input.versionCode) || input.versionCode < 1)) {
    throw new Error('--version-code must be a positive integer.');
  }
  const status = input.status ?? 'completed';
  if (status !== 'draft' && status !== 'completed' && status !== 'inProgress') {
    throw new Error('--status must be draft, completed or inProgress.');
  }
  if (status === 'inProgress') {
    if (input.userFraction === undefined) {
      throw new Error('An inProgress (staged) Google Play release needs --user-fraction.');
    }
    assertPlayUserFraction(input.userFraction);
  } else if (input.userFraction !== undefined) {
    throw new Error('--user-fraction applies only to an inProgress (staged) release.');
  }
  if (input.releaseNotes !== undefined) {
    assertPlayReleaseNotes(input.releaseNotes);
  }
}

/** Credential-free injection point for the mock-transport tests. */
export async function promotePlayReleaseWithPublisher(
  input: PlayPromoteInput,
  publisher: PlayPublisher,
): Promise<PlayPromoteResult> {
  assertPlayPromoteInput(input);
  const status = input.status ?? 'completed';
  if (input.dryRun !== true) {
    assertPlayReleaseConfirmed({ track: input.toTrack, status }, input.confirmProduction === true);
  }
  input.signal?.throwIfAborted();
  const { packageName, fromTrack, toTrack } = input;
  const editId = await publisher.insertEdit(packageName, input.signal);
  let committed = false;
  try {
    const source = await readTrack(publisher, packageName, editId, fromTrack, input.signal, true);
    const sourceRelease = selectSourceRelease(source.releases ?? [], input);
    const versionCodes = input.versionCode === undefined
      ? [...(sourceRelease.versionCodes ?? [])]
      : [String(input.versionCode)];
    const notes = input.releaseNotes ?? copiedNotes(sourceRelease);
    const release: PlayTrackRelease = {
      ...(typeof sourceRelease.name === 'string' ? { name: sourceRelease.name } : {}),
      status,
      versionCodes,
      ...(input.userFraction === undefined ? {} : { userFraction: input.userFraction }),
      ...(notes === undefined ? {} : { releaseNotes: notes }),
    };
    const target = await readTrack(
      publisher,
      packageName,
      editId,
      toTrack,
      input.signal,
      !isWellKnownPlayTrack(toTrack),
    );
    const targetReleases = target.releases ?? [];
    const already = targetReleases.filter((item) =>
      versionCodes.some((code) => item.versionCodes?.includes(code)),
    );
    if (already.length > 0) {
      const same = already.length === 1 && already[0] !== undefined
        && already[0].status === status
        && sameCodes(already[0].versionCodes, versionCodes)
        && matchesRequestedRelease(already[0], {
          track: toTrack,
          status,
          ...(input.userFraction === undefined ? {} : { userFraction: input.userFraction }),
          ...(input.releaseNotes === undefined ? {} : { releaseNotes: input.releaseNotes }),
        }, status);
      if (!same) {
        throw new Error(
          `Google Play ${toTrack} already has version ${versionCodes.join(',')} as ${
            already.map((item) => String(item.status)).join(', ')
          } with other options; change it with "mpgd deploy rollout" or inspect it.`,
        );
      }
      return {
        status: 'unchanged',
        packageName,
        fromTrack,
        toTrack,
        versionCodes,
        release: already[0] ?? release,
        superseded: [],
      };
    }
    if (status === 'inProgress'
      && !targetReleases.some((item) => item.status === 'completed')) {
      // Play Console: "Rollout percentage options are unavailable for a first release."
      throw new Error(
        `Google Play ${toTrack} has no completed release yet, so a staged rollout cannot start; `
        + 'promote with --status completed (or draft) first.',
      );
    }
    const merged = mergeNewPlayRelease(targetReleases, release);
    const desired: PlayTrack = { track: toTrack, releases: merged.releases };
    if (input.dryRun === true) {
      return {
        status: 'dry-run',
        packageName,
        fromTrack,
        toTrack,
        versionCodes,
        release,
        superseded: merged.superseded,
        plannedTrack: desired,
      };
    }
    try {
      await publisher.updateTrack(packageName, editId, desired, input.signal);
    } catch (error) {
      if (isDefinitiveHttpError(error)) {
        throw error;
      }
      throw new PlayPromoteUncertainError('track-update', editId, versionCodes);
    }
    try {
      await publisher.validateEdit(packageName, editId, input.signal);
    } catch (error) {
      if (isDefinitiveHttpError(error)) {
        throw error;
      }
      throw new PlayPromoteUncertainError('validate', editId, versionCodes);
    }
    try {
      await publisher.commitEdit(packageName, editId, input.signal);
    } catch (error) {
      if (isDefinitiveHttpError(error)) {
        throw error;
      }
      committed = true; // Unknown: never delete an edit that may have been committed.
      throw new PlayPromoteUncertainError('commit', editId, versionCodes);
    }
    committed = true;
    return {
      status: 'committed',
      packageName,
      fromTrack,
      toTrack,
      versionCodes,
      release,
      superseded: merged.superseded,
      editId,
    };
  } finally {
    if (!committed) {
      // Discard the uncommitted edit (dry run, no-op or refusal); a failure here is harmless.
      await publisher.deleteEdit(packageName, editId, input.signal).catch(() => undefined);
    }
  }
}

async function readTrack(
  publisher: PlayPublisher,
  packageName: string,
  editId: string,
  track: string,
  signal: AbortSignal | undefined,
  mustExist: boolean,
): Promise<PlayTrack> {
  try {
    return await publisher.getTrack(packageName, editId, track, signal);
  } catch (error) {
    if (isHttpStatus(error, 404)) {
      if (mustExist) {
        throw new Error(`Google Play has no ${track} track for ${packageName}.`);
      }
      return { track, releases: [] };
    }
    throw error;
  }
}

function selectSourceRelease(
  releases: readonly PlayTrackRelease[],
  input: PlayPromoteInput,
): PlayTrackRelease {
  const listed = releases.map((release) => `${String(release.status)} [${
    (release.versionCodes ?? []).join(',')}]`).join('; ') || 'none';
  if (input.versionCode !== undefined) {
    const matches = releases.filter((release) =>
      release.versionCodes?.includes(String(input.versionCode)),
    );
    const match = matches[0];
    if (matches.length !== 1 || match === undefined) {
      throw new Error(
        `Google Play ${input.fromTrack} has no release with version code ${input.versionCode}; `
        + `only a version already on the source track can be promoted. Releases: ${listed}.`,
      );
    }
    if (!promotableStatuses.includes(String(match.status))) {
      throw new Error(
        `Google Play ${input.fromTrack} version ${input.versionCode} is ${String(match.status)}; `
        + 'only a completed or in-progress release can be promoted.',
      );
    }
    return match;
  }
  const completed = releases.filter((release) => release.status === 'completed');
  if (completed.length !== 1 || completed[0] === undefined) {
    throw new Error(
      `Google Play ${input.fromTrack} needs exactly one completed release to promote; pass `
      + `--version-code. Releases: ${listed}.`,
    );
  }
  return completed[0];
}

function copiedNotes(release: PlayTrackRelease): PlayReleaseNote[] | undefined {
  const notes = (release.releaseNotes ?? []).flatMap((note) =>
    typeof note.language === 'string' && typeof note.text === 'string'
      ? [{ language: note.language, text: note.text }]
      : [],
  );
  return notes.length === 0 ? undefined : notes;
}

function sameCodes(
  observed: readonly string[] | null | undefined,
  wanted: readonly string[],
): boolean {
  const left = [...(observed ?? [])].sort();
  const right = [...wanted].sort();
  return left.length === right.length && left.every((code, index) => code === right[index]);
}
