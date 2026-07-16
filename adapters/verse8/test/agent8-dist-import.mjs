const agent8 = await import('../dist/agent8.js');

if (!('createVerse8Agent8CommerceService' in agent8)) {
  throw new Error('Missing @mpgd/adapter-verse8/agent8 export: createVerse8Agent8CommerceService');
}

console.log('@mpgd/adapter-verse8/agent8 Node ESM import passed.');
