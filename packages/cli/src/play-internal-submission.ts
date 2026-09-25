import { createHash } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';

import type {
  PlayBundle,
  PlayPublisher,
  PlayTrack,
  PlayTrackRelease,
} from './play-publisher-port.js';
import { inspectAndroidBundleSigner } from './android-bundle-signer.js';
import type { ImmutableNativeBuildRecord } from './release-state.js';

const sha256Pattern = /^[a-f0-9]{64}$/u;
const trackName = 'internal';
const bundleUploadTimeoutMs = 120_000;

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
    readonly stage: 'upload' | 'track-update' | 'validate' | 'commit',
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

/** Internal injection point for credential-free SDK contract tests. */
export async function submitVerifiedAndroidBundleWithPublisher(
  input: PlayInternalSubmissionInput,
  publisher: PlayPublisher,
  requestRootUrl?: string,
): Promise<PlayInternalSubmissionResult> {
  const versionCode = await preflight(input);
  const expectedSha256 = input.record.artifactSha256;
  const packageName = input.packageName;
  const editId = await publisher.insertEdit(packageName);
  await input.onEditCreated?.(editId);

  let bundles = await publisher.listBundles(packageName, editId);
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
      const uploaded = await publisher.uploadBundle({
        packageName,
        editId,
        aabFile: input.aabFile,
        timeoutMs: bundleUploadTimeoutMs,
        ...(requestRootUrl === undefined ? {} : { requestRootUrl }),
      });
      assertBundle(uploaded, versionCode, expectedSha256);
    } catch (error) {
      if (isDefinitiveHttpError(error)) {
        throw error;
      }
      try {
        bundles = await publisher.listBundles(packageName, editId);
        existing = findVersionBundle(bundles, versionCode, expectedSha256);
      } catch {
        throw new PlaySubmissionUncertainError('upload', editId);
      }
      if (existing === undefined) {
        throw new PlaySubmissionUncertainError('upload', editId);
      }
    }
  }

  const release: PlayTrackRelease = {
    name: input.record.releaseKey,
    status: 'completed',
    versionCodes: [String(versionCode)],
  };
  const desired: PlayTrack = {
    track: trackName,
    releases: [...(currentTrack.releases ?? []), release],
  };
  try {
    await publisher.updateTrack(packageName, editId, desired);
  } catch (error) {
    let applied: boolean;
    try {
      const observed = await getInternalTrack(publisher, packageName, editId);
      applied = hasCompletedVersion(observed.releases, versionCode);
    } catch {
      throw new PlaySubmissionUncertainError('track-update', editId);
    }
    if (!applied) {
      throw error;
    }
  }
  try {
    await publisher.validateEdit(packageName, editId);
  } catch (error) {
    if (isDefinitiveHttpError(error)) {
      throw error;
    }
    throw new PlaySubmissionUncertainError('validate', editId);
  }
  try {
    await publisher.commitEdit(packageName, editId);
    return result(input, editId, versionCode, false);
  } catch {
    // Inserting a new edit invalidates the first edit for this API user. A
    // failed commit response cannot safely be reconciled by creating one.
    throw new PlaySubmissionUncertainError('commit', editId);
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

async function getInternalTrack(
  publisher: PlayPublisher,
  packageName: string,
  editId: string,
): Promise<PlayTrack> {
  try {
    return await publisher.getTrack(packageName, editId);
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

function isDefinitiveHttpError(error: unknown): boolean {
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

function hasCompletedVersion(
  releases: readonly PlayTrackRelease[] | null | undefined,
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
