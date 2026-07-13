#!/usr/bin/env node
import { resolve } from 'node:path';

import {
  dumpGraph,
  graphResultFiles,
  inspectWithDump,
  listPresetNames,
  readPreset,
  repoRoot,
  summarizeGraphResult,
} from './local-graph-runtime.mjs';

const args = process.argv.slice(2);
const requestedPresets = args.length === 0 ? listPresetNames() : args;
const dumps = new Map();

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

  const result = await inspectWithDump(dump, preset.props);
  const nextAction = result.next?.action;
  const anchorCount =
    result.answerAnchors?.length ??
    result.anchors?.length ??
    result.nodes?.length ??
    result.hits?.length ??
    0;

  if (nextAction !== 'answer') {
    throw new Error(`Graph preset ${presetName} did not produce answer-ready evidence.`);
  }

  if (anchorCount === 0) {
    throw new Error(`Graph preset ${presetName} produced no answer anchors.`);
  }

  const resultFiles = graphResultFiles(result);

  for (const expectedFile of preset.expectedFiles) {
    if (![...resultFiles].some((file) => file.startsWith(expectedFile))) {
      throw new Error(`Graph preset ${presetName} did not anchor expected file ${expectedFile}.`);
    }
  }

  console.log(`Graph preset passed ${presetName}: ${summarizeGraphResult(result)}`);
}
