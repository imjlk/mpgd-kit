import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { assertStorePresence, type StorePresence } from '@mpgd/catalog';

import { initializeDeployConfig } from './deploy-planning.js';
import type {
  PlayAppDetails,
  PlayImage,
  PlayListing,
  PlayStoreListingPort,
} from './play-listing-port.js';
import {
  applyStorePresence,
  planStorePresence,
  saveStorePresencePlan,
} from './store-presence-command.js';
import {
  applyPlayPresence,
  formatPlayPresencePlan,
  planPlayPresence,
  PlayPresenceApplyError,
  type PlayPresencePlan,
} from './store-presence-play.js';
import { StorePlanStaleError } from './store-sync.js';

const packageName = 'dev.mpgd.store';

/** PNG header bytes (signature, IHDR, IDAT, IEND); `seed` makes the digest differ. */
function png(width: number, height: number, seed: number, colorType = 2): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    return Buffer.concat([length, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = colorType;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', Buffer.from([seed & 0xff, (seed >> 8) & 0xff])),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

interface PlayState {
  details: PlayAppDetails;
  listings: Map<string, PlayListing>;
  images: Map<string, PlayImage[]>;
}

interface FakePlay {
  readonly port: PlayStoreListingPort;
  state: PlayState;
  readonly writes: string[];
  readonly edits: string[];
  failOn?: string | undefined;
  /** Play answers uploads with another digest, as if it re-encoded them. */
  reencode?: boolean;
}

const clone = (state: PlayState): PlayState => ({
  details: { ...state.details },
  listings: new Map([...state.listings].map(([key, value]) => [key, { ...value }])),
  images: new Map(
    [...state.images].map(([key, value]) => [key, value.map((image) => ({ ...image }))]),
  ),
});

/** In-memory Play with edit semantics: an edit is a copy, commit replaces the app's state. */
function fakePlay(initial: Partial<PlayState> = {}): FakePlay {
  const open = new Map<string, PlayState>();
  let nextEdit = 0;
  let nextImage = 0;
  const writes: string[] = [];
  const edits: string[] = [];
  const fake: FakePlay = {
    state: {
      details: initial.details ?? { defaultLanguage: 'en-US' },
      listings: initial.listings ?? new Map(),
      images: initial.images ?? new Map(),
    },
    writes,
    edits,
    port: {
      async insertEdit(name) {
        assert.equal(name, packageName);
        nextEdit += 1;
        const id = `edit-${nextEdit}`;
        open.set(id, clone(fake.state));
        edits.push(`insert ${id}`);
        return id;
      },
      async deleteEdit(_name, editId) {
        edits.push(`delete ${editId}`);
        open.delete(editId);
      },
      async commitEdit(input) {
        edits.push(`commit ${input.editId}${input.changesNotSentForReview ? ' not-sent' : ''}`);
        fail('commit');
        const state = edit(input.editId);
        fake.state = state;
        open.delete(input.editId);
      },
      async getDetails(_name, editId) {
        return { ...edit(editId).details };
      },
      async updateDetails(input) {
        writes.push(`details ${JSON.stringify(input.details)}`);
        fail('details');
        edit(input.editId).details = { ...input.details };
      },
      async listListings(_name, editId) {
        return [...edit(editId).listings.values()].map((listing) => ({ ...listing }));
      },
      async updateListing(input) {
        writes.push(`listing ${input.listing.language}`);
        fail(`listing ${input.listing.language}`);
        edit(input.editId).listings.set(input.listing.language, { ...input.listing });
      },
      async listImages(input) {
        const state = edit(input.editId);
        assert.ok(
          state.listings.has(input.language),
          `images of ${input.language} read before it exists`,
        );
        return (state.images.get(`${input.language}/${input.imageType}`) ?? []).map((image) => ({
          ...image,
        }));
      },
      async uploadImage(input) {
        writes.push(`upload ${input.language}/${input.imageType} ${path.basename(input.file)}`);
        fail(`upload ${path.basename(input.file)}`);
        const state = edit(input.editId);
        assert.ok(state.listings.has(input.language), 'images go to an existing listing');
        assert.ok(input.mimeType === 'image/png');
        nextImage += 1;
        const digest = fake.reencode === true ? 'f'.repeat(64) : sha256(readFileSync(input.file));
        const image = { id: `img-${nextImage}`, sha256: digest };
        const key = `${input.language}/${input.imageType}`;
        state.images.set(key, [...(state.images.get(key) ?? []), image]);
        return image;
      },
      async deleteAllImages(input) {
        writes.push(`deleteall ${input.language}/${input.imageType}`);
        edit(input.editId).images.set(`${input.language}/${input.imageType}`, []);
      },
    },
  };
  function edit(editId: string): PlayState {
    const state = open.get(editId);
    assert.ok(state !== undefined, `edit ${editId} is open`);
    return state;
  }
  function fail(step: string): void {
    if (fake.failOn === step) {
      fake.failOn = undefined;
      throw new Error(`Play rejected ${step}`);
    }
  }
  return fake;
}

interface Fixture {
  readonly root: string;
  readonly directory: string;
  readonly images: Readonly<Record<string, Buffer>>;
  write(name: string, bytes: Buffer): void;
}

function makeFixture(): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), 'mpgd-store-presence-'));
  const directory = path.join(root, 'game');
  mkdirSync(path.join(directory, 'store'), { recursive: true });
  const images: Record<string, Buffer> = {
    'store/icon.png': png(512, 512, 1, 6),
    'store/feature.png': png(1024, 500, 2),
    'store/phone-1.png': png(1080, 1920, 3),
    'store/phone-2.png': png(1080, 1920, 4),
    'store/phone-3.png': png(1080, 1920, 5),
    'store/tablet-1.png': png(1920, 1080, 6),
  };
  const write = (name: string, bytes: Buffer): void => {
    mkdirSync(path.dirname(path.join(directory, name)), { recursive: true });
    writeFileSync(path.join(directory, name), bytes);
  };
  for (const [name, bytes] of Object.entries(images)) {
    write(name, bytes);
  }
  return { root, directory, images, write };
}

