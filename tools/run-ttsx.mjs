import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const toolsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(toolsDir);
const rootRequire = createRequire(join(repoRoot, 'package.json'));
const typescriptPackageJson = rootRequire.resolve('typescript/package.json');
const typescriptRequire = createRequire(typescriptPackageJson);
const platformPackage = `@typescript/typescript-${process.platform}-${process.arch}`;
const platformPackageJson = typescriptRequire.resolve(`${platformPackage}/package.json`);
const platformRoot = dirname(platformPackageJson);
const tsgoBinary = join(platformRoot, 'lib', process.platform === 'win32' ? 'tsc.exe' : 'tsc');
const ttscPackageJson = rootRequire.resolve('ttsc/package.json');
const ttscLauncher = join(dirname(ttscPackageJson), 'lib', 'launcher', 'ttsc.js');
const ttsxLauncher = join(dirname(ttscPackageJson), 'lib', 'launcher', 'ttsx.js');
const userArgs = process.argv.slice(2);
const { project, passthroughArgs, cliArgv, compileOnce } = parseRunnerArgs(userArgs);
const entry = passthroughArgs[0];
const sourceEntry = entry === undefined ? undefined : resolve(process.cwd(), entry);
const relativeEntry = sourceEntry === undefined ? undefined : relative(repoRoot, sourceEntry);
const toolsEntry = resolve(process.cwd(), project) === join(repoRoot, 'tsconfig.tools.json')
  && relativeEntry !== undefined
  && !relativeEntry.startsWith('..')
  && !isAbsolute(relativeEntry)
  && relativeEntry.endsWith('.ts');
const forceTtsx = process.env.MPGD_FORCE_TTSX === '1';
if (!existsSync(tsgoBinary)) {
  throw new Error(`TypeScript-Go binary not found: ${tsgoBinary}`);
}
const inheritedEmitRoot = readInheritedEmitRoot(compileOnce);
// --compile-once type-checks and emits the tools program a single time for a
// command tree (for example build:target and the validators it spawns) instead
// of once per ttsx process. Nested runners inherit the emit through the env.
const ownedEmitRoot = compileOnce && toolsEntry && !forceTtsx && inheritedEmitRoot === undefined
  ? emitToolsProgram()
  : undefined;
const emittedRoot = ownedEmitRoot ?? inheritedEmitRoot;
const emittedEntry = emittedRoot && relativeEntry && join(emittedRoot, relativeEntry.replace(/\.ts$/, '.js'));
const useCompiled = !forceTtsx
  && toolsEntry
  && emittedEntry !== undefined
  && existsSync(emittedEntry);

// ttsx owns its emitted files under its execution cache. Authored .js/.d.ts
// siblings are valid inputs and must not be deleted by a repository-wide scan.
const startedAt = process.hrtime.bigint();
const result = spawnSync(process.execPath, useCompiled
  ? [join(toolsDir, 'ci', 'run-compiled.mjs'), sourceEntry, ...passthroughArgs.slice(1)]
  : [ttsxLauncher, '--cwd', process.cwd(), '--project', project, ...passthroughArgs], {
  stdio: 'inherit',
  env: {
    ...process.env,
    TTSC_TSGO_BINARY: tsgoBinary,
    ...(ownedEmitRoot === undefined
      ? {}
      : { MPGD_CI_EMIT_ROOT: ownedEmitRoot, MPGD_TOOLS_EMIT_SOURCE_ROOT: repoRoot }),
    ...(cliArgv === undefined ? {} : { MPGD_CLI_ARGV: JSON.stringify(cliArgv) }),
  },
});

const exitCode = result.status ?? 1;
recordTiming(useCompiled ? 'compiled' : 'ttsx', passthroughArgs[0] ?? '<none>', startedAt, exitCode);
if (result.error !== undefined) {
  throw result.error;
}

process.exit(exitCode);

function readInheritedEmitRoot(requireSourceRoot) {
  const emitRoot = process.env.MPGD_CI_EMIT_ROOT;

  if (emitRoot === undefined || emitRoot.length === 0) {
    return undefined;
  }

  // A --compile-once emit belongs to the checkout that produced it. A nested
  // command from another kit checkout must compile its own sources.
  const sourceRoot = process.env.MPGD_TOOLS_EMIT_SOURCE_ROOT;
  const hasSourceRoot = sourceRoot !== undefined && sourceRoot.length !== 0;
  if (hasSourceRoot && !sameRealPath(sourceRoot, repoRoot)) {
    return undefined;
  }

  // CI's prepared emit (no source marker) stays reusable by plain runners, but a
  // --compile-once command only trusts an emit that names this checkout.
  if (requireSourceRoot && !hasSourceRoot) {
    return undefined;
  }

  return resolve(process.cwd(), emitRoot);
}

