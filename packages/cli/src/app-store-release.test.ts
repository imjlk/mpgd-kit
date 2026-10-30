import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { assertStorePresence, type StorePresence } from '@mpgd/catalog';

import type { AscIap, AscIapPort, AscIapVersion } from './app-store-iap-port.js';
import type {
  AscAppInfo,
  AscScreenshotSet,
  AscStorePresencePort,
  AscVersionLocalization,
} from './app-store-presence-port.js';
import { createAscReleasePort, type AscReleaseSession } from './app-store-release-asc.js';
import {
  applyAppStoreReleaseCommand,
  changeAppStorePhasedReleaseCommand,
  planAppStoreReleaseCommand,
  publishAppStoreVersionCommand,
  readAppStoreReleaseStatusCommand,
  saveAppStoreReleasePlan,
} from './app-store-release-command.js';
import type {
  AscAgeRating,
  AscPhasedRelease,
  AscReleaseBuild,
  AscReleasePort,
  AscReleaseVersion,
  AscReviewDetail,
  AscReviewSubmission,
  AscReviewSubmissionItem,
} from './app-store-release-port.js';
import {
  applyAppStoreRelease,
  AppStoreReleaseApplyError,
  formatAppStoreReleasePlan,
  planAppStoreRelease,
  readAppStoreReleaseStatus,
  type AppStoreReleasePlanInput,
  type AppStoreReleaseRequest,
} from './app-store-release.js';
import { initializeDeployConfig } from './deploy-planning.js';
import { ReleaseProcessError } from './deploy-process.js';
import type { readNativeReleaseStatus } from './release-state.js';
import { StorePlanStaleError } from './store-sync.js';

const appId = '1234567890';
const bundleId = 'dev.mpgd.release';
const now = (): Date => new Date('2026-10-31T00:00:00Z');

interface AscState {
  bundleId: string;
  primaryLocale: string;
  versions: AscReleaseVersion[];
  builds: AscReleaseBuild[];
  attached: Map<string, { id: string; buildNumber?: string }>;
  reviewDetails: Map<string, AscReviewDetail>;
  passwords: Map<string, string>;
  phased: Map<string, AscPhasedRelease>;
  ageRating: AscAgeRating | undefined;
  submissions: AscReviewSubmission[];
  items: Map<string, AscReviewSubmissionItem[]>;
  localizations: Map<string, AscVersionLocalization[]>;
  sets: Map<string, AscScreenshotSet[]>;
  appInfos: AscAppInfo[];
  iaps: AscIap[];
  iapVersions: Map<string, AscIapVersion[]>;
}

interface FakeAsc {
  readonly ports: Omit<AscReleaseSession, 'close'>;
  readonly state: AscState;
  readonly writes: string[];
  failOn?: string | undefined;
  failWith?: Error | undefined;
}

const shots = (id: string, displayType: string): AscScreenshotSet => ({
  id,
  displayType,
  screenshots: [{ id: `${id}-1`, sourceFileChecksum: 'a'.repeat(32), deliveryState: 'COMPLETE' }],
});

