import { createHash } from 'node:crypto';

import type { AppStorePresence, AppStorePresenceReview, StorePresence } from '@mpgd/catalog';

import type { AscIap, AscIapPort } from './app-store-iap-port.js';
import type { AscStorePresencePort, AscVersionLocalization } from './app-store-presence-port.js';
import type {
  AscPhasedRelease,
  AscReleaseBuild,
  AscReleasePort,
  AscReleaseType,
  AscReleaseVersion,
  AscReviewDetail,
  AscReviewDetailWrite,
  AscReviewSubmission,
  AscReviewSubmissionItem,
} from './app-store-release-port.js';
import { ReleaseProcessError } from './deploy-process.js';
import {
  describeTextChange,
  normalizeLineBreaks,
  type StorePresenceTextChange,
} from './store-presence.js';
import { stableSha256, StorePlanStaleError } from './store-sync.js';

/**
 * App Store Connect release: everything between "the build is in
 * TestFlight" and "the version is submitted for review", planned from App
 * Store Connect and the game files, then applied step by step.
 *
 * The plan reads; apply re-plans, refuses when App Store Connect or the
 * files moved past the reviewed plan, and writes in a fixed order: the
 * version (created or renamed, then its copyright and release options), its
 * build, What's New, App Review information, the phased release, the review
 * submission with the version and the in-app purchases that go with it, and
 * the submission itself. App Store Connect has no transaction: a failed
 * apply names the steps already written, and a new plan lists what is left.
 *
 * A version that does not exist yet is created alone: App Store Connect
 * then needs its store page (`mpgd store presence apply`) before anything
 * else can be checked, so the next plan picks up from there.
 */

export const appStoreReleasePlanCommand = 'mpgd store release plan';

export type AppStoreReleaseStage = 'create-version' | 'prepare' | 'submitted' | 'approved';

export interface AppStoreReleaseRequest {
  /** The marketing version (`CFBundleShortVersionString`) to submit. */
  readonly marketingVersion: string;
  /** The build number; without it, the newest build of the version. */
  readonly buildNumber?: string;
  /** The App Store Connect build `deploy run` recorded for this build, when known. */
  readonly recordedBuildId?: string;
  /** The iOS app runs on iPad too: App Review needs 13-inch iPad screenshots. */
  readonly universal: boolean;
  readonly releaseType: AscReleaseType;
  /** ISO 8601 date-time; required for, and only for, SCHEDULED. */
  readonly earliestReleaseDate?: string;
  readonly phasedRelease: boolean;
  /** In-app purchase product IDs deliberately left out of this submission. */
  readonly skipIaps: readonly string[];
  /** Send the demo account password again even when App Store Connect has one. */
  readonly rotateDemoPassword: boolean;
}

/** The demo account values the presence file names by environment variable. */
export interface AppStoreReleaseDemoAccount {
  readonly name: string;
  readonly password: string;
}

export interface AppStoreReleasePlanInput {
  readonly appId: string;
  readonly bundleId: string;
  readonly presence: StorePresence;
  readonly request: AppStoreReleaseRequest;
  /** Resolved from `appStore.review.demoAccount`; never saved. */
  readonly demoAccount?: AppStoreReleaseDemoAccount;
  readonly now?: () => Date;
}

export interface AppStoreReleasePorts {
  readonly release: AscReleasePort;
  readonly presence: AscStorePresencePort;
  readonly iap: AscIapPort;
}

export interface PlannedReleaseIap {
  readonly productId: string;
  readonly iapId: string;
  readonly type: string;
  readonly state: string;
  /** `attach`: added to the submission; `attached`: already in it. */
  readonly action: 'attach' | 'attached' | 'skip' | 'none' | 'blocked';
  readonly versionId?: string;
}

export interface AppStoreReleasePlan {
  readonly schemaVersion: 1;
  readonly store: 'app-store';
  readonly appId: string;
  readonly bundleId: string;
  readonly marketingVersion: string;
  readonly stage: AppStoreReleaseStage;
  readonly version: {
    readonly action: 'create' | 'rename' | 'reuse';
    readonly id?: string;
    /** `rename`: the editable version's current version string. */
    readonly from?: string;
    readonly state?: string;
    /** No version of the app has been released: App Store Connect takes no What's New. */
    readonly first: boolean;
  };
  /** One `versions update` (copyright, release type, earliest release date), when anything differs. */
  readonly versionUpdate?: {
    readonly copyright?: string;
    readonly releaseType?: AscReleaseType;
    readonly earliestReleaseDate?: string;
  };
  readonly build?: {
    readonly id: string;
    readonly buildNumber: string;
    readonly action: 'attach' | 'unchanged';
    /** The build attached now, which the new one replaces. */
    readonly replaces?: string;
  };
  readonly whatsNew: readonly {
    readonly locale: string;
    readonly localizationId: string;
    readonly change: StorePresenceTextChange;
  }[];
  readonly reviewDetail: {
    readonly action: 'create' | 'update' | 'unchanged';
    readonly id?: string;
    /** Field names only; the values stay in the game file and the environment. */
    readonly fields: readonly string[];
  };
  readonly phasedRelease: {
    readonly action: 'create' | 'delete' | 'unchanged';
    readonly id?: string;
    readonly state?: string;
  };
  readonly iaps: readonly PlannedReleaseIap[];
  readonly submission: {
    readonly action: 'create' | 'reuse' | 'submitted' | 'none';
    readonly id?: string;
    readonly state?: string;
    readonly addVersion: boolean;
    readonly submit: boolean;
  };
  /** The writes apply makes, in order. */
  readonly operations: readonly string[];
  /** What must be fixed before apply runs; apply refuses while any is listed. */
  readonly blockers: readonly string[];
  readonly notes: readonly string[];
  /** What the kit cannot do; the developer does it in App Store Connect. */
  readonly manual: readonly string[];
  readonly changed: boolean;
  readonly remoteSha256: string;
  readonly desiredSha256: string;
}

/** The writes of a plan, with what each needs. */
interface PlannedWrites {
  readonly createVersion?: { readonly releaseType: AscReleaseType; readonly copyright?: string };
  readonly renameVersion?: string;
  readonly whatsNew: readonly { readonly locale: string; readonly localizationId: string; readonly text: string }[];
  readonly reviewDetail?: { readonly action: 'create' | 'update'; readonly id?: string; readonly fields: AscReviewDetailWrite };
}

// App Store Connect `AppVersionState` (and the legacy `AppStoreVersionState` spellings).
// READY_FOR_REVIEW: the version is in a review submission that was not submitted
// yet (a partial apply), so it is prepared and submitted like the others.
const editableVersionStates = new Set([
  'PREPARE_FOR_SUBMISSION',
  'READY_FOR_REVIEW',
  'DEVELOPER_REJECTED',
  'REJECTED',
  'METADATA_REJECTED',
  'INVALID_BINARY',
]);
const renameableVersionStates = new Set(['PREPARE_FOR_SUBMISSION', 'DEVELOPER_REJECTED']);
const submittedVersionStates = new Set([
  'WAITING_FOR_REVIEW',
  'IN_REVIEW',
  'WAITING_FOR_EXPORT_COMPLIANCE',
]);
const approvedVersionStates = new Set([
  'PENDING_DEVELOPER_RELEASE',
  'PENDING_APPLE_RELEASE',
  'ACCEPTED',
]);
const releasedVersionStates = new Set([
  'READY_FOR_DISTRIBUTION',
  'PROCESSING_FOR_DISTRIBUTION',
  'REPLACED_WITH_NEW_VERSION',
  'READY_FOR_SALE',
  'DEVELOPER_REMOVED_FROM_SALE',
  'REMOVED_FROM_SALE',
]);
const editableAppInfoStates = new Set(['PREPARE_FOR_SUBMISSION', 'DEVELOPER_REJECTED', 'REJECTED']);
const liveAppInfoStates = new Set(['READY_FOR_DISTRIBUTION', 'READY_FOR_SALE']);
// `InAppPurchaseState` values that need work before the purchase can be reviewed.
const unfinishedIapStates = new Set([
  'MISSING_METADATA',
  'WAITING_FOR_UPLOAD',
  'PROCESSING_CONTENT',
  'DEVELOPER_ACTION_NEEDED',
  'REJECTED',
]);
/** An in-app purchase of this type has been, or is being, reviewed. */
const reviewedIapStates = new Set([
  'APPROVED',
  'PENDING_BINARY_APPROVAL',
  'WAITING_FOR_REVIEW',
  'IN_REVIEW',
]);
// `InAppPurchaseVersion.state` of the version a READY_TO_SUBMIT purchase submits.
const submittableIapVersionStates = new Set([
  'PREPARE_FOR_SUBMISSION',
  'READY_FOR_REVIEW',
  'REJECTED',
  'DEVELOPER_REJECTED',
]);
const iphoneDisplayTypes = ['APP_IPHONE_67', 'APP_IPHONE_65'];
const ipadDisplayTypes = ['APP_IPAD_PRO_3GEN_129', 'APP_IPAD_PRO_129'];

