#!/usr/bin/env node
// Graph preflight: run every checked-in preset under tools/graph/requests/ and
// assert that the ttsc graph answer cites each preset's named entrypoints.
//
// Why named entrypoints and not directory prefixes: a tour ranks the whole graph
// heuristically, so an unrelated feature PR can shift which files its anchors
// land in. The old `expectedFiles` prefix check failed on that drift and pushed
// feature PRs into editing presets or folding modules to keep a directory
// anchored. A named entrypoint is a `{ name, file }` pair the preset's question
// is actually about; it is seeded into the tour through `reinterpretations`
// and matched against the result by file and symbol name, so it does not move
// when centrality moves. `expectedFiles` was removed rather than kept as a
// secondary check: every named entrypoint already carries its file, and the
// prefix check only reintroduced the heuristic failure mode. See
// tools/graph/README.md.
import { resolve } from 'node:path';

import {
  assertGraphPresetResponse,
  dumpGraph,
  inspectWithDump,
  listPresetNames,
  readPreset,
  repoRoot,
  summarizeGraphResult,
} from './local-graph-runtime.js';

const args = process.argv.slice(2);
const requestedPresets = args.length === 0 ? listPresetNames() : args;
const dumps = new Map<string, string>();

for (const presetName of requestedPresets) {
  const preset = readPreset(presetName);
  const cwd = resolve(preset.cwd ?? repoRoot);
  const tsconfig = preset.tsconfig ?? 'tsconfig.graph.json';
  const key = `${cwd}\0${tsconfig}`;
  let dump = dumps.get(key);

  if (dump === undefined) {
    dump = dumpGraph({ cwd, tsconfig });
    dumps.set(key, dump);
  }

  const response = await inspectWithDump(dump, preset.props);
  const { result, nextAction } = assertGraphPresetResponse(presetName, preset, response);

  console.info(
    `Graph preset passed ${presetName}: ${summarizeGraphResult(result, nextAction)}, ` +
      `named entrypoints ${preset.namedEntrypoints.map((entry) => entry.name).join(', ')}`,
  );
}