/** An app with 1.0.0 live and 1.1.0 in preparation, build 42 processed, two purchases ready. */
function fakeAsc(initial: Partial<AscState> = {}): FakeAsc {
  let next = 0;
  const newId = (prefix: string): string => {
    next += 1;
    return `${prefix}-${next}`;
  };
  const writes: string[] = [];
  const state: AscState = {
    bundleId,
    primaryLocale: 'en-US',
    versions: [
      {
        id: 'v1',
        versionString: '1.0.0',
        state: 'READY_FOR_DISTRIBUTION',
        releaseType: 'MANUAL',
        copyright: '2026 Studio',
      },
      {
        id: 'v2',
        versionString: '1.1.0',
        state: 'PREPARE_FOR_SUBMISSION',
        releaseType: 'AFTER_APPROVAL',
      },
    ],
    builds: [
      { id: 'b41', buildNumber: '41', processingState: 'VALID', usesNonExemptEncryption: false },
      { id: 'b42', buildNumber: '42', processingState: 'VALID', usesNonExemptEncryption: false },
    ],
    attached: new Map(),
    reviewDetails: new Map(),
    passwords: new Map(),
    phased: new Map(),
    ageRating: { id: 'age-1', answered: ['violenceCartoonOrFantasy', 'gambling'] },
    submissions: [],
    items: new Map(),
    localizations: new Map([
      [
        'v2',
        [
          {
            id: 'vl-en',
            locale: 'en-US',
            description: 'd',
            keywords: 'k',
            supportUrl: 'https://example.com/support',
          },
          {
            id: 'vl-ko',
            locale: 'ko',
            description: 'd',
            keywords: 'k',
            supportUrl: 'https://example.com/support',
          },
        ],
      ],
    ]),
    sets: new Map([
      ['vl-en', [shots('set-iphone', 'APP_IPHONE_67'), shots('set-ipad', 'APP_IPAD_PRO_3GEN_129')]],
    ]),
    appInfos: [
      { id: 'info-live', state: 'READY_FOR_DISTRIBUTION' },
      { id: 'info-next', state: 'PREPARE_FOR_SUBMISSION' },
    ],
    iaps: [
      {
        id: 'iap-coins',
        productId: 'coins_100',
        name: 'Coins',
        inAppPurchaseType: 'CONSUMABLE',
        state: 'READY_TO_SUBMIT',
      },
      {
        id: 'iap-gems',
        productId: 'gems_10',
        name: 'Gems',
        inAppPurchaseType: 'CONSUMABLE',
        state: 'APPROVED',
      },
      {
        id: 'iap-noads',
        productId: 'no_ads',
        name: 'No ads',
        inAppPurchaseType: 'NON_CONSUMABLE',
        state: 'READY_TO_SUBMIT',
      },
    ],
    iapVersions: new Map([
      ['iap-coins', [{ id: 'iv-coins', version: 1, state: 'READY_FOR_REVIEW' }]],
      ['iap-noads', [{ id: 'iv-noads', version: 1, state: 'READY_FOR_REVIEW' }]],
    ]),
    ...initial,
  };
  const fake: FakeAsc = { state, writes, ports: undefined as unknown as FakeAsc['ports'] };
  const write = (step: string): void => {
    writes.push(step);
    if (fake.failOn !== undefined && step.startsWith(fake.failOn)) {
      fake.failOn = undefined;
      throw fake.failWith ?? new Error(`App Store Connect rejected ${step}`);
    }
  };
  const unused = (name: string) => async (): Promise<never> => {
    throw new Error(`unexpected ${name}`);
  };
  const release: AscReleasePort = {
    async readApp(app) {
      assert.equal(app, appId);
      return { bundleId: state.bundleId, primaryLocale: state.primaryLocale };
    },
    async listVersions() {
      return structuredClone(state.versions);
    },
    async listBuilds(input) {
      assert.equal(input.appId, appId);
      return structuredClone(state.builds.filter((build) =>
        input.buildNumber === undefined || build.buildNumber === input.buildNumber));
    },
    async readAttachedBuild(versionId) {
      return structuredClone(state.attached.get(versionId));
    },
    async readReviewDetail(versionId) {
      return structuredClone(state.reviewDetails.get(versionId));
    },
    async readPhasedRelease(versionId) {
      return structuredClone(state.phased.get(versionId));
    },
    async readAgeRating(appInfoId) {
      assert.equal(appInfoId, 'info-next', 'the age rating of the app information being prepared');
      return structuredClone(state.ageRating);
    },
    async listReviewSubmissions() {
      return structuredClone(state.submissions);
    },
    async listReviewSubmissionItems(submissionId) {
      return structuredClone(state.items.get(submissionId) ?? []);
    },
    async createVersion(input) {
      write(`create version ${input.versionString} ${input.releaseType}`);
      const id = newId('v');
      state.versions.push({
        id,
        versionString: input.versionString,
        state: 'PREPARE_FOR_SUBMISSION',
        releaseType: input.releaseType,
        ...(input.copyright === undefined ? {} : { copyright: input.copyright }),
      });
      return id;
    },
    async updateVersion(input) {
      write(`update version ${Object.keys(input).filter((key) => key !== 'versionId').sort().join(',')}`);
      const version = state.versions.find((candidate) => candidate.id === input.versionId);
      assert.ok(version !== undefined);
      Object.assign(version, {
        ...(input.versionString === undefined ? {} : { versionString: input.versionString }),
        ...(input.copyright === undefined ? {} : { copyright: input.copyright }),
        ...(input.releaseType === undefined ? {} : { releaseType: input.releaseType }),
        ...(input.earliestReleaseDate === undefined ? {} : { earliestReleaseDate: input.earliestReleaseDate }),
      });
    },
    async attachBuild(input) {
      write(`attach ${input.buildId}`);
      const build = state.builds.find((candidate) => candidate.id === input.buildId);
      state.attached.set(input.versionId, { id: input.buildId, buildNumber: String(build?.buildNumber) });
    },
    async createReviewDetail(input) {
      write(`review create ${Object.keys(input.fields).sort().join(',')}`);
      const { demoAccountPassword, ...fields } = input.fields;
      state.reviewDetails.set(input.versionId, {
        id: newId('rd'),
        ...fields,
        demoAccountRequired: fields.demoAccountRequired === true,
        demoAccountPasswordSet: demoAccountPassword !== undefined,
      });
      if (demoAccountPassword !== undefined) {
        state.passwords.set(input.versionId, demoAccountPassword);
      }
    },
    async updateReviewDetail(input) {
      write(`review update ${Object.keys(input.fields).sort().join(',')}`);
      for (const [versionId, detail] of state.reviewDetails) {
        if (detail.id === input.detailId) {
          const { demoAccountPassword, ...fields } = input.fields;
          state.reviewDetails.set(versionId, {
            ...detail,
            ...fields,
            demoAccountPasswordSet: detail.demoAccountPasswordSet || demoAccountPassword !== undefined,
          });
          if (demoAccountPassword !== undefined) {
            state.passwords.set(versionId, demoAccountPassword);
          }
        }
      }
    },
    async createPhasedRelease(versionId) {
      write('phased create');
      state.phased.set(versionId, { id: newId('phased'), state: 'INACTIVE' });
    },
    async deletePhasedRelease(phasedReleaseId) {
      write(`phased delete ${phasedReleaseId}`);
      for (const [versionId, phased] of state.phased) {
        if (phased.id === phasedReleaseId) {
          state.phased.delete(versionId);
        }
      }
    },
    async updatePhasedRelease(input) {
      write(`phased ${input.state}`);
      for (const [versionId, phased] of state.phased) {
        if (phased.id === input.phasedReleaseId) {
          state.phased.set(versionId, { ...phased, state: input.state });
        }
      }
    },
    async createReviewSubmission() {
      write('submission create');
      const id = newId('sub');
      state.submissions.push({ id, state: 'READY_FOR_REVIEW' });
      state.items.set(id, []);
      return id;
    },
    async addReviewSubmissionItem(input) {
      write(`item ${input.type} ${input.id}`);
      const items = state.items.get(input.submissionId) ?? [];
      items.push({
        id: newId('item'),
        state: 'READY_FOR_REVIEW',
        ...(input.type === 'appStoreVersions'
          ? { appStoreVersionId: input.id }
          : { inAppPurchaseVersionId: input.id }),
      });
      state.items.set(input.submissionId, items);
      // App Store Connect marks a version in an unsubmitted submission READY_FOR_REVIEW.
      const version = state.versions.find((candidate) => candidate.id === input.id);
      if (input.type === 'appStoreVersions' && version !== undefined) {
        Object.assign(version, { state: 'READY_FOR_REVIEW' });
      }
    },
    async submitReviewSubmission(submissionId) {
      write(`submit ${submissionId}`);
      const submission = state.submissions.find((candidate) => candidate.id === submissionId);
      assert.ok(submission !== undefined);
      Object.assign(submission, { state: 'WAITING_FOR_REVIEW', submittedDate: '2026-10-31T01:00:00Z' });
      for (const item of state.items.get(submissionId) ?? []) {
        const version = state.versions.find((candidate) => candidate.id === item.appStoreVersionId);
        if (version !== undefined) {
          Object.assign(version, { state: 'WAITING_FOR_REVIEW' });
        }
        const iap = state.iaps.find((candidate) =>
          state.iapVersions.get(candidate.id)?.some((entry) => entry.id === item.inAppPurchaseVersionId));
        if (iap !== undefined) {
          Object.assign(iap, { state: 'WAITING_FOR_REVIEW' });
        }
      }
    },
    async releaseVersion(versionId) {
      write(`release ${versionId}`);
      const version = state.versions.find((candidate) => candidate.id === versionId);
      assert.ok(version !== undefined);
      Object.assign(version, { state: 'READY_FOR_DISTRIBUTION' });
    },
  };
  const presence: AscStorePresencePort = {
    readAppBundleId: unused('readAppBundleId'),
    async listAppInfos() {
      return structuredClone(state.appInfos);
    },
    listAppInfoLocalizations: unused('listAppInfoLocalizations'),
    listVersions: unused('presence listVersions'),
    async listVersionLocalizations(versionId) {
      return structuredClone(state.localizations.get(versionId) ?? []);
    },
    async listScreenshotSets(localizationId) {
      return structuredClone(state.sets.get(localizationId) ?? []);
    },
    upsertAppInfoLocalization: unused('upsertAppInfoLocalization'),
    createVersionLocalization: unused('createVersionLocalization'),
    async updateVersionLocalization(input) {
      write(`whatsNew ${input.localizationId}`);
      assert.deepEqual(
        Object.keys(input.fields),
        ['whatsNew'],
        "the release writes only What's New",
      );
      for (const list of state.localizations.values()) {
        const entry = list.find((candidate) => candidate.id === input.localizationId);
        if (entry !== undefined) {
          Object.assign(entry, input.fields);
        }
      }
    },
    uploadScreenshot: unused('uploadScreenshot'),
    deleteScreenshot: unused('deleteScreenshot'),
  };
  const iap: AscIapPort = {
    readAppBundleId: unused('iap readAppBundleId'),
    async listIaps() {
      return structuredClone(state.iaps);
    },
    async listVersions(iapId) {
      return structuredClone(state.iapVersions.get(iapId) ?? []);
    },
    listLocalizations: unused('listLocalizations'),
    readPriceSchedule: unused('readPriceSchedule'),
    readAvailability: unused('readAvailability'),
    readReviewScreenshot: unused('readReviewScreenshot'),
    listTerritories: unused('listTerritories'),
    createIap: unused('createIap'),
    updateIap: unused('updateIap'),
    createVersion: unused('iap createVersion'),
    createLocalization: unused('createLocalization'),
    updateLocalization: unused('updateLocalization'),
    findPricePoint: unused('findPricePoint'),
    createPriceSchedule: unused('createPriceSchedule'),
    setAvailability: unused('setAvailability'),
    deleteReviewScreenshot: unused('deleteReviewScreenshot'),
    uploadReviewScreenshot: unused('uploadReviewScreenshot'),
  };
  (fake as { ports: FakeAsc['ports'] }).ports = { release, presence, iap };
  return fake;
}

const contact = {
  firstName: 'Dev',
  lastName: 'Support',
  email: 'dev@example.com',
  phone: '+82 10 1234 5678',
};
const locale = (whatsNew?: string): Record<string, unknown> => ({
  name: 'Block Party',
  description: 'Stack blocks.',
  keywords: 'blocks',
  supportUrl: 'https://example.com/support',
  ...(whatsNew === undefined ? {} : { whatsNew }),
});

function presenceFile(appStore: Record<string, unknown> = {}): StorePresence {
  return assertStorePresence({
    version: '1',
    appStore: {
      localizations: { 'en-US': locale('New puzzles.'), ko: locale('새 퍼즐.') },
      copyright: '2026 Studio',
      review: { contact, notes: 'Play as a guest from the title screen.' },
      ...appStore,
    },
  });
}

const request = (overrides: Partial<AppStoreReleaseRequest> = {}): AppStoreReleaseRequest => ({
  marketingVersion: '1.1.0',
  buildNumber: '42',
  universal: true,
  releaseType: 'MANUAL',
  phasedRelease: false,
  skipIaps: [],
  rotateDemoPassword: false,
  ...overrides,
});

const input = (overrides: Partial<AppStoreReleasePlanInput> = {}): AppStoreReleasePlanInput => ({
  appId,
  bundleId,
  presence: presenceFile(),
  request: request(),
  now,
  ...overrides,
});

const root = mkdtempSync(path.join(tmpdir(), 'mpgd-app-store-release-'));

