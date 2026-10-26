import { Review } from '@apps-in-toss/web-framework';
import { createReviewProvider, type ReviewProvider } from '@mpgd/platform/reviews';

export interface AitReviewSdk {
  readonly request: () => Promise<void>;
  readonly isSupported: () => boolean;
}
export function createAitReviewProvider(sdk: AitReviewSdk = {
  request: () => Review.request(),
  isSupported: () => Review.request.isSupported(),
}): ReviewProvider {
  return createReviewProvider({
    providerId: 'apps-in-toss',
    isAvailable: () => sdk.isSupported(),
    requestNative: () => sdk.request(),
  });
}
