import typia, { type tags } from 'typia';

import { isRelativeChildPath, storeListingLocalePattern } from './store-listings.js';

/**
 * The app's store presence: the store page text and graphics of Google Play
 * (Play Console "Store presence") and the App Store (app information and
 * version metadata), per language. It is a separate file from the product
 * store listing file (`mpgd.store-listings.json`), which describes one-time
 * products; this one describes the app itself. Like that file it never ships
 * to players: only `mpgd store presence plan|apply` reads it.
 *
 * Graphics are paths relative to the file. Their pixel sizes, formats and
 * counts are checked against the store rules below by
 * {@link assertStorePresenceImage}, from the bytes the caller read.
 */

/** A set of screenshots. A plain list adds what the store lacks; `complete` makes the store match it. */
export type StorePresenceImageSet =
  | readonly (string & tags.MinLength<1>)[]
  | {
      readonly files: readonly (string & tags.MinLength<1>)[];
      /**
       * The list is the whole set: images the store holds that it does not
       * name are removed, and the order is made to match. Without it the
       * sync only adds the images the store lacks.
       */
      readonly complete?: boolean;
    };

export interface GooglePlayPresenceGraphics {
  /** 512 x 512 PNG, at most 1 MB. */
  readonly icon?: string & tags.MinLength<1>;
  /** 1024 x 500 JPEG or PNG without alpha. */
  readonly featureGraphic?: string & tags.MinLength<1>;
  readonly phoneScreenshots?: StorePresenceImageSet;
  readonly sevenInchScreenshots?: StorePresenceImageSet;
  readonly tenInchScreenshots?: StorePresenceImageSet;
}

/** One Play store listing language (`edits.listings`). */
export interface GooglePlayPresenceListing {
  /** App name, at most 30 characters. */
  readonly title: string & tags.MinLength<1>;
  /** At most 80 characters. */
  readonly shortDescription: string & tags.MinLength<1>;
  /** At most 4,000 characters. */
  readonly fullDescription: string & tags.MinLength<1>;
  /** YouTube URL of the promo video. When absent, Play keeps the one it has. */
  readonly video?: string & tags.MinLength<1>;
  readonly graphics?: GooglePlayPresenceGraphics;
}

/** Play contact details (`edits.details`); fields left out stay as Play has them. */
export interface GooglePlayPresenceContact {
  readonly email?: string & tags.MinLength<3>;
  readonly website?: string & tags.MinLength<1>;
  readonly phone?: string & tags.MinLength<1>;
}

export interface GooglePlayPresence {
  /** Keyed by BCP-47 language tag as Play writes it, for example `en-US` or `ko-KR`. */
  readonly listings: Readonly<Record<string, GooglePlayPresenceListing>>;
  readonly contact?: GooglePlayPresenceContact;
}

/** App Store screenshot sets by display size. */
export interface AppStorePresenceScreenshots {
  /** iPhone 6.9" display (App Store Connect `APP_IPHONE_67`). */
  readonly iphone69?: StorePresenceImageSet;
  /** iPhone 6.5" display (`APP_IPHONE_65`). */
  readonly iphone65?: StorePresenceImageSet;
  /** iPhone 6.3" display (`APP_IPHONE_61`). */
  readonly iphone63?: StorePresenceImageSet;
  /** iPad 13" display (`APP_IPAD_PRO_3GEN_129`). */
  readonly ipad13?: StorePresenceImageSet;
}

/** One App Store locale: app information and version localization fields. */
export interface AppStorePresenceLocalization {
  /** App name, 2 to 30 characters (app information localization). */
  readonly name: string & tags.MinLength<2>;
  /** At most 30 characters (app information localization). */
  readonly subtitle?: string & tags.MinLength<1>;
  /** Overrides the file's `privacyPolicyUrl` for this locale. */
  readonly privacyPolicyUrl?: string & tags.MinLength<1>;
  /** At most 4,000 characters (version localization). */
  readonly description: string & tags.MinLength<1>;
  /** Comma-separated, at most 100 bytes. */
  readonly keywords: string & tags.MinLength<1>;
  /** At most 170 characters. */
  readonly promotionalText?: string & tags.MinLength<1>;
  /** At most 4,000 characters; App Store Connect takes it from the second version on. */
  readonly whatsNew?: string & tags.MinLength<1>;
  readonly supportUrl: string & tags.MinLength<1>;
  readonly marketingUrl?: string & tags.MinLength<1>;
  readonly screenshots?: AppStorePresenceScreenshots;
}

