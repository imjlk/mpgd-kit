import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { readJsonFile } from '../io';

const [targetName = 'web-preview', profile = 'production'] = process.argv.slice(2);

interface BuildTargetConfig {
  readonly kind: 'web' | 'capacitor-android' | 'capacitor-ios' | 'apps-in-toss';
  readonly gameApp: string;
  readonly adapter: string;
  readonly output?: string;
  readonly shellApp?: string;
  readonly wrapperApp?: string;
  readonly webDir?: string;
  readonly artifact?: string;
}

interface BuildTargetsFile {
  readonly targets: Record<string, BuildTargetConfig>;
}

run('pnpm', ['validate:catalog'], process.env);
run('pnpm', ['validate:ads'], process.env);
run('pnpm', ['validate:target-config'], process.env);
run('pnpm', ['validate:effective-config'], process.env);
run('pnpm', ['validate:targets'], process.env);
run('node', ['tools/run-ttsx.mjs', 'tools/package/build-packages.ts'], process.env);

const config = readJsonFile('platform.targets.json') as BuildTargetsFile;
const target = config.targets[targetName];

if (target === undefined) {
  throw new Error(`Unknown target: ${targetName}`);
}

const appTarget = targetName === 'web-preview' ? 'browser' : targetName;
const env = {
  ...process.env,
  APP_TARGET: appTarget,
  APP_VERSION: process.env.APP_VERSION ?? '0.0.0',
  BUILD_ID: process.env.BUILD_ID ?? 'local',
};

run('pnpm', ['--dir', target.gameApp, 'exec', 'vite', 'build', '--mode', profile], env);

switch (target.kind) {
  case 'web': {
    const output = requireString(target.output, `${targetName}.output`);
    replaceDirectory(`${target.gameApp}/dist`, output);
    writeManifest(targetName, profile, output, env);
    break;
  }

  case 'apps-in-toss': {
    const webDir = requireString(target.webDir, `${targetName}.webDir`);
    const wrapperApp = requireString(target.wrapperApp, `${targetName}.wrapperApp`);
    replaceDirectory(`${target.gameApp}/dist`, webDir);
    run('pnpm', ['--dir', wrapperApp, 'exec', 'vite', 'build', '--mode', profile], env);
    run('pnpm', ['--dir', wrapperApp, 'ait:build'], env);

    const aitArtifact = findFileByExtension(wrapperApp, '.ait');
    const releaseArtifact = 'release-output/ait/mpgd-kit.ait';
    copyFile(aitArtifact, releaseArtifact);
    writeManifest(targetName, profile, releaseArtifact, env);
    break;
  }

  case 'capacitor-android': {
    const webDir = requireString(target.webDir, `${targetName}.webDir`);
    const shellApp = requireString(target.shellApp, `${targetName}.shellApp`);
    replaceDirectory(`${target.gameApp}/dist`, webDir);
    ensureCapacitorPlatform(shellApp, 'android', env);
    run('pnpm', ['--dir', shellApp, 'cap', 'sync', 'android'], env);

    const androidProject = `${shellApp}/android`;
    run('./gradlew', ['bundleRelease', '--no-daemon'], env, androidProject);

    const aabArtifact = `${androidProject}/app/build/outputs/bundle/release/app-release.aab`;
    const releaseArtifact = 'release-output/android/app-release.aab';
    copyFile(aabArtifact, releaseArtifact);
    writeManifest(targetName, profile, releaseArtifact, env);
    break;
  }

  case 'capacitor-ios': {
    const webDir = requireString(target.webDir, `${targetName}.webDir`);
    const shellApp = requireString(target.shellApp, `${targetName}.shellApp`);
    replaceDirectory(`${target.gameApp}/dist`, webDir);
    ensureCapacitorPlatform(shellApp, 'ios', env);
    run('pnpm', ['--dir', shellApp, 'cap', 'sync', 'ios'], env);

    let releaseArtifact = `${shellApp}/ios`;

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
          join(process.cwd(), releaseArtifact),
          'CODE_SIGNING_ALLOWED=NO',
        ],
        env,
        `${shellApp}/ios`,
      );
    } else {
      console.warn(
        'ios: cap sync completed; set MPGD_RUN_IOS_ARCHIVE=1 to run xcodebuild archive.',
      );
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

function copyFile(source: string, destination: string): void {
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination);
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
    ['manifest:release', target, releaseProfile, artifact, 'artifacts/release-manifest.json'],
    commandEnv,
  );
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
