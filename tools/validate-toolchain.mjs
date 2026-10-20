import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// Published JavaScript, not a TypeScript loader. This check runs under plain
// `node` before the toolchain it validates can be trusted.
import { isMap, isScalar, isSeq, LineCounter, parseDocument } from 'yaml';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoots = ['adapters', 'apps', 'backend', 'examples', 'native-plugins', 'packages'];
const skippedDirectories = new Set([
  '.git', '.cache', 'node_modules', 'dist', 'build', 'coverage', 'artifacts', 'output',
  'release-output', 'release-input',
]);
const exactRelease = /^(\d+)\.(\d+)\.(\d+)$/;
const setupNodeUses = /^actions\/setup-node(?:@[^\s]+)?$/;

/** Check installed-input manifests and shipped templates against the root's exact ttsc pin. */
export function inspectToolchain(root = repositoryRoot) {
  const rootPackage = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const version = rootPackage.devDependencies?.ttsc;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) {
    throw new Error('package.json must declare an exact devDependencies.ttsc version.');
  }

  const files = [join(root, 'package.json')];
  for (const directory of sourceRoots) {
    const path = join(root, directory);
    if (existsSync(path)) collectManifests(path, files);
  }

  const failures = [];
  let declarations = 0;
  for (const path of files) {
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const [name, actual] of Object.entries(manifest[field] ?? {})) {
        if (name !== 'ttsc' && !name.startsWith('@ttsc/')) continue;
        declarations += 1;
        if (actual !== version) {
          failures.push(`${relative(root, path)}: ${field}.${name} is ${actual}; expected ${version}`);
        }
      }
    }
  }

  const workspacePath = join(root, 'pnpm-workspace.yaml');
  if (existsSync(workspacePath)) {
    const workspace = readFileSync(workspacePath, 'utf8');
    for (const match of workspace.matchAll(/^\s*-\s*['"]?((?:@ttsc\/[^@\s'"]+|ttsc))@([^\s'"]+)['"]?\s*$/gm)) {
      if (match[2] !== version) {
        failures.push(`pnpm-workspace.yaml: ${match[1]}@${match[2]} must match ${version}`);
      }
    }
  }

  return { version, manifests: files.length, declarations, failures };
}

/** Keep local mise and CI setup-node on one exact Node release.
 * @param {string} [root] */
export function inspectNodePins(root = repositoryRoot) {
  const failures = [];
  const misePath = join(root, '.mise.toml');
  if (!existsSync(misePath)) {
    failures.push('.mise.toml must pin an exact node version.');
    return { version: undefined, failures };
  }
  const version = readMiseNodePin(readFileSync(misePath, 'utf8'));
  if (version === undefined) {
    failures.push('.mise.toml must pin an exact node version.');
    return { version: undefined, failures };
  }
  const manifestPath = join(root, 'package.json');
  if (existsSync(manifestPath)) {
    const engines = JSON.parse(readFileSync(manifestPath, 'utf8')).engines?.node;
    if (typeof engines !== 'string') {
      failures.push(`package.json engines.node must be a string range that accepts the .mise.toml pin ${version}`);
    } else if (!nodePinSatisfies(version, engines)) {
      failures.push(`package.json engines.node ${engines} does not accept the .mise.toml pin ${version}`);
    }
  }
  const workflowRoot = join(root, '.github/workflows');
  if (existsSync(workflowRoot)) {
    for (const entry of readdirSync(workflowRoot)) {
      if (!entry.endsWith('.yml') && !entry.endsWith('.yaml')) continue;
      inspectWorkflowNodePins(entry, readFileSync(join(workflowRoot, entry), 'utf8'), version, failures);
    }
  }
  return { version, failures };
}

/** `semver` is not a root dependency, and this bootstrap cannot take a loader.
 * Evaluate the ranges contributors actually declare. A version-shaped range this
 * checker cannot reduce is accepted, so a valid engine declaration is not rejected
 * just because its spelling is unfamiliar. Garbage is still a failure.
 * @param {string} pin @param {string} range */
