/**
 * Google Play store listing port (Android Publisher v3 edits: `edits.details`,
 * `edits.listings`, `edits.images`). The Google SDK lives under
 * adapters/play-publisher; the CLI sees only these shapes.
 *
 * - Edits: https://developers.google.com/android-publisher/edits
 * - Listings: https://developers.google.com/android-publisher/api-ref/rest/v3/edits.listings
 * - Images: https://developers.google.com/android-publisher/api-ref/rest/v3/edits.images
 * - Details: https://developers.google.com/android-publisher/api-ref/rest/v3/edits.details
 * - Commit: https://developers.google.com/android-publisher/api-ref/rest/v3/edits/commit
 */

/** `AppDetails`. */
export interface PlayAppDetails {
  readonly defaultLanguage?: string | null | undefined;
  readonly contactEmail?: string | null | undefined;
  readonly contactPhone?: string | null | undefined;
  readonly contactWebsite?: string | null | undefined;
}

/** `Listing`: one language of the main store listing. */
export interface PlayListing {
  readonly language?: string | null | undefined;
  readonly title?: string | null | undefined;
  readonly shortDescription?: string | null | undefined;
  readonly fullDescription?: string | null | undefined;
  /** YouTube URL of the promo video. */
  readonly video?: string | null | undefined;
}

/** `Image`. */
export interface PlayImage {
  readonly id?: string | null | undefined;
  readonly url?: string | null | undefined;
  readonly sha1?: string | null | undefined;
  readonly sha256?: string | null | undefined;
}

/** The `AppImageType` values the store presence sync manages. */
export type PlayImageType =
  | 'icon'
  | 'featureGraphic'
  | 'phoneScreenshots'
  | 'sevenInchScreenshots'
  | 'tenInchScreenshots';

export interface PlayImageTarget {
  readonly packageName: string;
  readonly editId: string;
  readonly language: string;
  readonly imageType: PlayImageType;
  readonly signal?: AbortSignal;
}

export interface PlayStoreListingPort {
  /** `edits.insert`. A new edit invalidates the caller's other open edit. */
  insertEdit(packageName: string, signal?: AbortSignal): Promise<string>;
  /** `edits.delete`: discards an uncommitted edit. */
  deleteEdit(packageName: string, editId: string, signal?: AbortSignal): Promise<void>;
  /**
   * `edits.commit` with `changesInReviewBehavior=ERROR_IF_IN_REVIEW`, and
   * `changesNotSentForReview` when asked.
   */
  commitEdit(input: {
    readonly packageName: string;
    readonly editId: string;
    readonly changesNotSentForReview: boolean;
    readonly signal?: AbortSignal;
  }): Promise<void>;
  getDetails(packageName: string, editId: string, signal?: AbortSignal): Promise<PlayAppDetails>;
  /** `edits.details.update` with the whole object. */
  updateDetails(input: {
    readonly packageName: string;
    readonly editId: string;
    readonly details: PlayAppDetails;
    readonly signal?: AbortSignal;
  }): Promise<void>;
  /** `edits.listings.list`: every language. */
  listListings(packageName: string, editId: string, signal?: AbortSignal): Promise<PlayListing[]>;
  /** `edits.listings.update`: creates or replaces one language. */
  updateListing(input: {
    readonly packageName: string;
    readonly editId: string;
    readonly listing: PlayListing & { readonly language: string };
    readonly signal?: AbortSignal;
  }): Promise<void>;
  /** `edits.images.list`, in the order Play shows them. */
  listImages(input: PlayImageTarget): Promise<PlayImage[]>;
  /** `edits.images.upload`: adds one image after the ones the slot holds. */
  uploadImage(input: PlayImageTarget & {
    readonly file: string;
    readonly mimeType: 'image/png' | 'image/jpeg';
    readonly timeoutMs: number;
  }): Promise<PlayImage>;
  /** `edits.images.deleteall`. */
  deleteAllImages(input: PlayImageTarget): Promise<void>;
}
