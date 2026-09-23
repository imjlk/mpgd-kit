import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
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
const ttsxLauncher = join(dirname(ttscPackageJson), 'lib', 'launcher', 'ttsx.js');
const userArgs = process.argv.slice(2);
const { project, passthroughArgs, cliArgv } = parseRunnerArgs(userArgs);
if (!existsSync(tsgoBinary)) {
  throw new Error(`TypeScript-Go binary not found: ${tsgoBinary}`);
}

// ttsx owns its emitted files under its execution cache. Authored .js/.d.ts
// siblings are valid inputs and must not be deleted by a repository-wide scan.
const startedAt = process.hrtime.bigint();
const result = spawnSync(process.execPath, [
  ttsxLauncher,
  '--cwd',
  process.cwd(),
  '--project',
  project,
  ...passthroughArgs,
], {
  stdio: 'inherit',
  env: {
    ...process.env,
    TTSC_TSGO_BINARY: tsgoBinary,
    ...(cliArgv === undefined ? {} : { MPGD_CLI_ARGV: JSON.stringify(cliArgv) }),
  },
});

const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
const exitCode = result.status ?? 1;
if (process.env.GITHUB_STEP_SUMMARY) {
  try {
    const summaryPath = process.env.GITHUB_STEP_SUMMARY;
    const title = '### ttsx invocation timings';
    const previous = existsSync(summaryPath) ? readFileSync(summaryPath, 'utf8') : '';
    if (!previous.includes(title)) {
      appendFileSync(summaryPath, `${title}\n\n| Project | Entry | Seconds | Exit |\n| --- | --- | ---: | ---: |\n`);
    }
    const safeProject = project.replaceAll('|', '\\|').replaceAll('`', "'");
    const safeEntry = (passthroughArgs[0] ?? '<none>').replaceAll('|', '\\|').replaceAll('`', "'");
    appendFileSync(summaryPath, `| \`${safeProject}\` | \`${safeEntry}\` | ${seconds.toFixed(1)} | ${exitCode} |\n`);
  } catch (error) {
    // Reporting must never turn a passing test into a CI failure.
    console.warn(`Could not write ttsx timing summary: ${error.message}`);
  }
}
if (process.env.GITHUB_ACTIONS) {
  console.log(`ttsx ${passthroughArgs[0] ?? '<none>'}: ${seconds.toFixed(1)}s, exit ${exitCode}`);
}

if (result.error !== undefined) {
  throw result.error;
}

process.exit(exitCode);

function parseRunnerArgs(args) {
  let project = process.env.TTSC_PROJECT ?? 'tsconfig.tools.json';
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

    if (arg === '--mpgd-cli') {
      const entry = args[index + 1];

      if (entry === undefined) {
        throw new Error('--mpgd-cli requires a CLI entry path.');
      }

      return {
        project,
        passthroughArgs: [...passthroughArgs, entry],
        cliArgv: stripPnpmArgumentSeparator(args.slice(index + 2)),
      };
    }

    passthroughArgs.push(arg);
  }

  return {
    project,
    passthroughArgs,
    cliArgv: undefined,
  };
}

function stripPnpmArgumentSeparator(args) {
  const separatorIndex = args.indexOf('--');

  if (separatorIndex === -1) {
    return args;
  }

  return [...args.slice(0, separatorIndex), ...args.slice(separatorIndex + 1)];
}
