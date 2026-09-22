import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  graphResultAnchorCount,
  listPresetNames,
  normalizeRequest,
  readPreset,
  summarizeGraphResult,
} from './graph/local-graph-runtime.mjs';

test('all checked-in presets use the current draft and tour request contracts', () => {
  for (const name of listPresetNames()) {
    const { props } = readPreset(name);
    assert.equal(props.draft.type, props.request.type, name);
    if (props.request.type === 'tour') {
      assert.ok(props.request.reinterpretations.every((value) => typeof value === 'string'), name);
      assert.equal(props.request.query, undefined, name);
    }
  }
});

test('rejects legacy tour requests before invoking the graph application', () => {
  assert.throws(() => normalizeRequest({
    question: 'What runs?', draft: 'Use a tour.', request: { type: 'tour', query: 'run' },
  }, 'legacy.json'), /draft with reason and type/);
  assert.throws(() => normalizeRequest({
    question: 'What runs?', draft: { reason: 'Use a tour.', type: 'tour' },
    request: { type: 'tour', query: 'run' },
  }, 'legacy.json'), /reinterpretations array/);
});

test('uses the envelope next action and counts trace anchors only after resolving the start', () => {
  const result = { type: 'trace', start: { id: 'a' }, reached: [{ id: 'b' }] };
  assert.equal(graphResultAnchorCount(result), 2);
  assert.match(summarizeGraphResult(result, 'answer'), /2 anchors, next=answer$/);
  assert.equal(graphResultAnchorCount({ type: 'trace', candidates: [{ id: 'a' }], reached: [] }), 0);
  assert.equal(graphResultAnchorCount({ type: 'details', nodes: [] }), 0);
});
