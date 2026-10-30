/**
 * App Store Connect release port: the App Store version, its build, App
 * Review information, release options, the age rating declaration and the
 * review submission. `app-store-release-asc.ts` implements it with the
 * pinned `asc` CLI; the planner and tests see only these shapes. The store
 * page reads and the version localization writes come from
 * `app-store-presence-port.ts`, and the in-app purchase reads from
 * `app-store-iap-port.ts`.
 *
 * Resources (App Store Connect API, read 2026-10-31):
 * - App Store versions: https://developer.apple.com/documentation/appstoreconnectapi/appstoreversion
 *   (`releaseType` MANUAL, AFTER_APPROVAL or SCHEDULED; `earliestReleaseDate`; `copyright`)
 * - The version's build: https://developer.apple.com/documentation/appstoreconnectapi/patch-v1-appstoreversions-_id_-relationships-build
 * - Builds: https://developer.apple.com/documentation/appstoreconnectapi/build
 *   (`processingState` PROCESSING, FAILED, INVALID or VALID; `usesNonExemptEncryption`)
 * - App Review information: https://developer.apple.com/documentation/appstoreconnectapi/post-v1-appstorereviewdetails
 * - Phased release: https://developer.apple.com/documentation/appstoreconnectapi/post-v1-appstoreversionphasedreleases
 *   (`PhasedReleaseState` INACTIVE, ACTIVE, PAUSED or COMPLETE)
 * - Review submissions: https://developer.apple.com/documentation/appstoreconnectapi/post-v1-reviewsubmissions,
 *   their items https://developer.apple.com/documentation/appstoreconnectapi/post-v1-reviewsubmissionitems,
 *   and submitting one https://developer.apple.com/documentation/appstoreconnectapi/patch-v1-reviewsubmissions-_id_
 * - Manual release: https://developer.apple.com/documentation/appstoreconnectapi/post-v1-appstoreversionreleaserequests
 */

export type AscReleaseType = 'MANUAL' | 'AFTER_APPROVAL' | 'SCHEDULED';

export interface AscReleaseApp {
  readonly bundleId: string;
  /** The app's primary language, for example `en-US`. */
  readonly primaryLocale?: string | undefined;
}

export interface AscReleaseVersion {
  readonly id: string;
  readonly versionString: string;
  /** `appVersionState`, or `appStoreState` when App Store Connect sends only that. */
  readonly state?: string | undefined;
  /** The legacy `appStoreState`. */
  readonly appStoreState?: string | undefined;
  readonly releaseType?: string | undefined;
  readonly earliestReleaseDate?: string | undefined;
  readonly copyright?: string | undefined;
  readonly createdDate?: string | undefined;
}

export interface AscReleaseBuild {
  readonly id: string;
  /** The build number (`CFBundleVersion`). */
  readonly buildNumber: string;
  readonly processingState?: string | undefined;
  readonly expired?: boolean | undefined;
  /** `undefined` while App Store Connect waits for the export compliance answer. */
  readonly usesNonExemptEncryption?: boolean | undefined;
  readonly uploadedDate?: string | undefined;
}

export interface AscReviewDetail {
  readonly id: string;
  readonly contactFirstName?: string | undefined;
  readonly contactLastName?: string | undefined;
  readonly contactEmail?: string | undefined;
  readonly contactPhone?: string | undefined;
  readonly demoAccountName?: string | undefined;
  /** asc withholds the password; only whether one is set is known. */
  readonly demoAccountPasswordSet: boolean;
  readonly demoAccountRequired: boolean;
  readonly notes?: string | undefined;
}

/** The fields a review detail write sends; a field left out stays as it is. */
export interface AscReviewDetailWrite {
  readonly contactFirstName?: string;
  readonly contactLastName?: string;
  readonly contactEmail?: string;
  readonly contactPhone?: string;
  readonly notes?: string;
  readonly demoAccountRequired?: boolean;
  readonly demoAccountName?: string;
  readonly demoAccountPassword?: string;
}

