import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Packs a workspace package together with the runtime dependency closure its
 * manifests declare, so a consumer can `pnpm install --offline` from a fresh
 * store. Workspace packages go through `pnpm pack` (their published form);
 * third-party dependencies are archived from the installed copy the package
 * resolves at runtime, so the closure follows the lockfile rather than a
 * hard-coded list. Optional peers are skipped unless installed as dependencies.
 */
export function createPackedDependencyCloser({ fixture, pnpm = 'pnpm' }) {
  const packages = new Map();
  const edges = new Map();

  function pack(inputDirectory) {
    const directory = realpathSync(inputDirectory);
    const metadata = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
    const id = `${metadata.name}@${metadata.version}`;
    if (packages.has(id)) {
      return packages.get(id);
    }
    let archive;
    if (metadata.name.startsWith('@mpgd/')) {
      const packed = JSON.parse(run(pnpm, [
        'pack', '--json', '--pack-destination', fixture,
      ], directory).stdout);
      assert.equal(typeof packed.filename, 'string');
      archive = resolve(fixture, packed.filename);
    } else {
      archive = join(fixture, `dependency-${packages.size}.tgz`);
      const staging = mkdtempSync(join(fixture, 'dependency-'));
      try {
        cpSync(directory, join(staging, 'package'), { recursive: true, verbatimSymlinks: true });
        run('tar', ['-czf', archive, '-C', staging, 'package'], staging);
      } finally {
        rmSync(staging, { recursive: true, force: true });
      }
    }
    const entry = { name: metadata.name, version: metadata.version, tarball: `file:${archive}` };
    packages.set(id, entry);
    for (const dependency of Object.keys({
      ...metadata.dependencies, ...metadata.optionalDependencies, ...metadata.peerDependencies,
    })) {
      if (
        metadata.peerDependenciesMeta?.[dependency]?.optional
        && !metadata.dependencies?.[dependency]
      ) {
        continue;
      }
      const installed = findInstalledDependency(directory, dependency);
      if (!installed && metadata.optionalDependencies?.[dependency]) {
        continue;
      }
      assert.ok(installed, `Missing installed dependency ${id} > ${dependency}`);
      edges.set(`${id}>${dependency}`, pack(installed).tarball);
    }
    return entry;
  }

  /** pnpm overrides mapping every packed name (and each dependency edge) to its tarball. */
  function overrides() {
    const byName = Map.groupBy(packages.values(), (entry) => entry.name);
    const result = new Map([...byName]
      .filter(([, entries]) => entries.length === 1)
      .map(([name, entries]) => [name, entries[0].tarball]));
    for (const edge of edges) {
      result.set(...edge);
    }
    return result;
  }

  function overridesYaml() {
    return [
      'overrides:',
      ...[...overrides()].map(([name, tarball]) => `  '${name}': ${JSON.stringify(tarball)}`),
    ].join('\n');
  }

  /** The single packed entry for a dependency name, for direct consumer dependencies. */
  function packed(name) {
    const entries = [...packages.values()].filter((entry) => entry.name === name);
    assert.equal(entries.length, 1, `Expected exactly one packed ${name}, found ${entries.length}.`);
    return entries[0];
  }

  return { pack, packed, overrides, overridesYaml };
}

export function findInstalledDependency(from, name) {
  let directory = from;
  while (true) {
    const candidate = join(directory, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) {
      return realpathSync(candidate);
    }
    const parent = dirname(directory);
    if (parent === directory) {
      return undefined;
    }
    directory = parent;
  }
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd, env: { ...process.env, CI: 'false' }, encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.stdout}${result.stderr}`);
  }
  return result;
}
