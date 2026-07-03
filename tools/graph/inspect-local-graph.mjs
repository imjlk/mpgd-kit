#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { chmodSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const graphRoot = dirname(require.resolve('@ttsc/graph/package.json'));
const { resolveGraphBinary } = require(join(graphRoot, 'lib/resolveGraphBinary.js'));
const { TtscGraphApplication } = require(join(graphRoot, 'lib/TtscGraphApplication.js'));
const { TtscGraphMemory } = require(join(graphRoot, 'lib/model/TtscGraphMemory.js'));

const args = process.argv.slice(2);
const dumpOnly = args.includes('--dump');
const requestPath = readOption('--request');
const tsconfig = readOption('--tsconfig') ?? 'tsconfig.tools.json';
const cwd = resolve(readOption('--cwd') ?? repoRoot);

const binary = resolveGraphBinary(process.env, cwd);

if (binary === null) {
  throw new Error('Could not resolve the native ttscgraph binary. Run pnpm install first.');
}

if (process.platform !== 'win32') {
  chmodSync(binary, 0o755);
}

const dump = spawnSync(binary, ['dump', '--cwd', cwd, '--tsconfig', tsconfig], {
  cwd,
  encoding: 'utf8',
  maxBuffer: 128 * 1024 * 1024,
  stdio: ['ignore', 'pipe', 'inherit'],
});

if (dump.error !== undefined) {
  throw dump.error;
}

if (dump.status !== 0) {
  throw new Error(`ttscgraph dump failed with exit code ${dump.status}.`);
}

if (dumpOnly) {
  process.stdout.write(dump.stdout);
  process.exit(0);
}

const props = requestPath === undefined ? defaultRequest() : JSON.parse(readFileSync(requestPath, 'utf8'));
const memory = TtscGraphMemory.from(JSON.parse(dump.stdout));
const app = new TtscGraphApplication(memory);
const response = app.inspect_typescript_graph(props);

process.stdout.write(`${JSON.stringify(response.result, null, 2)}\n`);

function readOption(name) {
  const index = args.indexOf(name);

  if (index === -1) {
    return undefined;
  }

  const value = args[index + 1];

  if (value === undefined || value.startsWith('--')) {
    throw new Error(`Missing value for ${name}.`);
  }

  return value;
}

function defaultRequest() {
  return {
    question: 'What are the central target build, validation, and release manifest flows?',
    draft: 'Use a tour because the target pipeline crosses several tool modules.',
    review: 'A broad flow question should start with tour over the current local graph dump.',
    request: {
      type: 'tour',
      query: 'target build validation release manifest',
      includeTests: true,
      limit: 50,
    },
  };
}
