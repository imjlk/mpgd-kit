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
  readdirSync,
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

/** Reject every non-registry package spec, including hosted Git shorthand.
 * @param {unknown} dependencies
 * @param {typeof import('npm-package-arg').resolve} parseSpec */
export function assertRegistryOnly(dependencies, parseSpec) {
  assert.ok(dependencies && typeof dependencies === 'object' && !Array.isArray(dependencies));
  for (const [name, spec] of Object.entries(dependencies)) {
    assert.equal(typeof spec, 'string', `Invalid dependency spec for ${name}`);
    const parsed = parseSpec(name, spec);
    assert.equal(
      parsed.registry,
      true,
      `Consumer dependency must use the public registry: ${name}@${spec}`,
    );
  }
}

/** Inspect manifest and pnpm dependency maps without interpreting ordinary
 * workspace globs, build permissions or script strings as package sources.
 * @param {unknown} metadata
 * @param {typeof import('npm-package-arg').resolve} parseSpec */
export function assertConsumerMetadata(metadata, parseSpec) {
  assert.ok(metadata && typeof metadata === 'object' && !Array.isArray(metadata));
  for (const [key, value] of Object.entries(metadata)) {
    if (['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'catalog'].includes(
      key,
    )) {
      assertRegistryOnly(value, parseSpec);
    } else if (key === 'overrides' || key === 'resolutions') {
      assert.ok(value && typeof value === 'object' && !Array.isArray(value));
      // Override selectors can contain parent/range syntax; only their target
      // values are dependency specs.
      for (const spec of Object.values(value)) {
        assertRegistryOnly({ 'consumer-override': spec }, parseSpec);
      }
    } else if (key === 'catalogs') {
      assert.ok(value && typeof value === 'object' && !Array.isArray(value));
      for (const catalog of Object.values(value)) {
        assertRegistryOnly(catalog, parseSpec);
      }
    } else if (key === 'patchedDependencies') {
      assert.deepEqual(value, {}, 'Published consumers must not apply local patches');
    } else if (key === 'pnpm' || key === 'packageExtensions') {
      if (key === 'pnpm') {
        assertConsumerMetadata(value, parseSpec);
      } else {
        assert.ok(value && typeof value === 'object' && !Array.isArray(value));
        for (const extension of Object.values(value)) {
          assertConsumerMetadata(extension, parseSpec);
        }
      }
    }
  }
}

/** Validate the entire freshly generated tree before pnpm installs apps/* too.
 * @param {string} directory
 * @param {typeof import('npm-package-arg').resolve} parseSpec */
export function assertGeneratedManifests(directory, parseSpec) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    assert.ok(!entry.isSymbolicLink(), `Generated consumer contains a source link: ${path}`);
    if (entry.isDirectory()) {
      assert.notEqual(
        entry.name,
        'node_modules',
        'Generated consumer must start without installed dependencies',
      );
      assertGeneratedManifests(path, parseSpec);
    } else if (entry.isFile() && entry.name === 'package.json') {
      assertConsumerMetadata(JSON.parse(readFileSync(path, 'utf8')), parseSpec);
    }
  }
}

const publicationAttempts = 36;
const publicationPauseMs = 10_000;
export const fetch404RetryLimit = 6;

/** @param {string} name */
function registryPackageUrl(name) {
  const escapedName = name.startsWith('@')
    ? `@${encodeURIComponent(name.slice(1))}`
    : encodeURIComponent(name);
  return `${registry}${escapedName}`;
}

/** @returns {Promise<void>} */
function publicationPause() {
  return new Promise((done) => setTimeout(done, publicationPauseMs));
}

/** @param {string} version */
function parseSemver(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (match === null) {
    return undefined;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    text: version,
  };
}

/** Exact pins and caret ranges are what generated games request from npm.
 * @param {string} spec */
export function isAwaitedPackageSpec(spec) {
  return parseSemver(spec) !== undefined
    || /^\^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(spec);
}

/**
 * Highest registry version pnpm selects for an exact pin or caret range.
 * @param {readonly string[]} versions
 * @param {string} spec
 */
