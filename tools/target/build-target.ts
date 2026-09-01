import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';

import { loadEnv } from 'vite';

import { assertProductionTargetReadiness } from '../../packages/cli/src/production-target-readiness';
import {
  targetConfigExtensionsFileEnv,
  targetConfigMatrixFileEnv,
} from '../../packages/cli/src/target-config-env';
import { generateTargetIcons, verifyGeneratedTargetIcons } from '../icons/generator';
import {
  assertStagedWebIconEvidence,
  stageNativeIconResources,
  stageWebIconEvidence,
  stageWrapperIcon,
} from '../icons/staging';
import { requireCanonicalAppVersion } from './app-version';
import { embeddedTargetConfigFileName, writeEffectiveTargetConfigs } from './effective-config';
import { createReleaseManifestWriter, resolveReleaseProvenance } from './generate-release-manifest';
import {
  assertMicrosoftStorePwaProvenance,
  writeMicrosoftStorePwaArtifacts,
} from './microsoft-store-pwa';
import { assembleMiniGameArtifact, assertDisjointMiniGameTargetOutputs } from './minigame-artifact';
import { wechatStagingAppId, writeWechatMiniGameProjectFiles } from './minigame-project-files';
import { normalizeMonetizationCatalogEnv } from './monetization-catalog-env';
import { assertNativeReleaseIdentity } from './native-release-identity';
import {
  appTargetForPlatformTarget,
  assertPlatformTargetBuildEmitterAvailable,
  effectiveTargetConfigOutputDir,
  loadPlatformTargetsConfig,
  releaseManifestPath,
  resolveFromPlatformTargetsBase,
} from './platform-targets';
import type { MiniGameTargetConfig, PlatformTargetConfig, WebTargetConfig } from './schemas';
import { loadTargetConfigMatrix } from './target-config-matrix';
import {
  assertDisjointWebTargetOutputs,
  assertInstallableWebArtifact,
  assertNonInstallableWebArtifact,
  assertWebArtifactOutputDirectory,
  assertWebStaticDirectory,
  copyWebStaticDirectoryContents,
} from './web-artifact';

const [targetName = 'web-preview', profile = 'production'] = process.argv.slice(2);
const appVersion = requireCanonicalAppVersion(process.env.APP_VERSION ?? '0.0.0');
const releaseProvenance = resolveReleaseProvenance();
const writeCapturedReleaseManifest = createReleaseManifestWriter(releaseProvenance);
const releaseManifestEnvKeys = [
  'APP_VERSION',
  'BUILD_ID',
  'MPGD_AD_PLACEMENTS_FILE',
  'MPGD_AIT_APP_NAME',
  'MPGD_AIT_SDK_MAJOR',
  'MPGD_EFFECTIVE_TARGET_CONFIG_OUTPUT_DIR',
  'MPGD_ICON_MANIFEST_PATH',
  'MPGD_TARGET_BUILD_NUMBER',
  'MPGD_TARGET_MARKETING_VERSION',
  'MPGD_PLATFORM_TARGETS_FILE',
  'MPGD_TARGET_VERSION_CODE',
  'MPGD_TARGET_VERSION_NAME',
  'MPGD_PRODUCT_CATALOG_FILE',
  'MPGD_SOURCE_GIT_SHA',
  targetConfigExtensionsFileEnv,
] as const;

const platformTargets = loadPlatformTargetsConfig();
const configBaseDir = platformTargets.baseDir;
const config = platformTargets.config;
const target = config.targets[targetName];

if (target === undefined) {
  throw new Error(`Unknown target: ${targetName}`);
}

assertPlatformTargetBuildEmitterAvailable(target, targetName);
assertDisjointWebTargetOutputs(config.targets, targetPath, [
  { name: 'release manifest', path: releaseManifestPath(configBaseDir) },
  {
    name: 'effective target config output',
    path: effectiveTargetConfigOutputDir(configBaseDir),
  },
]);
assertDisjointMiniGameTargetOutputs(config.targets, targetPath, [
  { name: 'release manifest', path: releaseManifestPath(configBaseDir) },
  {
    name: 'effective target config output',
    path: effectiveTargetConfigOutputDir(configBaseDir),
  },
]);
const runtimeTargetConfigMatrix = loadTargetConfigMatrix();
const monetizationCatalogEnv = normalizeMonetizationCatalogEnv(process.env, configBaseDir);
const targetScopedEnv = {
  ...process.env,
  ...monetizationCatalogEnv,
  MPGD_TARGET_CONFIG_TARGETS: targetName,
};

