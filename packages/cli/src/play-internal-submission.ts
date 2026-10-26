import { createHash } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';

import type {
  PlayBundle,
  PlayPublisher,
  PlayTrack,
  PlayTrackRelease,
} from './play-publisher-port.js';
import { inspectAndroidBundleSigner } from './android-bundle-signer.js';
import {
  assertPlayReleaseConfirmed,
  assertPlayReleaseRequest,
  defaultPlayReleaseRequest,
  hashMappingFile,
  isPlayDraftAppRejection,
  isWellKnownPlayTrack,
  mergeNewPlayRelease,
  newPlayRelease,
  playReleaseNeedsConfirmation,
  type PlayNewReleaseStatus,
  type PlayReleaseRequest,
} from './play-release-options.js';
import type { ImmutableNativeBuildRecord } from './release-state.js';

const sha256Pattern = /^[a-f0-9]{64}$/u;
const editIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const bundleUploadTimeoutMs = 120_000;

export interface PlayInternalSubmissionInput {
  readonly record: ImmutableNativeBuildRecord;
  readonly aabFile: string;
  readonly packageName: string;
  /** Absolute path to a game-owned Google service account JSON file. */
  readonly serviceAccountFile: string;
  /** Reuse the checkpointed edit; never create a replacement after an uncertain response. */
  readonly resumeEditId?: string;
  /** Persist this edit ID before any upload begins, for later reconciliation. */
  readonly onEditCreated?: (editId: string) => Promise<void>;
  /** Track, status, rollout fraction, notes and mapping; defaults to internal/completed. */
  readonly release?: PlayReleaseRequest;
  /** Required for production tracks and staged (inProgress) rollouts. */
  readonly confirmProduction?: boolean;
  /** Called before the kit re-commits a release as a draft for a never-published app. */
  readonly onDraftAppFallback?: (track: string) => void;
  readonly signal?: AbortSignal;
}

export interface PlayInternalSubmissionResult {
  readonly status: 'committed';
  readonly packageName: string;
  readonly editId: string;
  readonly track: string;
  /** The committed release's status; `draft` after a draft-app fallback. */
  readonly releaseStatus: PlayNewReleaseStatus;
  /** Play refused a non-draft release because the app was never published. */
  readonly draftAppFallback: boolean;
  readonly versionCode: number;
  readonly bundleSha256: string;
  readonly alreadyCommitted: boolean;
}

/** The planned edit of a `--dry-run`: verified locally, no Google Play call made. */
export interface PlaySubmissionPlan {
  readonly dryRun: true;
  readonly packageName: string;
  readonly track: string;
  readonly versionCode: number;
  readonly bundleSha256: string;
  readonly release: PlayTrackRelease;
  readonly mapping?: { readonly file: string; readonly sha256: string };
  readonly requiresConfirmProduction: boolean;
  readonly operations: readonly string[];
}

export class PlaySubmissionUncertainError extends Error {
  constructor(
    readonly stage: 'checkpoint' | 'upload' | 'deobfuscation-upload' | 'track-update'
      | 'validate' | 'commit',
    readonly editId: string,
  ) {
    super(
      `Google Play ${stage} result is uncertain for edit ${editId}; inspect remote state before retry.`,
    );
    this.name = 'PlaySubmissionUncertainError';
  }
}

/** Submit only a previously inspected, immutable Android build record. */
export async function submitVerifiedAndroidBundle(
  input: PlayInternalSubmissionInput,
): Promise<PlayInternalSubmissionResult> {
  if (!existsSync(input.serviceAccountFile) || !statSync(input.serviceAccountFile).isFile()) {
    throw new Error('Google Play service account file is missing.');
  }
  const { createServiceAccountPublisher } = await import(
    new URL('./play-sdk-adapter.js', import.meta.url).href
  ) as { createServiceAccountPublisher: (file: string) => PlayPublisher };
  const publisher = createServiceAccountPublisher(input.serviceAccountFile);
  return submitVerifiedAndroidBundleWithPublisher(input, publisher);
}

