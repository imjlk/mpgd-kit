import assert from 'node:assert/strict';

import {
  resolvePlayBillingAccountBinding,
  resolveStoreKitAppAccountToken,
} from '../../../examples/phaser-starter/src/platform/commerceAccountBinding.js';
import { deriveAppAccountToken, deriveObfuscatedAccountId } from './accountBinding.js';
import { runGuestIdentityConformance } from './identityConformance.js';
import { createMemoryIdentityStore } from './store.js';

await runGuestIdentityConformance(async () => createMemoryIdentityStore());

// The server derives exactly what the generated game binds on the device
// (the starter's commerceAccountBinding.ts, kept byte-identical to the template's).
for (const playerId of [
  'p_0123456789abcdef0123456789abcdef',
  'p_ffffffffffffffffffffffffffffffff',
]) {
  const gateway = {
    identity: {
      async getPlayer() {
        return null;
      },
      async getSession() {
        return { identityLevel: 'authenticated', trustLevel: 'server-verified', playerId } as const;
      },
    },
  };
  assert.deepEqual(await resolvePlayBillingAccountBinding(gateway), {
    kind: 'obfuscated-account-id',
    value: await deriveObfuscatedAccountId(playerId),
  });
  assert.equal(
    await resolveStoreKitAppAccountToken(gateway),
    await deriveAppAccountToken(playerId),
  );
}
// A fixed vector, so a change on both sides at once is still noticed.
assert.equal(
  await deriveObfuscatedAccountId('p_0123456789abcdef0123456789abcdef'),
  '491d3dd8d314dcec68918da198762efdd39f6ba5701f598e42215c395c893eaf',
);
assert.equal(
  await deriveAppAccountToken('p_0123456789abcdef0123456789abcdef'),
  '491d3dd8-d314-5cec-a891-8da198762efd',
);

console.info('Guest identity service (memory store) passed.');
