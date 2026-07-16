const agent8 = await import('../dist/agent8.js');

if (!('createVerse8Agent8CommerceService' in agent8)) {
  throw new Error('Missing @mpgd/adapter-verse8/agent8 export: createVerse8Agent8CommerceService');
}

if (!('createVerse8Agent8StorageService' in agent8)) {
  throw new Error('Missing @mpgd/adapter-verse8/agent8 export: createVerse8Agent8StorageService');
}

if (!('createVerse8Agent8LeaderboardBoundary' in agent8)) {
  throw new Error(
    'Missing @mpgd/adapter-verse8/agent8 export: createVerse8Agent8LeaderboardBoundary',
  );
}

console.log('@mpgd/adapter-verse8/agent8 Node ESM import passed.');
