import { readFile } from 'node:fs/promises';

import { Miniflare } from 'miniflare';

import assert from 'node:assert/strict';

import { createD1IdentityStore } from './d1Store.js';
import { runGuestIdentityConformance } from './identityConformance.js';
import { createGuestIdentityService, defaultIdentityServiceConfig } from './identityService.js';

const miniflare = new Miniflare({
  modules: true,
  script: `export default { fetch() { return new Response('ok'); } };`,
  d1Databases: { DB: 'identity-store' },
});

async function applyMigration(db: D1Database): Promise<void> {
  const sql = (await Promise.all(
    ['0001_guest_identity.sql', '0002_account_deletion.sql'].map((file) =>
      readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8')),
  )).join('\n');
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
      'identity_deletion_confirmations',
    ]) {
      await db.prepare(`DELETE FROM ${table}`).run();
    }
    return createD1IdentityStore(db);
  });
  // The purge drains a backlog larger than one batch in one run.
  for (const table of [
    'identity_players',
    'identity_session_families',
    'identity_refresh_tokens',
    'identity_access_tokens',
    'identity_deletion_confirmations',
  ]) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }
  let clock = Date.parse('2030-01-01T00:00:00.000Z');
  const service = createGuestIdentityService({
    store: createD1IdentityStore(db, { purgeBatch: 2 }),
    now: () => clock,
    config: { maxGuestsPerInstallationPerDay: 20 },
    log: () => undefined,
  });
  const issued = [];
  for (let index = 0; index < 7; index += 1) {
    const answer = await service.issueGuest({ installationId: `install-drain-${index}0000` });
    assert.ok(answer.ok);
    issued.push(answer.value);
  }
  for (const guest of issued.slice(0, 5)) {
    await service.revoke({ refreshToken: guest.refreshToken });
  }
  clock += defaultIdentityServiceConfig.accessTokenTtlMs + 8 * 24 * 60 * 60 * 1000;
  await service.purge();
  const count = async (table: string) =>
    (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())?.n;
  assert.equal(await count('identity_access_tokens'), 0);
  assert.equal(await count('identity_session_families'), 2);
  assert.equal(await count('identity_refresh_tokens'), 2);
  console.info('Guest identity service (D1 store) passed.');
} finally {
  await miniflare.dispose();
}
