import { existsSync, statSync } from 'node:fs';

import { isDefinitiveHttpError, isHttpStatus } from './play-internal-submission.js';
import type { PlayPublisher, PlayTrack, PlayTrackRelease } from './play-publisher-port.js';
import {
  assertPlayReleaseConfirmed,
  assertPlayTrackName,
  assertPlayUserFraction,
  type PlayReleaseStatus,
} from './play-release-options.js';

/**
 * Changes to a release already on a track, without a new bundle. They follow
 * the staged-rollout steps of https://developers.google.com/android-publisher/tracks:
 * `update` changes an inProgress release's userFraction, `halt` sets it
 * `halted`, `resume` sets a halted release back to `inProgress`, and
 * `complete` sets it `completed` (100%).
 */
export type PlayRolloutAction = 'update' | 'halt' | 'resume' | 'complete';

export const playRolloutActions: readonly PlayRolloutAction[] = Object.freeze([
  'update',
  'halt',
  'resume',
  'complete',
]);

export interface PlayRolloutInput {
  readonly packageName: string;
  readonly track: string;
  readonly action: PlayRolloutAction;
  /** Selects the release; defaults to the track's only release the action applies to. */
  readonly versionCode?: number;
  /** Required for `update`; optional for `resume` (else the halted release's own fraction). */
  readonly userFraction?: number;
  /** Required for production tracks and for any change that leaves a staged rollout running. */
  readonly confirmProduction?: boolean;
  /** Read the track in a throw-away edit and return the planned body without committing. */
  readonly dryRun?: boolean;
  readonly signal?: AbortSignal;
}

export interface PlayRolloutReleaseState {
  readonly status: string;
  readonly userFraction?: number;
}

export interface PlayRolloutResult {
  /** `committed`: Play accepted the edit. `unchanged`: nothing to do. `dry-run`: nothing sent. */
  readonly status: 'committed' | 'unchanged' | 'dry-run';
  readonly packageName: string;
  readonly track: string;
  readonly action: PlayRolloutAction;
  readonly versionCodes: readonly string[];
  readonly before: PlayRolloutReleaseState;
  readonly after: PlayRolloutReleaseState;
  readonly editId?: string;
  /** The `edits.tracks.update` body (dry run only). */
  readonly plannedTrack?: PlayTrack;
}

export class PlayRolloutUncertainError extends Error {
  constructor(
    readonly stage: 'track-update' | 'validate' | 'commit',
    readonly editId: string,
    /** The release that was being changed; pass one of them as --version-code on the re-run. */
    readonly versionCodes: readonly string[] = [],
  ) {
    super(
      `Google Play rollout ${stage} result is uncertain for edit ${editId}. Re-run the same `
      + `command${versionCodes[0] === undefined ? '' : ` with --version-code ${versionCodes[0]}`}: `
      + 'it reads the live track first and reports "unchanged" if the change landed.',
    );
    this.name = 'PlayRolloutUncertainError';
  }
}

// Without --version-code, the release an action applies to (or has already
// been applied to, so a re-run after a lost response reports "unchanged").
const sourceStatuses: Record<PlayRolloutAction, readonly string[]> = {
  update: ['inProgress'],
  halt: ['inProgress', 'halted'],
  resume: ['halted', 'inProgress'],
  complete: ['inProgress', 'halted'],
};

/** Change one existing release on one named track with a service account. */
export async function changePlayRollout(
  input: PlayRolloutInput & { readonly serviceAccountFile: string },
): Promise<PlayRolloutResult> {
  if (!existsSync(input.serviceAccountFile) || !statSync(input.serviceAccountFile).isFile()) {
    throw new Error('Google Play service account file is missing.');
  }
  assertPlayRolloutInput(input);
  const { createServiceAccountPublisher } = await import(
    new URL('./play-sdk-adapter.js', import.meta.url).href
  ) as { createServiceAccountPublisher: (file: string) => PlayPublisher };
  return changePlayRolloutWithPublisher(
    input,
    createServiceAccountPublisher(input.serviceAccountFile),
  );
}

export function assertPlayRolloutInput(input: PlayRolloutInput): void {
  assertPlayTrackName(input.track);
  if (!playRolloutActions.includes(input.action)) {
    throw new Error('--action must be update, halt, resume or complete.');
  }
  if (input.versionCode !== undefined
    && (!Number.isSafeInteger(input.versionCode) || input.versionCode < 1)) {
    throw new Error('--version-code must be a positive integer.');
  }
  if (input.userFraction !== undefined) {
    if (input.action !== 'update' && input.action !== 'resume') {
      throw new Error('--user-fraction applies only to --action update or resume.');
    }
    assertPlayUserFraction(input.userFraction);
  } else if (input.action === 'update') {
    throw new Error('--action update needs --user-fraction.');
  }
}

