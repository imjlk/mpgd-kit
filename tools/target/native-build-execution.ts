import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

import { withIosSigningSession } from '../../packages/cli/src/ios-signing-session';
import { stageNativeIconResources } from '../icons/staging';
import type { GeneratedTargetIcons } from '../icons/types';
import { inspectSignedAndroidBundle } from './native-android-inspection';
import type { NativeBuildPlan } from './native-build-mode';
import { createNativeShellStage } from './native-build-stage';
import { inspectSignedIosArchive, inspectSignedIosIpa } from './native-ios-inspection';
import { resolveIosSigningPlan } from './native-ios-signing';
import {
  assertNativeReleaseIdentity,
  runNativeSyncWithIdentityCheck,
} from './native-release-identity';
import type { PlatformTargetConfig } from './schemas';

export interface NativeBuildExecutionInput {
  readonly targetName: string;
  readonly target: PlatformTargetConfig;
  readonly profile: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly plan: NativeBuildPlan;
  readonly artifactRoot: string;
  readonly webBundle: string;
  readonly generatedIcons: GeneratedTargetIcons;
  readonly targetPath: (path: string) => string;
  readonly replaceDirectory: (source: string, destination: string) => void;
  readonly copyFile: (source: string, destination: string) => void;
  readonly ensureCapacitorPlatform: (
    shellApp: string,
    platform: 'android' | 'ios',
    environment: NodeJS.ProcessEnv,
  ) => void;
  readonly copyIosSyncSwiftPackage: (
    shellApp: string,
    releaseArtifact: string,
    packageName: string,
    swiftPackageName: string,
  ) => void;
  readonly run: (
    command: string,
    args: readonly string[],
    environment: NodeJS.ProcessEnv,
    cwd?: string,
  ) => void;
}

/** The Gradle/Xcode execution path shared by the Kit script and installed CLI. */
export async function executeNativeTargetBuild(input: NativeBuildExecutionInput): Promise<string> {
  const { target, targetName, profile, environment, plan, artifactRoot, webBundle } = input;
  if (target.kind !== 'capacitor-android' && target.kind !== 'capacitor-ios') {
    throw new Error(`Target ${targetName} is not a Capacitor native target.`);
  }
  const platform: 'android' | 'ios' = target.kind === 'capacitor-android' ? 'android' : 'ios';
  if (plan.platform !== platform) {
    throw new Error(`Native build plan platform ${plan.platform} does not match ${platform}.`);
  }
  const webDir = input.targetPath(requireString(target.webDir, `${targetName}.webDir`));
  const shellApp = input.targetPath(requireString(target.shellApp, `${targetName}.shellApp`));
  const identityInput = {
    environment,
    metadata: target.metadata,
    platform,
    required: profile === 'production',
    shellApp,
  };
  assertNativeReleaseIdentity(identityInput);
  const stage = createNativeShellStage({ shellApp, webDir });

  try {
    input.replaceDirectory(webBundle, stage.webDir);
    input.ensureCapacitorPlatform(stage.shellApp, platform, environment);
    await stageNativeIconResources(input.generatedIcons, stage.shellApp);
    runNativeSyncWithIdentityCheck({ ...identityInput, shellApp: stage.shellApp }, () => {
      input.run('pnpm', ['--dir', stage.shellApp, 'cap', 'sync', platform], environment);
    });
    return platform === 'android'
      ? executeAndroidBuild(input, stage.shellApp)
      : executeIosBuild(input, stage.shellApp);
  } finally {
    stage.dispose();
  }
}

