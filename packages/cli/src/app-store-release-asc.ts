import { createAscIapPort } from './app-store-iap-asc.js';
import type { AscIapPort } from './app-store-iap-port.js';
import { createAscStorePresencePort } from './app-store-presence-asc.js';
import type { AscStorePresencePort } from './app-store-presence-port.js';
import type {
  AscAgeRating,
  AscPhasedRelease,
  AscReleaseBuild,
  AscReleasePort,
  AscReleaseVersion,
  AscReviewDetail,
  AscReviewDetailWrite,
  AscReviewSubmission,
  AscReviewSubmissionItem,
} from './app-store-release-port.js';
import {
  ascExitNotFound,
  ascListTimeoutMs,
  ascLookupTimeoutMs,
  isEmptyResource,
  isRecord,
  list,
  openAscSession,
  optionalString,
  relationshipId,
  requiredString,
  single,
  type AscCommandRunner,
  type AscCredential,
} from './asc-session.js';
import { ReleaseProcessError } from './deploy-process.js';

/**
 * The release port on the pinned `asc` 5.5.0 CLI. Commands (5.5.0 source,
 * `internal/cli/...`):
 *
 * - `apps view` (`apps/apps.go`)
 * - `versions list|create|update|attach-build|release` and
 *   `versions phased-release view|create|update|delete` (`versions/`)
 * - `builds list` (`builds/builds_commands.go`)
 * - `versions view --include-build` for the attached build
 * - `review details-for-version|details-create|details-update`
 *   (`reviews/review_details.go`): the output withholds the demo password
 *   as "(redacted)"; a version without details prints `configured: false`
 * - `age-rating view --app-info-id` (`agerating/age_rating.go`)
 * - `review submissions-list|submissions-create|submissions-submit` and
 *   `review items-list|items-add` (`reviews/`): items are listed with
 *   `--include`, which is what makes App Store Connect return their
 *   version relationships (asc's own `submit` does the same)
 *
 * asc takes the demo account password only as a command-line flag, so it is
 * visible in the local process list while that one `asc` call runs; it is
 * redacted from the captured output and never written to a file.
 */

export interface AscReleaseSession {
  readonly release: AscReleasePort;
  readonly presence: AscStorePresencePort;
  readonly iap: AscIapPort;
  close(): void;
}

/** Copy and verify the pinned binary; `close` removes it. */
export async function openAscReleaseSession(
  credential: AscCredential,
  options: { readonly signal?: AbortSignal; readonly secretValues?: readonly string[] } = {},
): Promise<AscReleaseSession> {
  const session = await openAscSession(credential, options.signal, options.secretValues);
  return {
    release: createAscReleasePort(session.run),
    presence: createAscStorePresencePort(session.run),
    iap: createAscIapPort(session.run),
    close: () => session.close(),
  };
}

// AgeRatingDeclaration content descriptors (App Store Connect API
// `AgeRatingDeclaration.Attributes`); a questionnaire never answered has none.
const ageRatingDescriptors = [
  'advertising',
  'alcoholTobaccoOrDrugUseOrReferences',
  'ageAssurance',
  'contests',
  'gambling',
  'gamblingSimulated',
  'gunsOrOtherWeapons',
  'healthOrWellnessTopics',
  'horrorOrFearThemes',
  'lootBox',
  'matureOrSuggestiveThemes',
  'medicalOrTreatmentInformation',
  'messagingAndChat',
  'parentalControls',
  'profanityOrCrudeHumor',
  'sexualContentGraphicAndNudity',
  'sexualContentOrNudity',
  'unrestrictedWebAccess',
  'userGeneratedContent',
  'violenceCartoonOrFantasy',
  'violenceRealistic',
  'violenceRealisticProlongedGraphicOrSadistic',
] as const;

