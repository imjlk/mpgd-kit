/** Provider IDs describe the destination/store, not the device OS. Open string permits new hosts. */
export interface ReviewCapabilities {
  readonly providerId: string;
  readonly nativePrompt: boolean;
  readonly reviewPage: boolean;
}
export type ReviewOutcome =
  | { readonly status: 'requested' }
  | { readonly status: 'opened' }
  | { readonly status: 'unavailable' }
  | { readonly status: 'failed' };
/** No outcome asserts that a prompt appeared, a rating was chosen or a review was submitted. */
export interface ReviewProvider {
  getCapabilities(): ReviewCapabilities;
  requestNative(): Promise<ReviewOutcome>;
  /** Explicit user action only. Never a fallback for a native request that silently did nothing. */
  openPage(): Promise<ReviewOutcome>;
}