if (process.env.MPGD_SKIP_BUILD_TARGET_PREFLIGHT !== '1') {
  run('pnpm', ['validate:catalog'], targetScopedEnv);
  run('pnpm', ['validate:ads'], targetScopedEnv);
  run('pnpm', ['validate:target-config'], targetScopedEnv);
  run('pnpm', ['validate:effective-config'], targetScopedEnv);
  run('pnpm', ['validate:targets'], targetScopedEnv);
  run('node', ['tools/run-ttsx.mjs', 'tools/package/build-packages.ts'], process.env);
}

const gameApp = targetPath(target.gameApp);
const webTargetPaths = target.kind === 'web'
  ? resolveWebTargetPaths(target, targetName)
  : undefined;

if (webTargetPaths !== undefined) {
  assertWebArtifactOutputDirectory(webTargetPaths.output, `${gameApp}/dist`);
}

if (webTargetPaths?.staticDirPath !== undefined) {
  const { output, staticDirPath } = webTargetPaths;

  assertWebStaticDirectory(staticDirPath, output, configBaseDir);
  assertWebStaticDirectory(staticDirPath, `${gameApp}/dist`, configBaseDir);
}

const generatedIcons = await generateTargetIcons({
  gameRoot: configBaseDir,
  targetName,
  target,
  profile,
  enforceExternalReadiness:
    profile === 'production'
    && target.kind === 'apps-in-toss'
    && process.env.MPGD_AIT_PACKAGE_MODE !== 'skip',
});
await verifyGeneratedTargetIcons(generatedIcons);
const appTarget = appTargetForPlatformTarget(target, targetName);
const gameServicesUrl = profile === 'production'
  ? (process.env.VITE_MPGD_GAME_SERVICES_URL
    ?? loadEnv(profile, gameApp, 'VITE_MPGD_').VITE_MPGD_GAME_SERVICES_URL)
  : process.env.VITE_MPGD_GAME_SERVICES_URL;

assertProductionTargetReadiness({
  target: targetName,
  profile,
  targetsFile: platformTargets.path,
  gameRoot: configBaseDir,
  ...(runtimeTargetConfigMatrix.targets[targetName] === undefined
    ? {}
    : { targetPolicy: runtimeTargetConfigMatrix.targets[targetName] }),
  ...(gameServicesUrl === undefined ? {} : { gameServicesUrl }),
});

const runtimeTargetConfigMatrixFile = createRuntimeTargetConfigMatrixFile(
  runtimeTargetConfigMatrix,
);
const env: NodeJS.ProcessEnv = {
  ...process.env,
  ...monetizationCatalogEnv,
  ...targetBuildConfigEnv(target),
  APP_TARGET: appTarget,
  MPGD_CONFIG_TARGET: targetName,
  APP_VERSION: appVersion,
  BUILD_ID: process.env.BUILD_ID ?? 'local',
  MPGD_SOURCE_GIT_SHA: releaseProvenance.sourceGitSha,
  MPGD_PLATFORM_TARGETS_FILE: platformTargets.path,
  MPGD_EFFECTIVE_TARGET_CONFIG_OUTPUT_DIR: effectiveTargetConfigOutputDir(configBaseDir),
  MPGD_ICON_MANIFEST_PATH: generatedIcons.manifestPath,
  [targetConfigMatrixFileEnv]: runtimeTargetConfigMatrixFile,
};