function executeAndroidBuild(input: NativeBuildExecutionInput, stagedShell: string): string {
  const { plan, artifactRoot, environment, target } = input;
  const androidProject = `${stagedShell}/android`;
  let releaseArtifact: string;
  if (plan.mode === 'sync') {
    releaseArtifact = `${artifactRoot}/capacitor-sync`;
    input.replaceDirectory(androidProject, input.targetPath(releaseArtifact));
  } else if (plan.mode === 'debug') {
    input.run('./gradlew', ['assembleDebug', '--no-daemon'], environment, androidProject);
    releaseArtifact = `${artifactRoot}/app-debug.apk`;
    input.copyFile(
      `${androidProject}/app/build/outputs/apk/debug/app-debug.apk`,
      input.targetPath(releaseArtifact),
    );
  } else if (plan.mode === 'unsigned-archive' || plan.mode === 'signed-archive') {
    input.run(
      './gradlew',
      plan.mode === 'signed-archive'
        ? androidSignedReleaseGradleArgs(environment)
        : ['bundleRelease', '--no-daemon'],
      environment,
      androidProject,
    );
    releaseArtifact = `${artifactRoot}/app-release.aab`;
    input.copyFile(
      `${androidProject}/app/build/outputs/bundle/release/app-release.aab`,
      input.targetPath(releaseArtifact),
    );
    if (plan.mode === 'signed-archive') {
      inspectSignedAndroidBundle({
        bundle: input.targetPath(releaseArtifact),
        expectedPackageId: requireString(target.metadata?.packageId, 'Android package ID'),
        expectedVersionCode: requireString(
          environment.MPGD_TARGET_VERSION_CODE,
          'MPGD_TARGET_VERSION_CODE',
        ),
        expectedVersionName: requireString(
          environment.MPGD_TARGET_VERSION_NAME,
          'MPGD_TARGET_VERSION_NAME',
        ),
        expectedSignerSha256: requireString(
          environment.MPGD_ANDROID_UPLOAD_CERT_SHA256,
          'MPGD_ANDROID_UPLOAD_CERT_SHA256',
        ),
        ...(environment.MPGD_BUNDLETOOL_JAR === undefined
          ? {} : { bundletoolJar: environment.MPGD_BUNDLETOOL_JAR }),
      });
    }
  } else {
    throw new Error(`Unsupported Android build mode: ${plan.mode}.`);
  }
  return releaseArtifact;
}

export function androidSignedReleaseGradleArgs(environment: NodeJS.ProcessEnv): readonly string[] {
  const initScript = environment.MPGD_ANDROID_SIGNING_INIT_SCRIPT;
  if (initScript === undefined || initScript === '') {
    return ['bundleRelease', '--no-daemon'];
  }
  if (!isAbsolute(initScript) || !existsSync(initScript) || !statSync(initScript).isFile()) {
    throw new Error('Android upload signing init script must be an existing absolute file.');
  }
  return ['bundleRelease', '--no-daemon', '--init-script', initScript];
}

async function executeIosBuild(input: NativeBuildExecutionInput, stagedShell: string): Promise<string> {
  const { plan, artifactRoot, target } = input;
  const p12File = input.environment.MPGD_IOS_SIGNING_P12;
  if ((plan.mode === 'signed-archive' || plan.mode === 'store-export')
    && p12File !== undefined && p12File !== '') {
    return withIosSigningSession(
      {
        p12File,
        p12Password: requireString(
          input.environment.MPGD_IOS_SIGNING_P12_PASSWORD,
          'MPGD_IOS_SIGNING_P12_PASSWORD',
        ),
        provisioningProfileFile: requireString(
          input.environment.MPGD_IOS_PROVISIONING_PROFILE_FILE,
          'MPGD_IOS_PROVISIONING_PROFILE_FILE',
        ),
        teamId: requireString(input.environment.MPGD_IOS_TEAM_ID, 'MPGD_IOS_TEAM_ID'),
        bundleId: requireString(target.metadata?.bundleId, 'iOS bundle ID'),
        environment: input.environment,
      },
      async (session) => executeIosBuildWithEnvironment(input, stagedShell, session.environment),
    );
  }
  return executeIosBuildWithEnvironment(input, stagedShell, input.environment);
}

