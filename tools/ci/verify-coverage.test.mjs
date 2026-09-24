import assert from 'node:assert/strict';
import test from 'node:test';
import { expectedCoverage, verifyCoverage } from './verify-coverage.mjs';

const base = {
  EVENT_NAME: 'pull_request',
  METADATA_ONLY: 'false',
  DOCS_ONLY: 'false',
  DOCS_VALIDATION: 'false',
  RUN_PREPARED: 'true',
  RUN_NATIVE: 'false',
};

test('full scope requires every prepared group and target build', () => {
  const expected = expectedCoverage(base);
  assert.equal(expected['test-prepared'], 'success');
  assert.equal(expected['build-ios'], 'success');
  assert.equal(expected['test-focused'], 'skipped');
  assert.deepEqual(verifyCoverage({ ...base, ...actualResults(expected) }).mismatches, []);
});

test('native scope requires focused and both platform builds, not unrelated suites', () => {
  const flags = { ...base, RUN_PREPARED: 'false', RUN_NATIVE: 'true' };
  const expected = expectedCoverage(flags);
  assert.equal(expected['test-focused'], 'success');
  assert.equal(expected['build-android'], 'success');
  assert.equal(expected['build-ios'], 'success');
  for (const name of ['test-browser', 'compile-tools', 'test-prepared', 'build-web-targets', 'build-ait', 'build-devvit']) {
    assert.equal(expected[name], 'skipped');
  }
  assert.deepEqual(verifyCoverage({ ...flags, ...actualResults(expected) }).mismatches, []);
  const incomplete = verifyCoverage({ ...flags, ...actualResults(expected), IOS_RESULT: 'skipped' });
  assert.match(incomplete.mismatches.join(' '), /build-ios should be success/);
});

test('focused, docs, release metadata, and attested pushes retain their coverage', () => {
  const focused = expectedCoverage({ ...base, RUN_PREPARED: 'false' });
  assert.equal(focused['test-focused'], 'success');
  assert.equal(focused['test-browser'], 'success');
  const docs = expectedCoverage({ ...base, RUN_PREPARED: 'false', DOCS_ONLY: 'true', DOCS_VALIDATION: 'true' });
  assert.equal(docs['docs-validation'], 'success');
  assert.equal(docs['test-browser'], 'skipped');
  const metadata = expectedCoverage({ ...base, RUN_PREPARED: 'false', METADATA_ONLY: 'true' });
  assert.equal(metadata['test-focused'], 'skipped');
  const push = expectedCoverage({ ...base, EVENT_NAME: 'push', RUN_PREPARED: 'false', DOCS_VALIDATION: 'true' });
  assert.equal(push['test-focused'], 'skipped');
  assert.equal(push['test-browser'], 'success');
});

test('missing and contradictory scope outputs fail closed', () => {
  assert.throws(() => expectedCoverage({ ...base, RUN_NATIVE: '' }), /did not classify/);
  assert.throws(() => expectedCoverage({ ...base, RUN_NATIVE: 'true' }), /conflicts/);
  assert.throws(() => expectedCoverage({ ...base, RUN_PREPARED: 'false', RUN_NATIVE: 'true', EVENT_NAME: 'push' }), /conflicts/);
});

function actualResults(expected) {
  return {
    PREPARE_RESULT: expected.prepare,
    DOCS_RESULT: expected['docs-validation'],
    FOCUSED_RESULT: expected['test-focused'],
    BROWSER_RESULT: expected['test-browser'],
    COMPILE_RESULT: expected['compile-tools'],
    PREPARED_RESULT: expected['test-prepared'],
    WEB_TARGETS_RESULT: expected['build-web-targets'],
    ANDROID_RESULT: expected['build-android'],
    IOS_RESULT: expected['build-ios'],
    AIT_RESULT: expected['build-ait'],
    DEVVIT_RESULT: expected['build-devvit'],
  };
}
