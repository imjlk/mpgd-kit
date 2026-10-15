import { spawnSync } from 'node:child_process';
import { chmodSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveGraphBinary } from '@ttsc/graph';
import { isObject, object } from '../validation/json.js';

type JsonObject = Record<string, unknown>;
export interface NamedEntrypoint {
  readonly name: string;
  readonly file: string;
  readonly kind?: string;
}
interface GraphSymbol {
  readonly id: string;
  readonly file: string;
  readonly symbol: string;
  readonly kind: string | undefined;
}
interface RequestBundle {
  readonly name: string;
  readonly description: string;
  readonly namedEntrypoints: NamedEntrypoint[];
  readonly tsconfig: string | undefined;
  readonly cwd: string | undefined;
  readonly props: JsonObject & { question: string; draft: JsonObject; request: JsonObject };
}
// The package does not export its application or identity decoder publicly.
// Keep this version-pinned dynamic bridge narrow: requests and answers stay unknown
// at the dependency boundary and our checked contracts validate the parts we use.
interface GraphApplication {
  inspect_typescript_graph(props: unknown): Promise<unknown>;
}
interface GraphInternals {
  TtscGraphApplication: new (memory: unknown) => GraphApplication;
  TtscGraphMemory: { from(dump: unknown): unknown };
  parseTtscGraphNodeId(id: string): { path: string; name: string; kind?: string } | undefined;
}
const require = createRequire(import.meta.url);

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const requestDir = join(repoRoot, 'tools/graph/requests');

// These are internal @ttsc/graph module paths, not public exports. Re-check them
// whenever the pinned @ttsc/graph version changes (pnpm validate:toolchain pins it).
const graphRoot = dirname(require.resolve('@ttsc/graph/package.json'));
const { TtscGraphApplication } = require(
  join(graphRoot, 'lib/TtscGraphApplication.js'),
) as Pick<GraphInternals, 'TtscGraphApplication'>;
const { TtscGraphMemory } = require(
  join(graphRoot, 'lib/model/TtscGraphMemory.js'),
) as Pick<GraphInternals, 'TtscGraphMemory'>;
const { parseTtscGraphNodeId } = require(
  join(graphRoot, 'lib/model/TtscGraphNodeId.js'),
) as Pick<GraphInternals, 'parseTtscGraphNodeId'>;

export function listPresetNames() {
  return readdirSync(requestDir)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => entry.slice(0, -'.json'.length))
    .sort((left, right) => left.localeCompare(right));
}

/** A checked-in preset: must declare the named entrypoints the preflight asserts. */
export function readPreset(name: string) {
  const path = join(requestDir, `${name}.json`);
  return normalizeRequest(JSON.parse(readFileSync(path, 'utf8')), path);
}

/** An ad-hoc request file for `inspect-local-graph.ts --request`: named entrypoints are optional. */
export function readRequestFile(path: string) {
  const request = JSON.parse(readFileSync(path, 'utf8'));
  return normalizeRequest(request, path, { requireNamedEntrypoints: false });
}

export function normalizeRequest(value: unknown, source: string, { requireNamedEntrypoints = true } = {}): RequestBundle {
  const request = object(value, `Graph request ${source}`);
  const {
    name = source,
    description = '',
    namedEntrypoints = undefined,
    expectedFiles = undefined,
    tsconfig = undefined,
    cwd = undefined,
    ...props
  } = request;

  if (typeof name !== 'string' || typeof description !== 'string' || (tsconfig !== undefined && typeof tsconfig !== 'string') || (cwd !== undefined && typeof cwd !== 'string')) {
    throw new Error(`Graph request metadata must use strings: ${source}`);
  }

  if (expectedFiles !== undefined) {
    throw new Error(
      `Graph request still declares expectedFiles; declare namedEntrypoints instead (see tools/graph/README.md): ${source}`,
    );
  }

  if (typeof props.question !== 'string') {
    throw new Error(`Graph request is missing question: ${source}`);
  }

  if (!isObject(props.request)) {
    throw new Error(`Graph request is missing request payload: ${source}`);
  }

  if (
    !isObject(props.draft) ||
    typeof props.draft.reason !== 'string' || typeof props.draft.type !== 'string'
  ) {
    throw new Error(`Graph request needs a draft with reason and type: ${source}`);
  }

  const normalizedEntrypoints = normalizeNamedEntrypoints(
    namedEntrypoints,
    props.request,
    source,
    requireNamedEntrypoints,
  );

  if (props.request.type === 'tour') {
    props.request = {
      ...props.request,
      reinterpretations: tourReinterpretationsOf(props.request, normalizedEntrypoints, source),
    };
  }

  return {
    name,
    description,
    namedEntrypoints: normalizedEntrypoints,
    tsconfig,
    cwd,
    props: {
      ...props,
      question: props.question,
      draft: props.draft,
      request: object(props.request, 'Graph request payload'),
    },
  };
}

