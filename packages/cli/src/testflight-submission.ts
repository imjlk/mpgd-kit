import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  createReadStream,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ReleaseProcessError, runReleaseProcess } from './deploy-process.js';
import type { ImmutableNativeBuildRecord } from './release-state.js';

const pinnedAscVersion = '5.5.0';
const sha256Pattern = /^[0-9a-f]{64}$/u;
const teamIdPattern = /^[A-Z0-9]{10}$/u;
const apiKeyIdPattern = /^[A-Z0-9]{10}$/u;
const ascIdPattern = /^[A-Za-z0-9][A-Za-z0-9-]*$/u;
const marketingVersionPattern = /^\d+(?:\.\d+){0,2}$/u;
const uploadTimeoutMs = 12 * 60 * 1000;
const lookupTimeoutMs = 60_000;
const maxJsonBytes = 1024 * 1024;

export type IosTestFlightStatus = 'uploaded' | 'processing' | 'testflight-ready'
  | 'action-required' | 'failed' | 'unknown';

export interface IosTestFlightSubmissionInput {
  readonly record: ImmutableNativeBuildRecord;
  readonly ipaFile: string;
  readonly bundleId: string;
  /** Numeric App Store Connect app ID, not an ambiguous app name. */
  readonly appStoreAppId: string;
  /** Existing internal beta group ID, not a group name. */
  readonly internalGroupId: string;
  /** Absolute path to the pinned asc 5.5.0 binary. */
  readonly ascBinary: string;
  readonly apiKeyId: string;
  readonly apiIssuerId: string;
  readonly apiPrivateKeyBase64: string;
  /** Persist this ID before continuing; supplying it on retry skips uploading. */
  readonly resumeUploadId?: string;
  /** SHA-256 persisted with resumeUploadId by the same release checkpoint. */
  readonly resumeArtifactSha256?: string;
  readonly onUploadCommitted?: (uploadId: string) => Promise<void>;
  readonly signal?: AbortSignal;
}

export interface IosTestFlightSubmissionResult {
  readonly status: IosTestFlightStatus;
  readonly appStoreAppId: string;
  readonly bundleId: string;
  readonly marketingVersion: string;
  readonly buildNumber: string;
  readonly internalGroupId: string;
  readonly uploadId?: string;
  readonly buildId?: string;
  readonly detail?: string;
}

export class IosSubmissionUncertainError extends Error {
  constructor(readonly uploadId: string) {
    super(
      `iOS upload ${uploadId} was committed but its local checkpoint failed; inspect remote state before retry.`,
    );
    this.name = 'IosSubmissionUncertainError';
  }
}

/** A narrow, testable command boundary; no arbitrary public submitter choice. */
export type AscJsonRunner = (args: readonly string[], timeoutMs: number) => Promise<unknown>;

interface ResolvedPreflight {
  readonly marketingVersion: string;
  readonly buildNumber: string;
}

