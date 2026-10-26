import { Capacitor, registerPlugin } from '@capacitor/core';
import {
  createUnavailableCrashReporter,
  formatCrashMessage,
  installCrashErrorCapture,
  normalizeCrashError,
  redactCrashText,
  sanitizeCrashContext,
  type CrashContextValue,
  type CrashErrorEventTarget,
  type CrashReporter,
  type CrashReporterStatus,
  type CrashStackFrame,
} from '@mpgd/platform/crash-reporting';

// Firebase Crashlytics through the native plugin `@capacitor-firebase/crashlytics`
// 8.x, installed into the shell by `mpgd target init capacitor --providers
// crash-reporting`. The game bundle never imports the npm package: the
// reporter reaches the native plugin by its registered name, so a game whose
// shell lacks the plugin builds unchanged and gets an unavailable reporter.

/** The name the native plugin registers with Capacitor. */
export const capacitorCrashlyticsPluginName = 'FirebaseCrashlytics';
/** `CrashReporterStatus.provider` of the Capacitor reporter. */
export const capacitorCrashReportingProvider = 'firebase-crashlytics';

type CrashlyticsKeyType = 'string' | 'boolean' | 'long' | 'double' | 'int' | 'float';

/**
 * The calls the reporter makes on `@capacitor-firebase/crashlytics` 8.x
 * (`FirebaseCrashlyticsPlugin`); the adapter's tests check that the plugin's
 * own declarations satisfy it.
 */
export interface CapacitorCrashlyticsPlugin {
  setCustomKey(options: {
    readonly key: string;
    readonly value: CrashContextValue;
    readonly type: CrashlyticsKeyType;
  }): Promise<void>;
  log(options: { readonly message: string }): Promise<void>;
  setEnabled(options: { readonly enabled: boolean }): Promise<void>;
  /** iOS only; Android rejects it. */
  isEnabled(): Promise<{ readonly enabled: boolean }>;
  deleteUnsentReports(): Promise<void>;
  recordException(options: {
    readonly message: string;
    readonly stacktrace?: CrashStackFrame[];
  }): Promise<void>;
}

export interface CapacitorCrashReporterOptions {
  readonly target: 'android' | 'ios';
  readonly appVersion: string;
  readonly buildId: string;
  /**
   * Extra non-personal context, for example the kit or content version.
   * Filtered by `sanitizeCrashContext`; never put a player id here.
   */
  readonly context?: Readonly<Record<string, unknown>>;
  /**
   * Hold JavaScript reports and breadcrumbs until the game calls
   * `setCollectionEnabled(true)` in this session, for games that turn
   * Crashlytics' automatic collection off until the player agrees
   * (docs/CRASH_REPORTING.md#the-players-choice). Defaults to false.
   */
  readonly requireConsent?: boolean;
  /** Defaults to `Capacitor.isPluginAvailable`. */
  readonly isPluginAvailable?: (name: string) => boolean;
  /** Defaults to the plugin registered under `capacitorCrashlyticsPluginName`. */
  readonly plugin?: CapacitorCrashlyticsPlugin;
}

const int32Min = -(2 ** 31);
const int32Max = 2 ** 31 - 1;

function keyType(value: CrashContextValue): CrashlyticsKeyType {
  if (typeof value === 'boolean') {
    return 'boolean';
  }
  if (typeof value === 'number') {
    // The Android plugin reads `long` and `int` values as a Java Integer, so
    // an integer outside the int32 range goes as a double.
    return Number.isInteger(value) && value >= int32Min && value <= int32Max ? 'int' : 'double';
  }
  return 'string';
}

/** A kit-set build fact: control characters removed and cut to 128 characters, not redacted. */
function kitContextValue(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, 128);
}

/**
 * A `CrashReporter` backed by Firebase Crashlytics. Native crashes are
 * captured by the Crashlytics SDK on its own; this reporter adds non-fatal
 * reports for JavaScript errors, breadcrumbs, and the collection toggle.
 * Context keys (`mpgd_target`, `mpgd_build_id`, `mpgd_app_version`,
 * `mpgd_adapter`, and `options.context`) are set once, starting when the
 * reporter is created, so native crashes carry them too. When the first of
 * them fails (Firebase not configured) the reporter is `not-configured` and
 * later calls do nothing; a failing game key is skipped.
 */
