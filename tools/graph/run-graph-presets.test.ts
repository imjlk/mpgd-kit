import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { object, parseObject } from '../validation/json.js';

import {
  assertGraphPresetResponse,
  graphResultAnchorCount,
  graphResultSymbols,
  listPresetNames,
  missingNamedEntrypoints,
  normalizeGraphFile,
  normalizeRequest,
  readPreset,
  repoRoot,
} from './local-graph-runtime.js';

// A synthetic tour answer shaped like @ttsc/graph's runTour output. The named
// entrypoints the target-release preset asserts are cited across the payload
// (entrypoints, flow starts, flow reached nodes, answer anchors) while every
// "central entrypoint" the heuristic ranking picked has drifted into
// packages/cli — the shape that broke the old directory-prefix check.
const namedEntrypoints = [
  { name: 'executeNativeTargetBuild', file: 'tools/target/native-build-execution.ts' },
  { name: 'generateReleaseManifest', file: 'tools/target/generate-release-manifest.ts' },
  { name: 'verifyTargetArtifacts', file: 'tools/smoke/verify-target-artifacts.ts' },
];

function tourPreset(overrides: Record<string, unknown> = {}) {
  return normalizeRequest(
    {
      name: 'synthetic-tour',
      namedEntrypoints,
      question: 'What are the central target build, smoke, and release manifest flows?',
      draft: { reason: 'Tour the target pipeline.', type: 'tour' },
      request: { type: 'tour', includeTests: true },
      ...overrides,
    },
    'synthetic-tour.json',
  );
}

function node(file: string, name: string, kind = 'function', line = 1): { id: string; name: string; kind: string; file: string; line: number; calls?: unknown[] } {
  return { id: `${file}#${name}:${kind}`, name: name.split('.').at(-1) ?? name, kind, file, line };
}

function driftedTourResponse() {
  const build = node(
    'tools/target/native-build-execution.ts',
    'executeNativeTargetBuild',
    'function',
    52,
  );
  const manifest = node(
    'tools/target/generate-release-manifest.ts',
    'generateReleaseManifest',
    'function',
    76,
  );
  const smoke = node(
    'tools/smoke/verify-target-artifacts.ts',
    'verifyTargetArtifacts',
    'function',
    78,
  );
  return {
    audit: { selection: 'heuristic' } as Record<string, unknown>,
    next: { action: 'answer' },
    result: {
      type: 'tour',
      entrypoints: [
        node('packages/cli/src/native-deploy-run.ts', 'runNativeDeployment'),
        node('packages/cli/src/release-state.ts', 'recordNativeReleaseBuild'),
        node(
          'packages/cli/src/microsoft-store-package-generation.ts',
          'runMicrosoftStorePackageGeneration',
        ),
        node('packages/game-services/src/server.ts', 'createGameServicesBackend'),
        build,
      ],
      primaryFlow: [
        {
          start: smoke,
          steps: [
            'verifyTargetArtifacts -[calls at tools/smoke/verify-target-artifacts.ts:90]-> generateReleaseManifest',
          ],
          reached: [
            { id: manifest.id, name: manifest.name, line: manifest.line },
            {
              id: 'tools/target/generate-release-manifest.ts#writeReleaseManifest:function',
              name: 'writeReleaseManifest',
            },
          ],
        },
      ],
      nearby: [] as unknown[],
      tests: [],
      answerAnchors: [
        { reason: 'central entrypoint', ...build, startLine: build.line },
        {
          reason: 'central entrypoint',
          ...node('packages/cli/src/native-deploy-run.ts', 'runNativeDeployment'),
        },
      ],
    },
  };
}