export function selectPublishedVersion(versions, spec) {
  const exact = parseSemver(spec);
  if (exact !== undefined) {
    return versions.includes(spec) ? spec : undefined;
  }
  const caret = /^\^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(spec);
  if (caret === null) {
    return undefined;
  }
  const major = Number(caret[1]);
  const minor = Number(caret[2]);
  const patch = Number(caret[3]);
  const matches = versions.flatMap((version) => {
    const parsed = parseSemver(version);
    if (parsed === undefined) {
      return [];
    }
    const inRange = major === 0
      ? parsed.major === 0 && parsed.minor === minor && parsed.patch >= patch
        && (minor !== 0 || parsed.patch === patch)
      : parsed.major === major && (
        parsed.minor > minor || (parsed.minor === minor && parsed.patch >= patch)
      );
    return inRange ? [parsed] : [];
  }).sort((left, right) => left.major - right.major || left.minor - right.minor || left.patch - right.patch);
  return matches.at(-1)?.text;
}

/** @param {string} directory */
export function collectPublishedPackageSpecs(directory) {
  /** @type {Map<string, { name: string; spec: string }>} */
  const specs = new Map();
  walk(directory);
  return [...specs.values()].sort((left, right) =>
    left.name.localeCompare(right.name) || left.spec.localeCompare(right.spec));

  /** @param {string} current */
  function walk(current) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') {
          walk(path);
        }
        continue;
      }
      if (!entry.isFile() || entry.name !== 'package.json') {
        continue;
      }
      const manifest = JSON.parse(readFileSync(path, 'utf8'));
      for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
        const dependencies = manifest[field];
        if (dependencies === null || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
          continue;
        }
        for (const [name, spec] of Object.entries(dependencies)) {
          if (name.startsWith('@mpgd/') && typeof spec === 'string' && isAwaitedPackageSpec(spec)) {
            specs.set(`${name}\0${spec}`, { name, spec });
          }
        }
      }
    }
  }
}

/** @param {string} output */
export function isTransientTarball404(output) {
  return output.includes('ERR_PNPM_FETCH_404');
}

/** @typedef {{ status?: number | null; error?: Error; stdout?: string; stderr?: string; log?: string }} CommandResult */

/**
 * @param {() => CommandResult | Promise<CommandResult>} invoke
 * @param {() => Promise<unknown>} pause
 * @param {number} [limit]
 * @returns {Promise<CommandResult>}
 */
export async function retryTransientTarball404(invoke, pause, limit = fetch404RetryLimit) {
  /** @type {CommandResult | undefined} */
  let last;
  for (let attempt = 0; attempt < limit; attempt++) {
    last = await invoke();
    const output = `${last.stdout ?? ''}\n${last.stderr ?? ''}\n${last.error?.message ?? ''}`;
    if (last.status === 0 && last.error === undefined) {
      return last;
    }
    if (attempt === limit - 1 || !isTransientTarball404(output)) {
      return last;
    }
    console.info(`npm tarball was not fetchable; retrying install (${attempt + 1}/${limit})`);
    await pause();
  }
  throw new Error('Install retry limit must be at least 1.');
}

/**
 * fetch reports DNS/socket failures as TypeError and aborts as named errors.
 * @param {unknown} error
 */
function isTransientRegistryError(error) {
  return error instanceof TypeError
    || (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name));
}

/**
 * @param {string} url
 * @param {typeof fetch} request
 * @param {string} [accept]
 * @param {string} [method]
 * @returns {Promise<Response | undefined>}
 */
async function fetchRegistry(url, request, accept, method = 'GET') {
  try {
    const response = await request(url, {
      method,
      headers: {
        ...(accept === undefined ? {} : { accept }),
        ...(method === 'GET' && accept === undefined ? { range: 'bytes=0-0' } : {}),
      },
      signal: AbortSignal.timeout(30_000),
    });
    return response;
  } catch (error) {
    // fetch reports DNS/socket failures as TypeError and aborts as named errors.
    if (isTransientRegistryError(error)) {
      return undefined;
    }
    throw error;
  }
}

/**
 * Metadata can list dist.tarball before that object exists. Probe the same URL
 * `npm view <pkg>@<ver> dist.tarball` prints: HEAD, then a ranged GET.
 * @param {string} url
 * @param {typeof fetch} request
 */