export interface AscPhasedRelease {
  readonly id: string;
  /** INACTIVE, ACTIVE, PAUSED or COMPLETE. */
  readonly state: string;
  readonly currentDayNumber?: number | undefined;
  readonly startDate?: string | undefined;
}

export interface AscAgeRating {
  readonly id: string;
  /** The answered content descriptors, by attribute name. */
  readonly answered: readonly string[];
}

export interface AscReviewSubmission {
  readonly id: string;
  /** READY_FOR_REVIEW, WAITING_FOR_REVIEW, IN_REVIEW, UNRESOLVED_ISSUES, CANCELING, COMPLETING or COMPLETE. */
  readonly state: string;
  readonly submittedDate?: string | undefined;
}

export interface AscReviewSubmissionItem {
  readonly id: string;
  /** READY_FOR_REVIEW, ACCEPTED, APPROVED, REJECTED or REMOVED. */
  readonly state?: string | undefined;
  readonly appStoreVersionId?: string | undefined;
  readonly inAppPurchaseVersionId?: string | undefined;
}

export type AscReviewItemType = 'appStoreVersions' | 'inAppPurchaseVersions';

export interface AscReleasePort {
  readApp(appId: string): Promise<AscReleaseApp>;
  /** iOS App Store versions of the app, with their release options. */
  listVersions(appId: string): Promise<AscReleaseVersion[]>;
  /** iOS builds of one marketing version, optionally one build number. */
  listBuilds(input: {
    readonly appId: string;
    readonly marketingVersion: string;
    readonly buildNumber?: string;
  }): Promise<AscReleaseBuild[]>;
  /** The build attached to the version, if any. */
  readAttachedBuild(versionId: string): Promise<{ readonly id: string; readonly buildNumber?: string } | undefined>;
  /** `undefined` when the version has no App Review information yet. */
  readReviewDetail(versionId: string): Promise<AscReviewDetail | undefined>;
  /** `undefined` when the version has no phased release. */
  readPhasedRelease(versionId: string): Promise<AscPhasedRelease | undefined>;
  /** The age rating declaration of an app information record. */
  readAgeRating(appInfoId: string): Promise<AscAgeRating | undefined>;
  /** iOS review submissions of the app, every state. */
  listReviewSubmissions(appId: string): Promise<AscReviewSubmission[]>;
  listReviewSubmissionItems(submissionId: string): Promise<AscReviewSubmissionItem[]>;

  /** Returns the new version's ID. */
  createVersion(input: {
    readonly appId: string;
    readonly versionString: string;
    readonly releaseType: AscReleaseType;
    readonly copyright?: string;
  }): Promise<string>;
  updateVersion(input: {
    readonly versionId: string;
    readonly versionString?: string;
    readonly copyright?: string;
    readonly releaseType?: AscReleaseType;
    readonly earliestReleaseDate?: string;
  }): Promise<void>;
  attachBuild(input: { readonly versionId: string; readonly buildId: string }): Promise<void>;
  createReviewDetail(input: { readonly versionId: string; readonly fields: AscReviewDetailWrite }): Promise<void>;
  updateReviewDetail(input: { readonly detailId: string; readonly fields: AscReviewDetailWrite }): Promise<void>;
  /** A new phased release in INACTIVE: it starts when the version is released. */
  createPhasedRelease(versionId: string): Promise<void>;
  deletePhasedRelease(phasedReleaseId: string): Promise<void>;
  updatePhasedRelease(input: {
    readonly phasedReleaseId: string;
    readonly state: 'ACTIVE' | 'PAUSED' | 'COMPLETE';
  }): Promise<void>;
  /** Returns the new submission's ID. */
  createReviewSubmission(appId: string): Promise<string>;
  addReviewSubmissionItem(input: {
    readonly submissionId: string;
    readonly type: AscReviewItemType;
    readonly id: string;
  }): Promise<void>;
  submitReviewSubmission(submissionId: string): Promise<void>;
  /** Releases a version in PENDING_DEVELOPER_RELEASE. */
  releaseVersion(versionId: string): Promise<void>;
}
