import { spawnSync } from 'node:child_process';
import { chmodSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const requestDir = join(repoRoot, 'tools/graph/requests');

const graphRoot = dirname(require.resolve('@ttsc/graph/package.json'));
const { resolveGraphBinary } = require(join(graphRoot, 'lib/resolveGraphBinary.js'));
const { TtscGraphApplication } = require(join(graphRoot, 'lib/TtscGraphApplication.js'));
const { TtscGraphMemory } = require(join(graphRoot, 'lib/model/TtscGraphMemory.js'));
const { parseTtscGraphNodeId } = require(join(graphRoot, 'lib/model/TtscGraphNodeId.js'));

export function listPresetNames() {
  return readdirSync(requestDir)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => entry.slice(0, -'.json'.length))
    .sort((left, right) => left.localeCompare(right));
}

/** A checked-in preset: must declare the named entrypoints the preflight asserts. */
export function readPreset(name) {
  const path = join(requestDir, `${name}.json`);
  return normalizeRequest(JSON.parse(readFileSync(path, 'utf8')), path);
}

/** An ad-hoc request file for `inspect-local-graph.mjs --request`: named entrypoints are optional. */
export function readRequestFile(path) {
  const request = JSON.parse(readFileSync(path, 'utf8'));
  return normalizeRequest(request, path, { requireNamedEntrypoints: false });
}

export function normalizeRequest(request, source, { requireNamedEntrypoints = true } = {}) {
  const {
    name = source,
    description = '',
    namedEntrypoints = undefined,
    expectedFiles = undefined,
    tsconfig = undefined,
    cwd = undefined,
    ...props
  } = request;

  if (expectedFiles !== undefined) {
    throw new Error(
      `Graph request still declares expectedFiles; declare namedEntrypoints instead (see tools/graph/README.md): ${source}`,
    );
  }

  if (typeof props.question !== 'string') {
    throw new Error(`Graph request is missing question: ${source}`);
  }

  if (typeof props.request !== 'object' || props.request === null) {
    throw new Error(`Graph request is missing request payload: ${source}`);
  }

  if (
    typeof props.draft !== 'object' || props.draft === null ||
    typeof props.draft.reason !== 'string' || typeof props.draft.type !== 'string'
  ) {
    throw new Error(`Graph request needs a draft with reason and type: ${source}`);
  }

  if (props.request.type === 'tour' && !Array.isArray(props.request.reinterpretations)) {
    throw new Error(`Graph tour needs a reinterpretations array: ${source}`);
  }

  return {
    name,
    description,
    namedEntrypoints: normalizeNamedEntrypoints(
      namedEntrypoints,
      props.request,
      source,
      requireNamedEntrypoints,
    ),
    tsconfig,
    cwd,
    props,
  };
}

/**
 * The symbols a preset asserts the graph answer is made of.
 *
 * A tour must list them explicitly, and every listed name must also be a
 * `reinterpretations` entry so the tour seeds it instead of hoping the
 * centrality ranking finds it. A details request already pins exact handles,
 * so its named entrypoints default to those handles, kind included. An entry
 * may carry an optional `kind` to pin the node kind as well.
 */
function normalizeNamedEntrypoints(namedEntrypoints, graphRequest, source, required) {
  const declared = namedEntrypoints === undefined && graphRequest.type === 'details'
    ? namedEntrypointsFromHandles(graphRequest.handles, source)
    : namedEntrypoints;

  if (declared === undefined && !required) {
    return [];
  }

  if (!Array.isArray(declared) || declared.length === 0) {
    throw new Error(`Graph request needs a non-empty namedEntrypoints array: ${source}`);
  }

  const normalized = declared.map((entry, index) => {
    if (
      typeof entry !== 'object' || entry === null ||
      typeof entry.name !== 'string' || entry.name.trim() === '' ||
      typeof entry.file !== 'string' || entry.file.trim() === '' ||
      (entry.kind !== undefined && (typeof entry.kind !== 'string' || entry.kind.trim() === ''))
    ) {
      throw new Error(
        `Graph request namedEntrypoints[${index}] needs name and file strings (kind optional): ${source}`,
      );
    }
    return {
      name: entry.name.trim(),
      file: normalizeGraphFile(entry.file),
      ...(entry.kind === undefined ? {} : { kind: entry.kind.trim() }),
    };
  });

  if (graphRequest.type === 'tour') {
    const reinterpretations = new Set(graphRequest.reinterpretations.map((value) => String(value).trim()));
    for (const entry of normalized) {
      if (!reinterpretations.has(entry.name)) {
        throw new Error(
          `Graph tour named entrypoint ${entry.name} must also be listed in request.reinterpretations: ${source}`,
        );
      }
    }
  }

  return normalized;
}

