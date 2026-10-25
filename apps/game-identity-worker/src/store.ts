/**
 * Storage of the guest identity service. Every row carries `player_id`, so
 * deleting a player (L3b) is one key across every table. Tokens are stored
 * only as SHA-256 hashes. Times are epoch milliseconds.
 */
export interface IdentitySessionFamily {
  /** Stable for the session's whole life: the `sessionFamilyId` and the notifications `sessionId`. */
  readonly familyId: string;
  readonly playerId: string;
  /** The installation the guest was issued for; the identity service vouches for it from then on. */
  readonly installationId: string;
  readonly createdAt: number;
  /** When the family ends unless refreshed first (the inactivity window, sliding). */
  readonly expiresAt: number;
  readonly revokedAt?: number;
  readonly revokeReason?: IdentityRevokeReason;
  /** The one refresh token that rotates the family. */
  readonly currentRefreshHash: string;
  /** The token `currentRefreshHash` replaced: a retry of it within the grace window is not a replay. */
  readonly previousRefreshHash?: string;
  /** When `previousRefreshHash` was replaced. */
  readonly rotatedAt?: number;
}

export type IdentityRevokeReason = 'logout' | 'refresh-token-reuse';

export interface IdentityAccessToken {
  readonly tokenHash: string;
  readonly familyId: string;
  readonly playerId: string;
  readonly expiresAt: number;
}

export interface IdentityStore {
  /** Families issued for `installationId` at or after `since`. */
  countFamiliesIssuedSince(installationId: string, since: number): Promise<number>;
  /** Writes a new player and its first family, refresh token, and access token, all or nothing. */
  createGuest(input: {
    readonly playerId: string;
    readonly family: IdentitySessionFamily;
    readonly access: IdentityAccessToken;
  }): Promise<void>;
  /** The family a refresh token was ever issued in, or `undefined`. */
  findRefreshToken(tokenHash: string): Promise<{ readonly familyId: string } | undefined>;
  getFamily(familyId: string): Promise<IdentitySessionFamily | undefined>;
  /**
   * Compare-and-swap rotation, all or nothing: when the family is live at
   * `now` and its current refresh hash is `expected.currentRefreshHash`
   * (and, when given, its previous one is `expected.previousRefreshHash`),
   * makes `next.currentRefreshHash` current, sets the previous hash, its
   * time, and the new end, records the new refresh token, and writes the
   * access token. `false` when the family changed first.
   */
  rotate(input: {
    readonly familyId: string;
    readonly now: number;
    readonly expected: { readonly currentRefreshHash: string; readonly previousRefreshHash?: string };
    readonly next: {
      readonly currentRefreshHash: string;
      readonly previousRefreshHash: string;
      readonly rotatedAt: number;
      readonly expiresAt: number;
    };
    readonly access: IdentityAccessToken;
  }): Promise<boolean>;
  /** Revokes a live family and deletes its access tokens; `false` when it was already revoked. */
  revokeFamily(familyId: string, reason: IdentityRevokeReason, at: number): Promise<boolean>;
  /** An access token with its family, or `undefined`. */
  findAccessToken(
    tokenHash: string,
  ): Promise<{ readonly access: IdentityAccessToken; readonly family: IdentitySessionFamily } | undefined>;
  hasPlayer(playerId: string): Promise<boolean>;
  /**
   * Upkeep, bounded per call: access tokens past their end, refresh tokens
   * issued before `refreshTokensBefore` (too old to tell a replay from an
   * unknown token), and families (with their tokens) that ended, by
   * revocation or inactivity, before `familiesEndedBefore`. Players stay.
   */
  purge(input: {
    readonly now: number;
    readonly refreshTokensBefore: number;
    readonly familiesEndedBefore: number;
  }): Promise<void>;
}

/** An in-memory store for tests and local development (`IDENTITY_STORE = "memory"`). */
export function createMemoryIdentityStore(): IdentityStore {
  const players = new Set<string>();
  const families = new Map<string, IdentitySessionFamily>();
  const refreshTokens = new Map<string, { familyId: string; issuedAt: number }>();
  const accessTokens = new Map<string, IdentityAccessToken>();
  const live = (family: IdentitySessionFamily, now: number) =>
    family.revokedAt === undefined && family.expiresAt > now;
  return {
    async countFamiliesIssuedSince(installationId, since) {
      return [...families.values()]
        .filter((family) => family.installationId === installationId && family.createdAt >= since)
        .length;
    },
    async createGuest({ playerId, family, access }) {
      if (players.has(playerId) || families.has(family.familyId)
        || refreshTokens.has(family.currentRefreshHash) || accessTokens.has(access.tokenHash)) {
        throw new Error('Identity row already exists.');
      }
      players.add(playerId);
      families.set(family.familyId, family);
      refreshTokens.set(family.currentRefreshHash, { familyId: family.familyId, issuedAt: family.createdAt });
      accessTokens.set(access.tokenHash, access);
    },
    async findRefreshToken(tokenHash) {
      const row = refreshTokens.get(tokenHash);
      return row === undefined ? undefined : { familyId: row.familyId };
    },
    async getFamily(familyId) {
      return families.get(familyId);
    },
    async rotate({ familyId, now, expected, next, access }) {
      const family = families.get(familyId);
      if (family === undefined || !live(family, now)
        || family.currentRefreshHash !== expected.currentRefreshHash
        || (expected.previousRefreshHash !== undefined
          && family.previousRefreshHash !== expected.previousRefreshHash)) {
        return false;
      }
      families.set(familyId, { ...family, ...next });
      refreshTokens.set(next.currentRefreshHash, { familyId, issuedAt: now });
      accessTokens.set(access.tokenHash, access);
      return true;
    },
    async revokeFamily(familyId, reason, at) {
      const family = families.get(familyId);
      if (family === undefined || family.revokedAt !== undefined) {
        return false;
      }
      families.set(familyId, { ...family, revokedAt: at, revokeReason: reason });
      for (const [hash, access] of accessTokens) {
        if (access.familyId === familyId) {
          accessTokens.delete(hash);
        }
      }
      return true;
    },
    async findAccessToken(tokenHash) {
      const access = accessTokens.get(tokenHash);
      const family = access === undefined ? undefined : families.get(access.familyId);
      return access === undefined || family === undefined ? undefined : { access, family };
    },
    async hasPlayer(playerId) {
      return players.has(playerId);
    },
    async purge({ now, refreshTokensBefore, familiesEndedBefore }) {
      for (const [hash, access] of accessTokens) {
        if (access.expiresAt <= now) {
          accessTokens.delete(hash);
        }
      }
      for (const [hash, row] of refreshTokens) {
        if (row.issuedAt < refreshTokensBefore) {
          refreshTokens.delete(hash);
        }
      }
      for (const [familyId, family] of families) {
        const endedAt = family.revokedAt ?? family.expiresAt;
        if (endedAt < familiesEndedBefore) {
          families.delete(familyId);
          for (const [hash, row] of refreshTokens) {
            if (row.familyId === familyId) {
              refreshTokens.delete(hash);
            }
          }
          for (const [hash, access] of accessTokens) {
            if (access.familyId === familyId) {
              accessTokens.delete(hash);
            }
          }
        }
      }
    },
  };
}
