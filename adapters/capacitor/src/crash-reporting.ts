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
  /** Defaults to `Capacitor.isPluginAvailable`. */
  readonly isPluginAvailable?: (name: string) => boolean;
  /** Defaults to the plugin registered under `capacitorCrashlyticsPluginName`. */
  readonly plugin?: CapacitorCrashlyticsPlugin;
}

function keyType(value: CrashContextValue): CrashlyticsKeyType {
  if (typeof value === 'boolean') {
    return 'boolean';
  }
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) ? 'long' : 'double';
  }
  return 'string';
}

/**
 * A `CrashReporter` backed by Firebase Crashlytics. Native crashes are
 * captured by the Crashlytics SDK on its own; this reporter adds non-fatal
 * reports for JavaScript errors, breadcrumbs, and the collection toggle.
 * Context keys (`mpgd_target`, `mpgd_build_id`, `mpgd_app_version`,
 * `mpgd_adapter`, and `options.context`) are set once before the first
 * report. A plugin call that fails (Firebase not configured) marks the
 * reporter `not-configured` and later calls do nothing.
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
  const context = sanitizeCrashContext({
    ...options.context,
    mpgd_target: options.target,
    mpgd_build_id: options.buildId,
    mpgd_app_version: options.appVersion,
    mpgd_adapter: 'capacitor',
  });
  let configured = true;
  // Set by `setCollectionEnabled` in this session; the SDK keeps the choice
  // across launches, but Android cannot read it back.
  let collectionEnabled: boolean | undefined;
  let ready: Promise<boolean> | undefined;
  const prepare = (): Promise<boolean> => {
    ready ??= (async () => {
      try {
        for (const [key, value] of Object.entries(context)) {
          await plugin.setCustomKey({ key, value, type: keyType(value) });
        }
      } catch {
        configured = false;
      }
      return configured;
    })();
    return ready;
  };
  const collecting = async (): Promise<boolean> => collectionEnabled !== false && await prepare();

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
        return;
      }
      const normalized = normalizeCrashError(error);
      try {
        await plugin.recordException({
          message: formatCrashMessage(normalized, recordOptions?.source ?? 'game'),
          ...(normalized.frames.length === 0 ? {} : { stacktrace: [...normalized.frames] }),
        });
      } catch {
        // A report that cannot be recorded is dropped; game code never sees it.
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