async function confirmTarball(url, request) {
  if (await probeTarball(url, request, 'HEAD')) {
    return true;
  }
  return probeTarball(url, request, 'GET');
}

/**
 * @param {string} url
 * @param {typeof fetch} request
 * @param {'HEAD' | 'GET'} method
 */
async function probeTarball(url, request, method) {
  const response = await fetchRegistry(url, request, undefined, method);
  if (response === undefined) {
    return false;
  }
  if (response.body !== null) {
    try {
      await response.body.cancel();
    } catch (error) {
      // Disposal can fail with the same socket errors as a metadata body read.
      if (isTransientRegistryError(error)) {
        return false;
      }
      throw error;
    }
  }
  if (response.ok) {
    return true;
  }
  if (method === 'HEAD' && (response.status === 405 || response.status === 501)) {
    return false;
  }
  assert.ok(
    [404, 408, 429].includes(response.status) || response.status >= 500,
    `npm tarball failed: ${response.status}`,
  );
  return false;
}

/** @param {string} name @param {string} version
 * @param {typeof fetch} [request]
 * @param {() => Promise<unknown>} [pause] */
export async function publishedMetadata(
  name,
  version,
  request = fetch,
  pause = publicationPause,
) {
  const packageUrl = registryPackageUrl(name);
  // npm's public metadata cache can lag a successful publish by five minutes,
  // and the tarball CDN can lag the metadata that names dist.tarball.
  for (let attempt = 0; attempt < publicationAttempts; attempt++) {
    // Package managers consume package lists, whose caches can lag the single-
    // version endpoint. Require both full and abbreviated install metadata.
    const versions = await Promise.all(
      ['application/json', 'application/vnd.npm.install-v1+json'].map(async (accept) => {
        const response = await fetchRegistry(packageUrl, request, accept);
        if (response === undefined) {
          return undefined;
        }
        if (!response.ok) {
          assert.ok(
            [404, 408, 429].includes(response.status) || response.status >= 500,
            `npm metadata failed: ${response.status}`,
          );
          return undefined;
        }
        let document;
        try {
          document = await response.json();
        } catch (error) {
          // A socket can close after headers. Metadata assertions below stay fatal.
          if (isTransientRegistryError(error)) {
            return undefined;
          }
          throw error;
        }
        assert.equal(document.name, name);
        const metadata = document.versions?.[version];
        if (metadata === undefined) {
          return undefined;
        }
        assert.equal(metadata.name, name);
        assert.equal(metadata.version, version);
        assert.ok(metadata.dist?.integrity, `No npm integrity for ${name}`);
        assert.ok(metadata.dist.tarball.startsWith(registry), 'Unexpected tarball registry');
        return { name, version, integrity: metadata.dist.integrity, tarball: metadata.dist.tarball };
      }),
    );
    const [full, abbreviated] = versions;
    if (full !== undefined && abbreviated !== undefined) {
      assert.equal(full.integrity, abbreviated.integrity, 'npm metadata integrity differs');
      assert.equal(full.tarball, abbreviated.tarball, 'npm metadata tarball differs');
      if (await confirmTarball(full.tarball, request)) {
        return full;
      }
    }
    if (attempt < publicationAttempts - 1) {
      await pause();
    }
  }
  throw new Error(`Published package did not become visible: ${name}@${version}`);
}

/**
 * @param {readonly { name: string; spec: string }[]} specs
 * @param {typeof fetch} [request]
 * @param {() => Promise<unknown>} [pause]
 */
export async function awaitPublishedPackageSpecs(
  specs,
  request = fetch,
  pause = publicationPause,
) {
  await Promise.all(specs.map((spec) => awaitPublishedSpec(spec.name, spec.spec, request, pause)));
}

/**
 * @param {string} name
 * @param {string} spec
 * @param {typeof fetch} request
 * @param {() => Promise<unknown>} pause
 */
