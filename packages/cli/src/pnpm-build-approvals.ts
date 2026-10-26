/**
 * pnpm build-script decisions for the dependencies a notifications game adds.
 *
 * pnpm 11 replaced `onlyBuiltDependencies` with `allowBuilds` and fails an
 * install (`ERR_PNPM_IGNORED_BUILDS`) while a dependency's build script is
 * neither allowed (`true`) nor denied (`false`), because `strictDepBuilds`
 * defaults to `true` (https://pnpm.io/settings/build). The notifications
 * starter adds `firebase`, whose tree has two such scripts:
 *
 * - `@firebase/util` `postinstall.js` only matters for Firebase App Hosting:
 *   it reads `FIREBASE_WEBAPP_CONFIG`, may fetch the web app config from
 *   firebase.googleapis.com, and bakes it into `dist/postinstall.*` for
 *   `initializeApp()` without options. The published `dist` already ships the
 *   placeholder that returns `undefined`, and the kit never initializes the web
 *   SDK (it is there so the messaging plugin's web fallback resolves), so the
 *   script is denied: the install stays offline and reproducible.
 * - `protobufjs` `scripts/postinstall.js` only prints a warning when the parent
 *   package declares protobufjs with another semver operator. The game
 *   template already allows it for the Apps in Toss toolchain, so the same
 *   decision is kept here.
 *
 * `packages/cli/test/pnpm-build-approvals.test.ts` records every package with
 * an install script in the starter's Firebase tree and fails when the starter's
 * firebase version moves without that list (and a decision here) being redone.
 */
export const notificationsBuildApprovals: Readonly<Record<string, boolean>> = Object.freeze({
  '@firebase/util': false,
  protobufjs: true,
});

export type AllowBuildsEdit =
  | { readonly kind: 'covered' }
  | { readonly kind: 'edited'; readonly content: string; readonly added: readonly string[] }
  | { readonly kind: 'unsupported'; readonly missing: readonly string[] };

const allowBuildsLine = /^allowBuilds:[ \t]*(?:#.*)?$/mu;
// Any top-level spelling of the key, quoted or not, so an unparsed form is
// reported instead of getting a second, duplicate mapping appended.
const allowBuildsKey = /^(?:allowBuilds|'allowBuilds'|"allowBuilds")[ \t]*:/mu;
const entryKey = /^([ \t]+)(?:'((?:[^']|'')*)'|"((?:[^"\\]|\\.)*)"|([^\s#'"-][^:#]*?))[ \t]*:[ \t]*[^\s#]/u;

/** The package a matcher names: `name`, `name@range`, `@scope/name@range`, or `name@git-url`. */
export function allowBuildsPackageName(matcher: string): string {
  const trimmed = matcher.trim();
  const versionAt = trimmed.indexOf('@', trimmed.startsWith('@') ? 1 : 0);
  return versionAt === -1 ? trimmed : trimmed.slice(0, versionAt);
}

function quoteKey(name: string): string {
  return /^[a-z0-9][a-z0-9._-]*$/u.test(name) ? name : `'${name.replaceAll("'", "''")}'`;
}

/**
 * Adds an explicit decision for each package in `approvals` that the
 * `pnpm-workspace.yaml` content does not list yet, keeping every existing
 * entry (a game's own decision wins). Only the block-mapping form the game
 * template writes is edited; another form is reported as unsupported so the
 * caller can print the entries instead of rewriting YAML it cannot parse.
 */
