/**
 * App Store Connect in-app purchase port. The kit drives App Store Connect
 * through the pinned `asc` CLI (docs/NATIVE_DEPLOY_TOOLING_DECISION.md);
 * `app-store-iap-asc.ts` implements this port with it, and the planner and
 * tests see only these shapes.
 *
 * Resources (App Store Connect API 4.4.1):
 * - In-app purchases v2: https://developer.apple.com/documentation/appstoreconnectapi/in-app-purchases
 * - Versions and their localizations: https://developer.apple.com/documentation/appstoreconnectapi/in-app-purchase-versions
 * - Price schedules: https://developer.apple.com/documentation/appstoreconnectapi/post-v1-inapppurchasepriceschedules
 * - Availability: https://developer.apple.com/documentation/appstoreconnectapi/post-v1-inapppurchaseavailabilities
 * - Review screenshot: https://developer.apple.com/documentation/appstoreconnectapi/post-v1-inapppurchaseappstorereviewscreenshots
 */

export type AscIapType = 'CONSUMABLE' | 'NON_CONSUMABLE';

export interface AscIap {
  readonly id: string;
  readonly productId: string;
  /** Reference name. */
  readonly name: string;
  readonly inAppPurchaseType: string;
  /** `InAppPurchaseState`, for example `MISSING_METADATA` or `APPROVED`. */
  readonly state?: string | undefined;
  readonly familySharable?: boolean | undefined;
  readonly reviewNote?: string | undefined;
}

export interface AscIapVersion {
  readonly id: string;
  readonly version?: number | undefined;
  /** `PREPARE_FOR_SUBMISSION`, `READY_FOR_REVIEW`, `WAITING_FOR_REVIEW`, `APPROVED`, ... */
  readonly state?: string | undefined;
}

export interface AscIapLocalization {
  readonly id: string;
  readonly locale: string;
  readonly name: string;
  readonly description?: string | undefined;
}

/** The current price schedule: base territory and the manual prices in effect. */
export interface AscIapPriceSchedule {
  readonly id: string;
  readonly baseTerritory?: string | undefined;
  /** Manual (not equalized) prices in effect now, per alpha-3 territory. */
  readonly manualPrices: readonly { readonly territory: string; readonly customerPrice: string }[];
}

export interface AscIapReviewScreenshot {
  readonly id: string;
  readonly fileName?: string | undefined;
  readonly fileSize?: number | undefined;
  /** MD5 of the uploaded file, as App Store Connect records it. */
  readonly sourceFileChecksum?: string | undefined;
}

export interface AscIapPort {
  /** The app record's bundle ID (`apps view`). */
  readAppBundleId(appId: string): Promise<string>;
  listIaps(appId: string): Promise<AscIap[]>;
  listVersions(iapId: string): Promise<AscIapVersion[]>;
  listLocalizations(versionId: string): Promise<AscIapLocalization[]>;
  /** `undefined` when the in-app purchase has no price schedule yet. */
  readPriceSchedule(iapId: string): Promise<AscIapPriceSchedule | undefined>;
  /** `undefined` when no review screenshot was uploaded. */
  readReviewScreenshot(iapId: string): Promise<AscIapReviewScreenshot | undefined>;
  /** Every App Store territory (alpha-3). */
  listTerritories(): Promise<string[]>;

  createIap(input: {
    readonly appId: string;
    readonly type: AscIapType;
    readonly referenceName: string;
    readonly productId: string;
    readonly familySharable: boolean;
  }): Promise<string>;
  updateIap(input: {
    readonly iapId: string;
    readonly referenceName?: string;
    readonly familySharable?: true;
  }): Promise<void>;
  createVersion(iapId: string): Promise<string>;
  createLocalization(input: {
    readonly versionId: string;
    readonly locale: string;
    readonly name: string;
    readonly description: string;
  }): Promise<void>;
  updateLocalization(input: {
    readonly localizationId: string;
    readonly name: string;
    readonly description: string;
  }): Promise<void>;
  /** The price point of `customerPrice` in `territory`; throws unless exactly one matches. */
  findPricePoint(input: {
    readonly iapId: string;
    readonly territory: string;
    readonly customerPrice: string;
  }): Promise<string>;
  /** A new schedule effective now: the base territory's and the manual prices. */
  createPriceSchedule(input: {
    readonly iapId: string;
    readonly baseTerritory: string;
    readonly pricePointIds: readonly string[];
  }): Promise<void>;
  setAvailability(input: {
    readonly iapId: string;
    readonly territories: readonly string[];
    readonly availableInNewTerritories: boolean;
  }): Promise<void>;
  deleteReviewScreenshot(screenshotId: string): Promise<void>;
  uploadReviewScreenshot(input: { readonly iapId: string; readonly file: string }): Promise<void>;
}
