import type {
  IdentityAccessToken,
  IdentityRevokeReason,
  IdentitySessionFamily,
  IdentityStore,
} from './store.js';

/** Rows one purge statement deletes at most; the next scheduled run continues a backlog. */
export const d1IdentityPurgeBatch = 500;

interface FamilyRow {
  readonly family_id: string;
  readonly player_id: string;
  readonly installation_id: string;
  readonly created_at_ms: number;
  readonly expires_at_ms: number;
  readonly revoked_at_ms: number | null;
  readonly revoke_reason: string | null;
  readonly current_refresh_hash: string;
  readonly previous_refresh_hash: string | null;
  readonly rotated_at_ms: number | null;
  readonly rotation_nonce: string | null;
}

const familyColumns = 'f.family_id, f.player_id, f.installation_id, f.created_at_ms, f.expires_at_ms, '
  + 'f.revoked_at_ms, f.revoke_reason, f.current_refresh_hash, f.previous_refresh_hash, f.rotated_at_ms, '
  + 'f.rotation_nonce';

/**
 * The identity store on D1 (migrations/0001_guest_identity.sql). Every
 * multi-row write is one `batch`, which D1 runs as a transaction; the
 * rotation is a compare-and-swap on the family's current refresh hash, and
 * the rows it adds are inserted only when that swap took effect.
 */