function nodePinSatisfies(pin, range) {
  const actual = exactRelease.exec(pin);
  if (actual === null) return false;
  const version = [Number(actual[1]), Number(actual[2]), Number(actual[3])];
  const parsed = parseNodeRange(range);
  if (parsed === 'invalid') return false;
  if (parsed === 'accept') return true;
  return parsed.some((set) => set.every((comparator) => comparatorMatches(version, comparator)));
}

/** @param {string} range @returns {Array<Array<{ op: string, v: number[], pre?: string }>> | 'invalid' | 'accept'} */
function parseNodeRange(range) {
  const trimmed = range.trim();
  if (trimmed === '' || trimmed === '*' || trimmed === 'x' || trimmed === 'X') return [[]];
  const sets = [];
  for (const alternative of trimmed.split(/\s*\|\|\s*/)) {
    if (alternative.trim() === '') {
      sets.push([]);
      continue;
    }
    const set = parseComparatorSet(expandHyphens(alternative));
    if (set === 'invalid' || set === 'accept') return set;
    sets.push(set);
  }
  return sets;
}

/** @param {string} text */
function expandHyphens(text) {
  return text.replace(
    /(^|\s)(v?(?:\d+|[xX*])(?:\.(?:\d+|[xX*])){0,2}(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?)\s+-\s+(v?(?:\d+|[xX*])(?:\.(?:\d+|[xX*])){0,2}(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?)(?=\s|$)/g,
    (_match, lead, left, right) => {
      const expanded = hyphenComparators(left, right);
      return expanded === undefined ? `${lead}${left} - ${right}` : `${lead}${expanded}`;
    },
  );
}

/** @param {string} leftRaw @param {string} rightRaw */
function hyphenComparators(leftRaw, rightRaw) {
  const left = parseVersionToken(leftRaw);
  const right = parseVersionToken(rightRaw);
  if (left === null || left === 'invalid-order' || right === null || right === 'invalid-order') return undefined;
  const lower = `>=${left.major ?? 0}.${left.minor ?? 0}.${left.patch ?? 0}${left.prerelease ? `-${left.prerelease}` : ''}`;
  if (right.wildMajor) return lower;
  if (right.minor === undefined || right.wildMinor) return `${lower} <${(right.major ?? 0) + 1}.0.0`;
  if (right.patch === undefined || right.wildPatch) return `${lower} <${right.major}.${right.minor + 1}.0`;
  return `${lower} <=${right.major}.${right.minor}.${right.patch}`;
}

/** @param {string} text @returns {Array<{ op: string, v: number[], pre?: string }> | 'invalid' | 'accept'} */
function parseComparatorSet(text) {
  const raw = text.trim().split(/\s+/);
  const tokens = [];
  for (let index = 0; index < raw.length; index++) {
    const token = raw[index] ?? '';
    if (/^(>=|<=|>|<|=)$/.test(token) && index + 1 < raw.length) {
      tokens.push(`${token}${raw[index + 1]}`);
      index += 1;
      continue;
    }
    tokens.push(token);
  }
  const comparators = [];
  for (const token of tokens) {
    if (token === '-') return 'accept';
    const expanded = parseOneComparator(token);
    if (expanded === 'invalid' || expanded === 'accept') return expanded;
    comparators.push(...expanded);
  }
  return comparators;
}

/** @param {string} token */
function parseOneComparator(token) {
  const match = /^(>=|<=|>|<|=|\^|~>|~)?([\s\S]*)$/.exec(token);
  if (match === null) return 'invalid';
  const operator = match[1] ?? '';
  const rest = match[2] ?? '';
  if (rest === '') return 'invalid';
  const parsed = parseVersionToken(rest);
  if (parsed === 'invalid-order') return 'invalid';
  if (parsed === null) {
    return /^(?:>=|<=|>|<|=|\^|~>|~)?v?(?:\d+|[xX*])(?:\.(?:\d+|[xX*])){0,2}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(token)
      ? 'accept'
      : 'invalid';
  }
  if (operator === '^') return expandCaret(parsed);
  if (operator === '~' || operator === '~>') return expandTilde(parsed);
  if (operator === '' || operator === '=') return expandBare(parsed);
  return expandInequality(operator, parsed);
}

/** @param {string} raw */
function parseVersionToken(raw) {
  const match = /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z][0-9A-Za-z.-]*))?(?:\+[0-9A-Za-z.-]+)?$/.exec(raw);
  if (match === null) return null;
  const part = (value) => {
    if (value === undefined) return undefined;
    return /^[xX*]$/.test(value) ? 'x' : Number(value);
  };
  const major = part(match[1]);
  const minor = part(match[2]);
  const patch = part(match[3]);
  if ((major === 'x' && minor !== undefined && minor !== 'x') || (minor === 'x' && patch !== undefined && patch !== 'x')) {
    return 'invalid-order';
  }
  return {
    wildMajor: major === 'x',
    major: major === 'x' ? undefined : major,
    wildMinor: minor === 'x',
    minor: minor === 'x' ? undefined : minor,
    wildPatch: patch === 'x',
    patch: patch === 'x' ? undefined : patch,
    prerelease: match[4],
  };
}

