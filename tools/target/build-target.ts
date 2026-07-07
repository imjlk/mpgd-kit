import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';

import { embeddedTargetConfigFileName, writeEffectiveTargetConfigs } from './effective-config';
import {
  effectiveTargetConfigOutputDir,
  loadPlatformTargetsConfig,
  releaseManifestPath,
  resolveFromPlatformTargetsBase,
} from './platform-targets';
import type { TargetReleaseMetadata } from './schemas';

const [targetName = 'web-preview', profile = 'production'] = process.argv.slice(2);

interface BuildTargetConfig {
  readonly kind: 'web' | 'capacitor-android' | 'capacitor-ios' | 'apps-in-toss' | 'devvit-web';
  readonly gameApp: string;
  readonly adapter: string;
  readonly metadata?: TargetReleaseMetadata;
  readonly output?: string;
  readonly shellApp?: string;
  readonly wrapperApp?: string;
  readonly webDir?: string;
  readonly artifact?: string;
}

const targetScopedEnv = {
  ...process.env,
  MPGD_TARGET_CONFIG_TARGETS: targetName,
};

if (process.env.MPGD_SKIP_BUILD_TARGET_PREFLIGHT !== '1') {
  run('pnpm', ['validate:catalog'], process.env);
  run('pnpm', ['validate:ads'], process.env);
  run('pnpm', ['validate:target-config'], targetScopedEnv);
  run('pnpm', ['validate:effective-config'], targetScopedEnv);
  run('pnpm', ['validate:targets'], process.env);
  run('node', ['tools/run-ttsx.mjs', 'tools/package/build-packages.ts'], process.env);
}

const platformTargets = loadPlatformTargetsConfig();
const configBaseDir = platformTargets.baseDir;
const config = platformTargets.config;
const target = config.targets[targetName] as BuildTargetConfig | undefined;

if (target === undefined) {
  throw new Error(`Unknown target: ${targetName}`);
}

const gameApp = targetPath(target.gameApp);
const appTarget = appTargetForBuild(target, targetName);
const env: NodeJS.ProcessEnv = {
  ...process.env,
  ...targetReleaseMetadataEnv(target),
  APP_TARGET: appTarget,
  MPGD_CONFIG_TARGET: targetName,
  APP_VERSION: process.env.APP_VERSION ?? '0.0.0',
  BUILD_ID: process.env.BUILD_ID ?? 'local',
  MPGD_EFFECTIVE_TARGET_CONFIG_OUTPUT_DIR: effectiveTargetConfigOutputDir(configBaseDir),
};

run('pnpm', ['--dir', gameApp, 'exec', 'vite', 'build', '--mode', profile], env);
embedEffectiveTargetConfig(targetName, gameApp);

