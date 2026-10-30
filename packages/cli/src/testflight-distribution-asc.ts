import {
  ascListTimeoutMs,
  ascLookupTimeoutMs,
  isRecord,
  list,
  openAscSession,
  optionalString,
  requiredString,
  single,
  type AscCommandRunner,
  type AscCredential,
} from './asc-session.js';
import type {
  TestFlightBetaReviewDetail,
  TestFlightBetaReviewDetailChanges,
  TestFlightBetaReviewSubmission,
  TestFlightDistributionPort,
  TestFlightGroup,
  TestFlightWhatToTest,
} from './testflight-distribution-port.js';
import { readBuildGroupMembership } from './testflight-submission.js';

/**
 * The TestFlight distribution port on the pinned `asc` 5.5.0 CLI. Commands
 * (5.5.0 source, `internal/cli/...`):
 *
 * - `apps view`, `builds list` (`builds/builds_commands.go`)
 * - `testflight groups list --app` (App Store Connect `BetaGroup` resources) and
 *   `testflight groups list --build-id`, which prints asc's own membership
 *   result `{ buildId, appId, complete, groups: [{ id, type }] }`
 *   (`testflight/build_group_membership.go`)
 * - `builds build-beta-detail view` (`BuildBetaDetail`: `internalBuildState`,
 *   `externalBuildState`)
 * - `builds add-groups --build-id --group` without `--submit`
 *   (`builds/builds.go`); asc refuses an external group while the build waits
 *   for or failed TestFlight App Review
 * - `builds test-notes list|create` (`builds/build_test_notes.go`): the
 *   build's `BetaBuildLocalization` "What to Test"; create updates the locale
 *   when it exists
 * - `testflight review view|edit` (`testflight/testflight_review.go`): the app's
 *   `BetaAppReviewDetail`; asc prints a stored demo account password as
 *   `(redacted)`
 * - `testflight review submissions list` and `testflight review submit
 *   --confirm`: the build's `BetaAppReviewSubmission`
 */

/** Copy and verify the pinned binary; `close` removes it. */
export async function openAscTestFlightDistributionSession(
  credential: AscCredential,
  options: { readonly signal?: AbortSignal; readonly secretValues?: readonly string[] } = {},
): Promise<{ readonly port: TestFlightDistributionPort; close(): void }> {
  const session = await openAscSession(credential, options.signal, options.secretValues ?? []);
  return { port: createAscTestFlightDistributionPort(session.run), close: () => session.close() };
}

