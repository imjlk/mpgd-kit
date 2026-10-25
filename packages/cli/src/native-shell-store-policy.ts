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

function findAndroidLauncherActivity(
  manifest: string,
): { readonly start: number; readonly tag: string } | undefined {
  const masked = maskXmlComments(manifest);
  // `<activity` followed by whitespace, `/` or `>`: never `<activity-alias`.
  const openings = /<activity(?=[\s/>])(?:"[^"]*"|'[^']*'|[^>"'])*?(\/?)>/gu;
  for (const opening of masked.matchAll(openings)) {
    const start = opening.index ?? 0;
    const tagEnd = start + opening[0].length;
    if (opening[1] === '/') {
      continue;
    }
    const close = masked.indexOf('</activity>', tagEnd);
    if (close === -1) {
      return undefined;
    }
    if (/android\.intent\.category\.LAUNCHER/u.test(masked.slice(tagEnd, close))) {
      return { start, tag: manifest.slice(start, tagEnd) };
    }
  }
  return undefined;
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
 * own manifests (the plugin declares UserDefaults CA92.1). A game adds the
 * APIs its own native code uses and, if it wants Xcode's privacy report to
 * match its App Store privacy answers, the data types it collects
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
        message: 'The shell installs AdMob but android/app/src/main/AndroidManifest.xml has no '
          + 'com.google.android.gms.ads.APPLICATION_ID meta-data; the app crashes at launch.',
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