export interface AppStorePresence {
  /** Keyed by App Store Connect locale, for example `en-US`, `ko` or `zh-Hans`. */
  readonly localizations: Readonly<Record<string, AppStorePresenceLocalization>>;
}

export interface StorePresence {
  readonly version: string & tags.MinLength<1>;
  /** Privacy policy URL: written to the App Store, printed as a manual step for Play. */
  readonly privacyPolicyUrl?: string & tags.MinLength<1>;
  readonly googlePlay?: GooglePlayPresence;
  readonly appStore?: AppStorePresence;
}

export type GooglePlayPresenceImageSlot = keyof GooglePlayPresenceGraphics;
export type AppStorePresenceDisplay = keyof AppStorePresenceScreenshots;

/** Every image slot the file can fill, as the store names it. */
export type StorePresenceImageSlot =
  | { readonly store: 'google-play'; readonly slot: GooglePlayPresenceImageSlot }
  | { readonly store: 'app-store'; readonly slot: AppStorePresenceDisplay };

export const googlePlayPresenceImageSlots = Object.freeze([
  'icon',
  'featureGraphic',
  'phoneScreenshots',
  'sevenInchScreenshots',
  'tenInchScreenshots',
] as const satisfies readonly GooglePlayPresenceImageSlot[]);

export const appStorePresenceDisplays = Object.freeze([
  'iphone69',
  'iphone65',
  'iphone63',
  'ipad13',
] as const satisfies readonly AppStorePresenceDisplay[]);

/** App Store Connect `screenshotDisplayType` of each display key. */
export const appStorePresenceDisplayTypes: Readonly<Record<AppStorePresenceDisplay, string>> = Object.freeze(
  {
    iphone69: 'APP_IPHONE_67',
    iphone65: 'APP_IPHONE_65',
    iphone63: 'APP_IPHONE_61',
    ipad13: 'APP_IPAD_PRO_3GEN_129',
  },
);

// Google Play: Play Console Help "Create and set up your app" (title 30,
// short description 80, full description 4,000) and "Add preview assets"
// (graphics), https://support.google.com/googleplay/android-developer/answer/9859152
// and .../answer/9866151.
export const googlePlayPresenceLimits = Object.freeze({
  title: 30,
  shortDescription: 80,
  fullDescription: 4000,
  /** Screenshots per device type. */
  screenshots: 8,
  screenshotMinSide: 320,
  screenshotMaxSide: 3840,
  /** Icon file size. */
  iconBytes: 1024 * 1024,
  /** Feature graphic and screenshot file size (Play Console upload form; not stated on the help page). */
  graphicBytes: 15 * 1024 * 1024,
  screenshotBytes: 8 * 1024 * 1024,
});

// App Store: App Store Connect Help, "App information" (name 2-30, subtitle
// 30), "Platform version information" (description 4,000, keywords 100
// bytes, promotional text 170, what's new 4,000) and "Screenshot
// specifications" (1 to 10 per display size, .jpeg/.jpg/.png, no alpha).
export const appStorePresenceLimits = Object.freeze({
  name: 30,
  minName: 2,
  subtitle: 30,
  description: 4000,
  keywordBytes: 100,
  promotionalText: 170,
  whatsNew: 4000,
  screenshots: 10,
});

/** Accepted pixel sizes per App Store display (portrait; landscape is the same pair swapped). */
export const appStorePresenceScreenshotSizes: Readonly<Record<AppStorePresenceDisplay, readonly (readonly [number, number])[]>> = Object.freeze(
  {
    iphone69: [
      [1260, 2736],
      [1290, 2796],
      [1320, 2868],
    ],
    iphone65: [
      [1242, 2688],
      [1284, 2778],
    ],
    iphone63: [
      [1179, 2556],
      [1206, 2622],
    ],
    ipad13: [
      [2048, 2732],
      [2064, 2752],
    ],
  },
);

const assertStorePresenceShape = typia.createAssert<StorePresence>();