/** Verify the record and artifact, then describe the edit without calling Google Play. */
export async function planVerifiedAndroidBundleSubmission(
  input: Omit<PlayInternalSubmissionInput, 'serviceAccountFile'>,
): Promise<PlaySubmissionPlan> {
  const request = input.release ?? defaultPlayReleaseRequest;
  assertPlayReleaseRequest(request);
  const versionCode = await preflight(input);
  await assertMappingUnchanged(request);
  return {
    dryRun: true,
    packageName: input.packageName,
    track: request.track,
    versionCode,
    bundleSha256: input.record.artifactSha256,
    release: newPlayRelease(request, input.record.releaseKey, versionCode),
    ...(request.mappingFile === undefined || request.mappingSha256 === undefined ? {} : {
      mapping: { file: request.mappingFile, sha256: request.mappingSha256 },
    }),
    requiresConfirmProduction: playReleaseNeedsConfirmation(request),
    operations: [
      'edits.insert',
      'edits.bundles.list',
      `edits.tracks.get ${request.track}`,
      'edits.bundles.upload (skipped when the edit already has this version code)',
      ...(request.mappingFile === undefined
        ? [] : ['edits.deobfuscationfiles.upload proguard']),
      `edits.tracks.update ${request.track} (other releases kept; a ${
        request.status === 'draft' ? 'draft replaces an older draft'
          : 'new release replaces an in-progress or halted rollout'})`,
      'edits.validate',
      'edits.commit changesInReviewBehavior=ERROR_IF_IN_REVIEW',
    ],
  };
}

/** Internal injection point for credential-free SDK contract tests. */
export async function submitVerifiedAndroidBundleWithPublisher(
  input: PlayInternalSubmissionInput,
  publisher: PlayPublisher,
  requestRootUrl?: string,
): Promise<PlayInternalSubmissionResult> {
  const request = input.release ?? defaultPlayReleaseRequest;
  assertPlayReleaseRequest(request);
  assertPlayReleaseConfirmed(request, input.confirmProduction === true);
  const trackName = request.track;
  const versionCode = await preflight(input);
  await assertMappingUnchanged(request);
  const expectedSha256 = input.record.artifactSha256;
  const packageName = input.packageName;
  if (input.resumeEditId !== undefined && !editIdPattern.test(input.resumeEditId)) {
    throw new Error('Google Play resume edit ID is malformed.');
  }
  input.signal?.throwIfAborted();
  let editId = input.resumeEditId ?? await publisher.insertEdit(packageName, input.signal);
  let freshEdit = input.resumeEditId === undefined;
  // A new edit is checkpointed after the read-only checks below and before
  // anything is uploaded or committed, so a refused request leaves no edit to
  // reconcile and can be retried with corrected options.
  let editPersisted = input.resumeEditId !== undefined;
  const persistEdit = async (): Promise<void> => {
    if (editPersisted) {
      return;
    }
    try {
      await input.onEditCreated?.(editId);
    } catch {
      throw new PlaySubmissionUncertainError('checkpoint', editId);
    }
    editPersisted = true;
  };

  let bundles: PlayBundle[];
  try {
    bundles = await publisher.listBundles(packageName, editId, input.signal);
  } catch (error) {
    if (input.resumeEditId === undefined || !isHttpStatus(error, 404)) {
      throw error;
    }
    // A successful commit may have invalidated the old edit while its response
    // was lost. Open a new snapshot solely to inspect the live track.
    editId = await publisher.insertEdit(packageName, input.signal);
    freshEdit = true;
    editPersisted = false;
    await persistEdit();
    bundles = await publisher.listBundles(packageName, editId, input.signal);
  }
  let existing = findVersionBundle(bundles, versionCode, expectedSha256);
  const currentTrack = await getTrackOrEmpty(
    publisher,
    packageName,
    editId,
    trackName,
    input.signal,
    !isWellKnownPlayTrack(trackName),
  );
  const release = newPlayRelease(request, input.record.releaseKey, versionCode);
  const commit = async (status: PlayNewReleaseStatus): Promise<PlayInternalSubmissionResult> => {
    const committed = await validateAndCommit({
      publisher, packageName, editId, trackName, versionCode, release, status,
      currentTrack, ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(input.onDraftAppFallback === undefined ? {} : {
        onDraftAppFallback: input.onDraftAppFallback,
      }),
    });
    return result(input, trackName, editId, versionCode, false, committed);
  };
  if (hasVersion(currentTrack.releases, versionCode)) {
    if (existing === undefined) {
      throw new Error(
        `Google Play ${trackName} track has this version without matching bundle bytes.`,
      );
    }
    // Our own edit (resumed), or the live track after that edit was committed
    // and its response lost (a resume that found the edit gone), may hold this
    // release as a draft-app fallback.
    const fallbackDraft = request.status !== 'draft' && (!freshEdit
      ? hasVersionWithStatus(currentTrack.releases, versionCode, 'draft')
      : input.resumeEditId !== undefined && (currentTrack.releases ?? []).some((item) =>
        item.status === 'draft' && item.name === input.record.releaseKey
        && item.versionCodes?.includes(String(versionCode))));
    if (!hasVersionWithStatus(currentTrack.releases, versionCode, request.status)
      && !fallbackDraft) {
      throw new Error(
        `Google Play ${trackName} track version is not ${request.status}; inspect it before resubmitting.`,
      );
    }
    const observedStatus: PlayNewReleaseStatus = fallbackDraft
      && !hasVersionWithStatus(currentTrack.releases, versionCode, request.status)
      ? 'draft' : request.status;
    const observed = (currentTrack.releases ?? []).find((item) => item.status === observedStatus
      && item.versionCodes?.includes(String(versionCode)));
    if (observed !== undefined && !matchesRequestedRelease(observed, request, observedStatus)) {
      throw new Error(
        `Google Play ${trackName} track already has this version with another rollout fraction `
        + 'or other release notes; change it with "mpgd deploy rollout" or inspect it.',
      );
    }
    if (freshEdit) {
      await persistEdit();
      if (request.mappingFile !== undefined) {
        // The release may have reached Play without this mapping: add it to
        // the version in an edit of its own.
        await uploadMapping(
          publisher,
          request,
          packageName,
          editId,
          versionCode,
          input.signal,
          requestRootUrl,
        );
        return { ...await commit(observedStatus), alreadyCommitted: true };
      }
      return result(input, trackName, editId, versionCode, true, {
        status: observedStatus,
        draftAppFallback: observedStatus !== request.status,
      });
    }
    // A resumed edit sees its own uncommitted track. Publish it before success.
    await uploadMapping(
      publisher,
      request,
      packageName,
      editId,
      versionCode,
      input.signal,
      requestRootUrl,
    );
    return commit(observedStatus);
  }
  if (playReleaseStartsRollout(request.status, currentTrack.releases)) {
    // Play Console: "Rollout percentage options are unavailable for a first release."
    throw new Error(
      `Google Play ${trackName} has no completed release yet, so a staged rollout cannot start; `
      + 'release it with --status completed (or draft) first.',
    );
  }
  await persistEdit();
  if (existing === undefined) {
    try {
      const uploaded = await publisher.uploadBundle({
        packageName,
        editId,
        aabFile: input.aabFile,
        timeoutMs: bundleUploadTimeoutMs,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        ...(requestRootUrl === undefined ? {} : { requestRootUrl }),
      });
      assertBundle(uploaded, versionCode, expectedSha256);
    } catch (error) {
      if (isDefinitiveHttpError(error)) {
        throw error;
      }
      try {
        bundles = await publisher.listBundles(packageName, editId, input.signal);
        existing = findVersionBundle(bundles, versionCode, expectedSha256);
      } catch {
        throw new PlaySubmissionUncertainError('upload', editId);
      }
      if (existing === undefined) {
        throw new PlaySubmissionUncertainError('upload', editId);
      }
    }
  }
  await uploadMapping(
    publisher,
    request,
    packageName,
    editId,
    versionCode,
    input.signal,
    requestRootUrl,
  );

  const desired: PlayTrack = {
    track: trackName,
    releases: mergeNewPlayRelease(currentTrack.releases, release).releases,
  };
  await updateTrackChecked(
    publisher,
    packageName,
    editId,
    trackName,
    desired,
    versionCode,
    request.status,
    input.signal,
  );
  return commit(request.status);
}