const manualSteps = [
  'App Privacy answers (App Store Connect > App Privacy): the public App Store Connect API has no resource '
  + 'for them, so the kit can neither write nor check them.',
  'Age rating answers: the plan only checks that the questionnaire was answered; answer it in App Store '
  + 'Connect (App Information > Age Rating).',
  'Sandbox testers, pricing and availability of the app, content rights, the app category and the '
  + 'export compliance documentation of a build that uses non-exempt encryption stay in App Store Connect.',
];

function versionState(version: AscReleaseVersion): string {
  return String(version.state ?? version.appStoreState ?? '');
}

function inStates(version: AscReleaseVersion, states: ReadonlySet<string>): boolean {
  return states.has(String(version.state)) || states.has(String(version.appStoreState));
}

/** Read App Store Connect and plan; never writes. */
export async function planAppStoreRelease(
  input: AppStoreReleasePlanInput,
  ports: AppStoreReleasePorts,
): Promise<AppStoreReleasePlan> {
  return (await planWithWrites(input, ports)).plan;
}

async function planWithWrites(
  input: AppStoreReleasePlanInput,
  ports: AppStoreReleasePorts,
): Promise<{ readonly plan: AppStoreReleasePlan; readonly writes: PlannedWrites }> {
  const appStore = requireAppStore(input.presence);
  const { request } = input;
  assertRequest(request, input.now?.() ?? new Date());
  const app = await ports.release.readApp(input.appId);
  if (app.bundleId !== input.bundleId) {
    throw new Error(
      `App Store Connect app ${input.appId} has bundle ID ${app.bundleId}, not ${input.bundleId} from the deployment profile.`,
    );
  }
  const blockers: string[] = [];
  const notes: string[] = [];
  const remote: Record<string, unknown> = { app };

  const versions = await ports.release.listVersions(input.appId);
  remote.versions = versions;
  const first = !versions.some((version) => inStates(version, releasedVersionStates));
  const exact = versions.filter((version) => version.versionString === request.marketingVersion);
  if (exact.length > 1) {
    throw new Error(
      `App Store Connect lists iOS version ${request.marketingVersion} ${exact.length} times.`,
    );
  }
  const [named] = exact;
  const base = {
    appId: input.appId,
    bundleId: input.bundleId,
    marketingVersion: request.marketingVersion,
  };

  // A version that is submitted, approved or released has nothing left to prepare.
  if (named !== undefined && inStates(named, releasedVersionStates)) {
    throw new Error(
      `iOS version ${named.versionString} is already ${versionState(named)}: submit a new marketing version.`,
    );
  }
  if (named !== undefined && (inStates(named, submittedVersionStates) || inStates(named, approvedVersionStates))) {
    const stage = inStates(named, approvedVersionStates) ? 'approved' : 'submitted';
    notes.push(stage === 'approved'
      ? `Version ${named.versionString} is ${versionState(named)}: App Review approved it. `
        + 'Release it with "mpgd store release publish" when its release type is manual.'
      : `Version ${named.versionString} is ${versionState(named)}: it is already submitted. `
        + 'Follow it with "mpgd store release status".');
    return finish({
      base,
      stage,
      version: { action: 'reuse', id: named.id, state: versionState(named), first },
      writes: { whatsNew: [] },
      blockers,
      notes,
      remote,
      request,
      demoAccount: input.demoAccount,
    });
  }

  if (named !== undefined && !inStates(named, editableVersionStates)) {
    throw new Error(
      `iOS version ${named.versionString} is ${versionState(named)}; the kit cannot prepare it.`,
    );
  }
  const editable = versions.filter((version) => inStates(version, editableVersionStates));
  const inFlight = versions.filter((version) => version.id !== named?.id
    && (inStates(version, submittedVersionStates) || inStates(version, approvedVersionStates)));
  let version: AscReleaseVersion | undefined = named !== undefined && inStates(named, editableVersionStates)
    ? named
    : undefined;
  let rename: string | undefined;
  if (version === undefined) {
    if (editable.length > 1) {
      throw new Error(
        `App Store Connect app ${input.appId} has ${editable.length} editable iOS versions; finish or remove all but one.`,
      );
    }
    const [other] = editable;
    if (other !== undefined) {
      if (!inStates(other, renameableVersionStates)) {
        blockers.push(
          `iOS version ${other.versionString} is ${versionState(other)}: App Store Connect keeps one version in `
          + `preparation. Resubmit or remove it in App Store Connect, or plan ${other.versionString} instead.`,
        );
      }
      version = other;
      rename = request.marketingVersion;
      notes.push(
        `App Store Connect has version ${other.versionString} in preparation; the plan renames it to `
        + `${request.marketingVersion} (iPhone and iPad share one version).`,
      );
    }
  }
  for (const other of inFlight) {
    blockers.push(
      `iOS version ${other.versionString} is ${versionState(other)}: wait until App Review finishes it `
      + '(or remove it from review in App Store Connect) before preparing another.',
    );
  }

  if (version === undefined) {
    // A new version: create it alone; its store page comes next.
    const copyright = appStore.copyright;
    notes.push(
      `Version ${request.marketingVersion} does not exist yet: apply creates it, then run `
      + '"mpgd store presence plan --store app-store" and apply it to fill its store page, and plan the '
      + 'release again for the build, App Review information and the submission.',
    );
    const builds = await ports.release.listBuilds({
      appId: input.appId,
      marketingVersion: request.marketingVersion,
      ...(request.buildNumber === undefined ? {} : { buildNumber: request.buildNumber }),
    });
    remote.builds = builds;
    const buildBlockers: string[] = [];
    selectBuild(builds, request, buildBlockers, notes);
    notes.push(...buildBlockers.map((blocker) => `Later: ${blocker}`));
    return finish({
      base,
      stage: 'create-version',
      version: { action: 'create', first },
      writes: {
        createVersion: {
          // A scheduled release needs its date, which only an update sets: create it manual first.
          releaseType: request.releaseType === 'SCHEDULED' ? 'MANUAL' : request.releaseType,
          ...(copyright === undefined ? {} : { copyright }),
        },
        whatsNew: [],
      },
      blockers,
      notes,
      remote,
      request,
      demoAccount: input.demoAccount,
    });
  }

  // The version in preparation: read everything the submission depends on.
  const [localizations, builds, attached, reviewDetail, phased, appInfos, iaps, submissions] = await Promise.all(
    [
      ports.presence.listVersionLocalizations(version.id),
      ports.release.listBuilds({
        appId: input.appId,
        marketingVersion: request.marketingVersion,
        ...(request.buildNumber === undefined ? {} : { buildNumber: request.buildNumber }),
      }),
      ports.release.readAttachedBuild(version.id),
      ports.release.readReviewDetail(version.id),
      ports.release.readPhasedRelease(version.id),
      ports.presence.listAppInfos(input.appId),
      ports.iap.listIaps(input.appId),
      ports.release.listReviewSubmissions(input.appId),
    ],
  );
  Object.assign(remote, {
    version,
    localizations,
    builds,
    attached,
    reviewDetail,
    phased,
    appInfos,
    iaps,
    submissions,
  });

  // Version settings: copyright and release options.
  const versionUpdate: { copyright?: string; releaseType?: AscReleaseType; earliestReleaseDate?: string } = {};
  if (appStore.copyright === undefined) {
    if ((version.copyright ?? '') === '') {
      blockers.push(
        'The version has no copyright line: add appStore.copyright (for example "2026 Your Studio") to the '
        + 'store presence file.',
      );
    }
  } else if (appStore.copyright !== version.copyright) {
    versionUpdate.copyright = appStore.copyright;
  }
  if (request.releaseType !== version.releaseType) {
    versionUpdate.releaseType = request.releaseType;
  }
  if (request.releaseType === 'SCHEDULED' && request.earliestReleaseDate !== undefined
    && Date.parse(request.earliestReleaseDate) !== Date.parse(version.earliestReleaseDate ?? '')) {
    versionUpdate.releaseType = request.releaseType;
    versionUpdate.earliestReleaseDate = request.earliestReleaseDate;
  }

  // The build.
  const selected = selectBuild(builds, request, blockers, notes);
  const build = selected === undefined
    ? undefined
    : {
        id: selected.id,
        buildNumber: selected.buildNumber,
        action: attached?.id === selected.id ? 'unchanged' as const : 'attach' as const,
        ...(attached !== undefined && attached.id !== selected.id
          ? { replaces: attached.buildNumber ?? attached.id }
          : {}),
      };

  // Localizations: every locale of the file is on the version, What's New on an update.
  const whatsNew: { locale: string; localizationId: string; text: string; change: StorePresenceTextChange }[] = [];
  const byLocale = new Map(localizations.map((entry) => [entry.locale.toLowerCase(), entry]));
  const fileLocales = Object.keys(appStore.localizations);
  const fileLocaleKeys = new Set(fileLocales.map((locale) => locale.toLowerCase()));
  for (const locale of fileLocales) {
    const remoteLocale = byLocale.get(locale.toLowerCase());
    if (remoteLocale === undefined) {
      blockers.push(
        `${locale}: the version has no ${locale} localization on App Store Connect. Run "mpgd store presence `
        + 'plan --store app-store" and apply it first.',
      );
      continue;
    }
    if (first) {
      continue;
    }
    const desired = appStore.localizations[locale]?.whatsNew;
    if (desired === undefined) {
      if ((remoteLocale.whatsNew ?? '') === '') {
        blockers.push(
          `${locale}: What's New is required for an update; add appStore.localizations.${locale}.whatsNew.`,
        );
      }
      continue;
    }
    const text = normalizeLineBreaks(desired);
    const change = describeTextChange('whatsNew', remoteLocale.whatsNew, text);
    if (change !== undefined) {
      whatsNew.push({ locale: remoteLocale.locale, localizationId: remoteLocale.id, text, change });
    }
  }
  for (const entry of localizations) {
    if (!fileLocaleKeys.has(entry.locale.toLowerCase())) {
      if (!first && (entry.whatsNew ?? '') === '') {
        blockers.push(
          `${entry.locale}: on App Store Connect but not in the store presence file, and it has no What's New. `
          + `Add appStore.localizations.${entry.locale} to the file (or remove the locale in App Store Connect).`,
        );
      } else {
        notes.push(
          `${entry.locale}: on App Store Connect but not in the store presence file; left as it is.`,
        );
      }
    }
  }
  if (first && fileLocales.some((locale) => appStore.localizations[locale]?.whatsNew !== undefined)) {
    notes.push(
      "This is the app's first version: App Store Connect takes no What's New, so it is left out.",
    );
  }

  // Screenshots: App Review needs the iPhone set and, for a universal app, the 13-inch iPad set.
  const screenshotLocale = pickScreenshotLocale(localizations, app.primaryLocale);
  if (screenshotLocale !== undefined) {
    const sets = await ports.presence.listScreenshotSets(screenshotLocale.id);
    remote.screenshotSets = sets;
    const has = (types: readonly string[]): boolean => sets.some((set) =>
      types.includes(set.displayType)
      && set.screenshots.some((shot) => shot.deliveryState === undefined || shot.deliveryState === 'COMPLETE'));
    if (!has(iphoneDisplayTypes)) {
      blockers.push(
        `${screenshotLocale.locale}: no 6.9-inch (or 6.5-inch) iPhone screenshots on the version. Add `
        + `appStore.localizations.${screenshotLocale.locale}.screenshots.iphone69 and apply the store presence.`,
      );
    }
    if (request.universal && !has(ipadDisplayTypes)) {
      blockers.push(
        `${screenshotLocale.locale}: the app runs on iPad (mpgd.targets.json ios metadata.iosDeviceFamily) `
        + 'but the version has no 13-inch iPad screenshots. Add '
        + `appStore.localizations.${screenshotLocale.locale}.screenshots.ipad13 and apply the store presence.`,
      );
    }
  }

  // Age rating: answered on the app information record that goes with this version.
  const appInfo = appInfos.find((info) => editableAppInfoStates.has(String(info.state)))
    ?? appInfos.find((info) => liveAppInfoStates.has(String(info.state)))
    ?? appInfos[0];
  const ageRating = appInfo === undefined
    ? undefined
    : await ports.release.readAgeRating(appInfo.id);
  remote.ageRating = ageRating ?? null;
  if (ageRating === undefined || ageRating.answered.length === 0) {
    blockers.push(
      'The age rating questionnaire is not answered: answer it in App Store Connect (App Information > '
      + 'Age Rating), then plan again.',
    );
  }

  // App Review information.
  const review = planReviewDetail(
    appStore.review,
    reviewDetail,
    input.demoAccount,
    request,
    blockers,
    notes,
  );

  // Phased release.
  const phasedRelease = planPhasedRelease(request.phasedRelease, phased, notes);

  // In-app purchases and the review submission.
  const openSubmissions = submissions.filter((submission) => submission.state !== 'COMPLETE');
  const items = new Map<string, AscReviewSubmissionItem[]>();
  for (const submission of openSubmissions) {
    items.set(submission.id, await ports.release.listReviewSubmissionItems(submission.id));
  }
  remote.items = Object.fromEntries([...items.entries()].sort(([left], [right]) => left.localeCompare(right)));
  const plannedIaps = await planIaps(iaps, request.skipIaps, ports.iap, blockers, notes, remote);
  const submission = planSubmission({
    versionId: version.id,
    openSubmissions,
    items,
    iaps: plannedIaps,
    blockers,
  });
  const iapsWithItems = plannedIaps.map((iap): PlannedReleaseIap =>
    iap.action === 'attach' && iap.versionId !== undefined && submission.attachedIapVersions.has(iap.versionId)
      ? { ...iap, action: 'attached' }
      : iap,
  );

  return finish({
    base,
    stage: 'prepare',
    version: {
      action: rename === undefined ? 'reuse' : 'rename',
      id: version.id,
      ...(rename === undefined ? {} : { from: version.versionString }),
      state: versionState(version),
      first,
    },
    ...(Object.keys(versionUpdate).length === 0 ? {} : { versionUpdate }),
    ...(build === undefined ? {} : { build }),
    writes: {
      ...(rename === undefined ? {} : { renameVersion: rename }),
      whatsNew: whatsNew.map(({ locale, localizationId, text }) => ({
        locale,
        localizationId,
        text,
      })),
      ...(review.write === undefined ? {} : { reviewDetail: review.write }),
    },
    whatsNew: whatsNew.map(({ locale, localizationId, change }) => ({
      locale,
      localizationId,
      change,
    })),
    reviewDetail: review.plan,
    phasedRelease,
    iaps: iapsWithItems,
    submission: submission.plan,
    blockers,
    notes,
    remote,
    request,
    demoAccount: input.demoAccount,
  });
}