await test('passes when the named entrypoints are cited even though the ranked anchors drifted', () => {
  const preset = tourPreset();
  const response = driftedTourResponse();
  const { result, nextAction, anchorCount } = assertGraphPresetResponse('synthetic-tour', preset, response);
  assert.equal(nextAction, 'answer');
  assert.equal(anchorCount, graphResultAnchorCount(result));
  assert.ok(anchorCount > 0);
  // The fixture deliberately has no tools/smoke anchor among the ranked
  // "central entrypoint" anchors, which is what the old prefix rule required.
  assert.ok(Array.isArray(result.answerAnchors));
  assert.ok(result.answerAnchors.every((anchor: unknown) => {
    const file = object(anchor, 'anchor').file;
    return typeof file === 'string' && !file.startsWith('tools/smoke/');
  }));
});

await test('fails naming the missing symbol and file when a named entrypoint is absent', () => {
  const preset = tourPreset();
  const response = driftedTourResponse();
  assert.ok(response.result.primaryFlow[0]);
  response.result.primaryFlow[0].reached = [];
  assert.deepEqual(missingNamedEntrypoints(response.result, preset.namedEntrypoints), [
    { name: 'generateReleaseManifest', file: 'tools/target/generate-release-manifest.ts' },
  ]);
  assert.throws(
    () => assertGraphPresetResponse('synthetic-tour', preset, response),
    /Graph preset synthetic-tour is missing named entrypoints: generateReleaseManifest \(tools\/target\/generate-release-manifest\.ts\)\./,
  );
});

await test('an edge anchor without a node id is not evidence that the symbol is declared there', () => {
  const preset = tourPreset();
  const response = driftedTourResponse();
  assert.ok(response.result.primaryFlow[0]);
  response.result.primaryFlow[0].reached = [];
  response.result.nearby.push({
    reason: 'calls generateReleaseManifest',
    name: 'generateReleaseManifest',
    file: 'tools/target/generate-release-manifest.ts',
    startLine: 80,
  });
  assert.throws(
    () => assertGraphPresetResponse('synthetic-tour', preset, response),
    /missing named entrypoints: generateReleaseManifest/,
  );
});

await test('ids nested below the answer surface do not count', () => {
  const preset = tourPreset();
  const response = driftedTourResponse();
  assert.ok(response.result.primaryFlow[0]);
  response.result.primaryFlow[0].reached = [];
  // A node id that only appears inside another entry (a callee list, a flow
  // step's prose, or an audit record) is not a cited answer symbol.
  assert.ok(response.result.entrypoints[0]);
  response.result.entrypoints[0].calls = [
    { id: 'tools/target/generate-release-manifest.ts#generateReleaseManifest:function', name: 'generateReleaseManifest' },
  ];
  response.audit.seeds = [{ id: 'tools/target/generate-release-manifest.ts#generateReleaseManifest:function' }];
  assert.throws(
    () => assertGraphPresetResponse('synthetic-tour', preset, response),
    /missing named entrypoints: generateReleaseManifest/,
  );
});

await test('a same-named symbol in another file does not satisfy a named entrypoint', () => {
  const preset = tourPreset();
  const response = driftedTourResponse();
  assert.ok(response.result.primaryFlow[0]);
  response.result.primaryFlow[0].reached = [
    { id: 'packages/cli/src/release-manifest.ts#generateReleaseManifest:function', name: 'generateReleaseManifest' },
  ];
  assert.throws(
    () => assertGraphPresetResponse('synthetic-tour', preset, response),
    /missing named entrypoints: generateReleaseManifest \(tools\/target\/generate-release-manifest\.ts\)/,
  );
});