/** Credential-free injection point for the mock-transport tests. */
export async function changePlayRolloutWithPublisher(
  input: PlayRolloutInput,
  publisher: PlayPublisher,
): Promise<PlayRolloutResult> {
  assertPlayRolloutInput(input);
  if (input.dryRun !== true && (input.action === 'update' || input.action === 'resume')) {
    // Leaves (or keeps) a staged rollout running: confirm before any request.
    assertPlayReleaseConfirmed(
      { track: input.track, status: 'inProgress' },
      input.confirmProduction === true,
    );
  } else if (input.dryRun !== true) {
    assertPlayReleaseConfirmed(
      { track: input.track, status: 'completed' },
      input.confirmProduction === true,
    );
  }
  input.signal?.throwIfAborted();
  const { packageName, track: trackName } = input;
  const editId = await publisher.insertEdit(packageName, input.signal);
  let committed = false;
  try {
    let current: PlayTrack;
    try {
      current = await publisher.getTrack(packageName, editId, trackName, input.signal);
    } catch (error) {
      if (isHttpStatus(error, 404)) {
        throw new Error(`Google Play has no ${trackName} track for ${packageName}.`);
      }
      throw error;
    }
    const releases = current.releases ?? [];
    const target = selectRelease(releases, input);
    const before = releaseState(target);
    const changed = applyAction(target, input);
    const versionCodes = [...(target.versionCodes ?? [])];
    if (changed === undefined) {
      return {
        status: 'unchanged',
        packageName,
        track: trackName,
        action: input.action,
        versionCodes,
        before,
        after: before,
      };
    }
    // Only the selected release changes; every other release goes back as Play returned it.
    const desired: PlayTrack = {
      track: trackName,
      releases: releases.map((release) => release === target ? changed : release),
    };
    const after = releaseState(changed);
    if (input.dryRun === true) {
      return {
        status: 'dry-run',
        packageName,
        track: trackName,
        action: input.action,
        versionCodes,
        before,
        after,
        plannedTrack: desired,
      };
    }
    try {
      await publisher.updateTrack(packageName, editId, desired, input.signal);
    } catch (error) {
      if (isDefinitiveHttpError(error)) {
        throw error;
      }
      throw new PlayRolloutUncertainError('track-update', editId, versionCodes);
    }
    try {
      await publisher.validateEdit(packageName, editId, input.signal);
    } catch (error) {
      if (isDefinitiveHttpError(error)) {
        throw error;
      }
      throw new PlayRolloutUncertainError('validate', editId, versionCodes);
    }
    try {
      await publisher.commitEdit(packageName, editId, input.signal);
    } catch (error) {
      if (isDefinitiveHttpError(error)) {
        throw error;
      }
      committed = true; // Unknown: never delete an edit that may have been committed.
      throw new PlayRolloutUncertainError('commit', editId, versionCodes);
    }
    committed = true;
    return {
      status: 'committed',
      packageName,
      track: trackName,
      action: input.action,
      versionCodes,
      before,
      after,
      editId,
    };
  } finally {
    if (!committed) {
      // Discard the uncommitted edit (dry run, no-op or refusal); a failure here is harmless.
      await publisher.deleteEdit(packageName, editId, input.signal).catch(() => undefined);
    }
  }
}

function selectRelease(
  releases: readonly PlayTrackRelease[],
  input: PlayRolloutInput,
): PlayTrackRelease {
  const candidates = input.versionCode === undefined
    ? releases.filter((release) => sourceStatuses[input.action].includes(String(release.status)))
    : releases.filter((release) => release.versionCodes?.includes(String(input.versionCode)));
  if (candidates.length !== 1 || candidates[0] === undefined) {
    const listed = releases.map((release) => `${String(release.status)} [${
      (release.versionCodes ?? []).join(',')}]`).join('; ') || 'none';
    throw new Error(input.versionCode === undefined
      ? `Google Play ${input.track} needs exactly one ${sourceStatuses[input.action].join(' or ')} `
        + `release for --action ${input.action}; pass --version-code. Releases: ${listed}.`
      : `Google Play ${input.track} has no single release with version code ${input.versionCode}. `
        + `Releases: ${listed}.`);
  }
  return candidates[0];
}

/** The changed release, or undefined when it is already in the requested state. */
function applyAction(
  release: PlayTrackRelease,
  input: PlayRolloutInput,
): PlayTrackRelease | undefined {
  const status = String(release.status) as PlayReleaseStatus;
  const fraction = typeof release.userFraction === 'number' ? release.userFraction : undefined;
  const refuse = (detail: string): never => {
    throw new Error(`Google Play ${input.track} release is ${status}; ${detail}`);
  };
  const { userFraction: _dropped, ...withoutFraction } = release;
  switch (input.action) {
    case 'update':
      if (status !== 'inProgress') {
        return refuse('only an inProgress release has a fraction to update.');
      }
      return fraction === input.userFraction
        ? undefined
        : { ...release, userFraction: input.userFraction };
    case 'halt':
      if (status === 'halted') {
        return undefined;
      }
      if (status !== 'inProgress' && status !== 'completed') {
        return refuse('only an inProgress or completed release can be halted.');
      }
      // Halting a completed release serves the previous completed release instead.
      return { ...release, status: 'halted' };
    case 'resume': {
      if (status === 'inProgress') {
        return input.userFraction === undefined || input.userFraction === fraction
          ? undefined
          : refuse('use --action update to change its fraction.');
      }
      if (status !== 'halted') {
        return refuse('only a halted release can be resumed.');
      }
      const resumed = input.userFraction ?? fraction;
      if (resumed === undefined) {
        return refuse('it has no rollout fraction; pass --user-fraction or use --action complete.');
      }
      return { ...release, status: 'inProgress', userFraction: resumed };
    }
    case 'complete':
      if (status === 'completed') {
        return undefined;
      }
      if (status !== 'inProgress' && status !== 'halted') {
        return refuse('only an inProgress or halted release can be completed.');
      }
      return { ...withoutFraction, status: 'completed' };
  }
}

function releaseState(release: PlayTrackRelease): PlayRolloutReleaseState {
  return {
    status: String(release.status),
    ...(typeof release.userFraction === 'number' ? { userFraction: release.userFraction } : {}),
  };
}
