import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type {
  NativeInspectionCommandResult,
  NativeInspectionCommandRunner,
} from './native-android-inspection';

export interface IosApplicationIdentity {
  readonly bundleId: string;
  readonly marketingVersion: string;
  readonly buildNumber: string;
  readonly teamId: string;
  readonly signed: true;
}

export interface IosInspectionInput {
  readonly expectedBundleId: string;
  readonly expectedMarketingVersion: string;
  readonly expectedBuildNumber: string;
  readonly expectedTeamId: string;
  readonly runner?: NativeInspectionCommandRunner;
}

export function inspectSignedIosArchive(
  archive: string,
  input: IosInspectionInput,
): IosApplicationIdentity {
  return inspectSignedIosApplication(path.join(archive, 'Products/Applications/App.app'), input);
}

export function inspectSignedIosIpa(
  ipa: string,
  input: IosInspectionInput,
): IosApplicationIdentity {
  if (!existsSync(ipa) || !statSync(ipa).isFile()) {
    throw new Error('iOS store IPA is missing.');
  }
  const runner = input.runner ?? { run: runCommand };
  const listing = runner.run('unzip', ['-Z1', ipa]);
  if (listing.status !== 0) {
    throw new Error('iOS store IPA could not be listed.');
  }
  const entries = listing.stdout.split(/\r?\n/u).filter(Boolean);
  if (entries.some((entry) => entry.startsWith('/') || entry.includes('\\')
    || entry.split('/').some((segment) => segment === '..' || segment === '.'))) {
    throw new Error('iOS store IPA has an unsafe path.');
  }
  const appManifests = entries.filter((entry) => /^Payload\/[^/]+\.app\/Info\.plist$/u.test(entry));
  if (appManifests.length !== 1) {
    throw new Error('iOS store IPA must contain exactly one app manifest.');
  }
  const appRelative = path.dirname(appManifests[0] ?? '');
  const extracted = mkdtempSync(path.join(tmpdir(), 'mpgd-ios-inspection-'));
  try {
    const result = runner.run('unzip', ['-q', ipa, '-d', extracted]);
    if (result.status !== 0) {
      throw new Error('iOS store IPA could not be extracted.');
    }
    return inspectSignedIosApplication(path.join(extracted, appRelative), input);
  } finally {
    rmSync(extracted, { recursive: true, force: true });
  }
}

export function inspectSignedIosApplication(
  appPath: string,
  input: IosInspectionInput,
): IosApplicationIdentity {
  const plist = path.join(appPath, 'Info.plist');
  if (!existsSync(plist) || !statSync(plist).isFile()) {
    throw new Error('Signed iOS app manifest is missing.');
  }
  if (!existsSync(path.join(appPath, 'Assets.car'))
    || existsSync(path.join(appPath, 'Info-Smoke.plist'))) {
    throw new Error('Signed iOS app contains smoke assets or omits release icons.');
  }
  const runner = input.runner ?? { run: runCommand };
  const signature = runner.run('codesign', ['--verify', '--deep', '--strict', appPath]);
  if (signature.status !== 0) {
    throw new Error('iOS app code signature could not be verified.');
  }
  const signingInfo = runner.run('codesign', ['-dv', '--verbose=4', appPath]);
  const signingText = `${signingInfo.stdout}\n${signingInfo.stderr}`;
  const expectedTeamLine = `TeamIdentifier=${input.expectedTeamId}`;
  if (signingInfo.status !== 0 || /Signature=adhoc/iu.test(signingText)
    || !signingText.split(/\r?\n/u).some((line) => line.trim() === expectedTeamLine)) {
    throw new Error('iOS app is not signed for the expected development team.');
  }

  const fields = [
    ['bundleId', 'CFBundleIdentifier', input.expectedBundleId],
    ['marketingVersion', 'CFBundleShortVersionString', input.expectedMarketingVersion],
    ['buildNumber', 'CFBundleVersion', input.expectedBuildNumber],
  ] as const;
  const observed = Object.fromEntries(
    fields.map(([name, key, expected]) => {
      const result = runner.run('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist]);
      if (result.status !== 0 || result.stdout.trim() !== expected) {
        throw new Error(`iOS app ${name} does not match release identity.`);
      }
      return [name, expected];
    }),
  ) as Record<'bundleId' | 'marketingVersion' | 'buildNumber', string>;

  const configFiles = [
    path.join(appPath, 'capacitor.config.json'),
    path.join(appPath, 'public/capacitor.config.json'),
  ];
  if (!configFiles.some((file) => existsSync(file))) {
    throw new Error('Signed iOS app Capacitor configuration is missing.');
  }
  for (const configFile of configFiles) {
    if (existsSync(configFile)) {
      assertNoDebugServer(configFile);
    }
  }
  return { ...observed, teamId: input.expectedTeamId, signed: true };
}

function assertNoDebugServer(file: string): void {
  const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Signed iOS app has malformed Capacitor configuration.');
  }
  const config = value as Record<string, unknown>;
  const server = config.server;
  const ios = config.ios;
  if ((typeof server === 'object' && server !== null && 'url' in server)
    || (typeof ios === 'object' && ios !== null
      && 'webContentsDebuggingEnabled' in ios && ios.webContentsDebuggingEnabled === true)) {
    throw new Error('Signed iOS app retains a live-reload or debug bridge configuration.');
  }
}

function runCommand(command: string, args: readonly string[]): NativeInspectionCommandResult {
  const result = spawnSync(command, [...args], {
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error !== undefined) {
    throw new Error(`Required iOS inspection command is unavailable: ${command}.`);
  }
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}