interface CommitInput {
  readonly publisher: PlayPublisher;
  readonly packageName: string;
  readonly editId: string;
  readonly trackName: string;
  readonly versionCode: number;
  readonly release: PlayTrackRelease;
  /** The status the edit's track now holds for this version. */
  readonly status: PlayNewReleaseStatus;
  /** The track as read before this submission changed it. */
  readonly currentTrack: PlayTrack;
  readonly onDraftAppFallback?: (track: string) => void;
  readonly signal?: AbortSignal;
}

interface CommittedRelease {
  readonly status: PlayNewReleaseStatus;
  readonly draftAppFallback: boolean;
}

async function validateAndCommit(input: CommitInput): Promise<CommittedRelease> {
  const { publisher, packageName, editId } = input;
  try {
    await publisher.validateEdit(packageName, editId, input.signal);
  } catch (error) {
    if (input.status !== 'draft' && isPlayDraftAppRejection(error)) {
      return commitDraftFallback(input);
    }
    if (isDefinitiveHttpError(error)) {
      throw error;
    }
    throw new PlaySubmissionUncertainError('validate', editId);
  }
  try {
    await publisher.commitEdit(packageName, editId, input.signal);
    return { status: input.status, draftAppFallback: input.status === 'draft'
      && input.release.status !== 'draft' };
  } catch (error) {
    // A definitive draft-app rejection means nothing was committed.
    if (input.status !== 'draft' && isPlayDraftAppRejection(error)) {
      return commitDraftFallback(input);
    }
    // Inserting a new edit invalidates the first edit for this API user. A
    // failed commit response cannot safely be reconciled by creating one.
    throw new PlaySubmissionUncertainError('commit', editId);
  }
}

