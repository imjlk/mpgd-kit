import { LiveDriverUsageError } from './driver';

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
  /** What adb said on failure (`device offline`, `unauthorized`, ...), when the runner keeps it. */
  readonly stderr?: string;
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

/**
 * The serials `adb devices` lists as online (`device`), not `offline` or
 * `unauthorized`. Lines before the `List of devices attached` header (the
 * daemon's start-up notes) are ignored.
 */
export function onlineAdbSerials(devicesOutput: string): readonly string[] {
  const lines = devicesOutput.split(/\r?\n/u);
  const header = lines.findIndex((line) => line.trim().startsWith('List of devices'));
  if (header < 0) {
    // Not a device list: nothing in it names a device.
    return [];
  }
  return lines
    .slice(header + 1)
    .map((line) => line.trim().split(/\s+/u))
    .filter((fields) => fields.length >= 2 && fields[1] === 'device')
    .map((fields) => fields[0] ?? '')
    .filter((serial) => serial.length > 0);
}

/** Whether `pm list packages <name>` lists exactly that package (the filter also matches longer names). */
export function listsAndroidPackage(listOutput: string, name: string): boolean {
  return listOutput.split(/\r?\n/u).some((line) => line.trim() === `package:${name}`);
}

/**
 * `granted=true` / `granted=false` of a runtime permission in `dumpsys
 * package <app>`, or `undefined`. The name must start its line, so a
 * permission that only ends with it does not match; the first user's
 * section (user 0) comes first.
 */
export function dumpsysPermissionGranted(dumpsysOutput: string, permission: string): boolean | undefined {
  const escaped = permission.replaceAll('.', '\\.');
  const match = new RegExp(`^\\s*${escaped}: granted=(true|false)`, 'mu').exec(dumpsysOutput);
  return match === null ? undefined : match[1] === 'true';
}

/** Whether `adb reverse --list` has exactly this forward (device port to host port). */
export function listsAdbReverse(listOutput: string, port: number): boolean {
  return listOutput.split(/\r?\n/u).some((line) => {
    const fields = line.trim().split(/\s+/u);
    return fields.at(-2) === `tcp:${port}` && fields.at(-1) === `tcp:${port}`;
  });
}

function deviceProblem(online: readonly string[], serial: string | undefined): string {
  if (online.length === 0) {
    return 'no emulator or device is online: start one (emulator -avd <name>) and wait for it to boot.';
  }
  if (serial === undefined) {
    return `${online.length} devices are online (${online.join(', ')}); pick one with --serial.`;
  }
  return `${serial} is not online (${online.join(', ')}).`;
}

function permissionDetail(granted: boolean | undefined): string {
  if (granted === true) {
    return 'POST_NOTIFICATIONS is granted';
  }
  if (granted === false) {
    return "POST_NOTIFICATIONS is not granted yet: turn notifications on from the game's settings screen (a tap), not with adb.";
  }
  return "POST_NOTIFICATIONS is not in the app's runtime permissions: not requested yet, or not in its manifest.";
}

/** An adb call that failed: the device went away, or adb could not run. */
class AdbCallFailed extends Error {}

