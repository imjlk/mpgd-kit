import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createAscTestFlightDistributionPort } from './testflight-distribution-asc.js';
import type {
  TestFlightBetaReviewDetail,
  TestFlightBetaReviewDetailChanges,
  TestFlightBetaReviewSubmission,
  TestFlightDistributionPort,
  TestFlightGroup,
  TestFlightWhatToTest,
} from './testflight-distribution-port.js';
import {
  applyTestFlightDistribution,
  parseTestFlightBetaReview,
  parseTestFlightGroups,
  planTestFlightDistribution,
  readTestFlightBetaReviewFile,
  readTestFlightBuildStatus,
  readTestFlightWhatToTestFile,
  type TestFlightDistributionRequest,
} from './testflight-distribution.js';

const appId = '1234567890';
const bundleId = 'dev.mpgd.testflight';
const buildId = 'build-1';
const internalGroup: TestFlightGroup = {
  id: 'group-internal',
  name: 'Studio QA',
  isInternal: true,
};
const externalGroup: TestFlightGroup = { id: 'group-ipad', name: 'iPad QA', isInternal: false };
const phoneGroup: TestFlightGroup = { id: 'group-phone', name: 'iPhone QA', isInternal: false };

interface FakeState {
  processingState: string | undefined;
  internalBuildState: string;
  externalBuildState: string;
  groups: TestFlightGroup[];
  members: Set<string>;
  notes: TestFlightWhatToTest[];
  detail: TestFlightBetaReviewDetail;
  submissions: TestFlightBetaReviewSubmission[];
  /** What App Store Connect does to the external state when a build is submitted. */
  submitState: string;
  /** The external state App Store Connect moves to once an external group is added. */
  stateAfterAdd?: string;
  /** Membership reads after add-groups that still miss the new groups. */
  membershipLag?: number;
  hiddenReads?: number;
  hidden?: readonly string[];
  writes: string[];
  failSubmit?: boolean;
}

function fake(overrides: Partial<FakeState> = {}): { state: FakeState; port: TestFlightDistributionPort } {
  const state: FakeState = {
    processingState: 'VALID',
    internalBuildState: 'READY_FOR_BETA_TESTING',
    externalBuildState: 'READY_FOR_BETA_SUBMISSION',
    groups: [internalGroup, externalGroup, phoneGroup],
    members: new Set(),
    notes: [],
    detail: { id: 'detail-1', demoAccountPasswordSet: false, demoAccountRequired: false },
    submissions: [],
    submitState: 'WAITING_FOR_REVIEW',
    writes: [],
    ...overrides,
  };
  const port: TestFlightDistributionPort = {
    async readAppBundleId(requested) {
      assert.equal(requested, appId);
      return bundleId;
    },
    async findBuild(requested, version, number) {
      assert.deepEqual([requested, version, number], [appId, '1.4.0', '42']);
      return state.processingState === undefined ? undefined : { id: buildId, processingState: state.processingState };
    },
    async listGroups() {
      return state.groups;
    },
    async readBuildBetaState() {
      return { internalBuildState: state.internalBuildState, externalBuildState: state.externalBuildState };
    },
    async listBuildGroupIds() {
      if ((state.hiddenReads ?? 0) > 0) {
        state.hiddenReads = (state.hiddenReads ?? 0) - 1;
        return [...state.members].filter((id) => !(state.hidden ?? []).includes(id));
      }
      return [...state.members];
    },
    async addBuildToGroups(id, groupIds) {
      assert.equal(id, buildId);
      for (const groupId of groupIds) {
        assert.equal(state.members.has(groupId), false, `group ${groupId} added twice`);
        const group = state.groups.find((entry) => entry.id === groupId);
        if (group?.isInternal === false
          && ['WAITING_FOR_BETA_REVIEW', 'IN_BETA_REVIEW', 'BETA_REJECTED'].includes(state.externalBuildState)) {
          throw new Error('asc refuses an external group during review');
        }
        state.members.add(groupId);
        if (group?.isInternal === false && state.stateAfterAdd !== undefined) {
          state.externalBuildState = state.stateAfterAdd;
        }
      }
      state.writes.push(`add-groups ${groupIds.join(',')}`);
      state.hiddenReads = state.membershipLag ?? 0;
      state.hidden = groupIds;
    },
    async listWhatToTest() {
      return state.notes;
    },
    async putWhatToTest(id, locale, text) {
      assert.equal(id, buildId);
      state.notes = [
        ...state.notes.filter((note) => note.locale !== locale),
        { id: `note-${locale}`, locale, whatsNew: text },
      ];
      state.writes.push(`what-to-test ${locale}`);
    },
    async readBetaReviewDetail() {
      return state.detail;
    },
    async updateBetaReviewDetail(id, changes: TestFlightBetaReviewDetailChanges) {
      assert.equal(id, state.detail.id);
      const { demoAccountPassword, ...visible } = changes;
      state.detail = {
        ...state.detail,
        ...visible,
        demoAccountPasswordSet: state.detail.demoAccountPasswordSet || demoAccountPassword !== undefined,
      };
      state.writes.push(`review-details ${Object.keys(changes).sort().join(',')}`);
    },
    async listBetaReviewSubmissions() {
      return state.submissions;
    },
    async submitForBetaReview(id) {
      assert.equal(id, buildId);
      if (state.failSubmit === true) {
        throw new Error('Another build of this version is in review.');
      }
      assert.equal(state.submissions.length, 0, 'build submitted twice');
      const submission = { id: 'submission-1', betaReviewState: state.submitState, submittedDate: '2026-10-31T00:00:00Z' };
      state.submissions = [submission];
      state.externalBuildState = state.submitState === 'APPROVED' ? 'BETA_APPROVED' : 'WAITING_FOR_BETA_REVIEW';
      state.writes.push('submit');
      return submission;
    },
  };
  return { state, port };
}

