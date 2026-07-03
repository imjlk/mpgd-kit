import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const defaultAndroidHome = join(homedir(), 'Library/Android/sdk');
const androidHome = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? defaultAndroidHome;
const adb = join(androidHome, 'platform-tools', 'adb');
const emulator = join(androidHome, 'emulator', 'emulator');
const avdName = process.env.MPGD_ANDROID_AVD ?? 'Pixel_6_API_33';
const packageName = 'dev.mpgd.kit';
const screenshotPath = 'artifacts/emulator/android.png';
const debugApk =
  'apps/mobile-capacitor/android/app/build/outputs/apk/debug/app-debug.apk';

assertExecutable(adb, 'adb');
assertExecutable(emulator, 'emulator');

run('pnpm', ['build:android']);
run('./gradlew', ['assembleDebug', '--no-daemon'], 'apps/mobile-capacitor/android');

const serial = getOrStartEmulator();
run(adb, ['-s', serial, 'wait-for-device']);
waitForBoot(serial);
run(adb, ['-s', serial, 'shell', 'input', 'keyevent', '82']);
run(adb, ['-s', serial, 'install', '-r', debugApk]);
run(adb, ['-s', serial, 'logcat', '-c']);
run(adb, [
  '-s',
  serial,
  'shell',
  'monkey',
  '-p',
  packageName,
  '-c',
  'android.intent.category.LAUNCHER',
  '1',
]);
sleep(5_000);
mkdirSync('artifacts/emulator', { recursive: true });
run(adb, ['-s', serial, 'shell', 'screencap', '-p', '/sdcard/mpgd-smoke.png']);
run(adb, ['-s', serial, 'pull', '/sdcard/mpgd-smoke.png', screenshotPath]);

const logs = capture(adb, ['-s', serial, 'logcat', '-d', '-t', '1000']);
writeFileSync('artifacts/emulator/android-logcat.txt', logs);

if (/FATAL EXCEPTION|\\bANR\\b|AndroidRuntime/.test(logs)) {
  throw new Error('Android emulator smoke detected a crash marker in logcat.');
}

console.log(`Android emulator smoke passed: ${serial}, screenshot=${screenshotPath}`);

function getOrStartEmulator(): string {
  const existing = listEmulators()[0];

  if (existing !== undefined) {
    return existing;
  }

  const emulatorArgs = [`@${avdName}`, '-no-snapshot-save', '-no-audio', '-no-boot-anim'];
  const child = spawn(emulator, emulatorArgs, {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  const started = waitForEmulatorSerial();

  if (started === undefined) {
    throw new Error(`Timed out waiting for Android emulator AVD: ${avdName}`);
  }

  return started;
}

function listEmulators(): string[] {
  return capture(adb, ['devices'])
    .split('\\n')
    .map((line) => line.trim().split(/\\s+/))
    .flatMap(([serial, state]) => {
      if (serial?.startsWith('emulator-') === true && state === 'device') {
        return [serial];
      }

      return [];
    });
}

function waitForEmulatorSerial(): string | undefined {
  const deadline = Date.now() + 120_000;

  while (Date.now() < deadline) {
    const serial = listEmulators()[0];

    if (serial !== undefined) {
      return serial;
    }

    sleep(2_000);
  }

  return undefined;
}

function waitForBoot(serial: string): void {
  const deadline = Date.now() + 180_000;

  while (Date.now() < deadline) {
    const bootCompleted = capture(adb, ['-s', serial, 'shell', 'getprop', 'sys.boot_completed']).trim();

    if (bootCompleted === '1') {
      return;
    }

    sleep(2_000);
  }

  throw new Error(`Timed out waiting for Android emulator boot: ${serial}`);
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

function assertExecutable(path: string, label: string): void {
  if (!existsSync(path)) {
    throw new Error(`Missing Android ${label}: ${path}`);
  }
}
