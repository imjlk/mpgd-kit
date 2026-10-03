import { execFileSync, spawn } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { availableParallelism } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';

import { buildSync } from 'esbuild';

import { runInDependencyOrder } from './build-scheduler';
import {
  createInputFingerprints,
  isReusableBuild,
  packageBuildToolchainFiles,
  recordBuild,
  workspaceDependencyNames,
} from './build-fingerprint';
import {
  discoverBuildablePackages,
  sortByWorkspaceDependencies,
  type WorkspacePackage,
} from './workspace';

const cacheDir = join('node_modules', '.cache', 'mpgd-package-build');
const fingerprintDir = join(cacheDir, 'fingerprints');
// build:target passes --reuse-unchanged: a package whose sources, workspace
// dependencies and toolchain match its last build, and whose dist is untouched,
// is not rebuilt. Release builds (build:packages) always rebuild.
// MPGD_REBUILD_PACKAGES=1 forces a full rebuild.
const reuseUnchanged = process.argv.includes('--reuse-unchanged')
  && process.env.MPGD_REBUILD_PACKAGES !== '1';
const requestedPackageNames = process.argv.slice(2).filter((arg) => arg !== '--reuse-unchanged');
const packages = selectBuildablePackages(discoverBuildablePackages(), requestedPackageNames);
const packagePaths = Object.fromEntries(
  packages.map((workspacePackage) => [
    workspacePackage.name,
    [toPosix(relative(cacheDir, join(workspacePackage.dir, 'dist')))],
  ]),
);
const allowedGeneratedSourcePrefixes = [
  'packages/i18n/src/paraglide/',
  'packages/i18n/src/paraglideAdapter.',
] as const;
// Launch the compilers with this Node directly: `pnpm exec` adds about two
// seconds of startup to each of the ~60 compiler runs.
const rootRequire = createRequire(resolve('package.json'));
const ttscLauncher = join(
  dirname(rootRequire.resolve('ttsc/package.json')),
  'lib',
  'launcher',
  'ttsc.js',
);
const tscLauncher = join(dirname(rootRequire.resolve('typescript/package.json')), 'bin', 'tsc');
// Packages build concurrently once the workspace packages they read are built.
// MPGD_PACKAGE_BUILD_CONCURRENCY=1 restores one-at-a-time builds.
const concurrency = packageBuildConcurrency(process.env.MPGD_PACKAGE_BUILD_CONCURRENCY);
const nativeBuilderEntry = join(
  'node_modules',
  '.cache',
  'mpgd-native-build',
  'tools',
  'target',
  'build-target.js',
);

mkdirSync(fingerprintDir, { recursive: true });
const inputFingerprints = createInputFingerprints(discoverBuildablePackages(), {
  toolchainFiles: packageBuildToolchainFiles,
  kitHead: cleanKitHead,
});

// Reuse is decided before any compiler runs: a package's input fingerprint
// covers its sources and its dependencies' fingerprints, never their dists.
const reusedPackages: string[] = [];
const rebuiltPackages: {
  readonly workspacePackage: WorkspacePackage;
  readonly inputFingerprint: string | undefined;
}[] = [];
for (const workspacePackage of sortByWorkspaceDependencies(packages)) {
  if (
    !existsSync(join(workspacePackage.dir, 'src'))
    || !existsSync(join(workspacePackage.dir, 'tsconfig.json'))
  ) {
    throw new Error(`Package is missing src or tsconfig.json: ${workspacePackage.name}`);
  }

  const inputFingerprint = inputFingerprints(workspacePackage.name);
  const distDir = join(workspacePackage.dir, 'dist');
  if (reuseUnchanged && isReusableBuild(fingerprintFile(workspacePackage.name), inputFingerprint, distDir)) {
    reusedPackages.push(workspacePackage.name);
    console.log(`Reused ${workspacePackage.name}`);
  } else {
    rebuiltPackages.push({ workspacePackage, inputFingerprint });
  }
}

