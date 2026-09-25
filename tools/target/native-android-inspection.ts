import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';

export interface NativeInspectionCommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface NativeInspectionCommandRunner {
  run(command: string, args: readonly string[]): NativeInspectionCommandResult;
}

export interface AndroidBundleIdentity {
  readonly packageId: string;
  readonly versionCode: string;
  readonly versionName: string;
  readonly signed: true;
}

/** Inspect the emitted AAB, not the source Gradle file, before store handoff. */
export function inspectSignedAndroidBundle(input: {
  readonly bundle: string;
  readonly expectedPackageId: string;
  readonly expectedVersionCode: string;
  readonly expectedVersionName: string;
  readonly expectedSignerSha256: string;
  readonly bundletoolJar?: string;
  readonly runner?: NativeInspectionCommandRunner;
}): AndroidBundleIdentity {
  if (!existsSync(input.bundle) || !statSync(input.bundle).isFile()) {
    throw new Error('Signed Android app bundle is missing.');
  }
  if (input.bundletoolJar !== undefined && !existsSync(input.bundletoolJar)) {
    throw new Error('Configured bundletool JAR is missing.');
  }
  const runner = input.runner ?? { run: runCommand };
  const verification = runner.run('jarsigner', ['-verify', '-verbose', input.bundle]);
  const signingOutput = `${verification.stdout}\n${verification.stderr}`;
  if (verification.status !== 0 || !/\bjar verified\./u.test(signingOutput)
    || /jar is unsigned|contains unsigned entries|has expired/iu.test(signingOutput)) {
    throw new Error('Android app bundle is not verifiably signed for upload.');
  }
  const expectedSigner = input.expectedSignerSha256.replace(/:/gu, '').toUpperCase();
  if (!/^[A-F0-9]{64}$/u.test(expectedSigner)) {
    throw new Error(
      'Expected Android upload certificate SHA-256 fingerprint is missing or invalid.',
    );
  }
  const certificate = runner.run('keytool', [
    '-J-Duser.language=en',
    '-printcert',
    '-jarfile',
    input.bundle,
  ]);
  const signer = /\bSigner #1:/u.test(certificate.stdout)
    ? /\bSHA256:\s*((?:[A-Fa-f0-9]{2}:){31}[A-Fa-f0-9]{2})/u.exec(certificate.stdout)?.[1]
    : undefined;
  if (certificate.status !== 0 || /\bSigner #2:/u.test(certificate.stdout)
    || signer?.replace(/:/gu, '').toUpperCase() !== expectedSigner) {
    throw new Error('Android app bundle signer does not match the expected upload certificate.');
  }

  const attributes = [
    ['packageId', '/manifest/@package', input.expectedPackageId],
    ['versionCode', '/manifest/@android:versionCode', input.expectedVersionCode],
    ['versionName', '/manifest/@android:versionName', input.expectedVersionName],
  ] as const;
  const observed = Object.fromEntries(
    attributes.map(([name, xpath, expected]) => {
      const args = ['dump', 'manifest', `--bundle=${input.bundle}`, `--xpath=${xpath}`];
      const result = input.bundletoolJar === undefined
        ? runner.run('bundletool', args)
        : runner.run('java', ['-jar', input.bundletoolJar, ...args]);
      if (result.status !== 0) {
        throw new Error(`Could not inspect Android bundle ${name}; install bundletool.`);
      }
      const actual = result.stdout.trim().replace(/^"|"$/gu, '');
      if (actual !== expected) {
        throw new Error(`Android bundle ${name} does not match release identity.`);
      }
      return [name, actual];
    }),
  ) as Record<'packageId' | 'versionCode' | 'versionName', string>;

  const runtimeConfig = runner.run('unzip', [
    '-p',
    input.bundle,
    'base/assets/capacitor.config.json',
  ]);
  if (runtimeConfig.status !== 0 || runtimeConfig.stdout.trim() === '') {
    throw new Error('Android bundle Capacitor configuration could not be inspected.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(runtimeConfig.stdout);
  } catch {
    throw new Error('Android bundle Capacitor configuration is malformed.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Android bundle Capacitor configuration is malformed.');
  }
  const server = (parsed as Record<string, unknown>).server;
  if (typeof server === 'object' && server !== null && 'url' in server) {
    throw new Error('Android bundle retains a live-reload bridge configuration.');
  }
  const android = (parsed as Record<string, unknown>).android;
  if (android !== undefined && (typeof android !== 'object' || android === null
    || Array.isArray(android))) {
    throw new Error('Android bundle Capacitor android configuration is malformed.');
  }
  if (android !== undefined && 'webContentsDebuggingEnabled' in android
    && android.webContentsDebuggingEnabled !== false) {
    throw new Error('Android bundle enables WebView debugging.');
  }

  return { ...observed, signed: true };
}

function runCommand(command: string, args: readonly string[]): NativeInspectionCommandResult {
  const result = spawnSync(command, [...args], {
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error !== undefined) {
    throw new Error(`Required native inspection command is unavailable: ${command}.`);
  }
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}
