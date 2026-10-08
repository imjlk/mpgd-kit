import {
  AdMob,
  AdmobConsentStatus,
  RewardAdPluginEvents,
  type AdMobPlugin,
} from '@capacitor-community/admob';
import { Capacitor } from '@capacitor/core';
import type { BridgeRequest, BridgeResponse } from '@mpgd/bridge';
import { admobClientRewardEvidenceSchema } from '@mpgd/game-services/admob-client-reward';
import {
  admobSsvMaximumBindingFieldLength,
  encodeAdMobSsvCustomData,
} from '@mpgd/game-services/admob-ssv';
import type { RewardedAdResult } from '@mpgd/platform';
import {
  adProtocol,
  adProtocolVersion,
  assertAdPresentationEvent,
  assertAdShowInput,
  assertAdShowResult,
  toAdAdapter,
  type AdAvailability,
  type AdPlacementInput,
  type AdPresentationEvent,
  type AdProvider,
  type AdReason,
  type AdShowInput,
  type AdShowResult,
} from '@mpgd/platform/ads';

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
  /** Used for native no-fill error codes; defaults to Capacitor's platform. */
  readonly target?: 'android' | 'ios';
}

export interface CapacitorAdMobRewardedProvider extends CapacitorServiceProvider {
  readonly adProvider: AdProvider;
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
const pendingLoadSdk = new WeakSet<object>();
type AdEventBody<T = AdPresentationEvent> = T extends AdPresentationEvent
  ? Omit<T, 'providerId' | 'invocationId' | 'sequence'> : never;

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