try {
  if (targetName === 'microsoft-store' && target.kind === 'web' && profile === 'production') {
    assertMicrosoftStorePwaProvenance({
      appVersion: requireString(env.APP_VERSION, 'APP_VERSION'),
      buildId: requireString(env.BUILD_ID, 'BUILD_ID'),
      sourceGitSha: releaseProvenance.sourceGitSha,
      kitGitSha: releaseProvenance.kitGitSha,
    });
  }

  if (target.kind !== 'devvit-web' && !isMiniGameTarget(target)) {
    run('pnpm', ['--dir', gameApp, 'exec', 'vite', 'build', '--mode', profile], env);
    embedEffectiveTargetConfig(targetName, `${gameApp}/dist`, env);
    if (target.kind !== 'web') {
      stageWebIconEvidence(generatedIcons, `${gameApp}/dist`);
    }
  }

  switch (target.kind) {
    case 'wechat-minigame': {
      const outputConfigPath = requireString(target.output, `${targetName}.output`);
      const output = targetPath(outputConfigPath);
      const bundleRoot = mkdtempSync(join(tmpdir(), 'mpgd-wechat-bundles-'));

      try {
        const runtimeBundleRoot = join(bundleRoot, 'runtime');
        const gameBundleRoot = join(bundleRoot, 'game');
        buildMiniGameBundle('runtime', runtimeBundleRoot, bundleRoot, gameApp, profile, env);
        buildMiniGameBundle('game', gameBundleRoot, bundleRoot, gameApp, profile, env);
        const effectiveTargetConfig = generateEffectiveTargetConfigArtifact(targetName, env);
        const appId = env.MPGD_WECHAT_APP_ID?.trim() || wechatStagingAppId;

        assembleMiniGameArtifact({
          projectRoot: configBaseDir,
          artifactRoot: output,
          runtimeBundleRoot,
          gameBundleRoot,
          effectiveTargetConfigSource: effectiveTargetConfig.path,
          generatedIcons,
          target: targetName,
          runtime: target.kind,
          appVersion: requireString(env.APP_VERSION, 'APP_VERSION'),
          buildId: requireString(env.BUILD_ID, 'BUILD_ID'),
          sourceGitSha: releaseProvenance.sourceGitSha,
          kitGitSha: releaseProvenance.kitGitSha,
          budget: target.packageBudget,
          writeProjectFiles(artifactRoot) {
            writeWechatMiniGameProjectFiles({
              artifactRoot,
              targetName,
              orientation: target.orientation,
              appId,
              production: profile === 'production',
            });
          },
          forbiddenJavaScriptMarkers: [
            { marker: 'TTMinis.game', owner: 'TikTok' },
            { marker: 'createTikTokPlatformGateway', owner: 'TikTok' },
          ],
          forbiddenGameBundleGlobals: ['wx'],
        });
        writeManifest(targetName, profile, outputConfigPath, env);
      } finally {
        rmSync(bundleRoot, { force: true, recursive: true });
      }
      break;
    }

    case 'tiktok-minigame':
      throw new Error(
        `Mini-game target ${targetName} cannot be built until its native artifact emitter is installed.`,
      );

    case 'web': {
      if (webTargetPaths === undefined) {
        throw new Error(`Failed to resolve web target paths for ${targetName}.`);
      }

      const { output, outputConfigPath, staticDirPath } = webTargetPaths;

      replaceDirectory(`${gameApp}/dist`, output);
      if (staticDirPath !== undefined) {
        copyWebStaticDirectoryContents(staticDirPath, output);
      }
      stageWebIconEvidence(generatedIcons, output, {
        ...(target.installable === undefined ? {} : { installable: target.installable }),
        ...(staticDirPath === undefined
          ? {}
          : { manifestSourceDirectory: staticDirPath }),
      });
      assertStagedWebIconEvidence(generatedIcons, output);
      if (targetName === 'microsoft-store' && profile === 'production') {
        writeMicrosoftStorePwaArtifacts({
          artifactRoot: output,
          provenance: {
            appVersion: requireString(env.APP_VERSION, 'APP_VERSION'),
            buildId: requireString(env.BUILD_ID, 'BUILD_ID'),
            sourceGitSha: releaseProvenance.sourceGitSha,
            kitGitSha: releaseProvenance.kitGitSha,
          },
        });
      }
      if (target.installable === false) {
        assertNonInstallableWebArtifact(output);
      } else {
        assertInstallableWebArtifact(output);
      }
      writeManifest(targetName, profile, outputConfigPath, env);
      break;
    }

    case 'apps-in-toss': {
      const webDirConfigPath = requireString(target.webDir, `${targetName}.webDir`);
      const webDir = targetPath(webDirConfigPath);
      const wrapperApp = targetPath(requireString(target.wrapperApp, `${targetName}.wrapperApp`));
      replaceDirectory(`${gameApp}/dist`, webDir);
      mirrorAitRuntimeAssets(gameApp, wrapperApp);
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
      stageWrapperIcon(generatedIcons, wrapperApp);

      run('pnpm', ['--dir', wrapperApp, 'exec', 'vite', 'build', '--mode', profile], env);
      embedEffectiveTargetConfig(targetName, webDir, env);
      stageWebIconEvidence(generatedIcons, webDir);
      writeManifest(targetName, profile, `${wrapperAppConfigPath}/dist`, env);
      break;
    }

    case 'capacitor-android': {
      const webDir = targetPath(requireString(target.webDir, `${targetName}.webDir`));
      const shellApp = targetPath(requireString(target.shellApp, `${targetName}.shellApp`));
      replaceDirectory(`${gameApp}/dist`, webDir);
      ensureCapacitorPlatform(shellApp, 'android', env);
      assertNativeReleaseIdentity({
        environment: env,
        metadata: target.metadata,
        platform: 'android',
        required: profile === 'production',
        shellApp,
      });
      const restoreIcons = await stageNativeIconResources(generatedIcons, shellApp);

      try {
        run('pnpm', ['--dir', shellApp, 'cap', 'sync', 'android'], env);

        const androidProject = `${shellApp}/android`;
        run('./gradlew', ['bundleRelease', '--no-daemon'], env, androidProject);

        const aabArtifact = `${androidProject}/app/build/outputs/bundle/release/app-release.aab`;
        const releaseArtifact = 'release-output/android/app-release.aab';
        copyFile(aabArtifact, targetPath(releaseArtifact));
        writeManifest(targetName, profile, releaseArtifact, env);
      } finally {
        restoreIcons();
      }
      break;
    }

    case 'capacitor-ios': {
      const webDir = targetPath(requireString(target.webDir, `${targetName}.webDir`));
      const shellApp = targetPath(requireString(target.shellApp, `${targetName}.shellApp`));
      replaceDirectory(`${gameApp}/dist`, webDir);
      ensureCapacitorPlatform(shellApp, 'ios', env);
      assertNativeReleaseIdentity({
        environment: env,
        metadata: target.metadata,
        platform: 'ios',
        required: profile === 'production',
        shellApp,
      });
      const restoreIcons = await stageNativeIconResources(generatedIcons, shellApp);

      try {
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
      } finally {
        restoreIcons();
      }
      break;
    }
  }
} finally {
  rmSync(dirname(runtimeTargetConfigMatrixFile), { force: true, recursive: true });
}