// The packaged native builder compiles tools/target against workspace sources
// rather than package dists, so it compiles while the packages build.
const nativeBuilderTask = '@mpgd/cli native builder';
const rebuildsCli = rebuiltPackages.some(({ workspacePackage }) =>
  workspacePackage.name === '@mpgd/cli');
await runInDependencyOrder(
  [
    ...(rebuildsCli ? [{ name: nativeBuilderTask, dependencies: [], build: compileNativeBuilder }] : []),
    ...rebuiltPackages.map(({ workspacePackage, inputFingerprint }) => ({
      name: workspacePackage.name,
      // Dev and peer dependencies count too: Capacitor plugins import types
      // from peer @mpgd packages.
      dependencies: [
        ...workspaceDependencyNames(workspacePackage),
        ...(workspacePackage.name === '@mpgd/cli' ? [nativeBuilderTask] : []),
      ],
      build: () => buildPackage(workspacePackage, inputFingerprint),
    })),
  ],
  concurrency,
  (task) => task.build(),
);

if (reuseUnchanged) {
  console.log(`Reused ${reusedPackages.length} of ${packages.length} unchanged package builds.`);
}

async function buildPackage(
  workspacePackage: WorkspacePackage,
  inputFingerprint: string | undefined,
): Promise<void> {
  const srcDir = join(workspacePackage.dir, 'src');
  const tsconfigPath = join(workspacePackage.dir, 'tsconfig.json');
  const distDir = join(workspacePackage.dir, 'dist');

  rmSync(fingerprintFile(workspacePackage.name), { force: true });
  rmSync(distDir, { force: true, recursive: true });

  const tempConfigPath = join(cacheDir, `${safeFileName(workspacePackage.name)}.json`);
  const tempConfigDir = dirname(tempConfigPath);
  writeFileSync(
    tempConfigPath,
    JSON.stringify(
      {
        extends: toPosix(relative(tempConfigDir, tsconfigPath)),
        compilerOptions: {
          noEmit: false,
          outDir: toPosix(relative(tempConfigDir, distDir)),
          rootDir: toPosix(relative(tempConfigDir, srcDir)),
          declaration: true,
          declarationMap: false,
          emitDeclarationOnly: false,
          sourceMap: false,
          paths: packagePaths,
        },
        include: [toPosix(relative(tempConfigDir, join(srcDir, '**/*.ts')))],
        exclude: [
          toPosix(relative(tempConfigDir, join(srcDir, '**/*.test.ts'))),
          toPosix(relative(tempConfigDir, join(srcDir, '**/*.spec.ts'))),
        ],
      },
      null,
      2,
    ),
  );

  await runNode('ttsc', ttscLauncher, ['-p', tempConfigPath]);
  // Published declarations come from the stock TypeScript printer: ttsc's own
  // declaration emit differs in places (for example `(typeof X)[number]`).
  await runNode('tsc', tscLauncher, ['-p', tempConfigPath, '--emitDeclarationOnly']);
  copySourceRuntimeAssets(srcDir, distDir);
  copyRuntimeAssets(srcDir, distDir);
  formatDeclarationFiles(distDir);
  removeGeneratedSourceSiblings(srcDir);

  assertFile(join(distDir, 'index.js'));
  assertFile(join(distDir, 'index.d.ts'));
  if (workspacePackage.name === '@mpgd/cli') {
    copyFileSync(
      join(srcDir, 'ios-keychain-import.swift'),
      join(distDir, 'ios-keychain-import.swift'),
    );
    buildPlayPublisherAdapter(distDir);
    copyFileSync(join('tools', 'deploy', 'asc-pin.json'), join(distDir, 'asc-pin.json'));
    buildPackagedIosInspection(distDir);
    buildPackagedNativeTarget(workspacePackage, distDir);
  }
  recordBuild(fingerprintFile(workspacePackage.name), inputFingerprint, distDir);
  console.log(`Built ${workspacePackage.name}`);
}

