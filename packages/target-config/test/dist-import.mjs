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
const snapshot = targetConfig.resolveTargetViewportSnapshot({
  width: 390,
  height: 844,
  runtime: 'capacitor-ios',
  safeAreaInsets: {
    top: 47,
    bottom: 34,
  },
});

assert.deepEqual(snapshot.safeArea.contentBounds, {
  x: 0,
  y: 47,
  width: 390,
  height: 763,
});
console.log('Target config dist import passed.');