function createRuntimeTargetConfigMatrixFile(matrix: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), 'mpgd-target-config-matrix-'));
  const file = join(directory, 'matrix.json');

  writeFileSync(file, `${JSON.stringify(matrix)}\n`);
  return file;
}

function resolveWebTargetPaths(target: WebTargetConfig, name: string) {
  const outputConfigPath = requireString(target.output, `${name}.output`);

  return {
    output: targetPath(outputConfigPath),
    outputConfigPath,
    staticDirPath: target.staticDir === undefined ? undefined : targetPath(target.staticDir),
  };
}

function replaceDirectory(source: string, destination: string): void {
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  cpSync(source, destination, { recursive: true });
}

function mirrorAitRuntimeAssets(gameApp: string, wrapperApp: string): void {
  const sourceAssets = `${gameApp}/dist/assets`;
  const destinationAssets = `${wrapperApp}/public/assets`;

  if (existsSync(sourceAssets)) {
    replaceDirectory(sourceAssets, destinationAssets);
  } else {
    rmSync(destinationAssets, { recursive: true, force: true });
  }
}

function targetBuildConfigEnv(target: PlatformTargetConfig): NodeJS.ProcessEnv {
  const metadata = target.metadata;
  const env: NodeJS.ProcessEnv = {};

  if (metadata !== undefined) {
    assignEnv(env, 'MPGD_TARGET_APP_NAME', metadata.appName);
    assignEnv(env, 'MPGD_TARGET_DISPLAY_NAME', metadata.displayName);
    assignEnv(env, 'MPGD_TARGET_PRIMARY_COLOR', metadata.primaryColor);
    assignEnv(env, 'MPGD_TARGET_PACKAGE_ID', metadata.packageId);
    assignEnv(env, 'MPGD_TARGET_BUNDLE_ID', metadata.bundleId);

    assignSdkMajorEnv(env, 'MPGD_TARGET_SDK_MAJOR', metadata.sdkMajor, 'metadata.sdkMajor');
  }

  if (target.kind === 'apps-in-toss') {
    if (metadata !== undefined) {
      assignEnv(env, 'MPGD_AIT_APP_NAME', metadata.appName);
      assignEnv(env, 'MPGD_AIT_PRIMARY_COLOR', metadata.primaryColor);

      assignSdkMajorEnv(env, 'MPGD_AIT_SDK_MAJOR', metadata.sdkMajor, 'metadata.sdkMajor');
    }

    if (target.navigationBar !== undefined) {
      env.MPGD_AIT_NAVIGATION_BAR = JSON.stringify(target.navigationBar);
    }
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
    const target = `${directory}/${file}`;

    if (file.endsWith(extension) && statSync(target).isFile()) {
      rmSync(target, { force: true });
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
  withProcessEnv(commandEnv, releaseManifestEnvKeys, () =>
    writeCapturedReleaseManifest({
      target,
      profile: releaseProfile,
      artifact,
      iconManifestArtifactPath: findEmbeddedIconManifestArtifactPath(artifact),
      outputPath: releaseManifestPath(configBaseDir),
    }),
  );
}

function findEmbeddedIconManifestArtifactPath(artifact: string): string {
  const artifactPath = targetPath(artifact);
  const fileName = 'mpgd-icon-manifest.json';
  const matches = statSync(artifactPath).isDirectory()
    ? findNamedArtifactFiles(artifactPath, fileName).map(
        (path) => relative(artifactPath, path).replaceAll('\\', '/'),
      )
    : listZipEntries(artifactPath).filter((entry) => basename(entry) === fileName);

  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one ${fileName} in release artifact ${artifactPath}; found ${matches.length}.`,
    );
  }

  const match = matches[0];

  if (
    match === undefined
    || match.startsWith('/')
    || match.split('/').some(
      (segment) => segment.length === 0 || segment === '.' || segment === '..',
    )
  ) {
    throw new Error(`Unsafe embedded icon manifest path in ${artifactPath}: ${String(match)}`);
  }

  return match;
}

function findNamedArtifactFiles(root: string, fileName: string): readonly string[] {
  const matches: string[] = [];

  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    const stat = lstatSync(path);

    if (stat.isSymbolicLink()) {
      continue;
    }

    if (stat.isDirectory()) {
      matches.push(...findNamedArtifactFiles(path, fileName));
    } else if (stat.isFile() && entry === fileName) {
      matches.push(path);
    }
  }

  return matches;
}

function listZipEntries(path: string): readonly string[] {
  const result = spawnSync('unzip', ['-Z1', path], {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8',
  });

  if (result.error !== undefined) {
    throw result.error;
  }

  const toleratedPrefixWarning = result.status === 1
    && result.stdout.trim().length > 0
    && result.stderr.includes('extra bytes at beginning or within zipfile')
    && result.stderr.includes('(attempting to process anyway)');

  if (result.status !== 0 && !toleratedPrefixWarning) {
    throw new Error(
      `Failed to list release artifact ${path}: ${result.stderr.trim() || `exit ${String(result.status)}`}`,
    );
  }

  return result.stdout.split('\n').filter((entry) => entry.length > 0);
}

function embedEffectiveTargetConfig(
  target: string,
  destination: string,
  commandEnv: NodeJS.ProcessEnv,
): void {
  const artifact = generateEffectiveTargetConfigArtifact(target, commandEnv);

  copyFile(artifact.path, `${destination}/${embeddedTargetConfigFileName}`);
}

function generateEffectiveTargetConfigArtifact(
  target: string,
  commandEnv: NodeJS.ProcessEnv,
) {
  const artifact = withProcessEnv(commandEnv, [
    'MPGD_PRODUCT_CATALOG_FILE',
    'MPGD_AD_PLACEMENTS_FILE',
  ], () => writeEffectiveTargetConfigs({
    targets: [target],
    outputDir: effectiveTargetConfigOutputDir(configBaseDir),
  })).artifacts.find((candidate) => candidate.target === target);

  if (artifact === undefined) {
    throw new Error(`Failed to generate effective target config for ${target}.`);
  }

  return artifact;
}

function isMiniGameTarget(target: PlatformTargetConfig): target is MiniGameTargetConfig {
  return target.kind === 'wechat-minigame' || target.kind === 'tiktok-minigame';
}

function buildMiniGameBundle(
  bundleKind: 'runtime' | 'game',
  outputDir: string,
  stagingRoot: string,
  gameApp: string,
  profile: string,
  commandEnv: NodeJS.ProcessEnv,
): void {
  const viteConfig = join(gameApp, 'vite.minigame.config.ts');

  if (!existsSync(viteConfig)) {
    throw new Error(
      `Mini-game target requires a game-owned vite.minigame.config.ts: ${viteConfig}`,
    );
  }

  run(
    'pnpm',
    ['exec', 'vite', 'build', '--config', 'vite.minigame.config.ts', '--mode', profile],
    {
      ...commandEnv,
      MPGD_MINIGAME_BUNDLE_KIND: bundleKind,
      MPGD_MINIGAME_BUNDLE_OUTPUT_DIR: outputDir,
      MPGD_MINIGAME_BUNDLE_STAGING_ROOT: stagingRoot,
    },
    gameApp,
  );
}

function withProcessEnv<T>(
  env: NodeJS.ProcessEnv,
  keys: readonly string[],
  callback: () => T,
): T {
  const previousValues = new Map(keys.map((key) => [key, process.env[key]]));

  for (const key of keys) {
    const value = env[key];

    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return callback();
  } finally {
    for (const [key, value] of previousValues) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
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