/** The image list of a set and whether the set is complete. */
export function resolveStorePresenceImageSet(
  set: StorePresenceImageSet,
): { readonly files: readonly string[]; readonly complete: boolean } {
  if (isFileList(set)) {
    return { files: set, complete: false };
  }
  return { files: set.files, complete: set.complete === true };
}

/** Validate a store presence file: shape, languages, text lengths, URLs, paths and counts. */
export function assertStorePresence(input: unknown): StorePresence {
  const presence = assertStorePresenceShape(input);
  if (presence.googlePlay === undefined && presence.appStore === undefined) {
    throw new Error('Store presence file names neither googlePlay nor appStore.');
  }
  if (presence.privacyPolicyUrl !== undefined) {
    assertHttpsUrl(presence.privacyPolicyUrl, 'privacyPolicyUrl');
  }
  if (presence.googlePlay !== undefined) {
    assertGooglePlay(presence.googlePlay);
  }
  if (presence.appStore !== undefined) {
    assertAppStore(presence.appStore);
  }
  return presence;
}

function assertGooglePlay(play: GooglePlayPresence): void {
  const languages = assertLocaleKeys(play.listings, 'googlePlay.listings');
  for (const language of languages) {
    const listing = play.listings[language] as GooglePlayPresenceListing;
    const field = `googlePlay.listings.${language}`;
    assertText(listing.title, `${field}.title`, googlePlayPresenceLimits.title);
    assertText(
      listing.shortDescription,
      `${field}.shortDescription`,
      googlePlayPresenceLimits.shortDescription,
    );
    assertText(
      listing.fullDescription,
      `${field}.fullDescription`,
      googlePlayPresenceLimits.fullDescription,
      true,
    );
    if (listing.video !== undefined) {
      assertYouTubeUrl(listing.video, `${field}.video`);
    }
    const graphics = listing.graphics ?? {};
    for (const slot of googlePlayPresenceImageSlots) {
      const value = graphics[slot];
      if (value === undefined) {
        continue;
      }
      if (slot === 'icon' || slot === 'featureGraphic') {
        assertImagePath(value as string, `${field}.graphics.${slot}`);
        continue;
      }
      assertImageSet(
        value as StorePresenceImageSet,
        `${field}.graphics.${slot}`,
        googlePlayPresenceLimits.screenshots,
      );
    }
  }
  const contact = play.contact;
  if (contact?.website !== undefined) {
    assertHttpsUrl(contact.website, 'googlePlay.contact.website');
  }
  if (contact?.email !== undefined && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(contact.email)) {
    throw new Error('Store presence googlePlay.contact.email is not an email address.');
  }
  if (contact?.phone !== undefined && !/^\+?[0-9 ()-]{3,}$/u.test(contact.phone)) {
    throw new Error('Store presence googlePlay.contact.phone is not a telephone number.');
  }
}

function assertAppStore(appStore: AppStorePresence): void {
  const locales = assertLocaleKeys(appStore.localizations, 'appStore.localizations');
  for (const locale of locales) {
    const entry = appStore.localizations[locale] as AppStorePresenceLocalization;
    const field = `appStore.localizations.${locale}`;
    assertText(entry.name, `${field}.name`, appStorePresenceLimits.name);
    if ([...entry.name].length < appStorePresenceLimits.minName) {
      throw new Error(
        `Store presence ${field}.name must be at least ${appStorePresenceLimits.minName} characters.`,
      );
    }
    if (entry.subtitle !== undefined) {
      assertText(entry.subtitle, `${field}.subtitle`, appStorePresenceLimits.subtitle);
    }
    assertText(entry.description, `${field}.description`, appStorePresenceLimits.description, true);
    assertText(entry.keywords, `${field}.keywords`, Number.POSITIVE_INFINITY);
    if (utf8ByteLength(entry.keywords) > appStorePresenceLimits.keywordBytes) {
      throw new Error(
        `Store presence ${field}.keywords is longer than ${appStorePresenceLimits.keywordBytes} bytes (UTF-8).`,
      );
    }
    if (entry.promotionalText !== undefined) {
      assertText(
        entry.promotionalText,
        `${field}.promotionalText`,
        appStorePresenceLimits.promotionalText,
        true,
      );
    }
    if (entry.whatsNew !== undefined) {
      assertText(entry.whatsNew, `${field}.whatsNew`, appStorePresenceLimits.whatsNew, true);
    }
    assertHttpsUrl(entry.supportUrl, `${field}.supportUrl`);
    if (entry.marketingUrl !== undefined) {
      assertHttpsUrl(entry.marketingUrl, `${field}.marketingUrl`);
    }
    if (entry.privacyPolicyUrl !== undefined) {
      assertHttpsUrl(entry.privacyPolicyUrl, `${field}.privacyPolicyUrl`);
    }
    for (const display of appStorePresenceDisplays) {
      const set = entry.screenshots?.[display];
      if (set !== undefined) {
        assertImageSet(set, `${field}.screenshots.${display}`, appStorePresenceLimits.screenshots);
      }
    }
  }
}

