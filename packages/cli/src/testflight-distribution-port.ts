/**
 * The App Store Connect operations TestFlight distribution needs, as data the
 * planner can compare. `testflight-distribution-asc.ts` implements it on the
 * pinned `asc` 5.5.0; the tests use an in-memory fake.
 */

export interface TestFlightBuild {
  readonly id: string;
  /** App Store Connect `Build.processingState`: PROCESSING, FAILED, INVALID or VALID. */
  readonly processingState: string;
}

export interface TestFlightGroup {
  readonly id: string;
  readonly name: string;
  readonly isInternal: boolean;
}

/** App Store Connect `BuildBetaDetail` states (`InternalBetaState`, `ExternalBetaState`). */
export interface TestFlightBuildBetaState {
  readonly internalBuildState: string;
  readonly externalBuildState: string;
}

/** One `BetaBuildLocalization`: the build's "What to Test" text in one locale. */
export interface TestFlightWhatToTest {
  readonly id: string;
  readonly locale: string;
  readonly whatsNew?: string;
}

/** The app's `BetaAppReviewDetail`; asc never prints the demo account password. */
export interface TestFlightBetaReviewDetail {
  readonly id: string;
  readonly contactFirstName?: string;
  readonly contactLastName?: string;
  readonly contactEmail?: string;
  readonly contactPhone?: string;
  readonly notes?: string;
  readonly demoAccountName?: string;
  /** asc 5.5.0 replaces a stored password with a placeholder; only its presence is known. */
  readonly demoAccountPasswordSet: boolean;
  readonly demoAccountRequired: boolean;
}

export interface TestFlightBetaReviewDetailChanges {
  readonly contactFirstName?: string;
  readonly contactLastName?: string;
  readonly contactEmail?: string;
  readonly contactPhone?: string;
  readonly notes?: string;
  readonly demoAccountName?: string;
  readonly demoAccountPassword?: string;
  readonly demoAccountRequired?: boolean;
}

/** A `BetaAppReviewSubmission`; `betaReviewState` is a `BetaReviewState`. */
export interface TestFlightBetaReviewSubmission {
  readonly id: string;
  readonly betaReviewState: string;
  readonly submittedDate?: string;
}

export interface TestFlightDistributionPort {
  readAppBundleId(appId: string): Promise<string>;
  /** The build with this marketing version and build number, if App Store Connect has it. */
  findBuild(appId: string, marketingVersion: string, buildNumber: string): Promise<TestFlightBuild | undefined>;
  listGroups(appId: string): Promise<readonly TestFlightGroup[]>;
  readBuildBetaState(buildId: string): Promise<TestFlightBuildBetaState>;
  /** IDs of the groups that contain the build; throws when the lookup is incomplete. */
  listBuildGroupIds(appId: string, buildId: string): Promise<readonly string[]>;
  /** Adds the build to these groups; never submits it for review. */
  addBuildToGroups(buildId: string, groupIds: readonly string[]): Promise<void>;
  listWhatToTest(buildId: string): Promise<readonly TestFlightWhatToTest[]>;
  /** Creates or updates the "What to Test" text of one locale. */
  putWhatToTest(buildId: string, locale: string, text: string): Promise<void>;
  readBetaReviewDetail(appId: string): Promise<TestFlightBetaReviewDetail>;
  updateBetaReviewDetail(detailId: string, changes: TestFlightBetaReviewDetailChanges): Promise<void>;
  listBetaReviewSubmissions(buildId: string): Promise<readonly TestFlightBetaReviewSubmission[]>;
  submitForBetaReview(buildId: string): Promise<TestFlightBetaReviewSubmission>;
}
