import {
  createReviewProvider,
  createUnsupportedReviewProvider,
  type ReviewProvider,
} from '@mpgd/platform/reviews';

export interface ReviewPageInput {
  readonly providerId: string;
  /** Game-owned registered listing, never constructed from a user-supplied title or room link. */
  readonly url: string;
  readonly allowedOrigins: readonly string[];
  /** Host-specific navigation; must run from an explicit user click. */
  readonly open: (url: string) => boolean | Promise<boolean>;
}
export function createReviewPageProvider(input: ReviewPageInput): ReviewProvider {
  const url = new URL(input.url);
  if (url.protocol !== 'https:' || url.username || url.password || !input.allowedOrigins.includes(url.origin)) {
    throw new TypeError('Unapproved review page');
  }
  return createReviewProvider({
    providerId: input.providerId,
    openPage: async () => input.open(url.href),
  });
}
export function createMicrosoftReviewProvider(input: {
  readonly productId: string;
  readonly open: (url: string) => boolean | Promise<boolean>;
  readonly isAvailable: () => boolean;
}): ReviewProvider {
  if (!/^[A-Z0-9]{12}$/.test(input.productId)) {
    throw new TypeError('Invalid Microsoft Store product ID');
  }
  return createReviewProvider({
    providerId: 'microsoft-store',
    isAvailable: input.isAvailable,
    openPage: async () => input.open(`ms-windows-store://review/?ProductId=${input.productId}`),
  });
}
/** No published ONE store H5 review prompt API: explicit approved listing navigation only. */
export function createOneStoreReviewProvider(input?: Omit<ReviewPageInput, 'providerId'>): ReviewProvider {
  return input
    ? createReviewPageProvider({ ...input, providerId: 'onestore' })
    : createUnsupportedReviewProvider('onestore');
}
/** Do not send players to a review of the Verse8 host app instead of their actual game. */
export function createVerse8ReviewProvider(input?: Omit<ReviewPageInput, 'providerId'>): ReviewProvider {
  return input
    ? createReviewPageProvider({ ...input, providerId: 'verse8' })
    : createUnsupportedReviewProvider('verse8');
}