await test('preset file paths normalize Windows separators, ./ and ../ segments, and whitespace', () => {
  assert.equal(
    normalizeGraphFile('.\\tools\\target\\native-build-execution.ts'),
    'tools/target/native-build-execution.ts',
  );
  assert.equal(normalizeGraphFile(' ./src//runtime/../bootstrap.ts '), 'src/bootstrap.ts');
  assert.equal(
    normalizeGraphFile('../../packages/i18n/src/index.ts'),
    '../../packages/i18n/src/index.ts',
  );
  const preset = tourPreset({
    namedEntrypoints: [
      { name: 'executeNativeTargetBuild', file: '.\\tools\\target\\native-build-execution.ts' },
      { name: 'generateReleaseManifest', file: ' ./tools/target/generate-release-manifest.ts' },
      { name: 'verifyTargetArtifacts', file: 'tools/smoke/verify-target-artifacts.ts' },
    ],
  });
  const response = driftedTourResponse();
  assert.ok(response.result.entrypoints[4]);
  response.result.entrypoints[4].id = 'tools\\target\\native-build-execution.ts#executeNativeTargetBuild:function';
  assert.doesNotThrow(() => assertGraphPresetResponse('synthetic-tour', preset, response));
});

await test('member entrypoints match the qualified symbol part of the id, not the simple name field', () => {
  const file = 'packages/game-services/src/server.ts';
  const result = {
    type: 'details',
    nodes: [
      {
        id: `${file}#InMemoryGameServicesStore.recordLeaderboardScore:method`,
        name: 'recordLeaderboardScore',
        kind: 'method',
        file,
      },
    ],
  };
  assert.deepEqual(graphResultSymbols(result), [
    {
      id: `${file}#InMemoryGameServicesStore.recordLeaderboardScore:method`,
      file,
      symbol: 'InMemoryGameServicesStore.recordLeaderboardScore',
      kind: 'method',
    },
  ]);
  assert.deepEqual(
    missingNamedEntrypoints(result, [
      { name: 'InMemoryGameServicesStore.recordLeaderboardScore', file },
    ]),
    [],
  );
  assert.equal(
    missingNamedEntrypoints(result, [{ name: 'recordLeaderboardScore', file }]).length,
    1,
  );
});

await test('an entrypoint that pins a kind is not satisfied by another kind with the same name', () => {
  const file = 'tools/target/effective-config.ts';
  const result = {
    type: 'details',
    nodes: [node(file, 'embeddedTargetConfigFileName', 'variable')],
  };
  assert.deepEqual(
    missingNamedEntrypoints(result, [{ name: 'embeddedTargetConfigFileName', file }]),
    [],
  );
  assert.deepEqual(
    missingNamedEntrypoints(result, [
      { name: 'embeddedTargetConfigFileName', file, kind: 'function' },
    ]),
    [{ name: 'embeddedTargetConfigFileName', file, kind: 'function' }],
  );
});

await test('details presets derive their named entrypoints, kind included, from the pinned handles', () => {
  const preset = normalizeRequest({
    question: 'Which symbols connect the contract and router?',
    draft: { reason: 'Pin exact handles.', type: 'details' },
    request: {
      type: 'details',
      handles: [
        'packages/game-services/src/contract.ts#gameServicesContract:variable',
        'packages/game-services/src/server.ts#createGameServicesRouter:function',
      ],
    },
  }, 'synthetic-details.json');
  assert.deepEqual(preset.namedEntrypoints, [
    { name: 'gameServicesContract', file: 'packages/game-services/src/contract.ts', kind: 'variable' },
    { name: 'createGameServicesRouter', file: 'packages/game-services/src/server.ts', kind: 'function' },
  ]);
  const response = {
    next: { action: 'answer' },
    result: {
      type: 'details',
      nodes: [
        {
          ...node('packages/game-services/src/contract.ts', 'gameServicesContract', 'variable'),
          // A resolved node's callee list cites the other handle; that is not a
          // resolution of the handle itself.
          calls: [node('packages/game-services/src/server.ts', 'createGameServicesRouter')],
        },
      ],
      unknown: [],
      ambiguous: [
        {
          handle: 'createGameServicesRouter',
          candidates: [node('packages/game-services/src/server.ts', 'createGameServicesRouter')],
        },
      ],
    },
  };
  assert.throws(
    () => assertGraphPresetResponse('synthetic-details', preset, response),
    /missing named entrypoints: createGameServicesRouter:function \(packages\/game-services\/src\/server\.ts\)/,
  );
  response.result.nodes.push({ ...node('packages/game-services/src/server.ts', 'createGameServicesRouter'), calls: [] });
  assert.doesNotThrow(() => assertGraphPresetResponse('synthetic-details', preset, response));
});