const longDescription = `${'Stack blocks with friends. '.repeat(10)}\nEvery week a new puzzle.`;

function presence(overrides: Partial<NonNullable<StorePresence['googlePlay']>> = {}): StorePresence {
  return assertStorePresence({
    version: '2026-10-27',
    privacyPolicyUrl: 'https://example.com/privacy',
    googlePlay: {
      listings: {
        'en-US': {
          title: 'Block Party',
          shortDescription: 'Stack blocks with friends.',
          fullDescription: longDescription,
          graphics: {
            icon: 'store/icon.png',
            featureGraphic: 'store/feature.png',
            phoneScreenshots: ['store/phone-1.png', 'store/phone-2.png'],
            tenInchScreenshots: { files: ['store/tablet-1.png'], complete: true },
          },
        },
        'ko-KR': {
          title: '블록 파티',
          shortDescription: '친구와 블록을 쌓아요.',
          fullDescription: '매주 새 퍼즐.',
        },
      },
      ...overrides,
    },
  });
}

const input = (fixture: Fixture, file: StorePresence = presence()) => ({
  packageName,
  presence: file,
  directory: fixture.directory,
});

// A draft app: Play has an English listing without graphics.
{
  const fixture = makeFixture();
  try {
    const play = fakePlay({
      listings: new Map([
        [
          'en-US',
          { language: 'en-US', title: 'Block', shortDescription: 'Old', fullDescription: 'Old.' },
        ],
      ]),
      details: { defaultLanguage: 'en-US', contactEmail: 'old@example.com' },
    });
    const plan = await planPlayPresence(input(fixture), play.port);
    assert.deepEqual(play.writes, [], 'plan never writes');
    assert.deepEqual(play.edits, ['insert edit-1', 'delete edit-1'], 'plan discards its read edit');
    assert.equal(plan.changed, true);
    assert.equal(plan.imageRemovals, 0);
    const [english, korean] = plan.languages;
    assert.equal(english?.action, 'update');
    assert.deepEqual(
      english?.text.map((change) => change.field),
      ['title', 'shortDescription', 'fullDescription'],
    );
    const title = english?.text[0];
    assert.equal(title?.from, 'Block', 'short texts are shown');
    assert.equal(title?.to, 'Block Party');
    const full = english?.text[2];
    assert.equal(full?.to, undefined, 'long texts show lengths only');
    assert.equal(full?.toLength, [...longDescription].length);
    assert.deepEqual(
      english?.images.map((slot) => [slot.imageType, slot.action, slot.upload.length]),
      [
        ['icon', 'add', 1],
        ['featureGraphic', 'add', 1],
        ['phoneScreenshots', 'add', 2],
        ['tenInchScreenshots', 'add', 1],
      ],
    );
    assert.equal(korean?.action, 'create');
    assert.equal(korean?.language, 'ko-KR');
    assert.match(plan.manual.join('\n'), /Privacy policy .*https:\/\/example\.com\/privacy/u);
    const printed = formatPlayPresencePlan(plan);
    assert.match(printed, /update +en-US/u);
    assert.match(printed, /title: "Block" -> "Block Party"/u);
    assert.match(printed, /fullDescription: 4 chars -> \d+ chars/u);
    assert.match(printed, /\+ store\/phone-1\.png/u);
    assert.match(printed, /create +ko-KR/u);

    await assert.rejects(
      applyPlayPresence({ saved: plan, plan: input(fixture), port: play.port, approved: false }),
      /--approve/u,
    );
    play.edits.length = 0;
    const result = await applyPlayPresence({
      saved: plan,
      plan: input(fixture),
      port: play.port,
      approved: true,
    });
    assert.equal(result.status, 'committed');
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(play.writes, [
      'listing en-US',
      'upload en-US/icon icon.png',
      'upload en-US/featureGraphic feature.png',
      'upload en-US/phoneScreenshots phone-1.png',
      'upload en-US/phoneScreenshots phone-2.png',
      'upload en-US/tenInchScreenshots tablet-1.png',
      'listing ko-KR',
    ]);
    assert.deepEqual(play.edits, ['insert edit-2', 'commit edit-2'], 'one edit, committed once');
    assert.equal(play.state.listings.get('ko-KR')?.title, '블록 파티');
    assert.equal(play.state.listings.get('en-US')?.fullDescription, longDescription);

    // A re-run is a no-op: the plan is now empty and the old plan applies as unchanged.
    const again = await planPlayPresence(input(fixture), play.port);
    assert.equal(again.changed, false);
    assert.match(formatPlayPresencePlan(again), /no changes/u);
    play.writes.length = 0;
    play.edits.length = 0;
    const rerun = await applyPlayPresence({
      saved: plan,
      plan: input(fixture),
      port: play.port,
      approved: true,
    });
    assert.equal(rerun.status, 'unchanged');
    assert.deepEqual(play.writes, []);
    assert.deepEqual(play.edits, ['insert edit-4', 'delete edit-4']);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

/** Play already holding the English listing and some images. */
function seededPlay(fixture: Fixture, phone: readonly string[], extra: PlayImage[] = []): FakePlay {
  const images = new Map<string, PlayImage[]>();
  images.set('en-US/phoneScreenshots', [
    ...phone.map((name, index) => ({ id: `old-${index}`, sha256: sha256(fixture.images[name] as Buffer) })),
    ...extra,
  ]);
  images.set('en-US/icon', [
    { id: 'old-icon', sha256: sha256(fixture.images['store/icon.png'] as Buffer) },
  ]);
  return fakePlay({
    listings: new Map([
      [
        'en-US',
        {
          language: 'en-US',
          title: 'Block Party',
          shortDescription: 'Stack blocks with friends.',
          fullDescription: longDescription,
          video: 'https://youtu.be/old',
        },
      ],
      [
        'ja-JP',
        { language: 'ja-JP', title: 'ブロック', shortDescription: 's', fullDescription: 'f' },
      ],
    ]),
    images,
    details: { defaultLanguage: 'ja-JP' },
  });
}

const onlyEnglish = (graphics: Record<string, unknown>, contact?: Record<string, string>): StorePresence =>
  assertStorePresence({
    version: '1',
    googlePlay: {
      listings: {
        'en-US': {
          title: 'Block Party',
          shortDescription: 'Stack blocks with friends.',
          fullDescription: longDescription,
          graphics,
        },
      },
      ...(contact === undefined ? {} : { contact }),
    },
  });

// A plain list adds only what Play lacks and keeps the rest; the video and other languages stay.
{
  const fixture = makeFixture();
  try {
    const play = seededPlay(
      fixture,
      ['store/phone-1.png'],
      [{ id: 'extra', sha256: 'e'.repeat(64) }],
    );
    const file = onlyEnglish({ phoneScreenshots: ['store/phone-1.png', 'store/phone-2.png'] });
    const plan = await planPlayPresence(input(fixture, file), play.port);
    const [english] = plan.languages;
    assert.equal(english?.action, 'unchanged', 'the text matches; the video Play has is kept');
    const [slot] = english?.images ?? [];
    assert.equal(slot?.action, 'add');
    assert.deepEqual(
      slot?.upload.map((image) => image.path),
      ['store/phone-2.png'],
    );
    assert.match(slot?.notes.join('\n') ?? '', /keeps 1 image/u);
    assert.deepEqual(plan.remoteOnlyLanguages, ['ja-JP']);
    assert.match(plan.notes.join('\n'), /default language ja-JP is not in the file/u);
    await applyPlayPresence({
      saved: plan,
      plan: input(fixture, file),
      port: play.port,
      approved: true,
    });
    assert.deepEqual(play.writes, ['upload en-US/phoneScreenshots phone-2.png']);
    assert.equal(play.state.images.get('en-US/phoneScreenshots')?.length, 3);

    // Nine images in a plain list are over Play's limit of eight.
    const crowded = seededPlay(
      fixture,
      [],
      Array.from({ length: 7 }, (_, index) => ({
        id: `x${index}`,
        sha256: String(index).repeat(64),
      })),
    );
    await assert.rejects(
      planPlayPresence(
        input(
          fixture,
          onlyEnglish({ phoneScreenshots: ['store/phone-1.png', 'store/phone-2.png'] }),
        ),
        crowded.port,
      ),
      /at most 8\. Mark the set complete/u,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

// A complete set removes what the file drops, only with --confirm-image-removal.
{
  const fixture = makeFixture();
  try {
    const play = seededPlay(fixture, ['store/phone-1.png', 'store/phone-2.png']);
    const file = onlyEnglish({
      icon: 'store/icon.png',
      phoneScreenshots: { files: ['store/phone-3.png', 'store/phone-1.png'], complete: true },
    });
    const plan = await planPlayPresence(input(fixture, file), play.port);
    const slots = plan.languages[0]?.images ?? [];
    assert.equal(slots[0]?.action, 'unchanged', 'the icon matches');
    assert.equal(slots[1]?.action, 'replace');
    assert.deepEqual(
      slots[1]?.remove.map((image) => image.id),
      ['old-1'],
    );
    assert.equal(plan.imageRemovals, 1);
    assert.match(formatPlayPresencePlan(plan), /IMAGE REMOVAL: 1 image/u);
    play.edits.length = 0;
    await assert.rejects(
      applyPlayPresence({
        saved: plan,
        plan: input(fixture, file),
        port: play.port,
        approved: true,
      }),
      /--confirm-image-removal/u,
    );
    assert.deepEqual(play.writes, []);
    assert.deepEqual(
      play.edits,
      ['insert edit-2', 'delete edit-2'],
      'the refused edit is discarded',
    );
    await applyPlayPresence({
      saved: plan,
      plan: input(fixture, file),
      port: play.port,
      approved: true,
      confirmImageRemoval: true,
      changesNotSentForReview: true,
    });
    assert.deepEqual(play.writes, [
      'deleteall en-US/phoneScreenshots',
      'upload en-US/phoneScreenshots phone-3.png',
      'upload en-US/phoneScreenshots phone-1.png',
    ]);
    assert.ok(play.edits.includes('commit edit-3 not-sent'));
    assert.deepEqual(
      play.state.images.get('en-US/phoneScreenshots')?.map((image) => image.sha256),
      [
        sha256(fixture.images['store/phone-3.png'] as Buffer),
        sha256(fixture.images['store/phone-1.png'] as Buffer),
      ],
    );

    // Reordering a complete set re-uploads it but removes nothing: no confirmation needed.
    const reorder = seededPlay(fixture, ['store/phone-1.png', 'store/phone-2.png']);
    const swapped = onlyEnglish({
      phoneScreenshots: { files: ['store/phone-2.png', 'store/phone-1.png'], complete: true },
    });
    const reorderPlan = await planPlayPresence(input(fixture, swapped), reorder.port);
    assert.equal(reorderPlan.imageRemovals, 0);
    assert.equal(reorderPlan.languages[0]?.images[0]?.action, 'replace');
    await applyPlayPresence({
      saved: reorderPlan,
      plan: input(fixture, swapped),
      port: reorder.port,
      approved: true,
    });
    // A complete set Play already starts with only appends.
    const prefix = seededPlay(fixture, ['store/phone-1.png']);
    const longer = onlyEnglish({
      phoneScreenshots: { files: ['store/phone-1.png', 'store/phone-2.png'], complete: true },
    });
    const prefixPlan = await planPlayPresence(input(fixture, longer), prefix.port);
    assert.equal(prefixPlan.languages[0]?.images[0]?.action, 'add');
    // A new icon replaces Play's without a removal confirmation.
    fixture.write('store/icon.png', png(512, 512, 99, 6));
    const icon = await planPlayPresence(
      input(fixture, onlyEnglish({ icon: 'store/icon.png' })),
      seededPlay(fixture, []).port,
    );
    assert.equal(icon.languages[0]?.images[0]?.action, 'replace');
    assert.equal(icon.imageRemovals, 0);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

// Stale plans, failures, contact details and re-encoded images.
{
  const fixture = makeFixture();
  try {
    const file = onlyEnglish(
      { phoneScreenshots: ['store/phone-1.png', 'store/phone-2.png'] },
      { email: 'help@example.com', website: 'https://example.com' },
    );
    const play = seededPlay(fixture, []);
    const plan = await planPlayPresence(input(fixture, file), play.port);
    assert.deepEqual(
      plan.details?.changes.map((change) => change.field),
      ['contactEmail', 'contactWebsite'],
    );
    assert.deepEqual(plan.details?.write, {
      defaultLanguage: 'ja-JP',
      contactEmail: 'help@example.com',
      contactWebsite: 'https://example.com',
    });

    // Someone edits the listing in Play Console: apply refuses and discards its edit.
    play.state.listings.set('en-US', { ...play.state.listings.get('en-US'), title: 'Renamed' });
    play.edits.length = 0;
    await assert.rejects(
      applyPlayPresence({
        saved: plan,
        plan: input(fixture, file),
        port: play.port,
        approved: true,
      }),
      StorePlanStaleError,
    );
    assert.deepEqual(play.edits, ['insert edit-2', 'delete edit-2']);
    assert.deepEqual(play.writes, []);

    // A graphic changed after the plan: stale too.
    const fresh = seededPlay(fixture, []);
    const freshPlan = await planPlayPresence(input(fixture, file), fresh.port);
    fixture.write('store/phone-2.png', png(1080, 1920, 77));
    await assert.rejects(
      applyPlayPresence({
        saved: freshPlan,
        plan: input(fixture, file),
        port: fresh.port,
        approved: true,
      }),
      /changed since the plan/u,
    );
    fixture.write('store/phone-2.png', fixture.images['store/phone-2.png'] as Buffer);

    // A write fails: the edit is discarded and Play is as it was.
    const failing = seededPlay(fixture, []);
    const failingPlan = await planPlayPresence(input(fixture, file), failing.port);
    const before = clone(failing.state);
    failing.failOn = 'upload phone-2.png';
    failing.edits.length = 0;
    await assert.rejects(
      applyPlayPresence({ saved: failingPlan, plan: input(fixture, file), port: failing.port, approved: true }),
      (error: unknown) => error instanceof PlayPresenceApplyError && error.outcome === 'discarded'
        && /upload of store\/phone-2\.png/u.test(error.message) && /nothing was published/u.test(error.message),
    );
    assert.deepEqual(failing.edits, ['insert edit-2', 'delete edit-2']);
    assert.deepEqual(failing.state, before);
    // The commit fails: the outcome is unknown, and a fresh plan shows what is left.
    failing.failOn = 'commit';
    await assert.rejects(
      applyPlayPresence({
        saved: failingPlan,
        plan: input(fixture, file),
        port: failing.port,
        approved: true,
      }),
      (error: unknown) => error instanceof PlayPresenceApplyError && error.outcome === 'unknown',
    );
    const committed = await applyPlayPresence({
      saved: failingPlan,
      plan: input(fixture, file),
      port: failing.port,
      approved: true,
    });
    assert.equal(committed.status, 'committed');
    assert.equal(failing.state.details.contactEmail, 'help@example.com');

    // Play answers with another digest: apply warns, the next plan shows the images again.
    const reencoding = seededPlay(fixture, []);
    reencoding.reencode = true;
    const reencodePlan = await planPlayPresence(input(fixture, file), reencoding.port);
    const warned = await applyPlayPresence({
      saved: reencodePlan,
      plan: input(fixture, file),
      port: reencoding.port,
      approved: true,
    });
    assert.equal(warned.warnings.length, 2);
    assert.match(warned.warnings[0] ?? '', /next plan will show it as changed/u);

    // Images are checked before Play is asked anything.
    fixture.write('store/phone-1.png', png(1080, 2400, 3));
    const untouched = seededPlay(fixture, []);
    await assert.rejects(
      planPlayPresence(input(fixture, file), untouched.port),
      /twice the short side/u,
    );
    assert.deepEqual(untouched.edits, []);
    fixture.write('store/phone-1.png', png(512, 512, 3).subarray(0, 20));
    await assert.rejects(
      planPlayPresence(input(fixture, file), untouched.port),
      /PNG has no IHDR|not a PNG/u,
    );
    writeFileSync(path.join(fixture.directory, 'store/phone-1.png'), Buffer.from('GIF89a'));
    await assert.rejects(
      planPlayPresence(input(fixture, file), untouched.port),
      /not a PNG or JPEG/u,
    );
    fixture.write('store/phone-1.png', fixture.images['store/phone-1.png'] as Buffer);
    fixture.write('store/phone-dup.png', fixture.images['store/phone-1.png'] as Buffer);
    await assert.rejects(
      planPlayPresence(
        input(
          fixture,
          onlyEnglish({ phoneScreenshots: ['store/phone-1.png', 'store/phone-dup.png'] }),
        ),
        untouched.port,
      ),
      /same image twice/u,
    );
    await assert.rejects(
      planPlayPresence(
        input(fixture, onlyEnglish({ phoneScreenshots: ['store/missing.png'] })),
        untouched.port,
      ),
      /missing\.png is missing/u,
    );
    await assert.rejects(
      planPlayPresence(
        {
          ...input(fixture),
          presence: assertStorePresence({
            version: '1',
            appStore: {
              localizations: {
                'en-US': {
                  name: 'Block',
                  description: 'd',
                  keywords: 'k',
                  supportUrl: 'https://example.com',
                },
              },
            },
          }),
        },
        untouched.port,
      ),
      /no googlePlay section/u,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

// The command: deployment profile, credential, saved plan, --game.
{
  const fixture = makeFixture();
  try {
    const game = fixture.directory;
    mkdirSync(path.join(game, 'apps/mobile'), { recursive: true });
    writeFileSync(path.join(game, 'apps/mobile/package.json'), '{"name":"mobile"}\n');
    writeFileSync(path.join(game, 'mpgd.targets.json'), `${JSON.stringify({
      targets: {
        android: {
          kind: 'capacitor-android',
          adapter: 'capacitor',
          artifact: 'aab',
          gameApp: '.',
          shellApp: 'apps/mobile',
          webDir: 'apps/mobile/www',
          metadata: { packageId: packageName },
        },
      },
    }, null, 2)}\n`);
    initializeDeployConfig(game);
    const presenceJson = JSON.parse(JSON.stringify(presence())) as StorePresence;
    writeFileSync(
      path.join(game, 'mpgd.store-presence.json'),
      `${JSON.stringify(presenceJson, null, 2)}\n`,
    );
    const serviceAccount = path.join(fixture.root, 'service-account.json');
    writeFileSync(serviceAccount, '{}\n');
    const environment = { MPGD_GOOGLE_PLAY_SERVICE_ACCOUNT: serviceAccount };
    const play = fakePlay({
      listings: new Map([['en-US', { language: 'en-US', title: 'Block' }]]),
    });
    const opened: string[] = [];
    const factory = async (file: string): Promise<PlayStoreListingPort> => {
      opened.push(file);
      return play.port;
    };

    await assert.rejects(
      planStorePresence(
        { game, profile: 'beta', store: 'google-play' },
        {},
        { googlePlay: factory },
      ),
      /MPGD_GOOGLE_PLAY_SERVICE_ACCOUNT/u,
    );
    await assert.rejects(
      planStorePresence({ game, profile: 'beta', store: 'app-store' }, environment, {
        googlePlay: factory,
      }),
      /google-play/u,
    );
    const planned = await planStorePresence(
      { game, profile: 'beta', store: 'google-play' },
      environment,
      { googlePlay: factory },
    );
    assert.deepEqual(opened, [serviceAccount]);
    assert.equal(planned.presenceFile, path.join(game, 'mpgd.store-presence.json'));
    const planFile = path.join(fixture.root, 'presence-plan.json');
    saveStorePresencePlan(planFile, planned);
    assert.throws(() => saveStorePresencePlan(planFile, planned), /EEXIST/u);
    const savedPlan = JSON.parse(readFileSync(planFile, 'utf8')) as { plan: PlayPresencePlan };
    assert.ok(
      savedPlan.plan.languages.every((language) =>
        language.images.every((slot) => slot.upload.every((image) => !path.isAbsolute(image.path))),
      ),
      'the plan names graphics relative to the presence file',
    );

    await assert.rejects(
      applyStorePresence({ planFile, approved: false }, environment, { googlePlay: factory }),
      /--approve/u,
    );
    const malformed = path.join(fixture.root, 'malformed.json');
    writeFileSync(malformed, '{"schemaVersion":1,"kind":"mpgd-store-products-plan"}\n');
    await assert.rejects(
      applyStorePresence({ planFile: malformed, approved: true }, environment, {
        googlePlay: factory,
      }),
      /Saved store presence plan is malformed/u,
    );

    // The game moved to another checkout: --game re-reads the files there.
    const moved = path.join(fixture.root, 'moved');
    cpSync(game, moved, { recursive: true });
    writeFileSync(path.join(game, 'mpgd.store-presence.json'), '{"version":"gone"}\n');
    const applied = await applyStorePresence(
      { planFile, game: moved, approved: true },
      environment,
      { googlePlay: factory },
    );
    assert.equal(applied.status, 'committed');
    assert.equal(play.state.listings.get('ko-KR')?.title, '블록 파티');
    // Relative --presence paths resolve against the current directory.
    const relative = path.relative(process.cwd(), path.join(moved, 'mpgd.store-presence.json'));
    const replanned = await planStorePresence(
      { game: moved, profile: 'beta', store: 'google-play', presenceFile: relative },
      environment,
      { googlePlay: factory },
    );
    assert.equal(replanned.plan.changed, false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

console.info('Google Play store presence sync tests passed.');
