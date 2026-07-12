const server = await import('../dist/server/index.js');

for (const exportName of [
  'createDevvitPostOperationCoordinator',
  'createDevvitRedisPostOperationStore',
  'defineDevvitPostOperation',
]) {
  if (typeof server[exportName] !== 'function') {
    throw new Error(`Missing @mpgd/adapter-devvit/server export: ${exportName}`);
  }
}

console.log('@mpgd/adapter-devvit/server Node ESM import passed.');
