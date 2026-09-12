import assert from 'node:assert/strict';

// Invoked in both modes by the untransformed Node smoke runner.
const expected = process.argv.includes('--expect-failure') ? 2 : 1;
assert.equal(1, expected, 'MPGD_ASSERTION_CANARY');
process.stdout.write('MPGD_ASSERTION_CANARY_PASSED\n');
