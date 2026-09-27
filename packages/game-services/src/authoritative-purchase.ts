import type { PurchaseResult } from '@mpgd/platform';

/**
 * Internal: the Microsoft Store adapter completes the ledger grant before it returns this
 * checkout result, so no further backend verification is requested for it.
 */
export function isAuthoritativeMicrosoftStoreCompletion(
  target: string,
  purchase: PurchaseResult,
): purchase is PurchaseResult & { readonly status: 'completed'; readonly transactionId: string } {
  return target === 'microsoft-store'
    && purchase.status === 'completed'
    && purchase.transactionId !== undefined
    && purchase.authoritativeGrant?.ledgerEntryId === purchase.transactionId;
}