/** Verify and use exactly the pinned asc release, with isolated environment auth. */
export async function submitVerifiedIosBuild(
  input: IosTestFlightSubmissionInput,
): Promise<IosTestFlightSubmissionResult> {
  if (process.platform !== 'darwin') {
    throw new Error('Signed iOS IPA verification requires macOS.');
  }
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'mpgd-asc-session-'));
  try {
    if (!path.isAbsolute(input.ascBinary)) {
      throw new Error('asc binary must be an absolute file path.');
    }
    const binary = path.join(tempRoot, 'asc');
    copyFileSync(input.ascBinary, binary);
    chmodSync(binary, 0o700);
    await verifyPinnedAscBinary(binary);
    const stagedIpa = path.join(tempRoot, 'release.ipa');
    copyFileSync(input.ipaFile, stagedIpa);
    const stagedInput = { ...input, ipaFile: stagedIpa };
    const resolvedPreflight = await preflight(stagedInput);
    const { inspectSignedIosIpa } = await import(
      new URL('./ios-ipa-inspection.js', import.meta.url).href
    ) as { inspectSignedIosIpa: (file: string, expected: {
      expectedBundleId: string;
      expectedMarketingVersion: string;
      expectedBuildNumber: string;
      expectedTeamId: string;
    }) => unknown
    };
    inspectSignedIosIpa(stagedIpa, {
      expectedBundleId: input.bundleId,
      expectedMarketingVersion: resolvedPreflight.marketingVersion,
      expectedBuildNumber: resolvedPreflight.buildNumber,
      expectedTeamId: input.record.inspectedTeamId ?? '',
    });
    const environment = isolatedAscEnvironment(input, tempRoot);
    const runner: AscJsonRunner = async (args, timeoutMs) => {
      const result = await runReleaseProcess({
        command: binary,
        args: [...args, '--output', 'json'],
        cwd: tempRoot,
        environment,
        timeoutMs,
        maxOutputBytes: maxJsonBytes,
        captureMachineStdout: true,
        secretValues: [input.apiKeyId, input.apiIssuerId, input.apiPrivateKeyBase64],
        signal: input.signal,
      });
      if (result.truncated || result.machineStdout === undefined) {
        throw new Error('asc JSON output was truncated or unavailable.');
      }
      try {
        return JSON.parse(result.machineStdout) as unknown;
      } catch {
        throw new Error('asc returned invalid JSON.');
      }
    };
    return await submitVerifiedIosBuildResolved(stagedInput, runner, resolvedPreflight);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

/** Internal mock boundary used by credential-free submission tests. */
export async function submitVerifiedIosBuildWithRunner(
  input: IosTestFlightSubmissionInput,
  run: AscJsonRunner,
): Promise<IosTestFlightSubmissionResult> {
  return submitVerifiedIosBuildResolved(input, run, await preflight(input));
}

async function submitVerifiedIosBuildResolved(
  input: IosTestFlightSubmissionInput,
  run: AscJsonRunner,
  { marketingVersion, buildNumber }: ResolvedPreflight,
): Promise<IosTestFlightSubmissionResult> {
  const base = {
    appStoreAppId: input.appStoreAppId,
    bundleId: input.bundleId,
    marketingVersion,
    buildNumber,
    internalGroupId: input.internalGroupId,
  };
  const app = await run(['apps', 'view', '--id', input.appStoreAppId], lookupTimeoutMs);
  if (!isRecord(app) || !isRecord(app.data) || app.data.id !== input.appStoreAppId
    || app.data.type !== 'apps' || !isRecord(app.data.attributes)
    || app.data.attributes.bundleId !== input.bundleId) {
    throw new Error('App Store Connect app ID does not match the verified IPA bundle ID.');
  }
  const groupsResponse = await run(
    [
      'testflight',
      'groups',
      'list',
      '--app',
      input.appStoreAppId,
      '--internal',
      '--id',
      input.internalGroupId,
      '--paginate',
    ],
    lookupTimeoutMs,
  );
  if (!findInternalGroup(groupsResponse, input.internalGroupId)) {
    throw new Error('Configured TestFlight group is not an internal group of this app.');
  }

  let uploadId = input.resumeUploadId;
  if (uploadId === undefined) {
    const before = await lookupBuild(input, marketingVersion, buildNumber, run);
    if (before !== undefined) {
      return {
        ...base,
        status: 'unknown',
        buildId: before.id,
        detail: 'A build already uses this app version and build number; do not reupload.',
      };
    }
    const existingUploads = await lookupUploadIds(input, marketingVersion, buildNumber, run);
    if (existingUploads.length > 0) {
      return {
        ...base,
        status: 'unknown',
        ...(existingUploads.length === 1 ? { uploadId: existingUploads[0] } : {}),
        detail: 'An upload already exists for this app version and build number; reconcile it before retry.',
      };
    }
    let upload: unknown;
    try {
      upload = await run([
        'builds', 'upload', '--app', input.appStoreAppId,
        '--ipa', input.ipaFile, '--platform', 'IOS',
        '--version', marketingVersion, '--build-number', buildNumber,
        '--checksum',
      ], uploadTimeoutMs);
    } catch (error) {
      const observed = await lookupBuild(input, marketingVersion, buildNumber, run).catch(
        () => undefined,
      );
      return {
        ...base,
        status: 'unknown',
        ...(observed === undefined ? {} : { buildId: observed.id }),
        detail: `Upload result was not confirmed${failureReason(error)}; inspect App Store Connect before retry.`,
      };
    }
    try {
      uploadId = assertUploadResult(upload, statSync(input.ipaFile).size);
    } catch {
      const observed = await lookupBuild(input, marketingVersion, buildNumber, run).catch(
        () => undefined,
      );
      return {
        ...base,
        status: 'unknown',
        ...(observed === undefined ? {} : { buildId: observed.id }),
        detail: 'Upload output was invalid; inspect App Store Connect before retry.',
      };
    }
    try {
      await input.onUploadCommitted?.(uploadId);
    } catch {
      throw new IosSubmissionUncertainError(uploadId);
    }
  } else {
    const matches = (await lookupUploadIds(input, marketingVersion, buildNumber, run))
      .filter((id) => id === uploadId);
    if (matches.length !== 1) {
      return {
        ...base,
        status: 'unknown',
        uploadId,
        detail: 'Checkpointed upload is not uniquely visible for this app and version.',
      };
    }
  }

  let build: ObservedBuild | undefined;
  try {
    build = await lookupBuild(input, marketingVersion, buildNumber, run);
  } catch (error) {
    return {
      ...base,
      status: 'uploaded',
      uploadId,
      detail: `Upload committed; build processing lookup is temporarily unavailable${failureReason(error)}.`,
    };
  }
  if (build === undefined) {
    return {
      ...base,
      status: 'uploaded',
      uploadId,
      detail: 'Upload committed; build is not yet discoverable.',
    };
  }
  if (build.processingState === 'PROCESSING') {
    return { ...base, status: 'processing', uploadId, buildId: build.id };
  }
  if (build.processingState === 'FAILED' || build.processingState === 'INVALID') {
    return {
      ...base,
      status: 'failed',
      uploadId,
      buildId: build.id,
      detail: `App Store Connect reported ${build.processingState}.`,
    };
  }
  if (build.processingState !== 'VALID') {
    return {
      ...base,
      status: 'unknown',
      uploadId,
      buildId: build.id,
      detail: 'App Store Connect returned an unknown processing state.',
    };
  }

  try {
    const added = await run(
      ['builds', 'add-groups', '--build-id', build.id, '--group', input.internalGroupId],
      lookupTimeoutMs,
    );
    assertGroupAssignment(added, build.id, input.internalGroupId);
  } catch (error) {
    const operatorAction = error instanceof ReleaseProcessError
      && error.reason === 'exit'
      && /export compliance|encryption declaration|account agreement|tax and banking/iu
        .test(error.output);
    const status = operatorAction ? 'action-required' : 'unknown';
    return {
      ...base,
      status,
      uploadId,
      buildId: build.id,
      detail: `Build is processed, but internal group assignment needs inspection${failureReason(error)}.`,
    };
  }
  let membershipFailure: unknown;
  try {
    const memberships = await run(
      ['testflight', 'groups', 'list', '--build-id', build.id, '--internal'],
      lookupTimeoutMs,
    );
    if (findInternalGroup(memberships, input.internalGroupId)) {
      return { ...base, status: 'testflight-ready', uploadId, buildId: build.id };
    }
  } catch (error) {
    membershipFailure = error;
    // Membership can be queried again by explicit build ID.
  }
  return {
    ...base,
    status: 'unknown',
    uploadId,
    buildId: build.id,
    detail: `Group assignment response was not confirmed by a membership read${failureReason(membershipFailure)}.`,
  };
}

interface ObservedBuild {
  readonly id: string;
  readonly processingState: string;
}

async function lookupUploadIds(
  input: IosTestFlightSubmissionInput,
  marketingVersion: string,
  buildNumber: string,
  run: AscJsonRunner,
): Promise<readonly string[]> {
  const response = await run(
    [
      'builds',
      'uploads',
      'list',
      '--app',
      input.appStoreAppId,
      '--cf-bundle-short-version',
      marketingVersion,
      '--cf-bundle-version',
      buildNumber,
      '--platform',
      'IOS',
      '--paginate',
    ],
    lookupTimeoutMs,
  );
  const items = readDataArray(response, 'builds uploads list');
  if (items.some((item) => !isRecord(item) || item.type !== 'buildUploads'
    || typeof item.id !== 'string' || !ascIdPattern.test(item.id)
    || !isRecord(item.attributes)
    || typeof item.attributes.cfBundleShortVersionString !== 'string'
    || typeof item.attributes.cfBundleVersion !== 'string'
    || typeof item.attributes.platform !== 'string')) {
    throw new Error('asc builds uploads list returned a malformed upload.');
  }
  return items.filter((item) => isRecord(item) && isRecord(item.attributes)
    && item.attributes.cfBundleShortVersionString === marketingVersion
    && item.attributes.cfBundleVersion === buildNumber
    && item.attributes.platform === 'IOS')
    .map((item) => (item as { id: string }).id);
}

async function lookupBuild(
  input: IosTestFlightSubmissionInput,
  marketingVersion: string,
  buildNumber: string,
  run: AscJsonRunner,
): Promise<ObservedBuild | undefined> {
  const response = await run(
    [
      'builds',
      'list',
      '--app',
      input.appStoreAppId,
      '--version',
      marketingVersion,
      '--build-number',
      buildNumber,
      '--platform',
      'IOS',
      '--paginate',
    ],
    lookupTimeoutMs,
  );
  const items = readDataArray(response, 'builds list');
  if (items.some((item) => !isRecord(item) || item.type !== 'builds'
    || typeof item.id !== 'string' || item.id === ''
    || !isRecord(item.attributes) || typeof item.attributes.version !== 'string'
    || typeof item.attributes.processingState !== 'string')) {
    throw new Error('asc builds list returned a malformed build.');
  }
  const matching = items.filter((item) => (item as { attributes: { version: string } })
    .attributes.version === buildNumber);
  if (matching.length > 1) {
    throw new Error('App Store Connect returned multiple builds for the reserved version.');
  }
  const item = matching[0];
  if (item === undefined) {
    return undefined;
  }
  if (!isRecord(item) || typeof item.id !== 'string' || item.id === ''
    || !isRecord(item.attributes) || typeof item.attributes.processingState !== 'string') {
    throw new Error('asc builds list returned a malformed build.');
  }
  return { id: item.id, processingState: item.attributes.processingState };
}

function findInternalGroup(response: unknown, groupId: string): boolean {
  return readDataArray(response, 'TestFlight groups list').some((value) => isRecord(value)
    && value.type === 'betaGroups' && value.id === groupId
    && isRecord(value.attributes) && value.attributes.isInternalGroup === true);
}

function readDataArray(response: unknown, command: string): readonly unknown[] {
  if (!isRecord(response) || !Array.isArray(response.data)) {
    throw new Error(`asc ${command} returned an invalid JSON schema.`);
  }
  return response.data;
}

function assertUploadResult(value: unknown, expectedBytes: number): string {
  if (!isRecord(value) || typeof value.uploadId !== 'string' || value.uploadId === ''
    || typeof value.fileId !== 'string' || value.fileId === ''
    || value.uploaded !== true || value.fileSize !== expectedBytes
    || (Array.isArray(value.operations) && value.operations.length > 0)) {
    throw new Error('asc upload result was not a confirmed, redacted committed upload.');
  }
  return value.uploadId;
}

function assertGroupAssignment(value: unknown, buildId: string, groupId: string): void {
  if (!isRecord(value) || value.action !== 'added' || value.buildId !== buildId
    || !Array.isArray(value.groupIds)
    || value.groupIds.some((id) => typeof id !== 'string'
      || id !== groupId)) {
    throw new Error('asc returned an invalid TestFlight group assignment.');
  }
}

function failureReason(error: unknown): string {
  return error instanceof ReleaseProcessError ? ` (${error.reason})` : '';
}

async function preflight(input: IosTestFlightSubmissionInput): Promise<ResolvedPreflight> {
  const version = input.record.platformVersion;
  const buildNumber = version.buildNumber;
  const marketingVersion = version.marketingVersion;
  if (input.record.target !== 'ios' || input.bundleId !== input.record.inspectedAppId
    || !teamIdPattern.test(input.record.inspectedTeamId ?? '')
    || !/^[1-9]\d*$/u.test(String(buildNumber))
    || typeof marketingVersion !== 'string'
    || !marketingVersionPattern.test(marketingVersion)
    || !/^\d+$/u.test(input.appStoreAppId)
    || !ascIdPattern.test(input.internalGroupId)
    || (input.resumeUploadId !== undefined && !ascIdPattern.test(input.resumeUploadId))
    || (input.resumeUploadId === undefined) !== (input.resumeArtifactSha256 === undefined)
    || (input.resumeArtifactSha256 !== undefined
      && input.resumeArtifactSha256 !== input.record.artifactSha256)
    || !sha256Pattern.test(input.record.artifactSha256)
    || !input.ipaFile.endsWith('.ipa') || !existsSync(input.ipaFile)
    || !statSync(input.ipaFile).isFile()) {
    throw new Error('TestFlight submission requires a matching verified iOS IPA build record.');
  }
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(input.ipaFile)) {
    hash.update(chunk);
  }
  if (hash.digest('hex') !== input.record.artifactSha256) {
    throw new Error('TestFlight IPA bytes differ from the immutable build record.');
  }
  return { marketingVersion, buildNumber: String(buildNumber) };
}

