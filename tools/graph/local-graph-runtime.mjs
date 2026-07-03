import { spawnSync } from 'node:child_process';
import { chmodSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const requestDir = join(repoRoot, 'tools/graph/requests');

const graphRoot = dirname(require.resolve('@ttsc/graph/package.json'));
const { resolveGraphBinary } = require(join(graphRoot, 'lib/resolveGraphBinary.js'));
const { TtscGraphApplication } = require(join(graphRoot, 'lib/TtscGraphApplication.js'));
const { TtscGraphMemory } = require(join(graphRoot, 'lib/model/TtscGraphMemory.js'));

export function listPresetNames() {
  return readdirSync(requestDir)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => entry.slice(0, -'.json'.length))
    .sort((left, right) => left.localeCompare(right));
}

export function readPreset(name) {
  return readRequestFile(join(requestDir, `${name}.json`));
}

export function readRequestFile(path) {
  const request = JSON.parse(readFileSync(path, 'utf8'));
  return normalizeRequest(request, path);
}

export function normalizeRequest(request, source) {
  const {
    name = source,
    description = '',
    expectedFiles = [],
    tsconfig = undefined,
    cwd = undefined,
    ...props
  } = request;

  if (typeof props.question !== 'string') {
    throw new Error(`Graph request is missing question: ${source}`);
  }

  if (typeof props.request !== 'object' || props.request === null) {
    throw new Error(`Graph request is missing request payload: ${source}`);
  }

  return {
    name,
    description,
    expectedFiles,
    tsconfig,
    cwd,
    props,
  };
}

export function dumpGraph({ cwd, tsconfig }) {
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

  return dump.stdout;
}

export function inspectWithDump(dump, props) {
  const memory = TtscGraphMemory.from(JSON.parse(dump));
  const app = new TtscGraphApplication(memory);
  return app.inspect_typescript_graph(props).result;
}

export function summarizeGraphResult(result) {
  const entrypointCount = result.entrypoints?.length ?? 0;
  const anchorCount = result.answerAnchors?.length ?? result.anchors?.length ?? 0;
  const nextAction = result.next?.action ?? 'unknown';
  return `${entrypointCount} entrypoints, ${anchorCount} anchors, next=${nextAction}`;
}

export function graphResultFiles(result) {
  return new Set(
    [
      ...(result.entrypoints ?? []),
      ...(result.answerAnchors ?? []),
      ...(result.anchors ?? []),
      ...(result.nearby ?? []),
    ]
      .map((entry) => entry.file)
      .filter((file) => typeof file === 'string'),
  );
}
