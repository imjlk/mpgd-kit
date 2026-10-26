import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  createReadStream,
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  ReleaseProcessError,
  runReleaseProcess,
  type ReleaseProcessInput,
  type ReleaseProcessResult,
} from './deploy-process.js';
import type { NativeDsymIdentity } from './native-build-symbols.js';
import {
  readNativeReleaseStatus,
  recordCrashSymbolUpload,
  type CrashSymbolUploadRecord,
  type RecordedSymbolFile,
} from './release-state.js';

// Uploads the dSYMs recorded with an iOS build to Firebase Crashlytics with
// Firebase's own `upload-symbols` (the copy recorded from the build's package
// checkout) and the `GoogleService-Info.plist` the archived app bundles:
//
//     upload-symbols -gsp GoogleService-Info.plist -p ios dSYMs.zip
//
// Firebase documents this command for uploading dSYMs outside the Xcode run
// script (https://firebase.google.com/docs/crashlytics/ios/get-deobfuscated-reports);
// the tool's usage text accepts "zip archives containing dSYMs". The outcome is
// recorded next to the immutable build record, so an upload is done once and a
// failed one can be retried with `mpgd deploy symbols`. It never touches a store
// submission.

const uploadTimeoutMs = 10 * 60_000;

export interface CrashSymbolUploadPlan {
  readonly releaseKey: string;
  readonly buildRunId: string;
  readonly dsymArchiveSha256: string;
  readonly dsyms: readonly NativeDsymIdentity[];
  /** `upload-symbols` and its arguments, with the recorded (game-relative) files. */
  readonly command: readonly string[];
}

export type CrashSymbolUploadResult =
  | { readonly status: 'not-applicable'; readonly reason: string }
  | { readonly status: 'already-uploaded'; readonly upload: CrashSymbolUploadRecord }
  | { readonly status: 'planned'; readonly plan: CrashSymbolUploadPlan }
  | {
      readonly status: 'uploaded';
      readonly plan: CrashSymbolUploadPlan;
      readonly upload: CrashSymbolUploadRecord;
      readonly output: string;
    }
  | {
      readonly status: 'failed';
      readonly plan: CrashSymbolUploadPlan;
      readonly error: string;
      readonly output: string;
      /** Absent when the failure itself could not be recorded. */
      readonly upload?: CrashSymbolUploadRecord;
    };

export interface UploadRecordedCrashSymbolsInput {
  readonly gameRoot: string;
  readonly gameId: string;
  readonly releaseKey: string;
  /** Print the planned upload; run nothing and record nothing. */
  readonly dryRun?: boolean;
  readonly environment?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
}

/** Injection boundary for tests; production uses the release state and a child process. */
export interface CrashSymbolUploadPorts {
  readonly readStatus: typeof readNativeReleaseStatus;
  readonly recordUpload: typeof recordCrashSymbolUpload;
  readonly run: (input: ReleaseProcessInput) => Promise<ReleaseProcessResult>;
  readonly platform: NodeJS.Platform;
}

const productionPorts: CrashSymbolUploadPorts = {
  readStatus: readNativeReleaseStatus,
  recordUpload: recordCrashSymbolUpload,
  run: runReleaseProcess,
  platform: process.platform,
};