await test('keeps the answer-ready and non-empty anchor requirements', () => {
  const preset = tourPreset();
  const inspect = driftedTourResponse();
  inspect.next = { action: 'inspect' };
  assert.throws(
    () => assertGraphPresetResponse('synthetic-tour', preset, inspect),
    /did not produce answer-ready evidence/,
  );
  const empty = driftedTourResponse();
  empty.result.answerAnchors = [];
  assert.throws(
    () => assertGraphPresetResponse('synthetic-tour', preset, empty),
    /produced no answer anchors/,
  );
  assert.throws(
    () => assertGraphPresetResponse('synthetic-tour', preset, null),
    /invalid response envelope/,
  );
  assert.throws(
    () => assertGraphPresetResponse('synthetic-tour', preset, { next: { action: 'answer' } }),
    /no graph result/,
  );
});

await test('rejects presets that still use expectedFiles or declare malformed named entrypoints', () => {
  assert.throws(
    () => tourPreset({ expectedFiles: ['tools/target/'] }),
    /declares expectedFiles; declare namedEntrypoints/,
  );
  assert.throws(() => tourPreset({ namedEntrypoints: undefined }), /non-empty namedEntrypoints/);
  assert.throws(() => tourPreset({ namedEntrypoints: [] }), /non-empty namedEntrypoints/);
  assert.throws(
    () => tourPreset({ namedEntrypoints: [{ name: 'executeNativeTargetBuild' }] }),
    /needs name and file strings/,
  );
});

await test('tour reinterpretations are derived from the named entrypoints', () => {
  const names = namedEntrypoints.map((entry) => entry.name);
  assert.deepEqual(tourPreset().props.request.reinterpretations, names);
  // An explicit list is tolerated only when it is the derived list.
  assert.deepEqual(
    tourPreset({ request: { type: 'tour', reinterpretations: [...names] } }).props.request.reinterpretations,
    names,
  );
  assert.throws(
    () => tourPreset({ request: { type: 'tour', reinterpretations: ['executeNativeTargetBuild'] } }),
    /request\.reinterpretations is derived from namedEntrypoints; omit it or list exactly executeNativeTargetBuild, generateReleaseManifest, verifyTargetArtifacts/,
  );
  assert.throws(
    () => tourPreset({ request: { type: 'tour', reinterpretations: [...names, 'extraHint'] } }),
    /is derived from namedEntrypoints/,
  );
  // Without named entrypoints (ad-hoc), the list must be spelled out.
  assert.throws(
    () => normalizeRequest({
      question: 'What runs?', draft: { reason: 'Look.', type: 'tour' }, request: { type: 'tour' },
    }, 'adhoc.json', { requireNamedEntrypoints: false }),
    /needs a reinterpretations array of non-empty strings or namedEntrypoints/,
  );
  // Ad-hoc explicit lists are trimmed; duplicate named entrypoints seed once.
  assert.deepEqual(
    normalizeRequest({
      question: 'What runs?', draft: { reason: 'Look.', type: 'tour' },
      request: { type: 'tour', reinterpretations: [' bootstrapStarter '] },
    }, 'adhoc.json', { requireNamedEntrypoints: false }).props.request.reinterpretations,
    ['bootstrapStarter'],
  );
  assert.deepEqual(
    tourPreset({
      namedEntrypoints: [
        { name: 'verifyTargetArtifacts', file: 'tools/smoke/verify-target-artifacts.ts', kind: 'function' },
        { name: 'verifyTargetArtifacts', file: 'tools/smoke/verify-target-artifacts.test.ts' },
      ],
    }).props.request.reinterpretations,
    ['verifyTargetArtifacts'],
  );
});

