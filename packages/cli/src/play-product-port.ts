/**
 * Google Play one-time product port (Android Publisher v3
 * `monetization.onetimeproducts`). The Google SDK lives under
 * adapters/play-publisher; the CLI sees only these shapes.
 * https://developers.google.com/android-publisher/api-ref/rest/v3/monetization.onetimeproducts
 */

/** `Money`: whole `units` as a decimal string and `nanos` (10^-9 units). */
export interface PlayMoney {
  readonly currencyCode?: string | null | undefined;
  readonly units?: string | null | undefined;
  readonly nanos?: number | null | undefined;
}

export interface PlayOneTimeProductListing {
  readonly languageCode?: string | null | undefined;
  readonly title?: string | null | undefined;
  readonly description?: string | null | undefined;
}

export interface PlayRegionalPricingConfig {
  readonly regionCode?: string | null | undefined;
  readonly price?: PlayMoney | undefined;
  /** `AVAILABLE`, `NO_LONGER_AVAILABLE`, `AVAILABLE_IF_RELEASED`, `AVAILABLE_FOR_OFFERS_ONLY`. */
  readonly availability?: string | null | undefined;
}

export interface PlayNewRegionsConfig {
  readonly usdPrice?: PlayMoney | undefined;
  readonly eurPrice?: PlayMoney | undefined;
  readonly availability?: string | null | undefined;
}

export interface PlayPurchaseOption {
  readonly purchaseOptionId?: string | null | undefined;
  readonly buyOption?: {
    readonly legacyCompatible?: boolean | null | undefined;
    readonly multiQuantityEnabled?: boolean | null | undefined;
  } | undefined;
  /** A rent option; the sync never manages one. */
  readonly rentOption?: Readonly<Record<string, unknown>> | undefined;
  readonly regionalPricingAndAvailabilityConfigs?: readonly PlayRegionalPricingConfig[] | undefined;
  readonly newRegionsConfig?: PlayNewRegionsConfig | undefined;
  /** Output only: `DRAFT`, `ACTIVE`, `INACTIVE` or `INACTIVE_PUBLISHED`. */
  readonly state?: string | null | undefined;
  readonly [field: string]: unknown;
}

export interface PlayOneTimeProduct {
  readonly packageName?: string | null | undefined;
  readonly productId?: string | null | undefined;
  readonly listings?: readonly PlayOneTimeProductListing[] | undefined;
  readonly purchaseOptions?: readonly PlayPurchaseOption[] | undefined;
  readonly taxAndComplianceSettings?: {
    readonly productTaxCategoryCode?: string | null | undefined;
    readonly [field: string]: unknown;
  } | undefined;
  /** Output only. */
  readonly regionsVersion?: { readonly version?: string | null | undefined } | undefined;
  readonly [field: string]: unknown;
}

/** `monetization.convertRegionPrices` response. */
export interface PlayConvertedPrices {
  readonly convertedRegionPrices?: Readonly<Record<string, {
    readonly regionCode?: string | null | undefined;
    /** Tax inclusive. */
    readonly price?: PlayMoney | undefined;
    readonly taxAmount?: PlayMoney | undefined;
  }>> | null | undefined;
  readonly convertedOtherRegionsPrice?: {
    readonly usdPrice?: PlayMoney | undefined;
    readonly eurPrice?: PlayMoney | undefined;
  } | undefined;
  readonly regionVersion?: { readonly version?: string | null | undefined } | undefined;
}

export interface PlayProductCatalogPort {
  /** Every one-time product of the app (`onetimeproducts.list`, all pages). */
  listOneTimeProducts(packageName: string, signal?: AbortSignal): Promise<PlayOneTimeProduct[]>;
  /** Read-only price conversion (`monetization.convertRegionPrices`). */
  convertRegionPrices(input: {
    readonly packageName: string;
    readonly price: PlayMoney;
    readonly productTaxCategoryCode?: string;
    readonly signal?: AbortSignal;
  }): Promise<PlayConvertedPrices>;
  /** `onetimeproducts.patch`; `allowMissing` creates the product. */
  patchOneTimeProduct(input: {
    readonly packageName: string;
    readonly productId: string;
    readonly product: PlayOneTimeProduct;
    readonly updateMask: string;
    readonly allowMissing: boolean;
    readonly regionsVersion: string;
    readonly signal?: AbortSignal;
  }): Promise<PlayOneTimeProduct>;
  /** `onetimeproducts.purchaseOptions.batchUpdateStates` with one activate request. */
  activatePurchaseOption(input: {
    readonly packageName: string;
    readonly productId: string;
    readonly purchaseOptionId: string;
    readonly signal?: AbortSignal;
  }): Promise<void>;
}
