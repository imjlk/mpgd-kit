#!/usr/bin/env node
import { resolve } from 'node:path';

import {
  dumpGraph,
  inspectWithDump,
  listPresetNames,
  readPreset,
  readRequestFile,
  repoRoot,
} from './local-graph-runtime.mjs';

const args = process.argv.slice(2);
const dumpOnly = args.includes('--dump');
const listPresets = args.includes('--list-presets');
const requestPath = readOption('--request');
const presetName = readOption('--preset');
const explicitTsconfig = readOption('--tsconfig');

if (listPresets) {
  process.stdout.write(`${listPresetNames().join('\n')}\n`);
  process.exit(0);
}

if (requestPath !== undefined && presetName !== undefined) {
  throw new Error('Use either --request or --preset, not both.');
}

const requestBundle =
  requestPath === undefined ? readPreset(presetName ?? 'target-release') : readRequestFile(requestPath);
const tsconfig = explicitTsconfig ?? requestBundle.tsconfig ?? 'tsconfig.graph.json';
const cwd = resolve(readOption('--cwd') ?? requestBundle.cwd ?? repoRoot);

const dump = dumpGraph({ cwd, tsconfig });

if (dumpOnly) {
  process.stdout.write(dump);
  process.exit(0);
}

const response = inspectWithDump(dump, requestBundle.props);

process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);

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