function buildPlayPublisherAdapter(distDir: string): void {
  const output = join(distDir, 'play-sdk-adapter.js');
  const result = buildSync({
    entryPoints: [join('adapters', 'play-publisher', 'src', 'index.ts')],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    metafile: true,
  });
  if (result.metafile.outputs[output] === undefined) {
    throw new Error('Packaged Google Play adapter is missing.');
  }
}

function buildPackagedIosInspection(distDir: string): void {
  const output = join(distDir, 'ios-ipa-inspection.js');
  const result = buildSync({
    entryPoints: [join('tools', 'target', 'native-ios-inspection.ts')],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'esm',
    metafile: true,
  });
  if (result.metafile.outputs[output] === undefined) {
    throw new Error('Packaged iOS IPA inspector is missing.');
  }
}

function compileNativeBuilder(): Promise<void> {
  return runNode('ttsc', ttscLauncher, ['-p', 'tsconfig.native-build-package.json']);
}

function buildPackagedNativeTarget(workspacePackage: WorkspacePackage, distDir: string): void {
  const output = join(distDir, 'native-build-target.js');
  assertFile(nativeBuilderEntry);
  const result = buildSync({
    entryPoints: [nativeBuilderEntry],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    metafile: true,
  });
  const emitted = result.metafile.outputs[output];
  if (emitted === undefined) {
    throw new Error('Native build bundle output is missing from esbuild metadata.');
  }
  for (const imported of emitted.imports) {
    if (!imported.external || imported.path.startsWith('node:')) {
      continue;
    }
    const segments = imported.path.split('/');
    let dependency = segments[0];
    if (imported.path.startsWith('@')) {
      dependency = segments.slice(0, 2).join('/');
    }
    if (dependency === undefined || workspacePackage.packageJson.dependencies?.[dependency] === undefined) {
      throw new Error(`Packaged native builder is missing CLI runtime dependency ${dependency}.`);
    }
  }

  const kitGitSha = execFileSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  if (!/^[0-9a-f]{40}$/u.test(kitGitSha)) {
    throw new Error('Package build requires a full Kit Git SHA.');
  }
  const worktreeStatus = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  const packageVersion = workspacePackage.packageJson.version;
  if (packageVersion === undefined) {
    throw new Error('@mpgd/cli package version is missing.');
  }
  writeFileSync(join(distDir, 'native-build-info.json'), `${JSON.stringify({
    kitGitSha,
    kitDirty: worktreeStatus.length > 0,
    packageVersion,
  }, null, 2)}\n`);
}

function selectBuildablePackages(
  available: readonly WorkspacePackage[],
  requestedNames: readonly string[],
): WorkspacePackage[] {
  if (requestedNames.length === 0) {
    return [...available];
  }

  const byName = new Map(
    available.map((workspacePackage) => [workspacePackage.name, workspacePackage]),
  );
  const selected = new Set<string>();

  for (const name of requestedNames) {
    select(name);
  }

  return available.filter((workspacePackage) => selected.has(workspacePackage.name));

  function select(name: string): void {
    if (selected.has(name)) {
      return;
    }

    const workspacePackage = byName.get(name);

    if (workspacePackage === undefined) {
      throw new Error(`Unknown buildable workspace package: ${name}`);
    }

    selected.add(name);
    for (const [dependency, version] of Object.entries(
      workspacePackage.packageJson.dependencies ?? {},
    )) {
      if (version.startsWith('workspace:') && byName.has(dependency)) {
        select(dependency);
      }
    }
  }
}

function packageBuildConcurrency(value: string | undefined): number {
  if (value === undefined || value === '') {
    return availableParallelism();
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`MPGD_PACKAGE_BUILD_CONCURRENCY must be a positive integer: ${value}`);
  }
  return parsed;
}