export function createCapacitorCrashReporter(options: CapacitorCrashReporterOptions): CrashReporter {
  const isPluginAvailable = options.isPluginAvailable
    ?? ((name: string) => Capacitor.isPluginAvailable(name));
  if (!isPluginAvailable(capacitorCrashlyticsPluginName)) {
    return createUnavailableCrashReporter({
      provider: capacitorCrashReportingProvider,
      state: 'not-installed',
    });
  }
  const plugin = options.plugin
    ?? registerPlugin<CapacitorCrashlyticsPlugin>(capacitorCrashlyticsPluginName);
  // Build ids are often long hex strings, which the token rule of
  // `redactCrashText` would hide, so the kit's own keys are not redacted.
  // `mpgd_target` goes first: its result tells whether Firebase is configured.
  const kitContext: readonly (readonly [string, string])[] = [
    ['mpgd_build_id', kitContextValue(options.buildId)],
    ['mpgd_app_version', kitContextValue(options.appVersion)],
    ['mpgd_adapter', 'capacitor'],
  ];
  const gameContext = Object.entries(sanitizeCrashContext(options.context ?? {}))
    .filter(([key]) => !key.startsWith('mpgd_'));
  // Set by `setCollectionEnabled` in this session; the SDK keeps the choice
  // across launches, but Android cannot read it back.
  let collectionEnabled: boolean | undefined = options.requireConsent === true ? false : undefined;
  let ready: Promise<boolean> | undefined;
  const prepare = (): Promise<boolean> => {
    ready ??= (async () => {
      try {
        await plugin.setCustomKey({ key: 'mpgd_target', value: options.target, type: 'string' });
      } catch {
        return false;
      }
      for (const [key, value] of [...kitContext, ...gameContext]) {
        try {
          await plugin.setCustomKey({ key, value, type: keyType(value) });
        } catch {
          // One key the SDK refuses does not stop reporting.
        }
      }
      return true;
    })();
    return ready;
  };
  const collecting = async (): Promise<boolean> => collectionEnabled !== false && await prepare();
  // Native crashes can happen before any JavaScript report, so the context
  // keys are set right away. Keys stay on the device until a report is sent,
  // so this does not bypass `requireConsent`.
  void prepare();

  return {
    async getStatus(): Promise<CrashReporterStatus> {
      if (!await prepare()) {
        return { provider: capacitorCrashReportingProvider, state: 'not-configured' };
      }
      let enabled = collectionEnabled;
      if (enabled === undefined && options.target === 'ios') {
        try {
          enabled = (await plugin.isEnabled()).enabled;
        } catch {
          enabled = undefined;
        }
      }
      return {
        provider: capacitorCrashReportingProvider,
        state: 'available',
        ...(enabled === undefined ? {} : { collectionEnabled: enabled }),
      };
    },
    async recordError(error, recordOptions) {
      if (!await collecting()) {
        return false;
      }
      const normalized = normalizeCrashError(error);
      try {
        await plugin.recordException({
          message: formatCrashMessage(normalized, recordOptions?.source ?? 'game'),
          ...(normalized.frames.length === 0 ? {} : { stacktrace: [...normalized.frames] }),
        });
        return true;
      } catch {
        // A report that cannot be recorded is dropped; game code never sees it.
        return false;
      }
    },
    async log(message) {
      if (!await collecting()) {
        return;
      }
      try {
        await plugin.log({ message: redactCrashText(message) });
      } catch {
        // Breadcrumbs are best effort.
      }
    },
    async setCollectionEnabled(enabled) {
      if (!await prepare()) {
        return;
      }
      collectionEnabled = enabled;
      try {
        await plugin.setEnabled({ enabled });
        if (!enabled) {
          await plugin.deleteUnsentReports();
        }
      } catch {
        // The session flag still stops JavaScript reports when turned off.
      }
    },
  };
}

export interface CapacitorCrashReportingOptions extends Omit<
  CapacitorCrashReporterOptions,
  'target' | 'appVersion' | 'buildId'
> {
  /** A reporter to use instead of the Crashlytics one. */
  readonly reporter?: CrashReporter;
  /**
   * Report uncaught errors and unhandled rejections from the WebView.
   * Defaults to true; only installed when the native plugin is present.
   */
  readonly captureGlobalErrors?: boolean;
  /** Defaults to `globalThis` when it has `addEventListener`. */
  readonly errorTarget?: CrashErrorEventTarget;
}

/**
 * The gateway's crash reporting: the reporter and, when the crash service is
 * present, the WebView error capture. `dispose` removes the listeners.
 */
export function createCapacitorGatewayCrashReporting(input: {
  readonly target: 'android' | 'ios';
  readonly appVersion: string;
  readonly buildId: string;
  readonly options: CapacitorCrashReportingOptions;
}): { readonly reporter: CrashReporter; readonly dispose: () => void } {
  const { reporter: customReporter, captureGlobalErrors, errorTarget, ...reporterOptions } = input.options;
  const isPluginAvailable = reporterOptions.isPluginAvailable
    ?? ((name: string) => Capacitor.isPluginAvailable(name));
  const reporter = customReporter ?? createCapacitorCrashReporter({
    ...reporterOptions,
    isPluginAvailable,
    target: input.target,
    appVersion: input.appVersion,
    buildId: input.buildId,
  });
  const present = customReporter !== undefined || isPluginAvailable(capacitorCrashlyticsPluginName);
  const target = errorTarget ?? globalErrorTarget();
  const dispose = present && captureGlobalErrors !== false && target !== undefined
    ? installCrashErrorCapture({ reporter, target })
    : () => {};
  return { reporter, dispose };
}

function globalErrorTarget(): CrashErrorEventTarget | undefined {
  const candidate = globalThis as Partial<CrashErrorEventTarget>;
  return typeof candidate.addEventListener === 'function'
    && typeof candidate.removeEventListener === 'function'
    ? candidate as CrashErrorEventTarget
    : undefined;
}
