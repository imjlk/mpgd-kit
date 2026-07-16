const server = await import('../dist/server.js');

for (const exportName of [
  'createVerse8AdsEvidenceVerifier',
  'createVerse8AdsVerifierHttpClient',
  'defaultVerse8AdsVerifierBaseUrl',
  'Verse8AdsVerifierHttpError',
]) {
  if (!(exportName in server)) {
    throw new Error(`Missing @mpgd/adapter-verse8/server export: ${exportName}`);
  }
}

console.log('@mpgd/adapter-verse8/server Node ESM import passed.');
