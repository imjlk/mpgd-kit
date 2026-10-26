import { notificationsMessagingPlugin } from './notifications-starter.js';

/**
 * Store-facing settings of the game-owned Capacitor shell: the iOS
 * Info.plist keys App Store Connect reads (export compliance, device
 * capabilities). The starter writes them into a newly generated project;
 * a production build only reports what an existing shell still lacks, so
 * game-owned native files are never rewritten behind the game's back.
 */

export interface NativeShellPolicyIssue {
  /** `error` fails a production build; `warning` is printed. */
  readonly level: 'error' | 'warning';
  readonly message: string;
}

/**
 * Adds the iOS keys every kit shell should ship with, keeping any value the
 * game already set:
 * - `ITSAppUsesNonExemptEncryption` = false. The kit itself only uses HTTPS
 *   through the OS and OS crypto, which Apple's export rules exempt, so
 *   App Store Connect does not ask the export-compliance question per build.
 *   A game that adds its own encryption sets the key to true and answers it.
 * - `UIRequiredDeviceCapabilities` lists `arm64` instead of the 32-bit
 *   `armv7` left over from the Capacitor template.
 */
export function applyIosInfoPlistStorePolicy(plist: string): string {
  let next = plist;
  if (lacksExportComplianceKey(next)) {
    next = insertPlistTopLevelEntry(next, 'ITSAppUsesNonExemptEncryption', '<false/>');
  }
  const capabilities = readPlistTopLevelValue(next, 'UIRequiredDeviceCapabilities');
  if (capabilities !== undefined && requires32BitArm(capabilities.xml)) {
    const replaced = /<string>\s*arm64\s*<\/string>/u.test(capabilities.xml)
      ? capabilities.xml.replace(/\s*<string>\s*armv7\s*<\/string>/gu, '')
      : capabilities.xml
        .replace(/<string>\s*armv7\s*<\/string>/u, '<string>arm64</string>')
        .replace(/\s*<string>\s*armv7\s*<\/string>/gu, '');
    next = `${next.slice(0, capabilities.start)}${replaced}${next.slice(capabilities.end)}`;
  }
  return next;
}

/** What a shell's release Info.plist still lacks compared with `applyIosInfoPlistStorePolicy`. */
export function inspectIosInfoPlistStorePolicy(plist: string): readonly NativeShellPolicyIssue[] {
  const issues: NativeShellPolicyIssue[] = [];
  if (lacksExportComplianceKey(plist)) {
    issues.push({
      level: 'warning',
      message: 'iOS Info.plist has no ITSAppUsesNonExemptEncryption: App Store Connect will ask '
        + 'the export-compliance question for every build and TestFlight holds the build until '
        + 'it is answered. Add <key>ITSAppUsesNonExemptEncryption</key><false/> when the game '
        + 'uses only HTTPS/OS encryption (see docs/TESTFLIGHT_INTERNAL_SUBMISSION.md).',
    });
  }
  const capabilities = readPlistTopLevelValue(plist, 'UIRequiredDeviceCapabilities');
  if (capabilities !== undefined && requires32BitArm(capabilities.xml)) {
    issues.push({
      level: 'warning',
      message: 'iOS Info.plist UIRequiredDeviceCapabilities lists the 32-bit armv7; use arm64.',
    });
  }
  return issues;
}

function lacksExportComplianceKey(plist: string): boolean {
  return readPlistTopLevelValue(plist, 'ITSAppUsesNonExemptEncryption') === undefined;
}

function requires32BitArm(capabilitiesXml: string): boolean {
  return /<string>\s*armv7\s*<\/string>/u.test(capabilitiesXml);
}

export interface PlistValue {
  readonly start: number;
  readonly end: number;
  readonly xml: string;
}

/**
 * The value element following `<key>name</key>` (first occurrence), or
 * undefined. Only for keys that appear once in the document, such as the
 * top-level Info.plist keys this module manages.
 */
export function readPlistTopLevelValue(plist: string, key: string): PlistValue | undefined {
  const masked = plist.replace(/<!--[\s\S]*?-->/gu, (comment) => comment.replace(/[^\n]/gu, ' '));
  const marker = new RegExp(`<key>\\s*${escapeRegExp(key)}\\s*</key>\\s*`, 'u').exec(masked);
  if (marker === null) {
    return undefined;
  }
  const start = marker.index + marker[0].length;
  const open = /^<([A-Za-z]+)\s*(\/?)>/u.exec(masked.slice(start));
  if (open === null) {
    throw new Error(`Info.plist key ${key} has no readable value.`);
  }
  const tag = open[1] ?? '';
  if (open[2] === '/') {
    const end = start + open[0].length;
    return { start, end, xml: plist.slice(start, end) };
  }
  let depth = 0;
  const tags = new RegExp(`<(/?)${tag}\\b[^>]*?(/?)>`, 'gu');
  tags.lastIndex = start;
  for (let match = tags.exec(masked); match !== null; match = tags.exec(masked)) {
    if (match[2] === '/') {
      continue;
    }
    depth += match[1] === '/' ? -1 : 1;
    if (depth === 0) {
      const end = match.index + match[0].length;
      return { start, end, xml: plist.slice(start, end) };
    }
  }
  throw new Error(`Info.plist key ${key} has an unclosed value.`);
}

/** Replaces the value of `key`, or appends the entry to the root dictionary. */
export function setPlistTopLevelValue(plist: string, key: string, valueXml: string): string {
  const existing = readPlistTopLevelValue(plist, key);
  if (existing !== undefined) {
    return `${plist.slice(0, existing.start)}${valueXml}${plist.slice(existing.end)}`;
  }
  return insertPlistTopLevelEntry(plist, key, valueXml);
}

