import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Generates a game with `mpgd game create --providers notifications` for the
// Phaser and lite templates and type-checks what it generated: the game, its
// tools (including `pnpm validate:notifications`), and the Devvit server the
// starter edits. Then it runs the game's validator, which must refuse the
// starter's sender placeholder and pass once a real contact is set.
//
// Nothing is installed from a registry: the game's node_modules links the
// kit's own, and each `@mpgd/*` name links the workspace package, whose built
// dist the type check reads (run `pnpm build:packages` first).

/**
 * The checkout, not the directory of this file: CI's prepared lane runs the
 * compiled entry from its emit root, so the root is the source root the
 * runner names, the working directory (package scripts run from the
 * repository root), or the source tree.
 */
function resolveKitRoot(): string {
  const marker = join('packages', 'cli', 'templates', 'notifications-overlay', 'common');
  const candidates = [
    process.env.MPGD_TOOLS_EMIT_SOURCE_ROOT,
    process.cwd(),
    fileURLToPath(new URL('../..', import.meta.url)),
  ];
  for (const root of candidates) {
    if (root !== undefined && root.length > 0 && existsSync(join(root, marker))) {
      return root;
    }
  }
  throw new Error(`Cannot locate the kit checkout from ${candidates.join(', ')}.`);
}

const kitRoot = resolveKitRoot();
const compiler = join(kitRoot, 'node_modules/ttsc/lib/launcher/ttsc.js');
const runner = join(kitRoot, 'node_modules/ttsc/lib/launcher/ttsx.js');
const cli = join(kitRoot, 'packages/cli/dist/bin.js');
assert.ok(existsSync(cli), 'Build packages before generating the notifications game.');
const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), 'mpgd-notifications-game-')));
const linkType = process.platform === 'win32' ? 'junction' : 'dir';

function run(args: readonly string[], cwd: string): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: 300_000 });
}

function passed(result: SpawnSyncReturns<string>, label: string): SpawnSyncReturns<string> {
  assert.ifError(result.error);
  assert.equal(result.signal, null, `${label}: ${result.stderr}`);
  assert.equal(result.status, 0, `${label}:\n${result.stdout}\n${result.stderr}`);
  return result;
}

/** Every workspace package by its `@mpgd/*` name. */
function workspacePackages(): ReadonlyMap<string, string> {
  const packages = new Map<string, string>();
  for (const group of ['adapters', 'packages', 'native-plugins']) {
    for (const entry of readdirSync(join(kitRoot, group), { withFileTypes: true })) {
      const manifest = join(kitRoot, group, entry.name, 'package.json');
      if (!entry.isDirectory() || !existsSync(manifest)) {
        continue;
      }
      const { name } = JSON.parse(readFileSync(manifest, 'utf8')) as { readonly name?: string };
      if (name?.startsWith('@mpgd/') === true) {
        packages.set(name, join(kitRoot, group, entry.name));
      }
    }
  }
  return packages;
}

/**
 * Links installed dependencies into `directory`/node_modules, package by
 * package (a scope's packages one by one, so several installs can fill one
 * scope; the first install that has a package wins), and each `@mpgd/*` name
 * to its workspace package.
 */
function linkDependencies(directory: string, installs: readonly string[]): void {
  const modules = join(directory, 'node_modules');
  mkdirSync(join(modules, '@mpgd'), { recursive: true });
  const link = (source: string, destination: string): void => {
    if (!existsSync(destination)) {
      symlinkSync(source, destination, linkType);
    }
  };
  for (const installed of installs) {
    // A missing install would surface later as an obscure missing module.
    assert.ok(existsSync(installed), `Install ${installed} first (pnpm install).`);
    for (const entry of readdirSync(installed)) {
      // pnpm's own files (.bin, .pnpm, .modules.yaml) and the workspace's packages are not linked.
      if (entry === '@mpgd' || entry.startsWith('.')) {
        continue;
      }
      if (entry.startsWith('@')) {
        mkdirSync(join(modules, entry), { recursive: true });
        for (const scoped of readdirSync(join(installed, entry))) {
          link(join(installed, entry, scoped), join(modules, entry, scoped));
        }
      } else {
        link(join(installed, entry), join(modules, entry));
      }
    }
  }
  for (const [name, source] of workspacePackages()) {
    link(source, join(modules, name));
  }
}

function typecheck(directory: string, project: string, label: string): void {
  passed(run([compiler, '--noEmit', '-p', project], directory), label);
}

try {
  for (const template of ['phaser', 'lite'] as const) {
    const gameRoot = join(fixtureRoot, `notifications-${template}`);
    passed(
      run(
        [
          cli,
          'game',
          'create',
          gameRoot,
          '--template',
          template,
          '--providers',
          'notifications',
          '--workspace',
          '--kit-path',
          kitRoot,
        ],
        kitRoot,
      ),
      `${template}: game create`,
    );
    for (const file of [
      'notifications/topics.json',
      'notifications/deployment.json',
      'src/platform/notificationSettings.ts',
      'tools/validate-notifications.ts',
    ]) {
      assert.ok(existsSync(join(gameRoot, file)), `${template}: ${file}`);
    }

    // The kit's tools, then the starters' installs (the AIT polyfill the
    // template imports is installed for the lite starter).
    linkDependencies(gameRoot, [
      join(kitRoot, 'node_modules'),
      join(kitRoot, 'examples/phaser-starter/node_modules'),
      join(kitRoot, 'examples/lite-starter/node_modules'),
    ]);
    typecheck(gameRoot, 'tsconfig.json', `${template}: game type check`);
    typecheck(gameRoot, 'tsconfig.tools.json', `${template}: tools type check`);
    // The Devvit server the starter edits (catalog, deployment, scheduler).
    const devvit = join(gameRoot, 'apps/target-devvit');
    linkDependencies(devvit, [join(kitRoot, 'apps/target-devvit/node_modules')]);
    typecheck(devvit, 'tsconfig.json', `${template}: Devvit type check`);

    // `pnpm validate:notifications` refuses the starter's sender placeholder…
    const manifest = JSON.parse(readFileSync(join(gameRoot, 'package.json'), 'utf8')) as {
      readonly scripts?: Readonly<Record<string, string>>;
    };
    const script = 'ttsx --project tsconfig.tools.json tools/validate-notifications.ts';
    assert.equal(
      manifest.scripts?.['validate:notifications'],
      script,
      `${template}: validate script`,
    );
    const validate = [runner, ...script.split(' ').slice(1)];
    const refused = run(validate, gameRoot);
    assert.ifError(refused.error);
    assert.equal(
      refused.status,
      1,
      `${template}: placeholder refused\n${refused.stdout}\n${refused.stderr}`,
    );
    assert.match(refused.stderr, /advertisingSender\.contact placeholder/u);
    // …and passes once the sender has a real contact.
    const deploymentFile = join(gameRoot, 'notifications/deployment.json');
    const deployment = JSON.parse(readFileSync(deploymentFile, 'utf8')) as {
      readonly advertisingSender: Readonly<Record<string, string>>;
    };
    writeFileSync(
      deploymentFile,
      `${JSON.stringify({ ...deployment, advertisingSender: { ...deployment.advertisingSender, contact: '080-1234-5678' } }, null, 2)}\n`,
    );
    const accepted = passed(run(validate, gameRoot), `${template}: validate:notifications`);
    assert.match(accepted.stdout, /Notification topics: \d+; advertising rules: kr\./u);
    console.info(`${template}: notifications game generated, type-checked, and validated.`);
  }
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}
