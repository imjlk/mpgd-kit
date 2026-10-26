import type { PlayerDataEraser } from '@mpgd/game-services';

/**
 * Account deletion tombstones (docs/GAME_SERVICES_BACKEND.md#account-deletion).
 *
 * After a deletion, a write can still arrive for the player: a request that
 * authenticated before the identity was deleted, a cron run that loaded the
 * player, or an AdMob SSV callback Google delivers late. Every player-keyed
 * write path checks the tombstone and refuses, so nothing new lands under the
 * deleted id once the erasure has started; the final erasure pass removes
 * what an operation already past its check wrote.
 *
 * A tombstone is an HMAC-SHA-256 of the player id under a deployment secret
 * (`GAME_SERVICES_ACCOUNT_DELETION_TOMBSTONE_KEY`), never the id itself, and it
 * expires (`accountDeletionTombstoneTtlMs`). It is pseudonymous (without the
 * key it names no one, and a low-entropy player id cannot be guessed from
 * it), time-bound, and exists only to enforce the deletion, which is why it
 * is compatible with erasing the account (개인정보 보호법 art. 21: destroy
 * what is no longer needed; this is needed, and only for that period).
 */

/**
 * How long a tombstone refuses writes: 30 days, far past an access token's
 * 15 minutes, a request's or cron run's longest run, and the delays of
 * AdMob SSV retries and notification schedules.
 */
export const accountDeletionTombstoneTtlMs = 30 * 24 * 60 * 60 * 1000;

/** The key a memory deployment (local development only) uses; nothing it hashes outlives the isolate. */
const memoryTombstoneKey = 'mpgd-account-deletion-tombstone-memory-key';

/** The shortest `GAME_SERVICES_ACCOUNT_DELETION_TOMBSTONE_KEY` accepted. */
export const accountDeletionTombstoneKeyMinLength = 32;

/** A write for a deleted player, refused. Its message names no player. */
export class AccountDeletedWriteError extends Error {
  readonly code = 'ACCOUNT_DELETED';

  constructor() {
    super('The player was deleted; the write is refused.');
    this.name = 'AccountDeletedWriteError';
  }
}

export interface AccountDeletionTombstones {
  /** Records the player's deletion at `at` (idempotent; a later call extends the expiry). */
  add(playerId: string, at: Date): Promise<void>;
  /** Whether the player has a live tombstone at `at`. */
  isDeleted(playerId: string, at?: Date): Promise<boolean>;
  /** Deletes the tombstones that expired by `at`; answers how many. */
  purgeExpired(at: Date): Promise<number>;
}