export function addAllowBuilds(
  content: string,
  approvals: Readonly<Record<string, boolean>>,
): AllowBuildsEdit {
  if (/^dangerouslyAllowAllBuilds:[ \t]*true\b/mu.test(content)
    || /^strictDepBuilds:[ \t]*false\b/mu.test(content)) {
    return { kind: 'covered' };
  }
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/u);
  const header = lines.findIndex((line) => allowBuildsLine.test(line));
  // A bare name reviews every version; a qualified matcher (`name@1.2.3`,
  // `name@git+…`) reviews only what it names, which may not be what the
  // starter's firebase brings.
  const listed = new Set<string>();
  const qualified = new Set<string>();
  let indent = '  ';
  if (header !== -1) {
    let indentSeen = false;
    for (let index = header + 1; index < lines.length; index += 1) {
      const line = lines[index] ?? '';
      if (line.trim() === '' || /^[ \t]*#/u.test(line)) {
        continue;
      }
      if (!/^[ \t]/u.test(line)) {
        break;
      }
      // Only one-line `key: value` entries at one indentation are read; a
      // sequence item, a value on the next line, or a nested key would make
      // the scan miss an entry and the edit add a duplicate key.
      const match = entryKey.exec(line);
      if (match === null || (indentSeen && match[1] !== indent)) {
        return { kind: 'unsupported', missing: Object.keys(approvals) };
      }
      // A merge key (`<<: *decisions`), an anchor, an alias or a tag brings
      // entries the line scan cannot see, so an inserted entry could override
      // an inherited decision.
      if (/^(?:<<|[&*!])/u.test(match[4] ?? '') || /[&*!]$/u.test(match[0])) {
        return { kind: 'unsupported', missing: Object.keys(approvals) };
      }
      if (!indentSeen) {
        indent = match[1] ?? indent;
        indentSeen = true;
      }
      const key = match[2]?.replaceAll("''", "'") ?? match[3] ?? match[4] ?? '';
      const name = allowBuildsPackageName(key);
      (name === key.trim() ? listed : qualified).add(name);
    }
  } else if (allowBuildsKey.test(content)) {
    return { kind: 'unsupported', missing: Object.keys(approvals) };
  }
  const missing = Object.keys(approvals).filter((name) => !listed.has(name)).sort();
  if (missing.length === 0) {
    return { kind: 'covered' };
  }
  if (missing.some((name) => qualified.has(name))) {
    // A bare entry would override the game's version-specific decision.
    return { kind: 'unsupported', missing };
  }
  const entries = missing.map((name) => `${indent}${quoteKey(name)}: ${String(approvals[name])}`);
  if (header !== -1) {
    lines.splice(header + 1, 0, ...entries);
  } else {
    while (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }
    lines.push('allowBuilds:', ...entries, '');
  }
  const edited = lines.join(newline);
  return {
    kind: 'edited',
    content: edited.endsWith(newline) ? edited : `${edited}${newline}`,
    added: missing,
  };
}

/** The `allowBuilds` block to print when the caller cannot edit the file itself. */
export function allowBuildsSnippet(approvals: Readonly<Record<string, boolean>>): string {
  return [
    'allowBuilds:',
    ...Object.keys(approvals).sort().map((name) => `  ${quoteKey(name)}: ${String(approvals[name])}`),
  ].join('\n');
}

/**
 * The `pnpm-workspace.yaml` edit a notifications game needs before its
 * install adds `firebase`: the new content when the file can be edited, or a
 * warning with the entries to add when it cannot (no file at the game root,
 * where a parent workspace may govern the install, or a form this edit does
 * not parse).
 */
export function planNotificationsBuildApprovals(
  workspace: string | undefined,
): { readonly content?: string; readonly warning?: string } {
  const instruction = 'pnpm 11 stops installing firebase until the pnpm-workspace.yaml that '
    + `installs the game lists its build scripts:\n${allowBuildsSnippet(notificationsBuildApprovals)}`;
  if (workspace === undefined) {
    return { warning: `The game has no pnpm-workspace.yaml; ${instruction}` };
  }
  const edit = addAllowBuilds(workspace, notificationsBuildApprovals);
  if (edit.kind === 'edited') {
    return { content: edit.content };
  }
  if (edit.kind === 'unsupported') {
    return {
      warning: 'pnpm-workspace.yaml writes allowBuilds in a form the initializer does not edit '
        + '(a quoted key, a flow mapping, or a version-specific entry for one of these packages); '
        + instruction,
    };
  }
  return {};
}