function isolatedAscEnvironment(input: IosTestFlightSubmissionInput, directory: string): NodeJS.ProcessEnv {
  if (!apiKeyIdPattern.test(input.apiKeyId)
    || input.apiIssuerId.trim() === '' || input.apiPrivateKeyBase64.trim() === '') {
    throw new Error('App Store Connect API credentials are incomplete.');
  }
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.startsWith('ASC_')) {
      delete environment[key];
    }
  }
  return {
    ...environment,
    HOME: directory,
    CFFIXED_USER_HOME: directory,
    XDG_CONFIG_HOME: directory,
    TMPDIR: directory,
    TMP: directory,
    TEMP: directory,
    ASC_TELEMETRY_DISABLED: '1',
    ASC_BYPASS_KEYCHAIN: '1',
    ASC_STRICT_AUTH: '1',
    ASC_KEY_ID: input.apiKeyId,
    ASC_ISSUER_ID: input.apiIssuerId,
    ASC_PRIVATE_KEY_B64: input.apiPrivateKeyBase64,
    ASC_TIMEOUT: '60s',
    ASC_UPLOAD_TIMEOUT: '10m',
  };
}

/** The package consumes one reviewed asc pin; it does not trust PATH or version text. */
export async function verifyPinnedAscBinary(
  binary: string,
  pinFile = fileURLToPath(new URL('./asc-pin.json', import.meta.url)),
): Promise<void> {
  if (!path.isAbsolute(binary) || !existsSync(binary) || !statSync(binary).isFile()) {
    throw new Error('asc binary must be an existing absolute file.');
  }
  const pin = JSON.parse(readFileSync(pinFile, 'utf8')) as unknown;
  const host = `${process.platform}-${process.arch}`;
  if (!isRecord(pin) || pin.version !== pinnedAscVersion
    || !isRecord(pin.assets) || !isRecord(pin.assets[host])) {
    throw new Error('No reviewed asc binary pin exists for this host.');
  }
  const expected = pin.assets[host].sha256;
  if (typeof expected !== 'string' || !sha256Pattern.test(expected)) {
    throw new Error('Reviewed asc binary pin is malformed.');
  }
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(realpathSync(binary))) {
    hash.update(chunk);
  }
  if (hash.digest('hex') !== expected) {
    throw new Error('asc binary checksum differs from the reviewed 5.5.0 pin.');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