/** @param {{ major?: number, minor?: number, patch?: number, wildMajor: boolean, wildMinor: boolean, wildPatch: boolean, prerelease?: string }} ver */
function expandBare(ver) {
  if (ver.wildMajor) return [];
  const major = ver.major ?? 0;
  if (ver.minor === undefined || ver.wildMinor) return [atLeast(major, 0, 0), below(major + 1, 0, 0)];
  if (ver.patch === undefined || ver.wildPatch) return [atLeast(major, ver.minor, 0), below(major, ver.minor + 1, 0)];
  return [{ op: '=', v: [major, ver.minor, ver.patch], pre: ver.prerelease }];
}

/** @param {{ major?: number, minor?: number, patch?: number, wildMajor: boolean, wildMinor: boolean, wildPatch: boolean, prerelease?: string }} ver */
function expandCaret(ver) {
  if (ver.wildMajor) return [];
  const major = ver.major ?? 0;
  if (ver.minor === undefined || ver.wildMinor) return [atLeast(major, 0, 0), below(major + 1, 0, 0)];
  if (ver.patch === undefined || ver.wildPatch) {
    return major === 0
      ? [atLeast(0, ver.minor, 0), below(0, ver.minor + 1, 0)]
      : [atLeast(major, ver.minor, 0), below(major + 1, 0, 0)];
  }
  const lower = { op: '>=', v: [major, ver.minor, ver.patch], pre: ver.prerelease };
  if (major === 0) {
    return ver.minor === 0
      ? [lower, below(0, 0, ver.patch + 1)]
      : [lower, below(0, ver.minor + 1, 0)];
  }
  return [lower, below(major + 1, 0, 0)];
}

/** @param {{ major?: number, minor?: number, patch?: number, wildMajor: boolean, wildMinor: boolean, wildPatch: boolean, prerelease?: string }} ver */
function expandTilde(ver) {
  if (ver.wildMajor) return [];
  const major = ver.major ?? 0;
  if (ver.minor === undefined || ver.wildMinor) return [atLeast(major, 0, 0), below(major + 1, 0, 0)];
  const patch = ver.patch === undefined || ver.wildPatch ? 0 : ver.patch;
  return [{ op: '>=', v: [major, ver.minor, patch], pre: ver.prerelease }, below(major, ver.minor + 1, 0)];
}

/** @param {string} operator @param {{ major?: number, minor?: number, patch?: number, wildMajor: boolean, wildMinor: boolean, wildPatch: boolean, prerelease?: string }} ver */
function expandInequality(operator, ver) {
  if (ver.wildMajor) return operator === '>' || operator === '<' ? [below(0, 0, 0)] : [];
  const major = ver.major ?? 0;
  const minorMissing = ver.minor === undefined || ver.wildMinor;
  const patchMissing = minorMissing || ver.patch === undefined || ver.wildPatch;
  if (!patchMissing) return [{ op: operator, v: [major, ver.minor ?? 0, ver.patch ?? 0], pre: ver.prerelease }];
  if (operator === '>') return minorMissing ? [atLeast(major + 1, 0, 0)] : [atLeast(major, (ver.minor ?? 0) + 1, 0)];
  if (operator === '>=') return minorMissing ? [atLeast(major, 0, 0)] : [atLeast(major, ver.minor ?? 0, 0)];
  if (operator === '<=') return minorMissing ? [below(major + 1, 0, 0)] : [below(major, (ver.minor ?? 0) + 1, 0)];
  return minorMissing ? [below(major, 0, 0)] : [below(major, ver.minor ?? 0, 0)];
}