async function awaitPublishedSpec(name, spec, request, pause) {
  if (parseSemver(spec) !== undefined) {
    await publishedMetadata(name, spec, request, pause);
    return;
  }
  if (!isAwaitedPackageSpec(spec)) {
    return;
  }
  for (let attempt = 0; attempt < publicationAttempts; attempt++) {
    const response = await fetchRegistry(registryPackageUrl(name), request, 'application/json');
    if (response !== undefined && !response.ok) {
      assert.ok(
        [404, 408, 429].includes(response.status) || response.status >= 500,
        `npm metadata failed: ${response.status}`,
      );
    }
    let versions;
    if (response?.ok === true) {
      try {
        versions = Object.keys((await response.json()).versions ?? {});
      } catch (error) {
        if (!(error instanceof TypeError
          || (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)))) {
          throw error;
        }
      }
    }
    const selected = versions === undefined ? undefined : selectPublishedVersion(versions, spec);
    if (selected !== undefined) {
      await publishedMetadata(name, selected, request, pause);
      return;
    }
    if (attempt < publicationAttempts - 1) {
      await pause();
    }
  }
  throw new Error(`Published package did not become visible: ${name}@${spec}`);
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
  console.info(`Published consumer evidence: ${output}`);
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
  function spawnLogged(command, args, cwd) {
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
    /** @type {CommandResult} */
    const result = {
      status: child.status,
      stdout: typeof child.stdout === 'string' ? child.stdout : '',
      stderr: typeof child.stderr === 'string' ? child.stderr : '',
      log,
    };
    if (child.error !== undefined) {
      result.error = child.error;
    }
    return result;
  }
  /** @param {CommandResult} result */
  function assertSucceeded(result) {
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.log);
    return result.stdout ?? '';
  }
  /** @param {string} command @param {string[]} args @param {string} cwd */
  function run(command, args, cwd) {
    return assertSucceeded(spawnLogged(command, args, cwd));
  }
  /** @param {string} command @param {string[]} args @param {string} cwd */
  async function runInstall(command, args, cwd) {
    return assertSucceeded(await retryTransientTarball404(
      () => spawnLogged(command, args, cwd),
      publicationPause,
    ));
  }
  const requested = [
    { name: '@mpgd/cli', version: cliVersion },
    { name: '@mpgd/create-game', version: createVersion },
  ];
  writeFileSync(
    join(output, 'requested.json'),
    JSON.stringify({ template, expected: requested }, null, 2),
  );
  const expected = await Promise.all(
    requested.map(({ name, version }) => publishedMetadata(name, version)),
  );
  writeFileSync(join(output, 'requested.json'), JSON.stringify({ template, expected }, null, 2));
  writeFileSync(
    join(bootstrap, 'package.json'),
    JSON.stringify(
      {
        private: true,
        type: 'module',
        packageManager: 'pnpm@11.7.0',
        dependencies: {
          '@mpgd/cli': cliVersion,
          '@mpgd/create-game': createVersion,
          'npm-package-arg': '13.0.2',
          yaml: '2.9.0',
        },
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(bootstrap, 'pnpm-workspace.yaml'),
    "packages: ['.']\nallowBuilds:\n  esbuild: true\n  sharp: true\n",
  );
  await runInstall(pnpm, ['install', '--no-frozen-lockfile'], bootstrap);
  const bootstrapRequire = createRequire(join(bootstrap, 'package.json'));
  /** @type {typeof import('npm-package-arg')} */
  const packageArg = bootstrapRequire('npm-package-arg');
  /** @type {typeof import('yaml')} */
  const yaml = bootstrapRequire('yaml');
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
  assertGeneratedManifests(game, packageArg.resolve);
  assertConsumerMetadata(
    yaml.parse(readFileSync(join(game, 'pnpm-workspace.yaml'), 'utf8')),
    packageArg.resolve,
  );
  if (template === 'lite') {
    assert.ok(manifest.dependencies['@mpgd/lite-shell']);
    assert.equal(manifest.dependencies.phaser, undefined);
  }
  // Direct @mpgd specs can resolve to versions published in the same release.
  // Confirm those tarballs before install; the install retry covers transitive
  // packages whose metadata is visible before the CDN object exists.
  await awaitPublishedPackageSpecs(collectPublishedPackageSpecs(game));
  await runInstall(pnpm, ['install', '--no-frozen-lockfile'], game);
  await runInstall(pnpm, ['install', '--frozen-lockfile'], game);
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