function insertPlistTopLevelEntry(plist: string, key: string, valueXml: string): string {
  const close = /<\/dict>\s*<\/plist>\s*$/u.exec(plist);
  if (close === null) {
    throw new Error('Info.plist must end with its root </dict></plist>.');
  }
  const newline = plist.includes('\r\n') ? '\r\n' : '\n';
  const head = plist.slice(0, close.index).replace(/[ \t]*$/u, '');
  const separator = head.endsWith('\n') ? '' : newline;
  return `${head}${separator}\t<key>${key}</key>${newline}\t${valueXml}${newline}${plist.slice(close.index)}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

// Orientation and device family.

/** The game's design orientation (`mpgd.game.json` `native.orientation`). */
export type NativeShellOrientation = 'portrait' | 'landscape' | 'any';
/** iOS devices the App Store offers the game on (`mpgd.targets.json` ios `metadata.iosDeviceFamily`). */
export type IosDeviceFamily = 'universal' | 'iphone';

const nativeShellOrientations: readonly NativeShellOrientation[] = ['portrait', 'landscape', 'any'];

/**
 * Reads `native.orientation` from a parsed `mpgd.game.json`; undefined when
 * the game has not chosen one, in which case nothing is enforced.
 */
export function readGameNativeOrientation(gameConfig: unknown): NativeShellOrientation | undefined {
  if (!isRecord(gameConfig) || gameConfig.native === undefined) {
    return undefined;
  }
  if (!isRecord(gameConfig.native)) {
    throw new Error('mpgd.game.json native must be an object when present.');
  }
  for (const key of Object.keys(gameConfig.native)) {
    if (key !== 'orientation') {
      throw new Error(`mpgd.game.json native.${key} is not supported.`);
    }
  }
  const orientation = gameConfig.native.orientation;
  if (orientation === undefined) {
    return undefined;
  }
  if (!nativeShellOrientations.includes(orientation as NativeShellOrientation)) {
    throw new Error("mpgd.game.json native.orientation must be 'portrait', 'landscape' or 'any'.");
  }
  return orientation as NativeShellOrientation;
}

/** Reads `metadata.iosDeviceFamily` of the ios target; undefined when not chosen. */
export function readIosDeviceFamily(metadata: unknown): IosDeviceFamily | undefined {
  if (!isRecord(metadata) || metadata.iosDeviceFamily === undefined) {
    return undefined;
  }
  if (metadata.iosDeviceFamily !== 'universal' && metadata.iosDeviceFamily !== 'iphone') {
    throw new Error("ios metadata.iosDeviceFamily must be 'universal' or 'iphone'.");
  }
  return metadata.iosDeviceFamily;
}

const iosPortrait = 'UIInterfaceOrientationPortrait';
const iosPortraitUpsideDown = 'UIInterfaceOrientationPortraitUpsideDown';
const iosLandscape = [
  'UIInterfaceOrientationLandscapeLeft',
  'UIInterfaceOrientationLandscapeRight',
];

/** iPhone orientations for a design orientation (upside-down portrait stays off, as in Xcode's template). */
export function iosIphoneOrientations(orientation: NativeShellOrientation): readonly string[] {
  if (orientation === 'portrait') {
    return [iosPortrait];
  }
  if (orientation === 'landscape') {
    return iosLandscape;
  }
  return [iosPortrait, ...iosLandscape];
}

/**
 * iPad always lists all four orientations. Apple deprecated
 * `UIRequiresFullScreen` in iPadOS 26 and asks apps to support every
 * orientation (TN3192); iPadOS keeps a game that prefers one orientation at a
 * consistent scene size, and the kit's runtime orientation policy letterboxes
 * or asks the player to rotate.
 */
export const iosIpadOrientations: readonly string[] = [
  iosPortrait,
  iosPortraitUpsideDown,
  ...iosLandscape,
];

/** Writes the iPhone and iPad orientation lists for the game's design orientation. */
export function applyIosInfoPlistOrientation(
  plist: string,
  orientation: NativeShellOrientation,
): string {
  const array = (values: readonly string[]): string =>
    `<array>${values.map((value) => `\n\t\t<string>${value}</string>`).join('')}\n\t</array>`;
  return setPlistTopLevelValue(
    setPlistTopLevelValue(
      plist,
      'UISupportedInterfaceOrientations',
      array(iosIphoneOrientations(orientation)),
    ),
    'UISupportedInterfaceOrientations~ipad',
    array(iosIpadOrientations),
  );
}

function readPlistStrings(plist: string, key: string): readonly string[] | undefined {
  const value = readPlistTopLevelValue(plist, key);
  if (value === undefined) {
    return undefined;
  }
  return [...value.xml.matchAll(/<string>\s*([^<]*?)\s*<\/string>/gu)].map(
    (match) => match[1] ?? '',
  );
}

export function inspectIosInfoPlistOrientation(
  plist: string,
  orientation: NativeShellOrientation | undefined,
  deviceFamily: IosDeviceFamily,
): readonly NativeShellPolicyIssue[] {
  const issues: NativeShellPolicyIssue[] = [];
  if (orientation !== undefined) {
    // A missing key means every orientation to iOS.
    const listed = readPlistStrings(plist, 'UISupportedInterfaceOrientations');
    const iphone = listed ?? iosIpadOrientations;
    const portrait = iphone.some(
      (value) => value === iosPortrait || value === iosPortraitUpsideDown,
    );
    const landscape = iphone.some((value) => iosLandscape.includes(value));
    const matchesByOrientation: Record<NativeShellOrientation, boolean> = {
      portrait: portrait && !landscape,
      landscape: landscape && !portrait,
      any: portrait && landscape,
    };
    const matches = matchesByOrientation[orientation];
    if (!matches) {
      issues.push({
        level: 'error',
        message: `iOS Info.plist UISupportedInterfaceOrientations (${
          listed === undefined ? 'key missing, so every orientation' : iphone.join(', ') || 'none'}) `
          + `does not match mpgd.game.json native.orientation "${orientation}".`,
      });
    }
  }
  if (deviceFamily === 'universal') {
    // Without the ~ipad key iPad uses the base list; without either, every orientation.
    const ipad = readPlistStrings(plist, 'UISupportedInterfaceOrientations~ipad')
      ?? readPlistStrings(plist, 'UISupportedInterfaceOrientations')
      ?? iosIpadOrientations;
    if (iosIpadOrientations.some((value) => !ipad.includes(value))) {
      issues.push({
        level: 'warning',
        message: 'iOS Info.plist iPad orientations (UISupportedInterfaceOrientations~ipad, or '
          + 'UISupportedInterfaceOrientations when that key is absent) do not list all four; '
          + 'Apple asks iPad apps to support every orientation (TN3192) and deprecated '
          + 'UIRequiresFullScreen in iPadOS 26.',
      });
    }
  }
  return issues;
}

/** `TARGETED_DEVICE_FAMILY` value: 1 = iPhone, 2 = iPad. */
export function iosTargetedDeviceFamily(family: IosDeviceFamily): string {
  return family === 'iphone' ? '1' : '1,2';
}

/** Sets `TARGETED_DEVICE_FAMILY` in every build configuration of the App target. */
export function applyIosProjectDeviceFamily(project: string, family: IosDeviceFamily): string {
  const value = `"${iosTargetedDeviceFamily(family)}"`;
  let next = project;
  for (const id of readAppTargetConfigurationIds(project)) {
    const settings = locatePbxBuildSettings(next, id);
    const body = next.slice(settings.start, settings.end);
    const assignment = /(\bTARGETED_DEVICE_FAMILY\s*=\s*)[^;]+;/u;
    const updated = assignment.test(body)
      ? body.replace(assignment, `$1${value};`)
      : `\n\t\t\t\tTARGETED_DEVICE_FAMILY = ${value};${body}`;
    next = `${next.slice(0, settings.start)}${updated}${next.slice(settings.end)}`;
  }
  return next;
}

/** The App target's Release `TARGETED_DEVICE_FAMILY`, without quotes, or undefined. */
export function readIosAppReleaseDeviceFamily(project: string): string | undefined {
  for (const id of readAppTargetConfigurationIds(project)) {
    const settings = locatePbxBuildSettings(project, id);
    if (settings.name !== 'Release') {
      continue;
    }
    const value = /\bTARGETED_DEVICE_FAMILY\s*=\s*([^;]+);/u.exec(
      project.slice(settings.start, settings.end),
    )?.[1];
    return value?.trim().replace(/^"(.*)"$/u, '$1').replace(/\s+/gu, '');
  }
  return undefined;
}

export function inspectIosProjectDeviceFamily(
  project: string,
  family: IosDeviceFamily | undefined,
): readonly NativeShellPolicyIssue[] {
  if (family === undefined) {
    return [];
  }
  const actual = readIosAppReleaseDeviceFamily(project);
  const expected = iosTargetedDeviceFamily(family);
  if (actual === expected) {
    return [];
  }
  return [{
    level: 'error',
    message: `iOS App target Release TARGETED_DEVICE_FAMILY is ${actual ?? 'unset'}, but `
      + `mpgd.targets.json ios metadata.iosDeviceFamily "${family}" needs "${expected}".`,
  }];
}

const androidOrientationValues: Record<NativeShellOrientation, readonly string[]> = {
  portrait: ['portrait', 'sensorPortrait', 'userPortrait', 'reversePortrait'],
  landscape: ['landscape', 'sensorLandscape', 'userLandscape', 'reverseLandscape'],
  any: ['unspecified', 'user', 'sensor', 'fullSensor', 'fullUser'],
};

/**
 * Sets the launcher activity's `android:screenOrientation` (`portrait`,
 * `sensorLandscape`, or none for `any`) and marks the application
 * `android:appCategory="game"`. Android 16 ignores orientation restrictions
 * on large screens for apps targeting API 36 unless the app is a game.
 */
export function applyAndroidManifestOrientation(
  manifest: string,
  orientation: NativeShellOrientation,
): string {
  const activity = findAndroidLauncherActivity(manifest);
  if (activity === undefined) {
    throw new Error('Android manifest has no launcher activity to orient.');
  }
  let tag = removeXmlAttribute(activity.tag, 'android:screenOrientation');
  if (orientation !== 'any') {
    const value = orientation === 'portrait' ? 'portrait' : 'sensorLandscape';
    tag = addXmlAttribute(tag, 'android:screenOrientation', value);
  }
  let next = `${manifest.slice(0, activity.start)}${tag}${manifest.slice(activity.start + activity.tag.length)}`;
  const application = /<application\b[^>]*?>/u.exec(maskXmlComments(next));
  if (application !== null) {
    const applicationTag = next.slice(application.index, application.index + application[0].length);
    if (!/\sandroid:appCategory\s*=/u.test(applicationTag)) {
      next = `${next.slice(0, application.index)}${addXmlAttribute(applicationTag, 'android:appCategory', 'game')}${
        next.slice(application.index + applicationTag.length)}`;
    }
  }
  return next;
}

export function inspectAndroidManifestOrientation(
  manifest: string,
  orientation: NativeShellOrientation | undefined,
): readonly NativeShellPolicyIssue[] {
  if (orientation === undefined) {
    return [];
  }
  const activity = findAndroidLauncherActivity(manifest);
  if (activity === undefined) {
    return [{ level: 'error', message: 'Android manifest has no launcher activity.' }];
  }
  const value = readXmlAttribute(activity.tag, 'android:screenOrientation') ?? 'unspecified';
  const issues: NativeShellPolicyIssue[] = [];
  if (!androidOrientationValues[orientation].includes(value)) {
    issues.push({
      level: 'error',
      message: `Android launcher activity android:screenOrientation="${value}" does not match `
        + `mpgd.game.json native.orientation "${orientation}".`,
    });
  }
  const application = /<application\b[^>]*?>/u.exec(maskXmlComments(manifest))?.[0] ?? '';
  if (orientation !== 'any' && readXmlAttribute(application, 'android:appCategory') !== 'game') {
    issues.push({
      level: 'warning',
      message: 'Android <application> has no android:appCategory="game": Android 16 ignores '
        + 'the orientation lock on tablets and foldables for apps targeting API 36 unless '
        + 'they are games.',
    });
  }
  return issues;
}

/**
 * The activity the launcher opens: one whose own intent filter has the
 * LAUNCHER category, or the `android:targetActivity` of a launcher
 * `<activity-alias>` (an arrangement the shell initializer accepts).
 */
function findAndroidLauncherActivity(
  manifest: string,
): { readonly start: number; readonly tag: string } | undefined {
  const elements = readAndroidActivityElements(manifest, 'activity');
  const direct = elements.find((element) => element.launcher);
  if (direct !== undefined) {
    return { start: direct.start, tag: direct.tag };
  }
  const alias = readAndroidActivityElements(manifest, 'activity-alias')
    .find((element) => element.launcher);
  const target = alias === undefined
    ? undefined
    : readXmlAttribute(alias.tag, 'android:targetActivity');
  if (target === undefined) {
    return undefined;
  }
  // Exact name, or a relative `.Main` against a fully qualified `pkg.Main`.
  const sameClass = (name: string): boolean => name === target
    || (target.startsWith('.') && name.endsWith(target))
    || (name.startsWith('.') && target.endsWith(name))
    // A dotless name is relative to the namespace too (`MainActivity`).
    || (!name.includes('.') && name !== '' && target.endsWith(`.${name}`))
    || (!target.includes('.') && name.endsWith(`.${target}`));
  const match = elements.filter((element) =>
    sameClass(readXmlAttribute(element.tag, 'android:name') ?? ''),
  );
  return match.length === 1 && match[0] !== undefined
    ? { start: match[0].start, tag: match[0].tag }
    : undefined;
}

function readAndroidActivityElements(
  manifest: string,
  element: 'activity' | 'activity-alias',
): readonly { readonly start: number; readonly tag: string; readonly launcher: boolean }[] {
  const masked = maskXmlComments(manifest);
  // The element name followed by whitespace, `/` or `>`, so `activity` never matches `activity-alias`.
  const openings = new RegExp(`<${element}(?=[\\s/>])(?:"[^"]*"|'[^']*'|[^>"'])*?(\\/?)>`, 'gu');
  const found: { start: number; tag: string; launcher: boolean }[] = [];
  for (const opening of masked.matchAll(openings)) {
    const start = opening.index ?? 0;
    const tagEnd = start + opening[0].length;
    const tag = manifest.slice(start, tagEnd);
    if (opening[1] === '/') {
      found.push({ start, tag, launcher: false });
      continue;
    }
    const close = masked.indexOf(`</${element}>`, tagEnd);
    const body = close === -1 ? '' : masked.slice(tagEnd, close);
    found.push({ start, tag, launcher: /android\.intent\.category\.LAUNCHER/u.test(body) });
  }
  return found;
}

