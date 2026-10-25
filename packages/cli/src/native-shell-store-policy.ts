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
  if (readPlistTopLevelValue(next, 'ITSAppUsesNonExemptEncryption') === undefined) {
    next = insertPlistTopLevelEntry(next, 'ITSAppUsesNonExemptEncryption', '<false/>');
  }
  const capabilities = readPlistTopLevelValue(next, 'UIRequiredDeviceCapabilities');
  if (capabilities !== undefined && /<string>\s*armv7\s*<\/string>/u.test(capabilities.xml)) {
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
  if (readPlistTopLevelValue(plist, 'ITSAppUsesNonExemptEncryption') === undefined) {
    issues.push({
      level: 'warning',
      message: 'iOS Info.plist has no ITSAppUsesNonExemptEncryption: App Store Connect will ask '
        + 'the export-compliance question for every build and TestFlight holds the build until '
        + 'it is answered. Add <key>ITSAppUsesNonExemptEncryption</key><false/> when the game '
        + 'uses only HTTPS/OS encryption (see docs/TESTFLIGHT_INTERNAL_SUBMISSION.md).',
    });
  }
  const capabilities = readPlistTopLevelValue(plist, 'UIRequiredDeviceCapabilities');
  if (capabilities !== undefined && /<string>\s*armv7\s*<\/string>/u.test(capabilities.xml)) {
    issues.push({
      level: 'warning',
      message: 'iOS Info.plist UIRequiredDeviceCapabilities lists the 32-bit armv7; use arm64.',
    });
  }
  return issues;
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
