/**
 * Stable diagnostic codes for Apps in Toss in-app purchases.
 *
 * The host bridge attaches one of these codes to a non-completed
 * `PurchaseResult.diagnostic`, a partial `PurchaseRestoreResult.diagnostic`, or
 * a rejected `commerce.getProducts`/`commerce.restore` bridge call. Native SDK
 * error codes are passed through separately as `providerCode`. Codes never
 * carry order ids, player ids, tokens or other personal data.
 *
 * This module is SDK-free so game UI code can compare codes without importing
 * the Apps in Toss framework.
 */
export const aitIapDiagnosticCodes = {
  /** IAP is not configured or the running Toss app lacks a required IAP method. */
  unavailable: 'AIT_IAP_UNAVAILABLE',
  /** The requested logical product has no configured SKU mapping. */
  productNotConfigured: 'AIT_IAP_PRODUCT_NOT_CONFIGURED',
  /** The native SDK returned no value, which it does on an unsupported Toss app version. */
  unsupportedAppVersion: 'AIT_IAP_UNSUPPORTED_APP_VERSION',
  /** The native product catalog call failed or did not settle in time. */
  catalogUnavailable: 'AIT_IAP_CATALOG_UNAVAILABLE',
  /** The native product catalog is empty. */
  catalogEmpty: 'AIT_IAP_CATALOG_EMPTY',
  /** The native catalog has products, but none of the configured SKUs is usable. */
  configuredSkusNotVisible: 'AIT_IAP_CONFIGURED_SKUS_NOT_VISIBLE',
  /** The configured SKU is not a one-time (consumable or non-consumable) product. */
  productTypeUnsupported: 'AIT_IAP_PRODUCT_TYPE_UNSUPPORTED',
  /** The game-owned `prepareIap` hook rejected or did not settle in time. */
  preparationFailed: 'AIT_IAP_PREPARATION_FAILED',
  /** Pending provider orders could not be read, so no new checkout was opened. */
  pendingOrderCheckFailed: 'AIT_IAP_PENDING_ORDER_CHECK_FAILED',
  /** An earlier paid order for this product was just granted; no new checkout was opened. */
  pendingOrderRecovered: 'AIT_IAP_PENDING_ORDER_RECOVERED',
  /** A paid order is still awaiting its server grant; no new checkout was opened. */
  pendingOrderUnresolved: 'AIT_IAP_PENDING_ORDER_UNRESOLVED',
  /** The durable purchase-attempt marker could not be read or written. */
  attemptStorageUnavailable: 'AIT_IAP_ATTEMPT_STORAGE_UNAVAILABLE',
  /** The same client purchase key already has an unfinished attempt. */
  attemptPending: 'AIT_IAP_ATTEMPT_PENDING',
  /** Another purchase is still between its pending-order check and checkout result. */
  checkoutInProgress: 'AIT_IAP_CHECKOUT_IN_PROGRESS',
  /** The native checkout could not be opened. */
  checkoutStartFailed: 'AIT_IAP_CHECKOUT_START_FAILED',
  /** The native checkout did not report a terminal result in time. */
  checkoutTimeout: 'AIT_IAP_CHECKOUT_TIMEOUT',
  /** The native checkout reported an error before an order was observed. */
  nativePurchaseFailed: 'AIT_IAP_NATIVE_PURCHASE_FAILED',
  /** A provider order exists but the game server has not confirmed its grant. */
  grantPending: 'AIT_IAP_GRANT_PENDING',
  /** The server grant succeeded but the native acknowledgement failed or was not observed. */
  grantCompletionFailed: 'AIT_IAP_GRANT_COMPLETION_FAILED',
  /** The game-owned entitlement reader failed or did not settle in time. */
  entitlementReadFailed: 'AIT_IAP_ENTITLEMENT_READ_FAILED',
  /** Restore ran out of time before reconciling pending orders. */
  restoreTimeout: 'AIT_IAP_RESTORE_TIMEOUT',
} as const;

export type AitIapDiagnosticCode =
  typeof aitIapDiagnosticCodes[keyof typeof aitIapDiagnosticCodes];

/** Native error code the SDK reports after a checkout whose grant callback returned false. */
export const aitIapProductNotGrantedByPartnerCode = 'PRODUCT_NOT_GRANTED_BY_PARTNER';