try {
  // Plan: reuse the version in preparation and list every write in order.
  {
    const asc = fakeAsc();
    const plan = await planAppStoreRelease(input(), asc.ports);
    assert.deepEqual(asc.writes, [], 'plan never writes');
    assert.equal(plan.stage, 'prepare');
    assert.deepEqual(plan.version, {
      action: 'reuse',
      id: 'v2',
      state: 'PREPARE_FOR_SUBMISSION',
      first: false,
    });
    assert.deepEqual(plan.blockers, []);
    assert.deepEqual(plan.versionUpdate, { copyright: '2026 Studio', releaseType: 'MANUAL' });
    assert.deepEqual(plan.build, { id: 'b42', buildNumber: '42', action: 'attach' });
    assert.deepEqual(
      plan.iaps.map((iap) => [iap.productId, iap.action]),
      [
        ['coins_100', 'attach'],
        ['gems_10', 'none'],
        ['no_ads', 'attach'],
      ],
    );
    assert.deepEqual(plan.operations, [
      'update version settings: copyright "2026 Studio", release MANUAL',
      'attach build 42 (b42)',
      "write What's New for en-US (12 characters)",
      "write What's New for ko (5 characters)",
      'create App Review information: contactFirstName, contactLastName, contactEmail, contactPhone, notes, demoAccountRequired',
      'create an iOS review submission',
      'add version 1.1.0 to the review submission',
      'add in-app purchase coins_100 (version iv-coins) to the review submission',
      'add in-app purchase no_ads (version iv-noads) to the review submission',
      'submit for App Review',
    ]);
    assert.ok(
      plan.notes.some((note) => /no_ads: the app's first non-consumable/u.test(note)),
      'the first non-consumable goes with this version',
    );
    assert.ok(
      !plan.notes.some((note) => /coins_100: the app's first/u.test(note)),
      'gems_10 was the first consumable',
    );
    assert.ok(
      plan.manual.some((step) => /App Privacy/u.test(step)),
      'App Privacy stays manual',
    );
    const printed = formatAppStoreReleasePlan(plan);
    assert.match(printed, /iOS version 1\.1\.0: prepare and submit for review/u);
    assert.match(printed, / 10\. submit for App Review/u);

    // Apply performs exactly the plan, in order.
    const applied = await applyAppStoreRelease({
      saved: plan,
      plan: input(),
      ports: asc.ports,
      approved: true,
    });
    assert.equal(applied.status, 'submitted');
    assert.deepEqual(asc.writes, [
      'update version copyright,releaseType',
      'attach b42',
      'whatsNew vl-en',
      'whatsNew vl-ko',
      'review create contactEmail,contactFirstName,contactLastName,contactPhone,demoAccountRequired,notes',
      'submission create',
      'item appStoreVersions v2',
      'item inAppPurchaseVersions iv-coins',
      'item inAppPurchaseVersions iv-noads',
      `submit ${String(applied.submissionId)}`,
    ]);

    // Idempotent: the same plan again is a no-op, and a new plan finds the version submitted.
    const again = await applyAppStoreRelease({
      saved: plan,
      plan: input(),
      ports: asc.ports,
      approved: true,
    });
    assert.equal(again.status, 'unchanged');
    assert.equal(asc.writes.length, 10);
    const after = await planAppStoreRelease(input(), asc.ports);
    assert.equal(after.stage, 'submitted');
    assert.equal(after.changed, false);
    assert.match(formatAppStoreReleasePlan(after), /already submitted/u);
  }

  // Apply needs --approve, refuses a moved App Store Connect, and a dry run writes nothing.
  {
    const asc = fakeAsc();
    const plan = await planAppStoreRelease(input(), asc.ports);
    await assert.rejects(
      applyAppStoreRelease({ saved: plan, plan: input(), ports: asc.ports, approved: false }),
      /requires --approve/u,
    );
    const dry = await applyAppStoreRelease({
      saved: plan,
      plan: input(),
      ports: asc.ports,
      approved: false,
      dryRun: true,
    });
    assert.equal(dry.status, 'dry-run');
    assert.deepEqual(dry.steps, plan.operations);
    assert.deepEqual(asc.writes, []);
    asc.state.attached.set('v2', { id: 'b41', buildNumber: '41' });
    await assert.rejects(
      applyAppStoreRelease({ saved: plan, plan: input(), ports: asc.ports, approved: true }),
      (error: unknown) => error instanceof StorePlanStaleError && /changed since the plan/u.test(error.message),
    );
    await assert.rejects(
      applyAppStoreRelease({
        saved: plan,
        plan: input({ request: request({ marketingVersion: '1.2.0' }) }),
        ports: asc.ports,
        approved: true,
      }),
      StorePlanStaleError,
    );
    assert.deepEqual(asc.writes, []);
  }

  // Partial failure: the error names what landed; a new plan reuses the open submission.
  {
    const asc = fakeAsc();
    const plan = await planAppStoreRelease(input(), asc.ports);
    asc.failOn = 'item inAppPurchaseVersions iv-noads';
    asc.failWith = new ReleaseProcessError('exit', 'STATE_ERROR', 19);
    await assert.rejects(
      applyAppStoreRelease({ saved: plan, plan: input(), ports: asc.ports, approved: true }),
      (error: unknown) => error instanceof AppStoreReleaseApplyError
        && error.definitive
        && error.written.includes('create review submission')
        && /nothing from this step landed/u.test(error.message)
        && /add in-app purchase no_ads/u.test(error.message)
        && /the same plan would fail here again\. Add no_ads to version 1\.1\.0 by hand/u.test(error.message)
        && /--skip-iap no_ads/u.test(error.message),
    );
    await assert.rejects(
      applyAppStoreRelease({ saved: plan, plan: input(), ports: asc.ports, approved: true }),
      StorePlanStaleError,
      'the old plan is stale once part of it landed',
    );
    const resumed = await planAppStoreRelease(input(), asc.ports);
    assert.deepEqual(resumed.blockers, []);
    assert.equal(resumed.submission.action, 'reuse');
    assert.equal(resumed.build?.action, 'unchanged');
    assert.equal(resumed.reviewDetail.action, 'unchanged');
    assert.deepEqual(
      resumed.iaps.filter((iap) => iap.action !== 'none').map((iap) => [iap.productId, iap.action]),
      [
        ['coins_100', 'attached'],
        ['no_ads', 'attach'],
      ],
    );
    assert.deepEqual(resumed.operations, [
      'add in-app purchase no_ads (version iv-noads) to the review submission',
      'submit for App Review',
    ]);
    const before = asc.writes.length;
    const done = await applyAppStoreRelease({
      saved: resumed,
      plan: input(),
      ports: asc.ports,
      approved: true,
    });
    assert.equal(done.status, 'submitted');
    assert.deepEqual(asc.writes.slice(before), [
      'item inAppPurchaseVersions iv-noads',
      `submit ${String(done.submissionId)}`,
    ]);
    assert.equal(asc.state.submissions.length, 1, 'no second submission');
  }

  // A refused in-app purchase item: skip it, optionally add it by hand, and submit the rest.
  {
    const asc = fakeAsc();
    const plan = await planAppStoreRelease(input(), asc.ports);
    asc.failOn = 'item inAppPurchaseVersions iv-coins';
    asc.failWith = new ReleaseProcessError('exit', 'ENTITY_ERROR.RELATIONSHIP.INVALID', 19);
    await assert.rejects(
      applyAppStoreRelease({ saved: plan, plan: input(), ports: asc.ports, approved: true }),
      (error: unknown) => error instanceof AppStoreReleaseApplyError
        && /Add coins_100, no_ads to version 1\.1\.0 by hand/u.test(error.message)
        && /--skip-iap coins_100,no_ads/u.test(error.message)
        && !/Run "mpgd store release plan" again: it reads/u.test(error.message),
    );
    // An unknown result (a timeout) keeps the usual "plan again".
    const timedOut = fakeAsc();
    const timeoutPlan = await planAppStoreRelease(input(), timedOut.ports);
    timedOut.failOn = 'item inAppPurchaseVersions iv-coins';
    timedOut.failWith = new ReleaseProcessError('timeout', '');
    await assert.rejects(
      applyAppStoreRelease({ saved: timeoutPlan, plan: input(), ports: timedOut.ports, approved: true }),
      (error: unknown) => error instanceof AppStoreReleaseApplyError && !error.definitive
        && /Run "mpgd store release plan" again/u.test(error.message),
    );
    // The developer adds no_ads by hand, then skips both purchases: the plan submits what is there.
    const submissionId = String(asc.state.submissions[0]?.id);
    asc.state.items.get(submissionId)?.push({
      id: 'item-by-hand',
      state: 'READY_FOR_REVIEW',
      inAppPurchaseVersionId: 'iv-noads',
    });
    const skipping = input({ request: request({ skipIaps: ['coins_100', 'no_ads'] }) });
    const skipped = await planAppStoreRelease(skipping, asc.ports);
    assert.deepEqual(skipped.blockers, []);
    assert.deepEqual(skipped.operations, ['submit for App Review']);
    assert.ok(
      skipped.notes.some((note) =>
        /1 in-app purchase item\(s\) the plan did not add \(item-by-hand\)/u.test(note),
      ),
    );
    const submitted = await applyAppStoreRelease({
      saved: skipped,
      plan: skipping,
      ports: asc.ports,
      approved: true,
    });
    assert.equal(submitted.status, 'submitted');

    // A lost answer leaves the result unknown.
    const unsure = fakeAsc();
    const unsurePlan = await planAppStoreRelease(input(), unsure.ports);
    unsure.failOn = 'submit';
    unsure.failWith = new ReleaseProcessError('timeout', '');
    await assert.rejects(
      applyAppStoreRelease({ saved: unsurePlan, plan: input(), ports: unsure.ports, approved: true }),
      (error: unknown) => error instanceof AppStoreReleaseApplyError && !error.definitive
        && /result is unknown/u.test(error.message),
    );
    // The submit did not land: the version is READY_FOR_REVIEW in an unsubmitted
    // submission, and the next plan only submits it.
    unsure.state.submissions = unsure.state.submissions.map((submission) => ({
      ...submission,
      state: 'READY_FOR_REVIEW',
    }));
    assert.equal(
      unsure.state.versions.find((version) => version.id === 'v2')?.state,
      'READY_FOR_REVIEW',
    );
    const resubmit = await planAppStoreRelease(input(), unsure.ports);
    assert.equal(resubmit.stage, 'prepare');
    assert.deepEqual(resubmit.blockers, []);
    assert.deepEqual(resubmit.operations, ['submit for App Review']);
    const resubmitted = await applyAppStoreRelease({
      saved: resubmit,
      plan: input(),
      ports: unsure.ports,
      approved: true,
    });
    assert.equal(resubmitted.status, 'submitted');
    assert.equal(
      unsure.state.versions.find((version) => version.id === 'v2')?.state,
      'WAITING_FOR_REVIEW',
    );
  }

  // Create: no version yet, so apply creates it alone and the next plan goes on from there.
  {
    const asc = fakeAsc();
    asc.state.versions = asc.state.versions.filter((version) => version.id !== 'v2');
    const plan = await planAppStoreRelease(input(), asc.ports);
    assert.equal(plan.stage, 'create-version');
    assert.deepEqual(plan.operations, [
      'create iOS version 1.1.0 (release MANUAL, copyright "2026 Studio")',
    ]);
    assert.ok(plan.notes.some((note) => /store presence plan/u.test(note)));
    const applied = await applyAppStoreRelease({
      saved: plan,
      plan: input(),
      ports: asc.ports,
      approved: true,
    });
    assert.equal(applied.status, 'created-version');
    assert.deepEqual(asc.writes, ['create version 1.1.0 MANUAL']);
    assert.match(applied.next.join(' '), /store presence plan --store app-store/u);
    // The new version has no store page yet: the next plan says so.
    const next = await planAppStoreRelease(input(), asc.ports);
    assert.equal(next.stage, 'prepare');
    assert.ok(
      next.blockers.some((blocker) => /en-US: the version has no en-US localization/u.test(blocker)),
    );

    // A scheduled release is created manual; its date comes with the next plan.
    const scheduled = fakeAsc();
    scheduled.state.versions = scheduled.state.versions.filter((version) => version.id !== 'v2');
    const scheduledPlan = await planAppStoreRelease(
      input({
        request: request({
          releaseType: 'SCHEDULED',
          earliestReleaseDate: '2026-12-01T09:00:00+09:00',
        }),
      }),
      scheduled.ports,
    );
    assert.match(scheduledPlan.operations[0] ?? '', /release MANUAL/u);
  }

  // Rename: another version in preparation is reused under the new version string.
  {
    const asc = fakeAsc();
    const plan = await planAppStoreRelease(
      input({ request: request({ marketingVersion: '1.2.0' }) }),
      asc.ports,
    );
    assert.deepEqual(plan.version, {
      action: 'rename',
      id: 'v2',
      from: '1.1.0',
      state: 'PREPARE_FOR_SUBMISSION',
      first: false,
    });
    assert.equal(plan.operations[0], 'rename iOS version 1.1.0 to 1.2.0');
    // The builds of 1.2.0 are what count.
    asc.state.versions[1] = { ...asc.state.versions[1] as AscReleaseVersion, state: 'REJECTED' };
    const rejected = await planAppStoreRelease(
      input({ request: request({ marketingVersion: '1.2.0' }) }),
      asc.ports,
    );
    assert.ok(rejected.blockers.some((blocker) => /1\.1\.0 is REJECTED/u.test(blocker)));
    // A released version string is blocked, and its plan changes nothing.
    const released = await planAppStoreRelease(
      input({ request: request({ marketingVersion: '1.0.0' }) }),
      asc.ports,
    );
    assert.equal(released.stage, 'released');
    assert.equal(released.changed, false);
    assert.match(
      released.blockers.join('\n'),
      /already READY_FOR_DISTRIBUTION: submit a new marketing version/u,
    );
  }

  // Build selection.
  {
    const blockersFor = async (
      builds: AscReleaseBuild[],
      overrides: Partial<AppStoreReleaseRequest> & { readonly noBuildNumber?: true } = {},
    ): Promise<{ readonly blockers: readonly string[]; readonly build?: { readonly id: string } }> => {
      const asc = fakeAsc({ builds });
      const { noBuildNumber, ...rest } = overrides;
      const { buildNumber: _dropped, ...withoutBuildNumber } = request(rest);
      return planAppStoreRelease(
        input({ request: noBuildNumber === true ? withoutBuildNumber : request(rest) }),
        asc.ports,
      );
    };
    const valid = { processingState: 'VALID', usesNonExemptEncryption: false };
    assert.match(
      (await blockersFor([])).blockers.join('\n'),
      /Build 1\.1\.0 \(42\) is not on App Store Connect: upload it with "mpgd deploy run"/u,
    );
    assert.match(
      (await blockersFor([{ id: 'b42', buildNumber: '42', processingState: 'PROCESSING' }])).blockers.join(
        '\n',
      ),
      /\(42\) is still processing/u,
    );
    assert.match(
      (await blockersFor([{ id: 'b42', buildNumber: '42', processingState: 'FAILED' }])).blockers.join(
        '\n',
      ),
      /\(42\) is FAILED/u,
    );
    assert.match(
      (await blockersFor([{ id: 'b42', buildNumber: '42', processingState: 'INVALID' }])).blockers.join(
        '\n',
      ),
      /\(42\) is INVALID/u,
    );
    assert.match(
      (await blockersFor([{ id: 'b42', buildNumber: '42', ...valid, expired: true }])).blockers.join(
        '\n',
      ),
      /\(42\) has expired/u,
    );
    assert.match(
      (await blockersFor([{ id: 'b42', buildNumber: '42', processingState: 'VALID' }])).blockers.join(
        '\n',
      ),
      /\(42\) is missing export compliance/u,
    );
    // Without a build number: the newest build, compared as numbers.
    const newest = await blockersFor(
      [
        { id: 'b9', buildNumber: '9', ...valid },
        { id: 'b10', buildNumber: '10', ...valid },
      ],
      { noBuildNumber: true },
    );
    assert.equal(newest.build?.id, 'b10');
    const processing = await blockersFor(
      [
        { id: 'b9', buildNumber: '9', ...valid },
        { id: 'b10', buildNumber: '10', processingState: 'PROCESSING' },
      ],
      { noBuildNumber: true },
    );
    assert.match(processing.blockers.join('\n'), /\(10\) is still processing/u);
    assert.match(
      (await blockersFor([], { noBuildNumber: true })).blockers.join('\n'),
      /No build of version 1\.1\.0/u,
    );
    // The build deploy run recorded must be the one App Store Connect lists.
    await assert.rejects(
      blockersFor([{ id: 'b42', buildNumber: '42', ...valid }], { recordedBuildId: 'b-other' }),
      /not b-other that deploy run recorded/u,
    );
    // An attached build is replaced, and the plan says which.
    const asc = fakeAsc();
    asc.state.attached.set('v2', { id: 'b41', buildNumber: '41' });
    const replaced = await planAppStoreRelease(input(), asc.ports);
    assert.deepEqual(replaced.build, {
      id: 'b42',
      buildNumber: '42',
      action: 'attach',
      replaces: '41',
    });
    asc.state.attached.set('v2', { id: 'b42', buildNumber: '42' });
    assert.equal((await planAppStoreRelease(input(), asc.ports)).build?.action, 'unchanged');
  }

  // Fail closed: what App Review would refuse is a blocker, and apply refuses a plan with any.
  {
    const blockers = async (change: (asc: FakeAsc) => void, file = presenceFile()): Promise<string> => {
      const asc = fakeAsc();
      change(asc);
      const plan = await planAppStoreRelease(input({ presence: file }), asc.ports);
      if (plan.blockers.length > 0) {
        await assert.rejects(
          applyAppStoreRelease({
            saved: plan,
            plan: input({ presence: file }),
            ports: asc.ports,
            approved: true,
          }),
          /blocker\(s\); fix them and plan again/u,
        );
        assert.deepEqual(asc.writes, []);
      }
      return plan.blockers.join('\n');
    };
    assert.match(
      await blockers((asc) => asc.state.localizations.set('v2', (asc.state.localizations.get('v2') ?? []).slice(0, 1))),
      /ko: the version has no ko localization on App Store Connect\. Run "mpgd store presence plan/u,
    );
    assert.match(
      await blockers((asc) => asc.state.sets.set('vl-en', [shots('set-iphone', 'APP_IPHONE_67')])),
      /runs on iPad .* no 13-inch iPad screenshots/u,
    );
    {
      const asc = fakeAsc();
      asc.state.sets.set('vl-en', [shots('set-iphone', 'APP_IPHONE_65')]);
      const iphoneOnly = await planAppStoreRelease(
        input({ request: request({ universal: false }) }),
        asc.ports,
      );
      assert.deepEqual(iphoneOnly.blockers, [], 'an iPhone-only app needs no iPad screenshots');
    }
    assert.match(
      await blockers((asc) => asc.state.sets.set('vl-en', [])),
      /no 6\.9-inch \(or 6\.5-inch\) iPhone/u,
    );
    assert.match(await blockers((asc) => {
      asc.state.ageRating = { id: 'age-1', answered: [] };
    }), /age rating questionnaire is not answered/u);
    assert.match(await blockers((asc) => {
      asc.state.ageRating = undefined;
    }), /age rating questionnaire is not answered/u);
    assert.match(
      await blockers(() => undefined, presenceFile({ copyright: undefined })),
      /no copyright line: add appStore\.copyright/u,
    );
    assert.match(
      await blockers(() => undefined, presenceFile({ review: undefined })),
      /App Review needs a contact: add appStore\.review\.contact/u,
    );
    assert.match(
      await blockers(() => undefined, presenceFile({
        localizations: { 'en-US': locale('New.'), ko: locale() },
      })),
      /ko: What's New is required for an update/u,
    );
    assert.match(
      await blockers(() => undefined, presenceFile({ localizations: { 'en-US': locale('New.') } })),
      /ko: on App Store Connect but not in the store presence file, and it has no What's New/u,
    );
    assert.match(await blockers((asc) => {
      asc.state.submissions = [{ id: 'sub-old', state: 'WAITING_FOR_REVIEW' }];
      asc.state.items.set('sub-old', [{ id: 'item-event', state: 'READY_FOR_REVIEW' }]);
    }), /sub-old is WAITING_FOR_REVIEW: App Store Connect reviews one iOS submission at a time/u);
    assert.match(await blockers((asc) => {
      asc.state.submissions = [{ id: 'sub-1', state: 'UNRESOLVED_ISSUES' }];
      asc.state.items.set('sub-1', [{ id: 'item-v', state: 'REJECTED', appStoreVersionId: 'v2' }]);
    }), /unresolved issues from App Review/u);
    assert.match(await blockers((asc) => {
      asc.state.submissions = [{ id: 'sub-1', state: 'READY_FOR_REVIEW' }];
      asc.state.items.set('sub-1', [{ id: 'item-event', state: 'READY_FOR_REVIEW' }]);
    }), /sub-1 already holds 1 other item\(s\) \(item-event\)/u);
    assert.match(await blockers((asc) => {
      asc.state.versions.push({ id: 'v0', versionString: '1.0.1', state: 'PENDING_DEVELOPER_RELEASE' });
    }), /1\.0\.1 is PENDING_DEVELOPER_RELEASE: wait until App Review finishes it/u);
    // A first version takes no What's New.
    const firstApp = fakeAsc();
    firstApp.state.versions = firstApp.state.versions.filter((version) => version.id !== 'v1');
    const firstPlan = await planAppStoreRelease(input(), firstApp.ports);
    assert.equal(firstPlan.version.first, true);
    assert.deepEqual(firstPlan.whatsNew, []);
    assert.ok(
      firstPlan.notes.some((note) =>
        /first version: App Store Connect takes no What's New/u.test(note),
      ),
    );
  }

  // In-app purchases: unfinished ones block unless skipped; an open submission's items count.
  {
    const asc = fakeAsc();
    asc.state.iaps.push({
      id: 'iap-pass',
      productId: 'season_pass',
      name: 'Pass',
      inAppPurchaseType: 'NON_CONSUMABLE',
      state: 'MISSING_METADATA',
    });
    const blocked = await planAppStoreRelease(input(), asc.ports);
    assert.match(
      blocked.blockers.join('\n'),
      /season_pass is MISSING_METADATA: finish it with "mpgd store products apply --store app-store".*--skip-iap season_pass/u,
    );
    const skipped = await planAppStoreRelease(
      input({ request: request({ skipIaps: ['season_pass'] }) }),
      asc.ports,
    );
    assert.deepEqual(skipped.blockers, []);
    assert.equal(skipped.iaps.find((iap) => iap.productId === 'season_pass')?.action, 'skip');
    await assert.rejects(
      planAppStoreRelease(input({ request: request({ skipIaps: ['nope'] }) }), asc.ports),
      /--skip-iap nope is not an in-app purchase of this app/u,
    );
    // Skipping every first non-consumable leaves a note.
    const allSkipped = await planAppStoreRelease(
      input({ request: request({ skipIaps: ['no_ads', 'season_pass'] }) }),
      asc.ports,
    );
    assert.ok(
      allSkipped.notes.some((note) =>
        /No non-consumable purchase goes with this version/u.test(note),
      ),
    );
    // Two versions that could go to review are ambiguous.
    asc.state.iapVersions.set('iap-coins', [
      { id: 'iv-a', version: 1, state: 'READY_FOR_REVIEW' },
      { id: 'iv-b', version: 2, state: 'PREPARE_FOR_SUBMISSION' },
    ]);
    const ambiguous = await planAppStoreRelease(
      input({ request: request({ skipIaps: ['season_pass'] }) }),
      asc.ports,
    );
    assert.match(ambiguous.blockers.join('\n'), /coins_100 is READY_TO_SUBMIT but has 2 versions/u);
    // A draft submission that already holds the version and a purchase is reused.
    const draft = fakeAsc();
    draft.state.submissions = [{ id: 'sub-draft', state: 'READY_FOR_REVIEW' }];
    draft.state.items.set('sub-draft', [
      { id: 'item-v', state: 'READY_FOR_REVIEW', appStoreVersionId: 'v2' },
      { id: 'item-c', state: 'READY_FOR_REVIEW', inAppPurchaseVersionId: 'iv-coins' },
      { id: 'item-gone', state: 'REMOVED', inAppPurchaseVersionId: 'iv-old' },
    ]);
    const reused = await planAppStoreRelease(input(), draft.ports);
    assert.deepEqual(reused.blockers, []);
    assert.deepEqual(reused.submission, {
      action: 'reuse',
      id: 'sub-draft',
      state: 'READY_FOR_REVIEW',
      addVersion: false,
      submit: true,
    });
    assert.equal(reused.iaps.find((iap) => iap.productId === 'coins_100')?.action, 'attached');
  }

  // App Review information: the demo account comes from the environment, its password is never planned.
  {
    const asc = fakeAsc();
    const file = presenceFile({
      review: { contact, demoAccount: { nameEnv: 'DEMO_NAME', passwordEnv: 'DEMO_PASSWORD' } },
    });
    const unset = await planAppStoreRelease(
      input({
        presence: file,
        demoAccountProblems: ['appStore.review.demoAccount names DEMO_PASSWORD, which is not set'],
      }),
      asc.ports,
    );
    assert.deepEqual(unset.blockers, [
      'appStore.review.demoAccount names DEMO_PASSWORD, which is not set',
    ]);
    assert.equal(unset.reviewDetail.action, 'unchanged');
    const noReason = await planAppStoreRelease(input({ presence: file }), asc.ports);
    assert.match(noReason.blockers.join('\n'), /Set DEMO_NAME and DEMO_PASSWORD/u);
    const demoAccount = { name: 'reviewer@example.com', password: 'sup3r-secret' };
    const plan = await planAppStoreRelease(input({ presence: file, demoAccount }), asc.ports);
    assert.deepEqual(plan.reviewDetail.fields, [
      'contactFirstName',
      'contactLastName',
      'contactEmail',
      'contactPhone',
      'demoAccountRequired',
      'demoAccountName',
      'demoAccountPassword',
    ]);
    const serialized = JSON.stringify(plan);
    assert.ok(
      !serialized.includes('sup3r-secret') && !serialized.includes('reviewer@example.com'),
      'no secret in the plan',
    );
    await applyAppStoreRelease({
      saved: plan,
      plan: input({ presence: file, demoAccount }),
      ports: asc.ports,
      approved: true,
    });
    assert.equal(asc.state.passwords.get('v2'), 'sup3r-secret');
    // Re-planned on the same version: nothing to send, the password is kept.
    asc.state.versions[1] = { ...asc.state.versions[1] as AscReleaseVersion, state: 'PREPARE_FOR_SUBMISSION' };
    asc.state.submissions = [];
    const kept = await planAppStoreRelease(input({ presence: file, demoAccount }), asc.ports);
    assert.equal(kept.reviewDetail.action, 'unchanged');
    assert.ok(kept.notes.some((note) => /--rotate-demo-password/u.test(note)));
    const rotated = await planAppStoreRelease(
      input({ presence: file, demoAccount, request: request({ rotateDemoPassword: true }) }),
      asc.ports,
    );
    assert.deepEqual(rotated.reviewDetail.fields, ['demoAccountPassword']);
    // A different demo account in the environment makes the reviewed plan stale.
    await assert.rejects(
      applyAppStoreRelease({
        saved: rotated,
        plan: input({
          presence: file,
          demoAccount: { name: 'other@example.com', password: 'x' },
          request: request({ rotateDemoPassword: true }),
        }),
        ports: asc.ports,
        approved: true,
      }),
      StorePlanStaleError,
    );
  }

  // Release options: release type, scheduled date, phased release on and off.
  {
    const asc = fakeAsc();
    await assert.rejects(
      planAppStoreRelease(input({ request: request({ releaseType: 'SCHEDULED' }) }), asc.ports),
      /needs --release-date/u,
    );
    await assert.rejects(
      planAppStoreRelease(
        input({
          request: request({
            releaseType: 'SCHEDULED',
            earliestReleaseDate: '2026-01-01T00:00:00Z',
          }),
        }),
        asc.ports,
      ),
      /is not in the future/u,
    );
    await assert.rejects(
      planAppStoreRelease(
        input({ request: request({ earliestReleaseDate: '2026-12-01T00:00:00Z' }) }),
        asc.ports,
      ),
      /applies only to --release-type scheduled/u,
    );
    await assert.rejects(
      planAppStoreRelease(
        input({
          request: request({ releaseType: 'SCHEDULED', earliestReleaseDate: '2026-12-01T09:00' }),
        }),
        asc.ports,
      ),
      /ISO 8601 date and time/u,
      'a date without an offset is ambiguous',
    );
    {
      // A date already on App Store Connect may have passed: nothing is written, nothing refused.
      const set = fakeAsc();
      Object.assign(set.state.versions[1] as AscReleaseVersion, {
        releaseType: 'SCHEDULED',
        earliestReleaseDate: '2026-10-01T00:00:00Z',
      });
      const kept = await planAppStoreRelease(
        input({
          request: request({
            releaseType: 'SCHEDULED',
            earliestReleaseDate: '2026-10-01T00:00:00Z',
          }),
        }),
        set.ports,
      );
      assert.deepEqual(kept.versionUpdate, { copyright: '2026 Studio' });
    }
    const scheduled = await planAppStoreRelease(
      input({
        request: request({
          releaseType: 'SCHEDULED',
          earliestReleaseDate: '2026-12-01T09:00:00+09:00',
          phasedRelease: true,
        }),
      }),
      asc.ports,
    );
    assert.deepEqual(scheduled.versionUpdate, {
      copyright: '2026 Studio',
      releaseType: 'SCHEDULED',
      earliestReleaseDate: '2026-12-01T09:00:00+09:00',
    });
    assert.equal(scheduled.phasedRelease.action, 'create');
    assert.ok(
      scheduled.operations.includes(
        'turn on phased release (7 days, starting when the version is released)',
      ),
    );
    asc.state.phased.set('v2', { id: 'phased-1', state: 'INACTIVE' });
    const off = await planAppStoreRelease(input(), asc.ports);
    assert.deepEqual(off.phasedRelease, { action: 'delete', id: 'phased-1', state: 'INACTIVE' });
    await applyAppStoreRelease({ saved: off, plan: input(), ports: asc.ports, approved: true });
    assert.ok(asc.writes.includes('phased delete phased-1'));
  }

  // The asc adapter: the commands it runs and how it reads their output.
  {
    const calls: string[][] = [];
    const responses: [string, unknown][] = [
      [
        'apps view',
        { data: { type: 'apps', id: appId, attributes: { bundleId, primaryLocale: 'en-US' } } },
      ],
      [
        'versions list',
        {
          data: [
            {
              type: 'appStoreVersions',
              id: 'v2',
              attributes: {
                versionString: '1.1.0',
                appVersionState: 'PREPARE_FOR_SUBMISSION',
                appStoreState: 'PREPARE_FOR_SUBMISSION',
                releaseType: 'MANUAL',
                copyright: '2026 Studio',
              },
            },
          ],
        },
      ],
      [
        'builds list',
        {
          data: [
            {
              type: 'builds',
              id: 'b42',
              attributes: {
                version: '42',
                processingState: 'VALID',
                expired: false,
                usesNonExemptEncryption: false,
              },
            },
          ],
        },
      ],
      ['versions view', { id: 'v2', versionString: '1.1.0', buildId: 'b42', buildVersion: '42' }],
      [
        'review details-for-version',
        { versionId: 'v2', configured: false, message: 'not configured' },
      ],
      ['versions phased-release view', { data: { type: '', id: '' } }],
      [
        'age-rating view',
        {
          data: {
            type: 'ageRatingDeclarations',
            id: 'age-1',
            attributes: {
              violenceCartoonOrFantasy: 'INFREQUENT_OR_MILD',
              gambling: false,
              kidsAgeBand: 'FIVE_AND_UNDER',
            },
          },
        },
      ],
      [
        'review submissions-list',
        {
          data: [
            {
              type: 'reviewSubmissions',
              id: 'sub-1',
              attributes: {
                platform: 'IOS',
                state: 'READY_FOR_REVIEW',
              },
            },
          ],
        },
      ],
      [
        'review items-list',
        {
          data: [
            {
              type: 'reviewSubmissionItems',
              id: 'item-1',
              attributes: { state: 'READY_FOR_REVIEW' },
              relationships: {
                appStoreVersion: { data: { type: 'appStoreVersions', id: 'v2' } },
                inAppPurchaseVersion: { data: { type: '', id: '' } },
              },
            },
          ],
        },
      ],
      [
        'versions create',
        { id: 'v3', versionString: '1.2.0', platform: 'IOS', state: 'PREPARE_FOR_SUBMISSION' },
      ],
      ['versions attach-build', { versionId: 'v2', buildId: 'b42', attached: true }],
      [
        'review submissions-create',
        {
          data: {
            type: 'reviewSubmissions',
            id: 'sub-2',
            attributes: { state: 'READY_FOR_REVIEW' },
          },
        },
      ],
      ['versions release', { releaseRequestId: 'rr-1', versionId: 'v2' }],
    ];
    const port = createAscReleasePort(async (args) => {
      calls.push([...args]);
      const joined = args.join(' ');
      const match = responses.find(([prefix]) => joined.startsWith(prefix));
      return structuredClone(match?.[1] ?? { data: { type: 'x', id: 'ok' } });
    });
    assert.deepEqual(await port.readApp(appId), { bundleId, primaryLocale: 'en-US' });
    assert.deepEqual(await port.listVersions(appId), [
      {
        id: 'v2',
        versionString: '1.1.0',
        state: 'PREPARE_FOR_SUBMISSION',
        appStoreState: 'PREPARE_FOR_SUBMISSION',
        releaseType: 'MANUAL',
        copyright: '2026 Studio',
      },
    ]);
    assert.deepEqual(
      await port.listBuilds({ appId, marketingVersion: '1.1.0', buildNumber: '42' }),
      [
        {
          id: 'b42',
          buildNumber: '42',
          processingState: 'VALID',
          expired: false,
          usesNonExemptEncryption: false,
        },
      ],
    );
    assert.deepEqual(calls.at(-1), [
      'builds',
      'list',
      '--app',
      appId,
      '--version',
      '1.1.0',
      '--build-number',
      '42',
      '--platform',
      'IOS',
      '--paginate',
    ]);
    assert.deepEqual(await port.readAttachedBuild('v2'), { id: 'b42', buildNumber: '42' });
    assert.equal(await port.readReviewDetail('v2'), undefined, 'configured: false is no detail');
    assert.equal(
      await port.readPhasedRelease('v2'),
      undefined,
      "asc's empty resource is no phased release",
    );
    assert.deepEqual(await port.readAgeRating('info-next'), {
      id: 'age-1',
      answered: ['gambling', 'violenceCartoonOrFantasy'],
    });
    assert.deepEqual(await port.listReviewSubmissions(appId), [
      { id: 'sub-1', state: 'READY_FOR_REVIEW' },
    ]);
    assert.deepEqual(await port.listReviewSubmissionItems('sub-1'), [
      { id: 'item-1', state: 'READY_FOR_REVIEW', appStoreVersionId: 'v2' },
    ]);
    assert.deepEqual(calls.at(-1), [
      'review',
      'items-list',
      '--submission',
      'sub-1',
      '--include',
      'appStoreVersion,inAppPurchaseVersion',
      '--paginate',
    ]);
    assert.equal(
      await port.createVersion({ appId, versionString: '1.2.0', releaseType: 'MANUAL', copyright: '2026 Studio' }),
      'v3',
    );
    assert.deepEqual(calls.at(-1), [
      'versions',
      'create',
      '--app',
      appId,
      '--version',
      '1.2.0',
      '--platform',
      'IOS',
      '--release-type',
      'MANUAL',
      '--copyright',
      '2026 Studio',
    ]);
    await port.updateVersion({
      versionId: 'v2',
      releaseType: 'SCHEDULED',
      earliestReleaseDate: '2026-12-01T00:00:00Z',
    });
    assert.deepEqual(calls.at(-1), [
      'versions',
      'update',
      '--version-id',
      'v2',
      '--release-type',
      'SCHEDULED',
      '--earliest-release-date',
      '2026-12-01T00:00:00Z',
    ]);
    await port.attachBuild({ versionId: 'v2', buildId: 'b42' });
    await port.createReviewDetail({
      versionId: 'v2',
      fields: {
        contactEmail: 'dev@example.com',
        demoAccountRequired: true,
        demoAccountName: 'n',
        demoAccountPassword: 'p',
      },
    });
    assert.deepEqual(calls.at(-1), [
      'review',
      'details-create',
      '--version-id',
      'v2',
      '--contact-email',
      'dev@example.com',
      '--demo-account-name',
      'n',
      '--demo-account-password',
      'p',
      '--demo-account-required=true',
    ]);
    await port.updateReviewDetail({ detailId: 'rd-1', fields: { demoAccountRequired: false } });
    assert.deepEqual(calls.at(-1), [
      'review',
      'details-update',
      '--id',
      'rd-1',
      '--demo-account-required=false',
    ]);
    await port.createPhasedRelease('v2');
    assert.deepEqual(calls.at(-1), [
      'versions',
      'phased-release',
      'create',
      '--version-id',
      'v2',
      '--state',
      'INACTIVE',
    ]);
    await port.updatePhasedRelease({ phasedReleaseId: 'phased-1', state: 'COMPLETE' });
    assert.deepEqual(calls.at(-1), [
      'versions',
      'phased-release',
      'update',
      '--id',
      'phased-1',
      '--state',
      'COMPLETE',
      '--confirm',
    ]);
    assert.equal(await port.createReviewSubmission(appId), 'sub-2');
    assert.deepEqual(calls.at(-1), [
      'review',
      'submissions-create',
      '--app',
      appId,
      '--platform',
      'IOS',
    ]);
    await port.addReviewSubmissionItem({
      submissionId: 'sub-2',
      type: 'inAppPurchaseVersions',
      id: 'iv-1',
    });
    assert.deepEqual(calls.at(-1), [
      'review',
      'items-add',
      '--submission',
      'sub-2',
      '--item-type',
      'inAppPurchaseVersions',
      '--item-id',
      'iv-1',
    ]);
    await port.submitReviewSubmission('sub-2');
    assert.deepEqual(calls.at(-1), ['review', 'submissions-submit', '--id', 'sub-2', '--confirm']);
    await port.releaseVersion('v2');
    assert.deepEqual(calls.at(-1), ['versions', 'release', '--version-id', 'v2', '--confirm']);

    // A review detail with a password set: asc shows "(redacted)".
    const detailPort = createAscReleasePort(async () => ({
      data: {
        type: 'appStoreReviewDetails',
        id: 'rd-1',
        attributes: {
          contactEmail: 'dev@example.com',
          demoAccountRequired: true,
          demoAccountName: 'n',
          demoAccountPassword: '(redacted)',
        },
      },
    }));
    assert.deepEqual(await detailPort.readReviewDetail('v2'), {
      id: 'rd-1',
      contactEmail: 'dev@example.com',
      demoAccountName: 'n',
      demoAccountPasswordSet: true,
      demoAccountRequired: true,
    });
    // Not found (exit 4) is no phased release; another failure is an error.
    const missing = createAscReleasePort(async () => {
      throw new ReleaseProcessError('exit', 'not found', 4);
    });
    assert.equal(await missing.readPhasedRelease('v2'), undefined);
    const broken = createAscReleasePort(async () => {
      throw new ReleaseProcessError('exit', 'server error', 1);
    });
    await assert.rejects(broken.readPhasedRelease('v2'), ReleaseProcessError);
    const unconfirmed = createAscReleasePort(async () => ({
      versionId: 'v2',
      buildId: 'b41',
      attached: true,
    }));
    await assert.rejects(
      unconfirmed.attachBuild({ versionId: 'v2', buildId: 'b42' }),
      /did not confirm/u,
    );
  }

  // Status reads the open submissions and only the newest completed ones since the version was created.
  {
    const asc = fakeAsc();
    Object.assign(asc.state.versions[1] as AscReleaseVersion, {
      createdDate: '2026-10-01T00:00:00Z',
    });
    const day = (n: number): string => `2026-${n < 10 ? '09' : '10'}-${String(n < 10 ? 20 + n : n).padStart(2, '0')}T00:00:00Z`;
    asc.state.submissions = [
      { id: 'sub-open', state: 'READY_FOR_REVIEW' },
      ...Array.from({ length: 8 }, (_, index) => ({
        id: `sub-new-${index}`,
        state: 'COMPLETE',
        submittedDate: day(10 + index),
      })),
      ...Array.from({ length: 3 }, (_, index) => ({ id: `sub-old-${index}`, state: 'COMPLETE', submittedDate: day(index) })),
    ];
    const read: string[] = [];
    const port: AscReleasePort = {
      ...asc.ports.release,
      async listReviewSubmissionItems(submissionId) {
        read.push(submissionId);
        return asc.ports.release.listReviewSubmissionItems(submissionId);
      },
    };
    const missing = await readAppStoreReleaseStatus(
      { appId, bundleId, marketingVersion: '1.1.0' },
      port,
    );
    assert.deepEqual(read, [
      'sub-open',
      'sub-new-7',
      'sub-new-6',
      'sub-new-5',
      'sub-new-4',
      'sub-new-3',
    ]);
    assert.equal(missing.submission, undefined);
    assert.match(
      missing.summary,
      /among the open ones and the 5 newest completed ones since it was created; 6 older submission\(s\) were not read/u,
    );
    // A match stops the search.
    asc.state.items.set('sub-new-6', [
      { id: 'item-v', state: 'APPROVED', appStoreVersionId: 'v2' },
    ]);
    read.length = 0;
    const found = await readAppStoreReleaseStatus(
      { appId, bundleId, marketingVersion: '1.1.0' },
      port,
    );
    assert.deepEqual(read, ['sub-open', 'sub-new-7', 'sub-new-6']);
    assert.equal(found.submission?.id, 'sub-new-6');
    assert.doesNotMatch(found.summary, /were not read/u);
  }

  // The commands: profile, credential, presence and targets files, saved plan, status, publish, phased.
  {
    const game = path.join(root, 'game');
    mkdirSync(path.join(game, 'apps/mobile'), { recursive: true });
    writeFileSync(path.join(game, 'apps/mobile/package.json'), '{"name":"mobile"}\n');
    const writeTargets = (iosDeviceFamily?: string): void => writeFileSync(path.join(game, 'mpgd.targets.json'), `${JSON.stringify({
      targets: {
        ios: {
          kind: 'capacitor-ios',
          adapter: 'capacitor',
          artifact: 'ipa',
          gameApp: '.',
          shellApp: 'apps/mobile',
          webDir: 'apps/mobile/www',
          metadata: { bundleId, ...(iosDeviceFamily === undefined ? {} : { iosDeviceFamily }) },
        },
      },
    }, null, 2)}\n`);
    writeTargets();
    const configFile = initializeDeployConfig(game);
    const config = JSON.parse(readFileSync(configFile, 'utf8')) as {
      profiles: { beta: { targets: { ios: Record<string, unknown> } } };
    };
    config.profiles.beta.targets.ios.testGroup = 'group-1';
    writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
    writeFileSync(path.join(game, 'mpgd.store-presence.json'), `${JSON.stringify({
      version: '1',
      appStore: {
        localizations: { 'en-US': locale('New puzzles.'), ko: locale('새 퍼즐.') },
        copyright: '2026 Studio',
        review: { contact, demoAccount: { nameEnv: 'MPGD_REVIEW_NAME', passwordEnv: 'MPGD_REVIEW_PASSWORD' } },
      },
    }, null, 2)}\n`);
    const credentialName = String(
      (config.profiles.beta.targets.ios.submissionCredential as { env: string }).env,
    );
    const environment = {
      MPGD_ASC_BINARY: '/opt/asc',
      MPGD_ASC_APP_ID: appId,
      MPGD_ASC_KEY_ID: 'ABCDE12345',
      MPGD_ASC_ISSUER_ID: 'issuer',
      [credentialName]: 'cHJpdmF0ZQ==',
      MPGD_REVIEW_NAME: 'reviewer@example.com',
      MPGD_REVIEW_PASSWORD: 'sup3r-secret',
    };
    const asc = fakeAsc();
    const sessions: { secrets: readonly string[]; closed: boolean }[] = [];
    const statusReads: string[] = [];
    const ports = {
      appStore: async (_credential: unknown, options: { readonly secretValues?: readonly string[] }) => {
        const session = { secrets: options.secretValues ?? [], closed: false };
        sessions.push(session);
        return {
          ...asc.ports,
          close: () => {
            session.closed = true;
          },
        };
      },
      readReleaseStatus: (async (statusInput: { releaseKey: string }) => {
        statusReads.push(statusInput.releaseKey);
        return {
          builds: { ios: { platformVersion: { marketingVersion: '1.1.0', buildNumber: 42 } } },
          submissions: statusInput.releaseKey === 'unsubmitted'
            ? { ios: { status: 'unknown' } }
            : { ios: { remoteBuildId: 'b42' } },
        };
      }) as unknown as typeof readNativeReleaseStatus,
      now,
    };
    const { MPGD_REVIEW_PASSWORD: _password, ...withoutPassword } = environment;
    await assert.rejects(
      planAppStoreReleaseCommand(
        { game, profile: 'beta', gameId: 'mygame', release: 'unsubmitted' },
        environment,
        ports,
      ),
      /recorded no App Store Connect build ID for its iOS build \(the TestFlight submission is unknown\)/u,
    );
    // Without the secrets the plan is still made, blocked on them, and apply refuses it.
    const unsetPlan = await planAppStoreReleaseCommand(
      { game, profile: 'beta', version: '1.1.0' },
      withoutPassword,
      ports,
    );
    assert.match(
      unsetPlan.plan.blockers.join('\n'),
      /names MPGD_REVIEW_PASSWORD, which is not set/u,
    );
    const unsetFile = path.join(root, 'unset-plan.json');
    saveAppStoreReleasePlan(unsetFile, unsetPlan);
    await assert.rejects(
      applyAppStoreReleaseCommand({ planFile: unsetFile, approved: true }, withoutPassword, ports),
      /blocker\(s\); fix them and plan again/u,
    );
    // With the secrets set later, the reviewed plan no longer matches (the demo name is part of it).
    await assert.rejects(
      applyAppStoreReleaseCommand({ planFile: unsetFile, approved: true }, environment, ports),
      StorePlanStaleError,
    );
    const padded = await planAppStoreReleaseCommand(
      { game, profile: 'beta', version: '1.1.0' },
      { ...environment, MPGD_REVIEW_PASSWORD: ' padded ' },
      ports,
    );
    assert.match(
      padded.plan.blockers.join('\n'),
      /MPGD_REVIEW_PASSWORD starts or ends with whitespace/u,
    );
    assert.equal(asc.writes.length, 0);
    await assert.rejects(
      planAppStoreReleaseCommand({ game, profile: 'beta' }, environment, ports),
      /Name the version with --marketing-version/u,
    );
    await assert.rejects(
      planAppStoreReleaseCommand({ game, profile: 'beta', gameId: 'mygame' }, environment, ports),
      /--game-id and --release go together/u,
    );
    await assert.rejects(
      planAppStoreReleaseCommand(
        { game, profile: 'beta', gameId: 'mygame', release: 'launch-1', version: '1.2.0' },
        environment,
        ports,
      ),
      /--marketing-version 1\.2\.0 differs from 1\.1\.0/u,
    );
    const planned = await planAppStoreReleaseCommand(
      { game, profile: 'beta', gameId: 'mygame', release: 'launch-1', phasedRelease: true },
      environment,
      ports,
    );
    assert.deepEqual(statusReads.at(-1), 'launch-1');
    assert.deepEqual(planned.request, {
      marketingVersion: '1.1.0',
      buildNumber: '42',
      recordedBuildId: 'b42',
      universal: true,
      releaseType: 'MANUAL',
      phasedRelease: true,
      skipIaps: [],
      rotateDemoPassword: false,
    });
    assert.deepEqual(planned.plan.blockers, []);
    assert.deepEqual(sessions.at(-1), {
      secrets: ['sup3r-secret', 'reviewer@example.com'],
      closed: true,
    });
    const planFile = path.join(root, 'release-plan.json');
    saveAppStoreReleasePlan(planFile, planned);
    const savedText = readFileSync(planFile, 'utf8');
    assert.ok(
      !savedText.includes('sup3r-secret') && !savedText.includes('reviewer@example.com'),
      'no secret on disk',
    );
    await assert.rejects(
      applyAppStoreReleaseCommand({ planFile, approved: false }, environment, ports),
      /requires --approve/u,
    );
    const dry = await applyAppStoreReleaseCommand(
      { planFile, approved: false, dryRun: true },
      environment,
      ports,
    );
    assert.equal(dry.status, 'dry-run');
    assert.equal(asc.writes.length, 0);
    // An iPhone-only target is a different plan.
    writeTargets('iphone');
    await assert.rejects(
      applyAppStoreReleaseCommand({ planFile, approved: true }, environment, ports),
      StorePlanStaleError,
    );
    writeTargets();
    const applied = await applyAppStoreReleaseCommand(
      { planFile, approved: true },
      environment,
      ports,
    );
    assert.equal(applied.status, 'submitted');
    assert.ok(asc.writes.includes('phased create'));
    assert.equal(asc.state.passwords.get('v2'), 'sup3r-secret');
    assert.ok(sessions.every((session) => session.closed));

    // Status reports where the submission stands.
    const status = await readAppStoreReleaseStatusCommand(
      { game, profile: 'beta', version: '1.1.0' },
      environment,
      ports,
    );
    assert.equal(status.version?.state, 'WAITING_FOR_REVIEW');
    assert.equal(status.submission?.state, 'WAITING_FOR_REVIEW');
    assert.deepEqual(status.version?.build, { id: 'b42', buildNumber: '42' });
    assert.match(status.summary, /waiting for App Review \(submitted 2026-10-31T01:00:00Z\)/u);
    const missingVersion = await readAppStoreReleaseStatusCommand(
      { game, profile: 'beta', version: '9.9.9' },
      environment,
      ports,
    );
    assert.match(missingVersion.summary, /does not exist yet/u);

    // Publish: only an approved version that waits for a manual release.
    await assert.rejects(
      publishAppStoreVersionCommand(
        { game, profile: 'beta', version: '1.1.0', approved: true },
        environment,
        ports,
      ),
      /only an approved version in PENDING_DEVELOPER_RELEASE/u,
    );
    await assert.rejects(
      publishAppStoreVersionCommand(
        { game, profile: 'beta', version: '1.1.0', approved: false },
        environment,
        ports,
      ),
      /requires --approve/u,
    );
    Object.assign(asc.state.versions[1] as AscReleaseVersion, {
      state: 'PENDING_DEVELOPER_RELEASE',
    });
    assert.match(
      (await readAppStoreReleaseStatusCommand({ game, profile: 'beta', version: '1.1.0' }, environment, ports)).summary,
      /approved and waits for you: release it with "mpgd store release publish"/u,
    );
    const published = await publishAppStoreVersionCommand(
      { game, profile: 'beta', version: '1.1.0', approved: true },
      environment,
      ports,
    );
    assert.equal(published.status, 'released');
    // Re-applying the plan of a released version is a no-op; planning it again is blocked.
    assert.equal(
      (await applyAppStoreReleaseCommand({ planFile, approved: true }, environment, ports)).status,
      'unchanged',
    );
    const releasedPlan = await planAppStoreReleaseCommand(
      { game, profile: 'beta', version: '1.1.0' },
      environment,
      ports,
    );
    assert.equal(releasedPlan.plan.stage, 'released');
    assert.match(
      releasedPlan.plan.blockers.join('\n'),
      /already READY_FOR_DISTRIBUTION: submit a new marketing version/u,
    );
    assert.equal(
      (await publishAppStoreVersionCommand({ game, profile: 'beta', version: '1.1.0', approved: true }, environment, ports)).status,
      'unchanged',
    );

    // Phased release: pause, resume, complete.
    const phased = (action: string) => changeAppStorePhasedReleaseCommand(
      { game, profile: 'beta', version: '1.1.0', action, approved: true },
      environment,
      ports,
    );
    await assert.rejects(
      phased('pause'),
      /has not started; it starts when the version is released/u,
    );
    const phasedId = asc.state.phased.get('v2')?.id ?? '';
    asc.state.phased.set('v2', { id: phasedId, state: 'ACTIVE', currentDayNumber: 3 });
    assert.match(
      (await readAppStoreReleaseStatusCommand({ game, profile: 'beta', version: '1.1.0' }, environment, ports)).summary,
      /released with a phased release ACTIVE on day 3 of 7/u,
    );
    assert.deepEqual(await phased('pause'), {
      status: 'updated',
      phasedReleaseId: phasedId,
      state: 'PAUSED',
    });
    assert.equal((await phased('pause')).status, 'unchanged');
    assert.equal((await phased('resume')).state, 'ACTIVE');
    assert.equal((await phased('complete')).state, 'COMPLETE');
    await assert.rejects(phased('resume'), /is COMPLETE; it cannot resume/u);
    await assert.rejects(phased('stop'), /--action must be pause, resume or complete/u);
    assert.deepEqual(asc.writes.slice(-4), [
      `release v2`,
      'phased PAUSED',
      'phased ACTIVE',
      'phased COMPLETE',
    ]);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.info('App Store Connect release tests passed.');
