/**
 * App Store Connect store page port: app information localizations (name,
 * subtitle, privacy policy URL), App Store version localizations (description,
 * keywords, promotional text, what's new, URLs) and their screenshot sets.
 * `app-store-presence-asc.ts` implements it with the pinned `asc` CLI; the
 * planner and tests see only these shapes.
 *
 * Resources (App Store Connect API):
 * - App infos and their localizations: https://developer.apple.com/documentation/appstoreconnectapi/app-infos
 * - App Store versions and their localizations: https://developer.apple.com/documentation/appstoreconnectapi/app-store-versions
 * - Screenshot sets and screenshots: https://developer.apple.com/documentation/appstoreconnectapi/app-screenshot-sets
 */

export interface AscAppInfo {
  readonly id: string;
  /** `AppInfoState` (`state`, or the older `appStoreState`), for example `PREPARE_FOR_SUBMISSION`. */
  readonly state?: string | undefined;
}

export interface AscAppInfoLocalization {
  readonly id: string;
  readonly locale: string;
  readonly name?: string | undefined;
  readonly subtitle?: string | undefined;
  readonly privacyPolicyUrl?: string | undefined;
}

export interface AscAppStoreVersion {
  readonly id: string;
  readonly versionString?: string | undefined;
  /** `appVersionState`, or `appStoreState` when App Store Connect sends only that. */
  readonly state?: string | undefined;
  /** The legacy `appStoreState`; App Store Connect fills the two inconsistently. */
  readonly appStoreState?: string | undefined;
  readonly createdDate?: string | undefined;
}

/** The version localization fields the sync writes. */
export interface AscVersionLocalizationFields {
  readonly description?: string | undefined;
  readonly keywords?: string | undefined;
  readonly promotionalText?: string | undefined;
  readonly whatsNew?: string | undefined;
  readonly supportUrl?: string | undefined;
  readonly marketingUrl?: string | undefined;
}

export interface AscVersionLocalization extends AscVersionLocalizationFields {
  readonly id: string;
  readonly locale: string;
}

export interface AscScreenshot {
  readonly id: string;
  readonly fileName?: string | undefined;
  /** MD5 of the uploaded file, as App Store Connect records it. */
  readonly sourceFileChecksum?: string | undefined;
  /** `assetDeliveryState.state`: `AWAITING_UPLOAD`, `UPLOAD_COMPLETE`, `COMPLETE` or `FAILED`. */
  readonly deliveryState?: string | undefined;
}

export interface AscScreenshotSet {
  readonly id: string;
  /** `screenshotDisplayType`, for example `APP_IPHONE_67`. */
  readonly displayType: string;
  /** In the set's order. */
  readonly screenshots: readonly AscScreenshot[];
}

export interface AscStorePresencePort {
  /** The app record's bundle ID (`apps view`). */
  readAppBundleId(appId: string): Promise<string>;
  listAppInfos(appId: string): Promise<AscAppInfo[]>;
  listAppInfoLocalizations(appId: string, appInfoId: string): Promise<AscAppInfoLocalization[]>;
  /** iOS App Store versions of the app. */
  listVersions(appId: string): Promise<AscAppStoreVersion[]>;
  listVersionLocalizations(versionId: string): Promise<AscVersionLocalization[]>;
  listScreenshotSets(versionLocalizationId: string): Promise<AscScreenshotSet[]>;

  /** Creates the locale's app information localization or updates it. */
  upsertAppInfoLocalization(input: {
    readonly appId: string;
    readonly appInfoId: string;
    readonly locale: string;
    readonly name: string;
    readonly subtitle?: string;
    readonly privacyPolicyUrl?: string;
  }): Promise<void>;
  /** Returns the new localization's ID. */
  createVersionLocalization(input: {
    readonly versionId: string;
    readonly locale: string;
    readonly fields: AscVersionLocalizationFields;
  }): Promise<string>;
  updateVersionLocalization(input: {
    readonly localizationId: string;
    readonly fields: AscVersionLocalizationFields;
  }): Promise<void>;
  /**
   * Appends one screenshot to the set of `displayType` (creating the set),
   * waiting until App Store Connect reports the asset delivered. Throws when
   * the delivery fails.
   */
  uploadScreenshot(input: {
    readonly versionLocalizationId: string;
    readonly displayType: string;
    readonly file: string;
  }): Promise<AscScreenshot>;
  deleteScreenshot(screenshotId: string): Promise<void>;
}
