import {
  AdMob,
  AdmobConsentStatus,
  RewardAdPluginEvents,
  type AdMobPlugin,
} from '@capacitor-community/admob';
import type { BridgeRequest, BridgeResponse } from '@mpgd/bridge';
import { admobClientRewardEvidenceSchema } from '@mpgd/game-services/admob-client-reward';
import {
  admobSsvMaximumBindingFieldLength,
  encodeAdMobSsvCustomData,
} from '@mpgd/game-services/admob-ssv';
import type { RewardedAdResult } from '@mpgd/platform';

import type { CapacitorServiceProvider } from './providers.js';

/** Only the AdMob subpath imports the optional native SDK. */
export type RewardedAdMobSdk = Pick<AdMobPlugin,
  | 'initialize'
  | 'requestConsentInfo'
  | 'showConsentForm'
  | 'showPrivacyOptionsForm'
  | 'prepareRewardVideoAd'
  | 'showRewardVideoAd'
  | 'addListener'
>;

export interface CreateCapacitorAdMobRewardedProviderInput {
  /** Logical placement IDs mapped to target-specific, game-owned AdMob ad units. */
  readonly adUnits: Readonly<Record<string, string>>;
  /** Must resolve to the same authenticated player ID used by GameServicesClient. */
  readonly getPlayerId: () => Promise<string> | string;
  /** Test ads do not send Google SSV callbacks; server grants remain pending. */
  readonly isTesting?: boolean;
  readonly sdk?: RewardedAdMobSdk;
  readonly showTimeoutMs?: number;
}

export interface CapacitorAdMobRewardedProvider extends CapacitorServiceProvider {
  /** Present UMP when required. Call before the gateway advertises ad readiness. */
  requestConsent(): Promise<boolean>;
  /** Game settings should expose this when the privacy message requires it. */
  showPrivacyOptions(): Promise<void>;
}

const unitPattern = /^ca-app-pub-\d+\/\d+$/u;
const defaultShowTimeoutMs = 180_000;
const loadTimeoutMs = 30_000;
const preflightTimeoutMs = 10_000;
const listenerCleanupTimeoutMs = 1_000;
const maximumCustomDataBytes = 1_024;
// The native plugin's rewarded event stream and prepared-ad table are global.
// Coordinate Kit providers sharing one SDK instance, even across gateways.
const activeSdk = new WeakSet<object>();
const uncertainSdk = new WeakSet<object>();

function response(input: BridgeRequest, result: RewardedAdResult | undefined): BridgeResponse {
  return { id: input.id, ok: true, data: result };
}

