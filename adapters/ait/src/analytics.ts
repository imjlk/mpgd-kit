import type { BridgeAnalyticsMethod } from '@mpgd/bridge';
import {
  createUnsupportedPlatformAnalyticsSink,
  platformAnalyticsLogTypes,
  readPlatformAnalyticsLog,
  readPlatformAnalyticsStatus,
  type PlatformAnalyticsLogType,
  type PlatformAnalyticsParamValue,
  type PlatformAnalyticsSink,
  type PlatformAnalyticsStatus,
} from '@mpgd/platform/analytics';

/**
 * Apps in Toss platform analytics. The game's gateway sends each log over the
 * host bridge (`analytics.log`); the wrapper's host bridge re-validates it and
 * calls `Analytics` from `@apps-in-toss/web-framework`, so the game bundle
 * never imports the SDK. This module imports no SDK either: the host passes
 * the SDK in.
 */
export const aitAnalyticsProviderId = 'apps-in-toss';

/** `Analytics.log` sends only on Toss 5.208.0 or later and is silently ignored before. */
export const minimumAitAnalyticsLogTossAppVersion = '5.208.0';

/** What a host older than 5.208.0 still sends, through the legacy loggers. */
const legacyLogTypes: readonly PlatformAnalyticsLogType[] = Object.freeze([
  'screen',
  'click',
  'impression',
]);

type AitLogParams = Readonly<Record<string, PlatformAnalyticsParamValue>>;
type AitLegacyLogger = (params: { readonly log_name: string } & AitLogParams) => Promise<void> | undefined;

/** The part of the SDK's `Analytics` the host calls. */
export interface AitAnalyticsSdk {
  readonly screen: AitLegacyLogger;
  readonly click: AitLegacyLogger;
  readonly impression: AitLegacyLogger;
  readonly log: (params: {
    readonly log_name: string;
    readonly log_type: Exclude<PlatformAnalyticsLogType, 'screen'>;
    readonly params: AitLogParams;
  }) => Promise<void>;
}

export interface AitAnalyticsHost {
  getStatus(): PlatformAnalyticsStatus;
  /** Re-validates an untrusted log and calls the SDK. Never throws. */
  log(value: unknown): boolean;
}

/**
 * Host side. `screen` logs go to `Analytics.screen`. On Toss 5.208.0 or later
 * the other types go to `Analytics.log`; before it, `click` and `impression`
 * fall back to `Analytics.click` and `Analytics.impression`, and `event` is
 * dropped. A log is handed to the SDK without waiting for it, and an SDK
 * failure, thrown or rejected, only drops the log.
 */
export function createAitAnalyticsHost(input: {
  readonly sdk: AitAnalyticsSdk;
  /** Whether this Toss app sends `Analytics.log` (5.208.0 or later). */
  readonly isLogSupported: () => boolean;
}): AitAnalyticsHost {
  return {
    getStatus() {
      return {
        provider: aitAnalyticsProviderId,
        state: 'available',
        logTypes: input.isLogSupported() ? platformAnalyticsLogTypes : legacyLogTypes,
      };
    },
    log(value) {
      const log = readPlatformAnalyticsLog(value);
      if (log === undefined) {
        return false;
      }
      const legacy = { log_name: log.logName, ...log.params };
      try {
        let sent: Promise<void> | undefined;
        if (log.logType === 'screen') {
          sent = input.sdk.screen(legacy);
        } else if (input.isLogSupported()) {
          sent = input.sdk.log({ log_name: log.logName, log_type: log.logType, params: log.params });
        } else if (log.logType === 'click') {
          sent = input.sdk.click(legacy);
        } else if (log.logType === 'impression') {
          sent = input.sdk.impression(legacy);
        } else {
          return false;
        }
        void Promise.resolve(sent).catch(() => {});
        return true;
      } catch {
        // Analytics must never affect play.
        return false;
      }
    },
  };
}

/**
 * Game side: the gateway's `analytics`. A host bridge published before
 * platform analytics answers `UNSUPPORTED_METHOD` (or rejects the method
 * name), which reads as `unsupported`; every failure resolves, never throws.
 */
export function createAitBridgeAnalyticsSink(
  request: (method: BridgeAnalyticsMethod, payload: unknown) => Promise<unknown>,
): PlatformAnalyticsSink {
  const unsupported = createUnsupportedPlatformAnalyticsSink();
  return {
    async getStatus() {
      try {
        return readPlatformAnalyticsStatus(await request('analytics.getStatus', {}))
          ?? await unsupported.getStatus();
      } catch {
        return await unsupported.getStatus();
      }
    },
    async log(entry) {
      const log = readPlatformAnalyticsLog(entry);
      if (log === undefined) {
        return false;
      }
      try {
        const data = await request('analytics.log', log);
        return typeof data === 'object' && data !== null && (data as { readonly sent?: unknown }).sent === true;
      } catch {
        return false;
      }
    },
  };
}