export function checkLiveEmulator(options: EmulatorCheckOptions, adb: AdbRunner): EmulatorCheckReport {
  if (!appIdPattern.test(options.appId)) {
    throw new LiveDriverUsageError(
      `--app-id ${JSON.stringify(options.appId)} is not an Android package name.`,
    );
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) {
    throw new LiveDriverUsageError(`--port ${options.port} is not a TCP port.`);
  }
  const lines: EmulatorCheckLine[] = [];
  const add = (result: EmulatorCheckLine['result'], check: string, detail: string): void => {
    lines.push({ result, check, detail });
  };
  const devices = adb(['devices']);
  if (devices.status !== 0) {
    const said = devices.stderr?.trim().split(/\r?\n/u)[0];
    add(
      'fail',
      'adb',
      `adb devices failed${said ? ` (${said})` : ''}: is the Android SDK platform-tools installed (ANDROID_HOME)?`,
    );
    return { ok: false, lines };
  }
  const online = onlineAdbSerials(devices.stdout);
  const serial = options.serial ?? (online.length === 1 ? online[0] : undefined);
  if (serial === undefined || !online.includes(serial)) {
    add('fail', 'device', deviceProblem(online, options.serial));
    return { ok: false, lines };
  }
  add('pass', 'device', serial);
  /** One adb call on the device; a failed call stops the check, so it is never read as an empty answer. */
  const failure = (args: readonly string[], result: AdbResult, hint: string): AdbCallFailed => {
    const said = result.stderr?.trim().split(/\r?\n/u)[0];
    return new AdbCallFailed(
      `adb -s ${serial} ${args.join(' ')} failed (exit ${result.status}${said ? `: ${said}` : ''}): ${hint}`,
    );
  };
  const onDevice = (...args: string[]): string => {
    const result = adb(['-s', serial, ...args]);
    if (result.status !== 0) {
      throw failure(args, result, 'is the device still online?');
    }
    return result.stdout;
  };
  const installedPackage = (name: string): boolean => {
    const args = ['shell', 'pm', 'list', 'packages', name];
    const result = adb(['-s', serial, ...args]);
    if (result.status === 0) {
      return listsAndroidPackage(result.stdout, name);
    }
    // Some builds exit non-zero when nothing matches: that is "not
    // installed" while the device still answers, and an adb failure if not.
    if (result.stdout.trim() === '' && adb(['-s', serial, 'shell', 'true']).status === 0) {
      return false;
    }
    throw failure(args, result, 'is the device still online?');
  };
  try {
    if (onDevice('shell', 'getprop', 'sys.boot_completed').trim() !== '1') {
      add(
        'fail',
        'boot',
        'the device is online but has not finished booting; wait and run this again.',
      );
      return { ok: false, serial, lines };
    }
    const sdk = Number(onDevice('shell', 'getprop', 'ro.build.version.sdk').trim());
    const sdkKnown = Number.isInteger(sdk) && sdk > 0;
    if (!sdkKnown) {
      add(
        'warn',
        'android-version',
        'could not read ro.build.version.sdk; the permission check is skipped.',
      );
    } else {
      add(
        'pass',
        'android-version',
        sdk >= 33
          ? `API ${sdk} (notifications need the runtime POST_NOTIFICATIONS permission)`
          : `API ${sdk}`,
      );
    }

    if (installedPackage('com.google.android.gms')) {
      add('pass', 'google-play-services', 'com.google.android.gms is installed');
    } else {
      add(
        'fail',
        'google-play-services',
        'no Google Play services: FCM cannot deliver. Use a "Google APIs" or "Google Play" system image.',
      );
    }
    if (installedPackage('com.android.vending')) {
      add('pass', 'google-play-store', 'com.android.vending is installed');
    } else {
      add(
        'warn',
        'google-play-store',
        'no Play Store app: a "Google APIs" image works, but update Play services there if FCM registration fails.',
      );
    }

    const installed = installedPackage(options.appId);
    if (installed) {
      add('pass', 'app', `${options.appId} is installed`);
    } else {
      add(
        'fail',
        'app',
        `${options.appId} is not installed: build and install the game's shell first.`,
      );
    }
    if (installed && sdkKnown && sdk >= 33) {
      const granted = dumpsysPermissionGranted(
        onDevice('shell', 'dumpsys', 'package', options.appId),
        'android.permission.POST_NOTIFICATIONS',
      );
      add(granted === true ? 'pass' : 'warn', 'notification-permission', permissionDetail(granted));
    }

    let reversed = listsAdbReverse(onDevice('reverse', '--list'), options.port);
    if (!reversed && options.reverse) {
      const forward = ['reverse', `tcp:${options.port}`, `tcp:${options.port}`];
      const set = adb(['-s', serial, ...forward]);
      if (set.status !== 0) {
        throw failure(
          forward,
          set,
          `is the port taken by another forward? Try adb -s ${serial} reverse --remove tcp:${options.port}.`,
        );
      }
      reversed = listsAdbReverse(onDevice('reverse', '--list'), options.port);
    }
    if (reversed) {
      add(
        'pass',
        'reverse',
        `the device's 127.0.0.1:${options.port} reaches this machine's ${options.port}`,
      );
    } else {
      add(
        'warn',
        'reverse',
        `run: adb -s ${serial} reverse tcp:${options.port} tcp:${options.port} (or pass --reverse)`,
      );
    }
  } catch (error) {
    if (!(error instanceof AdbCallFailed)) {
      throw error;
    }
    add('fail', 'adb', error.message);
  }
  return { ok: lines.every((line) => line.result !== 'fail'), serial, lines };
}