/**
 * Play accepts only draft releases until an app's first release is rolled out
 * from Play Console. Re-stage the same version as a draft in the same edit and
 * commit that, so the operator can roll it out from the console.
 */
async function commitDraftFallback(input: CommitInput): Promise<CommittedRelease> {
  input.onDraftAppFallback?.(input.trackName);
  const { userFraction: _fraction, ...withoutFraction } = input.release;
  const draft: PlayTrackRelease = { ...withoutFraction, status: 'draft' };
  const others = (input.currentTrack.releases ?? []).filter(
    (release) => !release.versionCodes?.includes(String(input.versionCode)),
  );
  await updateTrackChecked(
    input.publisher,
    input.packageName,
    input.editId,
    input.trackName,
    {
      track: input.trackName,
      releases: mergeNewPlayRelease(others, draft).releases,
    },
    input.versionCode,
    'draft',
    input.signal,
  );
  await validateAndCommit({ ...input, status: 'draft' });
  return { status: 'draft', draftAppFallback: true };
}

async function updateTrackChecked(
  publisher: PlayPublisher,
  packageName: string,
  editId: string,
  trackName: string,
  desired: PlayTrack,
  versionCode: number,
  status: PlayNewReleaseStatus,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await publisher.updateTrack(packageName, editId, desired, signal);
  } catch (error) {
    let applied: boolean;
    try {
      const observed = await getTrackOrEmpty(publisher, packageName, editId, trackName, signal);
      applied = hasVersionWithStatus(observed.releases, versionCode, status);
    } catch {
      throw new PlaySubmissionUncertainError('track-update', editId);
    }
    if (!applied) {
      throw error;
    }
  }
}

async function uploadMapping(
  publisher: PlayPublisher,
  request: PlayReleaseRequest,
  packageName: string,
  editId: string,
  versionCode: number,
  signal?: AbortSignal,
  requestRootUrl?: string,
): Promise<void> {
  if (request.mappingFile === undefined) {
    return;
  }
  // Re-uploading replaces the edit's mapping for this version code, so a lost
  // response is safe to retry on the same edit.
  try {
    await publisher.uploadDeobfuscationFile({
      packageName,
      editId,
      versionCode,
      mappingFile: request.mappingFile,
      timeoutMs: bundleUploadTimeoutMs,
      ...(signal === undefined ? {} : { signal }),
      ...(requestRootUrl === undefined ? {} : { requestRootUrl }),
    });
  } catch (error) {
    if (isDefinitiveHttpError(error)) {
      throw error;
    }
    throw new PlaySubmissionUncertainError('deobfuscation-upload', editId);
  }
}

async function assertMappingUnchanged(request: PlayReleaseRequest): Promise<void> {
  if (request.mappingFile !== undefined
    && await hashMappingFile(request.mappingFile) !== request.mappingSha256) {
    throw new Error('R8 mapping file changed after the release request was created.');
  }
}

/**
 * The release already on the track matches what this request would create:
 * the rollout fraction (a draft-app fallback has none) and, when given, the
 * release notes in any order.
 */
export function matchesRequestedRelease(
  observed: PlayTrackRelease,
  request: PlayReleaseRequest,
  observedStatus: PlayNewReleaseStatus,
): boolean {
  const fraction = typeof observed.userFraction === 'number' ? observed.userFraction : undefined;
  if (observedStatus === request.status && fraction !== request.userFraction) {
    return false;
  }
  if (request.releaseNotes === undefined) {
    return true;
  }
  const key = (language: string | null | undefined, text: string | null | undefined): string =>
    JSON.stringify([language ?? '', text ?? '']);
  const observedNotes = (observed.releaseNotes ?? []).map((note) => key(note.language, note.text))
    .sort();
  const wanted = request.releaseNotes.map((note) => key(note.language, note.text)).sort();
  return observedNotes.length === wanted.length
    && observedNotes.every((note, index) => note === wanted[index]);
}

