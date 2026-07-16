export const googlePlayProductPurchaseConformanceEvidence = Object.freeze({
  schema: 'google-play.product-purchase.v2',
  payload: Object.freeze({
    purchaseToken: 'google-play-conformance-token',
  }),
});

export interface CreateGooglePlayProductPurchaseConformanceFixtureInput {
  readonly productId?: string;
  readonly orderId?: string;
  readonly purchaseState?: 'PURCHASED' | 'CANCELLED' | 'PENDING';
  readonly purchaseCompletionTime?: string;
  readonly consumptionState?:
    | 'CONSUMPTION_STATE_YET_TO_BE_CONSUMED'
    | 'CONSUMPTION_STATE_CONSUMED';
  readonly acknowledgementState?:
    | 'ACKNOWLEDGEMENT_STATE_PENDING'
    | 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED';
  readonly quantity?: number;
  readonly refundableQuantity?: number;
  readonly obfuscatedExternalAccountId?: string;
}

/**
 * Builds a deterministic `purchases.productsv2` response for boundary and
 * provider-client conformance tests. It intentionally contains no credentials,
 * live purchase tokens, or environment-specific endpoints.
 */
export function createGooglePlayProductPurchaseConformanceFixture(
  input: CreateGooglePlayProductPurchaseConformanceFixtureInput = {},
): Readonly<Record<string, unknown>> {
  return {
    productLineItem: [
      {
        productId: input.productId ?? 'coins_100_android',
        productOfferDetails: {
          quantity: input.quantity ?? 1,
          refundableQuantity: input.refundableQuantity ?? 1,
          consumptionState:
            input.consumptionState ?? 'CONSUMPTION_STATE_YET_TO_BE_CONSUMED',
        },
      },
    ],
    purchaseStateContext: {
      purchaseState: input.purchaseState ?? 'PURCHASED',
    },
    orderId: input.orderId ?? 'GPA.conformance-1',
    purchaseCompletionTime:
      input.purchaseCompletionTime ?? '2030-01-02T03:04:05.000Z',
    acknowledgementState:
      input.acknowledgementState ?? 'ACKNOWLEDGEMENT_STATE_PENDING',
    ...(input.obfuscatedExternalAccountId === undefined
      ? {}
      : { obfuscatedExternalAccountId: input.obfuscatedExternalAccountId }),
  };
}
