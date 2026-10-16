// @ts-check
// Deliberately plain Node: a published-JavaScript consumer must not load Kit's
// TypeScript hooks, workspace aliases, node_modules, or locally built dist.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const registry = 'https://registry.npmjs.org/';

/** @param {string} root @param {string} candidate */
export function isWithin(root, candidate) {
  const part = relative(root, candidate);
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`));
}

/** @param {string} directory */
export function assertOutsideKit(directory) {
  let current = realpathSync(directory);
  while (true) {
    const manifest = join(current, 'package.json');
    if (existsSync(manifest)) {
      assert.notEqual(
        JSON.parse(readFileSync(manifest, 'utf8')).name,
        'mpgd-kit',
        'Consumer cannot inherit an adjacent Kit checkout',
      );
    }
    const parent = dirname(current);
    if (parent === current) {
      return;
    }
    current = parent;
  }
}

/** @param {string} version */
export function exactVersion(version) {
  assert.match(
    version,
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/,
    'Use an exact stable release version',
  );
  return version;
}

/** @param {NodeJS.ProcessEnv} source @param {string} checkout */
export function consumerEnvironment(source, checkout) {
  /** @param {string} path */
  const physical = (path) => existsSync(path) ? realpathSync(path) : resolve(path);
  const checkoutRoot = physical(checkout);
  return Object.fromEntries(Object.entries(source).filter(([key]) =>
    key === 'TTSC_GO_BINARY' || !/^(?:mpgd_|ttsc_|npm_|node_auth_token$|node_options$|node_path$|init_cwd$|pnpm_script_src_dir$)/i.test(key),
  ).map(([key, value]) => [key, key.toLowerCase() === 'path'
    ? value?.split(delimiter).filter((entry) => !isWithin(checkoutRoot, physical(entry))).join(delimiter)
    : value]));
}

/** Reject local package sources, including overrides left by a developer checkout.
 * @param {string} text */
export function assertRegistryOnly(text) {
  assert.doesNotMatch(
    text,
    /(?:workspace:|file:|link:|portal:|patch:|git\+|github:|https?:\/\/(?!registry\.npmjs\.org\/))/i,
    'Consumer dependency metadata must use the public registry only',
  );
}

/** @param {string} name @param {string} version */
async function publishedMetadata(name, version) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const response = await fetch(`${registry}${encodeURIComponent(name)}/${version}`, {
      signal: AbortSignal.timeout(30_000),
    });
    if (response.ok) {
      const metadata = await response.json();
      assert.equal(metadata.name, name);
      assert.equal(metadata.version, version);
      assert.ok(metadata.dist?.integrity, `No npm integrity for ${name}`);
      assert.ok(metadata.dist.tarball.startsWith(registry), 'Unexpected tarball registry');
      return { name, version, integrity: metadata.dist.integrity, tarball: metadata.dist.tarball };
    }
    assert.ok([404, 429, 503].includes(response.status), `npm metadata failed: ${response.status}`);
    if (attempt < 11) {
      await new Promise((done) => setTimeout(done, 10_000));
    }
  }
  throw new Error(`Published package did not become visible: ${name}@${version}`);
}

async function main() {
  const template = process.env.MPGD_PUBLISHED_TEMPLATE ?? 'phaser';
  assert.ok(['phaser', 'lite'].includes(template), 'Unknown template');
  const cliVersion = exactVersion(process.env.MPGD_PUBLISHED_CLI_VERSION
    ?? JSON.parse(readFileSync(join(repoRoot, 'packages/cli/package.json'), 'utf8')).version);
  const createVersion = exactVersion(process.env.MPGD_PUBLISHED_CREATE_VERSION
    ?? JSON.parse(readFileSync(join(repoRoot, 'packages/create-game/package.json'), 'utf8')).version);
  const output = process.env.MPGD_PUBLISHED_ROOT
    ? resolve(process.env.MPGD_PUBLISHED_ROOT)
    : mkdtempSync(join(tmpdir(), 'mpgd-published-'));
  if (process.env.MPGD_PUBLISHED_ROOT) {
    mkdirSync(output); // Never reuse an old consumer.
  }
  assert.ok(
    !isWithin(realpathSync(repoRoot), realpathSync(output)),
    'Consumer must be outside the Kit checkout',
  );
  assertOutsideKit(output);
  const bootstrap = join(output, 'path with spaces', 'bootstrap');
  const game = join(output, 'path with spaces', 'game');
  mkdirSync(bootstrap, { recursive: true });
  const environment = consumerEnvironment(process.env, repoRoot);
  const userConfig = join(output, 'user.npmrc');
  const globalConfig = join(output, 'global.npmrc');
  writeFileSync(userConfig, `registry=${registry}\n`);
  writeFileSync(globalConfig, '');
  environment.npm_config_userconfig = userConfig;
  environment.npm_config_globalconfig = globalConfig;
  environment.npm_config_registry = registry;
  // Windows .cmd files cannot be spawned without a shell. mise installs pnpm.exe.
  const pnpm = process.platform === 'win32'
    ? Object.entries(environment).find(([key]) => key.toLowerCase() === 'path')?.[1]
      ?.split(delimiter).map((entry) => join(entry, 'pnpm.exe')).find(existsSync)
    : 'pnpm';
  assert.ok(pnpm, 'Put the pinned standalone pnpm executable on PATH (mise exec)');
  /** @param {string} command @param {string[]} args @param {string} cwd */
  function run(command, args, cwd) {
    console.info(`${command} ${args.join(' ')} (${cwd})`);
    const child = spawnSync(command, args, {
      cwd,
      env: environment,
      encoding: 'utf8',
      timeout: 900_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    const log = `${command} ${args.join(' ')}\n${child.stdout ?? ''}\n${child.stderr ?? ''}\n`;
    appendFileSync(join(output, 'commands.log'), log);
    assert.ifError(child.error);
    assert.equal(child.status, 0, log);
    return child.stdout;
  }
  const expected = await Promise.all([
    publishedMetadata('@mpgd/cli', cliVersion),
    publishedMetadata('@mpgd/create-game', createVersion),
  ]);
  writeFileSync(join(output, 'requested.json'), JSON.stringify({ template, expected }, null, 2));
  writeFileSync(
    join(bootstrap, 'package.json'),
    JSON.stringify(
      {
        private: true,
        type: 'module',
        packageManager: 'pnpm@11.7.0',
        dependencies: { '@mpgd/cli': cliVersion, '@mpgd/create-game': createVersion },
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(bootstrap, 'pnpm-workspace.yaml'),
    "packages: ['.']\nallowBuilds:\n  esbuild: true\n  sharp: true\n",
  );
  run(pnpm, ['install', '--no-frozen-lockfile'], bootstrap);
  const bootstrapRequire = createRequire(join(bootstrap, 'package.json'));
  const creatorRoot = dirname(dirname(bootstrapRequire.resolve('@mpgd/create-game')));
  const creatorRequire = createRequire(join(creatorRoot, 'package.json'));
  const creatorCliRoot = dirname(dirname(creatorRequire.resolve('@mpgd/cli')));
  assert.equal(
    JSON.parse(readFileSync(join(creatorCliRoot, 'package.json'), 'utf8')).version,
    cliVersion,
  );
  // Launch the installed create-game bin, not Kit's source CLI or pnpm dlx's mutable latest.
  run(
    process.execPath,
    [join(creatorRoot, 'dist/bin.js'), game, '--microsoft-store', '--template', template],
    bootstrap,
  );
  const manifest = JSON.parse(readFileSync(join(game, 'package.json'), 'utf8'));
  for (const key of ['dependencies', 'devDependencies', 'optionalDependencies', 'pnpm']) {
    assertRegistryOnly(JSON.stringify(manifest[key] ?? {}));
  }
  assertRegistryOnly(readFileSync(join(game, 'pnpm-workspace.yaml'), 'utf8'));
  if (template === 'lite') {
    assert.ok(manifest.dependencies['@mpgd/lite-shell']);
    assert.equal(manifest.dependencies.phaser, undefined);
  }
  run(pnpm, ['install', '--no-frozen-lockfile'], game);
  run(pnpm, ['install', '--frozen-lockfile'], game);
  const requireFromGame = createRequire(join(game, 'package.json'));
  const cliRoot = dirname(dirname(requireFromGame.resolve('@mpgd/cli')));
  assert.ok(isWithin(realpathSync(game), realpathSync(cliRoot)), 'CLI resolved outside consumer');
  assert.equal(JSON.parse(readFileSync(join(cliRoot, 'package.json'), 'utf8')).version, cliVersion);
  // pnpm's own generated workspace links for apps/* are valid; external Kit
  // dependency specs and overrides were rejected above before installation.
  const installed = JSON.parse(run(pnpm, ['list', '--depth', '0', '--json'], game));
  for (const group of ['dependencies', 'devDependencies']) {
    for (const dependency of Object.values(installed[0][group] ?? {})) {
      assert.ok(
        isWithin(realpathSync(game), realpathSync(dependency.path)),
        'Dependency resolved outside consumer',
      );
    }
  }
  writeFileSync(join(output, 'installed.json'), JSON.stringify(installed, null, 2));
  copyFileSync(join(game, 'pnpm-lock.yaml'), join(output, 'consumer-lock.yaml'));
  run(pnpm, ['check'], game);
  assert.match(run(pnpm, ['accept', '--help'], game), /mpgd game accept/);
  run(pnpm, ['build'], game);
  assert.ok(existsSync(join(game, 'dist/index.html')));
  const bundle = join(game, 'dist/assets/game.js');
  assert.ok(existsSync(bundle));
  const nativeTools = await import(
    pathToFileURL(requireFromGame.resolve('@mpgd/cli/windows-native-tools')).href
  );
  const native = join(output, 'native');
  mkdirSync(join(native, 'native-tooling'), { recursive: true });
  copyFileSync(
    nativeTools.getMicrosoftStoreNativeAcceptanceModulePath(),
    join(native, 'native-tooling/WindowsMsixAcceptance.psm1'),
  );
  cpSync(
    nativeTools.getMicrosoftStoreNativeHostSourceDirectory(),
    join(native, 'native-tooling/windows-host'),
    { recursive: true },
  );
  const fixture = join(game, '.native-bridge-fixture.mjs');
  copyFileSync(join(repoRoot, 'tools/smoke/windows-native/bridge-fixture.mjs'), fixture);
  // esbuild and the adapter both resolve from the installed public packages.
  const { buildSync } = createRequire(join(cliRoot, 'package.json'))('esbuild');
  buildSync({
    entryPoints: [fixture],
    bundle: true,
    platform: 'browser',
    format: 'esm',
    outfile: join(game, 'dist/native-bridge-fixture.js'),
  });
  const receipt = {
    sourceGitSha: process.env.MPGD_PUBLISHED_SOURCE_SHA ?? process.env.GITHUB_SHA,
    runId: process.env.GITHUB_RUN_ID,
    template,
    platform: process.platform,
    node: process.version,
    dependencyMode: 'public-registry',
    expected,
    gameBundleSha256: createHash('sha256').update(readFileSync(bundle)).digest('hex'),
    checks: [
      'published-create-game',
      'registry-install',
      'frozen-install',
      'typecheck',
      'accept-help',
      'web-build',
    ],
  };
  writeFileSync(join(output, 'result.json'), JSON.stringify(receipt, null, 2));
  copyFileSync(join(output, 'result.json'), join(native, 'published-consumer.json'));
  console.info(`Published ${template} consumer passed: ${output}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