// Output is buffered per command so concurrent package builds do not interleave.
function runNode(name: string, launcher: string, args: readonly string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [launcher, ...args], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code, signal) => {
      process.stdout.write(Buffer.concat(stdout));
      process.stderr.write(Buffer.concat(stderr));
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(new Error(`${name} ${args.join(' ')} failed with exit code ${code ?? signal}.`));
    });
  });
}

function assertFile(path: string): void {
  if (!existsSync(path)) {
    throw new Error(`Missing package build artifact: ${path}`);
  }
}

function formatDeclarationFiles(dir: string): void {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);

    if (statSync(path).isDirectory()) {
      formatDeclarationFiles(path);
      continue;
    }

    if (!path.endsWith('.d.ts')) {
      continue;
    }

    const source = readFileSync(path, 'utf8');
    const formatted = `${source
      .replace(/^( +)/gm, (indent) => ' '.repeat(Math.floor(indent.length / 2)))
      .trimEnd()}\n`;

    writeFileSync(path, formatted);
  }
}

function copySourceRuntimeAssets(srcDir: string, distDir: string): void {
  forEachSourceBackedArtifact(srcDir, false, (sourcePath, sourceSibling) => {
    if (existsSync(sourceSibling)) {
      return;
    }

    copyFileSync(sourcePath, join(distDir, basename(sourcePath)));
  });
}

function copyRuntimeAssets(srcDir: string, distDir: string): void {
  const generatedDir = join(srcDir, 'paraglide');

  if (!existsSync(generatedDir)) {
    return;
  }

  copyDir(generatedDir, join(distDir, 'paraglide'));
}

function removeGeneratedSourceSiblings(dir: string): void {
  forEachSourceBackedArtifact(dir, true, (path, sourceSibling) => {
    if (!isAllowedGeneratedSource(path) && existsSync(sourceSibling)) {
      rmSync(path);
    }
  });
}

function forEachSourceBackedArtifact(
  dir: string,
  recursive: boolean,
  callback: (artifactPath: string, sourceSibling: string) => void,
): void {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);

    if (statSync(path).isDirectory()) {
      if (recursive) {
        forEachSourceBackedArtifact(path, recursive, callback);
      }
      continue;
    }

    if (!path.endsWith('.js') && !path.endsWith('.d.ts')) {
      continue;
    }

    const sourceSibling = path.endsWith('.d.ts')
      ? `${path.slice(0, -5)}.ts`
      : `${path.slice(0, -3)}.ts`;

    callback(path, sourceSibling);
  }
}

function isAllowedGeneratedSource(path: string): boolean {
  const normalizedPath = toPosix(path);

  return allowedGeneratedSourcePrefixes.some((prefix) => normalizedPath.startsWith(prefix));
}

function copyDir(sourceDir: string, targetDir: string): void {
  mkdirSync(targetDir, { recursive: true });

  for (const entry of readdirSync(sourceDir)) {
    if (entry === '.gitignore' || entry === '.prettierignore') {
      continue;
    }

    const sourcePath = join(sourceDir, entry);
    const targetPath = join(targetDir, entry);

    if (statSync(sourcePath).isDirectory()) {
      copyDir(sourcePath, targetPath);
      continue;
    }

    copyFileSync(sourcePath, targetPath);
  }
}

function safeFileName(value: string): string {
  return value.replace(/^@/, '').replace(/[^A-Za-z0-9._-]+/g, '-');
}

function toPosix(path: string): string {
  return path.split('\\').join('/');
}

function fingerprintFile(name: string): string {
  return join(fingerprintDir, `${safeFileName(name)}.json`);
}

// @mpgd/cli records the Kit Git SHA and dirty state, so it is only reused from a
// clean checkout at the same HEAD.
function cleanKitHead(): string | undefined {
  try {
    const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (status.length > 0) {
      return undefined;
    }
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}