const target = { appStoreAppId: appId, bundleId, marketingVersion: '1.4.0', buildNumber: '42' };
const review = {
  contactFirstName: 'Ada',
  contactLastName: 'Kim',
  contactEmail: 'qa@example.com',
  contactPhone: '+82 10 0000 0000',
  notes: 'Guest play; no sign-in needed.',
  demoAccount: { required: false },
};
const external: TestFlightDistributionRequest = {
  ...target,
  groups: ['Studio QA', 'iPad QA'],
  whatToTest: [
    { language: 'en-US', text: 'Buy a booster on an iPad.' },
    { language: 'ko', text: '부스터 구매' },
  ],
  betaReview: review,
};

const fixture = mkdtempSync(path.join(tmpdir(), 'mpgd-testflight-distribution-'));
try {
  // Internal only: the build joins another internal group, nothing is reviewed.
  {
    const { state, port } = fake();
    const result = await applyTestFlightDistribution(port, {
      ...target,
      groups: ['group-internal'],
    });
    assert.equal(result.betaReview.status, 'not-needed');
    assert.equal(result.betaReview.submit, false);
    assert.deepEqual(
      result.groups.map((group) => group.membership),
      ['added'],
    );
    assert.deepEqual(state.writes, ['add-groups group-internal']);
    const again = await applyTestFlightDistribution(port, {
      ...target,
      groups: ['group-internal'],
    });
    assert.deepEqual(
      again.groups.map((group) => group.membership),
      ['present'],
    );
    assert.deepEqual(state.writes, ['add-groups group-internal'], 'a re-run writes nothing');
  }

  // External: plan, then What to Test, groups, review details and the submission.
  {
    const { state, port } = fake({
      notes: [{ id: 'note-en', locale: 'en-US', whatsNew: 'Old notes' }],
    });
    const plan = await planTestFlightDistribution(port, external);
    assert.equal(plan.dryRun, true);
    assert.deepEqual(
      plan.groups.map((group) => [group.name, group.external, group.membership]),
      [
        ['Studio QA', false, 'add'],
        ['iPad QA', true, 'add'],
      ],
    );
    assert.deepEqual(plan.whatToTest, [
      { locale: 'en-US', action: 'update' },
      { locale: 'ko', action: 'create' },
    ]);
    assert.deepEqual([...plan.reviewDetailFields].sort(), [
      'contactEmail',
      'contactFirstName',
      'contactLastName',
      'contactPhone',
      'notes',
    ]);
    assert.deepEqual(plan.betaReview, { status: 'not-submitted', submit: true });
    assert.deepEqual(state.writes, [], 'a dry run writes nothing');

    const applied = await applyTestFlightDistribution(port, external);
    assert.equal(applied.dryRun, false);
    assert.deepEqual(applied.betaReview, {
      status: 'waiting-for-review',
      submit: true,
      submissionId: 'submission-1',
    });
    assert.deepEqual(state.writes, [
      'what-to-test en-US',
      'what-to-test ko',
      'add-groups group-internal,group-ipad',
      'review-details contactEmail,contactFirstName,contactLastName,contactPhone,notes',
      'submit',
    ]);

    // Re-run: no group is re-added and the open review is not submitted again.
    const rerun = await applyTestFlightDistribution(port, external);
    assert.deepEqual(
      rerun.groups.map((group) => group.membership),
      ['present', 'present'],
    );
    assert.deepEqual(
      rerun.whatToTest.map((note) => note.action),
      ['unchanged', 'unchanged'],
    );
    assert.deepEqual(rerun.betaReview, {
      status: 'waiting-for-review',
      submit: false,
      submissionId: 'submission-1',
    });
    assert.equal(state.writes.length, 5);

    // Another external group waits for the open review instead of failing in asc.
    const more = await applyTestFlightDistribution(port, {
      ...external,
      groups: ['iPad QA', 'iPhone QA'],
    });
    assert.deepEqual(
      more.groups.map((group) => group.membership),
      ['present', 'after-review'],
    );
    assert.match(more.detail ?? '', /iPhone QA only after the open TestFlight App Review ends/u);
    assert.equal(state.writes.length, 5);

    // Approved: the remaining group is added, still without a second submission.
    state.externalBuildState = 'BETA_APPROVED';
    state.submissions = state.submissions.map((submission) => ({ ...submission, betaReviewState: 'APPROVED' }));
    const approved = await applyTestFlightDistribution(port, {
      ...external,
      groups: ['iPad QA', 'iPhone QA'],
    });
    assert.equal(approved.betaReview.status, 'approved');
    assert.deepEqual(
      approved.groups.map((group) => group.membership),
      ['present', 'added'],
    );
    assert.deepEqual(state.writes.slice(5), ['add-groups group-phone']);

    const status = await readTestFlightBuildStatus(port, target);
    assert.equal(status.betaReview, 'approved');
    assert.equal(status.submission?.id, 'submission-1');
    assert.deepEqual(
      status.groups.map((group) => group.name).sort(),
      ['Studio QA', 'iPad QA', 'iPhone QA'].sort(),
    );
  }

  // Already submitted, with the build state not caught up yet: no second submission.
  {
    const { state, port } = fake({
      submissions: [{ id: 'submission-0', betaReviewState: 'IN_REVIEW' }],
      members: new Set(['group-ipad']),
      notes: [{ id: 'note-en', locale: 'en-US', whatsNew: 'Buy a booster on an iPad.' }],
    });
    const result = await applyTestFlightDistribution(port, {
      ...external,
      groups: ['iPad QA'],
      whatToTest: [],
    });
    assert.deepEqual(result.betaReview, {
      status: 'in-review',
      submit: false,
      submissionId: 'submission-0',
    });
    assert.deepEqual(state.writes, []);
  }

  // A later build of a reviewed version that App Store Connect lets through without review.
  {
    const { state, port } = fake({ externalBuildState: 'READY_FOR_BETA_TESTING' });
    const result = await applyTestFlightDistribution(port, { ...external, groups: ['iPad QA'] });
    assert.equal(result.betaReview.status, 'not-needed');
    assert.equal(result.betaReview.submit, false);
    assert.deepEqual(state.writes, [
      'what-to-test en-US',
      'what-to-test ko',
      'add-groups group-ipad',
    ]);
  }

  // The pre-rename READY_FOR_TESTING state asc 5.5.0 still accepts reads the same way.
  {
    const { state, port } = fake({ externalBuildState: 'READY_FOR_TESTING' });
    const result = await applyTestFlightDistribution(port, { ...external, groups: ['iPad QA'] });
    assert.equal(result.betaReview.status, 'not-needed');
    assert.ok(state.writes.includes('add-groups group-ipad'));
    assert.equal((await readTestFlightBuildStatus(port, target)).betaReview, 'not-needed');
  }

  // Adding the group let the build through without review: nothing is submitted.
  {
    const { state, port } = fake({ stateAfterAdd: 'READY_FOR_BETA_TESTING' });
    const result = await applyTestFlightDistribution(port, external);
    assert.deepEqual(result.betaReview, { status: 'not-needed', submit: false });
    assert.equal(state.writes.includes('submit'), false);
    assert.equal(
      state.writes.some((write) => write.startsWith('review-details')),
      false,
    );
  }

  // An auto-approved submission reports approved.
  {
    const { port } = fake({ submitState: 'APPROVED' });
    assert.equal((await applyTestFlightDistribution(port, external)).betaReview.status, 'approved');
  }

  // Rejected: nothing is written and the group waits for a passed review.
  {
    const { state, port } = fake({
      externalBuildState: 'BETA_REJECTED',
      submissions: [{ id: 'submission-0', betaReviewState: 'REJECTED' }],
      notes: [{ id: 'note-en', locale: 'en-US', whatsNew: 'Buy a booster.' }],
    });
    const result = await applyTestFlightDistribution(port, {
      ...external,
      groups: ['iPad QA'],
      whatToTest: [],
    });
    assert.equal(result.betaReview.status, 'rejected');
    assert.deepEqual(
      result.groups.map((group) => group.membership),
      ['after-review'],
    );
    assert.match(result.detail ?? '', /rejection is resolved/u);
    assert.deepEqual(state.writes, []);
  }

  // Missing group: fail closed and name the groups that exist.
  {
    const { state, port } = fake();
    await assert.rejects(
      applyTestFlightDistribution(port, { ...external, groups: ['iPad QA', 'Tablet QA'] }),
      /TestFlight group "Tablet QA" does not exist for app 1234567890.*iPad QA \(external, group-ipad\)/su,
    );
    await assert.rejects(
      planTestFlightDistribution(port, {
        ...external,
        groups: ['iPad QA'],
        appStoreAppId: 'not-numeric',
      }),
      /numeric app ID/u,
    );
    state.groups = [...state.groups, { id: 'group-ipad-2', name: 'iPad QA', isInternal: false }];
    await assert.rejects(
      planTestFlightDistribution(port, external),
      /More than one TestFlight group.*named "iPad QA"/u,
    );
    assert.deepEqual(state.writes, []);
  }

  // A build that is not uploaded or not processed yet: fail closed.
  {
    await assert.rejects(
      planTestFlightDistribution(fake({ processingState: undefined }).port, external),
      /has no iOS build 1\.4\.0 \(42\) yet/u,
    );
    await assert.rejects(
      applyTestFlightDistribution(fake({ processingState: 'PROCESSING' }).port, external),
      /still processing/u,
    );
    await assert.rejects(
      applyTestFlightDistribution(fake({ processingState: 'INVALID' }).port, external),
      /reports INVALID/u,
    );
    await assert.rejects(
      applyTestFlightDistribution(fake({ externalBuildState: 'PROCESSING' }).port, external),
      /cannot go to external testers yet/u,
    );
    await assert.rejects(
      applyTestFlightDistribution(fake({ externalBuildState: 'NOT_APPLICABLE' }).port, external),
      /Internal Only/u,
    );
    await assert.rejects(
      applyTestFlightDistribution(fake({ internalBuildState: 'PROCESSING' }).port, {
        ...target,
        groups: ['Studio QA'],
      }),
      /not ready for internal testers/u,
    );
    await assert.rejects(
      applyTestFlightDistribution(fake().port, { ...external, expectedBuildId: 'other-build' }),
      /differs from the build ID the release state recorded/u,
    );
    const status = await readTestFlightBuildStatus(
      fake({ processingState: 'PROCESSING' }).port,
      target,
    );
    assert.equal(status.betaReview, 'build-not-ready');
    assert.equal(status.processingState, 'PROCESSING');
    assert.equal(
      (await readTestFlightBuildStatus(fake({ processingState: 'INVALID' }).port, target)).betaReview,
      'build-unusable',
    );
    assert.equal(
      (await readTestFlightBuildStatus(fake({ externalBuildState: 'EXPIRED' }).port, target)).betaReview,
      'build-unusable',
    );
    assert.equal(
      (await readTestFlightBuildStatus(fake({ externalBuildState: 'PROCESSING' }).port, target)).betaReview,
      'build-not-ready',
    );
    assert.equal(
      (await readTestFlightBuildStatus(fake({ processingState: undefined }).port, target)).betaReview,
      'build-not-ready',
    );
  }

  // Export compliance keeps the action-required behaviour and writes nothing.
  {
    const { state, port } = fake({
      externalBuildState: 'MISSING_EXPORT_COMPLIANCE',
      internalBuildState: 'MISSING_EXPORT_COMPLIANCE',
    });
    const result = await applyTestFlightDistribution(port, external);
    assert.equal(result.betaReview.status, 'action-required');
    assert.deepEqual(
      result.groups.map((group) => group.membership),
      ['blocked', 'blocked'],
    );
    assert.match(result.detail ?? '', /ITSAppUsesNonExemptEncryption/u);
    assert.deepEqual(state.writes, []);
    assert.equal((await readTestFlightBuildStatus(port, target)).betaReview, 'action-required');
  }

  // Missing review details or What to Test: fail closed before any write.
  {
    const { state, port } = fake();
    await assert.rejects(
      applyTestFlightDistribution(port, {
        ...external,
        betaReview: { contactEmail: 'qa@example.com' },
      }),
      /needs review details that App Store Connect does not have: contactFirstName, contactLastName, contactPhone/u,
    );
    await assert.rejects(
      applyTestFlightDistribution(port, {
        ...external,
        betaReview: { ...review, demoAccount: { required: true, name: 'reviewer' } },
      }),
      /demoAccountPassword/u,
    );
    await assert.rejects(
      applyTestFlightDistribution(port, { ...external, whatToTest: [] }),
      /need the build's "What to Test"/u,
    );
    assert.deepEqual(state.writes, []);
  }

  // Review details already in App Store Connect are kept; the demo password is always sent.
  {
    const { state, port } = fake({
      detail: {
        id: 'detail-1',
        contactFirstName: 'Ada',
        contactLastName: 'Kim',
        contactEmail: 'qa@example.com',
        contactPhone: '+82 10 0000 0000',
        demoAccountName: 'reviewer',
        demoAccountPasswordSet: true,
        demoAccountRequired: true,
      },
    });
    const { betaReview: _unused, ...withoutReview } = external;
    const plan = await planTestFlightDistribution(port, withoutReview);
    assert.deepEqual(plan.reviewDetailFields, []);
    await applyTestFlightDistribution(port, {
      ...external,
      betaReview: { demoAccount: { required: true, name: 'reviewer', password: 'pw' } },
    });
    assert.ok(state.writes.includes('review-details demoAccountPassword'));
  }

  // A failed submission names what was already written; a re-run finishes it.
  {
    const { state, port } = fake({ failSubmit: true });
    await assert.rejects(
      applyTestFlightDistribution(port, external),
      /failed at TestFlight App Review submission \(already written: What to Test \(en-US\), What to Test \(ko\), group assignment, TestFlight review details\)/u,
    );
    state.failSubmit = false;
    const retried = await applyTestFlightDistribution(port, external);
    assert.equal(retried.betaReview.status, 'waiting-for-review');
    assert.deepEqual(state.writes.slice(-1), ['submit']);
    assert.equal(state.writes.filter((write) => write.startsWith('add-groups')).length, 1);
  }

  // A dry run without the demo account variables plans and lists them; apply refuses.
  {
    const file = path.join(fixture, 'review-dry-run.json');
    writeFileSync(
      file,
      JSON.stringify({
        ...review,
        demoAccount: {
          required: true,
          nameEnv: 'MPGD_TF_DEMO_NAME',
          passwordEnv: 'MPGD_TF_DEMO_PASSWORD',
        },
      }),
    );
    const unresolved = readTestFlightBetaReviewFile(file, {}, { requireValues: false });
    assert.deepEqual(unresolved.demoAccount, {
      required: true,
      nameEnv: 'MPGD_TF_DEMO_NAME',
      passwordEnv: 'MPGD_TF_DEMO_PASSWORD',
      unresolvedEnv: ['MPGD_TF_DEMO_NAME', 'MPGD_TF_DEMO_PASSWORD'],
    });
    const { state, port } = fake();
    const plan = await planTestFlightDistribution(port, { ...external, betaReview: unresolved });
    assert.deepEqual(plan.pendingInputs, [
      'demo account values: missing MPGD_TF_DEMO_NAME, MPGD_TF_DEMO_PASSWORD',
    ]);
    assert.ok(plan.reviewDetailFields.includes('demoAccountName'));
    assert.ok(plan.reviewDetailFields.includes('demoAccountPassword'));
    assert.equal(plan.betaReview.submit, true);
    await assert.rejects(
      applyTestFlightDistribution(port, { ...external, betaReview: unresolved }),
      /needs MPGD_TF_DEMO_NAME, MPGD_TF_DEMO_PASSWORD in the environment/u,
    );
    assert.deepEqual(state.writes, []);
    // A partly set account reports only what is missing.
    const partial = readTestFlightBetaReviewFile(
      file,
      { MPGD_TF_DEMO_NAME: 'reviewer' },
      { requireValues: false },
    );
    assert.deepEqual(partial.demoAccount?.unresolvedEnv, ['MPGD_TF_DEMO_PASSWORD']);
    // Bad names still fail in a dry run.
    writeFileSync(
      file,
      JSON.stringify({ demoAccount: { required: true, nameEnv: 'lower', passwordEnv: 'X' } }),
    );
    assert.throws(
      () => readTestFlightBetaReviewFile(file, {}, { requireValues: false }),
      /must name an environment variable/u,
    );
  }

  // A submission in a state this kit does not know is never submitted over.
  {
    const { state, port } = fake({
      submissions: [{ id: 'submission-x', betaReviewState: 'ON_HOLD' }],
    });
    const result = await applyTestFlightDistribution(port, external);
    assert.equal(result.betaReview.status, 'action-required');
    assert.equal(result.betaReview.submit, false);
    assert.match(result.detail ?? '', /submission-x reports an unknown state ON_HOLD/u);
    assert.deepEqual(state.writes, []);
    assert.equal((await readTestFlightBuildStatus(port, target)).betaReview, 'action-required');
  }

  // App Store Connect lists a new membership late: the read is retried, then fails closed.
  {
    const delays: number[] = [];
    const sleep = async (milliseconds: number): Promise<void> => {
      delays.push(milliseconds);
    };
    const lagging = fake({ membershipLag: 2 });
    const result = await applyTestFlightDistribution(lagging.port, external, { sleep });
    assert.equal(result.betaReview.status, 'waiting-for-review');
    assert.deepEqual(delays, [2_000, 5_000]);
    const stuck = fake({ membershipLag: 10 });
    await assert.rejects(
      applyTestFlightDistribution(stuck.port, external, { sleep }),
      /failed at group assignment .*does not show the build in Studio QA, iPad QA/u,
    );
    assert.equal(stuck.state.writes.includes('submit'), false);
  }

  // Review details file: env var names only, values from the environment.
  {
    const file = path.join(fixture, 'review.json');
    writeFileSync(
      file,
      JSON.stringify({
        ...review,
        demoAccount: {
          required: true,
          nameEnv: 'MPGD_TF_DEMO_NAME',
          passwordEnv: 'MPGD_TF_DEMO_PASSWORD',
        },
      }),
    );
    const parsed = readTestFlightBetaReviewFile(file, {
      MPGD_TF_DEMO_NAME: 'reviewer',
      MPGD_TF_DEMO_PASSWORD: 'secret',
    });
    assert.deepEqual(parsed.demoAccount, {
      required: true,
      nameEnv: 'MPGD_TF_DEMO_NAME',
      passwordEnv: 'MPGD_TF_DEMO_PASSWORD',
      name: 'reviewer',
      password: 'secret',
    });
    assert.throws(
      () => readTestFlightBetaReviewFile(file, { MPGD_TF_DEMO_NAME: 'reviewer' }),
      /needs MPGD_TF_DEMO_PASSWORD/u,
    );
    assert.throws(
      () =>
        parseTestFlightBetaReview({
          demoAccount: { required: true, name: 'reviewer', password: 'secret' },
        }),
      /names of environment variables/u,
    );
    assert.throws(
      () => parseTestFlightBetaReview({ demoAccountPassword: 'secret' }),
      /accept only/u,
    );
    assert.throws(() => parseTestFlightBetaReview({ notes: 'x'.repeat(4001) }), /4000 characters/u);
    assert.throws(() => parseTestFlightBetaReview({ contactEmail: 'nope' }), /not an email/u);
    assert.deepEqual(parseTestFlightBetaReview({ demoAccount: { required: false } }), {
      demoAccount: { required: false },
    });

    const notes = path.join(fixture, 'what-to-test.txt');
    writeFileSync(
      notes,
      `<en-US>\n${'Long test notes. '.repeat(60)}\n</en-US>\n<ko>\n부스터 구매\n</ko>\n`,
    );
    // TestFlight is not bound by Google Play's 500-character limit.
    assert.deepEqual(
      readTestFlightWhatToTestFile(notes).map((note) => note.language),
      ['en-US', 'ko'],
    );
    writeFileSync(notes, 'not tagged');
    assert.throws(() => readTestFlightWhatToTestFile(notes), /What to Test text must sit between/u);
    assert.deepEqual(parseTestFlightGroups(' iPad QA, group-1 ,'), ['iPad QA', 'group-1']);
    assert.throws(() => parseTestFlightGroups(' , '), /at least one/u);
  }

  // The asc 5.5.0 port: command shapes and output schemas.
  {
    const commands: string[][] = [];
    const port = createAscTestFlightDistributionPort(async (args) => {
      commands.push([...args]);
      const command = args.slice(0, 3).join(' ');
      if (command === 'testflight groups list' && args.includes('--build-id')) {
        return {
          buildId,
          appId,
          complete: true,
          groups: [{ id: 'group-ipad', name: 'iPad QA', type: 'external', membership: 'explicit' }],
        };
      }
      if (command === 'testflight groups list') {
        return {
          data: [
            {
              type: 'betaGroups',
              id: 'group-ipad',
              attributes: { name: 'iPad QA', isInternalGroup: false },
            },
          ],
        };
      }
      if (command === 'builds add-groups --build-id') {
        return { buildId, groupIds: ['group-ipad'], action: 'added' };
      }
      if (command === 'testflight review view') {
        return {
          data: [
            {
              type: 'betaAppReviewDetails',
              id: 'detail-1',
              attributes: {
                contactEmail: 'qa@example.com',
                demoAccountPassword: '(redacted)',
                demoAccountRequired: true,
              },
            },
          ],
        };
      }
      if (command === 'testflight review edit') {
        return { data: { type: 'betaAppReviewDetails', id: 'detail-1', attributes: {} } };
      }
      if (command === 'testflight review submit') {
        return {
          data: {
            type: 'betaAppReviewSubmissions',
            id: 'submission-1',
            attributes: { betaReviewState: 'WAITING_FOR_REVIEW' },
          },
        };
      }
      if (command === 'builds build-beta-detail view') {
        return {
          data: {
            type: 'buildBetaDetails',
            id: 'detail',
            attributes: {
              internalBuildState: 'IN_BETA_TESTING',
              externalBuildState: 'READY_FOR_BETA_SUBMISSION',
            },
          },
        };
      }
      throw new Error(`Unexpected asc command: ${args.join(' ')}`);
    });
    assert.deepEqual(await port.listGroups(appId), [
      { id: 'group-ipad', name: 'iPad QA', isInternal: false },
    ]);
    assert.deepEqual(await port.listBuildGroupIds(appId, buildId), ['group-ipad']);
    await port.addBuildToGroups(buildId, ['group-ipad']);
    assert.deepEqual(commands.at(-1), [
      'builds',
      'add-groups',
      '--build-id',
      buildId,
      '--group',
      'group-ipad',
    ]);
    const detail = await port.readBetaReviewDetail(appId);
    assert.equal(detail.demoAccountPasswordSet, true);
    assert.equal(detail.demoAccountRequired, true);
    await port.updateBetaReviewDetail('detail-1', {
      contactPhone: '+82',
      demoAccountRequired: false,
    });
    assert.deepEqual(commands.at(-1), [
      'testflight',
      'review',
      'edit',
      '--id',
      'detail-1',
      '--contact-phone',
      '+82',
      '--demo-account-required=false',
    ]);
    assert.deepEqual(await port.submitForBetaReview(buildId), {
      id: 'submission-1',
      betaReviewState: 'WAITING_FOR_REVIEW',
    });
    assert.deepEqual(commands.at(-1), [
      'testflight',
      'review',
      'submit',
      '--build-id',
      buildId,
      '--confirm',
    ]);
    assert.deepEqual(await port.readBuildBetaState(buildId), {
      internalBuildState: 'IN_BETA_TESTING',
      externalBuildState: 'READY_FOR_BETA_SUBMISSION',
    });
    assert.ok(
      commands.every((args) => !args.includes('--submit')),
      'groups are never added with --submit',
    );
    await assert.rejects(
      port.listBuildGroupIds(appId, 'other-build'),
      /invalid membership result/u,
    );
  }

  console.info('TestFlight distribution smoke passed.');
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
