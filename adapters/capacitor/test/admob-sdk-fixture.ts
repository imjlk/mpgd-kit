import { AdmobConsentStatus, RewardAdPluginEvents } from '@capacitor-community/admob';
import { vi } from 'vitest';
import type { RewardedAdMobSdk } from '../src/admob.js';

const unit = 'ca-app-pub-1234567890123456/1234567890';

export function createAdMobSdkFixture() {
  const listeners = new Map<string, Set<(...args: never[]) => void>>();
  let canRequestAds = true;
  let required = false;
  let privacyRequired = false;
  let removeStuck = false;
  const emit = (event: RewardAdPluginEvents, payload?: unknown) => {
    for (const listener of listeners.get(event) ?? []) {
      (listener as (value?: unknown) => void)(payload ?? { type: 'coin', amount: 1 });
    }
  };
  const prepare = vi.fn(async (_options: unknown) => ({ adUnitId: unit }));
  const show = vi.fn(async (_options: unknown) => ({ type: 'coin', amount: 1 }));
  const sdk = {
    initialize: vi.fn(async () => undefined),
    requestConsentInfo: vi.fn(async () => ({
      status: required ? AdmobConsentStatus.REQUIRED : AdmobConsentStatus.NOT_REQUIRED,
      isConsentFormAvailable: required,
      canRequestAds: !required && canRequestAds,
      privacyOptionsRequirementStatus: privacyRequired ? 'REQUIRED' : 'NOT_REQUIRED',
    })),
    showConsentForm: vi.fn(async () => ({
      status: canRequestAds ? AdmobConsentStatus.OBTAINED : AdmobConsentStatus.REQUIRED,
      canRequestAds,
      privacyOptionsRequirementStatus: privacyRequired ? 'REQUIRED' : 'NOT_REQUIRED',
    })),
    showPrivacyOptionsForm: vi.fn(async () => undefined),
    prepareRewardVideoAd: prepare,
    showRewardVideoAd: show,
    addListener: vi.fn(async (
      event: string,
      listener: (...args: never[]) => void,
    ) => {
      const callbacks = listeners.get(event) ?? new Set();
      callbacks.add(listener);
      listeners.set(event, callbacks);
      return { remove: async () => {
        if (removeStuck) {
          await new Promise<void>(() => {});
        }
        callbacks.delete(listener);
      } };
    }),
  };
  return {
    sdk: sdk as unknown as RewardedAdMobSdk,
    prepare,
    show,
    emit,
    setConsent(value: boolean, consentRequired = false) {
      canRequestAds = value;
      required = consentRequired;
    },
    setPrivacyRequired(value: boolean) {
      privacyRequired = value;
    },
    setRemoveStuck(value: boolean) {
      removeStuck = value;
    },
    listenerCount() {
      return [...listeners.values()].reduce((count, callbacks) => count + callbacks.size, 0);
    },
  };
}
