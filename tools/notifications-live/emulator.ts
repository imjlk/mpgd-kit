/**
 * Checks an Android emulator (or device) before a live notifications run:
 * one device online, Google Play services present (FCM needs them), the
 * game installed, its notification permission, and the `adb reverse` that
 * lets the app reach a `wrangler dev` Worker on this machine. It reads
 * through `adb` only; with `reverse` it also sets that one port forward.
 * It downloads and installs nothing.
 */

export interface AdbResult {
  readonly status: number;
  readonly stdout: string;
}

/** Runs `adb` with these arguments; the CLI gives `spawnSync`, the tests a fake. */
export type AdbRunner = (args: readonly string[]) => AdbResult;

export interface EmulatorCheckOptions {
  /** The app id (Android package) of the game's shell. */
  readonly appId: string;
  /** The device serial when more than one is online. */
  readonly serial?: string;
  /** The local Worker port the app should reach as 127.0.0.1 on the device. */
  readonly port: number;
  /** Set `adb reverse tcp:<port> tcp:<port>` when it is missing. */
  readonly reverse: boolean;
}

export interface EmulatorCheckLine {
  readonly result: 'pass' | 'warn' | 'fail';
  readonly check: string;
  readonly detail: string;
}

export interface EmulatorCheckReport {
  readonly ok: boolean;
  readonly serial?: string;
  readonly lines: readonly EmulatorCheckLine[];
}

const appIdPattern = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/u;

/** The serials `adb devices` lists as online (`device`), not `offline` or `unauthorized`. */
export function onlineAdbSerials(devicesOutput: string): readonly string[] {
  return devicesOutput
    .split(/\r?\n/u)
    .slice(1)
    .map((line) => line.trim().split(/\s+/u))
    .filter((fields) => fields.length >= 2 && fields[1] === 'device')
    .map((fields) => fields[0] ?? '')
    .filter((serial) => serial.length > 0);
}

/** Whether `pm list packages <name>` lists exactly that package (the filter also matches longer names). */
export function listsAndroidPackage(listOutput: string, name: string): boolean {
  return listOutput.split(/\r?\n/u).some((line) => line.trim() === `package:${name}`);
}

/** `granted=true` / `granted=false` of a runtime permission in `dumpsys package <app>`, or `undefined`. */
export function dumpsysPermissionGranted(dumpsysOutput: string, permission: string): boolean | undefined {
  const escaped = permission.replaceAll('.', '\\.');
  const match = new RegExp(`${escaped}: granted=(true|false)`, 'u').exec(dumpsysOutput);
  return match === null ? undefined : match[1] === 'true';
}

export function checkLiveEmulator(options: EmulatorCheckOptions, adb: AdbRunner): EmulatorCheckReport {
  if (!appIdPattern.test(options.appId)) {
    throw new Error(`--app-id ${JSON.stringify(options.appId)} is not an Android package name.`);
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) {
    throw new Error(`--port ${options.port} is not a TCP port.`);
  }
  const lines: EmulatorCheckLine[] = [];
  const add = (result: EmulatorCheckLine['result'], check: string, detail: string): void => {
    lines.push({ result, check, detail });
  };
  const devices = adb(['devices']);
  if (devices.status !== 0) {
    add(
      'fail',
      'adb',
      'adb devices failed: is the Android SDK platform-tools installed (ANDROID_HOME)?',
    );
    return { ok: false, lines };
  }
  const online = onlineAdbSerials(devices.stdout);
  const serial = options.serial ?? (online.length === 1 ? online[0] : undefined);
  if (serial === undefined || !online.includes(serial)) {
    add(
      'fail',
      'device',
      online.length === 0
        ? 'no emulator or device is online: start one (emulator -avd <name>) and wait for it to boot.'
        : options.serial === undefined
          ? `${online.length} devices are online (${online.join(', ')}); pick one with --serial.`
          : `${options.serial} is not online (${online.join(', ') || 'none'}).`,
    );
    return { ok: false, lines };
  }
  add('pass', 'device', serial);
  const shell = (...args: string[]): AdbResult => adb(['-s', serial, 'shell', ...args]);

  const sdk = Number(shell('getprop', 'ro.build.version.sdk').stdout.trim());
  add(
    Number.isInteger(sdk) && sdk > 0 ? 'pass' : 'warn',
    'android-version',
    Number.isInteger(sdk) && sdk > 0
      ? `API ${sdk}${sdk >= 33 ? ' (notifications need the runtime POST_NOTIFICATIONS permission)' : ''}`
      : 'could not read ro.build.version.sdk',
  );

  const gms = listsAndroidPackage(
    shell('pm', 'list', 'packages', 'com.google.android.gms').stdout,
    'com.google.android.gms',
  );
  add(
    gms ? 'pass' : 'fail',
    'google-play-services',
    gms
      ? 'com.google.android.gms is installed'
      : 'no Google Play services: FCM cannot deliver. Use a "Google APIs" or "Google Play" system image.',
  );
  const store = listsAndroidPackage(
    shell('pm', 'list', 'packages', 'com.android.vending').stdout,
    'com.android.vending',
  );
  add(
    store ? 'pass' : 'warn',
    'google-play-store',
    store
      ? 'com.android.vending is installed'
      : 'no Play Store app: a "Google APIs" image works, but update Play services there if FCM registration fails.',
  );

  const installed = listsAndroidPackage(
    shell('pm', 'list', 'packages', options.appId).stdout,
    options.appId,
  );
  add(
    installed ? 'pass' : 'fail',
    'app',
    installed
      ? `${options.appId} is installed`
      : `${options.appId} is not installed: build and install the game's shell first.`,
  );
  if (installed && sdk >= 33) {
    const granted = dumpsysPermissionGranted(
      shell('dumpsys', 'package', options.appId).stdout,
      'android.permission.POST_NOTIFICATIONS',
    );
    add(
      granted === true ? 'pass' : 'warn',
      'notification-permission',
      granted === true
        ? 'POST_NOTIFICATIONS is granted'
        : granted === false
          ? "POST_NOTIFICATIONS is not granted yet: turn notifications on from the game's settings screen (a tap), not with adb."
          : 'POST_NOTIFICATIONS was not requested yet.',
    );
  }

  const forward = `tcp:${options.port} tcp:${options.port}`;
  const hasReverse = (): boolean =>
    adb(['-s', serial, 'reverse', '--list']).stdout.split(/\r?\n/u).some((line) =>
      line.trim().endsWith(forward),
    );
  if (!hasReverse() && options.reverse) {
    adb(['-s', serial, 'reverse', `tcp:${options.port}`, `tcp:${options.port}`]);
  }
  const reversed = hasReverse();
  add(
    reversed ? 'pass' : 'warn',
    'reverse',
    reversed
      ? `the device's 127.0.0.1:${options.port} reaches this machine's ${options.port}`
      : `run: adb -s ${serial} reverse tcp:${options.port} tcp:${options.port} (or pass --reverse)`,
  );
  return { ok: lines.every((line) => line.result !== 'fail'), serial, lines };
}