/** The port over any runner; the tests drive it with recorded asc output. */
export function createAscReleasePort(run: AscCommandRunner): AscReleasePort {
  const optional = async (args: readonly string[]): Promise<unknown> => {
    try {
      return await run(args, ascLookupTimeoutMs);
    } catch (error) {
      if (error instanceof ReleaseProcessError && error.exitCode === ascExitNotFound) {
        return undefined;
      }
      throw error;
    }
  };
  return {
    async readApp(appId) {
      const app = single(await run(['apps', 'view', '--id', appId], ascLookupTimeoutMs), 'apps view');
      if (app.id !== appId) {
        throw new Error('asc apps view returned another app.');
      }
      return {
        bundleId: requiredString(app.attributes.bundleId, 'app bundle ID'),
        ...optionalString('primaryLocale', app.attributes.primaryLocale),
      };
    },
    async listVersions(appId) {
      return list(
        await run(['versions', 'list', '--app', appId, '--platform', 'IOS', '--paginate'], ascListTimeoutMs),
        'versions list',
      ).map((resource): AscReleaseVersion => ({
        id: resource.id,
        versionString: requiredString(resource.attributes.versionString, 'version string'),
        ...optionalString('state', resource.attributes.appVersionState ?? resource.attributes.appStoreState),
        ...optionalString('appStoreState', resource.attributes.appStoreState),
        ...optionalString('releaseType', resource.attributes.releaseType),
        ...optionalString('earliestReleaseDate', resource.attributes.earliestReleaseDate),
        ...optionalString('copyright', resource.attributes.copyright),
        ...optionalString('createdDate', resource.attributes.createdDate),
      }));
    },
    async listBuilds(input) {
      return list(await run([
        'builds', 'list',
        '--app', input.appId,
        '--version', input.marketingVersion,
        ...(input.buildNumber === undefined ? [] : ['--build-number', input.buildNumber]),
        '--platform', 'IOS',
        '--paginate',
      ], ascListTimeoutMs), 'builds list').map((resource): AscReleaseBuild => ({
        id: resource.id,
        buildNumber: requiredString(resource.attributes.version, 'build number'),
        ...optionalString('processingState', resource.attributes.processingState),
        ...(typeof resource.attributes.expired === 'boolean' ? { expired: resource.attributes.expired } : {}),
        ...(typeof resource.attributes.usesNonExemptEncryption === 'boolean'
          ? { usesNonExemptEncryption: resource.attributes.usesNonExemptEncryption }
          : {}),
        ...optionalString('uploadedDate', resource.attributes.uploadedDate),
      }));
    },
    async readAttachedBuild(versionId) {
      const result = await run(['versions', 'view', '--version-id', versionId, '--include-build'], ascLookupTimeoutMs);
      if (!isRecord(result) || result.id !== versionId) {
        throw new Error('asc versions view returned another version.');
      }
      return typeof result.buildId === 'string' && result.buildId !== ''
        ? { id: result.buildId, ...optionalString('buildNumber', result.buildVersion) }
        : undefined;
    },
    async readReviewDetail(versionId) {
      const response = await optional(['review', 'details-for-version', '--version-id', versionId]);
      if (response === undefined || isEmptyResource(response)
        || (isRecord(response) && response.configured === false)) {
        return undefined;
      }
      const detail = single(response, 'review details-for-version');
      const text = (key: string): Partial<Record<string, string>> => optionalString(key, detail.attributes[key]);
      return {
        id: detail.id,
        ...text('contactFirstName'),
        ...text('contactLastName'),
        ...text('contactEmail'),
        ...text('contactPhone'),
        ...text('demoAccountName'),
        ...text('notes'),
        demoAccountPasswordSet: typeof detail.attributes.demoAccountPassword === 'string'
          && detail.attributes.demoAccountPassword !== '',
        demoAccountRequired: detail.attributes.demoAccountRequired === true,
      } satisfies AscReviewDetail;
    },
    async readPhasedRelease(versionId) {
      const response = await optional(['versions', 'phased-release', 'view', '--version-id', versionId]);
      if (response === undefined || isEmptyResource(response)) {
        return undefined;
      }
      const phased = single(response, 'versions phased-release view');
      return {
        id: phased.id,
        state: requiredString(phased.attributes.phasedReleaseState, 'phased release state'),
        ...(typeof phased.attributes.currentDayNumber === 'number'
          ? { currentDayNumber: phased.attributes.currentDayNumber }
          : {}),
        ...optionalString('startDate', phased.attributes.startDate),
      } satisfies AscPhasedRelease;
    },
    async readAgeRating(appInfoId) {
      const response = await optional(['age-rating', 'view', '--app-info-id', appInfoId]);
      if (response === undefined || isEmptyResource(response)) {
        return undefined;
      }
      const declaration = single(response, 'age-rating view');
      return {
        id: declaration.id,
        answered: ageRatingDescriptors.filter((key) => {
          const value = declaration.attributes[key];
          return typeof value === 'boolean' || (typeof value === 'string' && value !== '');
        }),
      } satisfies AscAgeRating;
    },
    async listReviewSubmissions(appId) {
      return list(await run(
        ['review', 'submissions-list', '--app', appId, '--platform', 'IOS', '--paginate'],
        ascListTimeoutMs,
      ), 'review submissions-list').map((resource): AscReviewSubmission => ({
        id: resource.id,
        state: requiredString(resource.attributes.state, 'review submission state'),
        ...optionalString('submittedDate', resource.attributes.submittedDate),
      }));
    },
    async listReviewSubmissionItems(submissionId) {
      return list(await run([
        'review', 'items-list',
        '--submission', submissionId,
        '--include', 'appStoreVersion,inAppPurchaseVersion',
        '--paginate',
      ], ascListTimeoutMs), 'review items-list').map((resource): AscReviewSubmissionItem => ({
        id: resource.id,
        ...optionalString('state', resource.attributes.state),
        ...optionalString('appStoreVersionId', relationshipId(resource.relationships, 'appStoreVersion')),
        ...optionalString('inAppPurchaseVersionId', relationshipId(resource.relationships, 'inAppPurchaseVersion')),
      }));
    },
    async createVersion(input) {
      const result = await run([
        'versions', 'create',
        '--app', input.appId,
        '--version', input.versionString,
        '--platform', 'IOS',
        '--release-type', input.releaseType,
        ...(input.copyright === undefined ? [] : ['--copyright', input.copyright]),
      ], ascLookupTimeoutMs);
      if (!isRecord(result) || typeof result.id !== 'string' || result.id === ''
        || result.versionString !== input.versionString) {
        throw new Error('asc versions create returned no version.');
      }
      return result.id;
    },
    async updateVersion(input) {
      const flags = [
        ...(input.versionString === undefined ? [] : ['--version', input.versionString]),
        ...(input.copyright === undefined ? [] : ['--copyright', input.copyright]),
        ...(input.releaseType === undefined ? [] : ['--release-type', input.releaseType]),
        ...(input.earliestReleaseDate === undefined ? [] : ['--earliest-release-date', input.earliestReleaseDate]),
      ];
      if (flags.length === 0) {
        return;
      }
      await run(['versions', 'update', '--version-id', input.versionId, ...flags], ascLookupTimeoutMs);
    },
    async attachBuild(input) {
      const result = await run(
        ['versions', 'attach-build', '--version-id', input.versionId, '--build-id', input.buildId],
        ascLookupTimeoutMs,
      );
      if (!isRecord(result) || result.attached !== true || result.buildId !== input.buildId) {
        throw new Error('asc versions attach-build did not confirm the build.');
      }
    },
    async createReviewDetail(input) {
      await run(
        ['review', 'details-create', '--version-id', input.versionId, ...reviewDetailFlags(input.fields)],
        ascLookupTimeoutMs,
      );
    },
    async updateReviewDetail(input) {
      const flags = reviewDetailFlags(input.fields);
      if (flags.length === 0) {
        return;
      }
      await run(['review', 'details-update', '--id', input.detailId, ...flags], ascLookupTimeoutMs);
    },
    async createPhasedRelease(versionId) {
      await run(
        ['versions', 'phased-release', 'create', '--version-id', versionId, '--state', 'INACTIVE'],
        ascLookupTimeoutMs,
      );
    },
    async deletePhasedRelease(phasedReleaseId) {
      await run(['versions', 'phased-release', 'delete', '--id', phasedReleaseId, '--confirm'], ascLookupTimeoutMs);
    },
    async updatePhasedRelease(input) {
      await run([
        'versions', 'phased-release', 'update',
        '--id', input.phasedReleaseId,
        '--state', input.state,
        ...(input.state === 'COMPLETE' ? ['--confirm'] : []),
      ], ascLookupTimeoutMs);
    },
    async createReviewSubmission(appId) {
      return single(
        await run(['review', 'submissions-create', '--app', appId, '--platform', 'IOS'], ascLookupTimeoutMs),
        'review submissions-create',
      ).id;
    },
    async addReviewSubmissionItem(input) {
      await run([
        'review', 'items-add',
        '--submission', input.submissionId,
        '--item-type', input.type,
        '--item-id', input.id,
      ], ascLookupTimeoutMs);
    },
    async submitReviewSubmission(submissionId) {
      await run(['review', 'submissions-submit', '--id', submissionId, '--confirm'], ascLookupTimeoutMs);
    },
    async releaseVersion(versionId) {
      const result = await run(['versions', 'release', '--version-id', versionId, '--confirm'], ascLookupTimeoutMs);
      if (!isRecord(result) || result.versionId !== versionId || typeof result.releaseRequestId !== 'string') {
        throw new Error('asc versions release returned no release request.');
      }
    },
  };
}

const reviewDetailFlagNames = [
  ['contactFirstName', '--contact-first-name'],
  ['contactLastName', '--contact-last-name'],
  ['contactEmail', '--contact-email'],
  ['contactPhone', '--contact-phone'],
  ['notes', '--notes'],
  ['demoAccountName', '--demo-account-name'],
  ['demoAccountPassword', '--demo-account-password'],
] as const;

function reviewDetailFlags(fields: AscReviewDetailWrite): string[] {
  return [
    ...reviewDetailFlagNames.flatMap(([field, flag]) => {
      const value = fields[field];
      return value === undefined ? [] : [flag, value];
    }),
    // A Go boolean flag takes its value only in the `--flag=value` form.
    ...(fields.demoAccountRequired === undefined
      ? []
      : [`--demo-account-required=${String(fields.demoAccountRequired)}`]),
  ];
}