/**
 * The symbol names a tour seeds. They are the named entrypoints, in order:
 * the tour resolves each name as a handle and gives the resolved names half of
 * its seeds, so the list the preflight asserts and the list the tour seeds are
 * one list. An explicit `request.reinterpretations` is accepted only when it
 * is that same list; a request without named entrypoints (an ad-hoc file) must
 * spell it out.
 */
function tourReinterpretationsOf(graphRequest: JsonObject, namedEntrypoints: readonly NamedEntrypoint[], source: string): string[] {
  const explicit = graphRequest.reinterpretations;

  if (namedEntrypoints.length === 0) {
    if (!Array.isArray(explicit) || explicit.some((value) => typeof value !== 'string' || value.trim() === '')) {
      throw new Error(
        `Graph tour needs a reinterpretations array of non-empty strings or namedEntrypoints: ${source}`,
      );
    }
    return explicit.map((value) => value.trim());
  }

  // Two entries may share a name (different files, or one pinning kind); the
  // tour resolves a name once, so it is seeded once.
  const derived = [...new Set(namedEntrypoints.map((entry) => entry.name))];
  if (explicit !== undefined) {
    const given = Array.isArray(explicit)
      ? explicit.map((value) => String(value).trim())
      : undefined;
    if (given === undefined || given.length !== derived.length || given.some((value, index) => value !== derived[index])) {
      throw new Error(
        `Graph tour request.reinterpretations is derived from namedEntrypoints; omit it or list exactly ${derived.join(', ')}: ${source}`,
      );
    }
  }
  return derived;
}

/**
 * The symbols a preset asserts the graph answer is made of.
 *
 * A tour lists them explicitly and seeds the same names (see
 * `tourReinterpretationsOf`). A details request already pins exact handles,
 * so its named entrypoints default to those handles, kind included; an ad-hoc
 * details request may use bare-name handles, which are simply not asserted.
 * An entry may carry an optional `kind` to pin the node kind as well.
 */