await test('ad-hoc details requests may use bare-name handles, which are not asserted', () => {
  const adHoc = normalizeRequest({
    question: 'What does the router call?',
    draft: { reason: 'Pin by name.', type: 'details' },
    request: {
      type: 'details',
      handles: ['createGameServicesRouter', 'packages/game-services/src/contract.ts#gameServicesContract:variable'],
    },
  }, 'adhoc-details.json', { requireNamedEntrypoints: false });
  assert.deepEqual(adHoc.namedEntrypoints, [
    { name: 'gameServicesContract', file: 'packages/game-services/src/contract.ts', kind: 'variable' },
  ]);
  const bareOnly = normalizeRequest({
    question: 'What does the router call?',
    draft: { reason: 'Pin by name.', type: 'details' },
    request: { type: 'details', handles: ['createGameServicesRouter'] },
  }, 'adhoc-details.json', { requireNamedEntrypoints: false });
  assert.deepEqual(bareOnly.namedEntrypoints, []);
  // A checked-in preset must pin ids.
  assert.throws(
    () => normalizeRequest({
      question: 'What does the router call?',
      draft: { reason: 'Pin by name.', type: 'details' },
      request: { type: 'details', handles: ['createGameServicesRouter'] },
    }, 'preset-details.json'),
    /not a file#name:kind node id: createGameServicesRouter/,
  );
});

await test('ad-hoc request files may omit namedEntrypoints, but the preflight refuses to assert nothing', () => {
  const adHoc = normalizeRequest(
    {
      question: 'What runs?',
      draft: { reason: 'Look around.', type: 'tour' },
      request: { type: 'tour', reinterpretations: [] },
    },
    'adhoc.json',
    { requireNamedEntrypoints: false },
  );
  assert.deepEqual(adHoc.namedEntrypoints, []);
  assert.throws(
    () => assertGraphPresetResponse('adhoc', adHoc, driftedTourResponse()),
    /declares no namedEntrypoints to assert/,
  );
});

await test('every checked-in preset names entrypoints that are declared on disk', () => {
  for (const name of listPresetNames()) {
    const preset = readPreset(name);
    const cwd = resolve(preset.cwd ?? repoRoot);
    assert.ok(preset.namedEntrypoints.length > 0, `${name} declares named entrypoints`);
    for (const entry of preset.namedEntrypoints) {
      const path = join(cwd, entry.file);
      assert.ok(existsSync(path), `${name}: ${entry.file} exists`);
      const source = readFileSync(path, 'utf8');
      const [owner, ...members] = entry.name.split('.');
      // The declaring file names the symbol either in a declaration or in a
      // local export list (`export { owner }`, `export type { owner }`). A
      // re-export (`export { owner } from`) or an alias target (`x as owner`)
      // is not a declaration the graph cites under that file, and anonymous
      // `export default` declarations have no name the graph could cite.
      const declaration = new RegExp(
        `\\b(?:function\\*?|const|let|var|class|enum|interface|type)\\s+${owner}\\b` +
          `|export\\s*(?:type\\s+)?\\{[^}]*(?<!\\bas\\s+)\\b${owner}\\b[^}]*\\}(?!\\s*from\\b)`,
      );
      assert.match(source, declaration, `${name}: ${entry.file} declares ${owner}`);
      for (const member of members) {
        assert.ok(source.includes(member), `${name}: ${entry.file} mentions ${member}`);
      }
    }
    if (preset.props.request.type === 'tour') {
      const raw = parseObject(readFileSync(join(repoRoot, 'tools/graph/requests', `${name}.json`), 'utf8'), name);
      assert.equal(object(raw.request, 'request').reinterpretations, undefined, `${name}: reinterpretations are derived, not checked in`);
      assert.deepEqual(
        preset.props.request.reinterpretations,
        preset.namedEntrypoints.map((entry) => entry.name),
        `${name}: tour seeds exactly its named entrypoints`,
      );
    }
  }
});
