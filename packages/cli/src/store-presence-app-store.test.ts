import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { assertStorePresence, type StorePresence } from '@mpgd/catalog';

import { createAscStorePresencePort } from './app-store-presence-asc.js';
import type {
  AscAppInfo,
  AscAppInfoLocalization,
  AscAppStoreVersion,
  AscScreenshotSet,
  AscStorePresencePort,
  AscVersionLocalization,
} from './app-store-presence-port.js';
import { initializeDeployConfig } from './deploy-planning.js';
import { ReleaseProcessError } from './deploy-process.js';
import {
  applyStorePresence,
  planStorePresence,
  saveStorePresencePlan,
} from './store-presence-command.js';
import {
  applyAppStorePresence,
  AppStorePresenceApplyError,
  formatAppStorePresencePlan,
  planAppStorePresence,
} from './store-presence-app-store.js';
import { StorePlanStaleError } from './store-sync.js';

const appId = '1234567890';
const bundleId = 'dev.mpgd.store';

/** PNG header bytes (signature, IHDR, IDAT, IEND); `seed` makes the digest differ. */
function png(width: number, height: number, seed: number): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    return Buffer.concat([length, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', Buffer.from([seed & 0xff, (seed >> 8) & 0xff])),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const md5 = (bytes: Buffer): string => createHash('md5').update(bytes).digest('hex');

interface AscState {
  bundleId: string;
  appInfos: AscAppInfo[];
  appInfoLocalizations: Map<string, AscAppInfoLocalization[]>;
  versions: AscAppStoreVersion[];
  versionLocalizations: Map<string, AscVersionLocalization[]>;
  sets: Map<string, AscScreenshotSet[]>;
}

interface FakeAsc {
  readonly port: AscStorePresencePort;
  readonly state: AscState;
  readonly writes: string[];
  failOn?: string | undefined;
}

/** In-memory App Store Connect: version localizations own their screenshot sets. */
function fakeAsc(initial: Partial<AscState> = {}): FakeAsc {
  let next = 0;
  const id = (prefix: string): string => {
    next += 1;
    return `${prefix}-${next}`;
  };
  const writes: string[] = [];
  const state: AscState = {
    bundleId,
    appInfos: [
      { id: 'info-live', state: 'READY_FOR_DISTRIBUTION' },
      { id: 'info-next', state: 'PREPARE_FOR_SUBMISSION' },
    ],
    appInfoLocalizations: new Map(),
    versions: [
      { id: 'v1', versionString: '1.0.0', state: 'READY_FOR_SALE' },
      { id: 'v2', versionString: '1.1.0', state: 'PREPARE_FOR_SUBMISSION' },
    ],
    versionLocalizations: new Map(),
    sets: new Map(),
    ...initial,
  };
  const fake: FakeAsc = {
    state,
    writes,
    port: {
      async readAppBundleId(app) {
        assert.equal(app, appId);
        return state.bundleId;
      },
      async listAppInfos() {
        return structuredClone(state.appInfos);
      },
      async listAppInfoLocalizations(app, appInfoId) {
        assert.equal(app, appId);
        return structuredClone(state.appInfoLocalizations.get(appInfoId) ?? []);
      },
      async listVersions() {
        return structuredClone(state.versions);
      },
      async listVersionLocalizations(versionId) {
        return structuredClone(state.versionLocalizations.get(versionId) ?? []);
      },
      async listScreenshotSets(localizationId) {
        return structuredClone(state.sets.get(localizationId) ?? []);
      },
      async upsertAppInfoLocalization(input) {
        writes.push(`app-info ${input.locale}`);
        fail(`app-info ${input.locale}`);
        const list = state.appInfoLocalizations.get(input.appInfoId) ?? [];
        const existing = list.find((entry) => entry.locale === input.locale);
        const next = {
          id: existing?.id ?? id('ail'),
          locale: input.locale,
          name: input.name,
          subtitle: input.subtitle ?? existing?.subtitle,
          privacyPolicyUrl: input.privacyPolicyUrl ?? existing?.privacyPolicyUrl,
        };
        state.appInfoLocalizations.set(input.appInfoId, [
          ...list.filter((entry) => entry !== existing),
          next,
        ]);
      },
      async createVersionLocalization(input) {
        writes.push(`version-create ${input.locale}`);
        const list = state.versionLocalizations.get(input.versionId) ?? [];
        const created = { id: id('vl'), locale: input.locale, ...input.fields };
        state.versionLocalizations.set(input.versionId, [...list, created]);
        return created.id;
      },
      async updateVersionLocalization(input) {
        writes.push(`version-update ${Object.keys(input.fields).sort().join(',')}`);
        for (const list of state.versionLocalizations.values()) {
          const index = list.findIndex((entry) => entry.id === input.localizationId);
          if (index >= 0) {
            list[index] = { ...list[index] as AscVersionLocalization, ...input.fields };
          }
        }
      },
      async uploadScreenshot(input) {
        writes.push(`upload ${input.displayType} ${path.basename(input.file)}`);
        fail(`upload ${path.basename(input.file)}`);
        const sets = state.sets.get(input.versionLocalizationId) ?? [];
        let set = sets.find((candidate) => candidate.displayType === input.displayType);
        if (set === undefined) {
          set = { id: id('set'), displayType: input.displayType, screenshots: [] };
          sets.push(set);
          state.sets.set(input.versionLocalizationId, sets);
        }
        const shot = {
          id: id('shot'),
          sourceFileChecksum: md5(readFileSync(input.file)),
          deliveryState: 'COMPLETE',
        };
        (set.screenshots as typeof shot[]).push(shot);
        return shot;
      },
      async deleteScreenshot(screenshotId) {
        writes.push(`delete ${screenshotId}`);
        for (const sets of state.sets.values()) {
          for (const set of sets) {
            (set as unknown as { screenshots: unknown[] }).screenshots = set.screenshots.filter((shot) => shot.id !== screenshotId);
          }
        }
      },
    },
  };
  function fail(step: string): void {
    if (fake.failOn === step) {
      fake.failOn = undefined;
      throw new Error(`App Store Connect rejected ${step}`);
    }
  }
  return fake;
}

const root = mkdtempSync(path.join(tmpdir(), 'mpgd-app-store-presence-'));
const directory = path.join(root, 'game');
const images: Record<string, Buffer> = {
  'store/iphone-1.png': png(1320, 2868, 1),
  'store/iphone-2.png': png(1290, 2796, 2),
  'store/iphone-3.png': png(2868, 1320, 3),
  'store/ipad-1.png': png(2064, 2752, 4),
};
for (const [name, bytes] of Object.entries(images)) {
  mkdirSync(path.dirname(path.join(directory, name)), { recursive: true });
  writeFileSync(path.join(directory, name), bytes);
}

const english = {
  name: 'Block Party',
  subtitle: 'Stack with friends',
  description: 'Stack blocks with friends.\nA new puzzle every week.',
  keywords: 'blocks,puzzle,party',
  promotionalText: 'Season 2 is here.',
  whatsNew: 'New puzzles.',
  supportUrl: 'https://example.com/support',
};

function presence(locales: Record<string, unknown>): StorePresence {
  return assertStorePresence({
    version: '1',
    privacyPolicyUrl: 'https://example.com/privacy',
    appStore: { localizations: locales },
  });
}

const fullFile = presence({
  'en-US': {
    ...english,
    screenshots: {
      iphone69: ['store/iphone-1.png', 'store/iphone-2.png'],
      ipad13: { files: ['store/ipad-1.png'], complete: true },
    },
  },
  ko: {
    name: '블록 파티',
    description: '친구와 블록을 쌓아요.',
    keywords: '블록,퍼즐',
    supportUrl: 'https://example.com/support',
    screenshots: { iphone69: ['store/iphone-1.png'] },
  },
});

const input = (file: StorePresence) => ({ appId, bundleId, presence: file, directory });

/** An app with version 1.1.0 in preparation and English already on it. */
function seeded(): FakeAsc {
  const asc = fakeAsc();
  asc.state.appInfoLocalizations.set('info-next', [
    {
      id: 'ail-en',
      locale: 'en-US',
      name: 'Block Party',
      subtitle: 'Old subtitle',
      privacyPolicyUrl: 'https://example.com/privacy',
    },
  ]);
  asc.state.versionLocalizations.set('v2', [
    {
      id: 'vl-en',
      locale: 'en-US',
      ...english,
      description: 'Old description.',
      whatsNew: undefined,
    },
  ]);
  asc.state.sets.set('vl-en', [
    {
      id: 'set-ipad',
      displayType: 'APP_IPAD_PRO_3GEN_129',
      screenshots: [
        { id: 'old-ipad', sourceFileChecksum: 'a'.repeat(32), deliveryState: 'COMPLETE' },
      ],
    },
  ]);
  return asc;
}

try {
  // Plan: per locale the app information, the version localization and the screenshot sets.
  {
    const asc = seeded();
    const plan = await planAppStorePresence(input(fullFile), asc.port);
    assert.deepEqual(asc.writes, [], 'plan never writes');
    assert.deepEqual(plan.appInfo, { id: 'info-next', state: 'PREPARE_FOR_SUBMISSION' });
    assert.deepEqual(plan.version, {
      id: 'v2',
      versionString: '1.1.0',
      state: 'PREPARE_FOR_SUBMISSION',
      first: false,
    });
    const [en, ko] = plan.locales;
    assert.equal(en?.appInfo.action, 'update');
    assert.deepEqual(
      en?.appInfo.text.map((change) => change.field),
      ['subtitle'],
    );
    assert.equal(en?.version.action, 'update');
    assert.deepEqual(
      en?.version.write,
      { description: english.description, whatsNew: 'New puzzles.' },
      'only changed fields',
    );
    assert.deepEqual(
      en?.screenshots.map((set) => [set.display, set.action]),
      [
        ['iphone69', 'add'],
        ['ipad13', 'replace'],
      ],
    );
    assert.equal(plan.imageRemovals, 1, 'the complete iPad set drops the old screenshot');
    assert.equal(ko?.locale, 'ko');
    assert.equal(ko?.appInfo.action, 'create');
    assert.equal(ko?.version.action, 'create');
    assert.equal(ko?.screenshots[0]?.action, 'add');
    const printed = formatAppStorePresencePlan(plan);
    assert.match(printed, /version 1\.1\.0 PREPARE_FOR_SUBMISSION/u);
    assert.match(printed, /subtitle: "Old subtitle" -> "Stack with friends"/u);
    assert.match(printed, /replace +ipad13 \(APP_IPAD_PRO_3GEN_129\) complete set/u);
    assert.match(printed, /- old-ipad aaaaaaaaaaaa/u);
    assert.match(printed, /IMAGE REMOVAL: 1 screenshot/u);
    assert.match(printed, /submitting for review stay in App Store Connect/u);

    await assert.rejects(
      applyAppStorePresence({ saved: plan, plan: input(fullFile), port: asc.port, approved: true }),
      /--confirm-image-removal/u,
    );
    assert.deepEqual(asc.writes, []);
    const result = await applyAppStorePresence({
      saved: plan,
      plan: input(fullFile),
      port: asc.port,
      approved: true,
      confirmImageRemoval: true,
    });
    assert.equal(result.status, 'updated');
    assert.deepEqual(asc.writes, [
      'app-info en-US',
      'version-update description,whatsNew',
      'upload APP_IPHONE_67 iphone-1.png',
      'upload APP_IPHONE_67 iphone-2.png',
      'delete old-ipad',
      'upload APP_IPAD_PRO_3GEN_129 ipad-1.png',
      'app-info ko',
      'version-create ko',
      'upload APP_IPHONE_67 iphone-1.png',
    ]);
    const ipad = asc.state.sets.get('vl-en')?.find(
      (set) => set.displayType === 'APP_IPAD_PRO_3GEN_129',
    );
    assert.deepEqual(
      ipad?.screenshots.map((shot) => shot.sourceFileChecksum),
      [md5(images['store/ipad-1.png'] as Buffer)],
    );

    // A re-run is a no-op.
    const again = await planAppStorePresence(input(fullFile), asc.port);
    assert.equal(again.changed, false);
    assert.match(formatAppStorePresencePlan(again), /no changes/u);
    asc.writes.length = 0;
    const rerun = await applyAppStorePresence({
      saved: plan,
      plan: input(fullFile),
      port: asc.port,
      approved: true,
    });
    assert.equal(rerun.status, 'unchanged');
    assert.deepEqual(asc.writes, []);
  }

  // The first version takes no what's new; a missing editable version blocks the version part.
  {
    const first = fakeAsc({
      versions: [{ id: 'v1', versionString: '1.0.0', state: 'PREPARE_FOR_SUBMISSION' }],
    });
    const plan = await planAppStorePresence(input(presence({ 'en-US': english })), first.port);
    assert.equal(plan.version?.first, true);
    assert.equal(plan.locales[0]?.version.write?.whatsNew, undefined);
    assert.match(plan.notes.join('\n'), /No version of the app has been released yet/u);
    // A version that never reached the store (here an invalid binary) does not count as a release.
    const unreleased = fakeAsc({
      versions: [
        { id: 'v1', versionString: '1.0.0', state: 'INVALID_BINARY' },
        { id: 'v2', versionString: '1.0.1', state: 'PREPARE_FOR_SUBMISSION' },
      ],
    });
    assert.equal(
      (await planAppStorePresence(input(presence({ 'en-US': english })), unreleased.port)).version?.first,
      true,
    );
    // A release reported only through the legacy appStoreState counts.
    const legacy = fakeAsc({
      versions: [
        {
          id: 'v1',
          versionString: '1.0.0',
          state: 'UNKNOWN_STATE',
          appStoreState: 'READY_FOR_SALE',
        },
        { id: 'v2', versionString: '1.0.1', state: 'PREPARE_FOR_SUBMISSION' },
      ],
    });
    assert.equal(
      (await planAppStorePresence(input(presence({ 'en-US': english })), legacy.port)).version?.first,
      false,
    );

    const live = fakeAsc({
      appInfos: [{ id: 'info-live', state: 'READY_FOR_DISTRIBUTION' }],
      versions: [{ id: 'v1', versionString: '1.0.0', state: 'READY_FOR_SALE' }],
    });
    live.state.appInfoLocalizations.set('info-live', [
      { id: 'ail', locale: 'en-US', name: 'Old name' },
    ]);
    const blocked = await planAppStorePresence(
      input(
        presence({ 'en-US': { ...english, screenshots: { iphone69: ['store/iphone-1.png'] } } }),
      ),
      live.port,
    );
    assert.equal(blocked.changed, false, 'nothing is writable');
    assert.equal(blocked.blocked, 2);
    assert.match(formatAppStorePresencePlan(blocked), /nothing writable now \(2 blocked\)/u);
    assert.equal(blocked.locales[0]?.appInfo.action, 'blocked');
    assert.equal(blocked.locales[0]?.version.action, 'blocked');
    assert.deepEqual(blocked.locales[0]?.screenshots, []);
    assert.match(blocked.manual.join('\n'), /No iOS version is editable/u);
    assert.match(blocked.manual.join('\n'), /editable only while an app information record/u);
    assert.match(blocked.notes.join('\n'), /screenshots wait for an editable version/u);
    assert.equal(
      (await applyAppStorePresence({ saved: blocked, plan: input(presence({ 'en-US': english })), port: live.port, approved: true })).status,
      'unchanged',
    );

    const two = fakeAsc({
      versions: [
        { id: 'v2', state: 'PREPARE_FOR_SUBMISSION' },
        { id: 'v3', state: 'REJECTED' },
      ],
    });
    await assert.rejects(
      planAppStorePresence(input(presence({ 'en-US': english })), two.port),
      /2 editable iOS versions/u,
    );
    const other = fakeAsc({ bundleId: 'dev.other' });
    await assert.rejects(
      planAppStorePresence(input(presence({ 'en-US': english })), other.port),
      /bundle ID dev\.other/u,
    );
  }

  // Lists keep what the file does not name; failed deliveries are reported.
  {
    const asc = seeded();
    asc.state.sets.set('vl-en', [
      {
        id: 'set-iphone',
        displayType: 'APP_IPHONE_67',
        screenshots: [
          {
            id: 'kept',
            sourceFileChecksum: md5(images['store/iphone-1.png'] as Buffer),
            deliveryState: 'COMPLETE',
          },
          { id: 'broken', deliveryState: 'FAILED' },
        ],
      },
    ]);
    const file = presence({
      'en-US': {
        ...english,
        screenshots: { iphone69: ['store/iphone-1.png', 'store/iphone-3.png'] },
      },
    });
    const plan = await planAppStorePresence(input(file), asc.port);
    const [set] = plan.locales[0]?.screenshots ?? [];
    assert.equal(set?.action, 'add');
    assert.deepEqual(
      set?.upload.map((image) => image.path),
      ['store/iphone-3.png'],
    );
    assert.match(set?.notes.join('\n') ?? '', /keeps 1 image/u);
    assert.match(set?.notes.join('\n') ?? '', /broken is FAILED/u);
    assert.equal(plan.imageRemovals, 0);

    // A failed delivery whose checksum matches is not "present": a complete set replaces it.
    const failed = seeded();
    const iphone1 = md5(images['store/iphone-1.png'] as Buffer);
    failed.state.sets.set('vl-en', [
      {
        id: 'set-iphone',
        displayType: 'APP_IPHONE_67',
        screenshots: [{ id: 'failed', sourceFileChecksum: iphone1, deliveryState: 'FAILED' }],
      },
    ]);
    const completeFile = presence({
      'en-US': {
        ...english,
        screenshots: { iphone69: { files: ['store/iphone-1.png'], complete: true } },
      },
    });
    const repaired = await planAppStorePresence(input(completeFile), failed.port);
    assert.equal(repaired.locales[0]?.screenshots[0]?.action, 'replace');
    assert.deepEqual(repaired.locales[0]?.screenshots[0]?.deleteIds, ['failed']);

    // A screenshot App Store Connect is still processing: plan again later.
    failed.state.sets.set('vl-en', [
      {
        id: 'set-iphone',
        displayType: 'APP_IPHONE_67',
        screenshots: [{ id: 'settling', deliveryState: 'COMPLETE' }],
      },
    ]);
    // Only that set waits; the text and the other sets still plan.
    const waiting = await planAppStorePresence(input(completeFile), failed.port);
    assert.equal(waiting.blocked, 1);
    assert.equal(waiting.locales[0]?.screenshots[0]?.action, 'unchanged');
    assert.match(
      waiting.locales[0]?.screenshots[0]?.notes.join('\n') ?? '',
      /still processing screenshot settling/u,
    );
    assert.equal(waiting.locales[0]?.version.action, 'update', 'the text still plans');

    // A complete set that only changes order deletes and re-uploads the whole set: it needs the confirmation.
    const ordered = seeded();
    ordered.state.sets.set('vl-en', [
      {
        id: 'set-iphone',
        displayType: 'APP_IPHONE_67',
        screenshots: [
          {
            id: 's1',
            sourceFileChecksum: md5(images['store/iphone-1.png'] as Buffer),
            deliveryState: 'COMPLETE',
          },
          {
            id: 's2',
            sourceFileChecksum: md5(images['store/iphone-2.png'] as Buffer),
            deliveryState: 'COMPLETE',
          },
        ],
      },
    ]);
    const swapped = presence({
      'en-US': {
        ...english,
        screenshots: {
          iphone69: { files: ['store/iphone-2.png', 'store/iphone-1.png'], complete: true },
        },
      },
    });
    const reorder = await planAppStorePresence(input(swapped), ordered.port);
    assert.equal(reorder.imageRemovals, 2);
    assert.match(
      reorder.locales[0]?.screenshots[0]?.notes.join('\n') ?? '',
      /whole set \(2\) is deleted/u,
    );
    await assert.rejects(
      applyAppStorePresence({
        saved: reorder,
        plan: input(swapped),
        port: ordered.port,
        approved: true,
      }),
      /--confirm-image-removal/u,
    );
    assert.ok(!ordered.writes.some((write) => write.startsWith('delete')));

    // A new locale with no editable app information record waits whole: no half-added locale.
    const noInfo = fakeAsc({ appInfos: [{ id: 'info-live', state: 'READY_FOR_DISTRIBUTION' }] });
    const newLocale = await planAppStorePresence(
      input(
        presence({
          ko: {
            name: '블록',
            description: 'd',
            keywords: 'k',
            supportUrl: 'https://example.com',
            screenshots: { iphone69: ['store/iphone-1.png'] },
          },
        }),
      ),
      noInfo.port,
    );
    assert.equal(newLocale.locales[0]?.appInfo.action, 'blocked');
    assert.equal(newLocale.locales[0]?.version.action, 'blocked');
    assert.deepEqual(newLocale.locales[0]?.screenshots, []);
    assert.equal(newLocale.changed, false);
    assert.match(newLocale.notes.join('\n'), /ko: not on App Store Connect yet/u);

    // Without an editable record the live one is read, not a replaced older one; CRLF text matches LF.
    const stale = fakeAsc({
      appInfos: [
        { id: 'info-old', state: 'REPLACED_WITH_NEW_INFO' },
        { id: 'info-live', state: 'READY_FOR_DISTRIBUTION' },
      ],
    });
    stale.state.appInfoLocalizations.set('info-old', [
      { id: 'old', locale: 'en-US', name: 'Ancient' },
    ]);
    stale.state.appInfoLocalizations.set('info-live', [
      {
        id: 'live',
        locale: 'en-US',
        name: english.name,
        subtitle: english.subtitle,
        privacyPolicyUrl: 'https://example.com/privacy',
      },
    ]);
    stale.state.versionLocalizations.set('v2', [{ id: 'vl-en', locale: 'en-US', ...english }]);
    const crlf = await planAppStorePresence(
      input(
        presence({
          'en-US': { ...english, description: english.description.replace(/\n/gu, '\r\n') },
        }),
      ),
      stale.port,
    );
    assert.equal(crlf.locales[0]?.appInfo.action, 'unchanged', 'compared with the live record');
    assert.equal(crlf.locales[0]?.version.action, 'unchanged', 'CRLF matches LF');
  }

  // Stale plans and failures.
  {
    const asc = seeded();
    const plan = await planAppStorePresence(input(fullFile), asc.port);
    asc.state.versionLocalizations.get('v2')?.splice(0, 1, {
      id: 'vl-en',
      locale: 'en-US',
      ...english,
      description: 'Edited in App Store Connect.',
    });
    await assert.rejects(
      applyAppStorePresence({
        saved: plan,
        plan: input(fullFile),
        port: asc.port,
        approved: true,
        confirmImageRemoval: true,
      }),
      StorePlanStaleError,
    );
    assert.deepEqual(asc.writes, []);

    // An upload fails after the set was cleared: the error says so and names what landed.
    const failing = seeded();
    const failingPlan = await planAppStorePresence(input(fullFile), failing.port);
    failing.failOn = 'upload ipad-1.png';
    await assert.rejects(
      applyAppStorePresence({ saved: failingPlan, plan: input(fullFile), port: failing.port, approved: true, confirmImageRemoval: true }),
      (error: unknown) => error instanceof AppStorePresenceApplyError
        && /en-US ipad13 upload of store\/ipad-1\.png/u.test(error.message)
        && /ipad13 screenshots were deleted before the upload/u.test(error.message)
        && error.written.includes('en-US app information'),
    );
    // App Store Connect refuses a text write (asc exits with a 4xx code): nothing from that step landed.
    const refusing = seeded();
    const refusingPlan = await planAppStorePresence(input(fullFile), refusing.port);
    const refusingPort: AscStorePresencePort = {
      ...refusing.port,
      async updateVersionLocalization() {
        throw new ReleaseProcessError('exit', 'ENTITY_ERROR.ATTRIBUTE.INVALID', 32);
      },
    };
    await assert.rejects(
      applyAppStorePresence({ saved: refusingPlan, plan: input(fullFile), port: refusingPort, approved: true, confirmImageRemoval: true }),
      (error: unknown) => error instanceof AppStorePresenceApplyError && error.definitive
        && /nothing from this step landed/u.test(error.message),
    );
    // A generic asc failure (exit 1, for example a network error) stays uncertain.
    const unsure = seeded();
    const unsurePlan = await planAppStorePresence(input(fullFile), unsure.port);
    await assert.rejects(
      applyAppStorePresence({
        saved: unsurePlan,
        plan: input(fullFile),
        port: { ...unsure.port, async updateVersionLocalization() { throw new ReleaseProcessError('exit', 'timeout', 1); } },
        approved: true,
        confirmImageRemoval: true,
      }),
      (error: unknown) => error instanceof AppStorePresenceApplyError && !error.definitive
        && /result is unknown/u.test(error.message),
    );

    // The next plan shows only what is left.
    const rest = await planAppStorePresence(input(fullFile), failing.port);
    assert.equal(rest.locales[0]?.appInfo.action, 'unchanged');
    assert.equal(
      rest.locales[0]?.screenshots.find((set) => set.display === 'ipad13')?.action,
      'add',
    );
    assert.equal(rest.imageRemovals, 0);

    // A screenshot changed after the plan.
    const changed = seeded();
    const changedPlan = await planAppStorePresence(input(fullFile), changed.port);
    writeFileSync(path.join(directory, 'store/iphone-2.png'), png(1290, 2796, 99));
    await assert.rejects(
      applyAppStorePresence({
        saved: changedPlan,
        plan: input(fullFile),
        port: changed.port,
        approved: true,
        confirmImageRemoval: true,
      }),
      StorePlanStaleError,
    );
    writeFileSync(
      path.join(directory, 'store/iphone-2.png'),
      images['store/iphone-2.png'] as Buffer,
    );

    // A replaced set's files are all checked before the set is cleared.
    const replaced = seeded();
    const replacedPlan = await planAppStorePresence(input(fullFile), replaced.port);
    const ipadFile = path.join(directory, 'store/ipad-1.png');
    const originalIpad = readFileSync(ipadFile);
    const changingPort: AscStorePresencePort = {
      ...replaced.port,
      async uploadScreenshot(upload) {
        if (path.basename(upload.file) === 'iphone-2.png') {
          writeFileSync(ipadFile, png(2064, 2752, 55));
        }
        return replaced.port.uploadScreenshot(upload);
      },
    };
    await assert.rejects(
      applyAppStorePresence({
        saved: replacedPlan,
        plan: input(fullFile),
        port: changingPort,
        approved: true,
        confirmImageRemoval: true,
      }),
      /ipad-1\.png changed since the plan/u,
    );
    assert.ok(
      !replaced.writes.includes('delete old-ipad'),
      'the set is not cleared for a changed file',
    );
    writeFileSync(ipadFile, originalIpad);

    // asc gets the real path of a screenshot reached through a symbolic link inside the game.
    symlinkSync(
      path.join(directory, 'store/iphone-3.png'),
      path.join(directory, 'store/linked.png'),
    );
    const linked = fakeAsc();
    const uploaded: string[] = [];
    const linkedPort: AscStorePresencePort = {
      ...linked.port,
      async uploadScreenshot(upload) {
        uploaded.push(upload.file);
        return linked.port.uploadScreenshot(upload);
      },
    };
    const linkedFile = presence({
      'en-US': { ...english, screenshots: { iphone69: ['store/linked.png'] } },
    });
    const linkedPlan = await planAppStorePresence(input(linkedFile), linkedPort);
    await applyAppStorePresence({
      saved: linkedPlan,
      plan: input(linkedFile),
      port: linkedPort,
      approved: true,
    });
    assert.equal(uploaded.length, 1);
    assert.equal(
      path.basename(uploaded[0] ?? ''),
      'linked.png',
      'asc gets a private copy under the file name',
    );
    assert.ok(!(uploaded[0] ?? '').startsWith(directory), 'not the game file or its link');

    // A file changed while the uploads run is not picked up: the set's bytes were copied when checked.
    const racing = seeded();
    const racingFile = presence({
      'en-US': {
        ...english,
        screenshots: { iphone69: ['store/iphone-1.png', 'store/iphone-2.png'] },
      },
    });
    const racingPlan = await planAppStorePresence(input(racingFile), racing.port);
    const iphone2 = path.join(directory, 'store/iphone-2.png');
    const racingPort: AscStorePresencePort = {
      ...racing.port,
      async uploadScreenshot(upload) {
        if (path.basename(upload.file) === 'iphone-1.png') {
          writeFileSync(iphone2, png(1290, 2796, 77));
        }
        return racing.port.uploadScreenshot(upload);
      },
    };
    await applyAppStorePresence({
      saved: racingPlan,
      plan: input(racingFile),
      port: racingPort,
      approved: true,
    });
    writeFileSync(iphone2, images['store/iphone-2.png'] as Buffer);
    const racedSet = racing.state.sets.get('vl-en')?.find(
      (set) => set.displayType === 'APP_IPHONE_67',
    );
    assert.deepEqual(
      racedSet?.screenshots.map((shot) => shot.sourceFileChecksum),
      [md5(images['store/iphone-1.png'] as Buffer), md5(images['store/iphone-2.png'] as Buffer)],
      'the reviewed bytes are uploaded',
    );

    // Image rules apply before App Store Connect is asked anything.
    writeFileSync(path.join(directory, 'store/wrong.png'), png(1080, 1920, 7));
    const untouched = seeded();
    await assert.rejects(
      planAppStorePresence(
        input(presence({ 'en-US': { ...english, screenshots: { ipad13: ['store/wrong.png'] } } })),
        untouched.port,
      ),
      /not an App Store ipad13 screenshot size/u,
    );
    await assert.rejects(
      planAppStorePresence(
        {
          ...input(fullFile),
          presence: assertStorePresence({
            version: '1',
            googlePlay: {
              listings: { 'en-US': { title: 't', shortDescription: 's', fullDescription: 'f' } },
            },
          }),
        },
        untouched.port,
      ),
      /no appStore section/u,
    );
  }

  // The asc command lines and output parsing, against recorded asc 5.5.0 output shapes.
  {
    const calls: string[][] = [];
    const responses = new Map<string, unknown>([
      ['apps view', { data: { type: 'apps', id: appId, attributes: { bundleId } } }],
      [
        'apps info list',
        {
          data: [
            { type: 'appInfos', id: 'info-live', attributes: { state: 'READY_FOR_DISTRIBUTION' } },
            {
              type: 'appInfos',
              id: 'info-next',
              attributes: { appStoreState: 'PREPARE_FOR_SUBMISSION' },
            },
          ],
        },
      ],
      [
        'localizations list --type',
        {
          data: [
            {
              type: 'appInfoLocalizations',
              id: 'ail',
              attributes: {
                locale: 'en-US',
                name: 'Block Party',
                subtitle: '',
                privacyPolicyUrl: 'https://example.com/privacy',
              },
            },
          ],
        },
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
                appStoreState: 'PREPARE_FOR_SUBMISSION',
                appVersionState: 'PREPARE_FOR_SUBMISSION',
                createdDate: '2026-10-01T00:00:00Z',
              },
            },
          ],
        },
      ],
      [
        'localizations list --version',
        {
          data: [
            {
              type: 'appStoreVersionLocalizations',
              id: 'vl',
              attributes: {
                locale: 'en-US',
                description: 'd',
                keywords: 'k',
                supportUrl: 'https://example.com/support',
                whatsNew: '',
              },
            },
          ],
        },
      ],
      [
        'screenshots list',
        {
          versionLocalizationId: 'vl',
          sets: [
            {
              set: {
                type: 'appScreenshotSets',
                id: 'set-1',
                attributes: { screenshotDisplayType: 'APP_IPHONE_67' },
              },
              screenshots: [
                {
                  type: 'appScreenshots',
                  id: 'shot-1',
                  attributes: {
                    fileName: '1.png',
                    fileSize: 10,
                    sourceFileChecksum: 'abc',
                    assetDeliveryState: { state: 'COMPLETE' },
                  },
                },
              ],
            },
          ],
        },
      ],
      [
        'app-setup info set',
        { appId, appInfoLocalization: { data: { type: 'appInfoLocalizations', id: 'ail' } } },
      ],
      [
        'localizations create',
        {
          data: { type: 'appStoreVersionLocalizations', id: 'vl-new', attributes: { locale: 'ko' } },
        },
      ],
      [
        'localizations update',
        { data: { type: 'appStoreVersionLocalizations', id: 'vl', attributes: {} } },
      ],
      [
        'screenshots upload',
        {
          versionLocalizationId: 'vl',
          setId: 'set-1',
          displayType: 'APP_IPHONE_67',
          results: [
            {
              fileName: 'iphone-1.png',
              filePath: '/x/iphone-1.png',
              assetId: 'shot-2',
              state: 'COMPLETE',
            },
          ],
        },
      ],
      ['screenshots delete', { id: 'shot-1', deleted: true }],
    ]);
    const port = createAscStorePresencePort(async (args) => {
      calls.push([...args]);
      const joined = args.join(' ');
      const key = joined.startsWith('localizations list')
        ? args.includes('app-info')
          ? 'localizations list --type'
          : 'localizations list --version'
        : [...responses.keys()].find((prefix) => joined.startsWith(prefix));
      assert.ok(key !== undefined, `unexpected asc ${args.join(' ')}`);
      return structuredClone(responses.get(key));
    });
    assert.equal(await port.readAppBundleId(appId), bundleId);
    assert.deepEqual(await port.listAppInfos(appId), [
      { id: 'info-live', state: 'READY_FOR_DISTRIBUTION' },
      { id: 'info-next', state: 'PREPARE_FOR_SUBMISSION' },
    ]);
    assert.deepEqual(await port.listAppInfoLocalizations(appId, 'info-next'), [
      {
        id: 'ail',
        locale: 'en-US',
        name: 'Block Party',
        privacyPolicyUrl: 'https://example.com/privacy',
      },
    ]);
    assert.deepEqual(calls.at(-1), [
      'localizations',
      'list',
      '--type',
      'app-info',
      '--app',
      appId,
      '--app-info',
      'info-next',
      '--paginate',
    ]);
    assert.deepEqual(await port.listVersions(appId), [
      {
        id: 'v2',
        versionString: '1.1.0',
        state: 'PREPARE_FOR_SUBMISSION',
        appStoreState: 'PREPARE_FOR_SUBMISSION',
        createdDate: '2026-10-01T00:00:00Z',
      },
    ]);
    assert.deepEqual(calls.at(-1), [
      'versions',
      'list',
      '--app',
      appId,
      '--platform',
      'IOS',
      '--paginate',
    ]);
    assert.deepEqual(await port.listVersionLocalizations('v2'), [
      {
        id: 'vl',
        locale: 'en-US',
        description: 'd',
        keywords: 'k',
        supportUrl: 'https://example.com/support',
      },
    ]);
    assert.deepEqual(await port.listScreenshotSets('vl'), [
      {
        id: 'set-1',
        displayType: 'APP_IPHONE_67',
        screenshots: [
          { id: 'shot-1', fileName: '1.png', sourceFileChecksum: 'abc', deliveryState: 'COMPLETE' },
        ],
      },
    ]);
    await port.upsertAppInfoLocalization({
      appId,
      appInfoId: 'info-next',
      locale: 'ko',
      name: '블록',
      privacyPolicyUrl: 'https://example.com/privacy',
    });
    assert.deepEqual(calls.at(-1), [
      'app-setup',
      'info',
      'set',
      '--app',
      appId,
      '--app-info',
      'info-next',
      '--locale',
      'ko',
      '--name',
      '블록',
      '--privacy-policy-url',
      'https://example.com/privacy',
    ]);
    assert.equal(
      await port.createVersionLocalization({ versionId: 'v2', locale: 'ko', fields: { description: 'd\ne', keywords: 'k', supportUrl: 'https://example.com/s' } }),
      'vl-new',
    );
    assert.deepEqual(calls.at(-1), [
      'localizations',
      'create',
      '--version',
      'v2',
      '--locale',
      'ko',
      '--description',
      'd\ne',
      '--keywords',
      'k',
      '--support-url',
      'https://example.com/s',
    ]);
    await port.updateVersionLocalization({
      localizationId: 'vl',
      fields: { whatsNew: 'New', promotionalText: 'P' },
    });
    assert.deepEqual(calls.at(-1), [
      'localizations',
      'update',
      '--id',
      'vl',
      '--promotional-text',
      'P',
      '--whats-new',
      'New',
    ]);
    const before = calls.length;
    await port.updateVersionLocalization({ localizationId: 'vl', fields: {} });
    assert.equal(calls.length, before, 'no empty update is sent');
    assert.deepEqual(
      await port.uploadScreenshot({ versionLocalizationId: 'vl', displayType: 'APP_IPHONE_67', file: '/x/iphone-1.png' }),
      { id: 'shot-2', deliveryState: 'COMPLETE' },
    );
    assert.deepEqual(calls.at(-1), [
      'screenshots',
      'upload',
      '--version-localization',
      'vl',
      '--path',
      '/x/iphone-1.png',
      '--device-type',
      'APP_IPHONE_67',
    ]);
    await port.deleteScreenshot('shot-1');
    assert.deepEqual(calls.at(-1), ['screenshots', 'delete', '--id', 'shot-1', '--confirm']);

    // An upload asc reports as not delivered fails clearly.
    responses.set('screenshots upload', {
      results: [{ assetId: 'shot-3', state: 'UPLOAD_COMPLETE' }],
    });
    await assert.rejects(
      port.uploadScreenshot({
        versionLocalizationId: 'vl',
        displayType: 'APP_IPHONE_67',
        file: '/x/a.png',
      }),
      /shot-3 as UPLOAD_COMPLETE/u,
    );
    responses.set('screenshots upload', { results: [] });
    await assert.rejects(
      port.uploadScreenshot({
        versionLocalizationId: 'vl',
        displayType: 'APP_IPHONE_67',
        file: '/x/a.png',
      }),
      /no uploaded screenshot/u,
    );
  }

  // The command: the iOS profile, the asc credential, one session, the saved plan.
  {
    const game = directory;
    mkdirSync(path.join(game, 'apps/mobile'), { recursive: true });
    writeFileSync(path.join(game, 'apps/mobile/package.json'), '{"name":"mobile"}\n');
    writeFileSync(path.join(game, 'mpgd.targets.json'), `${JSON.stringify({
      targets: {
        ios: {
          kind: 'capacitor-ios',
          adapter: 'capacitor',
          artifact: 'ipa',
          gameApp: '.',
          shellApp: 'apps/mobile',
          webDir: 'apps/mobile/www',
          metadata: { bundleId },
        },
      },
    }, null, 2)}\n`);
    const configFile = initializeDeployConfig(game);
    const config = JSON.parse(readFileSync(configFile, 'utf8')) as {
      profiles: { beta: { targets: { ios: Record<string, unknown> } } };
    };
    config.profiles.beta.targets.ios.testGroup = 'group-1';
    writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
    writeFileSync(
      path.join(game, 'mpgd.store-presence.json'),
      `${JSON.stringify(fullFile, null, 2)}\n`,
    );
    const credentialName = String(
      (config.profiles.beta.targets.ios.submissionCredential as { env: string }).env,
    );
    const environment = {
      MPGD_ASC_BINARY: '/opt/asc',
      MPGD_ASC_APP_ID: appId,
      MPGD_ASC_KEY_ID: 'ABCDE12345',
      MPGD_ASC_ISSUER_ID: 'issuer',
      [credentialName]: 'cHJpdmF0ZQ==',
    };
    const asc = seeded();
    const sessions: { binary: string; closed: boolean }[] = [];
    const ports = {
      appStore: async (credential: { ascBinary: string }) => {
        const session = { binary: credential.ascBinary, closed: false };
        sessions.push(session);
        return {
          port: asc.port,
          close: () => {
            session.closed = true;
          },
        };
      },
    };
    await assert.rejects(
      planStorePresence(
        { game, profile: 'beta', store: 'app-store' },
        { MPGD_ASC_BINARY: '/opt/asc' },
        ports,
      ),
      /MPGD_ASC_APP_ID/u,
    );
    const planned = await planStorePresence(
      { game, profile: 'beta', store: 'app-store' },
      environment,
      ports,
    );
    assert.equal(planned.plan.store, 'app-store');
    assert.deepEqual(
      sessions,
      [{ binary: '/opt/asc', closed: true }],
      'one session, closed after the plan',
    );
    const planFile = path.join(root, 'app-store-presence-plan.json');
    saveStorePresencePlan(planFile, planned);
    await assert.rejects(
      applyStorePresence({ planFile, approved: true }, environment, ports),
      /--confirm-image-removal/u,
    );
    await assert.rejects(
      applyStorePresence(
        { planFile, approved: true, confirmImageRemoval: true, changesNotSentForReview: true },
        environment,
        ports,
      ),
      /Google Play only/u,
    );
    const applied = await applyStorePresence(
      { planFile, approved: true, confirmImageRemoval: true },
      environment,
      ports,
    );
    assert.equal(applied.status, 'updated');
    assert.ok(sessions.every((session) => session.closed));
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.info('App Store Connect store presence sync tests passed.');