/** @param {number} major @param {number} minor @param {number} patch */
function atLeast(major, minor, patch) {
  return { op: '>=', v: [major, minor, patch] };
}

/** @param {number} major @param {number} minor @param {number} patch */
function below(major, minor, patch) {
  return { op: '<', v: [major, minor, patch] };
}

/** @param {number[]} pin @param {{ op: string, v: number[], pre?: string }} comparator */
function comparatorMatches(pin, comparator) {
  let order = 0;
  for (let index = 0; index < 3; index++) {
    const left = pin[index] ?? 0;
    const right = comparator.v[index] ?? 0;
    if (left !== right) {
      order = left < right ? -1 : 1;
      break;
    }
  }
  if (order === 0 && comparator.pre) order = 1;
  if (comparator.op === '>=') return order >= 0;
  if (comparator.op === '>') return order > 0;
  if (comparator.op === '<=') return order <= 0;
  if (comparator.op === '<') return order < 0;
  return order === 0;
}

/** Require every actions/setup-node step to set node-version to the exact mise pin.
 * The workflow is parsed, so a continued scalar is the value setup-node receives.
 * @param {string} entry @param {string} text @param {string} version @param {string[]} failures */
function inspectWorkflowNodePins(entry, text, version, failures) {
  const lineCounter = new LineCounter();
  const document = parseDocument(text, { lineCounter });
  if (document.errors.length > 0) {
    const error = document.errors[0];
    const line = error?.linePos?.[0]?.line;
    failures.push(`.github/workflows/${entry}${line ? `:${line}` : ''}: cannot parse workflow YAML (${error?.message ?? 'invalid YAML'})`);
    return;
  }
  visitWorkflow(document.contents, (node) => {
    const uses = mapPair(node, 'uses');
    if (uses === undefined || !setupNodeUses.test(scalarText(uses.value) ?? '')) return;
    const usesLine = sourceLine(lineCounter, uses.key);
    const withPair = mapPair(node, 'with');
    const versionPair = withPair !== undefined && isMap(withPair.value) ? mapPair(withPair.value, 'node-version') : undefined;
    if (versionPair === undefined) {
      failures.push(`.github/workflows/${entry}:${usesLine} actions/setup-node omits node-version; expected ${version}`);
      return;
    }
    const raw = displayedNodeVersion(scalarText(versionPair.value));
    if (raw !== version) {
      const at = sourceLine(lineCounter, versionPair.key);
      failures.push(`.github/workflows/${entry}:${at} node-version is ${raw === '' ? 'empty' : raw}; expected ${version}`);
    }
  });
}

/** @param {import('yaml').Node | null | undefined} node @param {(map: import('yaml').YAMLMap) => void} visitMap */
function visitWorkflow(node, visitMap) {
  if (isMap(node)) {
    visitMap(node);
    for (const item of node.items) visitWorkflow(item.value, visitMap);
    return;
  }
  if (isSeq(node)) {
    for (const item of node.items) visitWorkflow(item, visitMap);
  }
}

/** @param {import('yaml').YAMLMap} map @param {string} name */
function mapPair(map, name) {
  for (const item of map.items) {
    if (isScalar(item.key) && item.key.value === name) return item;
  }
  return undefined;
}

/** Folded scalars and aliases resolve through the node value. A non-scalar is not a pin.
 * @param {import('yaml').Node | null | undefined} node */