function requireAppStore(presence: StorePresence): AppStorePresence {
  if (presence.appStore === undefined) {
    throw new Error('The store presence file has no appStore section.');
  }
  return presence.appStore;
}

const marketingVersionPattern = /^\d+(?:\.\d+){0,2}$/u;
const buildNumberPattern = /^\d+(?:\.\d+){0,2}$/u;
const productIdPattern = /^[A-Za-z0-9._-]{1,100}$/u;

function assertRequest(request: AppStoreReleaseRequest, now: Date): void {
  if (!marketingVersionPattern.test(request.marketingVersion)) {
    throw new Error(`Marketing version ${request.marketingVersion} must look like 1.2 or 1.2.3.`);
  }
  if (request.buildNumber !== undefined && !buildNumberPattern.test(request.buildNumber)) {
    throw new Error(`Build number ${request.buildNumber} must look like 42 or 1.0.42.`);
  }
  if (!['MANUAL', 'AFTER_APPROVAL', 'SCHEDULED'].includes(request.releaseType)) {
    throw new Error('The release type must be manual, after-approval or scheduled.');
  }
  if (request.releaseType === 'SCHEDULED') {
    const date = request.earliestReleaseDate === undefined
      ? Number.NaN
      : Date.parse(request.earliestReleaseDate);
    if (!Number.isFinite(date) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/u.test(request.earliestReleaseDate ?? '')) {
      throw new Error(
        'A scheduled release needs --release-date as an ISO 8601 date and time, for example 2026-12-01T09:00:00+09:00.',
      );
    }
    if (date <= now.getTime()) {
      throw new Error(
        `The release date ${String(request.earliestReleaseDate)} is not in the future.`,
      );
    }
  } else if (request.earliestReleaseDate !== undefined) {
    throw new Error('--release-date applies only to --release-type scheduled.');
  }
  for (const productId of request.skipIaps) {
    if (!productIdPattern.test(productId)) {
      throw new Error(`--skip-iap ${productId} is not an App Store product ID.`);
    }
  }
}