function failure(input: BridgeRequest, code: string, retryable = false): BridgeResponse {
  return { id: input.id, ok: false, error: { code, message: code, retryable } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRewardItem(value: unknown): boolean {
  return isRecord(value)
    && typeof value.type === 'string'
    && value.type.length > 0
    && typeof value.amount === 'number'
    && Number.isFinite(value.amount)
    && value.amount > 0;
}

class PreflightTimeoutError extends Error {}

async function withTimeout<T>(
  promise: Promise<T>,
  milliseconds: number,
  onLate?: (value: T) => Promise<void> | void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  const watched = promise.then((value) => {
    if (expired && onLate !== undefined) {
      void Promise.resolve().then(() => onLate(value)).catch(() => undefined);
    }
    return value;
  });
  try {
    return await Promise.race([
      watched,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          expired = true;
          reject(new PreflightTimeoutError('AdMob preflight timed out.'));
        }, milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * Opt-in rewarded-only provider. The SDK's SSV options are attached when an
 * operation is shown, never to an earlier unbound preload. A local reward
 * callback is only a signal to ask the backend; it is not a ledger grant.
 */
export function createCapacitorAdMobRewardedProvider(
  input: CreateCapacitorAdMobRewardedProviderInput,
): CapacitorAdMobRewardedProvider {
  const sdk = input.sdk ?? AdMob;
  const showTimeoutMs = input.showTimeoutMs ?? defaultShowTimeoutMs;
  if (!Number.isSafeInteger(showTimeoutMs) || showTimeoutMs < 1_000 || showTimeoutMs > 300_000) {
    throw new Error('AdMob show timeout must be between 1 and 300 seconds.');
  }

  const adUnits = new Map<string, string>();
  for (const [placementId, unit] of Object.entries(input.adUnits)) {
    if (placementId.trim() === '' || !unitPattern.test(unit)) {
      throw new Error(
        'AdMob rewarded placements require non-empty IDs and production-format ad units.',
      );
    }
    adUnits.set(placementId, unit);
  }
  if (adUnits.size === 0) {
    throw new Error('AdMob rewarded provider requires at least one ad unit.');
  }

  let initialized: Promise<void> | undefined;
  let consentTask: Promise<boolean> | undefined;
  let canRequestAds = false;
  let privacyOptionsRequired = false;

  const initialize = async (): Promise<void> => {
    if (initialized === undefined) {
      initialized = sdk.initialize().catch((error: unknown) => {
        initialized = undefined;
        throw error;
      });
    }
    await initialized;
  };

  const requestConsent = (): Promise<boolean> => {
    if (consentTask === undefined) {
      consentTask = (async () => {
        canRequestAds = false;
        await initialize();
        let info = await sdk.requestConsentInfo();
        if (info.status === AdmobConsentStatus.REQUIRED && info.isConsentFormAvailable) {
          info = await sdk.showConsentForm();
        }
        canRequestAds = info.canRequestAds === true;
        privacyOptionsRequired = info.privacyOptionsRequirementStatus === 'REQUIRED';
        return canRequestAds;
      })().finally(() => { consentTask = undefined; });
    }
    return consentTask;
  };

  const showRewarded = async (
    placementId: string,
    idempotencyKey: string,
  ): Promise<RewardedAdResult> => {
    const adId = adUnits.get(placementId);
    if (adId === undefined || !canRequestAds || activeSdk.has(sdk) || uncertainSdk.has(sdk)) {
      return { status: 'unavailable', rewardGranted: false };
    }
    if (idempotencyKey.trim() === ''
      || idempotencyKey.length > admobSsvMaximumBindingFieldLength
      || placementId.length > admobSsvMaximumBindingFieldLength) {
      return { status: 'failed', rewardGranted: false };
    }

    activeSdk.add(sdk);
    const handles: Array<{ remove(): Promise<void> }> = [];
    let rewardEarned = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let loadTimer: ReturnType<typeof setTimeout> | undefined;
    let loadTimedOut = false;
    let nativePreflightStarted = false;
    try {
      const playerId = await withTimeout(
        Promise.resolve().then(() => input.getPlayerId()),
        preflightTimeoutMs,
      );
      if (typeof playerId !== 'string' || playerId.trim() === ''
        || playerId.length > admobSsvMaximumBindingFieldLength) {
        return { status: 'failed', rewardGranted: false };
      }
      const customData = encodeAdMobSsvCustomData({ playerId, placementId, idempotencyKey });
      if (new TextEncoder().encode(customData).byteLength > maximumCustomDataBytes) {
        return { status: 'failed', rewardGranted: false };
      }
      // This plugin resolves showRewardVideoAd on reward, but on Android a
      // dismissal without reward leaves that promise unresolved. Observe the
      // terminal native events separately, and hold lifecycle through close.
      let finish!: (value: 'dismissed' | 'failed' | 'timeout') => void;
      const terminal = new Promise<'dismissed' | 'failed' | 'timeout'>((resolve) => {
        finish = resolve;
      });
      nativePreflightStarted = true;
      handles.push(await withTimeout(sdk.addListener(RewardAdPluginEvents.Rewarded, (reward) => {
        if (isRewardItem(reward)) {
          rewardEarned = true;
        }
      }), preflightTimeoutMs, (handle) => handle.remove()));
      handles.push(await withTimeout(sdk.addListener(RewardAdPluginEvents.Dismissed, () => {
        // Let a same-turn Rewarded event settle before reading the flag.
        queueMicrotask(() => finish('dismissed'));
      }), preflightTimeoutMs, (handle) => handle.remove()));
      handles.push(await withTimeout(sdk.addListener(RewardAdPluginEvents.FailedToShow, () => {
        finish('failed');
      }), preflightTimeoutMs, (handle) => handle.remove()));
      const loaded = await Promise.race([
        sdk.prepareRewardVideoAd({
          adId,
          ...(input.isTesting === undefined ? {} : { isTesting: input.isTesting }),
          ssv: { userId: playerId, customData },
        }),
        new Promise<never>((_resolve, reject) => {
          loadTimer = setTimeout(() => {
            loadTimedOut = true;
            reject(new Error('AdMob load timed out.'));
          }, loadTimeoutMs);
        }),
      ]);
      if (loadTimer !== undefined) {
        clearTimeout(loadTimer);
        loadTimer = undefined;
      }
      if (typeof loaded.adUnitId !== 'string' || loaded.adUnitId.length === 0) {
        return { status: 'failed', rewardGranted: false };
      }
      timer = setTimeout(() => finish('timeout'), showTimeoutMs);
      // Always observe rejection, even if a Dismissed event wins the race.
      const showResult = sdk.showRewardVideoAd({ adId: loaded.adUnitId });
      const onReward = (reward: unknown) => {
        if (isRewardItem(reward)) {
          rewardEarned = true;
        }
      };
      const onShowError = () => finish('failed');
      void showResult.then(onReward, onShowError);
      const outcome = await terminal;
      if (outcome === 'timeout') {
        // Native presentation state is unknown: do not allow another show.
        uncertainSdk.add(sdk);
      }
      let status: RewardedAdResult['status'] = 'failed';
      if (rewardEarned) {
        status = 'completed';
      } else if (outcome === 'dismissed') {
        // Mediation may deliver reward after dismissal. Only signed SSV can
        // later distinguish a true skip from an earned reward.
        status = 'pending';
      } else if (outcome === 'timeout') {
        status = 'pending';
      }
      return {
        status,
        rewardGranted: false,
        ...(status === 'completed' || status === 'pending' ? { evidence: {
          schema: admobClientRewardEvidenceSchema,
          payload: { adUnitId: adId },
        } } : {}),
      };
    } catch (error) {
      const uncertain = loadTimedOut
        || (nativePreflightStarted && error instanceof PreflightTimeoutError);
      if (uncertain) {
        uncertainSdk.add(sdk);
      }
      return { status: uncertain ? 'pending' : 'failed', rewardGranted: false };
    } finally {
      if (loadTimer !== undefined) {
        clearTimeout(loadTimer);
      }
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      try {
        const removals = handles.map((handle) => {
          const removal = Promise.resolve().then(() => handle.remove());
          return withTimeout(removal, listenerCleanupTimeoutMs);
        });
        const settled = await Promise.allSettled(removals);
        if (settled.some((result) => result.status === 'rejected')) {
          uncertainSdk.add(sdk);
        }
      } finally {
        activeSdk.delete(sdk);
      }
    }
  };

  return {
    id: 'admob-rewarded',
    features: ['rewardedAds'],
    methods: ['ads.preload', 'ads.showRewarded'],
    async getAvailability() {
      if (uncertainSdk.has(sdk) || !canRequestAds) {
        return { rewardedAds: 'action-required' };
      }
      return { rewardedAds: activeSdk.has(sdk) ? 'temporarily-unavailable' : 'available' };
    },
    requestConsent,
    async showPrivacyOptions() {
      if (!privacyOptionsRequired) {
        return;
      }
      canRequestAds = false;
      await initialize();
      try {
        await sdk.showPrivacyOptionsForm();
      } finally {
        await requestConsent();
      }
    },
    bridge: {
      async request(request) {
        if (request.method === 'ads.preload') {
          const payload = request.payload;
          if (!isRecord(payload)
            || (payload.format !== undefined && payload.format !== 'rewarded')
            || typeof payload.placementId !== 'string'
            || !adUnits.has(payload.placementId)) {
            return failure(request, 'ADMOB_PLACEMENT_INVALID');
          }
          // Preloading an unbound ad would omit the operation's SSV key.
          return response(request, undefined);
        }
        if (request.method !== 'ads.showRewarded' || !isRecord(request.payload)
          || typeof request.payload.placementId !== 'string'
          || typeof request.payload.idempotencyKey !== 'string') {
          return failure(request, 'ADMOB_REQUEST_INVALID');
        }
        return response(request, await showRewarded(
          request.payload.placementId,
          request.payload.idempotencyKey,
        ));
      },
    },
  };
}