function maskXmlComments(xml: string): string {
  return xml.replace(/<!--[\s\S]*?-->/gu, (comment) => comment.replace(/[^\n]/gu, ' '));
}

function xmlAttribute(name: string): RegExp {
  return new RegExp(`(\\s+)${escapeRegExp(name)}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'u');
}

function readXmlAttribute(tag: string, name: string): string | undefined {
  const match = xmlAttribute(name).exec(tag);
  return match === null ? undefined : (match[2] ?? match[3]);
}

function removeXmlAttribute(tag: string, name: string): string {
  return tag.replace(xmlAttribute(name), '');
}

/** Appends an attribute before the tag closes, reusing the last attribute's separator. */
function addXmlAttribute(tag: string, name: string, value: string): string {
  const close = /\s*\/?>$/u.exec(tag);
  const end = close?.index ?? tag.length;
  const separators = [...tag.slice(0, end).matchAll(/(\s+)[A-Za-z_:][\w:.-]*\s*=/gu)];
  const separator = separators.at(-1)?.[1] ?? ' ';
  return `${tag.slice(0, end)}${separator}${name}="${value}"${tag.slice(end)}`;
}

interface PbxBuildSettings {
  readonly name: string;
  readonly start: number;
  readonly end: number;
}

function readAppTargetConfigurationIds(project: string): readonly string[] {
  const target = findPbxObject(
    project,
    (body) => /\bisa\s*=\s*PBXNativeTarget;/u.test(body) && /\bname\s*=\s*"?App"?\s*;/u.test(body),
  );
  const listId = /\bbuildConfigurationList\s*=\s*([A-F0-9]+)\b/u.exec(target?.text ?? '')?.[1];
  const list = listId === undefined ? undefined : findPbxObjectById(project, listId);
  const ids = list === undefined
    ? undefined
    : readPbxList(project, list, 'buildConfigurations')?.ids;
  if (ids === undefined) {
    throw new Error('Xcode project has no App target build configuration list.');
  }
  return ids;
}

function locatePbxBuildSettings(project: string, id: string): PbxBuildSettings {
  const marker = new RegExp(`\\b${id}\\s*(?:\\/\\*[^*]*\\*\\/)?\\s*=\\s*\\{`, 'u').exec(project);
  if (marker === null) {
    throw new Error(`Xcode build configuration ${id} is missing.`);
  }
  const object = readBraced(project, project.indexOf('{', marker.index));
  const name = /\bname\s*=\s*"?([^";]+)"?\s*;/u.exec(object.text.replace(/\bbuildSettings\s*=\s*\{[\s\S]*\}\s*;/u, ''))?.[1] ?? '';
  const settingsMarker = /\bbuildSettings\s*=\s*\{/u.exec(object.text);
  if (settingsMarker === null) {
    throw new Error(`Xcode build configuration ${id} has no build settings.`);
  }
  const settings = readBraced(
    project,
    object.start + settingsMarker.index + settingsMarker[0].length - 1,
  );
  return { name: name.trim(), start: settings.start, end: settings.end };
}

/** The text between a `{` and its matching `}` (exclusive), skipping quoted strings and comments. */
function readBraced(source: string, open: number): { readonly text: string; readonly start: number; readonly end: number } {
  let depth = 0;
  let quote = false;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === '\\') {
        index += 1;
      } else if (character === '"') {
        quote = false;
      }
      continue;
    }
    if (character === '/' && source[index + 1] === '*') {
      const close = source.indexOf('*/', index + 2);
      index = close === -1 ? source.length : close + 1;
      continue;
    }
    if (character === '"') {
      quote = true;
    } else if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        return { text: source.slice(open + 1, index), start: open + 1, end: index };
      }
    }
  }
  throw new Error('Xcode project has an unclosed object.');
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// App privacy manifest.

export const iosAppPrivacyManifestFile = 'PrivacyInfo.xcprivacy';

/**
 * App-level privacy manifest of a kit shell. The App target's own code
 * (AppDelegate, SceneDelegate) calls no required-reason API and the kit does
 * no tracking; Capacitor core and the kit's game-services plugin ship their
 * own manifests (the plugin declares UserDefaults CA92.1). The collected
 * data array is empty only because the kit-owned shell code collects
 * nothing: a game adds the required-reason APIs its own native code uses
 * and an entry for each data type it collects
 * (docs/STORE_PRIVACY_DISCLOSURES.md).
 */
export const iosAppPrivacyManifestXml = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
  '<plist version="1.0">',
  '<dict>',
  '\t<key>NSPrivacyTracking</key>',
  '\t<false/>',
  '\t<key>NSPrivacyTrackingDomains</key>',
  '\t<array/>',
  '\t<key>NSPrivacyCollectedDataTypes</key>',
  '\t<array/>',
  '\t<key>NSPrivacyAccessedAPITypes</key>',
  '\t<array/>',
  '</dict>',
  '</plist>',
  '',
].join('\n');

/**
 * Adds a file in the App group to the App target's Resources phase of a
 * Capacitor-generated project. Returns undefined when the project does not
 * have that layout (an App group with `path = App`, a Resources phase, the
 * PBXBuildFile/PBXFileReference section markers), so the caller can leave the
 * project alone. A project whose Resources phase already bundles the file is
 * returned unchanged; one whose App group references it without bundling it
 * is left to the game (undefined).
 */
export function addIosAppResource(project: string, fileName: string): string | undefined {
  const resourcesPhase = findAppResourcesPhase(project);
  const group = findAppGroup(project);
  if (resourcesPhase === undefined || group === undefined
    || !project.includes('/* End PBXBuildFile section */')
    || !project.includes('/* End PBXFileReference section */')) {
    return undefined;
  }
  if (resourcesPhase.text.includes(`/* ${fileName} in Resources */`)) {
    return project;
  }
  if (group.text.includes(`/* ${fileName} */`)) {
    // Referenced but not bundled: a game-owned arrangement this helper leaves alone.
    return undefined;
  }
  const fileId = uniquePbxId(project, `${fileName}:file`);
  const buildId = uniquePbxId(project, `${fileName}:build`);
  const edits = [
    {
      at: project.indexOf('/* End PBXBuildFile section */'),
      text: `\t\t${buildId} /* ${fileName} in Resources */ = {isa = PBXBuildFile; fileRef = ${fileId} /* ${fileName} */; };\n`,
    },
    {
      at: project.indexOf('/* End PBXFileReference section */'),
      text: `\t\t${fileId} /* ${fileName} */ = {isa = PBXFileReference; lastKnownFileType = text.xml; path = ${fileName}; sourceTree = "<group>"; };\n`,
    },
    { at: group.childrenEnd, text: `\t${fileId} /* ${fileName} */,\n\t\t\t` },
    { at: resourcesPhase.filesEnd, text: `\t${buildId} /* ${fileName} in Resources */,\n\t\t\t` },
  ].sort((left, right) => right.at - left.at);
  let next = project;
  for (const edit of edits) {
    next = `${next.slice(0, edit.at)}${edit.text}${next.slice(edit.at)}`;
  }
  return next;
}

/** Whether the App target's Resources phase bundles `fileName`. */
export function iosAppBundlesResource(project: string, fileName: string): boolean {
  return findAppResourcesPhase(project)?.text.includes(`/* ${fileName} in Resources */`) === true;
}

export function inspectIosAppPrivacyManifest(project: string): readonly NativeShellPolicyIssue[] {
  if (iosAppBundlesResource(project, iosAppPrivacyManifestFile)) {
    return [];
  }
  return [{
    level: 'warning',
    message: `iOS App target does not bundle an app-level ${iosAppPrivacyManifestFile}; add one `
      + 'to the App group and its Resources phase (the kit reference shell has one) and declare '
      + "any required-reason API the game's own native code uses.",
  }];
}

function findAppResourcesPhase(
  project: string,
): { readonly text: string; readonly filesEnd: number } | undefined {
  const target = findPbxObject(
    project,
    (body) => /\bisa\s*=\s*PBXNativeTarget;/u.test(body) && /\bname\s*=\s*"?App"?\s*;/u.test(body),
  );
  if (target === undefined) {
    return undefined;
  }
  for (const id of readPbxList(project, target, 'buildPhases')?.ids ?? []) {
    const phase = findPbxObjectById(project, id);
    if (phase === undefined || !/\bisa\s*=\s*PBXResourcesBuildPhase\s*;/u.test(phase.text)) {
      continue;
    }
    const files = readPbxList(project, phase, 'files');
    return files === undefined ? undefined : { text: files.text, filesEnd: files.end };
  }
  return undefined;
}

/** The `path = App` group listed in the project's main group, with its children list. */
function findAppGroup(
  project: string,
): { readonly text: string; readonly childrenEnd: number } | undefined {
  const projectObject = findPbxObject(project, (body) => /\bisa\s*=\s*PBXProject\s*;/u.test(body));
  const mainGroupId = /\bmainGroup\s*=\s*([A-F0-9]+)\b/u.exec(projectObject?.text ?? '')?.[1];
  const mainGroup = mainGroupId === undefined ? undefined : findPbxObjectById(project, mainGroupId);
  if (mainGroup === undefined) {
    return undefined;
  }
  for (const childId of readPbxList(project, mainGroup, 'children')?.ids ?? []) {
    const child = findPbxObjectById(project, childId);
    if (child === undefined || !/\bisa\s*=\s*PBXGroup\s*;/u.test(child.text)
      || !/\bpath\s*=\s*"?App"?\s*;/u.test(child.text)) {
      continue;
    }
    const children = readPbxList(project, child, 'children');
    return children === undefined ? undefined : { text: children.text, childrenEnd: children.end };
  }
  return undefined;
}

interface PbxObject {
  readonly text: string;
  readonly start: number;
}

function findPbxObject(project: string, accept: (body: string) => boolean): PbxObject | undefined {
  for (const match of project.matchAll(/\b([A-F0-9]+)\s*(?:\/\*[^*]*\*\/)?\s*=\s*\{/gu)) {
    const body = readBraced(project, project.indexOf('{', match.index ?? 0));
    if (accept(body.text)) {
      return { text: body.text, start: body.start };
    }
  }
  return undefined;
}

function findPbxObjectById(project: string, id: string): PbxObject | undefined {
  const marker = new RegExp(`\\b${id}\\s*(?:\\/\\*[^*]*\\*\\/)?\\s*=\\s*\\{`, 'u').exec(project);
  if (marker === null) {
    return undefined;
  }
  const body = readBraced(project, project.indexOf('{', marker.index));
  return { text: body.text, start: body.start };
}

/**
 * A `key = ( ... );` list inside an object: its raw text, the IDs of its
 * entries, and the offset of its closing parenthesis, skipping comments and
 * quoted strings (a `/* Info (1).plist *\/` comment does not end the list).
 */
function readPbxList(
  project: string,
  object: PbxObject,
  key: string,
): { readonly text: string; readonly ids: readonly string[]; readonly end: number } | undefined {
  const marker = new RegExp(`\\b${key}\\s*=\\s*\\(`, 'u').exec(object.text);
  if (marker === null) {
    return undefined;
  }
  const start = object.start + marker.index + marker[0].length;
  let quote = false;
  for (let index = start; index < project.length; index += 1) {
    const character = project[index];
    if (quote) {
      if (character === '\\') {
        index += 1;
      } else if (character === '"') {
        quote = false;
      }
      continue;
    }
    if (character === '/' && project[index + 1] === '*') {
      const close = project.indexOf('*/', index + 2);
      index = close === -1 ? project.length : close + 1;
      continue;
    }
    if (character === '"') {
      quote = true;
    } else if (character === ')') {
      const text = project.slice(start, index);
      const ids = text.replace(/\/\*[^]*?\*\//gu, ' ').split(',')
        .map((entry) => /^\s*([A-F0-9]+)\b/u.exec(entry)?.[1])
        .filter((id): id is string => id !== undefined);
      return { text, ids, end: index };
    }
  }
  return undefined;
}

/** A deterministic 24-hex object ID that the project does not use yet. */
function uniquePbxId(project: string, seed: string): string {
  for (let attempt = 0; ; attempt += 1) {
    let hash = 0x811c9dc5;
    const input = `mpgd:${seed}:${attempt}`;
    let hex = '';
    for (let round = 0; hex.length < 24; round += 1) {
      for (const character of `${input}:${round}`) {
        hash ^= character.charCodeAt(0);
        hash = Math.imul(hash, 0x01000193) >>> 0;
      }
      hex += hash.toString(16).toUpperCase().padStart(8, '0');
    }
    const id = hex.slice(0, 24);
    if (!project.includes(id)) {
      return id;
    }
  }
}

// Advertising declarations.

export const admobCapacitorPlugin = '@capacitor-community/admob';
export const androidAdIdPermission = 'com.google.android.gms.permission.AD_ID';

/** Whether the shell's package.json installs the AdMob Capacitor plugin. */
export function shellUsesAdMob(shellPackage: unknown): boolean {
  if (!isRecord(shellPackage)) {
    return false;
  }
  return [shellPackage.dependencies, shellPackage.devDependencies]
    .some((dependencies) => isRecord(dependencies) && dependencies[admobCapacitorPlugin] !== undefined);
}

function adIdPermissions(manifest: string): readonly RegExpExecArray[] {
  const masked = maskXmlComments(manifest);
  return [...masked.matchAll(/<uses-permission(?=[\s/>])[^>]*?\/?>(?:\s*<\/uses-permission>)?/gu)]
    .filter((match) => readXmlAttribute(match[0], 'android:name') === androidAdIdPermission);
}

/** `declared`, `removed` (tools:node="remove"), or `absent` from the app manifest. */
export function readAndroidAdIdDeclaration(manifest: string): 'declared' | 'removed' | 'absent' {
  const permissions = adIdPermissions(manifest);
  if (permissions.length === 0) {
    return 'absent';
  }
  return permissions.some((match) => readXmlAttribute(match[0], 'tools:node') === 'remove')
    ? 'removed'
    : 'declared';
}

/**
 * Declares the advertising ID permission when the game shows AdMob ads
 * (Google Mobile Ads also merges it) and removes it from the merged manifest
 * otherwise, so the Play Console advertising ID answer matches the binary.
 */
export function applyAndroidManifestAdId(manifest: string, usesAds: boolean): string {
  if (adIdPermissions(manifest).length === 1
    && readAndroidAdIdDeclaration(manifest) === (usesAds ? 'declared' : 'removed')) {
    return manifest;
  }
  let next = manifest;
  for (const permission of [...adIdPermissions(manifest)].reverse()) {
    const start = permission.index ?? 0;
    const lineStart = next.lastIndexOf('\n', start - 1) + 1;
    const end = start + permission[0].length;
    const lineEnd = /^[ \t]*\r?\n/u.exec(next.slice(end))?.[0].length ?? 0;
    const whole = next.slice(lineStart, start).trim() === '' ? lineStart : start;
    next = `${next.slice(0, whole)}${next.slice(end + (whole === lineStart ? lineEnd : 0))}`;
  }
  const masked = maskXmlComments(next);
  const close = masked.lastIndexOf('</manifest>');
  const root = /<manifest\b[^>]*?>/u.exec(masked);
  if (close === -1 || root === null) {
    throw new Error('Android manifest has no <manifest> root.');
  }
  const newline = next.includes('\r\n') ? '\r\n' : '\n';
  const element = usesAds
    ? `<uses-permission android:name="${androidAdIdPermission}" />`
    : `<uses-permission android:name="${androidAdIdPermission}" tools:node="remove" />`;
  let rootTag = next.slice(root.index, root.index + root[0].length);
  if (!usesAds && !/\sxmlns:tools\s*=/u.test(rootTag)) {
    rootTag = addXmlAttribute(rootTag, 'xmlns:tools', 'http://schemas.android.com/tools');
  }
  const head = `${next.slice(0, root.index)}${rootTag}${next.slice(root.index + root[0].length, close)}`;
  return `${head.trimEnd()}${newline}    ${element}${newline}${next.slice(close)}`;
}

/**
 * `ads.admob.advertisingId` in `mpgd.game.json`: `removed` records a
 * deliberate no-advertising-ID policy (for example a child-directed game)
 * for a shell that installs AdMob; anything else expects the permission.
 */
export function readGameAdvertisingIdPolicy(gameConfig: unknown): 'declared' | 'removed' {
  const ads = isRecord(gameConfig) ? gameConfig.ads : undefined;
  const admob = isRecord(ads) ? ads.admob : undefined;
  const value = isRecord(admob) ? admob.advertisingId : undefined;
  if (value === undefined || value === 'declared') {
    return 'declared';
  }
  if (value === 'removed') {
    return 'removed';
  }
  throw new Error("mpgd.game.json ads.admob.advertisingId must be 'declared' or 'removed'.");
}

export function inspectAndroidManifestAds(
  manifest: string,
  usesAds: boolean,
  advertisingIdPolicy: 'declared' | 'removed' = 'declared',
): readonly NativeShellPolicyIssue[] {
  const issues: NativeShellPolicyIssue[] = [];
  const declaration = readAndroidAdIdDeclaration(manifest);
  if (usesAds) {
    const hasAppId = [...maskXmlComments(manifest).matchAll(/<meta-data\b[^>]*?\/?>/gu)]
      .some((match) => readXmlAttribute(match[0], 'android:name') === 'com.google.android.gms.ads.APPLICATION_ID');
    if (!hasAppId) {
      issues.push({
        level: 'error',
        message: 'The shell installs AdMob but neither android/app/src/main/AndroidManifest.xml '
          + "nor the release source set's manifest has com.google.android.gms.ads.APPLICATION_ID "
          + 'meta-data; the app crashes at launch.',
      });
    }
    if (declaration === 'removed' && advertisingIdPolicy !== 'removed') {
      issues.push({
        level: 'error',
        message: `AndroidManifest.xml removes ${androidAdIdPermission} although the shell installs `
          + 'AdMob: ads get a zeroed advertising ID on Android 13+ and the Play Console answer no '
          + 'longer matches. Replace the tools:node="remove" line with '
          + `<uses-permission android:name="${androidAdIdPermission}" />, or, for a deliberate `
          + 'no-advertising-ID policy (for example a child-directed game), set '
          + 'ads.admob.advertisingId to "removed" in mpgd.game.json.',
      });
    }
    if (declaration !== 'removed' && advertisingIdPolicy === 'removed') {
      issues.push({
        level: 'error',
        message: 'mpgd.game.json ads.admob.advertisingId is "removed", but AndroidManifest.xml '
          + `does not remove ${androidAdIdPermission}; add `
          + `<uses-permission android:name="${androidAdIdPermission}" tools:node="remove" />.`,
      });
    }
  } else if (declaration !== 'removed') {
    issues.push({
      level: 'warning',
      message: `The shell shows no AdMob ads, but AndroidManifest.xml does not remove `
        + `${androidAdIdPermission}; a dependency can still merge it. Add `
        + `<uses-permission android:name="${androidAdIdPermission}" tools:node="remove" />.`,
    });
  }
  return issues;
}

export function inspectIosInfoPlistAds(
  plist: string,
  usesAds: boolean,
): readonly NativeShellPolicyIssue[] {
  if (!usesAds) {
    return [];
  }
  const issues: NativeShellPolicyIssue[] = [];
  if (readPlistTopLevelValue(plist, 'GADApplicationIdentifier') === undefined) {
    issues.push({
      level: 'error',
      message: 'The shell installs AdMob but Info.plist has no GADApplicationIdentifier; the '
        + 'Google Mobile Ads SDK stops the app at launch.',
    });
  }
  const networks = readPlistTopLevelValue(plist, 'SKAdNetworkItems');
  if (networks === undefined || !/cstr6suwn9\.skadnetwork/u.test(networks.xml)) {
    issues.push({
      level: 'warning',
      message: "Info.plist SKAdNetworkItems does not list Google's cstr6suwn9.skadnetwork; copy "
        + 'the current list from https://developers.google.com/admob/ios/3p-skadnetworks.',
    });
  }
  return issues;
}

// iOS push (`--providers notifications`).

/** The entitlements file of a kit shell's App target, in the App group. */
export const iosPushEntitlementsFile = 'App.entitlements';
/** Its `CODE_SIGN_ENTITLEMENTS` value, relative to the Xcode project directory (`ios/App`). */
export const iosPushEntitlementsSetting = `App/${iosPushEntitlementsFile}`;

/**
 * The Push Notifications entitlement the Xcode capability writes. Apple:
 * "Xcode sets the value of the entitlement based on your app's current
 * provisioning profile", so `development` here signs as `production` with
 * an App Store profile
 * (https://developer.apple.com/documentation/bundleresources/entitlements/aps-environment).
 */
export const iosPushEntitlementsXml = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
  '<plist version="1.0">',
  '<dict>',
  '\t<key>aps-environment</key>',
  '\t<string>development</string>',
  '</dict>',
  '</plist>',
  '',
].join('\n');

/**
 * The AppDelegate methods `@capacitor-firebase/messaging` documents for iOS:
 * the plugin observes `.capacitorDidRegisterForRemoteNotifications` and hands
 * the APNs token to Firebase, so without them it never gets an FCM token.
 * The plugin README's third method (`didReceiveRemoteNotification`) is left
 * out: the kit sends no silent pushes, and plugin 8.5.2 never calls the
 * completion handler it is given.
 */
export const iosAppDelegatePushForwardingSwift: readonly string[] = [
  '    // @capacitor-firebase/messaging reads the APNs token from these Capacitor',
  '    // notifications (added by mpgd target init capacitor --providers notifications).',
  '    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {',
  '        NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications, object: deviceToken)',
  '    }',
  '',
  '    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {',
  '        NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)',
  '    }',
];

/** The call the scene delegate makes right after Capacitor's scene proxy (reference shell, #407). */
const iosSceneDelegateColdStartCall: readonly string[] = [
  '// A killed-app tap is only in connectionOptions.notificationResponse.',
  "// Capacitor 8.5's scene proxy replays URL contexts on capacitorViewDidAppear",
  '// and does not read this, and @capacitor/ios 8.5.2 never does either.',
  'forwardColdStartNotification(connectionOptions.notificationResponse)',
];

/** The scene delegate methods that replay a cold-start tap (reference shell, #407). */
export const iosSceneDelegateColdStartSwift: readonly string[] = [
  '    /// Replays a cold-start notification response once plugins have registered',
  "    /// with Capacitor's notification router. `load()` runs before",
  '    /// `capacitorViewDidAppear`, which is how the scene proxy replays URL contexts.',
  '    private func forwardColdStartNotification(_ response: UNNotificationResponse?) {',
  '        guard let response else { return }',
  '        var token: NSObjectProtocol?',
  '        token = NotificationCenter.default.addObserver(',
  '            forName: .capacitorViewDidAppear,',
  '            object: nil,',
  '            queue: .main',
  '        ) { _ in',
  '            if let token {',
  '                NotificationCenter.default.removeObserver(token)',
  '            }',
  '            self.deliverColdStartNotification(response)',
  '        }',
  '    }',
  '',
  '    private func deliverColdStartNotification(_ response: UNNotificationResponse) {',
  '        let center = UNUserNotificationCenter.current()',
  '        if let delegate = center.delegate {',
  '            delegate.userNotificationCenter?(center, didReceive: response, withCompletionHandler: {})',
  '            return',
  '        }',
  '        guard let controller = window?.rootViewController as? CAPBridgeViewController,',
  '              let bridge = controller.bridge else {',
  '            return',
  '        }',
  '        bridge.notificationRouter.userNotificationCenter(',
  '            center,',
  '            didReceive: response,',
  '            withCompletionHandler: {}',
  '        )',
  '    }',
];

/** Whether the shell's package.json installs the Firebase messaging plugin (`--providers notifications`). */
export function shellUsesFirebaseMessaging(shellPackage: unknown): boolean {
  if (!isRecord(shellPackage)) {
    return false;
  }
  return [shellPackage.dependencies, shellPackage.devDependencies].some((dependencies) =>
    isRecord(dependencies) && dependencies[notificationsMessagingPlugin] !== undefined);
}

/**
 * Swift source with comments and string literals blanked to spaces, so
 * offsets stay the same and only code is matched. Nested block comments,
 * multi-line strings and raw strings (`#"..."#`) are handled; an
 * interpolation's code inside a string is blanked with it, and a
 * single-line string that runs into a newline ends there, so one the
 * scanner misreads cannot blank the rest of the file.
 */
export function stripSwiftCommentsAndStrings(source: string): string {
  let output = '';
  let commentDepth = 0;
  let lineComment = false;
  /** The open string's closing delimiter, and whether `\` escapes in it. */
  let closing: { readonly text: string; readonly multiline: boolean; readonly raw: boolean } | undefined;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? '';
    const next = source[index + 1] ?? '';
    const blank = character === '\n' ? '\n' : ' ';
    if (lineComment) {
      lineComment = character !== '\n';
      output += blank;
    } else if (commentDepth > 0) {
      if (character === '/' && next === '*') {
        commentDepth += 1;
        output += '  ';
        index += 1;
      } else if (character === '*' && next === '/') {
        commentDepth -= 1;
        output += '  ';
        index += 1;
      } else {
        output += blank;
      }
    } else if (closing !== undefined) {
      if (!closing.raw && character === '\\' && next !== '' && next !== '\n') {
        output += '  ';
        index += 1;
      } else if (source.startsWith(closing.text, index)) {
        output += ' '.repeat(closing.text.length);
        index += closing.text.length - 1;
        closing = undefined;
      } else {
        if (character === '\n' && !closing.multiline) {
          closing = undefined;
        }
        output += blank;
      }
    } else if (character === '/' && next === '/') {
      lineComment = true;
      output += '  ';
      index += 1;
    } else if (character === '/' && next === '*') {
      commentDepth = 1;
      output += '  ';
      index += 1;
    } else {
      const opener = /^(#*)("""|")/u.exec(source.slice(index, index + 64));
      if (opener === null || (opener[1] === '' && character !== '"')) {
        output += character;
        continue;
      }
      const hashes = opener[1] ?? '';
      const quote = opener[2] ?? '"';
      closing = { text: `${quote}${hashes}`, multiline: quote === '"""', raw: hashes !== '' };
      output += ' '.repeat(opener[0].length);
      index += opener[0].length - 1;
    }
  }
  return output;
}

/**
 * The offset of the `}` that closes the top-level `class <name>` whose
 * inheritance clause names `conformance`, in source whose comments and
 * strings are blanked, or undefined.
 */
function findSwiftClassClose(code: string, name: string, conformance: string): number | undefined {
  const declaration = new RegExp(`\\bclass\\s+${name}\\b([^{};]*)\\{`, 'gu');
  for (const match of code.matchAll(declaration)) {
    const open = (match.index ?? 0) + match[0].length - 1;
    const before = code.slice(0, match.index ?? 0);
    const depthBefore = (before.match(/\{/gu)?.length ?? 0) - (before.match(/\}/gu)?.length ?? 0);
    if (depthBefore !== 0 || !new RegExp(`\\b${conformance}\\b`, 'u').test(match[1] ?? '')) {
      continue;
    }
    let depth = 0;
    for (let index = open; index < code.length; index += 1) {
      if (code[index] === '{') {
        depth += 1;
      } else if (code[index] === '}') {
        depth -= 1;
        if (depth === 0) {
          return index;
        }
      }
    }
    return undefined;
  }
  return undefined;
}

/** `lines` inserted before the class's closing brace, after one blank line. */
function insertBeforeSwiftClassClose(source: string, close: number, lines: readonly string[]): string {
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const head = source.slice(0, close).replace(/\s*$/u, '');
  return `${head}${newline}${newline}${lines.join(newline)}${newline}${source.slice(close)}`;
}

/** The body of each `func` whose name or labels include `label`, in blanked source. */
function swiftFunctionBodies(code: string, label: string): readonly string[] {
  const bodies: string[] = [];
  for (const match of code.matchAll(new RegExp(`\\bfunc\\b[^{}]*\\b${label}\\b[^{}]*\\{`, 'gu'))) {
    const open = (match.index ?? 0) + match[0].length - 1;
    let depth = 0;
    for (let index = open; index < code.length; index += 1) {
      if (code[index] === '{') {
        depth += 1;
      } else if (code[index] === '}') {
        depth -= 1;
        if (depth === 0) {
          bodies.push(code.slice(open + 1, index));
          break;
        }
      }
    }
  }
  return bodies;
}

/**
 * Whether a Swift source's `didRegisterForRemoteNotificationsWithDeviceToken`
 * hands the APNs token on: it posts `.capacitorDidRegisterForRemoteNotifications`
 * (what the messaging plugin observes) or sets Firebase's `apnsToken` itself.
 */
export function swiftForwardsPushToken(source: string): boolean {
  return swiftFunctionBodies(
    stripSwiftCommentsAndStrings(source),
    'didRegisterForRemoteNotificationsWithDeviceToken',
  ).some((body) => /\bcapacitorDidRegisterForRemoteNotifications\b|\.\s*apnsToken\s*=/u.test(body));
}

/** Whether a Swift source declares a scene delegate class. */
export function swiftDeclaresSceneDelegate(source: string): boolean {
  return /\bclass\s+\w+\s*:[^{]*\bUIWindowSceneDelegate\b/u.test(
    stripSwiftCommentsAndStrings(source),
  );
}

/** Whether a Swift source forwards the scene's cold-start notification response. */
export function swiftForwardsColdStartNotification(source: string): boolean {
  return /\.\s*notificationResponse\b/u.test(stripSwiftCommentsAndStrings(source));
}

/**
 * Adds the APNs registration forwarding (`iosAppDelegatePushForwardingSwift`)
 * to the `AppDelegate` class. An AppDelegate that already forwards the token
 * is returned unchanged; undefined when the class is not found or already
 * implements a registration callback without the forwarding, which is left
 * to the game.
 */
export function applyIosAppDelegatePushForwarding(source: string): string | undefined {
  if (swiftForwardsPushToken(source)) {
    return source;
  }
  const code = stripSwiftCommentsAndStrings(source);
  if (/\bdidRegisterForRemoteNotificationsWithDeviceToken\b|\bdidFailToRegisterForRemoteNotificationsWithError\b/u
    .test(code)) {
    return undefined;
  }
  const close = findSwiftClassClose(code, 'AppDelegate', 'UIApplicationDelegate');
  return close === undefined
    ? undefined
    : insertBeforeSwiftClassClose(source, close, iosAppDelegatePushForwardingSwift);
}

/**
 * Adds the cold-start notification forwarding of the kit reference shell
 * (#407) to Capacitor's `SceneDelegate`: `import UserNotifications`, the
 * call after `SceneDelegateProxy.shared.scene(_:willConnectTo:options:)`,
 * and `iosSceneDelegateColdStartSwift`. A scene delegate that already reads
 * `notificationResponse` is returned unchanged; undefined when it does not
 * have Capacitor's layout, which is left to the game.
 */
export function applyIosSceneDelegateColdStartForwarding(source: string): string | undefined {
  if (swiftForwardsColdStartNotification(source)) {
    return source;
  }
  const code = stripSwiftCommentsAndStrings(source);
  const proxyCalls = [...code.matchAll(
    /SceneDelegateProxy\s*\.\s*shared\s*\.\s*scene\s*\(\s*scene\s*,\s*willConnectTo\s*:\s*session\s*,\s*options\s*:\s*connectionOptions\s*\)/gu,
  )];
  const capacitorImport = /^import[ \t]+Capacitor[ \t]*(?=\r?$)/mu.exec(code);
  if (proxyCalls.length !== 1 || capacitorImport === null
    || /\bforwardColdStartNotification\b|\bdeliverColdStartNotification\b/u.test(code)) {
    return undefined;
  }
  const close = findSwiftClassClose(code, 'SceneDelegate', 'UIWindowSceneDelegate');
  const call = proxyCalls[0];
  if (close === undefined || call?.index === undefined || call.index > close) {
    return undefined;
  }
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const lineStart = source.lastIndexOf('\n', call.index) + 1;
  const indentation = /^[ \t]*/u.exec(source.slice(lineStart))?.[0] ?? '';
  const lineEnd = code.indexOf('\n', call.index);
  if (lineEnd === -1 || lineEnd > close || code.slice(call.index + call[0].length, lineEnd).trim() !== '') {
    return undefined;
  }
  const callEnd = source[lineEnd - 1] === '\r' ? lineEnd - 1 : lineEnd;
  const withMethods = insertBeforeSwiftClassClose(source, close, iosSceneDelegateColdStartSwift);
  const withCall = `${withMethods.slice(0, callEnd)}${
    iosSceneDelegateColdStartCall.map((line) => `${newline}${indentation}${line}`).join('')}${
    withMethods.slice(callEnd)}`;
  if (/^import[ \t]+UserNotifications[ \t]*(?=\r?$)/mu.test(code)) {
    return withCall;
  }
  const importEnd = capacitorImport.index + capacitorImport[0].length;
  return `${withCall.slice(0, importEnd)}${newline}import UserNotifications${withCall.slice(importEnd)}`;
}

/** The App target's Release `CODE_SIGN_ENTITLEMENTS`, without quotes, or undefined. */
export function readIosAppReleaseEntitlements(project: string): string | undefined {
  for (const id of readAppTargetConfigurationIds(project)) {
    const settings = locatePbxBuildSettings(project, id);
    if (settings.name === 'Release') {
      return readPbxSetting(project.slice(settings.start, settings.end), 'CODE_SIGN_ENTITLEMENTS');
    }
  }
  return undefined;
}

function readPbxSetting(settings: string, name: string): string | undefined {
  const value = new RegExp(`(?:^|[\\s;{])${name}\\s*=\\s*([^;]+);`, 'u').exec(settings)?.[1];
  return value?.trim().replace(/^"(.*)"$/u, '$1');
}

/**
 * The entitlements path a `CODE_SIGN_ENTITLEMENTS` value names, relative to
 * the Xcode project directory, or undefined when it uses another build
 * setting the kit cannot resolve.
 */
export function resolveIosEntitlementsSetting(value: string): string | undefined {
  const relative = value.replace(/^\$[({](?:SRCROOT|PROJECT_DIR)[)}]\//u, '');
  return relative.includes('$') || relative === '' ? undefined : relative;
}

/**
 * Adds `App.entitlements` to the App group of a Capacitor-generated project
 * and sets `CODE_SIGN_ENTITLEMENTS` in every App target build configuration.
 * The file is not bundled (no build phase). A project that already points
 * there is returned unchanged; undefined when the project has another layout
 * or another entitlements file, which is left to the game.
 */
export function applyIosProjectPushEntitlements(project: string): string | undefined {
  try {
    return addIosProjectPushEntitlements(project);
  } catch {
    // An Xcode project this cannot read is left to the game, like any other layout.
    return undefined;
  }
}

function addIosProjectPushEntitlements(project: string): string | undefined {
  const configurationIds = readAppTargetConfigurationIds(project);
  if (/\bCODE_SIGN_ENTITLEMENTS\s*\[/u.test(project)) {
    // A per-SDK entitlements setting would override the one this adds.
    return undefined;
  }
  const group = findAppGroup(project);
  if (group === undefined || !project.includes('/* End PBXFileReference section */')) {
    return undefined;
  }
  for (const id of configurationIds) {
    const settings = locatePbxBuildSettings(project, id);
    const current = readPbxSetting(
      project.slice(settings.start, settings.end),
      'CODE_SIGN_ENTITLEMENTS',
    );
    if (current !== undefined && resolveIosEntitlementsSetting(current) !== iosPushEntitlementsSetting) {
      return undefined;
    }
  }
  let next = project;
  if (!group.text.includes(`/* ${iosPushEntitlementsFile} */`)) {
    const fileId = uniquePbxId(project, `${iosPushEntitlementsFile}:file`);
    const edits = [
      {
        at: project.indexOf('/* End PBXFileReference section */'),
        text: `\t\t${fileId} /* ${iosPushEntitlementsFile} */ = {isa = PBXFileReference; lastKnownFileType = text.plist.entitlements; path = ${iosPushEntitlementsFile}; sourceTree = "<group>"; };\n`,
      },
      { at: group.childrenEnd, text: `\t${fileId} /* ${iosPushEntitlementsFile} */,\n\t\t\t` },
    ].sort((left, right) => right.at - left.at);
    for (const edit of edits) {
      next = `${next.slice(0, edit.at)}${edit.text}${next.slice(edit.at)}`;
    }
  }
  for (const id of configurationIds) {
    const settings = locatePbxBuildSettings(next, id);
    const body = next.slice(settings.start, settings.end);
    if (readPbxSetting(body, 'CODE_SIGN_ENTITLEMENTS') === undefined) {
      next = `${next.slice(0, settings.start)}\n\t\t\t\tCODE_SIGN_ENTITLEMENTS = ${
        iosPushEntitlementsSetting};${body}${next.slice(settings.end)}`;
    }
  }
  return next;
}

/** What `inspectIosPushWiring` reads from the shell's iOS project. */
export interface IosPushWiringInput {
  /** `ios/App/App.xcodeproj/project.pbxproj`. */
  readonly project: string;
  /**
   * A file of the iOS project by its path relative to `ios/App` (the Xcode
   * project directory), or undefined when it is missing or unsafe to read.
   */
  readonly readProjectFile: (relative: string) => string | undefined;
  /** The Swift sources of the App group (`ios/App/App`). */
  readonly swiftSources: readonly string[];
}

export const iosPushEntitlementStep = 'add the Push Notifications capability to the App target in '
  + `Xcode, or create ios/App/App/${iosPushEntitlementsFile} with <key>aps-environment</key>`
  + `<string>development</string> and set CODE_SIGN_ENTITLEMENTS = ${iosPushEntitlementsSetting} `
  + "in the App target's Debug and Release build settings (Xcode signs the value from the "
  + 'provisioning profile, production for the App Store)';
export const iosPushTokenForwardingStep = 'add to the AppDelegate class: func application(_ '
  + 'application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) '
  + '{ NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications, object: '
  + 'deviceToken) } and func application(_ application: UIApplication, '
  + 'didFailToRegisterForRemoteNotificationsWithError error: Error) { NotificationCenter.default.post('
  + 'name: .capacitorDidFailToRegisterForRemoteNotifications, object: error) }';
export const iosPushColdStartStep = 'copy forwardColdStartNotification and '
  + 'deliverColdStartNotification from the mpgd-kit reference shell '
  + '(apps/mobile-capacitor/ios/App/App/SceneDelegate.swift) into SceneDelegate, import '
  + 'UserNotifications, and call forwardColdStartNotification(connectionOptions.notificationResponse) '
  + 'right after SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)';

/**
 * What a shell with `@capacitor-firebase/messaging` still lacks on iOS: the
 * `aps-environment` entitlement on the App target's Release configuration,
 * the AppDelegate's APNs token forwarding, and the scene delegate's
 * cold-start tap forwarding (for a shell with a scene delegate). Each is an
 * error: without the first two no push reaches the app, and without the
 * third a tap on a notification while the app is not running opens it
 * without the notification's route. An entitlement the kit cannot follow
 * (`inspectIosPushEntitlement`) is a warning. The forwarding checks are
 * textual: the token must be handed on inside
 * `didRegisterForRemoteNotificationsWithDeviceToken`, and some App source
 * must read `.notificationResponse`.
 */
export function inspectIosPushWiring(input: IosPushWiringInput): readonly NativeShellPolicyIssue[] {
  const issues: NativeShellPolicyIssue[] = [];
  const guide = ' (see the mpgd-kit Firebase guide, docs/FIREBASE_NOTIFICATIONS.md#4-ios).';
  const entitlement = inspectIosPushEntitlement(input, guide);
  if (entitlement !== undefined) {
    issues.push(entitlement);
  }
  if (!input.swiftSources.some(swiftForwardsPushToken)) {
    issues.push({
      level: 'error',
      message: 'The shell installs @capacitor-firebase/messaging, but no App Swift source forwards '
        + 'the APNs device token to Capacitor, so the plugin never gets an FCM token: '
        + `${iosPushTokenForwardingStep}${guide}`,
    });
  }
  // A shell without scenes gets a cold-start tap through the notification
  // center delegate; only a scene delegate must forward it.
  if (input.swiftSources.some(swiftDeclaresSceneDelegate)
    && !input.swiftSources.some(swiftForwardsColdStartNotification)) {
    issues.push({
      level: 'error',
      message: 'The shell installs @capacitor-firebase/messaging, but its iOS SceneDelegate does '
        + 'not forward connectionOptions.notificationResponse, so a tap on a notification while '
        + "the app is not running opens the game without the notification's route: "
        + `${iosPushColdStartStep}${guide}`,
    });
  }
  return issues;
}

/**
 * The Release configuration's `aps-environment` entitlement: an error when it
 * is provably missing, a warning when the shell sets it in a way the kit
 * cannot follow (an xcconfig, a per-SDK setting, another build setting, a
 * build-setting value).
 */
function inspectIosPushEntitlement(
  input: IosPushWiringInput,
  guide: string,
): NativeShellPolicyIssue | undefined {
  const unverifiable = (reason: string): NativeShellPolicyIssue => ({
    level: 'warning',
    message: `The kit cannot verify the iOS aps-environment entitlement: ${reason}; make sure the `
      + `App target's Release signing includes it${guide}`,
  });
  let release: ReturnType<typeof readIosAppReleaseSigning>;
  try {
    release = readIosAppReleaseSigning(input.project);
  } catch {
    return unverifiable('the Xcode project could not be read');
  }
  if (release.conditional) {
    return unverifiable('CODE_SIGN_ENTITLEMENTS is set per SDK');
  }
  if (release.entitlements === undefined && release.baseConfiguration) {
    return unverifiable(
      'the Release configuration has a base xcconfig that may set CODE_SIGN_ENTITLEMENTS',
    );
  }
  const relative = release.entitlements === undefined
    ? undefined
    : resolveIosEntitlementsSetting(release.entitlements);
  if (release.entitlements !== undefined && relative === undefined) {
    return unverifiable(`CODE_SIGN_ENTITLEMENTS is ${release.entitlements}`);
  }
  const entitlements = relative === undefined ? undefined : input.readProjectFile(relative);
  let value: string | undefined;
  try {
    value = entitlements === undefined
      ? undefined
      : readPlistTopLevelValue(entitlements, 'aps-environment')?.xml;
  } catch {
    value = undefined;
  }
  if (value !== undefined && /^<string>\s*(?:development|production)\s*<\/string>$/u.test(value)) {
    return undefined;
  }
  if (value !== undefined && /^<string>[^<]*\$[({]/u.test(value)) {
    return unverifiable(`aps-environment is ${value}`);
  }
  return {
    level: 'error',
    message: 'The shell installs @capacitor-firebase/messaging, but the iOS App target has no '
      + 'aps-environment entitlement in its Release configuration'
      + `${release.entitlements === undefined ? '' : ` (${release.entitlements})`}, so APNs issues no `
      + `device token and no push reaches the app: ${iosPushEntitlementStep}${guide}`,
  };
}

/** The App target's Release signing settings that decide its entitlements file. */
/**
 * The Release signing settings that decide the App target's entitlements
 * file: the target's own, else what it inherits from the project-level
 * Release configuration. `baseConfiguration` is set when an xcconfig may
 * supply or override the value; the entitlements are then unverifiable.
 */
function readIosAppReleaseSigning(project: string): {
  readonly entitlements: string | undefined;
  readonly conditional: boolean;
  readonly baseConfiguration: boolean;
} {
  const projectObject = findPbxObject(project, (body) => /\bisa\s*=\s*PBXProject\s*;/u.test(body));
  const projectListId = /\bbuildConfigurationList\s*=\s*([A-F0-9]+)\b/u.exec(
    projectObject?.text ?? '',
  )?.[1];
  const projectList = projectListId === undefined
    ? undefined
    : findPbxObjectById(project, projectListId);
  const levels = [
    readAppTargetConfigurationIds(project),
    projectList === undefined
      ? []
      : (readPbxList(project, projectList, 'buildConfigurations')?.ids ?? []),
  ];
  let baseConfiguration = false;
  for (const ids of levels) {
    for (const id of ids) {
      const settings = locatePbxBuildSettings(project, id);
      if (settings.name !== 'Release') {
        continue;
      }
      const body = project.slice(settings.start, settings.end);
      const entitlements = readPbxSetting(body, 'CODE_SIGN_ENTITLEMENTS');
      const conditional = /\bCODE_SIGN_ENTITLEMENTS\s*\[/u.test(body);
      if (entitlements !== undefined || conditional) {
        // A target xcconfig outranks the project-level settings: the value
        // found there may not be the one Xcode signs with.
        return baseConfiguration
          ? { entitlements: undefined, conditional: false, baseConfiguration }
          : { entitlements, conditional, baseConfiguration };
      }
      baseConfiguration ||= /\bbaseConfigurationReference\s*=/u.test(
        findPbxObjectById(project, id)?.text.replace(body, '') ?? '',
      );
    }
  }
  return { entitlements: undefined, conditional: false, baseConfiguration };
}

/** The Firebase config file the messaging plugin reads from the app bundle. */
export const iosFirebaseConfigFile = 'GoogleService-Info.plist';

export function inspectIosFirebaseConfig(project: string): readonly NativeShellPolicyIssue[] {
  if (iosAppBundlesResource(project, iosFirebaseConfigFile)) {
    return [];
  }
  return [{
    level: 'warning',
    message: `The shell installs @capacitor-firebase/messaging, but the iOS App target does not bundle `
      + `${iosFirebaseConfigFile}; the plugin then leaves Firebase unconfigured and push fails closed. `
      + 'Download it from the Firebase console and add it to the App target in Xcode.',
  }];
}