/** Upload (or, with `dryRun`, plan) the Crashlytics dSYMs of one recorded iOS build. */
export async function uploadRecordedCrashSymbols(
  input: UploadRecordedCrashSymbolsInput,
  ports: CrashSymbolUploadPorts = productionPorts,
): Promise<CrashSymbolUploadResult> {
  const stateInput = {
    gameRoot: input.gameRoot,
    gameId: input.gameId,
    releaseKey: input.releaseKey,
    ...(input.environment === undefined ? {} : { environment: input.environment }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  };
  const status = await ports.readStatus(stateInput);
  const build = status.builds.ios;
  if (build === undefined) {
    throw new Error('This release has no recorded iOS build.');
  }
  const symbols = build.crashlyticsSymbols;
  if (symbols === undefined) {
    return {
      status: 'not-applicable',
      reason: 'The iOS build recorded no Crashlytics dSYMs: crash reporting is off, or the build '
        + 'was recorded before deploy run recorded dSYMs (upload those by hand, see '
        + 'docs/CRASH_REPORTING.md).',
    };
  }
  const previous = status.symbolUploads?.ios;
  if (previous?.status === 'uploaded' && previous.buildRunId === build.buildRunId
    && previous.dsymArchiveSha256 === symbols.dsymArchive.sha256) {
    return { status: 'already-uploaded', upload: previous };
  }
  const plan: CrashSymbolUploadPlan = {
    releaseKey: input.releaseKey,
    buildRunId: build.buildRunId,
    dsymArchiveSha256: symbols.dsymArchive.sha256,
    dsyms: symbols.dsyms,
    command: [
      symbols.uploadTool.location,
      '-gsp',
      symbols.googleServiceInfo.location,
      '-p',
      'ios',
      symbols.dsymArchive.location,
    ],
  };
  // The recorded files must be the build's bytes, also for a dry run.
  const tool = await verifiedRecordedFile(input.gameRoot, symbols.uploadTool, 'upload-symbols');
  const plist = await verifiedRecordedFile(
    input.gameRoot,
    symbols.googleServiceInfo,
    'GoogleService-Info.plist',
  );
  const archive = await verifiedRecordedFile(input.gameRoot, symbols.dsymArchive, 'dSYM archive');
  if (input.dryRun === true) {
    return { status: 'planned', plan };
  }
  if (ports.platform !== 'darwin') {
    throw new Error('Firebase upload-symbols is a macOS tool; upload the dSYMs from a Mac.');
  }
  const record = async (
    outcome: 'uploaded' | 'failed',
    failure?: string,
  ): Promise<CrashSymbolUploadRecord> => ports.recordUpload({
    ...stateInput,
    buildRunId: build.buildRunId,
    dsymArchiveSha256: symbols.dsymArchive.sha256,
    status: outcome,
    ...(failure === undefined ? {} : { failure }),
  });
  // Run a private executable copy: a restored workflow artifact loses its mode
  // bits, and the recorded file itself stays untouched.
  const workDirectory = mkdtempSync(path.join(tmpdir(), 'mpgd-crash-symbols-'));
  let output = '';
  try {
    const executable = path.join(workDirectory, 'upload-symbols');
    copyFileSync(tool, executable);
    chmodSync(executable, 0o700);
    if (await sha256(executable) !== symbols.uploadTool.sha256) {
      throw new Error('The copied upload-symbols differs from the recorded tool.');
    }
    try {
      const result = await ports.run({
        command: executable,
        args: ['-gsp', plist, '-p', 'ios', archive],
        cwd: workDirectory,
        environment: uploadEnvironment(input.environment ?? process.env, workDirectory),
        timeoutMs: uploadTimeoutMs,
        signal: input.signal,
      });
      output = result.output;
    } catch (error) {
      output = error instanceof ReleaseProcessError ? error.output : '';
      const reason = describeFailure(error);
      let upload: CrashSymbolUploadRecord | undefined;
      try {
        upload = await record('failed', reason);
      } catch {
        upload = undefined;
      }
      return {
        status: 'failed',
        plan,
        error: reason,
        output,
        ...(upload === undefined ? {} : { upload }),
      };
    }
  } finally {
    rmSync(workDirectory, { recursive: true, force: true });
  }
  return { status: 'uploaded', plan, upload: await record('uploaded'), output };
}

/** Only what the tool needs (and network proxy settings): no store, signing or Git credentials. */
function uploadEnvironment(source: NodeJS.ProcessEnv, temporary: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { TMPDIR: temporary };
  for (const name of [
    'PATH',
    'HOME',
    'USER',
    'LANG',
    'LC_ALL',
    'HTTPS_PROXY',
    'https_proxy',
    'HTTP_PROXY',
    'http_proxy',
    'NO_PROXY',
    'no_proxy',
    'SSL_CERT_FILE',
  ]) {
    const value = source[name];
    if (value !== undefined) {
      environment[name] = value;
    }
  }
  return environment;
}

function describeFailure(error: unknown): string {
  if (error instanceof ReleaseProcessError) {
    if (error.reason === 'exit') {
      return `upload-symbols exited with code ${String(error.exitCode ?? 'unknown')}`;
    }
    return error.reason === 'timeout'
      ? 'upload-symbols timed out'
      : `upload-symbols ${error.reason === 'spawn' ? 'could not start' : 'was aborted'}`;
  }
  return error instanceof Error ? error.message : String(error);
}

async function verifiedRecordedFile(
  gameRoot: string,
  recorded: RecordedSymbolFile,
  label: string,
): Promise<string> {
  const root = realpathSync(gameRoot);
  const candidate = path.resolve(root, recorded.location);
  if (!existsSync(candidate) || !statSync(candidate).isFile()) {
    throw new Error(
      `The recorded ${label} is missing: ${recorded.location}. Restore the release bundle `
        + '(.mpgd/releases/<release>) the build wrote.',
    );
  }
  const file = realpathSync(candidate);
  const relative = path.relative(root, file);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)) {
    throw new Error(`The recorded ${label} resolves outside the game directory.`);
  }
  if (await sha256(file) !== recorded.sha256) {
    throw new Error(`The recorded ${label} differs from the immutable build record.`);
  }
  return file;
}

async function sha256(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

/** The command that retries a failed upload for one release. */
export function crashSymbolsRetryCommand(input: { readonly gameId: string; readonly releaseKey: string }): string {
  return `mpgd deploy symbols --game . --game-id ${input.gameId} --release ${input.releaseKey}`;
}

/**
 * The `mpgd deploy run` step: upload the recorded dSYMs of the release's iOS
 * build once. A failure (or an error reading the files or the state) is
 * reported with the retry command and never thrown, so it cannot fail or
 * block the store submission.
 */
export async function uploadCrashSymbolsForDeployRun(
  input: UploadRecordedCrashSymbolsInput,
  report: (message: string) => void = (message) => console.warn(message),
  upload: typeof uploadRecordedCrashSymbols = uploadRecordedCrashSymbols,
): Promise<CrashSymbolUploadResult | undefined> {
  const retry = crashSymbolsRetryCommand(input);
  try {
    const result = await upload(input);
    if (result.status === 'uploaded') {
      report(`Crashlytics: uploaded the iOS dSYMs (${result.plan.dsyms
        .map((entry) => entry.bundle).join(', ')}).`);
    } else if (result.status === 'failed') {
      report(`warning: Crashlytics dSYM upload failed (${result.error}); the store submission `
        + `is not affected. Retry with: ${retry}${result.output === '' ? '' : `\n${result.output}`}`);
    }
    return result;
  } catch (error) {
    report(`warning: Crashlytics dSYM upload did not run (${
      error instanceof Error ? error.message : String(error)}); the store submission is not `
      + `affected. Retry with: ${retry}`);
    return undefined;
  }
}
