import { readFile } from 'node:fs/promises';

import { Miniflare } from 'miniflare';

import { createD1IdentityStore } from './d1Store.js';
import { runGuestIdentityConformance } from './identityConformance.js';

const miniflare = new Miniflare({
  modules: true,
  script: `export default { fetch() { return new Response('ok'); } };`,
  d1Databases: { DB: 'identity-store' },
});

async function applyMigration(db: D1Database): Promise<void> {
  const sql = await readFile(
    new URL('../migrations/0001_guest_identity.sql', import.meta.url),
    'utf8',
  );
  const statements = sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
  for (const statement of statements) {
    await db.prepare(statement).run();
  }
}

try {
  const db = await miniflare.getD1Database('DB') as unknown as D1Database;
  await applyMigration(db);
  // Applying the migration twice is harmless.
  await applyMigration(db);
  await runGuestIdentityConformance(async () => {
    for (const table of [
      'identity_players',
      'identity_session_families',
      'identity_refresh_tokens',
      'identity_access_tokens',
    ]) {
      await db.prepare(`DELETE FROM ${table}`).run();
    }
    return createD1IdentityStore(db);
  });
  console.info('Guest identity service (D1 store) passed.');
} finally {
  await miniflare.dispose();
}
