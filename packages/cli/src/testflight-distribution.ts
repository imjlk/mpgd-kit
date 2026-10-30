import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { isRecord } from './asc-session.js';
import {
  assertLocalizedNotes,
  readLocalizedNotesFile,
  type PlayReleaseNote,
} from './play-release-options.js';
import type {
  TestFlightBetaReviewDetail,
  TestFlightBetaReviewDetailChanges,
  TestFlightBetaReviewSubmission,
  TestFlightBuildBetaState,
  TestFlightDistributionPort,
  TestFlightGroup,
} from './testflight-distribution-port.js';
import { classifyInternalBuildState } from './testflight-submission.js';

/**
 * TestFlight distribution of an already uploaded iOS build beyond the
 * internal group of `mpgd deploy submit`: more internal or external groups,
 * the build's "What to Test" per locale, the app's TestFlight review details
 * and, for an external group, the TestFlight App Review submission.
 *
 * Every run reads App Store Connect first and writes only what differs, so a
 * re-run never adds a group twice or submits a build again.
 */

/**
 * The build's TestFlight App Review state for external testers:
 *
 * - `not-needed`: no external group was asked for, or App Store Connect lets
 *   external testers have the build without a review submission (Apple: "the
 *   first build you submit requires a full review, but later builds for the
 *   same version might not")
 * - `not-submitted`: the build can be submitted (dry run, or a status read)
 * - `waiting-for-review`, `in-review`, `approved`, `rejected`
 * - `action-required`: TestFlight waits for the export-compliance answer
 */
export type TestFlightBetaReviewStatus = 'not-needed' | 'not-submitted' | 'waiting-for-review'
  | 'in-review' | 'approved' | 'rejected' | 'action-required';

export interface TestFlightBuildTarget {
  /** Numeric App Store Connect app ID. */
  readonly appStoreAppId: string;
  readonly bundleId: string;
  readonly marketingVersion: string;
  readonly buildNumber: string;
  /**
   * The build ID the release state recorded once the submission found the
   * build. `distribute` requires it; `status` matches by version and build
   * number without it and says so (`buildIdRecorded: false`).
   */
  readonly expectedBuildId?: string;
}

export interface TestFlightBetaReviewInput {
  readonly contactFirstName?: string;
  readonly contactLastName?: string;
  readonly contactEmail?: string;
  readonly contactPhone?: string;
  readonly notes?: string;
  readonly demoAccount?: {
    readonly required: boolean;
    /** Read from the environment variable the review file names. */
    readonly name?: string;
    /** Read from the environment variable the review file names; never printed. */
    readonly password?: string;
    readonly nameEnv?: string;
    readonly passwordEnv?: string;
    /**
     * Variables a dry run found unset (`requireValues: false`). A plan lists
     * them; `applyTestFlightDistribution` refuses them before any call.
     */
    readonly unresolvedEnv?: readonly string[];
  };
}

export interface TestFlightBetaReviewReadOptions {
  /** False for a dry run: unset demo account variables are reported, not refused. Default true. */
  readonly requireValues?: boolean;
}