function scalarText(node) {
  if (node == null) return undefined;
  try {
    const value = node.toJSON();
    if (value == null) return '';
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

/** @param {string | undefined} value */
function displayedNodeVersion(value) {
  return value ?? '';
}

/** @param {LineCounter} lineCounter @param {import('yaml').Node | null | undefined} node */
function sourceLine(lineCounter, node) {
  if (node?.range == null) return 1;
  return lineCounter.linePos(node.range[0]).line;
}

/** Read `node` from the mise `[tools]` table. A matching assignment under `[env]`
 * or inside another value does not count.
 * @param {string} source @returns {string | undefined} */
function readMiseNodePin(source) {
  const reader = createTomlReader(source);
  let table = '';
  /** @type {string | undefined} */
  let version;
  while (!reader.done()) {
    reader.skipWsAndComments();
    if (reader.done()) break;
    if (reader.peek() === '[') {
      const header = reader.readTable();
      if (header === undefined) return undefined;
      table = header;
      continue;
    }
    const key = reader.readKey();
    reader.skipSpaces();
    if (key === undefined || reader.peek() !== '=') return undefined;
    reader.next();
    reader.skipSpaces();
    const value = reader.readValue();
    if (reader.failed || value === undefined) return undefined;
    const pin = toolsNodePin(table, key, value);
    if (pin === null) return undefined;
    if (pin !== undefined) version = pin;
  }
  return reader.failed ? undefined : version;
}

/** @param {string} table @param {string} key @param {unknown} value @returns {string | undefined | null} */
function toolsNodePin(table, key, value) {
  if (table === 'tools' && key === 'node') return exactNodePin(value);
  if (table === '' && key === 'tools.node') return exactNodePin(value);
  if (table === '' && key === 'tools' && isRecord(value) && Object.hasOwn(value, 'node')) return exactNodePin(value.node);
  return undefined;
}

/** @param {unknown} value @returns {string | null} */
function exactNodePin(value) {
  return typeof value === 'string' && exactRelease.test(value) ? value : null;
}

/** @param {unknown} value */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {string} source */
function createTomlReader(source) {
  let index = 0;
  let failed = false;
  const length = source.length;
  const peek = (offset = 0) => source[index + offset] ?? '';
  const next = () => {
    index += 1;
  };
  const startsWith = (text) => source.startsWith(text, index);

  function skipSpaces() {
    while (peek() === ' ' || peek() === '\t') index += 1;
  }

  function skipWsAndComments() {
    while (index < length) {
      const char = peek();
      if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
        index += 1;
        continue;
      }
      if (char === '#') {
        while (index < length && peek() !== '\n') index += 1;
        continue;
      }
      break;
    }
  }

  function fail() {
    failed = true;
    index = length;
  }

  /** @param {boolean} multiline */
  function readBasicString(multiline) {
    const quote = multiline ? '"""' : '"';
    index += quote.length;
    if (multiline && (peek() === '\n' || peek() === '\r')) {
      if (peek() === '\r' && source[index + 1] === '\n') index += 2;
      else index += 1;
    }
    let value = '';
    while (index < length) {
      if (startsWith(quote)) {
        index += quote.length;
        return value;
      }
      const char = peek();
      if (char === '\\') {
        index += 1;
        const escaped = peek();
        if (escaped === '') return fail();
        index += 1;
        if (escaped === '\n' || escaped === '\r') {
          if (escaped === '\r' && peek() === '\n') index += 1;
          while (peek() === ' ' || peek() === '\t' || peek() === '\n' || peek() === '\r') index += 1;
          continue;
        }
        const mapped = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };
        if (Object.hasOwn(mapped, escaped)) {
          value += mapped[escaped];
          continue;
        }
        if (escaped === 'u' || escaped === 'U') {
          const digits = escaped === 'u' ? 4 : 8;
          const hex = source.slice(index, index + digits);
          index += digits;
          const code = Number.parseInt(hex, 16);
          if (!Number.isFinite(code)) return fail();
          value += String.fromCodePoint(code);
          continue;
        }
        value += escaped;
        continue;
      }
      if (!multiline && (char === '\n' || char === '\r')) return fail();
      value += char;
      index += 1;
    }
    return fail();
  }

  /** @param {boolean} multiline */
  function readLiteralString(multiline) {
    const quote = multiline ? "'''" : "'";
    index += quote.length;
    const end = source.indexOf(quote, index);
    if (end < 0) return fail();
    const value = source.slice(index, end);
    index = end + quote.length;
    return value;
  }

  function readString() {
    if (startsWith('"""')) return readBasicString(true);
    if (startsWith("'''")) return readLiteralString(true);
    if (peek() === '"') return readBasicString(false);
    if (peek() === "'") return readLiteralString(false);
    return undefined;
  }

  function readBareKey() {
    const start = index;
    while (/[A-Za-z0-9_-]/.test(peek())) index += 1;
    return index === start ? undefined : source.slice(start, index);
  }

  function readKey() {
    const parts = [];
    while (index < length) {
      skipSpaces();
      const part = peek() === '"' || peek() === "'" ? readString() : readBareKey();
      if (part === undefined || failed) return undefined;
      parts.push(part);
      skipSpaces();
      if (peek() !== '.') break;
      index += 1;
    }
    return parts.length === 0 ? undefined : parts.join('.');
  }

  function readBare() {
    const start = index;
    while (index < length) {
      const char = peek();
      if (char === '\n' || char === '\r' || char === '#' || char === ',' || char === '}' || char === ']') break;
      index += 1;
    }
    return source.slice(start, index).trim();
  }

  function readInlineTable() {
    index += 1;
    /** @type {Record<string, unknown>} */
    const table = {};
    while (index < length && !failed) {
      skipWsAndComments();
      if (peek() === '}') {
        index += 1;
        return table;
      }
      const key = readKey();
      skipSpaces();
      if (key === undefined || peek() !== '=') return fail();
      index += 1;
      skipSpaces();
      const value = readValue();
      if (failed || value === undefined) return undefined;
      table[key] = value;
      skipSpaces();
      if (peek() === ',') {
        index += 1;
        continue;
      }
      skipWsAndComments();
      if (peek() === '}') {
        index += 1;
        return table;
      }
      return fail();
    }
    return fail();
  }

  function skipArray() {
    index += 1;
    while (index < length && !failed) {
      const char = peek();
      if (char === ']') {
        index += 1;
        return;
      }
      if (char === '"' || char === "'") {
        readString();
        continue;
      }
      if (char === '[') {
        skipArray();
        continue;
      }
      if (char === '{') {
        readInlineTable();
        continue;
      }
      index += 1;
    }
    fail();
  }

  function readValue() {
    if (peek() === '"' || peek() === "'") return readString();
    if (peek() === '{') return readInlineTable();
    if (peek() === '[') {
      skipArray();
      return failed ? undefined : { kind: 'array' };
    }
    if (peek() === '' || peek() === '\n' || peek() === '\r' || peek() === '#' || peek() === ',' || peek() === '}') {
      fail();
      return undefined;
    }
    return { kind: 'bare', text: readBare() };
  }

  function readTable() {
    const array = startsWith('[[');
    index += array ? 2 : 1;
    skipSpaces();
    const key = readKey();
    skipSpaces();
    if (array) {
      if (!startsWith(']]')) return fail();
      index += 2;
      return `[[${key ?? ''}]]`;
    }
    if (peek() !== ']') return fail();
    index += 1;
    return key ?? '';
  }

  return {
    get failed() {
      return failed;
    },
    done: () => index >= length || failed,
    peek,
    next,
    skipSpaces,
    skipWsAndComments,
    readKey,
    readValue,
    readTable,
  };
}

function collectManifests(directory, files) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && !skippedDirectories.has(entry.name)) {
      collectManifests(path, files);
    } else if (entry.isFile() && entry.name === 'package.json') {
      files.push(path);
    }
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = inspectToolchain(resolve(process.argv[2] ?? repositoryRoot));
  const nodePins = inspectNodePins(resolve(process.argv[2] ?? repositoryRoot));
  const failures = [...result.failures, ...nodePins.failures];
  if (failures.length > 0) {
    process.stderr.write(`${failures.join('\n')}\n`);
    process.exitCode = 1;
  } else {
    console.log(`ttsc ${result.version}: ${result.declarations} aligned declarations across ${result.manifests} manifests.`);
    console.info(`node ${nodePins.version}: workflow setup-node pins match .mise.toml.`);
  }
}
