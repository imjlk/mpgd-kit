const payments = await import('../dist/payments.js');

if (typeof payments.normalizeDevvitCommerceProducts !== 'function') {
  throw new Error('Missing @mpgd/adapter-devvit/payments product normalizer export.');
}
for (const removed of ['createDevvitCommerceAdapter', 'withDevvitCommerceAdapter']) {
  if (removed in payments) {
    throw new Error(`@mpgd/adapter-devvit/payments must not export the removed v1 ${removed}.`);
  }
}

console.log('@mpgd/adapter-devvit/payments Node ESM import passed.');