switch (target.kind) {
  case 'web': {
    const outputConfigPath = requireString(target.output, `${targetName}.output`);
    const output = targetPath(outputConfigPath);
    replaceDirectory(`${gameApp}/dist`, output);
    writeManifest(targetName, profile, outputConfigPath, env);
    break;
  }

  case 'apps-in-toss': {
    const webDirConfigPath = requireString(target.webDir, `${targetName}.webDir`);
    const webDir = targetPath(webDirConfigPath);
    const wrapperApp = targetPath(requireString(target.wrapperApp, `${targetName}.wrapperApp`));
    replaceDirectory(`${gameApp}/dist`, webDir);
    run('pnpm', ['--dir', wrapperApp, 'exec', 'vite', 'build', '--mode', profile], env);

    let releaseArtifact = webDirConfigPath;

    if (process.env.MPGD_AIT_PACKAGE_MODE !== 'skip') {
      removeFilesByExtension(wrapperApp, '.ait');
      run('pnpm', ['--dir', wrapperApp, 'ait:build'], env);

      const aitArtifact = findFileByExtension(wrapperApp, '.ait');
      releaseArtifact = `release-output/ait/${safeArtifactFileStem(env.MPGD_AIT_APP_NAME ?? 'mpgd-kit')}.ait`;
      copyFile(aitArtifact, targetPath(releaseArtifact));
    } else {
      releaseArtifact = 'release-output/ait/wrapper-web';
      replaceDirectory(`${wrapperApp}/dist`, targetPath(releaseArtifact));
      console.warn('ait: package build skipped; release manifest points to copied wrapper dist.');
    }

    writeManifest(targetName, profile, releaseArtifact, env);
    break;
  }

  case 'devvit-web': {
    const webDir = targetPath(requireString(target.webDir, `${targetName}.webDir`));
    const wrapperAppConfigPath = requireString(target.wrapperApp, `${targetName}.wrapperApp`);
    const wrapperApp = targetPath(wrapperAppConfigPath);
    replaceDirectory(`${gameApp}/dist`, webDir);
    run(
      'pnpm',
      [
        '--dir',
        wrapperApp,
        'exec',
        'vite',
        'build',
        '--config',
        'vite.server.config.ts',
        '--mode',
        profile,
      ],
      env,
    );
    writeManifest(targetName, profile, `${wrapperAppConfigPath}/dist`, env);
    break;
  }

  case 'capacitor-android': {
    const webDir = targetPath(requireString(target.webDir, `${targetName}.webDir`));
    const shellApp = targetPath(requireString(target.shellApp, `${targetName}.shellApp`));
    replaceDirectory(`${gameApp}/dist`, webDir);
    ensureCapacitorPlatform(shellApp, 'android', env);
    run('pnpm', ['--dir', shellApp, 'cap', 'sync', 'android'], env);

    const androidProject = `${shellApp}/android`;
    run('./gradlew', ['bundleRelease', '--no-daemon'], env, androidProject);

    const aabArtifact = `${androidProject}/app/build/outputs/bundle/release/app-release.aab`;
    const releaseArtifact = 'release-output/android/app-release.aab';
    copyFile(aabArtifact, targetPath(releaseArtifact));
    writeManifest(targetName, profile, releaseArtifact, env);
    break;
  }

  case 'capacitor-ios': {
    const webDir = targetPath(requireString(target.webDir, `${targetName}.webDir`));
    const shellApp = targetPath(requireString(target.shellApp, `${targetName}.shellApp`));
    replaceDirectory(`${gameApp}/dist`, webDir);
    ensureCapacitorPlatform(shellApp, 'ios', env);
    run('pnpm', ['--dir', shellApp, 'cap', 'sync', 'ios'], env);

    let releaseArtifact = requireString(target.shellApp, `${targetName}.shellApp`) + '/ios';

    if (process.env.MPGD_RUN_IOS_ARCHIVE === '1' && process.env.MPGD_RUN_IOS_SIMULATOR_BUILD === '1') {
      throw new Error('Set only one of MPGD_RUN_IOS_ARCHIVE or MPGD_RUN_IOS_SIMULATOR_BUILD.');
    }

    if (process.env.MPGD_RUN_IOS_ARCHIVE === '1') {
      releaseArtifact = 'release-output/ios/MPGDKit.xcarchive';
      run(
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
          targetPath(releaseArtifact),
          'CODE_SIGNING_ALLOWED=NO',
        ],
        env,
        `${shellApp}/ios`,
      );
    } else if (process.env.MPGD_RUN_IOS_SIMULATOR_BUILD === '1') {
      const buildRoot = targetPath('release-output/ios-simulator-build');
      const builtApp = `${buildRoot}/Release-iphonesimulator/App.app`;
      releaseArtifact = 'release-output/ios/App.app';

      rmSync(buildRoot, { recursive: true, force: true });
      run(
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
        env,
        `${shellApp}/ios`,
      );
      replaceDirectory(builtApp, targetPath(releaseArtifact));
    } else {
      console.warn(
        'ios: cap sync completed; set MPGD_RUN_IOS_SIMULATOR_BUILD=1 for a simulator .app or MPGD_RUN_IOS_ARCHIVE=1 for an xcarchive.',
      );
      releaseArtifact = 'release-output/ios/capacitor-sync';
      replaceDirectory(`${shellApp}/ios`, targetPath(releaseArtifact));
      copyIosSyncSwiftPackage(shellApp, releaseArtifact, '@mpgd/capacitor-game-services');
    }

    writeManifest(targetName, profile, releaseArtifact, env);
    break;
  }
}

function replaceDirectory(source: string, destination: string): void {
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  cpSync(source, destination, { recursive: true });
}

function appTargetForBuild(target: BuildTargetConfig, name: string): string {
  return target.kind === 'web' ? 'browser' : name;
}

function targetReleaseMetadataEnv(target: BuildTargetConfig): NodeJS.ProcessEnv {
  const metadata = target.metadata;

  if (metadata === undefined) {
    return {};
  }

  const env: NodeJS.ProcessEnv = {};

  assignEnv(env, 'MPGD_TARGET_APP_NAME', metadata.appName);
  assignEnv(env, 'MPGD_TARGET_DISPLAY_NAME', metadata.displayName);
  assignEnv(env, 'MPGD_TARGET_PRIMARY_COLOR', metadata.primaryColor);
  assignEnv(env, 'MPGD_TARGET_PACKAGE_ID', metadata.packageId);
  assignEnv(env, 'MPGD_TARGET_BUNDLE_ID', metadata.bundleId);

  assignSdkMajorEnv(env, 'MPGD_TARGET_SDK_MAJOR', metadata.sdkMajor, 'metadata.sdkMajor');

  if (target.kind === 'apps-in-toss') {
    assignEnv(env, 'MPGD_AIT_APP_NAME', metadata.appName);
    assignEnv(env, 'MPGD_AIT_DISPLAY_NAME', metadata.displayName);
    assignEnv(env, 'MPGD_AIT_PRIMARY_COLOR', metadata.primaryColor);

    assignSdkMajorEnv(env, 'MPGD_AIT_SDK_MAJOR', metadata.sdkMajor, 'metadata.sdkMajor');
  }

  return env;
}