/** The port over any runner; the tests drive it with recorded asc output. */
export function createAscTestFlightDistributionPort(run: AscCommandRunner): TestFlightDistributionPort {
  return {
    async readAppBundleId(appId) {
      const app = single(await run(['apps', 'view', '--id', appId], ascLookupTimeoutMs), 'apps view');
      const bundleId = app.attributes.bundleId;
      if (app.id !== appId || typeof bundleId !== 'string') {
        throw new Error('asc apps view returned no bundle ID for the app.');
      }
      return bundleId;
    },
    async findBuild(appId, marketingVersion, buildNumber) {
      const builds = list(await run([
        'builds', 'list',
        '--app', appId,
        '--version', marketingVersion,
        '--build-number', buildNumber,
        '--platform', 'IOS',
        '--paginate',
      ], ascListTimeoutMs), 'builds list').filter((build) => build.attributes.version === buildNumber);
      if (builds.length > 1) {
        throw new Error('App Store Connect returned more than one build for this version and build number.');
      }
      const build = builds[0];
      return build === undefined ? undefined : {
        id: build.id,
        processingState: requiredString(build.attributes.processingState, 'build processing state'),
      };
    },
    async listGroups(appId) {
      return list(
        await run(['testflight', 'groups', 'list', '--app', appId, '--paginate'], ascListTimeoutMs),
        'testflight groups list',
      ).map((group): TestFlightGroup => {
        if (typeof group.attributes.isInternalGroup !== 'boolean') {
          throw new Error('asc testflight groups list returned a group without isInternalGroup.');
        }
        return {
          id: group.id,
          name: requiredString(group.attributes.name, 'TestFlight group name'),
          isInternal: group.attributes.isInternalGroup,
        };
      });
    },
    async readBuildBetaState(buildId) {
      const detail = single(
        await run(['builds', 'build-beta-detail', 'view', '--build-id', buildId], ascLookupTimeoutMs),
        'builds build-beta-detail view',
      );
      return {
        internalBuildState: requiredString(detail.attributes.internalBuildState, 'internal build state'),
        externalBuildState: requiredString(detail.attributes.externalBuildState, 'external build state'),
      };
    },
    async listBuildGroupIds(appId, buildId) {
      const result = await run(
        ['testflight', 'groups', 'list', '--build-id', buildId, '--app', appId],
        ascListTimeoutMs,
      );
      return readBuildGroupMembership(result, buildId).map((group) => group.id);
    },
    async addBuildToGroups(buildId, groupIds) {
      const result = await run(
        ['builds', 'add-groups', '--build-id', buildId, '--group', groupIds.join(',')],
        ascLookupTimeoutMs,
      );
      if (!isRecord(result) || result.action !== 'added' || result.buildId !== buildId
        || !Array.isArray(result.groupIds)
        || result.groupIds.some((id) => typeof id !== 'string' || !groupIds.includes(id))) {
        throw new Error('asc builds add-groups returned an unexpected result.');
      }
    },
    async listWhatToTest(buildId) {
      return list(
        await run(['builds', 'test-notes', 'list', '--build-id', buildId, '--paginate'], ascListTimeoutMs),
        'builds test-notes list',
      ).map((localization): TestFlightWhatToTest => ({
        id: localization.id,
        locale: requiredString(localization.attributes.locale, 'What to Test locale'),
        ...optionalString('whatsNew', localization.attributes.whatsNew),
      }));
    },
    async putWhatToTest(buildId, locale, text) {
      single(await run([
        'builds', 'test-notes', 'create',
        '--build-id', buildId,
        '--locale', locale,
        '--whats-new', text,
      ], ascLookupTimeoutMs), 'builds test-notes create');
    },
    async readBetaReviewDetail(appId) {
      const details = list(
        await run(['testflight', 'review', 'view', '--app', appId], ascLookupTimeoutMs),
        'testflight review view',
      );
      const detail = details[0];
      if (detail === undefined || details.length > 1) {
        throw new Error("asc testflight review view did not return the app's one review detail.");
      }
      const attributes = detail.attributes;
      return {
        id: detail.id,
        ...optionalString('contactFirstName', attributes.contactFirstName),
        ...optionalString('contactLastName', attributes.contactLastName),
        ...optionalString('contactEmail', attributes.contactEmail),
        ...optionalString('contactPhone', attributes.contactPhone),
        ...optionalString('notes', attributes.notes),
        ...optionalString('demoAccountName', attributes.demoAccountName),
        demoAccountPasswordSet: typeof attributes.demoAccountPassword === 'string'
          && attributes.demoAccountPassword !== '',
        // asc omits a false demoAccountRequired from its JSON.
        demoAccountRequired: attributes.demoAccountRequired === true,
      } satisfies TestFlightBetaReviewDetail;
    },
    async updateBetaReviewDetail(detailId, changes) {
      single(
        await run(['testflight', 'review', 'edit', '--id', detailId, ...reviewDetailFlags(changes)], ascLookupTimeoutMs),
        'testflight review edit',
      );
    },
    async listBetaReviewSubmissions(buildId) {
      return list(
        await run(
          ['testflight', 'review', 'submissions', 'list', '--build-id', buildId, '--paginate'],
          ascLookupTimeoutMs,
        ),
        'testflight review submissions list',
      ).map(readSubmission);
    },
    async submitForBetaReview(buildId) {
      return readSubmission(single(
        await run(['testflight', 'review', 'submit', '--build-id', buildId, '--confirm'], ascLookupTimeoutMs),
        'testflight review submit',
      ));
    },
  };
}

function readSubmission(resource: { readonly id: string; readonly attributes: Record<string, unknown> }): TestFlightBetaReviewSubmission {
  return {
    id: resource.id,
    betaReviewState: requiredString(resource.attributes.betaReviewState, 'beta review state'),
    ...optionalString('submittedDate', resource.attributes.submittedDate),
  };
}

function reviewDetailFlags(changes: TestFlightBetaReviewDetailChanges): string[] {
  const flags: string[] = [];
  const text = [
    ['--contact-first-name', changes.contactFirstName],
    ['--contact-last-name', changes.contactLastName],
    ['--contact-email', changes.contactEmail],
    ['--contact-phone', changes.contactPhone],
    ['--notes', changes.notes],
    ['--demo-account-name', changes.demoAccountName],
    // asc 5.5.0 takes the password only as a flag value; the session redacts
    // it from asc's output.
    ['--demo-account-password', changes.demoAccountPassword],
  ] as const;
  for (const [flag, value] of text) {
    if (value !== undefined) {
      flags.push(flag, value);
    }
  }
  if (changes.demoAccountRequired !== undefined) {
    flags.push(`--demo-account-required=${String(changes.demoAccountRequired)}`);
  }
  if (flags.length === 0) {
    throw new Error('A TestFlight review detail update needs at least one change.');
  }
  return flags;
}