function assertLocaleKeys(map: Readonly<Record<string, unknown>>, field: string): string[] {
  const locales = Object.keys(map);
  if (locales.length === 0) {
    throw new Error(`Store presence ${field} needs at least one language.`);
  }
  const seen = new Set<string>();
  for (const locale of locales) {
    if (!storeListingLocalePattern.test(locale)) {
      throw new Error(`Store presence ${field} key ${locale} is not a BCP-47 language tag.`);
    }
    const folded = locale.toLowerCase();
    if (seen.has(folded)) {
      throw new Error(`Store presence ${field} lists ${locale} twice.`);
    }
    seen.add(folded);
  }
  return locales;
}

function assertText(value: string, field: string, limit: number, multiline = false): void {
  if (value.trim() !== value || value === '') {
    throw new Error(`Store presence ${field} must be trimmed and non-empty.`);
  }
  if (!multiline && /[\r\n]/u.test(value)) {
    throw new Error(`Store presence ${field} must be one line.`);
  }
  if ([...value].length > limit) {
    throw new Error(`Store presence ${field} is longer than ${limit} characters.`);
  }
}

function assertHttpsUrl(value: string, field: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Store presence ${field} is not a URL.`);
  }
  if (url.protocol !== 'https:' || /\s/u.test(value)) {
    throw new Error(`Store presence ${field} must be an https URL.`);
  }
}

function assertYouTubeUrl(value: string, field: string): void {
  assertHttpsUrl(value, field);
  const host = new URL(value).hostname.toLowerCase();
  if (!['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'].includes(host)) {
    throw new Error(`Store presence ${field} must be a YouTube video URL.`);
  }
}

function assertImagePath(value: string, field: string): void {
  if (!isRelativeChildPath(value)) {
    throw new Error(`Store presence ${field} must be a relative path inside the game.`);
  }
  if (!/\.(?:png|jpe?g)$/iu.test(value)) {
    throw new Error(`Store presence ${field} must be a .png, .jpg or .jpeg file.`);
  }
}

function assertImageSet(set: StorePresenceImageSet, field: string, maxCount: number): void {
  const { files } = resolveStorePresenceImageSet(set);
  if (files.length === 0) {
    throw new Error(`Store presence ${field} lists no images.`);
  }
  if (files.length > maxCount) {
    throw new Error(
      `Store presence ${field} lists ${files.length} images; the store takes at most ${maxCount}.`,
    );
  }
  const seen = new Set<string>();
  for (const [index, file] of files.entries()) {
    assertImagePath(file, `${field}[${index}]`);
    if (seen.has(file)) {
      throw new Error(`Store presence ${field} lists ${file} twice.`);
    }
    seen.add(file);
  }
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

function isFileList(set: StorePresenceImageSet): set is readonly string[] {
  return Array.isArray(set);
}

/** What the header of a PNG or JPEG file says. */
export interface StoreImageInfo {
  readonly format: 'png' | 'jpeg';
  readonly width: number;
  readonly height: number;
  /** PNG with an alpha channel or a transparency chunk. JPEG never has one. */
  readonly hasAlpha: boolean;
}

/**
 * Read the format, pixel size and alpha of a PNG or JPEG from its bytes,
 * without decoding the image. Throws on anything else.
 */
export function readStoreImageInfo(bytes: Uint8Array): StoreImageInfo {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.byteLength >= 8 && pngSignature.every((value, index) => bytes[index] === value)) {
    return readPng(bytes, view);
  }
  if (bytes.byteLength >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return readJpeg(bytes, view);
  }
  throw new Error('not a PNG or JPEG file');
}

function readPng(bytes: Uint8Array, view: DataView): StoreImageInfo {
  const chunkType = (offset: number): string =>
    String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
  if (bytes.byteLength < 33 || chunkType(8) !== 'IHDR') {
    throw new Error('PNG has no IHDR chunk');
  }
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  const colorType = bytes[25] as number;
  // Color types 4 (grey + alpha) and 6 (RGBA) carry alpha; a tRNS chunk adds it to the others.
  let hasAlpha = colorType === 4 || colorType === 6;
  let offset = 8;
  while (!hasAlpha && offset + 8 <= bytes.byteLength) {
    const length = view.getUint32(offset);
    const type = chunkType(offset);
    if (type === 'tRNS') {
      hasAlpha = true;
    }
    if (type === 'IDAT' || type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  if (width === 0 || height === 0) {
    throw new Error('PNG has no pixel size');
  }
  return { format: 'png', width, height, hasAlpha };
}

function readJpeg(bytes: Uint8Array, view: DataView): StoreImageInfo {
  let offset = 2;
  while (offset + 4 <= bytes.byteLength) {
    if (bytes[offset] !== 0xff) {
      throw new Error('JPEG marker expected');
    }
    const marker = bytes[offset + 1] as number;
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    // Markers without a length: TEM and RST0-RST7.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) {
      break;
    }
    const length = view.getUint16(offset + 2);
    // SOF0-SOF15 except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (offset + 9 > bytes.byteLength) {
        break;
      }
      const height = view.getUint16(offset + 5);
      const width = view.getUint16(offset + 7);
      if (width === 0 || height === 0) {
        throw new Error('JPEG has no pixel size');
      }
      return { format: 'jpeg', width, height, hasAlpha: false };
    }
    offset += 2 + length;
  }
  throw new Error('JPEG has no frame header');
}

/**
 * Check one image against the store's rules for its slot. `byteLength` is
 * the file size. Returns nothing; throws with the rule the image breaks.
 */
export function assertStorePresenceImage(
  target: StorePresenceImageSlot,
  info: StoreImageInfo,
  byteLength: number,
  label: string,
): void {
  const size = `${info.width} x ${info.height}`;
  if (target.store === 'google-play') {
    const limits = googlePlayPresenceLimits;
    if (target.slot === 'icon') {
      if (info.format !== 'png' || info.width !== 512 || info.height !== 512) {
        throw new Error(
          `${label}: the Play icon must be a 512 x 512 PNG, not a ${size} ${info.format}.`,
        );
      }
      if (byteLength > limits.iconBytes) {
        throw new Error(`${label}: the Play icon must be at most 1 MB.`);
      }
      return;
    }
    if (info.hasAlpha) {
      throw new Error(`${label}: Play takes this graphic as JPEG or 24-bit PNG without alpha.`);
    }
    if (target.slot === 'featureGraphic') {
      if (info.width !== 1024 || info.height !== 500) {
        throw new Error(`${label}: the Play feature graphic must be 1024 x 500, not ${size}.`);
      }
      if (byteLength > limits.graphicBytes) {
        throw new Error(`${label}: the Play feature graphic must be at most 15 MB.`);
      }
      return;
    }
    const short = Math.min(info.width, info.height);
    const long = Math.max(info.width, info.height);
    if (short < limits.screenshotMinSide || long > limits.screenshotMaxSide || long > 2 * short) {
      throw new Error(
        `${label}: Play screenshots must be ${limits.screenshotMinSide} to ${limits.screenshotMaxSide} px per side `
        + `with the long side at most twice the short side, not ${size}.`,
      );
    }
    if (byteLength > limits.screenshotBytes) {
      throw new Error(`${label}: Play screenshots must be at most 8 MB.`);
    }
    return;
  }
  if (info.hasAlpha) {
    throw new Error(
      `${label}: App Store screenshots can't include alpha channels or transparency.`,
    );
  }
  const accepted = appStorePresenceScreenshotSizes[target.slot];
  const fits = accepted.some(([width, height]) =>
    (info.width === width && info.height === height) || (info.width === height && info.height === width),
  );
  if (!fits) {
    throw new Error(
      `${label}: ${size} is not an App Store ${target.slot} screenshot size (${
        accepted.map(([width, height]) => `${width} x ${height}`).join(', ')}, portrait or landscape).`,
    );
  }
}