export interface TestFlightDistributionOptions {
  /** Waits between membership reads after adding groups; tests pass a no-op. */
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export interface TestFlightDistributionRequest extends TestFlightBuildTarget {
  /** Group IDs or exact group names; internal and external groups may be mixed. */
  readonly groups: readonly string[];
  readonly whatToTest?: readonly PlayReleaseNote[];
  readonly betaReview?: TestFlightBetaReviewInput;
}

export type TestFlightGroupMembership = 'present' | 'add' | 'added' | 'after-review' | 'blocked';

export interface TestFlightDistributionReport {
  readonly dryRun: boolean;
  readonly appStoreAppId: string;
  readonly marketingVersion: string;
  readonly buildNumber: string;
  readonly buildId: string;
  readonly internalBuildState: string;
  readonly externalBuildState: string;
  readonly groups: readonly {
    readonly id: string;
    readonly name: string;
    readonly external: boolean;
    /**
     * `after-review`: App Store Connect accepts the group once the open review
     * ends. `blocked`: not added until the `action-required` step is done.
     */
    readonly membership: TestFlightGroupMembership;
  }[];
  readonly whatToTest: readonly {
    readonly locale: string;
    readonly action: 'unchanged' | 'create' | 'update';
  }[];
  /** Names of the review detail fields this run writes (or would write); never their values. */
  readonly reviewDetailFields: readonly string[];
  /** Inputs a dry run could not resolve, e.g. `demo account values: missing NAME`; apply needs them. */
  readonly pendingInputs?: readonly string[];
  readonly betaReview: {
    readonly status: TestFlightBetaReviewStatus;
    /** True when this run submits (dry run: would submit) the build. */
    readonly submit: boolean;
    readonly submissionId?: string;
  };
  readonly detail?: string;
}

export interface TestFlightStatusReport {
  readonly appStoreAppId: string;
  readonly marketingVersion: string;
  readonly buildNumber: string;
  readonly buildId?: string;
  /**
   * False when the release state has no build ID yet, so the build was
   * matched by app, version and build number only.
   */
  readonly buildIdRecorded: boolean;
  readonly processingState?: string;
  readonly internalBuildState?: string;
  readonly externalBuildState?: string;
  /** Groups that contain the build. */
  readonly groups: readonly { readonly id: string; readonly name: string; readonly external: boolean }[];
  /**
   * `build-not-ready`: not uploaded or still processing; poll again.
   * `build-unusable`: failed processing, expired or internal-only; it never
   * becomes testable, so stop polling.
   */
  readonly betaReview: TestFlightBetaReviewStatus | 'build-not-ready' | 'build-unusable';
  readonly submission?: TestFlightBetaReviewSubmission;
  readonly detail?: string;
}

/** App Store Connect `BetaAppReviewDetail.notes`: "a maximum of 4,000 characters". */
export const maximumBetaReviewNotesCharacters = 4000;
/** Waits before each re-read of the group membership after `builds add-groups`. */
const membershipRetryDelaysMs = [2_000, 5_000, 10_000] as const;
const groupReferencePattern = /^[^,\s](?:[^,]{0,98}[^,\s])?$/u;
const environmentNamePattern = /^[A-Z_][A-Z0-9_]*$/u;
const exportComplianceDetail = 'TestFlight is waiting for the export-compliance answer: answer it in App Store '
  + 'Connect, or ship ITSAppUsesNonExemptEncryption in Info.plist for later builds.';

/** Read App Store Connect and print what `applyTestFlightDistribution` would write. */
export async function planTestFlightDistribution(
  port: TestFlightDistributionPort,
  request: TestFlightDistributionRequest,
): Promise<TestFlightDistributionReport> {
  return toReport(await planDistribution(port, request), true);
}

/** Write the differences the plan found: What to Test, groups, review details, submission. */
export async function applyTestFlightDistribution(
  port: TestFlightDistributionPort,
  request: TestFlightDistributionRequest,
  options: TestFlightDistributionOptions = {},
): Promise<TestFlightDistributionReport> {
  const unresolved = request.betaReview?.demoAccount?.unresolvedEnv ?? [];
  if (unresolved.length > 0) {
    throw new Error(
      `TestFlight review demo account needs ${unresolved.join(', ')} in the environment.`,
    );
  }
  const sleep = options.sleep ?? defaultSleep;
  const plan = await planDistribution(port, request);
  if (plan.blocked) {
    return toReport(plan, false);
  }
  const written: string[] = [];
  const step = async <T>(label: string, action: () => Promise<T>): Promise<T> => {
    let result: T;
    try {
      result = await action();
    } catch (error) {
      const done = written.length === 0 ? 'nothing' : written.join(', ');
      throw new Error(
        `TestFlight distribution failed at ${label} (already written: ${done}); re-run the same `
          + `command, which skips what is already done: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    written.push(label);
    return result;
  };
  for (const note of plan.whatToTest.filter((entry) => entry.action !== 'unchanged')) {
    await step(`What to Test (${note.locale})`, () =>
      port.putWhatToTest(plan.build.id, note.locale, note.text),
    );
  }
  const toAdd = plan.groups.filter((group) => group.membership === 'add');
  if (toAdd.length > 0) {
    await step('group assignment', async () => {
      await port.addBuildToGroups(plan.build.id, toAdd.map((group) => group.group.id));
      // App Store Connect can list a new membership a moment late: read it a
      // few times before treating the assignment as unconfirmed.
      let missing: readonly PlannedGroup[] = toAdd;
      for (let attempt = 0; ; attempt += 1) {
        const present = new Set(await port.listBuildGroupIds(request.appStoreAppId, plan.build.id));
        missing = toAdd.filter((group) => !present.has(group.group.id));
        const delay = membershipRetryDelaysMs[attempt];
        if (missing.length === 0 || delay === undefined) {
          break;
        }
        await sleep(delay);
      }
      if (missing.length > 0) {
        throw new Error(
          `a membership read does not show the build in ${missing.map((group) => group.group.name).join(', ')}`,
        );
      }
    });
  }
  let betaReview = plan.betaReview;
  let detail = plan.detail;
  let submit = plan.submit;
  if (submit) {
    // Adding the external group may have changed the review state; submit
    // only a build that still waits for its first submission.
    const after = classifyExternalReview(
      (await port.readBuildBetaState(plan.build.id)).externalBuildState,
      latestSubmission(await port.listBetaReviewSubmissions(plan.build.id)),
    );
    if (after.kind !== 'status' || after.status !== 'not-submitted') {
      submit = false;
      betaReview = after.kind === 'status' ? { status: after.status } : { status: 'action-required' };
      detail = after.kind === 'status' ? detail : after.detail;
    }
  }
  if (submit) {
    const detailChanges = plan.reviewDetailChanges;
    if (detailChanges !== undefined && plan.reviewDetailId !== undefined) {
      const detailId = plan.reviewDetailId;
      await step('TestFlight review details', () =>
        port.updateBetaReviewDetail(detailId, detailChanges),
      );
    }
    const submission = await step('TestFlight App Review submission', () =>
      port.submitForBetaReview(plan.build.id),
    );
    betaReview = {
      status: classifySubmissionState(submission.betaReviewState) ?? 'waiting-for-review',
      submissionId: submission.id,
    };
  }
  // Review details are written only with a submission; when the recheck
  // cancelled it, none were written.
  const {
    reviewDetailChanges: _unwrittenChanges,
    reviewDetailPendingFields: _unwrittenPending,
    ...writtenPlan
  } = plan;
  return toReport(
    {
      ...(submit ? plan : writtenPlan),
      groups: plan.groups.map((group) =>
        group.membership === 'add' ? { ...group, membership: 'added' } : group,
      ),
      betaReview,
      submit,
      ...(detail === undefined ? {} : { detail }),
    },
    false,
  );
}

/** A read-only status of the build's TestFlight groups and App Review, for CI polling. */
export async function readTestFlightBuildStatus(
  port: TestFlightDistributionPort,
  target: TestFlightBuildTarget,
): Promise<TestFlightStatusReport> {
  assertBuildTarget(target);
  const base = {
    appStoreAppId: target.appStoreAppId,
    marketingVersion: target.marketingVersion,
    buildNumber: target.buildNumber,
    buildIdRecorded: target.expectedBuildId !== undefined,
  };
  await assertAppBundle(port, target);
  const build = await port.findBuild(
    target.appStoreAppId,
    target.marketingVersion,
    target.buildNumber,
  );
  if (build === undefined) {
    return {
      ...base,
      groups: [],
      betaReview: 'build-not-ready',
      detail: 'App Store Connect has no build with this version and build number yet.',
    };
  }
  assertExpectedBuild(target, build.id);
  if (build.processingState !== 'VALID') {
    const processing = build.processingState === 'PROCESSING';
    return {
      ...base,
      buildId: build.id,
      processingState: build.processingState,
      groups: [],
      betaReview: processing ? 'build-not-ready' : 'build-unusable',
      detail: processing
        ? 'App Store Connect is still processing the build; poll again.'
        : `App Store Connect reports ${build.processingState}; upload a new build.`,
    };
  }
  // One asc call at a time, like every other asc-backed port.
  const state = await port.readBuildBetaState(build.id);
  const groups = await port.listGroups(target.appStoreAppId);
  const memberIds = await port.listBuildGroupIds(target.appStoreAppId, build.id);
  const submissions = await port.listBetaReviewSubmissions(build.id);
  const members = new Set(memberIds);
  const submission = latestSubmission(submissions);
  const review = classifyExternalReview(state.externalBuildState, submission);
  return {
    ...base,
    buildId: build.id,
    processingState: build.processingState,
    internalBuildState: state.internalBuildState,
    externalBuildState: state.externalBuildState,
    groups: groups.filter((group) => members.has(group.id))
      .map((group) => ({ id: group.id, name: group.name, external: !group.isInternal })),
    betaReview: review.kind === 'status'
      ? review.status
      : review.kind === 'action-required'
        ? 'action-required'
        : review.kind === 'not-ready' ? 'build-not-ready' : 'build-unusable',
    ...(submission === undefined ? {} : { submission }),
    ...(review.kind === 'status' ? {} : { detail: review.detail }),
  };
}

/**
 * Read a TestFlight review details file. Contact fields and notes are plain
 * values; the demo account only names environment variables, which are read
 * here so a sign-in never sits in a committed file.
 *
 *     {
 *       "contactFirstName": "Ada", "contactLastName": "Kim",
 *       "contactEmail": "qa@example.com", "contactPhone": "+82 10 0000 0000",
 *       "notes": "Guest play; no sign-in needed.",
 *       "demoAccount": { "required": false }
 *     }
 *
 * With `"required": true`, `nameEnv` and `passwordEnv` name the variables.
 */
export function readTestFlightBetaReviewFile(
  file: string,
  environment: NodeJS.ProcessEnv = process.env,
  options: TestFlightBetaReviewReadOptions = {},
): TestFlightBetaReviewInput {
  const resolved = path.resolve(file);
  if (!existsSync(resolved) || !statSync(resolved).isFile() || statSync(resolved).size > 64 * 1024) {
    throw new Error(`TestFlight review details file is missing or larger than 64 KiB: ${resolved}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolved, 'utf8')) as unknown;
  } catch {
    throw new Error(`TestFlight review details file is not valid JSON: ${resolved}`);
  }
  return parseTestFlightBetaReview(parsed, environment, options);
}

export function parseTestFlightBetaReview(
  value: unknown,
  environment: NodeJS.ProcessEnv = process.env,
  options: TestFlightBetaReviewReadOptions = {},
): TestFlightBetaReviewInput {
  const textKeys = [
    'contactFirstName',
    'contactLastName',
    'contactEmail',
    'contactPhone',
    'notes',
  ] as const;
  if (!isRecord(value) || Object.keys(value).some((key) => key !== 'demoAccount'
    && !(textKeys as readonly string[]).includes(key))) {
    throw new Error(
      `TestFlight review details accept only ${[...textKeys, 'demoAccount'].join(', ')}; `
        + 'a demo account names environment variables (nameEnv, passwordEnv).',
    );
  }
  const result: Record<string, unknown> = {};
  for (const key of textKeys) {
    const text = value[key];
    if (text === undefined) {
      continue;
    }
    if (typeof text !== 'string' || text.trim() === '') {
      throw new Error(`TestFlight review detail ${key} must be a non-empty string.`);
    }
    result[key] = text.trim();
  }
  if (typeof result.notes === 'string' && [...result.notes].length > maximumBetaReviewNotesCharacters) {
    throw new Error(
      `TestFlight review notes allow ${maximumBetaReviewNotesCharacters} characters.`,
    );
  }
  if (typeof result.contactEmail === 'string' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(result.contactEmail)) {
    throw new Error('TestFlight review detail contactEmail is not an email address.');
  }
  const demo = value.demoAccount;
  if (demo !== undefined) {
    if (!isRecord(demo) || typeof demo.required !== 'boolean'
      || Object.keys(demo).some((key) => !['required', 'nameEnv', 'passwordEnv'].includes(key))) {
      throw new Error(
        'TestFlight review demoAccount takes required (boolean), nameEnv and passwordEnv: the names of '
          + 'environment variables, never the sign-in itself.',
      );
    }
    if (!demo.required) {
      if (demo.nameEnv !== undefined || demo.passwordEnv !== undefined) {
        throw new Error(
          'A TestFlight review demo account that is not required takes no nameEnv or passwordEnv.',
        );
      }
      result.demoAccount = { required: false };
    } else {
      const unresolved: string[] = [];
      const read = (key: 'nameEnv' | 'passwordEnv'): { readonly env: string; readonly value?: string } => {
        const name = demo[key];
        if (typeof name !== 'string' || !environmentNamePattern.test(name)) {
          throw new Error(
            `TestFlight review demoAccount.${key} must name an environment variable (A-Z, 0-9, _).`,
          );
        }
        const secret = environment[name];
        if (secret === undefined || secret.trim() === '') {
          if (options.requireValues !== false) {
            throw new Error(`TestFlight review demo account needs ${name} in the environment.`);
          }
          unresolved.push(name);
          return { env: name };
        }
        return { env: name, value: secret.trim() };
      };
      const name = read('nameEnv');
      const password = read('passwordEnv');
      result.demoAccount = {
        required: true,
        nameEnv: name.env,
        passwordEnv: password.env,
        ...(name.value === undefined ? {} : { name: name.value }),
        ...(password.value === undefined ? {} : { password: password.value }),
        ...(unresolved.length === 0 ? {} : { unresolvedEnv: unresolved }),
      };
    }
  }
  return result as TestFlightBetaReviewInput;
}

/** The "What to Test" file: the release-notes format of `--release-notes`, without Play's length limit. */
export function readTestFlightWhatToTestFile(file: string): PlayReleaseNote[] {
  return readLocalizedNotesFile(file, 'What to Test');
}

/** Split a `--groups` value into group IDs or names. */
export function parseTestFlightGroups(value: string): string[] {
  const groups = value.split(',').map((entry) => entry.trim()).filter((entry) => entry !== '');
  if (groups.length === 0) {
    throw new Error('--groups needs at least one TestFlight group ID or name.');
  }
  return groups;
}

interface PlannedGroup {
  readonly group: TestFlightGroup;
  readonly membership: TestFlightGroupMembership;
}

interface PlannedNote {
  readonly locale: string;
  readonly text: string;
  readonly action: 'unchanged' | 'create' | 'update';
}

interface DistributionPlan {
  readonly request: TestFlightDistributionRequest;
  readonly build: { readonly id: string };
  readonly state: TestFlightBuildBetaState;
  readonly groups: readonly PlannedGroup[];
  readonly whatToTest: readonly PlannedNote[];
  readonly reviewDetailId?: string;
  readonly reviewDetailChanges?: TestFlightBetaReviewDetailChanges;
  /** Demo account fields a dry run would write once their variables are set. */
  readonly reviewDetailPendingFields?: readonly string[];
  readonly submit: boolean;
  readonly betaReview: { readonly status: TestFlightBetaReviewStatus; readonly submissionId?: string };
  /** A state the operator must resolve first; nothing is written. */
  readonly blocked: boolean;
  readonly detail?: string;
}

async function planDistribution(
  port: TestFlightDistributionPort,
  request: TestFlightDistributionRequest,
): Promise<DistributionPlan> {
  assertBuildTarget(request);
  if (request.expectedBuildId === undefined) {
    throw new Error(
      `The release state has no App Store Connect build ID for iOS build ${request.marketingVersion} `
        + `(${request.buildNumber}) yet. Re-run "mpgd deploy submit --target ios" for this release until it `
        + 'reports testflight-ready, then retry.',
    );
  }
  if (request.groups.length === 0 || request.groups.some((group) => !groupReferencePattern.test(group))) {
    throw new Error('TestFlight distribution needs one or more group IDs or names (no commas).');
  }
  await assertAppBundle(port, request);
  const build = await port.findBuild(
    request.appStoreAppId,
    request.marketingVersion,
    request.buildNumber,
  );
  const label = `${request.marketingVersion} (${request.buildNumber})`;
  if (build === undefined) {
    throw new Error(
      `App Store Connect has no iOS build ${label} yet. Upload it with "mpgd deploy submit --target ios" `
        + '(or "deploy run") and retry once it appears.',
    );
  }
  assertExpectedBuild(request, build.id);
  if (build.processingState === 'PROCESSING') {
    throw new Error(
      `iOS build ${label} is still processing in App Store Connect; retry when processing ends `
        + '(re-run "mpgd deploy submit --target ios" until it reports testflight-ready).',
    );
  }
  if (build.processingState !== 'VALID') {
    throw new Error(
      `iOS build ${label} cannot be tested: App Store Connect reports ${build.processingState}.`,
    );
  }
  const groups = resolveGroups(
    request.groups,
    await port.listGroups(request.appStoreAppId),
    request.appStoreAppId,
  );
  const state = await port.readBuildBetaState(build.id);
  const hasExternal = groups.some((group) => !group.isInternal);
  const present = new Set(await port.listBuildGroupIds(request.appStoreAppId, build.id));
  const base = { request, build, state, whatToTest: [] as PlannedNote[], submit: false };
  if (groups.some((group) => group.isInternal && !present.has(group.id))) {
    const internal = classifyInternalBuildState(state.internalBuildState);
    if (internal?.status === 'action-required') {
      return blocked(base, groups, present, internal.detail ?? exportComplianceDetail);
    }
    if (internal !== undefined) {
      throw new Error(
        `iOS build ${label} is not ready for internal testers (TestFlight ${state.internalBuildState}); `
          + `${internal.detail ?? 'retry when its TestFlight processing ends.'}`,
      );
    }
  }
  let review: ExternalReview = { kind: 'status', status: 'not-needed' };
  let submission: TestFlightBetaReviewSubmission | undefined;
  if (hasExternal) {
    submission = latestSubmission(await port.listBetaReviewSubmissions(build.id));
    review = classifyExternalReview(state.externalBuildState, submission);
    if (review.kind === 'action-required') {
      return blocked(base, groups, present, review.detail);
    }
    if (review.kind !== 'status') {
      throw new Error(`iOS build ${label} cannot go to external testers yet: ${review.detail}`);
    }
  }
  const status = review.kind === 'status' ? review.status : 'not-needed';
  const reviewOpen = status === 'waiting-for-review' || status === 'in-review' || status === 'rejected';
  const plannedGroups = groups.map(
    (group): PlannedGroup => ({
      group,
      membership: present.has(group.id)
        ? 'present'
        : !group.isInternal && reviewOpen
          ? 'after-review'
          : 'add',
    }),
  );
  const whatToTest = planWhatToTest(
    request.whatToTest ?? [],
    await port.listWhatToTest(build.id),
    hasExternal,
  );
  const submit = hasExternal && status === 'not-submitted';
  let reviewDetailId: string | undefined;
  let reviewDetailChanges: TestFlightBetaReviewDetailChanges | undefined;
  let reviewDetailPendingFields: readonly string[] = [];
  if (submit) {
    const detail = await port.readBetaReviewDetail(request.appStoreAppId);
    reviewDetailId = detail.id;
    ({ changes: reviewDetailChanges, pendingFields: reviewDetailPendingFields } = planReviewDetail(
      detail,
      request.betaReview,
    ));
  }
  const waitingGroups = plannedGroups.filter((group) => group.membership === 'after-review');
  return {
    request,
    build,
    state,
    groups: plannedGroups,
    whatToTest,
    ...(reviewDetailId === undefined ? {} : { reviewDetailId }),
    ...(reviewDetailChanges === undefined ? {} : { reviewDetailChanges }),
    ...(reviewDetailPendingFields.length === 0 ? {} : { reviewDetailPendingFields }),
    submit,
    betaReview: { status, ...(submission === undefined ? {} : { submissionId: submission.id }) },
    blocked: false,
    ...(waitingGroups.length === 0 ? {} : {
      detail: `App Store Connect adds ${waitingGroups.map((group) => group.group.name).join(', ')} only `
        + (status === 'rejected'
          ? 'after the rejection is resolved in App Store Connect and the build passes review; re-run then.'
          : 'after the open TestFlight App Review ends; re-run then.'),
    }),
  };
}

function blocked(
  base: Pick<DistributionPlan, 'request' | 'build' | 'state' | 'whatToTest' | 'submit'>,
  groups: readonly TestFlightGroup[],
  present: ReadonlySet<string>,
  detail: string,
): DistributionPlan {
  return {
    ...base,
    groups: groups.map((group) => ({
      group,
      membership: present.has(group.id) ? 'present' : 'blocked',
    })),
    betaReview: { status: 'action-required' },
    blocked: true,
    detail,
  };
}

function resolveGroups(
  requested: readonly string[],
  groups: readonly TestFlightGroup[],
  appId: string,
): TestFlightGroup[] {
  const resolved = new Map<string, TestFlightGroup>();
  for (const reference of requested) {
    const byId = groups.find((group) => group.id === reference);
    const byName = groups.filter((group) => group.name === reference);
    if (byId === undefined && byName.length > 1) {
      throw new Error(
        `More than one TestFlight group of app ${appId} is named "${reference}"; pass its group ID `
          + `(${byName.map((group) => group.id).join(', ')}).`,
      );
    }
    const group = byId ?? byName[0];
    if (group === undefined) {
      const known = groups.map(
        (entry) => `${entry.name} (${entry.isInternal ? 'internal' : 'external'}, ${entry.id})`,
      );
      throw new Error(
        `TestFlight group "${reference}" does not exist for app ${appId}. Create it in App Store Connect `
          + `> TestFlight first (an external group needs an internal group to exist). Existing groups: `
          + `${known.length === 0 ? 'none' : known.join('; ')}.`,
      );
    }
    resolved.set(group.id, group);
  }
  return [...resolved.values()];
}

function planWhatToTest(
  requested: readonly PlayReleaseNote[],
  existing: readonly { readonly locale: string; readonly whatsNew?: string }[],
  hasExternal: boolean,
): PlannedNote[] {
  if (requested.length > 0) {
    assertLocalizedNotes(requested, 'What to Test');
  }
  if (hasExternal && requested.length === 0
    && !existing.some((entry) => (entry.whatsNew ?? '').trim() !== '')) {
    throw new Error(
      'External testers need the build\'s "What to Test": pass --what-to-test <file> '
        + '(<en-US>…</en-US> blocks or JSON, the --release-notes format).',
    );
  }
  return requested.map((note): PlannedNote => {
    const current = existing.find(
      (entry) => entry.locale.toLowerCase() === note.language.toLowerCase(),
    );
    const text = note.text.trim();
    return {
      locale: current?.locale ?? note.language,
      text,
      action: current === undefined
        ? 'create'
        : (current.whatsNew ?? '').trim() === text
          ? 'unchanged'
          : 'update',
    };
  });
}

/** The changes the review details need before a submission; throws when required ones stay missing. */
function planReviewDetail(
  detail: TestFlightBetaReviewDetail,
  input: TestFlightBetaReviewInput | undefined,
): {
  readonly changes: TestFlightBetaReviewDetailChanges | undefined;
  readonly pendingFields: readonly string[];
} {
  const changes: Record<string, string | boolean> = {};
  const effective: Record<string, string | undefined> = {};
  for (const key of [
    'contactFirstName',
    'contactLastName',
    'contactEmail',
    'contactPhone',
    'notes',
  ] as const) {
    const wanted = input?.[key];
    const current = detail[key]?.trim();
    if (wanted !== undefined && wanted !== current) {
      changes[key] = wanted;
    }
    effective[key] = wanted ?? current;
  }
  const demo = input?.demoAccount;
  const demoRequired = demo?.required ?? detail.demoAccountRequired;
  if (demo !== undefined && demo.required !== detail.demoAccountRequired) {
    changes.demoAccountRequired = demo.required;
  }
  // A dry run without the demo account variables plans their fields as
  // written; apply refuses to run until they are set.
  const unresolved = demo?.unresolvedEnv ?? [];
  const nameUnresolved = demo?.nameEnv !== undefined && unresolved.includes(demo.nameEnv);
  const passwordUnresolved = demo?.passwordEnv !== undefined && unresolved.includes(demo.passwordEnv);
  const pendingFields = [
    ...(nameUnresolved ? ['demoAccountName'] : []),
    ...(passwordUnresolved ? ['demoAccountPassword'] : []),
  ];
  if (demo?.required === true) {
    if (demo.name !== undefined && demo.name !== detail.demoAccountName?.trim()) {
      changes.demoAccountName = demo.name;
    }
    // A stored password cannot be read back, so the one from the environment
    // is always sent with the submission.
    if (demo.password !== undefined) {
      changes.demoAccountPassword = demo.password;
    }
  }
  const missing = [
    ...(['contactFirstName', 'contactLastName', 'contactEmail', 'contactPhone'] as const)
      .filter((key) => effective[key] === undefined || effective[key] === ''),
    ...(demoRequired && !nameUnresolved && (demo?.name ?? detail.demoAccountName ?? '') === ''
      ? ['demoAccountName'] : []),
    ...(demoRequired && !passwordUnresolved && demo?.password === undefined && !detail.demoAccountPasswordSet
      ? ['demoAccountPassword'] : []),
  ];
  if (missing.length > 0) {
    throw new Error(
      `TestFlight App Review needs review details that App Store Connect does not have: ${missing.join(', ')}. `
        + 'Add them to the --beta-review file (a demo account by nameEnv/passwordEnv environment variable '
        + 'names) or fill App Store Connect > TestFlight > Test Information, then retry.',
    );
  }
  return {
    changes: Object.keys(changes).length === 0
      ? undefined
      : changes as TestFlightBetaReviewDetailChanges,
    pendingFields,
  };
}

type ExternalReview =
  | { readonly kind: 'status'; readonly status: TestFlightBetaReviewStatus }
  | { readonly kind: 'action-required' | 'unusable' | 'not-ready'; readonly detail: string };

/**
 * App Store Connect `ExternalBetaState` and the build's
 * `BetaAppReviewSubmission.betaReviewState` (`BetaReviewState`).
 */
function classifyExternalReview(
  externalBuildState: string,
  submission: TestFlightBetaReviewSubmission | undefined,
): ExternalReview {
  const submitted = submission === undefined
    ? undefined
    : classifySubmissionState(submission.betaReviewState);
  if (submission !== undefined && submitted === undefined) {
    // Never submit again over a submission whose state is not understood.
    return {
      kind: 'action-required',
      detail: `TestFlight App Review submission ${submission.id} reports an unknown state `
        + `${submission.betaReviewState}; inspect it in App Store Connect (App Review > TestFlight) `
        + 'before running this again.',
    };
  }
  switch (externalBuildState) {
    case 'WAITING_FOR_BETA_REVIEW':
      return { kind: 'status', status: 'waiting-for-review' };
    case 'IN_BETA_REVIEW':
      return { kind: 'status', status: 'in-review' };
    case 'BETA_REJECTED':
      return { kind: 'status', status: 'rejected' };
    case 'BETA_APPROVED':
      return { kind: 'status', status: 'approved' };
    case 'READY_FOR_BETA_TESTING':
    // Not in Apple's current ExternalBetaState list; asc 5.5.0 still accepts
    // it as a value App Store Connect returned before the rename.
    case 'READY_FOR_TESTING':
    case 'IN_BETA_TESTING':
      // Testable by external testers; without a submission of its own, the
      // build did not need one.
      return { kind: 'status', status: submitted ?? 'not-needed' };
    case 'READY_FOR_BETA_SUBMISSION':
      // A submission App Store Connect has not reflected in the build state yet.
      return { kind: 'status', status: submitted ?? 'not-submitted' };
    case 'MISSING_EXPORT_COMPLIANCE':
      return { kind: 'action-required', detail: exportComplianceDetail };
    case 'IN_EXPORT_COMPLIANCE_REVIEW':
      return {
        kind: 'action-required',
        detail: 'Apple is reviewing the export-compliance documentation.',
      };
    case 'PROCESSING':
      return {
        kind: 'not-ready',
        detail: 'TestFlight is still processing the build for external testing; retry later.',
      };
    case 'NOT_APPLICABLE':
      return {
        kind: 'unusable',
        detail: 'App Store Connect reports NOT_APPLICABLE (a TestFlight Internal Only upload); upload a build eligible for App Store distribution.',
      };
    case 'PROCESSING_EXCEPTION':
    case 'EXPIRED':
      return { kind: 'unusable', detail: `TestFlight reports ${externalBuildState}.` };
    default:
      return {
        kind: 'unusable',
        detail: `TestFlight reports an unknown external state ${externalBuildState}.`,
      };
  }
}

function classifySubmissionState(state: string): TestFlightBetaReviewStatus | undefined {
  switch (state) {
    case 'WAITING_FOR_REVIEW':
      return 'waiting-for-review';
    case 'IN_REVIEW':
      return 'in-review';
    case 'REJECTED':
      return 'rejected';
    case 'APPROVED':
      return 'approved';
    default:
      return undefined;
  }
}

function latestSubmission(
  submissions: readonly TestFlightBetaReviewSubmission[],
): TestFlightBetaReviewSubmission | undefined {
  return [...submissions].sort((left, right) =>
    (right.submittedDate ?? '').localeCompare(left.submittedDate ?? ''),
  )[0];
}

function toReport(plan: DistributionPlan, dryRun: boolean): TestFlightDistributionReport {
  return {
    dryRun,
    appStoreAppId: plan.request.appStoreAppId,
    marketingVersion: plan.request.marketingVersion,
    buildNumber: plan.request.buildNumber,
    buildId: plan.build.id,
    internalBuildState: plan.state.internalBuildState,
    externalBuildState: plan.state.externalBuildState,
    groups: plan.groups.map((entry) => ({
      id: entry.group.id,
      name: entry.group.name,
      external: !entry.group.isInternal,
      membership: entry.membership,
    })),
    whatToTest: plan.whatToTest.map((note) => ({ locale: note.locale, action: note.action })),
    reviewDetailFields: [
      ...Object.keys(plan.reviewDetailChanges ?? {}),
      ...(plan.reviewDetailPendingFields ?? []),
    ],
    ...(unresolvedDemoEnv(plan.request).length === 0 ? {} : {
      pendingInputs: [`demo account values: missing ${unresolvedDemoEnv(plan.request).join(', ')}`],
    }),
    betaReview: {
      status: plan.betaReview.status,
      submit: plan.submit,
      ...(plan.betaReview.submissionId === undefined ? {} : { submissionId: plan.betaReview.submissionId }),
    },
    ...(plan.detail === undefined ? {} : { detail: plan.detail }),
  };
}

async function assertAppBundle(port: TestFlightDistributionPort, target: TestFlightBuildTarget): Promise<void> {
  if (await port.readAppBundleId(target.appStoreAppId) !== target.bundleId) {
    throw new Error('App Store Connect app ID does not match the recorded iOS bundle ID.');
  }
}

function assertExpectedBuild(target: TestFlightBuildTarget, buildId: string): void {
  if (target.expectedBuildId !== undefined && target.expectedBuildId !== buildId) {
    throw new Error(
      'The App Store Connect build differs from the build ID the release state recorded.',
    );
  }
}

function assertBuildTarget(target: TestFlightBuildTarget): void {
  if (!/^\d+$/u.test(target.appStoreAppId) || !/^\d+(?:\.\d+){0,2}$/u.test(target.marketingVersion)
    || !/^[1-9]\d*$/u.test(target.buildNumber) || target.bundleId.trim() === '') {
    throw new Error(
      'TestFlight distribution needs a numeric app ID and the recorded version and build number.',
    );
  }
}

function unresolvedDemoEnv(request: TestFlightDistributionRequest): readonly string[] {
  return request.betaReview?.demoAccount?.unresolvedEnv ?? [];
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
