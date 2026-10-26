import type { PlatformGateway } from './index.js';
import type { ReviewCapabilities, ReviewOutcome, ReviewProvider } from './reviews-contract.js';
export type { ReviewCapabilities, ReviewOutcome, ReviewProvider } from './reviews-contract.js';

export function createReviewProvider(input: {
  readonly providerId: string;
  readonly isAvailable?: () => boolean;
  readonly requestNative?: () => Promise<void>;
  readonly openPage?: () => Promise<boolean>;
}): ReviewProvider {
  if (!/^[a-z][a-z0-9.-]{0,63}$/.test(input.providerId)) {
    throw new TypeError('Invalid review provider ID');
  }
  const available = () => {
    try {
      return input.isAvailable?.() ?? true;
    } catch {
      return false;
    }
  };
  return {
    getCapabilities(): ReviewCapabilities {
      const ready = available();
      return {
        providerId: input.providerId,
        nativePrompt: ready && !!input.requestNative,
        reviewPage: ready && !!input.openPage,
      };
    },
    async requestNative(): Promise<ReviewOutcome> {
      if (!available() || !input.requestNative) {
        return { status: 'unavailable' };
      }
      try {
        await input.requestNative();
        return { status: 'requested' };
      } catch {
        return { status: 'failed' };
      }
    },
    async openPage(): Promise<ReviewOutcome> {
      if (!available() || !input.openPage) {
        return { status: 'unavailable' };
      }
      try {
        return { status: await input.openPage() ? 'opened' : 'failed' };
      } catch {
        return { status: 'failed' };
      }
    },
  };
}
export function createUnsupportedReviewProvider(providerId: string): ReviewProvider {
  return createReviewProvider({ providerId });
}
/** Compose at the target boundary; no native plugin enters the generic gateway import. */
export function withReviewProvider(gateway: PlatformGateway, reviews: ReviewProvider): PlatformGateway {
  return {
    ...gateway,
    reviews,
    async getCapabilities() {
      return { ...await gateway.getCapabilities(), reviews: reviews.getCapabilities() };
    },
  };
}