export function createD1IdentityStore(
  db: D1Database,
  options: { readonly purgeBatch?: number } = {},
): IdentityStore {
  const purgeBatch = options.purgeBatch ?? d1IdentityPurgeBatch;
  return {
    async createGuest({ playerId, family, access, limit }) {
      // The family row goes first, only under the limit (one transaction, so
      // concurrent requests are serialized); the other rows follow it.
      const created = 'EXISTS (SELECT 1 FROM identity_session_families WHERE family_id = ?1)';
      const [familyInsert] = await db.batch([
        db.prepare(
          'INSERT INTO identity_session_families (family_id, player_id, installation_id, created_at_ms, '
            + 'expires_at_ms, current_refresh_hash) SELECT ?1, ?2, ?3, ?4, ?5, ?6 '
            + 'WHERE (SELECT COUNT(*) FROM identity_session_families WHERE installation_id = ?3 '
            + 'AND created_at_ms >= ?7) < ?8',
        ).bind(
          family.familyId,
          family.playerId,
          family.installationId,
          family.createdAt,
          family.expiresAt,
          family.currentRefreshHash,
          limit.since,
          limit.max,
        ),
        db.prepare(`INSERT INTO identity_players (player_id, created_at_ms) SELECT ?2, ?3 WHERE ${created}`)
          .bind(family.familyId, playerId, family.createdAt),
        db.prepare(
          'INSERT INTO identity_refresh_tokens (token_hash, family_id, player_id, issued_at_ms) '
            + `SELECT ?2, ?1, ?3, ?4 WHERE ${created}`,
        ).bind(family.familyId, family.currentRefreshHash, family.playerId, family.createdAt),
        db.prepare(
          'INSERT INTO identity_access_tokens (token_hash, family_id, player_id, expires_at_ms) '
            + `SELECT ?2, ?1, ?3, ?4 WHERE ${created}`,
        ).bind(family.familyId, access.tokenHash, access.playerId, access.expiresAt),
      ]);
      return familyInsert?.meta.changes === 1;
    },

    async findRefreshToken(tokenHash) {
      const row = await db.prepare('SELECT family_id FROM identity_refresh_tokens WHERE token_hash = ?1')
        .bind(tokenHash)
        .first<{ family_id: string }>();
      return row === null ? undefined : { familyId: row.family_id };
    },

    async getFamily(familyId) {
      const row = await db.prepare(`SELECT ${familyColumns} FROM identity_session_families f WHERE f.family_id = ?1`)
        .bind(familyId)
        .first<FamilyRow>();
      return row === null ? undefined : toFamily(row);
    },

    async rotate({ familyId, now, expected, next, access }) {
      const [swap] = await db.batch([
        db.prepare(
          'UPDATE identity_session_families SET current_refresh_hash = ?1, previous_refresh_hash = ?2, '
            + 'rotated_at_ms = ?3, expires_at_ms = ?4, rotation_nonce = ?8 WHERE family_id = ?5 '
            + 'AND current_refresh_hash = ?6 AND revoked_at_ms IS NULL AND expires_at_ms > ?7',
        ).bind(
          next.currentRefreshHash,
          next.previousRefreshHash,
          next.rotatedAt,
          next.expiresAt,
          familyId,
          expected.currentRefreshHash,
          now,
          next.rotationNonce,
        ),
        // Only when the swap above took effect: the new hash is current only then.
        db.prepare(
          'INSERT INTO identity_refresh_tokens (token_hash, family_id, player_id, issued_at_ms) '
            + 'SELECT ?1, family_id, player_id, ?2 FROM identity_session_families '
            + 'WHERE family_id = ?3 AND current_refresh_hash = ?1',
        ).bind(next.currentRefreshHash, now, familyId),
        db.prepare(
          'INSERT INTO identity_access_tokens (token_hash, family_id, player_id, expires_at_ms) '
            + 'SELECT ?1, family_id, player_id, ?2 FROM identity_session_families '
            + 'WHERE family_id = ?3 AND current_refresh_hash = ?4',
        ).bind(access.tokenHash, access.expiresAt, familyId, next.currentRefreshHash),
      ]);
      return swap?.meta.changes === 1;
    },

    async addAccessToken({ now, currentRefreshHash, access }) {
      const inserted = await db.prepare(
        'INSERT INTO identity_access_tokens (token_hash, family_id, player_id, expires_at_ms) '
          + 'SELECT ?1, family_id, player_id, ?2 FROM identity_session_families '
          + 'WHERE family_id = ?3 AND current_refresh_hash = ?4 AND revoked_at_ms IS NULL AND expires_at_ms > ?5',
      ).bind(access.tokenHash, access.expiresAt, access.familyId, currentRefreshHash, now).run();
      return inserted.meta.changes === 1;
    },

    async revokeFamily(familyId: string, reason: IdentityRevokeReason, at: number) {
      const [revoked] = await db.batch([
        db.prepare(
          'UPDATE identity_session_families SET revoked_at_ms = ?1, revoke_reason = ?2 '
            + 'WHERE family_id = ?3 AND revoked_at_ms IS NULL',
        ).bind(at, reason, familyId),
        db.prepare('DELETE FROM identity_access_tokens WHERE family_id = ?1').bind(familyId),
      ]);
      return revoked?.meta.changes === 1;
    },

    async findAccessToken(tokenHash) {
      const row = await db.prepare(
        `SELECT a.token_hash, a.expires_at_ms AS access_expires_at_ms, ${familyColumns} `
          + 'FROM identity_access_tokens a JOIN identity_session_families f ON f.family_id = a.family_id '
          + 'WHERE a.token_hash = ?1',
      ).bind(tokenHash).first<FamilyRow & { token_hash: string; access_expires_at_ms: number }>();
      if (row === null) {
        return undefined;
      }
      const family = toFamily(row);
      return {
        access: {
          tokenHash: row.token_hash,
          familyId: family.familyId,
          playerId: family.playerId,
          expiresAt: row.access_expires_at_ms,
        },
        family,
      };
    },

    async hasPlayer(playerId) {
      return await db.prepare('SELECT 1 AS found FROM identity_players WHERE player_id = ?1')
        .bind(playerId)
        .first() !== null;
    },

    async purge({ now, refreshTokensBefore, familiesEndedBefore }) {
      // Two indexed scans: revoked families, and live ones whose inactivity window passed.
      const ended = await db.prepare(
        'SELECT family_id FROM (SELECT family_id FROM identity_session_families WHERE revoked_at_ms IS NOT NULL AND revoked_at_ms < ?1 LIMIT ?2) '
          + 'UNION SELECT family_id FROM (SELECT family_id FROM identity_session_families '
          + 'WHERE revoked_at_ms IS NULL AND expires_at_ms < ?1 LIMIT ?2)',
      ).bind(familiesEndedBefore, purgeBatch).all<{ family_id: string }>();
      const endedIds = JSON.stringify(ended.results.map((row) => row.family_id));
      const [accessDeleted, refreshDeleted] = await db.batch([
        db.prepare(
          'DELETE FROM identity_access_tokens WHERE rowid IN '
            + '(SELECT rowid FROM identity_access_tokens WHERE expires_at_ms <= ?1 LIMIT ?2)',
        ).bind(now, purgeBatch),
        // Never a token a family still holds as its current or previous one:
        // a family issued under a longer inactivity window outlives the cutoff.
        db.prepare(
          'DELETE FROM identity_refresh_tokens WHERE rowid IN '
            + '(SELECT t.rowid FROM identity_refresh_tokens t WHERE t.issued_at_ms < ?1 '
            + 'AND NOT EXISTS (SELECT 1 FROM identity_session_families f WHERE f.family_id = t.family_id '
            + 'AND (f.current_refresh_hash = t.token_hash OR f.previous_refresh_hash = t.token_hash)) LIMIT ?2)',
        ).bind(refreshTokensBefore, purgeBatch),
        db.prepare('DELETE FROM identity_refresh_tokens WHERE family_id IN (SELECT value FROM json_each(?1))')
          .bind(endedIds),
        db.prepare('DELETE FROM identity_access_tokens WHERE family_id IN (SELECT value FROM json_each(?1))')
          .bind(endedIds),
        db.prepare('DELETE FROM identity_session_families WHERE family_id IN (SELECT value FROM json_each(?1))')
          .bind(endedIds),
      ]);
      // A full batch anywhere (each family scan can return `purgeBatch` ids) means more may remain.
      return {
        more: ended.results.length >= purgeBatch
          || (accessDeleted?.meta.changes ?? 0) >= purgeBatch
          || (refreshDeleted?.meta.changes ?? 0) >= purgeBatch,
      };
    },
  };
}

function toFamily(row: FamilyRow): IdentitySessionFamily {
  return {
    familyId: row.family_id,
    playerId: row.player_id,
    installationId: row.installation_id,
    createdAt: row.created_at_ms,
    expiresAt: row.expires_at_ms,
    currentRefreshHash: row.current_refresh_hash,
    ...(row.revoked_at_ms === null ? {} : { revokedAt: row.revoked_at_ms }),
    ...(row.revoke_reason === 'logout' || row.revoke_reason === 'refresh-token-reuse'
      ? { revokeReason: row.revoke_reason }
      : {}),
    ...(row.previous_refresh_hash === null ? {} : { previousRefreshHash: row.previous_refresh_hash }),
    ...(row.rotated_at_ms === null ? {} : { rotatedAt: row.rotated_at_ms }),
    ...(row.rotation_nonce === null ? {} : { rotationNonce: row.rotation_nonce }),
  };
}
