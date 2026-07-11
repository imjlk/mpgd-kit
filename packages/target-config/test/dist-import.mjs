import assert from 'node:assert/strict';

const targetConfig = await import('../dist/index.js');
const plan = targetConfig.resolveTargetViewportPlan({
  width: 430,
  height: 860,
  runtime: 'devvit-web',
  orientationPolicy: {
    mode: 'responsive',
    mismatchBehavior: 'continue',
  },
});

assert.equal(plan.layout.orientation, 'portrait');
assert.equal(plan.layout.shell, 'embedded-webview');
assert.equal(plan.orientation.mode, 'responsive');
console.log('Target config dist import passed.');
