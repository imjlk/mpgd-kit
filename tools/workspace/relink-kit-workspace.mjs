// @ts-check
// Repair runs before compiler dependencies are usable; keep this entry in Node.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  describeForeignKitDependencyLinks,
  findKitBuildInstallRoot,
  findKitDependencyLinks,
  isKitDependencyLinkOwnedBy,
  kitPackageGlobs,
} from './kit-dependency-links.mjs';

// Restores kit-owned node_modules links after a --workspace game install
// re-pointed them. `pnpm install --force` alone keeps the foreign links because
// the root lockfile state is already up to date.
const kitRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const checkOnly = process.argv.includes('--check');
const warnIndex = process.argv.indexOf('--warn-unless-owner');
const ownerIndex = process.argv.indexOf('--owner');
const ownerArgument = process.argv[ownerIndex + 1];
if (ownerIndex !== -1 && (ownerArgument === undefined || ownerArgument.startsWith('--'))) {
  throw new Error('--owner requires a game or workspace directory.');
}
const installRoot = ownerIndex === -1 ? kitRoot : findKitBuildInstallRoot(ownerArgument ?? kitRoot);

// --warn-unless-owner <dir>: build-target calls this before every build. Links
// owned by the game being built are expected in workspace mode; links owned by
// any other install mean this build may use another game's dependencies.
if (warnIndex !== -1) {
  const candidate = findKitBuildInstallRoot(process.argv[warnIndex + 1] ?? process.cwd());
  // Standalone games consume published packages and do not own Kit links.
  const owner = candidate === realpathSync.native(kitRoot) || includesKitPackages(workspacePackagePaths(candidate))
    ? candidate
    : realpathSync.native(kitRoot);
  const foreign = findKitDependencyLinks(kitRoot)
    .filter((entry) => !isKitDependencyLinkOwnedBy(entry, owner));
  const message = describeForeignKitDependencyLinks(kitRoot, foreign, owner);
  if (message !== undefined) {
    console.warn(`warning: ${message}`);
  }
  process.exit(0);
}

const warning = describeForeignKitDependencyLinks(
  kitRoot,
  findKitDependencyLinks(kitRoot).filter((entry) => !isKitDependencyLinkOwnedBy(entry, installRoot)),
  installRoot,
);

if (checkOnly) {
  if (warning !== undefined) {
    console.error(warning);
    process.exit(1);
  }
  console.info(`mpgd-kit: all kit package dependency links are owned by ${installRoot}.`);
  process.exit(0);
}

// A nested independent game may match the root's workspace globs but not its
// frozen lockfile. Check installation first so a failure cannot leave all kit
// packages without dependency links. Skip lifecycle scripts during this pass.
/** @type {Set<string> | undefined} */
let workspacePackages;
if (ownerIndex !== -1) {
  workspacePackages = workspacePackagePaths(installRoot);
  if (!includesKitPackages(workspacePackages)) {
    throw new Error(
      'The selected workspace does not include Kit packages; no dependency links were removed.',
    );
  }
}
const preflight = install(['--ignore-scripts']);
if (preflight.status !== 0) {
  console.error(
    'mpgd-kit: frozen install preflight failed; no dependency link folders were removed.',
  );
  process.exit(preflight.status ?? 1);
}

// A generated game's workspace only relinks these shared package groups.
// Apps and examples may contain independent game installs: leave them intact.
for (const group of kitPackageGlobs) {
  const groupDir = join(kitRoot, group);
  if (!existsSync(groupDir)) {
    continue;
  }
  for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
    if (entry.isDirectory() && (workspacePackages === undefined || workspacePackages.has(realpathSync.native(join(groupDir, entry.name))))) {
      rmSync(join(groupDir, entry.name, 'node_modules'), { recursive: true, force: true });
    }
  }
}
const result = install([]);
process.exit(result.status ?? 1);

/** @param {readonly string[]} extraArgs */
function install(extraArgs) {
  return spawnSync('pnpm', ['install', '--frozen-lockfile', '--prefer-offline', ...extraArgs], {
    cwd: installRoot,
    env: workspaceEnvironment(),
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
}

/** @param {string} owner @returns {Set<string>} */
function workspacePackagePaths(owner) {
  const listing = spawnSync('pnpm', ['list', '--recursive', '--depth', '-1', '--json'], {
    cwd: owner,
    env: workspaceEnvironment(),
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (listing.status !== 0) {
    throw new Error('Could not list the selected workspace; no dependency links were removed.');
  }
  /** @type {unknown} */
  const packages = JSON.parse(listing.stdout);
  if (!Array.isArray(packages)) {
    throw new Error('Invalid workspace package listing; no dependency links were removed.');
  }
  return new Set(
    packages.map((pkg) => {
      if (typeof pkg?.path !== 'string') {
        throw new Error('Invalid workspace package path; no dependency links were removed.');
      }
      return realpathSync.native(pkg.path);
    }),
  );
}

/** @param {Set<string>} packages */
function includesKitPackages(packages) {
  return [...packages].some((directory) => {
    const parts = relative(realpathSync.native(kitRoot), directory).split(sep);
    return parts.length === 2 && parts[0] !== undefined && kitPackageGlobs.includes(parts[0]);
  });
}

// pnpm lifecycle environments can pin their caller's workspace even when cwd
// changes. Resolve the selected owner from its own directory for list/install.
function workspaceEnvironment() {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.toLowerCase() === 'npm_config_workspace_dir') {
      delete environment[key];
    }
  }
  return environment;
}