function normalizeNamedEntrypoints(namedEntrypoints: unknown, graphRequest: JsonObject, source: string, required: boolean): NamedEntrypoint[] {
  let declared = namedEntrypoints;

  if (declared === undefined && graphRequest.type === 'details') {
    declared = namedEntrypointsFromHandles(graphRequest.handles, source, required);
    if (Array.isArray(declared) && declared.length === 0 && !required) {
      return [];
    }
  }

  if (!required && (declared === undefined || (Array.isArray(declared) && declared.length === 0))) {
    return [];
  }

  if (!Array.isArray(declared) || declared.length === 0) {
    throw new Error(`Graph request needs a non-empty namedEntrypoints array: ${source}`);
  }

  return declared.map((entry: unknown, index) => {
    if (
      !isObject(entry) ||
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
}

/**
 * Named entrypoints from a details request's handles. A checked-in preset
 * (`required`) must pin `file#name:kind` ids; an ad-hoc request may also use
 * bare names, which are skipped here because there is no file to assert.
 */
function namedEntrypointsFromHandles(handles: unknown, source: string, required: boolean): NamedEntrypoint[] {
  if (!Array.isArray(handles) || (required && handles.length === 0)) {
    if (required) {
      throw new Error(`Graph details request needs at least one handle: ${source}`);
    }
    return [];
  }

  const entries: NamedEntrypoint[] = [];
  for (const handle of handles) {
    const parsed = typeof handle === 'string' ? parseTtscGraphNodeId(handle) : undefined;
    if (parsed === undefined) {
      if (required) {
        throw new Error(
          `Graph details handle is not a file#name:kind node id: ${String(handle)} (${source})`,
        );
      }
      continue;
    }
    entries.push({
      name: parsed.name,
      file: parsed.path,
      ...(parsed.kind === undefined ? {} : { kind: parsed.kind }),
    });
  }
  return entries;
}

export function dumpGraph({ cwd, tsconfig }: { cwd: string; tsconfig: string }): string {
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

export async function inspectWithDump(dump: string, props: RequestBundle['props']): Promise<unknown> {
  const memory = TtscGraphMemory.from(JSON.parse(dump));
  const app = new TtscGraphApplication(memory);
  return app.inspect_typescript_graph(props);
}

export function summarizeGraphResult(result: JsonObject, nextAction = 'unknown') {
  const entrypointCount = arrayLength(result.entrypoints) ?? 0;
  const anchorCount = graphResultAnchorCount(result);
  return `${entrypointCount} entrypoints, ${anchorCount} anchors, next=${nextAction}`;
}

export function graphResultAnchorCount(result: JsonObject): number {
  if (result.type === 'trace') {
    return result.start !== undefined && result.start !== null
      ? 1 + (arrayLength(result.reached) ?? 0)
      : 0;
  }
  return (
    arrayLength(result.answerAnchors) ??
    arrayLength(result.anchors) ??
    arrayLength(result.nodes) ??
    arrayLength(result.hits) ??
    0
  );
}

/**
 * Normalize a graph file path so presets and dumps compare the same way on
 * every OS: backslashes become slashes, `./` and `a/../b` segments collapse,
 * and surrounding whitespace is dropped. `../../x.ts` stays relative, which is
 * how a `cwd`-scoped graph reports files outside its root.
 */
export function normalizeGraphFile(file: string): string {
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
export function graphResultSymbols(result: JsonObject): GraphSymbol[] {
  const symbols: GraphSymbol[] = [];
  for (const entry of answerSurfaceOf(result)) {
    if (!isObject(entry) || typeof entry.id !== 'string') {
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

function answerSurfaceOf(result: JsonObject): unknown[] {
  const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
  switch (result.type) {
    case 'tour':
      return [
        ...list(result.entrypoints),
        ...list(result.primaryFlow).flatMap((flow) => isObject(flow) ? [flow.start, ...list(flow.reached)] : []),
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
 * True when a cited symbol is the named entrypoint: same file, the same symbol
 * name as the id's symbol part (`Owner.member` for members), and the same kind
 * when the entrypoint pins one. Both sides are already normalized: symbols by
 * `graphResultSymbols`, entrypoints by `normalizeRequest`.
 */
export function matchesNamedEntrypoint(symbol: GraphSymbol, entrypoint: NamedEntrypoint): boolean {
  return (
    symbol.file === entrypoint.file &&
    symbol.symbol === entrypoint.name &&
    (entrypoint.kind === undefined || symbol.kind === entrypoint.kind)
  );
}

/** The preset's named entrypoints the result does not cite, in declaration order. */
export function missingNamedEntrypoints(result: JsonObject, namedEntrypoints: readonly NamedEntrypoint[]): NamedEntrypoint[] {
  const symbols = graphResultSymbols(result);
  return namedEntrypoints.filter(
    (entrypoint) => !symbols.some((symbol) => matchesNamedEntrypoint(symbol, entrypoint)),
  );
}

export function formatNamedEntrypoint(entrypoint: NamedEntrypoint): string {
  const kind = entrypoint.kind === undefined ? '' : `:${entrypoint.kind}`;
  return `${entrypoint.name}${kind} (${entrypoint.file})`;
}

/**
 * Validate one preset's graph response envelope and return its result.
 *
 * `preset` is `normalizeRequest` output (`readPreset`/`readRequestFile`): its
 * named entrypoints are already trimmed and path-normalized, and the matcher
 * relies on that.
 *
 * Throws when the envelope is malformed, when the graph did not produce an
 * answer-ready result, when the result has no anchors, when the preset
 * declares nothing to assert, or when any named entrypoint is missing. The
 * error names every missing symbol and file so the failure points at the
 * preset contract instead of at a heuristic ranking.
 */
export function assertGraphPresetResponse(presetName: string, preset: Pick<RequestBundle, 'namedEntrypoints'>, response: unknown) {
  if (!isObject(response)) {
    throw new Error(`Graph preset ${presetName} returned an invalid response envelope.`);
  }

  const { result } = response;
  if (!isObject(result)) {
    throw new Error(`Graph preset ${presetName} returned no graph result.`);
  }

  const nextAction = isObject(response.next) ? response.next.action : undefined;
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

function arrayLength(value: unknown): number | undefined {
  return Array.isArray(value) ? value.length : undefined;
}