/** Build numbers compare as dot-separated integers. */
function compareBuildNumbers(left: string, right: string): number {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

/**
 * The build to submit: the named build number, else the newest build of the
 * marketing version. Anything App Review would refuse is a blocker.
 */
function selectBuild(
  builds: readonly AscReleaseBuild[],
  request: AppStoreReleaseRequest,
  blockers: string[],
  notes: string[],
): AscReleaseBuild | undefined {
  const label = (build: { readonly buildNumber: string }): string =>
    `Build ${request.marketingVersion} (${build.buildNumber})`;
  let build: AscReleaseBuild | undefined;
  if (request.buildNumber !== undefined) {
    const matching = builds.filter((candidate) => candidate.buildNumber === request.buildNumber);
    if (matching.length > 1) {
      throw new Error(
        `App Store Connect lists build ${request.marketingVersion} (${request.buildNumber}) twice.`,
      );
    }
    build = matching[0];
    if (build === undefined) {
      blockers.push(
        `${label({ buildNumber: request.buildNumber })} is not on App Store Connect: upload it with "mpgd deploy run", `
        + 'or wait a few minutes for App Store Connect to list it, then plan again.',
      );
      return undefined;
    }
  } else {
    build = [...builds].sort((left, right) => compareBuildNumbers(right.buildNumber, left.buildNumber))[0];
    if (build === undefined) {
      blockers.push(
        `No build of version ${request.marketingVersion} is on App Store Connect: upload one with "mpgd deploy run".`,
      );
      return undefined;
    }
    notes.push(
      `${label(build)} is the newest build of the version; pass --build-number to choose another.`,
    );
  }
  if (request.recordedBuildId !== undefined && build.id !== request.recordedBuildId) {
    throw new Error(
      `${label(build)} is App Store Connect build ${build.id}, not ${request.recordedBuildId} that deploy run recorded.`,
    );
  }
  const state = String(build.processingState ?? '');
  if (state === 'PROCESSING') {
    blockers.push(
      `${label(build)} is still processing on App Store Connect; plan again when it is VALID.`,
    );
  } else if (state === 'FAILED' || state === 'INVALID') {
    blockers.push(
      `${label(build)} is ${state} on App Store Connect (see the email Apple sent); upload a new build.`,
    );
  } else if (state !== 'VALID') {
    blockers.push(`${label(build)} has processing state ${state || 'unknown'}; plan again later.`);
  } else if (build.expired === true) {
    blockers.push(`${label(build)} has expired; upload a new build.`);
  } else if (build.usesNonExemptEncryption === undefined) {
    blockers.push(
      `${label(build)} is missing export compliance: answer it for the build in App Store Connect, or ship `
      + 'ITSAppUsesNonExemptEncryption in Info.plist for later builds.',
    );
  } else if (build.usesNonExemptEncryption) {
    notes.push(
      `${label(build)} declares non-exempt encryption: App Review needs its export compliance documentation `
      + 'approved in App Store Connect.',
    );
  }
  return build;
}

function pickScreenshotLocale(
  localizations: readonly AscVersionLocalization[],
  primaryLocale: string | undefined,
): AscVersionLocalization | undefined {
  if (primaryLocale !== undefined) {
    const primary = localizations.find(
      (entry) => entry.locale.toLowerCase() === primaryLocale.toLowerCase(),
    );
    if (primary !== undefined) {
      return primary;
    }
  }
  return localizations[0];
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function planReviewDetail(
  review: AppStorePresenceReview | undefined,
  remote: AscReviewDetail | undefined,
  demoAccount: AppStoreReleaseDemoAccount | undefined,
  request: AppStoreReleaseRequest,
  blockers: string[],
  notes: string[],
): {
  readonly plan: AppStoreReleasePlan['reviewDetail'];
  readonly write?: NonNullable<PlannedWrites['reviewDetail']>;
} {
  if (review === undefined) {
    const complete = remote !== undefined && [
      remote.contactFirstName,
      remote.contactLastName,
      remote.contactEmail,
      remote.contactPhone,
    ].every((value) => (value ?? '') !== '');
    if (complete) {
      notes.push(
        'The store presence file has no appStore.review: the App Review information stays as it is.',
      );
    } else {
      blockers.push(
        'App Review needs a contact: add appStore.review.contact (first and last name, email, phone) to the store '
        + 'presence file.',
      );
    }
    return {
      plan: { action: 'unchanged', ...(remote === undefined ? {} : { id: remote.id }), fields: [] },
    };
  }
  if (review.demoAccount !== undefined && demoAccount === undefined) {
    throw new Error(
      'appStore.review.demoAccount needs its user name and password from the environment.',
    );
  }
  const desired: Record<string, string | boolean> = {
    contactFirstName: review.contact.firstName,
    contactLastName: review.contact.lastName,
    contactEmail: review.contact.email,
    contactPhone: review.contact.phone,
    ...(review.notes === undefined ? {} : { notes: normalizeLineBreaks(review.notes) }),
    demoAccountRequired: review.demoAccount !== undefined,
    ...(demoAccount === undefined ? {} : { demoAccountName: demoAccount.name }),
  };
  const fields: Record<string, string | boolean> = {};
  const changed: string[] = [];
  for (const [field, value] of Object.entries(desired)) {
    const current = remote === undefined
      ? undefined
      : field === 'demoAccountRequired'
        ? remote.demoAccountRequired
        : typeof remote[field as keyof AscReviewDetail] === 'string'
          ? normalizeLineBreaks(String(remote[field as keyof AscReviewDetail]))
          : undefined;
    if (current !== value) {
      fields[field] = value;
      changed.push(field);
    }
  }
  if (demoAccount !== undefined
    && (remote === undefined || !remote.demoAccountPasswordSet || request.rotateDemoPassword
      || changed.includes('demoAccountName') || changed.includes('demoAccountRequired'))) {
    fields.demoAccountPassword = demoAccount.password;
    changed.push('demoAccountPassword');
  }
  if (demoAccount !== undefined && !changed.includes('demoAccountPassword')) {
    notes.push(
      'The demo account password on App Store Connect is kept (asc never shows it); plan with '
      + '--rotate-demo-password to send it again.',
    );
  }
  if (changed.length === 0 && remote !== undefined) {
    return { plan: { action: 'unchanged', id: remote.id, fields: [] } };
  }
  return remote === undefined
    ? {
        plan: { action: 'create', fields: changed },
        write: { action: 'create', fields: fields as AscReviewDetailWrite },
      }
    : {
        plan: { action: 'update', id: remote.id, fields: changed },
        write: { action: 'update', id: remote.id, fields: fields as AscReviewDetailWrite },
      };
}

function planPhasedRelease(
  desired: boolean,
  remote: AscPhasedRelease | undefined,
  notes: string[],
): AppStoreReleasePlan['phasedRelease'] {
  if (desired) {
    return remote === undefined
      ? { action: 'create' }
      : { action: 'unchanged', id: remote.id, state: remote.state };
  }
  if (remote === undefined) {
    return { action: 'unchanged' };
  }
  if (remote.state === 'INACTIVE') {
    return { action: 'delete', id: remote.id, state: remote.state };
  }
  notes.push(`The phased release is ${remote.state}; it is left as it is.`);
  return { action: 'unchanged', id: remote.id, state: remote.state };
}

async function planIaps(
  iaps: readonly AscIap[],
  skipIaps: readonly string[],
  port: AscIapPort,
  blockers: string[],
  notes: string[],
  remote: Record<string, unknown>,
): Promise<PlannedReleaseIap[]> {
  const known = new Set(iaps.map((iap) => iap.productId));
  for (const productId of skipIaps) {
    if (!known.has(productId)) {
      throw new Error(
        `--skip-iap ${productId} is not an in-app purchase of this app on App Store Connect.`,
      );
    }
  }
  const skip = new Set(skipIaps);
  const iapVersions: Record<string, unknown> = {};
  const planned: PlannedReleaseIap[] = [];
  for (const iap of [...iaps].sort((left, right) =>
    left.productId.localeCompare(right.productId),
  )) {
    const state = String(iap.state ?? '');
    const base = { productId: iap.productId, iapId: iap.id, type: iap.inAppPurchaseType, state };
    if (skip.has(iap.productId)) {
      planned.push({ ...base, action: 'skip' });
      continue;
    }
    if (state === 'READY_TO_SUBMIT') {
      const versions = await port.listVersions(iap.id);
      iapVersions[iap.id] = versions;
      const submittable = versions.filter((version) =>
        submittableIapVersionStates.has(String(version.state)),
      );
      const [version] = submittable;
      if (submittable.length !== 1 || version === undefined) {
        blockers.push(
          `${iap.productId} is READY_TO_SUBMIT but has ${submittable.length} versions that could go to review; `
          + 'finish or remove the extra one in App Store Connect.',
        );
        planned.push({ ...base, action: 'blocked' });
        continue;
      }
      planned.push({ ...base, action: 'attach', versionId: version.id });
      continue;
    }
    if (unfinishedIapStates.has(state)) {
      blockers.push(
        state === 'PROCESSING_CONTENT'
          ? `${iap.productId} is still processing on App Store Connect; plan again later.`
          : `${iap.productId} is ${state}: finish it with "mpgd store products apply --store app-store" (or in App `
            + `Store Connect), or leave it out of this submission with --skip-iap ${iap.productId}.`,
      );
      planned.push({ ...base, action: 'blocked' });
      continue;
    }
    planned.push({ ...base, action: 'none' });
  }
  remote.iapVersions = iapVersions;
  // Apple reviews an app's first purchase of each type only with an app version.
  for (const type of [...new Set(iaps.map((iap) => iap.inAppPurchaseType))].sort()) {
    const reviewed = iaps.some(
      (iap) => iap.inAppPurchaseType === type && reviewedIapStates.has(String(iap.state)),
    );
    if (reviewed) {
      continue;
    }
    const going = planned.filter((iap) => iap.type === type && iap.action === 'attach');
    if (going.length > 0) {
      notes.push(
        `${going.map((iap) => iap.productId).join(', ')}: the app's first ${type.toLowerCase().replace(/_/gu, '-')} `
        + 'purchase(s), which App Review takes only together with an app version; they go with this one.',
      );
    } else if (planned.some((iap) => iap.type === type && iap.action === 'skip')) {
      notes.push(
        `No ${type.toLowerCase().replace(/_/gu, '-')} purchase goes with this version: the skipped ones can be sold only `
        + 'after they are submitted with a later version.',
      );
    }
  }
  return planned;
}

function planSubmission(input: {
  readonly versionId: string;
  readonly openSubmissions: readonly AscReviewSubmission[];
  readonly items: ReadonlyMap<string, readonly AscReviewSubmissionItem[]>;
  readonly iaps: readonly PlannedReleaseIap[];
  readonly blockers: string[];
}): { readonly plan: AppStoreReleasePlan['submission']; readonly attachedIapVersions: ReadonlySet<string> } {
  const live = (submissionId: string): AscReviewSubmissionItem[] =>
    [...(input.items.get(submissionId) ?? [])].filter((item) => item.state !== 'REMOVED');
  const plannedIapVersions = new Set(
    input.iaps.flatMap((iap) => iap.versionId === undefined ? [] : [iap.versionId]),
  );
  const holding = input.openSubmissions.find((submission) =>
    live(submission.id).some((item) => item.appStoreVersionId === input.versionId),
  );
  const draft = holding ?? input.openSubmissions.find((submission) => submission.state === 'READY_FOR_REVIEW');
  for (const submission of input.openSubmissions) {
    if (submission.id === draft?.id) {
      continue;
    }
    input.blockers.push(
      `Review submission ${submission.id} is ${submission.state}: App Store Connect reviews one iOS submission at `
      + 'a time. Wait for it to finish (or cancel it in App Store Connect) before submitting this version.',
    );
  }
  if (draft === undefined) {
    return {
      plan: { action: 'create', addVersion: true, submit: true },
      attachedIapVersions: new Set(),
    };
  }
  if (draft.state === 'UNRESOLVED_ISSUES') {
    input.blockers.push(
      `Review submission ${draft.id} has unresolved issues from App Review: read the message in App Store Connect, `
      + 'fix the version, and resubmit it there (the kit does not resubmit a returned submission).',
    );
  } else if (draft.state === 'CANCELING' || draft.state === 'COMPLETING') {
    input.blockers.push(
      `Review submission ${draft.id} is ${draft.state}; plan again in a few minutes.`,
    );
  }
  const items = live(draft.id);
  const unrelated = items.filter((item) => item.appStoreVersionId !== input.versionId
    && (item.inAppPurchaseVersionId === undefined || !plannedIapVersions.has(item.inAppPurchaseVersionId)));
  if (unrelated.length > 0 && draft.state === 'READY_FOR_REVIEW') {
    input.blockers.push(
      `Review submission ${draft.id} already holds ${unrelated.length} other item(s) (${
        unrelated.map((item) => item.id).join(', ')}); remove them in App Store Connect or submit them first.`,
    );
  }
  const attachedIapVersions = new Set(
    items.flatMap((item) =>
      item.inAppPurchaseVersionId === undefined ? [] : [item.inAppPurchaseVersionId],
    ),
  );
  const submitted = draft.state === 'WAITING_FOR_REVIEW' || draft.state === 'IN_REVIEW';
  return {
    plan: {
      action: submitted ? 'submitted' : 'reuse',
      id: draft.id,
      state: draft.state,
      addVersion: !items.some((item) => item.appStoreVersionId === input.versionId),
      submit: !submitted,
    },
    attachedIapVersions,
  };
}

function finish(input: {
  readonly base: Pick<AppStoreReleasePlan, 'appId' | 'bundleId' | 'marketingVersion'>;
  readonly stage: AppStoreReleaseStage;
  readonly version: AppStoreReleasePlan['version'];
  readonly versionUpdate?: AppStoreReleasePlan['versionUpdate'];
  readonly build?: AppStoreReleasePlan['build'];
  readonly writes: PlannedWrites;
  readonly whatsNew?: AppStoreReleasePlan['whatsNew'];
  readonly reviewDetail?: AppStoreReleasePlan['reviewDetail'];
  readonly phasedRelease?: AppStoreReleasePlan['phasedRelease'];
  readonly iaps?: readonly PlannedReleaseIap[];
  readonly submission?: AppStoreReleasePlan['submission'];
  readonly blockers: readonly string[];
  readonly notes: readonly string[];
  readonly remote: Record<string, unknown>;
  readonly request: AppStoreReleaseRequest;
  readonly demoAccount: AppStoreReleaseDemoAccount | undefined;
}): { readonly plan: AppStoreReleasePlan; readonly writes: PlannedWrites } {
  const iaps = input.iaps ?? [];
  const submission = input.submission ?? { action: 'none' as const, addVersion: false, submit: false };
  const reviewDetail = input.reviewDetail ?? { action: 'unchanged' as const, fields: [] };
  const phasedRelease = input.phasedRelease ?? { action: 'unchanged' as const };
  const whatsNew = input.whatsNew ?? [];
  const plan = {
    schemaVersion: 1 as const,
    store: 'app-store' as const,
    ...input.base,
    stage: input.stage,
    version: input.version,
    ...(input.versionUpdate === undefined ? {} : { versionUpdate: input.versionUpdate }),
    ...(input.build === undefined ? {} : { build: input.build }),
    whatsNew,
    reviewDetail,
    phasedRelease,
    iaps,
    submission,
  };
  const operations = describeOperations({ ...plan, writes: input.writes, request: input.request });
  const desired = {
    request: input.request,
    copyright: input.versionUpdate?.copyright ?? null,
    whatsNew: input.writes.whatsNew,
    reviewDetail: input.writes.reviewDetail === undefined
      ? null
      : {
          ...input.writes.reviewDetail,
          fields: {
            ...input.writes.reviewDetail.fields,
            demoAccountName: input.writes.reviewDetail.fields.demoAccountName === undefined
              ? undefined
              : sha256(input.writes.reviewDetail.fields.demoAccountName),
            demoAccountPassword: input.writes.reviewDetail.fields.demoAccountPassword === undefined
              ? undefined
              : 'set',
          },
        },
    demoAccountName: input.demoAccount === undefined ? null : sha256(input.demoAccount.name),
    operations,
  };
  return {
    plan: {
      ...plan,
      operations,
      blockers: input.blockers,
      notes: input.notes,
      manual: manualSteps,
      changed: operations.length > 0,
      remoteSha256: stableSha256(input.remote),
      desiredSha256: stableSha256(desired),
    },
    writes: input.writes,
  };
}

function describeOperations(plan: Omit<AppStoreReleasePlan,
  'operations' | 'blockers' | 'notes' | 'manual' | 'changed' | 'remoteSha256' | 'desiredSha256'> & {
  readonly writes: PlannedWrites;
  readonly request: AppStoreReleaseRequest;
}): string[] {
  const operations: string[] = [];
  const { writes } = plan;
  if (writes.createVersion !== undefined) {
    operations.push(
      `create iOS version ${plan.marketingVersion} (release ${writes.createVersion.releaseType}${
        writes.createVersion.copyright === undefined ? '' : `, copyright "${writes.createVersion.copyright}"`})`,
    );
    return operations;
  }
  if (writes.renameVersion !== undefined) {
    operations.push(`rename iOS version ${String(plan.version.from)} to ${writes.renameVersion}`);
  }
  if (plan.versionUpdate !== undefined) {
    const parts = [
      plan.versionUpdate.copyright === undefined ? undefined : `copyright "${plan.versionUpdate.copyright}"`,
      plan.versionUpdate.releaseType === undefined ? undefined : `release ${plan.versionUpdate.releaseType}`,
      plan.versionUpdate.earliestReleaseDate === undefined
        ? undefined
        : `not before ${plan.versionUpdate.earliestReleaseDate}`,
    ].filter((part) => part !== undefined);
    operations.push(`update version settings: ${parts.join(', ')}`);
  }
  if (plan.build?.action === 'attach') {
    operations.push(
      `attach build ${plan.build.buildNumber} (${plan.build.id})${
        plan.build.replaces === undefined ? '' : `, replacing build ${plan.build.replaces}`}`,
    );
  }
  for (const entry of plan.whatsNew) {
    operations.push(`write What's New for ${entry.locale} (${entry.change.toLength} characters)`);
  }
  if (plan.reviewDetail.action !== 'unchanged') {
    operations.push(
      `${plan.reviewDetail.action} App Review information: ${plan.reviewDetail.fields.join(', ')}`,
    );
  }
  if (plan.phasedRelease.action === 'create') {
    operations.push('turn on phased release (7 days, starting when the version is released)');
  } else if (plan.phasedRelease.action === 'delete') {
    operations.push('turn off phased release');
  }
  if (plan.submission.action === 'create') {
    operations.push('create an iOS review submission');
  }
  if (plan.submission.addVersion) {
    operations.push(`add version ${plan.marketingVersion} to the review submission`);
  }
  for (const iap of plan.iaps) {
    if (iap.action === 'attach') {
      operations.push(
        `add in-app purchase ${iap.productId} (version ${String(iap.versionId)}) to the review submission`,
      );
    }
  }
  if (plan.submission.submit) {
    operations.push('submit for App Review');
  }
  return operations;
}

export interface AppStoreReleaseApplyResult {
  readonly appId: string;
  readonly marketingVersion: string;
  readonly status: 'created-version' | 'submitted' | 'unchanged' | 'dry-run';
  /** The writes, in order (dry run: the writes apply would make). */
  readonly steps: readonly string[];
  readonly versionId?: string;
  readonly submissionId?: string;
  readonly next: readonly string[];
  readonly manual: readonly string[];
}

export class AppStoreReleaseApplyError extends Error {
  constructor(
    readonly stage: string,
    /** The writes that landed before the failure. */
    readonly written: readonly string[],
    cause: unknown,
    /** App Store Connect refused the step (asc exited with a 4xx-class code): nothing from it landed. */
    readonly definitive = false,
  ) {
    super(
      `App Store Connect ${stage} ${definitive ? 'failed; nothing from this step landed' : 'failed or its result is unknown'} (${
        cause instanceof Error ? cause.message : String(cause)}). Written before it: ${
        written.join('; ') || 'nothing'}. Run "${appStoreReleasePlanCommand}" again: it reads App Store `
      + 'Connect, finds what already landed (the version, its build, an open submission) and lists what is left.',
      { cause },
    );
    this.name = 'AppStoreReleaseApplyError';
  }
}

/** Refuse a plan with blockers, with every blocker named. */
export function assertNoBlockers(plan: AppStoreReleasePlan): void {
  if (plan.blockers.length > 0) {
    throw new Error(
      `The release plan has ${plan.blockers.length} blocker(s); fix them and plan again:\n${
        plan.blockers.map((blocker) => `- ${blocker}`).join('\n')}`,
    );
  }
}

/**
 * Apply a reviewed plan: re-plan, refuse when App Store Connect or the files
 * moved past it or it has blockers, then write step by step. A plan whose
 * changes already landed is a no-op, so a re-run is safe. `dryRun` stops
 * after the checks and returns the writes it would make.
 */
export async function applyAppStoreRelease(input: {
  readonly saved: AppStoreReleasePlan;
  readonly plan: AppStoreReleasePlanInput;
  readonly ports: AppStoreReleasePorts;
  readonly approved: boolean;
  readonly dryRun?: boolean;
}): Promise<AppStoreReleaseApplyResult> {
  const { saved, ports } = input;
  const { appId } = input.plan;
  const dryRun = input.dryRun === true;
  if (!input.approved && !dryRun) {
    throw new Error('Submitting the App Store release requires --approve.');
  }
  if (saved.appId !== appId || saved.bundleId !== input.plan.bundleId
    || saved.marketingVersion !== input.plan.request.marketingVersion) {
    throw new StorePlanStaleError(
      `The deployment profile or request now names app ${appId} (${input.plan.bundleId}) version `
      + `${input.plan.request.marketingVersion}, not the reviewed plan's.`,
      appStoreReleasePlanCommand,
    );
  }
  const { plan: current, writes } = await planWithWrites(input.plan, ports);
  const base = { appId, marketingVersion: current.marketingVersion, manual: current.manual };
  if (!current.changed) {
    return {
      ...base,
      status: 'unchanged',
      steps: [],
      ...(current.version.id === undefined ? {} : { versionId: current.version.id }),
      ...(current.submission.id === undefined ? {} : { submissionId: current.submission.id }),
      next: current.notes,
    };
  }
  if (current.remoteSha256 !== saved.remoteSha256 || current.desiredSha256 !== saved.desiredSha256) {
    throw new StorePlanStaleError(
      'App Store Connect, the store presence file or the demo account changed since the plan.',
      appStoreReleasePlanCommand,
    );
  }
  assertNoBlockers(current);
  if (dryRun) {
    return {
      ...base,
      status: 'dry-run',
      steps: current.operations,
      ...(current.version.id === undefined ? {} : { versionId: current.version.id }),
      next: [],
    };
  }
  const steps: string[] = [];
  let stage = 'start';
  const step = async <T>(name: string, action: () => Promise<T>): Promise<T> => {
    stage = name;
    const result = await action();
    steps.push(name);
    return result;
  };
  try {
    if (writes.createVersion !== undefined) {
      const create = writes.createVersion;
      const versionId = await step(`create version ${current.marketingVersion}`, () =>
        ports.release.createVersion({
          appId,
          versionString: current.marketingVersion,
          releaseType: create.releaseType,
          ...(create.copyright === undefined ? {} : { copyright: create.copyright }),
        }),
      );
      return {
        ...base,
        status: 'created-version',
        steps,
        versionId,
        next: [
          `Run "mpgd store presence plan --store app-store --out <plan>" and apply it to fill version `
          + `${current.marketingVersion}'s store page.`,
          `Then run "${appStoreReleasePlanCommand}" again for the build, App Review information and the submission.`,
        ],
      };
    }
    const versionId = current.version.id;
    if (versionId === undefined) {
      throw new Error('The plan has no version to prepare.');
    }
    if (writes.renameVersion !== undefined) {
      const versionString = writes.renameVersion;
      await step(`rename version to ${versionString}`, () =>
        ports.release.updateVersion({ versionId, versionString }),
      );
    }
    if (current.versionUpdate !== undefined) {
      const update = current.versionUpdate;
      await step('version settings', () => ports.release.updateVersion({ versionId, ...update }));
    }
    if (current.build?.action === 'attach') {
      const buildId = current.build.id;
      await step(`attach build ${current.build.buildNumber}`, () =>
        ports.release.attachBuild({ versionId, buildId }),
      );
    }
    for (const entry of writes.whatsNew) {
      await step(`What's New ${entry.locale}`, () =>
        ports.presence.updateVersionLocalization({
          localizationId: entry.localizationId,
          fields: { whatsNew: entry.text },
        }),
      );
    }
    const review = writes.reviewDetail;
    if (review !== undefined) {
      if (review.action === 'create') {
        await step('App Review information create', () =>
          ports.release.createReviewDetail({ versionId, fields: review.fields }),
        );
      } else if (review.id !== undefined) {
        const detailId = review.id;
        await step('App Review information update', () =>
          ports.release.updateReviewDetail({ detailId, fields: review.fields }),
        );
      }
    }
    if (current.phasedRelease.action === 'create') {
      await step('phased release on', () => ports.release.createPhasedRelease(versionId));
    } else if (current.phasedRelease.action === 'delete' && current.phasedRelease.id !== undefined) {
      const phasedId = current.phasedRelease.id;
      await step('phased release off', () => ports.release.deletePhasedRelease(phasedId));
    }
    let submissionId = current.submission.id;
    if (current.submission.action === 'create') {
      submissionId = await step('create review submission', () => ports.release.createReviewSubmission(appId));
    }
    if (submissionId === undefined) {
      throw new Error('The plan has no review submission.');
    }
    const id = submissionId;
    if (current.submission.addVersion) {
      await step(`add version ${current.marketingVersion} to submission ${id}`, () =>
        ports.release.addReviewSubmissionItem({
          submissionId: id,
          type: 'appStoreVersions',
          id: versionId,
        }),
      );
    }
    for (const iap of current.iaps) {
      if (iap.action === 'attach' && iap.versionId !== undefined) {
        const iapVersionId = iap.versionId;
        await step(`add in-app purchase ${iap.productId} to submission ${id}`, () =>
          ports.release.addReviewSubmissionItem({
            submissionId: id,
            type: 'inAppPurchaseVersions',
            id: iapVersionId,
          }),
        );
      }
    }
    if (current.submission.submit) {
      await step(`submit ${id} for review`, () => ports.release.submitReviewSubmission(id));
    }
    return {
      ...base,
      status: 'submitted',
      steps,
      versionId,
      submissionId: id,
      next: ['Follow the review with "mpgd store release status".'],
    };
  } catch (error) {
    throw new AppStoreReleaseApplyError(stage, steps, error, isDefinitiveAscFailure(error));
  }
}

/**
 * asc 5.5.0 exit codes (`cmd/exit_codes.go`): 2 usage, 3 auth, 4 not found,
 * 5 conflict, and 10 + (status - 400) for other 4xx answers. Those are App
 * Store Connect (or asc) refusing the request; 1 (generic, including network
 * failures), 5xx codes, a timeout or an abort leave the result unknown.
 */
function isDefinitiveAscFailure(error: unknown): boolean {
  if (!(error instanceof ReleaseProcessError) || error.reason !== 'exit' || error.exitCode === undefined) {
    return false;
  }
  const code = error.exitCode;
  const timeoutOrRateLimit = code === 10 + (408 - 400) || code === 10 + (429 - 400);
  return (code >= 2 && code <= 5) || (code >= 10 && code < 60 && !timeoutOrRateLimit);
}

/** The plan for the terminal. */
export function formatAppStoreReleasePlan(plan: AppStoreReleasePlan): string {
  const lines = [
    `App Store Connect app ${plan.appId} (${plan.bundleId}), iOS version ${plan.marketingVersion}: ${
      {
        'create-version': 'create the version',
        prepare: plan.changed ? 'prepare and submit for review' : 'nothing to change',
        submitted: 'already submitted',
        approved: 'approved',
      }[plan.stage]}${plan.version.state === undefined ? '' : ` (${plan.version.state})`}`,
  ];
  if (plan.build !== undefined) {
    lines.push(
      `  build     ${plan.build.buildNumber} (${plan.build.id})${plan.build.action === 'unchanged' ? ', attached' : ''}`,
    );
  }
  for (const iap of plan.iaps) {
    if (iap.action !== 'none') {
      lines.push(`  iap       ${iap.productId} ${iap.state}: ${iap.action}`);
    }
  }
  for (const [index, operation] of plan.operations.entries()) {
    lines.push(`  ${String(index + 1).padStart(2)}. ${operation}`);
  }
  for (const blocker of plan.blockers) {
    lines.push(`  BLOCKED   ${blocker}`);
  }
  for (const note of plan.notes) {
    lines.push(`  note      ${note}`);
  }
  for (const step of plan.manual) {
    lines.push(`  manual    ${step}`);
  }
  return lines.join('\n');
}

export interface AppStoreReleaseStatus {
  readonly appId: string;
  readonly version?: {
    readonly id: string;
    readonly versionString: string;
    readonly state: string;
    readonly releaseType?: string;
    readonly earliestReleaseDate?: string;
    readonly build?: { readonly id: string; readonly buildNumber?: string };
  };
  readonly submission?: {
    readonly id: string;
    readonly state: string;
    readonly submittedDate?: string;
    readonly items: readonly AscReviewSubmissionItem[];
  };
  readonly phasedRelease?: AscPhasedRelease;
  /** Where the release stands and what comes next, in a sentence. */
  readonly summary: string;
}

/** Where a version stands: its state, build, review submission and phased release. Reads only. */
export async function readAppStoreReleaseStatus(
  input: { readonly appId: string; readonly bundleId: string; readonly marketingVersion?: string },
  port: AscReleasePort,
): Promise<AppStoreReleaseStatus> {
  const app = await port.readApp(input.appId);
  if (app.bundleId !== input.bundleId) {
    throw new Error(
      `App Store Connect app ${input.appId} has bundle ID ${app.bundleId}, not ${input.bundleId} from the deployment profile.`,
    );
  }
  const versions = await port.listVersions(input.appId);
  const version = input.marketingVersion === undefined
    ? [...versions].sort((left, right) =>
        String(right.createdDate ?? '').localeCompare(String(left.createdDate ?? ''))
        // Without dates, the version not yet released is the one being worked on.
        || Number(inStates(left, releasedVersionStates)) - Number(inStates(right, releasedVersionStates)))[0]
    : versions.find((candidate) => candidate.versionString === input.marketingVersion);
  if (version === undefined) {
    return {
      appId: input.appId,
      summary: input.marketingVersion === undefined
        ? 'The app has no iOS version on App Store Connect yet.'
        : `iOS version ${input.marketingVersion} does not exist yet: "${appStoreReleasePlanCommand}" creates it.`,
    };
  }
  const [build, phased, submissions] = await Promise.all([
    port.readAttachedBuild(version.id),
    port.readPhasedRelease(version.id),
    port.listReviewSubmissions(input.appId),
  ]);
  // The newest submission holding this version.
  let submission: AppStoreReleaseStatus['submission'];
  const ordered = [...submissions].sort((left, right) =>
    Number(left.state === 'COMPLETE') - Number(right.state === 'COMPLETE')
    || String(right.submittedDate ?? '').localeCompare(String(left.submittedDate ?? '')));
  for (const candidate of ordered.slice(0, 10)) {
    const items = await port.listReviewSubmissionItems(candidate.id);
    if (items.some((item) => item.appStoreVersionId === version.id)) {
      submission = {
        id: candidate.id,
        state: candidate.state,
        ...(candidate.submittedDate === undefined ? {} : { submittedDate: candidate.submittedDate }),
        items,
      };
      break;
    }
  }
  const state = versionState(version);
  return {
    appId: input.appId,
    version: {
      id: version.id,
      versionString: version.versionString,
      state,
      ...(version.releaseType === undefined ? {} : { releaseType: version.releaseType }),
      ...(version.earliestReleaseDate === undefined ? {} : { earliestReleaseDate: version.earliestReleaseDate }),
      ...(build === undefined ? {} : { build }),
    },
    ...(submission === undefined ? {} : { submission }),
    ...(phased === undefined ? {} : { phasedRelease: phased }),
    summary: summarize(version, state, submission, phased),
  };
}

function summarize(
  version: AscReleaseVersion,
  state: string,
  submission: AppStoreReleaseStatus['submission'],
  phased: AscPhasedRelease | undefined,
): string {
  const name = `Version ${version.versionString}`;
  if (submission?.state === 'UNRESOLVED_ISSUES' || state === 'REJECTED' || state === 'METADATA_REJECTED') {
    return `${name} was returned by App Review: read the message in App Store Connect, fix it, and resubmit there.`;
  }
  if (inStates(version, editableVersionStates)) {
    return submission?.state === 'READY_FOR_REVIEW'
      ? `${name} is in preparation with an unsubmitted review submission ${submission.id}; apply the release plan to submit it.`
      : `${name} is in preparation (${state}); "${appStoreReleasePlanCommand}" lists what is left before review.`;
  }
  if (state === 'WAITING_FOR_REVIEW') {
    return `${name} is waiting for App Review${
      submission?.submittedDate === undefined ? '' : ` (submitted ${submission.submittedDate})`}.`;
  }
  if (state === 'IN_REVIEW') {
    return `${name} is in review.`;
  }
  if (state === 'WAITING_FOR_EXPORT_COMPLIANCE') {
    return `${name} waits for the build's export compliance answer in App Store Connect.`;
  }
  if (state === 'PENDING_DEVELOPER_RELEASE') {
    return `${name} is approved and waits for you: release it with "mpgd store release publish".`;
  }
  if (inStates(version, approvedVersionStates)) {
    return `${name} is approved (${state}); App Store Connect releases it as its release type says.`;
  }
  if (inStates(version, releasedVersionStates)) {
    return phased === undefined || phased.state === 'COMPLETE'
      ? `${name} is released (${state}).`
      : `${name} is released with a phased release ${phased.state}${
        phased.currentDayNumber === undefined ? '' : ` on day ${phased.currentDayNumber} of 7`}.`;
  }
  return `${name} is ${state}.`;
}

/** Release an approved version that waits for a manual release. */
export async function publishAppStoreVersion(
  input: {
    readonly appId: string;
    readonly bundleId: string;
    readonly marketingVersion: string;
    readonly approved: boolean;
  },
  port: AscReleasePort,
): Promise<{ readonly status: 'released' | 'unchanged'; readonly versionId: string; readonly state: string }> {
  if (!input.approved) {
    throw new Error('Releasing the App Store version requires --approve.');
  }
  const version = await findVersion(input, port);
  const state = versionState(version);
  if (inStates(version, releasedVersionStates)) {
    return { status: 'unchanged', versionId: version.id, state };
  }
  if (!inStates(version, new Set(['PENDING_DEVELOPER_RELEASE']))) {
    throw new Error(
      `Version ${version.versionString} is ${state}; only an approved version in PENDING_DEVELOPER_RELEASE is released by hand.`,
    );
  }
  await port.releaseVersion(version.id);
  return { status: 'released', versionId: version.id, state };
}

export type PhasedReleaseAction = 'pause' | 'resume' | 'complete';

/** Pause, resume or complete the phased release of a released version. */
export async function changeAppStorePhasedRelease(
  input: {
    readonly appId: string;
    readonly bundleId: string;
    readonly marketingVersion: string;
    readonly action: PhasedReleaseAction;
    readonly approved: boolean;
  },
  port: AscReleasePort,
): Promise<{ readonly status: 'updated' | 'unchanged'; readonly phasedReleaseId: string; readonly state: string }> {
  if (!['pause', 'resume', 'complete'].includes(input.action)) {
    throw new Error('--action must be pause, resume or complete.');
  }
  if (!input.approved) {
    throw new Error('Changing the phased release requires --approve.');
  }
  const version = await findVersion(input, port);
  const phased = await port.readPhasedRelease(version.id);
  if (phased === undefined) {
    throw new Error(`Version ${version.versionString} has no phased release.`);
  }
  const target = ({
    pause: 'PAUSED',
    resume: 'ACTIVE',
    complete: 'COMPLETE',
  } as const)[input.action];
  if (phased.state === target) {
    return { status: 'unchanged', phasedReleaseId: phased.id, state: phased.state };
  }
  const allowed: Record<typeof target, readonly string[]> = {
    PAUSED: ['ACTIVE'],
    ACTIVE: ['PAUSED'],
    COMPLETE: ['ACTIVE', 'PAUSED'],
  };
  if (!allowed[target].includes(phased.state)) {
    throw new Error(
      phased.state === 'INACTIVE'
        ? `The phased release of ${version.versionString} has not started; it starts when the version is released.`
        : `The phased release of ${version.versionString} is ${phased.state}; it cannot ${input.action}.`,
    );
  }
  await port.updatePhasedRelease({ phasedReleaseId: phased.id, state: target });
  return { status: 'updated', phasedReleaseId: phased.id, state: target };
}

async function findVersion(
  input: { readonly appId: string; readonly bundleId: string; readonly marketingVersion: string },
  port: AscReleasePort,
): Promise<AscReleaseVersion> {
  const app = await port.readApp(input.appId);
  if (app.bundleId !== input.bundleId) {
    throw new Error(
      `App Store Connect app ${input.appId} has bundle ID ${app.bundleId}, not ${input.bundleId} from the deployment profile.`,
    );
  }
  const version = (await port.listVersions(input.appId))
    .find((candidate) => candidate.versionString === input.marketingVersion);
  if (version === undefined) {
    throw new Error(`iOS version ${input.marketingVersion} is not on App Store Connect.`);
  }
  return version;
}
