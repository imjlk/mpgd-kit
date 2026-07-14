const payments = await import('../dist/payments.js');

if (typeof payments.createDevvitCommerceAdapter !== 'function') {
  throw new Error('Missing @mpgd/adapter-devvit/payments commerce adapter export.');
}

console.log('@mpgd/adapter-devvit/payments Node ESM import passed.');
