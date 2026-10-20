import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoots = ['adapters', 'apps', 'backend', 'examples', 'native-plugins', 'packages'];
const skippedDirectories = new Set([
  '.git', '.cache', 'node_modules', 'dist', 'build', 'coverage', 'artifacts', 'output',
  'release-output', 'release-input',
]);

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
  const pin = /^node\s*=\s*"(\d+\.\d+\.\d+)"\s*$/m.exec(readFileSync(misePath, 'utf8'));
  if (pin === null) {
    failures.push('.mise.toml must pin an exact node version.');
    return { version: undefined, failures };
  }
  const version = pin[1];
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
      const lines = readFileSync(join(workflowRoot, entry), 'utf8').split('\n');
      inspectSetupNodePins(entry, lines, version, failures);
    }
  }
  return { version, failures };
}

/** @param {string} pin @param {string} range */
function nodePinSatisfies(pin, range) {
  const minimum = /^>=(\d+)\.(\d+)\.(\d+)$/.exec(range);
  const actual = /^(\d+)\.(\d+)\.(\d+)$/.exec(pin);
  if (minimum === null || actual === null) {
    return false;
  }
  for (let index = 1; index <= 3; index++) {
    const left = Number(actual[index]);
    const right = Number(minimum[index]);
    if (left > right) return true;
    if (left < right) return false;
  }
  return true;
}

/** Require every actions/setup-node step to set node-version to the exact mise pin.
 * A missing key, or a value the line regex cannot see (an expression with whitespace),
 * is a failure. Literal mismatches keep the previous message.
 * @param {string} entry
 * @param {string[]} lines
 * @param {string} version
 * @param {string[]} failures */
function inspectSetupNodePins(entry, lines, version, failures) {
  for (let index = 0; index < lines.length; index++) {
    if (!isSetupNodeUses(lines[index] ?? '')) continue;
    const step = setupNodeStepRange(lines, index);
    const pin = setupNodeVersion(lines, step);
    if (pin === undefined) {
      failures.push(
        `.github/workflows/${entry}:${index + 1} actions/setup-node omits node-version; expected ${version}`,
      );
      continue;
    }
    if (pin.value !== version) {
      failures.push(
        `.github/workflows/${entry}:${pin.line} node-version is ${pin.raw === '' ? 'empty' : pin.raw}; expected ${version}`,
      );
    }
  }
}

/** @param {string} line */
function isSetupNodeUses(line) {
  return /^\s*(?:-\s+)?uses:\s*['"]?actions\/setup-node(?:@[^'"\s#]*)?['"]?\s*(?:#.*)?$/.test(line);
}

/** @param {string[]} lines @param {number} usesIndex */
function setupNodeStepRange(lines, usesIndex) {
  const stepIndent = listItemIndent(lines, usesIndex);
  const usesLine = lines[usesIndex] ?? '';
  const usesIsItem = indentOf(usesLine) === stepIndent && /^\s*-\s+/.test(usesLine);
  let start = usesIndex;
  // Do not walk into the previous step. Its body is indented past the list marker,
  // so a plain indent check would treat that body as part of this step.
  if (!usesIsItem) {
    for (let index = usesIndex - 1; index >= 0; index--) {
      const line = lines[index] ?? '';
      if (isIgnorableWorkflowLine(line)) continue;
      if (indentOf(line) <= stepIndent) {
        start = index;
        break;
      }
      start = index;
    }
  }
  let end = lines.length;
  for (let index = usesIndex + 1; index < lines.length; index++) {
    const line = lines[index] ?? '';
    if (isIgnorableWorkflowLine(line)) continue;
    if (indentOf(line) <= stepIndent) {
      end = index;
      break;
    }
  }
  return { start, end, stepIndent };
}

/** @param {string[]} lines @param {number} usesIndex */
function listItemIndent(lines, usesIndex) {
  const line = lines[usesIndex] ?? '';
  const ownDash = /^(\s*)-\s+/.exec(line);
  if (ownDash !== null) return ownDash[1].length;
  const usesIndent = indentOf(line);
  for (let index = usesIndex - 1; index >= 0; index--) {
    const previous = lines[index] ?? '';
    if (isIgnorableWorkflowLine(previous)) continue;
    const item = /^(\s*)-\s+/.exec(previous);
    if (item !== null && item[1].length < usesIndent) return item[1].length;
    if (indentOf(previous) < usesIndent) break;
  }
  return usesIndent;
}

/** @param {string[]} lines @param {{ start: number, end: number, stepIndent: number }} step */
function setupNodeVersion(lines, step) {
  let withIndent = -1;
  for (let index = step.start; index < step.end; index++) {
    const line = lines[index] ?? '';
    if (isIgnorableWorkflowLine(line)) continue;
    const indent = indentOf(line);
    if (withIndent === -1) {
      if (indent > step.stepIndent && /^\s*with:\s*(?:#.*)?$/.test(line)) withIndent = indent;
      continue;
    }
    if (indent <= withIndent) break;
    const match = /^\s*node-version:\s*(.*)$/.exec(line);
    if (match === null || indent !== withIndent + 2) continue;
    const raw = unquoteYamlScalar(stripYamlComment(match[1] ?? '').trim());
    return { line: index + 1, raw, value: /^\d+\.\d+\.\d+$/.test(raw) ? raw : undefined };
  }
  return undefined;
}

/** @param {string} line */
function isIgnorableWorkflowLine(line) {
  const trimmed = line.trim();
  return trimmed === '' || trimmed.startsWith('#');
}

/** @param {string} line */
function indentOf(line) {
  return /^\s*/.exec(line)?.[0].length ?? 0;
}

/** Keep a `#` inside a quoted scalar. A comment needs leading whitespace, as in YAML.
 * @param {string} value */
function stripYamlComment(value) {
  let quote = '';
  for (let index = 0; index < value.length; index++) {
    const char = value[index] ?? '';
    if (quote !== '') {
      if (char === quote) quote = '';
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === '#' && (index === 0 || value[index - 1] === ' ' || value[index - 1] === '\t')) {
      return value.slice(0, index);
    }
  }
  return value;
}

/** @param {string} value */
function unquoteYamlScalar(value) {
  const quoted = /^(['"])([\s\S]*)\1$/.exec(value);
  return quoted === null ? value : (quoted[2] ?? value);
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
