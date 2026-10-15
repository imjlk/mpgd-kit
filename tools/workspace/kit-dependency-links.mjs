// @ts-check
import { existsSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';

/** @typedef {{ link: string; target: string; installRoot: string; broken?: boolean }} KitDependencyLink */

// Dependency repair must run even when compiler dependency links are broken.
// Keep this Node bootstrap independent of the TypeScript toolchain.

// Kit workspace package roots. A `--workspace` game lists the same globs (with
// a ../mpgd-kit prefix) in its pnpm-workspace.yaml, so `pnpm install` in the
// game rewrites these packages' node_modules links into the game's store.
export const kitPackageGlobs = Object.freeze(['packages', 'adapters', 'native-plugins', 'backend']);

// `pnpm install --force` alone reports "Already up to date" and leaves the
// game-owned links in place, so the fix removes the per-package link folders
// first.
export const kitRelinkCommand = 'pnpm workspace:relink';

/** @param {string} root @param {string} path */
function isInside(root, path) {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

// Only the install root itself owns its store. A nested game can have a
// separate node_modules, and paths on another Windows drive are never owners.
/** @param {Pick<KitDependencyLink, 'installRoot' | 'broken'>} entry @param {string} owner */
export function isKitDependencyLinkOwnedBy(entry, owner) {
  return entry.broken !== true && relative(entry.installRoot, owner) === '';
}

/** The nearest pnpm workspace owns nested games, unless they declare their own.
 * @param {string} gameDirectory
 */
export function findKitBuildInstallRoot(gameDirectory) {
  const gameRoot = realpathSync(gameDirectory);
  let packageRoot;
  for (let directory = gameRoot; ; directory = dirname(directory)) {
    if (existsSync(join(directory, 'pnpm-workspace.yaml'))) {
      return directory;
    }
    if (packageRoot === undefined && existsSync(join(directory, 'package.json'))) {
      packageRoot = directory;
    }
    if (dirname(directory) === directory) {
      return packageRoot ?? gameRoot;
    }
  }
}

/** @param {string} nodeModules @returns {string[]} */
function linkEntries(nodeModules) {
  const out = [];
  for (const entry of readdirSync(nodeModules, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) {
      continue;
    }
    const path = join(nodeModules, entry.name);
    if (entry.name.startsWith('@') && entry.isDirectory()) {
      for (const scoped of readdirSync(path, { withFileTypes: true })) {
        if (scoped.isSymbolicLink()) {
          out.push(join(path, scoped.name));
        }
      }
    } else if (entry.isSymbolicLink()) {
      out.push(path);
    }
  }
  return out;
}

/**
 * Lists dependency install owners, including the Kit store and dangling links.
 * Internal workspace source links do not belong to a dependency store and are
 * intentionally excluded; they are shared by both Kit and game installations.
 * @param {string} kitRoot
 * @returns {KitDependencyLink[]}
 */
export function findKitDependencyLinks(kitRoot) {
  const root = realpathSync(kitRoot);
  /** @type {KitDependencyLink[]} */
  const links = [];
  for (const group of kitPackageGlobs) {
    const groupDir = join(root, group);
    if (!existsSync(groupDir)) {
      continue;
    }
    for (const pkg of readdirSync(groupDir, { withFileTypes: true })) {
      const nodeModules = join(groupDir, pkg.name, 'node_modules');
      if (!pkg.isDirectory() || !existsSync(nodeModules)) {
        continue;
      }
      for (const link of linkEntries(nodeModules)) {
        let target;
        try {
          target = realpathSync(link);
        } catch {
          // A dangling link usually means the owning game moved or was deleted.
          links.push({
            link: relative(root, link),
            target: readlinkSync(link),
            installRoot: '<missing>',
            broken: true,
          });
          continue;
        }
        // Ownership comes from the install that holds the target, not from
        // whether it sits under the kit: a game nested in the kit (for example
        // examples/my-game) has its own node_modules inside the checkout.
        const marker = `${sep}node_modules${sep}`;
        const installRoot = target.includes(marker)
          ? target.slice(0, target.indexOf(marker))
          : target;
        if (!target.includes(marker) && isInside(root, target)) {
          continue;
        }
        links.push({ link: relative(root, link), target, installRoot });
      }
    }
  }
  return links;
}

/** Kit-only checks compare all dependency stores against the Kit install.
 * @param {string} kitRoot
 */
export function findForeignKitDependencyLinks(kitRoot) {
  const owner = realpathSync(kitRoot);
  return findKitDependencyLinks(kitRoot).filter(
    (entry) => !isKitDependencyLinkOwnedBy(entry, owner),
  );
}

/** Describe mismatched install owners; default checks compare against the Kit.
 * @param {string} kitRoot
 * @param {KitDependencyLink[]} [foreign]
 * @param {string} [expectedOwner]
 */
export function describeForeignKitDependencyLinks(kitRoot, foreign = findForeignKitDependencyLinks(
  kitRoot,
), expectedOwner = realpathSync(kitRoot)) {
  const example = foreign[0];
  if (example === undefined) {
    return undefined;
  }
  const kitOwnedBuild = relative(realpathSync(kitRoot), expectedOwner) === '';
  const owners = [...new Set(foreign.map((entry) => entry.installRoot))].sort();
  return [
    `mpgd-kit: ${foreign.length} kit package dependency link(s) are not owned by ${kitOwnedBuild ? 'the kit install' : 'the selected build install'}`,
    `(expected ${expectedOwner}; links point into another install, or are broken),`,
    `into the install of: ${owners.join(', ')}.`,
    "A --workspace game's `pnpm install` re-links kit packages to its own store. Builds run from",
    "that game still work, but kit-only commands (and other games) then use that game's dependencies.",
    ...(kitOwnedBuild ? [] : [
      `Restore selected build links from the kit root with: ${kitRelinkCommand} --owner <workspace-directory>`,
      `Use this workspace directory as the --owner argument: ${expectedOwner}`,
    ]),
    `Restore kit-owned links from the kit root with: ${kitRelinkCommand}`,
    `Example: ${example.link} -> ${example.target}`,
  ].join('\n');
}
