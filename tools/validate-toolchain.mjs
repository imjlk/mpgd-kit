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
    if (typeof engines === 'string' && !nodePinSatisfies(version, engines)) {
      failures.push(`package.json engines.node ${engines} does not accept the .mise.toml pin ${version}`);
    }
  }
  const workflowRoot = join(root, '.github/workflows');
  if (existsSync(workflowRoot)) {
    for (const entry of readdirSync(workflowRoot)) {
      if (!entry.endsWith('.yml') && !entry.endsWith('.yaml')) continue;
      const lines = readFileSync(join(workflowRoot, entry), 'utf8').split('\n');
      for (let index = 0; index < lines.length; index++) {
        const match = /^\s*node-version:\s*['"]?([^'"\s#]+)['"]?\s*(?:#.*)?$/.exec(lines[index] ?? '');
        if (match !== null && match[1] !== version) {
          failures.push(`.github/workflows/${entry}:${index + 1} node-version is ${match[1]}; expected ${version}`);
        }
      }
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