function assignEnv(env: NodeJS.ProcessEnv, key: string, value: string | undefined): void {
  if (value === undefined) {
    return;
  }

  const trimmed = value.trim();

  if (trimmed.length > 0) {
    env[key] = trimmed;
  }
}

function assignSdkMajorEnv(
  env: NodeJS.ProcessEnv,
  key: string,
  value: number | undefined,
  label: string,
): void {
  if (value === undefined) {
    return;
  }

  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }

  env[key] = String(value);
}

function replaceDirectoryWithoutNodeModules(source: string, destination: string): void {
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  cpSync(source, destination, {
    recursive: true,
    filter: (sourcePath) => {
      const sourceRelativePath = relative(source, sourcePath);

      return (
        sourceRelativePath.length === 0
        || !sourceRelativePath.split(/[\\/]+/u).includes('node_modules')
      );
    },
  });
}

function copyIosSyncSwiftPackage(
  shellApp: string,
  releaseArtifact: string,
  packageName: string,
): void {
  const linkedPackage = `${shellApp}/node_modules/${packageName}`;
  let resolvedPackage: string;

  try {
    resolvedPackage = realpathSync(linkedPackage);
  } catch {
    throw new Error(`Missing iOS Swift package dependency: ${linkedPackage}`);
  }

  replaceDirectoryWithoutNodeModules(
    resolvedPackage,
    targetPath(`${releaseArtifact}/node_modules/${packageName}`),
  );
  rewriteIosSyncSwiftPackagePath(releaseArtifact, packageName);
}

function rewriteIosSyncSwiftPackagePath(releaseArtifact: string, packageName: string): void {
  const packageFile = targetPath(`${releaseArtifact}/App/CapApp-SPM/Package.swift`);
  const contents = readFileSync(packageFile, 'utf8');
  const shellRelativePath = `path: "../../../node_modules/${packageName}"`;
  const artifactRelativePath = `path: "../../node_modules/${packageName}"`;

  if (!contents.includes(shellRelativePath)) {
    throw new Error(`Missing iOS Swift package reference for ${packageName}: ${packageFile}`);
  }

  writeFileSync(packageFile, contents.replace(shellRelativePath, artifactRelativePath));
}

function copyFile(source: string, destination: string): void {
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination);
}

function removeFilesByExtension(directory: string, extension: string): void {
  if (!existsSync(directory)) {
    return;
  }

  for (const file of readdirSync(directory)) {
    if (file.endsWith(extension)) {
      rmSync(`${directory}/${file}`, { force: true });
    }
  }
}

function safeArtifactFileStem(value: string): string {
  const stem = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, '-')
    .replace(/^[._-]+|[._-]+$/gu, '');

  return stem.length === 0 ? 'mpgd-kit' : stem;
}

function ensureCapacitorPlatform(
  shellApp: string,
  platform: 'android' | 'ios',
  commandEnv: NodeJS.ProcessEnv,
): void {
  if (!existsSync(`${shellApp}/${platform}`)) {
    run('pnpm', ['--dir', shellApp, 'cap', 'add', platform], commandEnv);
  }
}

function writeManifest(
  target: string,
  releaseProfile: string,
  artifact: string,
  commandEnv: NodeJS.ProcessEnv,
): void {
  run(
    'pnpm',
    ['manifest:release', target, releaseProfile, artifact, releaseManifestPath(configBaseDir)],
    commandEnv,
  );
}

function embedEffectiveTargetConfig(target: string, gameApp: string): void {
  const artifact = writeEffectiveTargetConfigs({
    targets: [target],
    outputDir: effectiveTargetConfigOutputDir(configBaseDir),
  }).artifacts.find((candidate) => candidate.target === target);

  if (artifact === undefined) {
    throw new Error(`Failed to generate effective target config for ${target}.`);
  }

  copyFile(artifact.path, `${gameApp}/dist/${embeddedTargetConfigFileName}`);
}

function targetPath(path: string): string {
  return resolveFromPlatformTargetsBase(configBaseDir, path);
}

function findFileByExtension(directory: string, extension: string): string {
  const files = readdirSync(directory)
    .filter((file) => file.endsWith(extension))
    .sort();

  if (files.length === 0) {
    throw new Error(`Missing ${extension} artifact in ${directory}.`);
  }

  return `${directory}/${files[0]}`;
}

function run(
  command: string,
  args: readonly string[],
  commandEnv: NodeJS.ProcessEnv,
  cwd = process.cwd(),
): void {
  const result = spawnSync(command, [...args], {
    cwd,
    stdio: 'inherit',
    env: commandEnv,
  });

  if (result.error !== undefined) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}.`);
  }
}

function requireString(value: string | undefined, label: string): string {
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing target config value: ${label}`);
  }

  return value;
}