function namedEntrypointsFromHandles(handles, source) {
  if (!Array.isArray(handles)) {
    throw new Error(`Graph details request needs a handles array: ${source}`);
  }

  return handles.map((handle) => {
    const parsed = typeof handle === 'string' ? parseTtscGraphNodeId(handle) : undefined;
    if (parsed === undefined) {
      throw new Error(`Graph details handle is not a file#name:kind node id: ${String(handle)} (${source})`);
    }
    return { name: parsed.name, file: parsed.path, ...(parsed.kind === undefined ? {} : { kind: parsed.kind }) };
  });
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

export async function inspectWithDump(dump, props) {
  const memory = TtscGraphMemory.from(JSON.parse(dump));
  const app = new TtscGraphApplication(memory);
  return app.inspect_typescript_graph(props);
}

export function summarizeGraphResult(result, nextAction = 'unknown') {
  const entrypointCount = result.entrypoints?.length ?? 0;
  const anchorCount = graphResultAnchorCount(result);
  return `${entrypointCount} entrypoints, ${anchorCount} anchors, next=${nextAction}`;
}

export function graphResultAnchorCount(result) {
  if (result.type === 'trace') {
    return result.start !== undefined && result.start !== null
      ? 1 + (result.reached?.length ?? 0)
      : 0;
  }
  return (
    result.answerAnchors?.length ??
    result.anchors?.length ??
    result.nodes?.length ??
    result.hits?.length ??
    0
  );
}

/**
 * Normalize a graph file path so presets and dumps compare the same way on
 * every OS: backslashes become slashes, `./` and `a/../b` segments collapse,
 * and surrounding whitespace is dropped. `../../x.ts` stays relative, which is
 * how a `cwd`-scoped graph reports files outside its root.
 */
export function normalizeGraphFile(file) {
  return posix.normalize(file.trim().replaceAll('\\', '/'));
}

/**
 * The compiler-resolved symbols a graph result presents as its answer, each
 * as `{ id, file, symbol, kind }` parsed from the node id.
 *
 * Only the result's own answer surface counts, and only each entry's own id:
 * tour `entrypoints`, flow starts and reached nodes, and `nearby`/`tests`/
 * `answerAnchors` entries that carry an id; details `nodes`; a trace's start
 * and reached nodes. Nested references are deliberately ignored: a details
 * node's `calls`/`types` lists and `ambiguous[].candidates` carry ids for
 * symbols the request did not resolve, and an edge anchor such as `calls foo`
 * names a symbol with the call-site file and no id at all. Neither is
 * evidence that `foo` is declared where a preset says it is.
 */
export function graphResultSymbols(result) {
  const symbols = [];
  for (const entry of answerSurfaceOf(result)) {
    if (typeof entry !== 'object' || entry === null || typeof entry.id !== 'string') {
      continue;
    }
    const parsed = parseTtscGraphNodeId(entry.id);
    if (parsed === undefined) {
      continue;
    }
    symbols.push({
      id: entry.id,
      file: normalizeGraphFile(parsed.path),
      symbol: parsed.name,
      kind: parsed.kind,
    });
  }
  return symbols;
}

function answerSurfaceOf(result) {
  const list = (value) => (Array.isArray(value) ? value : []);
  switch (result.type) {
    case 'tour':
      return [
        ...list(result.entrypoints),
        ...list(result.primaryFlow).flatMap((flow) => [flow?.start, ...list(flow?.reached)]),
        ...list(result.nearby),
        ...list(result.tests),
        ...list(result.answerAnchors),
      ];
    case 'details':
      return list(result.nodes);
    case 'trace':
      return [result.start, ...list(result.reached)];
    default:
      return [
        ...list(result.nodes),
        ...list(result.hits),
        ...list(result.anchors),
        ...list(result.answerAnchors),
      ];
  }
}

/**
 * True when a cited symbol is the named entrypoint: same normalized file, the
 * same symbol name as the id's symbol part (`Owner.member` for members), and
 * the same kind when the entrypoint pins one.
 */
export function matchesNamedEntrypoint(symbol, entrypoint) {
  return (
    symbol.file === normalizeGraphFile(entrypoint.file) &&
    symbol.symbol === entrypoint.name.trim() &&
    (entrypoint.kind === undefined || symbol.kind === entrypoint.kind)
  );
}

/** The preset's named entrypoints the result does not cite, in declaration order. */
export function missingNamedEntrypoints(result, namedEntrypoints) {
  const symbols = graphResultSymbols(result);
  return namedEntrypoints.filter(
    (entrypoint) => !symbols.some((symbol) => matchesNamedEntrypoint(symbol, entrypoint)),
  );
}

export function formatNamedEntrypoint(entrypoint) {
  const kind = entrypoint.kind === undefined ? '' : `:${entrypoint.kind}`;
  return `${entrypoint.name}${kind} (${normalizeGraphFile(entrypoint.file)})`;
}

/**
 * Validate one preset's graph response envelope and return its result.
 *
 * Throws when the envelope is malformed, when the graph did not produce an
 * answer-ready result, when the result has no anchors, when the preset
 * declares nothing to assert, or when any named entrypoint is missing. The
 * error names every missing symbol and file so the failure points at the
 * preset contract instead of at a heuristic ranking.
 */
export function assertGraphPresetResponse(presetName, preset, response) {
  if (typeof response !== 'object' || response === null || Array.isArray(response)) {
    throw new Error(`Graph preset ${presetName} returned an invalid response envelope.`);
  }

  const { result } = response;
  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    throw new Error(`Graph preset ${presetName} returned no graph result.`);
  }

  const nextAction = response.next?.action;
  if (nextAction !== 'answer') {
    throw new Error(`Graph preset ${presetName} did not produce answer-ready evidence.`);
  }

  const anchorCount = graphResultAnchorCount(result);
  if (anchorCount === 0) {
    throw new Error(`Graph preset ${presetName} produced no answer anchors.`);
  }

  if (!Array.isArray(preset.namedEntrypoints) || preset.namedEntrypoints.length === 0) {
    throw new Error(`Graph preset ${presetName} declares no namedEntrypoints to assert.`);
  }

  const missing = missingNamedEntrypoints(result, preset.namedEntrypoints);
  if (missing.length > 0) {
    throw new Error(
      `Graph preset ${presetName} is missing named entrypoints: ${missing.map(formatNamedEntrypoint).join(', ')}. ` +
        'Cited symbols must match by file and symbol name; see tools/graph/README.md.',
    );
  }

  return { result, nextAction, anchorCount };
}
