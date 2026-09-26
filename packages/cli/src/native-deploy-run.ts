import { createHash } from 'node:crypto';
import {
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import path from 'node:path';

import type { PlatformVersionLedger } from '@mpgd/target-config';

import {
  readNativeDeployTargetProfile,
  type NativeDeploymentPlan,
  type NativeDeployTarget,
} from './deploy-planning.js';
import { withAndroidUploadSigningSession } from './android-signing-session.js';
import { withIosSigningSession } from './ios-signing-session.js';
import {
  submitRecordedNativeTarget,
  type NativeStoreCredential,
} from './native-deploy-submission.js';
import {
  readNativeReleaseStatus,
  recordNativeReleaseBuild,
  reserveNativeRelease,
  type NativeReleaseStatus,
} from './release-state.js';
import {
  installPinnedReleaseDependencies,
  pinNativeDeploymentPlan,
  runPinnedNativeBuild,
  withPinnedReleaseWorkspace,
  type PinnedReleaseWorkspace,
} from './release-workspace.js';
import { inspectAndroidBundleSigner } from './android-bundle-signer.js';

export interface RunNativeDeploymentInput {
  readonly plan: NativeDeploymentPlan;
  readonly releaseKey: string;
  readonly gameId: string;
  readonly gameVersion: string;
  readonly kit: { readonly packageVersion: string; readonly gitSha: string };
  /** Required only when no game ledger exists on release-state. */
  readonly initialLedger?: PlatformVersionLedger;
  readonly approved: boolean;
  readonly environment?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
}

/** Reserve once, build only missing targets, then submit the recorded binaries. */
export async function runNativeDeployment(input: RunNativeDeploymentInput): Promise<NativeReleaseStatus> {
  if (!input.approved) {
    throw new Error('Native deployment requires explicit internal-test approval.');
  }
  const environment = input.environment ?? process.env;
  const pinned = await pinNativeDeploymentPlan(input.plan, input.kit, {
    environment,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  const reserved = await reserveNativeRelease({
    gameRoot: input.plan.gameRoot,
    gameId: input.gameId,
    releaseKey: input.releaseKey,
    gameVersion: input.gameVersion,
    sourceGitSha: pinned.gameGitSha,
    kitGitSha: pinned.kitGitSha,
    targetConfigDigest: pinned.targetConfigSha256,
    targets: input.plan.targets.map((entry) => ({ target: entry.target })),
    ...(input.initialLedger === undefined ? {} : { initialLedger: input.initialLedger }),
    environment,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  let status = await readNativeReleaseStatus({
    gameRoot: input.plan.gameRoot,
    gameId: input.gameId,
    releaseKey: input.releaseKey,
    environment,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  const missing = planNativeDeploymentSteps(input.plan, status).buildTargets;
  if (missing.length > 0) {
    await withPinnedReleaseWorkspace(pinned, async (workspace) => {
      await installPinnedReleaseDependencies(workspace, {
        environment,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      for (const target of missing) {
        await buildAndRecordTarget(input, workspace, target, reserved.plan, environment);
      }
    }, {
      environment,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  }
  for (const entry of input.plan.targets) {
    status = await readNativeReleaseStatus({
      gameRoot: input.plan.gameRoot,
      gameId: input.gameId,
      releaseKey: input.releaseKey,
      environment,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (status.builds[entry.target] === undefined) {
      throw new Error(`${entry.target} has no verified build after the native build stage.`);
    }
    if (status.submissions[entry.target]?.status === 'committed'
      || status.submissions[entry.target]?.status === 'testflight-ready') {
      continue;
    }
    await submitRecordedNativeTarget({
      plan: input.plan,
      gameId: input.gameId,
      releaseKey: input.releaseKey,
      credential: readStoreCredential(input.plan, entry.target, environment),
      approved: input.approved,
      environment,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  }
  return readNativeReleaseStatus({
    gameRoot: input.plan.gameRoot,
    gameId: input.gameId,
    releaseKey: input.releaseKey,
    environment,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
}

/** Explain the next safe work without treating a missing or unknown store status as success. */
export function planNativeDeploymentSteps(
  plan: NativeDeploymentPlan,
  status: NativeReleaseStatus,
): {
  readonly buildTargets: readonly NativeDeployTarget[];
  readonly submitTargets: readonly NativeDeployTarget[];
} {
  const expected = plan.targets.map((entry) => entry.target);
  const reserved = Object.keys(status.plan.targets).sort();
  if (JSON.stringify([...expected].sort()) !== JSON.stringify(reserved)
    || status.plan.targetConfigDigest !== plan.targetConfigSha256) {
    throw new Error('Native release reservation differs from the saved deployment plan.');
  }
  const buildTargets: NativeDeployTarget[] = [];
  const submitTargets: NativeDeployTarget[] = [];
  for (const entry of plan.targets) {
    const build = status.builds[entry.target];
    if (build === undefined) {
      buildTargets.push(entry.target);
    } else if (build.inspectedAppId !== entry.appId) {
      throw new Error(`${entry.target} build record app ID differs from the deployment plan.`);
    }
    const submission = status.submissions[entry.target];
    if (submission !== undefined && build === undefined) {
      throw new Error(`${entry.target} store checkpoint has no immutable build.`);
    }
    if (submission?.status !== 'committed' && submission?.status !== 'testflight-ready') {
      submitTargets.push(entry.target);
    }
  }
  return { buildTargets, submitTargets };
}

async function buildAndRecordTarget(
  input: RunNativeDeploymentInput,
  workspace: PinnedReleaseWorkspace,
  target: NativeDeployTarget,
  reserved: Awaited<ReturnType<typeof reserveNativeRelease>>['plan'],
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const planned = input.plan.targets.find((entry) => entry.target === target);
  const version = reserved.targets[target];
  if (planned === undefined || version === undefined) {
    throw new Error('Native build target lacks its reserved version.');
  }
  const profile = readNativeDeployTargetProfile(input.plan, target);
  const buildEnvironment: NodeJS.ProcessEnv = {
    ...environment,
    APP_VERSION: input.gameVersion,
    BUILD_ID: reserved.buildId,
    MPGD_RELEASE_REVISION: String(reserved.releaseRevision),
    MPGD_RELEASE_LABEL: reserved.releaseLabel,
    ...(target === 'android' ? {
      MPGD_TARGET_VERSION_CODE: String(version.versionCode),
      MPGD_TARGET_VERSION_NAME: String(version.versionName),
    } : {
      MPGD_TARGET_BUILD_NUMBER: String(version.buildNumber),
      MPGD_TARGET_MARKETING_VERSION: String(version.marketingVersion),
    }),
  };
  const run = async (
    signedEnvironment: NodeJS.ProcessEnv,
    secretValues: readonly string[],
    signerOrTeam: string,
  ): Promise<void> => {
    const built = await runPinnedNativeBuild(workspace, {
      target,
      profile: 'production',
      mode: target === 'android' ? 'signed-archive' : 'store-export',
      environment: signedEnvironment,
      secretValues,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    const artifactLocation = `.mpgd/releases/${input.releaseKey}/${target}.${target === 'android' ? 'aab' : 'ipa'}`;
    const manifestLocation = `.mpgd/releases/${input.releaseKey}/${target}-manifest.json`;
    const artifactFile = persistImmutableFile(
      input.plan.gameRoot,
      artifactLocation,
      built.artifact,
    );
    const manifestFile = persistImmutableFile(
      input.plan.gameRoot,
      manifestLocation,
      built.releaseManifest,
    );
    const configDigest = createHash('sha256').update(JSON.stringify({
      gameGitSha: workspace.input.gameGitSha,
      lockfileSha256: workspace.input.lockfileSha256,
      targetConfigSha256: workspace.input.targetConfigSha256,
      deployConfigSha256: workspace.input.deployConfigSha256,
      kitPackageVersion: workspace.input.kitPackageVersion,
      kitGitSha: workspace.input.kitGitSha,
      releaseKey: input.releaseKey,
      target,
      version,
    })).digest('hex');
    const inspectedSignerSha256 = target === 'android'
      ? await inspectAndroidBundleSigner(artifactFile)
      : undefined;
    if (target === 'android' && inspectedSignerSha256 !== signerOrTeam.toLowerCase()) {
      throw new Error('Native Android artifact signer differs from the prepared upload key.');
    }
    await recordNativeReleaseBuild({
      gameRoot: input.plan.gameRoot,
      gameId: input.gameId,
      releaseKey: input.releaseKey,
      target,
      buildRunId: built.runId,
      kitPackageVersion: workspace.input.kitPackageVersion,
      buildConfigDigest: configDigest,
      artifactFile,
      expectedArtifactSha256: sha256(artifactFile),
      artifactLocation,
      releaseManifestFile: manifestFile,
      expectedReleaseManifestSha256: sha256(manifestFile),
      inspectedAppId: planned.appId,
      ...(target === 'android' ? { inspectedSignerSha256 } : { inspectedTeamId: signerOrTeam }),
      environment,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  };
  if (target === 'android') {
    await withAndroidUploadSigningSession(
      {
        keystoreFile: requiredEnvironment(environment, profile.signingCredential.env),
        storePassword: requiredEnvironment(environment, 'MPGD_ANDROID_UPLOAD_STORE_PASSWORD'),
        keyAlias: requiredEnvironment(environment, 'MPGD_ANDROID_UPLOAD_KEY_ALIAS'),
        keyPassword: requiredEnvironment(environment, 'MPGD_ANDROID_UPLOAD_KEY_PASSWORD'),
        expectedCertSha256: requiredEnvironment(environment, 'MPGD_ANDROID_UPLOAD_CERT_SHA256'),
        environment: buildEnvironment,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      },
      async (session) => {
        await run(session.environment, session.secretValues, session.expectedCertSha256);
      },
    );
  } else {
    await withIosSigningSession({
      p12File: requiredEnvironment(environment, profile.signingCredential.env),
      p12Password: requiredEnvironment(environment, 'MPGD_IOS_SIGNING_P12_PASSWORD'),
      provisioningProfileFile: requiredEnvironment(environment, 'MPGD_IOS_PROVISIONING_PROFILE'),
      bundleId: planned.appId,
      teamId: requiredEnvironment(environment, 'MPGD_IOS_TEAM_ID'),
      environment: buildEnvironment,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    }, async (session) => {
      await run(session.environment, [
        requiredEnvironment(environment, 'MPGD_IOS_SIGNING_P12_PASSWORD'),
      ], requiredEnvironment(environment, 'MPGD_IOS_TEAM_ID'));
    });
  }
}

export function readStoreCredential(
  plan: NativeDeploymentPlan,
  target: NativeDeployTarget,
  environment: NodeJS.ProcessEnv,
): NativeStoreCredential {
  const profile = readNativeDeployTargetProfile(plan, target);
  return target === 'android'
    ? {
        target,
        serviceAccountFile: requiredEnvironment(environment, profile.submissionCredential.env),
      }
    : {
        target,
        ascBinary: requiredEnvironment(environment, 'MPGD_ASC_BINARY'),
        appStoreAppId: requiredEnvironment(environment, 'MPGD_ASC_APP_ID'),
        apiKeyId: requiredEnvironment(environment, 'MPGD_ASC_KEY_ID'),
        apiIssuerId: requiredEnvironment(environment, 'MPGD_ASC_ISSUER_ID'),
        apiPrivateKeyBase64: requiredEnvironment(environment, profile.submissionCredential.env),
      };
}

function requiredEnvironment(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`Native deployment requires ${name}.`);
  }
  return value;
}

/** Internal artifact copy primitive; exported for boundary tests, not from the package root. */
export function persistImmutableFile(gameRoot: string, location: string, source: string): string {
  const root = realpathSync(gameRoot);
  const destination = path.resolve(root, location);
  const relative = path.relative(root, destination);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)) {
    throw new Error('Native release output escapes the game directory.');
  }
  const directory = path.dirname(destination);
  let current = root;
  for (const segment of path.relative(root, directory).split(path.sep)) {
    current = path.join(current, segment);
    if (!existsSync(current)) {
      mkdirSync(current, { mode: 0o700 });
    }
    const entry = lstatSync(current);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error('Native release output path contains a symlink or non-directory.');
    }
  }
  if (existsSync(destination) && !lstatSync(destination).isFile()) {
    throw new Error('Native release output must be a regular file.');
  }
  if (!existsSync(destination)) {
    copyFileSync(source, destination, constants.COPYFILE_EXCL);
  }
  if (!statSync(destination).isFile() || sha256(destination) !== sha256(source)) {
    throw new Error('Existing native release output has different bytes.');
  }
  return destination;
}

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}
