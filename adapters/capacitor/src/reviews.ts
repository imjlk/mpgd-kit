import { Capacitor } from '@capacitor/core';
import { AppReview } from '@capawesome/capacitor-app-review';
import { createReviewProvider, type ReviewProvider } from '@mpgd/platform/reviews';

export interface CapacitorReviewInput {
  /** Mandatory distribution identity. Android alone must never imply Google Play. */
  readonly store: 'google-play' | 'apple-app-store';
  readonly appId?: string;
}
export function createCapacitorReviewProvider(
  input: CapacitorReviewInput,
  host: Pick<typeof Capacitor, 'isNativePlatform' | 'isPluginAvailable' | 'getPlatform'> = Capacitor,
  plugin = AppReview,
): ReviewProvider {
  if (input.store !== 'google-play' && input.store !== 'apple-app-store') {
    throw new TypeError('Unsupported review store');
  }
  const matches = () => host.isNativePlatform() && host.isPluginAvailable('AppReview')
    && host.getPlatform() === (input.store === 'google-play' ? 'android' : 'ios');
  return createReviewProvider({
    providerId: input.store,
    isAvailable: matches,
    requestNative: () => plugin.requestReview(),
    // iOS listing navigation requires its registered Apple ID; never guess from bundleId.
    ...(input.store === 'google-play' || input.appId && /^\d+$/.test(input.appId) ? {
      openPage: async () => {
        await plugin.openAppStore(input.store === 'apple-app-store' && input.appId ? { appId: input.appId } : undefined);
        return true;
      },
    } : {}),
  });
}