  const providerId = 'admob-rewarded';
  const nativeTarget = input.target ?? Capacitor.getPlatform();
  const listeners = new Set<(event: AdPresentationEvent) => void>();
  const availability = (request: AdPlacementInput): AdAvailability => {
    if (request.format !== 'rewarded') {
      return { state: 'unsupported', reason: 'unsupported' };
    }
    if (!adUnits.has(request.placementId)) {
      return {
        state: 'configuration-required',
        reason: 'configuration-required',
      };
    }
    if (!canRequestAds || uncertainSdk.has(sdk) || pendingLoadSdk.has(sdk)) {
      return {
        state: 'action-required',
        reason: 'action-required',
      };
    }
    if (activeSdk.has(sdk)) {
      return { state: 'temporarily-unavailable', reason: 'busy' };
    }
    return { state: 'available' };
  };
  const show = async (supplied: AdShowInput): Promise<AdShowResult> => {
    const request = assertAdShowInput(supplied);
    const available = availability(request);
    const result = (state: Omit<AdShowResult, 'providerId' | 'invocationId' | 'format'>): AdShowResult =>
      assertAdShowResult({
        providerId,
        invocationId: request.invocationId,
        format: request.format,
        ...state,
      });
    const noStart = (reason: AdReason, outcome: 'failed' | 'unavailable' = 'failed') => result({
      outcome,
      presentation: 'not-started',
      eligibility: request.format === 'rewarded' ? 'not-earned' : 'not-applicable',
      reason,
    });
    if (available.state !== 'available') {
      return noStart(available.reason ?? 'unsupported', 'unavailable');
    }
    if (request.idempotencyKey.length > admobSsvMaximumBindingFieldLength
      || request.placementId.length > admobSsvMaximumBindingFieldLength) {
      return noStart('transient-failure');
    }
    const adId = adUnits.get(request.placementId);
    if (adId === undefined) {
      return noStart('configuration-required', 'unavailable');
    }
    activeSdk.add(sdk);
    let sequence = 0;
    let started = false;
    let displayCalled = false;
    let closed = false;
    let rewardEarned = false;
    let loadTimedOut = false;
    let listenerTimedOut = false;
    let loadFailure: AdReason = 'transient-failure';
    let timer: ReturnType<typeof setTimeout> | undefined;
    let loadTimer: ReturnType<typeof setTimeout> | undefined;
    const handles: Array<{ remove(): Promise<void> }> = [];
    const candidate = { schema: admobClientRewardEvidenceSchema, payload: { adUnitId: adId } };
    const emit = (event: AdEventBody) => {
      const published = assertAdPresentationEvent({
        ...event,
        providerId,
        invocationId: request.invocationId,
        sequence: ++sequence,
      });
      for (const listener of [...listeners]) {
        try {
          void Promise.resolve(listener(published)).catch(() => undefined);
        } catch { /* Native observation must continue. */ }
      }
    };
    let cleanupTask: Promise<void> | undefined;
    const cleanup = (): Promise<void> => {
      cleanupTask ??= (async () => {
        const settled = await Promise.allSettled(handles.map((handle) =>
          withTimeout(Promise.resolve().then(() => handle.remove()), listenerCleanupTimeoutMs)));
        if (settled.some((entry) => entry.status === 'rejected')) { uncertainSdk.add(sdk); }
        activeSdk.delete(sdk);
      })();
      return cleanupTask;
    };
    const earned = (reward: unknown) => {
      // Global Rewarded events lack invocation identity. Only the original
      // show promise can bind a late earned callback to this operation.
      if (!displayCalled || rewardEarned || !isRewardItem(reward)) {
        return;
      }
      rewardEarned = true;
      emit({ type: 'reward-earned', evidence: candidate });
    };
    let finish!: (value: 'dismissed' | 'failed' | 'timeout') => void;
    const terminal = new Promise<'dismissed' | 'failed' | 'timeout'>((resolve) => {
      finish = resolve;
    });
    const close = (failed: boolean) => {
      if (!displayCalled || closed) {
        return;
      }
      closed = true;
      uncertainSdk.delete(sdk);
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      emit(failed ? { type: 'failed', reason: 'transient-failure' } : { type: 'closed' });
      finish(failed ? 'failed' : 'dismissed');
      // Also runs after the caller-facing promise has already returned pending.
      void cleanup();
    };
    try {
      const playerId = await withTimeout(
        Promise.resolve().then(() => input.getPlayerId()),
        preflightTimeoutMs,
      );
      if (typeof playerId !== 'string' || playerId.trim() === ''
        || playerId.length > admobSsvMaximumBindingFieldLength) {
        return noStart('transient-failure');
      }
      const customData = encodeAdMobSsvCustomData({
        playerId,
        placementId: request.placementId,
        idempotencyKey: request.idempotencyKey,
      });
      if (new TextEncoder().encode(customData).byteLength > maximumCustomDataBytes) {
        return noStart('transient-failure');
      }
      const listen = async (promise: Promise<{ remove(): Promise<void> }>) => {
        try {
          handles.push(await withTimeout(promise, preflightTimeoutMs, (handle) => handle.remove()));
        } catch (error) {
          listenerTimedOut = error instanceof PreflightTimeoutError;
          throw error;
        }
      };
      await listen(
        sdk.addListener(RewardAdPluginEvents.Dismissed, () => queueMicrotask(() => close(false))),
      );
      await listen(sdk.addListener(RewardAdPluginEvents.FailedToShow, () => close(true)));
      await listen(
        sdk.addListener(RewardAdPluginEvents.Showed, () => {
          if (displayCalled && !closed && !started) {
            started = true;
            emit({ type: 'started' });
          }
        }),
      );
      await listen(
        sdk.addListener(RewardAdPluginEvents.FailedToLoad, (error) => {
          if (nativeTarget === 'android' && (error.code === 3 || error.code === 9) || nativeTarget === 'ios' && error.code === 1) {
            loadFailure = 'no-fill';
          }
        }),
      );
      const preparation = sdk.prepareRewardVideoAd({
        adId,
        ...(input.isTesting === undefined ? {} : { isTesting: input.isTesting }),
        ssv: { userId: playerId, customData },
      });
      void preparation.then(
        () => {
          if (loadTimedOut) {
            pendingLoadSdk.delete(sdk);
          }
        },
        () => {
          if (loadTimedOut) {
            pendingLoadSdk.delete(sdk);
          }
        },
      );
      const loaded = await Promise.race([
        preparation,
        new Promise<never>((_resolve, reject) => {
          loadTimer = setTimeout(() => { loadTimedOut = true; pendingLoadSdk.add(sdk); reject(new Error('AdMob load timed out.')); }, loadTimeoutMs);
        }),
      ]);
      if (loadTimer !== undefined) {
        clearTimeout(loadTimer);
        loadTimer = undefined;
      }
      if (typeof loaded.adUnitId !== 'string' || !unitPattern.test(loaded.adUnitId)) {
        return noStart('transient-failure');
      }
      // At this point SSV is attached to the original operation. Lookup correlation
      // is useful even when the caller's deadline precedes an earned SDK callback.
      emit({ type: 'requested', claimEvidence: candidate });
      displayCalled = true;
      timer = setTimeout(() => { uncertainSdk.add(sdk); emit({ type: 'unknown' }); finish('timeout'); }, showTimeoutMs);
      let showing: Promise<unknown>;
      try {
        showing = sdk.showRewardVideoAd({ adId: loaded.adUnitId });
      } catch {
        showing = Promise.reject(new Error('AdMob show invocation failed.'));
      }
      void showing.then((reward) => earned(reward), () => {
        // Promise rejection alone is not a native close observation.
        if (!closed) { uncertainSdk.add(sdk); emit({ type: 'unknown' }); finish('timeout'); }
      });
      const outcome = await terminal;
      if (outcome === 'failed') {
        if (!started && !rewardEarned) {
          return noStart('transient-failure');
        }
        return result({
          outcome: 'failed',
          presentation: 'closed',
          eligibility: rewardEarned ? 'eligible' : 'unknown',
          reason: 'transient-failure',
          claimEvidence: candidate,
          ...(rewardEarned ? { evidence: candidate } : {}),
        });
      }
      const eligibility = rewardEarned ? 'eligible' : 'unknown';
      return result({
        outcome: outcome === 'timeout' ? 'pending' : 'shown',
        presentation: outcome === 'timeout' ? 'unknown' : 'closed',
        eligibility,
        ...(outcome === 'timeout' ? { reason: 'outcome-unknown' } : {}),
        claimEvidence: candidate,
        ...(rewardEarned ? { evidence: candidate } : {}),
      });
    } catch {
      if (displayCalled && !closed) {
        uncertainSdk.add(sdk);
        emit({ type: 'unknown' });
        return result({
          outcome: 'pending',
          presentation: 'unknown',
          eligibility: rewardEarned ? 'eligible' : 'unknown',
          reason: 'outcome-unknown',
          claimEvidence: candidate,
          ...(rewardEarned ? { evidence: candidate } : {}),
        });
      }
      if (listenerTimedOut) {
        uncertainSdk.add(sdk);
      }
      return noStart(loadFailure);
    } finally {
      if (loadTimer !== undefined) {
        clearTimeout(loadTimer);
      }
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      // A caller deadline cannot remove the only native close observer. Keep
      // listeners/ownership until a definitive close, and release only this SDK.
      if (!displayCalled || closed) {
        await cleanup();
      }
    }
  };
  const adProvider: AdProvider = {
    id: providerId,
    protocol: adProtocol,
    protocolVersion: adProtocolVersion,
    rewardSignal: 'delayed',
    getAvailability: async (request) => availability(request),
    async preload(request) {
      const available = availability(request);
      return available.state === 'available'
        ? { status: 'deferred' }
        : { status: 'unavailable', reason: available.reason ?? 'unsupported' };
    },
    show,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const legacy = toAdAdapter(adProvider);

  return {
    id: 'admob-rewarded',
    adProvider,
    features: ['rewardedAds'],
    methods: ['ads.preload', 'ads.showRewarded'],
    async getAvailability() {
      if (uncertainSdk.has(sdk) || pendingLoadSdk.has(sdk) || !canRequestAds) {
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
        return response(request, await legacy.showRewarded({
          placementId: request.payload.placementId,
          idempotencyKey: request.payload.idempotencyKey,
        }));
      },
    },
  };
}
