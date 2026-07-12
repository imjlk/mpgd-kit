import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  assertEmbeddedTargetConfig,
  readEmbeddedTargetConfigFromDirectory,
} from './embedded-target-config';

const simulatorName = process.env.MPGD_IOS_SIM_NAME ?? 'iPhone 16';
const simulatorOs = process.env.MPGD_IOS_SIM_OS ?? 'iOS 18.4';
const bundleId = 'dev.mpgd.kit';
const artifactsDir = 'artifacts/emulator';
const buildRoot = join(process.cwd(), artifactsDir, 'ios-build');
const appPath = join(buildRoot, 'Debug-iphonesimulator/App.app');
const screenshotPath = join(process.cwd(), artifactsDir, 'ios.png');

run('pnpm', ['build:target', 'ios', 'staging']);

const device = findSimulator(simulatorName, simulatorOs);

if (device === undefined) {
  throw new Error(`Missing iOS simulator: ${simulatorName} (${simulatorOs})`);
}

if (device.state !== 'Booted') {
  run('xcrun', ['simctl', 'boot', device.udid]);
}

run('xcrun', ['simctl', 'bootstatus', device.udid, '-b']);
mkdirSync(artifactsDir, { recursive: true });
const xcodebuildArgs = [
  'build',
  '-project',
  'App/App.xcodeproj',
  '-target',
  'App',
  '-configuration',
  'Debug',
  '-sdk',
  'iphonesimulator',
  `SYMROOT=${buildRoot}`,
  `OBJROOT=${join(buildRoot, 'Intermediates.noindex')}`,
  'INFOPLIST_FILE=App/Info-Smoke.plist',
  'EXCLUDED_SOURCE_FILE_NAMES=Main.storyboard LaunchScreen.storyboard Assets.xcassets',
  'ASSETCATALOG_COMPILER_APPICON_NAME=',
  'SWIFT_ACTIVE_COMPILATION_CONDITIONS=DEBUG MPGD_SMOKE_NO_STORYBOARD',
  'CODE_SIGNING_ALLOWED=NO',
];

run('xcodebuild', xcodebuildArgs, 'apps/mobile-capacitor/ios');

if (!existsSync(appPath)) {
  throw new Error(`Missing iOS simulator app: ${appPath}`);
}

const embeddedConfig = readEmbeddedTargetConfigFromDirectory(appPath, 'iOS simulator app');
assertEmbeddedTargetConfig(embeddedConfig, { target: 'ios' });
writeFileSync('artifacts/emulator/ios-effective-target.json', embeddedConfig.content);

run('xcrun', ['simctl', 'install', device.udid, appPath]);
run('xcrun', ['simctl', 'launch', device.udid, bundleId]);
sleep(3_000);
run('xcrun', ['simctl', 'io', device.udid, 'screenshot', screenshotPath]);

console.log(`iOS simulator smoke passed: ${device.name}, screenshot=${screenshotPath}`);

interface SimulatorDevice {
  readonly name: string;
  readonly udid: string;
  readonly state: string;
}

interface SimulatorList {
  readonly devices: Record<string, readonly SimulatorDevice[]>;
}

function findSimulator(name: string, osName: string): SimulatorDevice | undefined {
  const raw = capture('xcrun', ['simctl', 'list', 'devices', 'available', '--json']);
  const list = JSON.parse(raw) as SimulatorList;
  const normalizedOs = osName.replace(/[^A-Za-z0-9]/g, '-').replace(/-+/g, '-');

  for (const [runtime, devices] of Object.entries(list.devices)) {
    if (!runtime.endsWith(normalizedOs)) {
      continue;
    }

    const device = devices.find((candidate) => candidate.name === name);

    if (device !== undefined) {
      return device;
    }
  }

  return undefined;
}

function run(command: string, args: readonly string[], cwd = process.cwd()): void {
  const result = spawnSync(command, [...args], {
    cwd,
    env: process.env,
    stdio: 'inherit',
  });

  if (result.error !== undefined) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}.`);
  }
}

function capture(command: string, args: readonly string[]): string {
  const result = spawnSync(command, [...args], {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8',
  });

  if (result.error !== undefined) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}.`);
  }

  return result.stdout;
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
