import assert from 'node:assert/strict';

const tutorial = await import('../dist/index.js');
const platformStorage = await import('../dist/platform-storage.js');
const testing = await import('../dist/testing.js');

assert.equal(typeof tutorial.defineTutorial, 'function');
assert.equal(typeof tutorial.createTutorialDirector, 'function');
assert.equal(typeof platformStorage.createPlatformTutorialProgressStore, 'function');
assert.equal(typeof testing.createMemoryTutorialProgressStore, 'function');

const definition = tutorial.defineTutorial({
  id: 'dist-smoke',
  initialScene: 'lobby',
  revision: 1,
  steps: [{
    advance: { kind: 'acknowledge' },
    id: 'welcome',
    interaction: 'blocked',
    scene: 'lobby',
    target: null,
  }],
});
const director = tutorial.createTutorialDirector({
  autoStart: true,
  definition,
  progressStore: testing.createMemoryTutorialProgressStore(),
});
director.acknowledge('welcome');
assert.equal(director.getSnapshot().status, 'completed');
await director.flush();

console.log('@mpgd/tutorial dist import smoke passed.');
