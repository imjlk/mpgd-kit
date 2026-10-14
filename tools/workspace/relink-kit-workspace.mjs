import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  describeForeignKitDependencyLinks,
  findForeignKitDependencyLinks,
  isKitDependencyLinkOwnedBy,
  kitPackageGlobs,
} from './kit-dependency-links.mjs';

// Restores kit-owned node_modules links after a --workspace game install
// re-pointed them. `pnpm install --force` alone keeps the foreign links because
// the root lockfile state is already up to date.
const kitRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const checkOnly = process.argv.includes('--check');
const warnIndex = process.argv.indexOf('--warn-unless-owner');

// --warn-unless-owner <dir>: build-target calls this before every build. Links
// owned by the game being built are expected in workspace mode; links owned by
// any other install mean this build may use another game's dependencies.
if (warnIndex !== -1) {
  const owner = realpathSync(process.argv[warnIndex + 1] ?? process.cwd());
  const foreign = findForeignKitDependencyLinks(kitRoot)
    .filter((entry) => !isKitDependencyLinkOwnedBy(entry, owner));
  const message = describeForeignKitDependencyLinks(kitRoot, foreign);
  if (message !== undefined) {
    console.warn(`warning: ${message}`);
  }
  process.exit(0);
}

const warning = describeForeignKitDependencyLinks(kitRoot);

if (checkOnly) {
  if (warning !== undefined) {
    console.error(warning);
    process.exit(1);
  }
  console.info('mpgd-kit: all kit package dependency links resolve inside the kit.');
  process.exit(0);
}

// A generated game's workspace only relinks these shared package groups.
// Apps and examples may contain independent game installs: leave them intact.
for (const group of kitPackageGlobs) {
  const groupDir = join(kitRoot, group);
  if (!existsSync(groupDir)) {
    continue;
  }
  for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      rmSync(join(groupDir, entry.name, 'node_modules'), { recursive: true, force: true });
    }
  }
}
const result = spawnSync('pnpm', ['install', '--frozen-lockfile', '--prefer-offline'], {
  cwd: kitRoot,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
process.exit(result.status ?? 1);