// Command-scoped emits live under this checkout's cache, named by the owning
// runner's pid. Normal exits remove their own; a runner killed by a signal
// leaves one behind, which the next --compile-once command prunes.
function createEmitDirectory() {
  const parent = join(repoRoot, 'node_modules', '.cache', 'mpgd-tools-emit');
  mkdirSync(parent, { recursive: true });
  for (const entry of readdirSync(parent)) {
    const ownerPid = Number.parseInt(entry, 10);
    if (Number.isSafeInteger(ownerPid) && ownerPid !== process.pid && !isProcessAlive(ownerPid)) {
      rmSync(join(parent, entry), { recursive: true, force: true });
    }
  }
  const dir = mkdtempSync(join(parent, `${process.pid}-`));
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function emitToolsProgram() {
  const emitStartedAt = process.hrtime.bigint();
  const outDir = createEmitDirectory();
  // Same program and plugins as CI's ci:emit-tools:prepared; diagnostics are
  // reproduced by the ttsx fallback below, so keep the successful emit quiet.
  const emit = spawnSync(process.execPath, [
    ttscLauncher,
    '-p',
    join(repoRoot, 'tsconfig.ci-tools.json'),
    '--outDir',
    outDir,
  ], {
    cwd: repoRoot,
    stdio: 'ignore',
    env: { ...process.env, TTSC_TSGO_BINARY: tsgoBinary },
  });
  const exitCode = emit.status ?? 1;
  recordTiming('emit', 'tsconfig.ci-tools.json', emitStartedAt, exitCode);

  if (emit.error === undefined && exitCode === 0) {
    return outDir;
  }

  rmSync(outDir, { recursive: true, force: true });
  console.warn('Could not compile the tools program once; falling back to ttsx for this command.');
  return undefined;
}

function sameRealPath(left, right) {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
}

function recordTiming(mode, label, since, exitCode) {
  if (!process.env.GITHUB_STEP_SUMMARY) {
    return;
  }

  try {
    const seconds = Number(process.hrtime.bigint() - since) / 1e9;
    const summaryPath = process.env.GITHUB_STEP_SUMMARY;
    const title = '### TypeScript invocation timings';
    const previous = existsSync(summaryPath) ? readFileSync(summaryPath, 'utf8') : '';
    if (!previous.includes(title)) {
      appendFileSync(summaryPath, `${title}\n\n| Mode | Project | Entry | Seconds | Exit |\n| --- | --- | --- | ---: | ---: |\n`);
    }
    const safeProject = project.replaceAll('|', '\\|').replaceAll('`', "'");
    const safeEntry = label.replaceAll('|', '\\|').replaceAll('`', "'");
    appendFileSync(summaryPath, `| ${mode} | \`${safeProject}\` | \`${safeEntry}\` | ${seconds.toFixed(1)} | ${exitCode} |\n`);
  } catch (error) {
    // Reporting must never turn a passing test into a CI failure.
    console.warn(`Could not write ttsx timing summary: ${error.message}`);
  }
}

function parseRunnerArgs(args) {
  let project = process.env.TTSC_PROJECT ?? 'tsconfig.tools.json';
  let compileOnce = false;
  const passthroughArgs = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === '--project' || arg === '-p') {
      const value = args[index + 1];

      if (value === undefined) {
        throw new Error(`${arg} requires a project path.`);
      }

      project = value;
      index += 1;
      continue;
    }

    if (arg.startsWith('--project=')) {
      project = arg.slice('--project='.length);
      continue;
    }

    // Runner options precede the entry; later arguments belong to the program.
    if (arg === '--compile-once' && passthroughArgs.length === 0) {
      compileOnce = true;
      continue;
    }

    if (arg === '--mpgd-cli') {
      const entry = args[index + 1];

      if (entry === undefined) {
        throw new Error('--mpgd-cli requires a CLI entry path.');
      }

      return {
        project,
        passthroughArgs: [...passthroughArgs, entry],
        cliArgv: stripPnpmArgumentSeparator(args.slice(index + 2)),
        compileOnce,
      };
    }

    passthroughArgs.push(arg);
  }

  return {
    project,
    passthroughArgs,
    cliArgv: undefined,
    compileOnce,
  };
}

function stripPnpmArgumentSeparator(args) {
  const separatorIndex = args.indexOf('--');

  if (separatorIndex === -1) {
    return args;
  }

  return [...args.slice(0, separatorIndex), ...args.slice(separatorIndex + 1)];
}