/** The stored form of a player id: lowercase hex HMAC-SHA-256 under `key`. */
export async function accountDeletionTombstoneKeyOf(key: string, playerId: string): Promise<string> {
  const encoder = new TextEncoder();
  const hmac = await crypto.subtle.importKey(
    'raw',
    encoder.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', hmac, encoder.encode(playerId)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Tombstones in D1 (`account_deletion_tombstones`, migration 0010). */
export function createD1AccountDeletionTombstones(db: D1Database, key: string): AccountDeletionTombstones {
  return {
    async add(playerId, at) {
      const expiresAt = new Date(at.getTime() + accountDeletionTombstoneTtlMs).toISOString();
      await db.prepare(`INSERT INTO account_deletion_tombstones (player_key, expires_at) VALUES (?1, ?2)
          ON CONFLICT (player_key) DO UPDATE SET expires_at = max(expires_at, excluded.expires_at)`)
        .bind(await accountDeletionTombstoneKeyOf(key, playerId), expiresAt)
        .run();
    },
    async isDeleted(playerId, at = new Date()) {
      return await db.prepare(
        'SELECT 1 AS found FROM account_deletion_tombstones WHERE player_key = ?1 AND expires_at > ?2',
      ).bind(await accountDeletionTombstoneKeyOf(key, playerId), at.toISOString()).first() !== null;
    },
    async purgeExpired(at) {
      const purged = await db.prepare('DELETE FROM account_deletion_tombstones WHERE expires_at <= ?1')
        .bind(at.toISOString())
        .run();
      return purged.meta.changes ?? 0;
    },
  };
}

/** Tombstones in this isolate's memory, for a memory deployment (local development only). */
export function createMemoryAccountDeletionTombstones(
  key: string = memoryTombstoneKey,
): AccountDeletionTombstones {
  const expiries = new Map<string, number>();
  return {
    async add(playerId, at) {
      const stored = await accountDeletionTombstoneKeyOf(key, playerId);
      expiries.set(
        stored,
        Math.max(expiries.get(stored) ?? 0, at.getTime() + accountDeletionTombstoneTtlMs),
      );
    },
    async isDeleted(playerId, at = new Date()) {
      return (expiries.get(await accountDeletionTombstoneKeyOf(key, playerId)) ?? 0) > at.getTime();
    },
    async purgeExpired(at) {
      let purged = 0;
      for (const [stored, expiresAt] of expiries) {
        if (expiresAt <= at.getTime()) {
          expiries.delete(stored);
          purged += 1;
        }
      }
      return purged;
    },
  };
}

/**
 * The tombstone as an eraser: registered first, so writes are refused from
 * the moment the erasure starts. The final pass writes it again, which
 * extends it from then.
 */
export function createAccountDeletionTombstoneEraser(
  tombstones: AccountDeletionTombstones,
  now: () => Date = () => new Date(),
): PlayerDataEraser {
  return {
    async erasePlayerData({ playerId }) {
      await tombstones.add(playerId, now());
      return { deleted: 0, retained: 0 };
    },
  };
}

/**
 * `target` with the named write methods refusing a deleted player
 * (`AccountDeletedWriteError`, before anything is written). Each entry names
 * the method and reads the player id from its arguments (`undefined`: no
 * player, not checked). Every other member is `target`'s own.
 */
export function refuseDeletedPlayerWrites<Target extends object>(
  target: Target,
  tombstones: AccountDeletionTombstones,
  writes: Readonly<Partial<Record<keyof Target & string, (args: readonly unknown[]) => unknown>>>,
): Target {
  return new Proxy(target, {
    get(object, property, receiver) {
      const value: unknown = Reflect.get(object, property, receiver);
      if (typeof value !== 'function') {
        return value;
      }
      const playerOf = typeof property === 'string'
        ? (writes as Readonly<Record<string, ((args: readonly unknown[]) => unknown) | undefined>>)[property]
        : undefined;
      if (playerOf === undefined) {
        return (...args: unknown[]) =>
          (value as (...rest: unknown[]) => unknown).apply(object, args);
      }
      return async (...args: unknown[]) => {
        const playerId = playerOf(args);
        if (typeof playerId === 'string' && await tombstones.isDeleted(playerId)) {
          throw new AccountDeletedWriteError();
        }
        return (value as (...rest: unknown[]) => unknown).apply(object, args);
      };
    },
  });
}

/** The first argument's `key` property, for `refuseDeletedPlayerWrites`. */
export function argumentField(key: string): (args: readonly unknown[]) => unknown {
  return (args) => {
    const first = args[0];
    return typeof first === 'object' && first !== null
      ? (first as Record<string, unknown>)[key]
      : undefined;
  };
}

/** What `resolveAccountDeletionTombstones` reads from a Worker's environment. */
export interface AccountDeletionTombstonesEnv {
  readonly MPGD_STORE?: 'memory' | 'd1';
  readonly DB?: D1Database;
  /**
   * The HMAC key of the deletion tombstones (a secret, at least
   * `accountDeletionTombstoneKeyMinLength` characters; generate one with
   * `openssl rand -base64 48`). Required before a D1 deployment deletes
   * accounts. Changing it forgets the live tombstones.
   */
  readonly GAME_SERVICES_ACCOUNT_DELETION_TOMBSTONE_KEY?: string;
}

/** This isolate's tombstones for a memory deployment. */
let memoryTombstones: AccountDeletionTombstones | undefined;
let reportedShortKey = false;

/**
 * The deployment's tombstones: D1 with the configured key, this isolate's
 * memory for a memory deployment, or `undefined` for a D1 deployment
 * without a (long enough) key, which then deletes no accounts.
 */
export function resolveAccountDeletionTombstones(
  env: AccountDeletionTombstonesEnv,
): AccountDeletionTombstones | undefined {
  if (env.MPGD_STORE !== 'd1') {
    memoryTombstones ??= createMemoryAccountDeletionTombstones();
    return memoryTombstones;
  }
  const key = env.GAME_SERVICES_ACCOUNT_DELETION_TOMBSTONE_KEY?.trim();
  if (env.DB === undefined || key === undefined || key.length === 0) {
    return undefined;
  }
  if (key.length < accountDeletionTombstoneKeyMinLength) {
    if (!reportedShortKey) {
      reportedShortKey = true;
      console.error(
        `GAME_SERVICES_ACCOUNT_DELETION_TOMBSTONE_KEY must be at least ${accountDeletionTombstoneKeyMinLength} characters; account deletion stays off.`,
      );
    }
    return undefined;
  }
  return createD1AccountDeletionTombstones(env.DB, key);
}
