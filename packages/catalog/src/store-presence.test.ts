import {
  appStorePresenceDisplayTypes,
  assertStorePresence,
  assertStorePresenceImage,
  readStoreImageInfo,
  resolveStorePresenceImageSet,
  type StorePresence,
} from './index';

/** The package has no Node types; a small assert of its own, like the other catalog tests. */
const assert = {
  equal(actual: unknown, expected: unknown, message = 'unexpected value'): void {
    if (actual !== expected) {
      throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}`);
    }
  },
  deepEqual(actual: unknown, expected: unknown): void {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
    }
  },
  throws(action: () => unknown, pattern: RegExp): void {
    try {
      action();
    } catch (error) {
      if (!pattern.test(error instanceof Error ? error.message : String(error))) {
        throw new Error(`Expected ${String(pattern)}, received ${String(error)}`);
      }
      return;
    }
    throw new Error(`Expected a rejection matching ${String(pattern)}.`);
  },
};

/** PNG header bytes: signature, IHDR, an optional tRNS chunk, IDAT and IEND (CRCs zero). */
function png(width: number, height: number, colorType = 2, transparency = false): Uint8Array {
  const chunk = (type: string, data: number[]): number[] => {
    const length = data.length;
    return [
      (length >>> 24) & 0xff,
      (length >>> 16) & 0xff,
      (length >>> 8) & 0xff,
      length & 0xff,
      ...[...type].map((character) => character.charCodeAt(0)),
      ...data,
      0,
      0,
      0,
      0,
    ];
  };
  const be32 = (value: number): number[] => [
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ];
  return Uint8Array.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...chunk('IHDR', [...be32(width), ...be32(height), 8, colorType, 0, 0, 0]),
    ...(transparency ? chunk('tRNS', [0, 0]) : []),
    ...chunk('IDAT', [1, 2, 3]),
    ...chunk('IEND', []),
  ]);
}

/** JPEG header bytes: SOI, an APP0 segment, then a baseline frame header. */
function jpeg(width: number, height: number): Uint8Array {
  return Uint8Array.from([
    0xff,
    0xd8,
    0xff,
    0xe0,
    0x00,
    0x06,
    0x4a,
    0x46,
    0x49,
    0x46,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    height >> 8,
    height & 0xff,
    width >> 8,
    width & 0xff,
    3,
    1,
    0x22,
    0,
    2,
    0x11,
    1,
    3,
    0x11,
    1,
    0xff,
    0xd9,
  ]);
}

// Image headers.
assert.deepEqual(readStoreImageInfo(png(512, 512, 6)), {
  format: 'png',
  width: 512,
  height: 512,
  hasAlpha: true,
});
assert.deepEqual(readStoreImageInfo(png(1024, 500)), {
  format: 'png',
  width: 1024,
  height: 500,
  hasAlpha: false,
});
assert.equal(
  readStoreImageInfo(png(1024, 500, 3, true)).hasAlpha,
  true,
  'a tRNS chunk is transparency',
);
assert.deepEqual(readStoreImageInfo(jpeg(1080, 1920)), {
  format: 'jpeg',
  width: 1080,
  height: 1920,
  hasAlpha: false,
});
assert.throws(
  () => readStoreImageInfo(Uint8Array.from([0x47, 0x49, 0x46, 0x38])),
  /not a PNG or JPEG/u,
);
assert.throws(
  () => readStoreImageInfo(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9])),
  /no frame header/u,
);

// Play image rules.
const play = (slot: 'icon' | 'featureGraphic' | 'phoneScreenshots') => ({
  store: 'google-play' as const,
  slot,
});
assertStorePresenceImage(play('icon'), readStoreImageInfo(png(512, 512, 6)), 1000, 'icon');
assert.throws(
  () => assertStorePresenceImage(play('icon'), readStoreImageInfo(jpeg(512, 512)), 1000, 'icon'),
  /512 x 512 PNG/u,
);
assert.throws(
  () =>
    assertStorePresenceImage(
      play('icon'),
      readStoreImageInfo(png(512, 512)),
      2 * 1024 * 1024,
      'icon',
    ),
  /1 MB/u,
);
assertStorePresenceImage(
  play('featureGraphic'),
  readStoreImageInfo(jpeg(1024, 500)),
  1000,
  'feature',
);
assert.throws(
  () =>
    assertStorePresenceImage(
      play('featureGraphic'),
      readStoreImageInfo(png(1024, 500, 6)),
      1000,
      'feature',
    ),
  /without alpha/u,
);
assert.throws(
  () =>
    assertStorePresenceImage(
      play('featureGraphic'),
      readStoreImageInfo(png(1000, 500)),
      1000,
      'feature',
    ),
  /1024 x 500/u,
);
assertStorePresenceImage(
  play('phoneScreenshots'),
  readStoreImageInfo(png(1080, 1920)),
  1000,
  'shot',
);
assert.throws(
  () =>
    assertStorePresenceImage(
      play('phoneScreenshots'),
      readStoreImageInfo(png(1080, 2400)),
      1000,
      'shot',
    ),
  /twice the short side/u,
);
assert.throws(
  () =>
    assertStorePresenceImage(
      play('phoneScreenshots'),
      readStoreImageInfo(png(300, 500)),
      1000,
      'shot',
    ),
  /320 to 3840/u,
);

// App Store screenshot sizes, portrait and landscape.
const display = (slot: 'iphone69' | 'ipad13') => ({ store: 'app-store' as const, slot });
assertStorePresenceImage(display('iphone69'), readStoreImageInfo(png(1320, 2868)), 1000, 'shot');
assertStorePresenceImage(display('iphone69'), readStoreImageInfo(jpeg(2868, 1320)), 1000, 'shot');
assertStorePresenceImage(display('ipad13'), readStoreImageInfo(png(2064, 2752)), 1000, 'shot');
assert.throws(
  () =>
    assertStorePresenceImage(display('ipad13'), readStoreImageInfo(png(1320, 2868)), 1000, 'shot'),
  /not an App Store ipad13 screenshot size/u,
);
assert.throws(
  () =>
    assertStorePresenceImage(
      display('iphone69'),
      readStoreImageInfo(png(1320, 2868, 6)),
      1000,
      'shot',
    ),
  /alpha/u,
);
assert.equal(appStorePresenceDisplayTypes.iphone69, 'APP_IPHONE_67');

// The file.
const valid: StorePresence = {
  version: '2026-10-27',
  privacyPolicyUrl: 'https://example.com/privacy',
  googlePlay: {
    listings: {
      'en-US': {
        title: 'Block Party',
        shortDescription: 'Stack blocks with friends.',
        fullDescription: 'Line one.\nLine two.',
        video: 'https://www.youtube.com/watch?v=abc',
        graphics: {
          icon: 'store/play/icon.png',
          featureGraphic: 'store/play/feature.png',
          phoneScreenshots: ['store/play/en/1.png', 'store/play/en/2.png'],
          tenInchScreenshots: { files: ['store/play/en/tablet.png'], complete: true },
        },
      },
      'ko-KR': {
        title: '블록 파티',
        shortDescription: '친구와 블록을 쌓아요.',
        fullDescription: '설명.',
      },
    },
    contact: { email: 'support@example.com', website: 'https://example.com' },
  },
  appStore: {
    localizations: {
      'en-US': {
        name: 'Block Party',
        subtitle: 'Stack with friends',
        description: 'Line one.\nLine two.',
        keywords: 'blocks,puzzle,party',
        supportUrl: 'https://example.com/support',
        screenshots: { iphone69: ['store/ios/en/1.png'], ipad13: ['store/ios/en/ipad.png'] },
      },
    },
  },
};
assert.deepEqual(assertStorePresence(valid), valid);
assert.deepEqual(resolveStorePresenceImageSet(['a.png']), { files: ['a.png'], complete: false });
assert.deepEqual(resolveStorePresenceImageSet({ files: ['a.png'], complete: true }), {
  files: ['a.png'],
  complete: true,
});

const withPlay = (listing: Record<string, unknown>): unknown => ({
  version: '1',
  googlePlay: { listings: { 'en-US': { ...valid.googlePlay?.listings['en-US'], ...listing } } },
});
assert.throws(() => assertStorePresence({ version: '1' }), /neither googlePlay nor appStore/u);
assert.throws(
  () => assertStorePresence(withPlay({ title: 'x'.repeat(31) })),
  /title is longer than 30/u,
);
assert.throws(
  () => assertStorePresence(withPlay({ shortDescription: 'x'.repeat(81) })),
  /shortDescription is longer than 80/u,
);
assert.throws(
  () => assertStorePresence(withPlay({ fullDescription: 'x'.repeat(4001) })),
  /fullDescription is longer than 4000/u,
);
assert.throws(() => assertStorePresence(withPlay({ title: 'Two\nlines' })), /one line/u);
assert.throws(() => assertStorePresence(withPlay({ title: ' padded' })), /trimmed/u);
assert.throws(
  () => assertStorePresence(withPlay({ video: 'https://vimeo.com/1' })),
  /YouTube video URL/u,
);
assert.throws(
  () => assertStorePresence(withPlay({ graphics: { icon: '../icon.png' } })),
  /relative path inside the game/u,
);
assert.throws(
  () => assertStorePresence(withPlay({ graphics: { icon: 'icon.gif' } })),
  /\.png, \.jpg or \.jpeg/u,
);
assert.throws(
  () =>
    assertStorePresence(
      withPlay({
        graphics: { phoneScreenshots: Array.from({ length: 9 }, (_, index) => `${index}.png`) },
      }),
    ),
  /at most 8/u,
);
assert.throws(
  () => assertStorePresence(withPlay({ graphics: { phoneScreenshots: ['a.png', 'a.png'] } })),
  /twice/u,
);
assert.throws(
  () => assertStorePresence(withPlay({ graphics: { phoneScreenshots: [] } })),
  /lists no images/u,
);
assert.throws(
  () =>
    assertStorePresence({
      version: '1',
      googlePlay: {
        listings: {
          'en-US': valid.googlePlay?.listings['en-US'],
          'EN-us': valid.googlePlay?.listings['en-US'],
        },
      },
    }),
  /not a BCP-47|twice/u,
);
assert.throws(
  () => assertStorePresence({ ...valid, privacyPolicyUrl: 'http://example.com/privacy' }),
  /https URL/u,
);

const withAppStore = (entry: Record<string, unknown>): unknown => ({
  version: '1',
  appStore: { localizations: { 'en-US': { ...valid.appStore?.localizations['en-US'], ...entry } } },
});
assert.throws(() => assertStorePresence(withAppStore({ name: 'B' })), /at least 2|minLength/iu);
assert.throws(
  () => assertStorePresence(withAppStore({ subtitle: 'x'.repeat(31) })),
  /subtitle is longer than 30/u,
);
// 34 three-byte characters are 102 bytes: within 100 characters, over 100 bytes.
assert.throws(() => assertStorePresence(withAppStore({ keywords: '가'.repeat(34) })), /100 bytes/u);
assert.throws(
  () => assertStorePresence(withAppStore({ promotionalText: 'x'.repeat(171) })),
  /promotionalText is longer than 170/u,
);
assert.throws(
  () => assertStorePresence(withAppStore({ supportUrl: 'mailto:a@b.c' })),
  /https URL/u,
);
assert.throws(
  () =>
    assertStorePresence(
      withAppStore({
        screenshots: { iphone69: Array.from({ length: 11 }, (_, index) => `${index}.png`) },
      }),
    ),
  /at most 10/u,
);

console.info('Store presence schema tests passed.');