/** A staged rollout needs a completed release on the track to stage over. */
function playReleaseStartsRollout(
  status: PlayNewReleaseStatus,
  releases: readonly PlayTrackRelease[] | null | undefined,
): boolean {
  return status === 'inProgress'
    && !(releases ?? []).some((release) => release.status === 'completed');
}

async function preflight(
  input: Pick<PlayInternalSubmissionInput, 'record' | 'aabFile' | 'packageName' | 'signal'>,
): Promise<number> {
  input.signal?.throwIfAborted();
  const record = input.record;
  const versionCode = record.platformVersion.versionCode;
  if (record.target !== 'android' || input.packageName !== record.inspectedAppId
    || !Number.isSafeInteger(versionCode) || Number(versionCode) < 1
    || !sha256Pattern.test(record.artifactSha256)
    || !sha256Pattern.test(record.inspectedSignerSha256 ?? '')
    || !input.aabFile.endsWith('.aab')
    || !existsSync(input.aabFile) || !statSync(input.aabFile).isFile()) {
    throw new Error('Google Play submission requires a matching verified Android AAB record.');
  }
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(input.aabFile)) {
    hash.update(chunk);
  }
  input.signal?.throwIfAborted();
  if (hash.digest('hex') !== record.artifactSha256) {
    throw new Error('Google Play AAB bytes differ from the immutable build record.');
  }
  if (await inspectAndroidBundleSigner(input.aabFile)
    !== record.inspectedSignerSha256?.replaceAll(':', '').toLowerCase()) {
    throw new Error('Google Play AAB signer differs from the immutable build record.');
  }
  return Number(versionCode);
}

function assertBundle(
  bundle: PlayBundle,
  versionCode: number,
  sha256: string,
): void {
  if (bundle.versionCode !== versionCode || bundle.sha256?.toLowerCase() !== sha256) {
    throw new Error('Google Play returned a different bundle version or SHA-256.');
  }
}

function findVersionBundle(
  bundles: readonly PlayBundle[],
  versionCode: number,
  sha256: string,
): PlayBundle | undefined {
  const sameVersion = bundles.find((bundle) => bundle.versionCode === versionCode);
  if (sameVersion !== undefined) {
    assertBundle(sameVersion, versionCode, sha256);
  }
  return sameVersion;
}

async function getTrackOrEmpty(
  publisher: PlayPublisher,
  packageName: string,
  editId: string,
  trackName: string,
  signal?: AbortSignal,
  mustExist = false,
): Promise<PlayTrack> {
  try {
    return await publisher.getTrack(packageName, editId, trackName, signal);
  } catch (error) {
    if (isHttpStatus(error, 404)) {
      if (mustExist) {
        throw new Error(
          `Google Play has no closed-testing track named "${trackName}"; create it in Play `
          + 'Console or check the name.',
        );
      }
      return { track: trackName, releases: [] };
    }
    throw error;
  }
}

export function isHttpStatus(error: unknown, status: number): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const value = error as { code?: unknown; response?: { status?: unknown } };
  return value.code === status || value.response?.status === status;
}

export function isDefinitiveHttpError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const value = error as { code?: unknown; response?: { status?: unknown } };
  const raw = value.response?.status ?? value.code;
  const status = typeof raw === 'number'
    ? raw
    : typeof raw === 'string' && /^\d{3}$/u.test(raw)
      ? Number(raw)
      : undefined;
  return status !== undefined && status >= 400 && status < 500
    && status !== 408 && status !== 429;
}

function hasVersion(
  releases: readonly PlayTrackRelease[] | null | undefined,
  versionCode: number,
): boolean {
  return releases?.some((release) => release.versionCodes?.includes(String(versionCode))) ?? false;
}

function hasVersionWithStatus(
  releases: readonly PlayTrackRelease[] | null | undefined,
  versionCode: number,
  status: PlayNewReleaseStatus,
): boolean {
  return releases?.some((release) => release.status === status
    && release.versionCodes?.includes(String(versionCode))) ?? false;
}

function result(
  input: PlayInternalSubmissionInput,
  trackName: string,
  editId: string,
  versionCode: number,
  alreadyCommitted: boolean,
  committed: CommittedRelease,
): PlayInternalSubmissionResult {
  return {
    status: 'committed',
    packageName: input.packageName,
    editId,
    track: trackName,
    releaseStatus: committed.status,
    draftAppFallback: committed.draftAppFallback,
    versionCode,
    bundleSha256: input.record.artifactSha256,
    alreadyCommitted,
  };
}