function executeIosBuildWithEnvironment(
  input: NativeBuildExecutionInput,
  stagedShell: string,
  environment: NodeJS.ProcessEnv,
): string {
  const { plan, artifactRoot, target } = input;
  let releaseArtifact: string;
  if (plan.mode === 'unsigned-archive') {
    releaseArtifact = `${artifactRoot}/App.xcarchive`;
    mkdirSync(dirname(input.targetPath(releaseArtifact)), { recursive: true });
    input.run(
      'xcodebuild',
      [
        'archive',
        '-project',
        'App/App.xcodeproj',
        '-scheme',
        'App',
        '-configuration',
        'Release',
        '-destination',
        'generic/platform=iOS',
        '-archivePath',
        input.targetPath(releaseArtifact),
        'CODE_SIGNING_ALLOWED=NO',
      ],
      environment,
      `${stagedShell}/ios`,
    );
  } else if (plan.mode === 'simulator') {
    const buildRoot = mkdtempSync(join(tmpdir(), 'mpgd-ios-simulator-'));
    releaseArtifact = `${artifactRoot}/App.app`;
    try {
      input.run(
        'xcodebuild',
        [
          'build',
          '-project',
          'App/App.xcodeproj',
          '-target',
          'App',
          '-configuration',
          'Release',
          '-sdk',
          'iphonesimulator',
          `SYMROOT=${buildRoot}`,
          `OBJROOT=${join(buildRoot, 'Intermediates.noindex')}`,
          'INFOPLIST_FILE=App/Info-Smoke.plist',
          'EXCLUDED_SOURCE_FILE_NAMES=Main.storyboard LaunchScreen.storyboard Assets.xcassets',
          'ASSETCATALOG_COMPILER_APPICON_NAME=',
          'SWIFT_ACTIVE_COMPILATION_CONDITIONS=MPGD_SMOKE_NO_STORYBOARD',
          'CODE_SIGNING_ALLOWED=NO',
        ],
        environment,
        `${stagedShell}/ios`,
      );
      input.replaceDirectory(
        `${buildRoot}/Release-iphonesimulator/App.app`,
        input.targetPath(releaseArtifact),
      );
    } finally {
      rmSync(buildRoot, { recursive: true, force: true });
    }
  } else if (plan.mode === 'sync') {
    console.warn(
      'ios: cap sync completed; set MPGD_RUN_IOS_SIMULATOR_BUILD=1 for a simulator .app or MPGD_RUN_IOS_ARCHIVE=1 for an xcarchive.',
    );
    releaseArtifact = `${artifactRoot}/capacitor-sync`;
    input.replaceDirectory(`${stagedShell}/ios`, input.targetPath(releaseArtifact));
    input.copyIosSyncSwiftPackage(
      stagedShell,
      releaseArtifact,
      '@mpgd/capacitor-game-services',
      'MpgdCapacitorGameServices',
    );
    input.copyIosSyncSwiftPackage(stagedShell, releaseArtifact, '@capacitor/app', 'CapacitorApp');
  } else if (plan.mode === 'signed-archive' || plan.mode === 'store-export') {
    const signing = resolveIosSigningPlan(environment, plan.mode);
    const archiveArtifact = `${artifactRoot}/App.xcarchive`;
    mkdirSync(dirname(input.targetPath(archiveArtifact)), { recursive: true });
    input.run(
      'xcodebuild',
      [
        'archive',
        '-project',
        'App/App.xcodeproj',
        '-scheme',
        'App',
        '-configuration',
        'Release',
        '-destination',
        'generic/platform=iOS',
        '-archivePath',
        input.targetPath(archiveArtifact),
        ...signing.archiveBuildSettings,
      ],
      environment,
      `${stagedShell}/ios`,
    );
    const expectedIosIdentity = {
      expectedBundleId: requireString(target.metadata?.bundleId, 'iOS bundle ID'),
      expectedMarketingVersion: requireString(
        environment.MPGD_TARGET_MARKETING_VERSION,
        'MPGD_TARGET_MARKETING_VERSION',
      ),
      expectedBuildNumber: requireString(
        environment.MPGD_TARGET_BUILD_NUMBER,
        'MPGD_TARGET_BUILD_NUMBER',
      ),
      expectedTeamId: signing.teamId,
    };
    inspectSignedIosArchive(input.targetPath(archiveArtifact), expectedIosIdentity);
    releaseArtifact = archiveArtifact;
    if (plan.mode === 'store-export') {
      const exportRoot = mkdtempSync(join(tmpdir(), 'mpgd-ios-export-'));
      try {
        input.run(
          'xcodebuild',
          [
            '-exportArchive',
            '-archivePath',
            input.targetPath(archiveArtifact),
            '-exportPath',
            exportRoot,
            '-exportOptionsPlist',
            requireString(signing.exportOptionsPlist, 'iOS export options plist'),
          ],
          environment,
          `${stagedShell}/ios`,
        );
        const exportedIpas = readdirSync(exportRoot).filter((name) => name.endsWith('.ipa'));
        if (exportedIpas.length !== 1) {
          throw new Error('iOS store export must produce exactly one IPA.');
        }
        releaseArtifact = `${artifactRoot}/App.ipa`;
        input.copyFile(join(exportRoot, exportedIpas[0] ?? ''), input.targetPath(releaseArtifact));
        inspectSignedIosIpa(input.targetPath(releaseArtifact), expectedIosIdentity);
      } finally {
        rmSync(exportRoot, { recursive: true, force: true });
      }
    }
  } else {
    throw new Error(`Unsupported iOS build mode: ${plan.mode}.`);
  }
  return releaseArtifact;
}

function requireString(value: string | undefined, label: string): string {
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing target config value: ${label}`);
  }
  return value;
}
