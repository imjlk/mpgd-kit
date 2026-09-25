import { createHash } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';

import { androidpublisher, auth, type androidpublisher_v3 } from '@googleapis/androidpublisher';

import type { ImmutableNativeBuildRecord } from './release-state.js';

const sha256Pattern = /^[a-f0-9]{64}$/u;
const scope = 'https://www.googleapis.com/auth/androidpublisher';
const trackName = 'internal';
const bundleUploadTimeoutMs = 120_000;
const aabMimeType = 'application/octet-stream';

export interface PlayInternalSubmissionInput {
  readonly record: ImmutableNativeBuildRecord;
  readonly aabFile: string;
  readonly packageName: string;
  /** Absolute path to a game-owned Google service account JSON file. */
  readonly serviceAccountFile: string;
  /** Persist this edit ID before any upload begins, for later reconciliation. */
  readonly onEditCreated?: (editId: string) => Promise<void>;
}

export interface PlayInternalSubmissionResult {
  readonly status: 'committed';
  readonly packageName: string;
  readonly editId: string;
  readonly track: 'internal';
  readonly versionCode: number;
  readonly bundleSha256: string;
  readonly alreadyCommitted: boolean;
}

export class PlaySubmissionUncertainError extends Error {
  constructor(
    readonly stage: 'upload' | 'track-update' | 'commit',
    readonly editId: string,
    options?: ErrorOptions,
  ) {
    super(
      `Google Play ${stage} result is uncertain for edit ${editId}; inspect remote state before retry.`,
      options,
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
  const googleAuth = new auth.GoogleAuth({
    keyFile: input.serviceAccountFile,
    scopes: [scope],
  });
  const publisher = androidpublisher({ version: 'v3', auth: googleAuth });
  return submitVerifiedAndroidBundleWithPublisher(input, publisher);
}

/** Internal injection point for credential-free SDK contract tests. */
export async function submitVerifiedAndroidBundleWithPublisher(
  input: PlayInternalSubmissionInput,
  publisher: androidpublisher_v3.Androidpublisher,
  requestRootUrl?: string,
): Promise<PlayInternalSubmissionResult> {
  const versionCode = await preflight(input);
  const expectedSha256 = input.record.artifactSha256;
  const packageName = input.packageName;
  const inserted = await publisher.edits.insert({ packageName }, { retry: false });
  const editId = inserted.data.id;
  if (typeof editId !== 'string' || editId.trim() === '') {
    throw new Error('Google Play did not return an edit ID.');
  }
  await input.onEditCreated?.(editId);

  let bundles = (await publisher.edits.bundles.list({ packageName, editId })).data.bundles ?? [];
  let existing = findVersionBundle(bundles, versionCode, expectedSha256);
  const currentTrack = await getInternalTrack(publisher, packageName, editId);
  if (hasVersion(currentTrack.releases, versionCode)) {
    if (existing === undefined) {
      throw new Error('Google Play internal track has this version without matching bundle bytes.');
    }
    if (!hasCompletedVersion(currentTrack.releases, versionCode)) {
      throw new Error(
        'Google Play internal track version is not completed; inspect it before resubmitting.',
      );
    }
    return result(input, editId, versionCode, true);
  }
  if (existing === undefined) {
    try {
      const uploaded = await publisher.edits.bundles.upload(
        {
          packageName,
          editId,
          media: { mimeType: aabMimeType, body: createReadStream(input.aabFile) },
        },
        {
          timeout: bundleUploadTimeoutMs,
          retry: false,
          // The generated SDK's media endpoint ignores the client's rootUrl.
          ...(requestRootUrl === undefined ? {} : { rootUrl: requestRootUrl }),
        },
      );
      assertBundle(uploaded.data, versionCode, expectedSha256);
    } catch (error) {
      try {
        bundles = (await publisher.edits.bundles.list({ packageName, editId })).data.bundles ?? [];
        existing = findVersionBundle(bundles, versionCode, expectedSha256);
      } catch {
        throw new PlaySubmissionUncertainError('upload', editId, { cause: error });
      }
      if (existing === undefined) {
        throw new PlaySubmissionUncertainError('upload', editId, { cause: error });
      }
    }
  }

  const release: androidpublisher_v3.Schema$TrackRelease = {
    name: input.record.releaseKey,
    status: 'completed',
    versionCodes: [String(versionCode)],
  };
  const desired: androidpublisher_v3.Schema$Track = {
    track: trackName,
    releases: [...(currentTrack.releases ?? []), release],
  };
  try {
    await publisher.edits.tracks.update(
      {
        packageName,
        editId,
        track: trackName,
        requestBody: desired,
      },
      { retry: false },
    );
  } catch (error) {
    let applied: boolean;
    try {
      const observed = await getInternalTrack(publisher, packageName, editId);
      applied = hasCompletedVersion(observed.releases, versionCode);
    } catch {
      throw new PlaySubmissionUncertainError('track-update', editId, { cause: error });
    }
    if (!applied) {
      throw error;
    }
  }
  await publisher.edits.validate({ packageName, editId });
  try {
    await publisher.edits.commit({
      packageName,
      editId,
      // The API default cancels changes currently in review. Never do that implicitly.
      changesInReviewBehavior: 'ERROR_IF_IN_REVIEW',
    }, { retry: false });
    return result(input, editId, versionCode, false);
  } catch (error) {
    try {
      const checkEdit = (await publisher.edits.insert({ packageName }, { retry: false })).data.id;
      if (typeof checkEdit === 'string') {
        const checkTrack = await getInternalTrack(publisher, packageName, checkEdit);
        const checkBundles = (await publisher.edits.bundles.list({
          packageName, editId: checkEdit,
        })).data.bundles ?? [];
        if (hasCompletedVersion(checkTrack.releases, versionCode)
          && findVersionBundle(checkBundles, versionCode, expectedSha256) !== undefined) {
          return result(input, editId, versionCode, false);
        }
      }
    } catch {
      // A failed read cannot prove that the commit did not happen.
    }
    throw new PlaySubmissionUncertainError('commit', editId, { cause: error });
  }
}

async function preflight(input: PlayInternalSubmissionInput): Promise<number> {
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
  if (hash.digest('hex') !== record.artifactSha256) {
    throw new Error('Google Play AAB bytes differ from the immutable build record.');
  }
  return Number(versionCode);
}

function assertBundle(
  bundle: androidpublisher_v3.Schema$Bundle,
  versionCode: number,
  sha256: string,
): void {
  if (bundle.versionCode !== versionCode || bundle.sha256?.toLowerCase() !== sha256) {
    throw new Error('Google Play returned a different bundle version or SHA-256.');
  }
}

function findVersionBundle(
  bundles: readonly androidpublisher_v3.Schema$Bundle[],
  versionCode: number,
  sha256: string,
): androidpublisher_v3.Schema$Bundle | undefined {
  const sameVersion = bundles.find((bundle) => bundle.versionCode === versionCode);
  if (sameVersion !== undefined) {
    assertBundle(sameVersion, versionCode, sha256);
  }
  return sameVersion;
}

async function getInternalTrack(
  publisher: androidpublisher_v3.Androidpublisher,
  packageName: string,
  editId: string,
): Promise<androidpublisher_v3.Schema$Track> {
  try {
    return (await publisher.edits.tracks.get({
      packageName,
      editId,
      track: trackName,
    })).data;
  } catch (error) {
    if (isHttpStatus(error, 404)) {
      return { track: trackName, releases: [] };
    }
    throw error;
  }
}

function isHttpStatus(error: unknown, status: number): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const value = error as { code?: unknown; response?: { status?: unknown } };
  return value.code === status || value.response?.status === status;
}

function hasVersion(
  releases: readonly androidpublisher_v3.Schema$TrackRelease[] | undefined,
  versionCode: number,
): boolean {
  return releases?.some((release) => release.versionCodes?.includes(String(versionCode))) ?? false;
}

function hasCompletedVersion(
  releases: readonly androidpublisher_v3.Schema$TrackRelease[] | undefined,
  versionCode: number,
): boolean {
  return releases?.some((release) => release.status === 'completed'
    && release.versionCodes?.includes(String(versionCode))) ?? false;
}

function result(
  input: PlayInternalSubmissionInput,
  editId: string,
  versionCode: number,
  alreadyCommitted: boolean,
): PlayInternalSubmissionResult {
  return {
    status: 'committed',
    packageName: input.packageName,
    editId,
    track: trackName,
    versionCode,
    bundleSha256: input.record.artifactSha256,
    alreadyCommitted,
  };
}
