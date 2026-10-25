import type { ServerGuestSessionCredentials } from '@mpgd/game-services/guest-session';

import { deriveAppAccountToken, deriveObfuscatedAccountId } from './accountBinding.js';
import type { IdentityAccessToken, IdentitySessionFamily, IdentityStore } from './store.js';
import {
  accessTokenPrefix,
  createIdentifier,
  createOpaqueToken,
  createRotationNonce,
  deletionConfirmationPrefix,
  deriveRefreshToken,
  hashToken,
  isOpaqueToken,
  readBearerToken,
  refreshTokenPrefix,
} from './tokens.js';

/**
 * Token lifetimes and limits. The defaults follow RFC 9700 (OAuth 2.0
 * Security Best Current Practice), section 4.14.2, for a public client:
 * short-lived access tokens, refresh tokens rotated on every use, and a
 * family that ends after a period of inactivity.
 */
export interface IdentityServiceConfig {
  /** Access token lifetime. Default 15 minutes. */
  readonly accessTokenTtlMs: number;
  /**
   * How long a family lives without a refresh; each refresh extends it.
   * Default 180 days. A guest that stays away longer loses its session (and,
   * without a linked account, its player).
   */
  readonly refreshIdleMs: number;
  /**
   * How long after a rotation the replaced refresh token may be presented
   * again without counting as a replay, while its successor has not been
   * used. A client whose network dropped the rotation's answer, or that the
   * OS suspended mid-request, keeps the old token and presents it at its
   * next refresh, which may be the next launch; strict replay detection
   * would then end the guest for good. A retry is answered with the same
   * successor (`deriveRefreshToken` with the family's rotation nonce), so no
   * answer ever invalidates another. Default 7 days; 0 turns it off (strict
   * RFC 9700 rotation). The cost: a stolen copy of the replaced token can
   * obtain that successor inside the window, and a thief who refreshes first
   * and keeps pace with the device is answered as a retry each time, so it is
   * not detected (docs/CLOUDFLARE_WORKER_DEPLOY.md weighs this).
   */
  readonly refreshRetryGraceMs: number;
  /** New guests per installation in a rolling day. Default 5. */
  readonly maxGuestsPerInstallationPerDay: number;
  /**
   * How long an account deletion confirmation is accepted after it is
   * issued: the time between the player's second tap and the game-services
   * request. Default 5 minutes.
   */
  readonly accountDeletionConfirmationTtlMs: number;
}

/** A configuration the service refuses; its message names the rule and holds no secret. */
export class IdentityConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdentityConfigurationError';
  }
}

export const defaultIdentityServiceConfig: IdentityServiceConfig = Object.freeze({
  accessTokenTtlMs: 15 * 60 * 1000,
  refreshIdleMs: 180 * 24 * 60 * 60 * 1000,
  refreshRetryGraceMs: 7 * 24 * 60 * 60 * 1000,
  maxGuestsPerInstallationPerDay: 5,
  accountDeletionConfirmationTtlMs: 5 * 60 * 1000,
});

/** An authenticated access token: who, which session, which installation, and when the session ends. */
export interface IdentityPrincipal {
  readonly playerId: string;
  readonly sessionId: string;
  readonly installationId: string;
  /** The family's end (ISO 8601), not the access token's. */
  readonly expiresAt: string;
}

export type IdentityRefusal =
  | 'INVALID_REQUEST'
  | 'GUEST_SESSION_REJECTED'
  | 'RATE_LIMITED'
  | 'ACCOUNT_BINDING_UNSUPPORTED'
  /**
   * The refresh lost a race to legitimate rotations of the same family after
   * it read its token as current or as a valid retry (an abandoned request
   * resuming late). Not a replay: nothing is revoked, and the client retries
   * with the newest token it holds.
   */
  | 'UNAVAILABLE';

export type IdentityResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: IdentityRefusal };

export interface GuestIdentityService {
  issueGuest(input: { readonly installationId: unknown }): Promise<IdentityResult<ServerGuestSessionCredentials>>;
  refresh(input: { readonly refreshToken: unknown }): Promise<IdentityResult<ServerGuestSessionCredentials>>;
  /** Ends the token's family. An unknown or malformed token is not an error (RFC 7009 section 2.2). */
  revoke(input: { readonly refreshToken: unknown }): Promise<void>;
  /** The seam for account linking (Sign in with Apple, Google): not supported by this service. */
  bindAccount(input: unknown): Promise<IdentityResult<never>>;
  /** The principal of an `Authorization: Bearer <access token>` header, or `undefined`. */
  authenticate(authorization: unknown): Promise<IdentityPrincipal | undefined>;
  /** Google Play `obfuscatedAccountId` of a known player, or `undefined`. */
  resolveObfuscatedAccountId(playerId: unknown): Promise<string | undefined>;
  /** StoreKit `appAccountToken` of a known player, or `undefined`. */
  resolveAppAccountToken(playerId: unknown): Promise<string | undefined>;
  /**
   * An account deletion confirmation for the refresh token's player (L3b):
   * the second proof, besides the access token, that the game-services
   * deletion route requires, so a stolen access token alone cannot delete
   * the account. The token must be the family's current refresh token, or
   * the replaced one inside the retry grace while its successor is unused;
   * it is not rotated. Any other token is `GUEST_SESSION_REJECTED`, without
   * revoking anything (the refresh route detects replays). Issuing one
   * replaces the family's earlier confirmation.
   */
  issueAccountDeletionConfirmation(input: {
    readonly refreshToken: unknown;
  }): Promise<IdentityResult<{ readonly confirmation: string; readonly expiresAt: string }>>;
  /**
   * Whether `confirmation` was issued to `playerId`'s live session and is
   * unexpired; a confirmed one is used up. Never throws for a bad input.
   */
  verifyAccountDeletionConfirmation(input: {
    readonly playerId: unknown;
    readonly confirmation: unknown;
  }): Promise<{ readonly confirmed: boolean }>;
  /**
   * Deletes the player: every session family and token, at once (L3b). The
   * game-services Worker calls it before erasing the player's game data.
   * Idempotent, and an unknown player is not an error.
   */
  deletePlayer(input: { readonly playerId: unknown }): Promise<void>;
  /** Storage upkeep; see `IdentityStore.purge`. */
  purge(): Promise<void>;
}

/** An installation id: 8 to 128 letters, digits, `_`, or `-` (a UUID fits). Never authority. */
export function isInstallationId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{8,128}$/u.test(value);
}

const playerIdPattern = /^p_[0-9a-f]{32}$/u;

/** Store purge rounds per `purge()` call: 50 rounds of 500-row statements per run. */
export const purgeMaxRounds = 50;

/** How long an ended family's rows are kept for support before the purge removes them. */
const endedFamilyRetentionMs = 7 * 24 * 60 * 60 * 1000;

export function createGuestIdentityService(input: {
  readonly store: IdentityStore;
  readonly config?: Partial<IdentityServiceConfig>;
  readonly now?: () => number;
  /**
   * Ends the family's notification session on the game-services Worker
   * (`endNotificationSession({ sessionId })`), so its devices are unbound at
   * once. Called after a logout or a replay revokes a family; a failure is
   * logged, and the devices are unbound at the family's end anyway.
   */
  readonly endNotificationSession?: (sessionId: string) => Promise<void>;
  readonly log?: (message: string) => void;
}): GuestIdentityService {
  const config = resolveConfig(input.config);
  const now = input.now ?? Date.now;
  const store = input.store;
  const log = input.log ?? ((message: string) => console.warn(message));

  async function issueAccess(family: { readonly familyId: string; readonly playerId: string }, at: number) {
    const token = createOpaqueToken(accessTokenPrefix);
    const access: IdentityAccessToken = {
      tokenHash: await hashToken(token),
      familyId: family.familyId,
      playerId: family.playerId,
      expiresAt: at + config.accessTokenTtlMs,
    };
    return { token, access };
  }

  function credentials(
    family: Pick<IdentitySessionFamily, 'familyId' | 'playerId'>,
    accessToken: string,
    refreshToken: string,
    access: IdentityAccessToken,
  ): ServerGuestSessionCredentials {
    return {
      serverUserId: family.playerId,
      // The session id does not rotate: it is the family, as the notifications Worker expects.
      sessionId: family.familyId,
      sessionFamilyId: family.familyId,
      identityLevel: 'guest',
      accessToken,
      refreshToken,
      accessExpiresAt: new Date(access.expiresAt).toISOString(),
    };
  }

  /**
   * Revokes the family and ends its notification session. The end is sent
   * again when a logout finds the family already revoked, so a logout the
   * client retries also retries an end the game-services Worker missed.
   */
  async function revoke(family: IdentitySessionFamily, reason: 'logout' | 'refresh-token-reuse', at: number) {
    await store.revokeFamily(family.familyId, reason, at);
    if (input.endNotificationSession === undefined) {
      return;
    }
    try {
      await input.endNotificationSession(family.familyId);
    } catch (error) {
      log(
        `[identity] endNotificationSession failed: ${error instanceof Error ? error.name : 'unknown error'}`,
      );
    }
  }

  const rejected = { ok: false, error: 'GUEST_SESSION_REJECTED' } as const;
  const lostRace = () => {
    log('[identity] a refresh lost a race to newer rotations; the family is kept');
    return { ok: false, error: 'UNAVAILABLE' } as const;
  };

  return {
    async issueGuest({ installationId }) {
      if (!isInstallationId(installationId)) {
        return { ok: false, error: 'INVALID_REQUEST' };
      }
      const at = now();
      const refreshToken = createOpaqueToken(refreshTokenPrefix);
      const family: IdentitySessionFamily = {
        familyId: createIdentifier('s_'),
        playerId: createIdentifier('p_'),
        installationId,
        createdAt: at,
        expiresAt: at + config.refreshIdleMs,
        currentRefreshHash: await hashToken(refreshToken),
      };
      const { token, access } = await issueAccess(family, at);
      const created = await store.createGuest({
        playerId: family.playerId,
        family,
        access,
        // A rolling day: a guest issued exactly 24 hours ago no longer counts.
        limit: { since: at - 24 * 60 * 60 * 1000 + 1, max: config.maxGuestsPerInstallationPerDay },
      });
      if (!created) {
        return { ok: false, error: 'RATE_LIMITED' };
      }
      return { ok: true, value: credentials(family, token, refreshToken, access) };
    },

    async refresh({ refreshToken }) {
      if (!isOpaqueToken(refreshToken, refreshTokenPrefix)) {
        return rejected;
      }
      const presented = await hashToken(refreshToken);
      const issuedIn = await store.findRefreshToken(presented);
      if (issuedIn === undefined) {
        return rejected;
      }
      // Two rounds at most: a lost compare-and-swap means another refresh of
      // the same token won, and the token is then read again as a retry.
      // `raced`: this request saw its token as the family's current one (or a
      // valid retry) and lost the swap, so later rotations overtook it. That
      // is a known race, not a replay: a stolen token presented after its
      // successor was used never reads as current, and still revokes.
      let raced = false;
      for (let round = 0; round < 2; round += 1) {
        const family = await store.getFamily(issuedIn.familyId);
        const at = now();
        if (family === undefined || family.revokedAt !== undefined || family.expiresAt <= at) {
          return rejected;
        }
        if (family.currentRefreshHash === presented) {
          const nonce = createRotationNonce();
          const nextRefreshToken = await deriveRefreshToken(refreshToken, nonce);
          const { token, access } = await issueAccess(family, at);
          const rotated = await store.rotate({
            familyId: family.familyId,
            now: at,
            expected: { currentRefreshHash: presented },
            next: {
              currentRefreshHash: await hashToken(nextRefreshToken),
              previousRefreshHash: presented,
              rotatedAt: at,
              expiresAt: at + config.refreshIdleMs,
              rotationNonce: nonce,
            },
            access,
          });
          if (rotated) {
            return { ok: true, value: credentials(family, token, nextRefreshToken, access) };
          }
          raced = true;
          continue;
        }
        // The token the latest rotation replaced, while its successor is
        // unused (still current) and within the grace window: the client
        // lost the answer, or an abandoned request is still running. Answer
        // the same successor again, so no answer ever invalidates another.
        if (
          config.refreshRetryGraceMs > 0
          && family.previousRefreshHash === presented
          && family.rotatedAt !== undefined
          && family.rotationNonce !== undefined
          && at - family.rotatedAt <= config.refreshRetryGraceMs
        ) {
          const successor = await deriveRefreshToken(refreshToken, family.rotationNonce);
          if (await hashToken(successor) === family.currentRefreshHash) {
            const { token, access } = await issueAccess(family, at);
            if (await store.addAccessToken({ now: at, currentRefreshHash: family.currentRefreshHash, access })) {
              return { ok: true, value: credentials(family, token, successor, access) };
            }
            raced = true;
            continue;
          }
        }
        if (raced) {
          return lostRace();
        }
        // RFC 9700 section 4.14.2: an invalidated refresh token was
        // presented, so one of two parties holds a stolen copy. The server
        // cannot tell which, so the whole family ends.
        await revoke(family, 'refresh-token-reuse', at);
        log('[identity] refresh token reuse: the session family was revoked');
        return rejected;
      }
      // Both rounds lost their swap (each `continue` above follows one).
      return lostRace();
    },

    async revoke({ refreshToken }) {
      if (!isOpaqueToken(refreshToken, refreshTokenPrefix)) {
        return;
      }
      const issuedIn = await store.findRefreshToken(await hashToken(refreshToken));
      const family = issuedIn === undefined ? undefined : await store.getFamily(issuedIn.familyId);
      if (family !== undefined) {
        await revoke(family, 'logout', now());
      }
    },

    async bindAccount() {
      return { ok: false, error: 'ACCOUNT_BINDING_UNSUPPORTED' };
    },

    async issueAccountDeletionConfirmation({ refreshToken }) {
      if (!isOpaqueToken(refreshToken, refreshTokenPrefix)) {
        return rejected;
      }
      const presented = await hashToken(refreshToken);
      const issuedIn = await store.findRefreshToken(presented);
      const family = issuedIn === undefined ? undefined : await store.getFamily(issuedIn.familyId);
      const at = now();
      if (family === undefined || family.revokedAt !== undefined || family.expiresAt <= at) {
        return rejected;
      }
      // The current token, or a retry of the replaced one (the client lost
      // the rotation's answer), exactly as `refresh` accepts them.
      const current = family.currentRefreshHash === presented
        || (config.refreshRetryGraceMs > 0
          && family.previousRefreshHash === presented
          && family.rotatedAt !== undefined
          && family.rotationNonce !== undefined
          && at - family.rotatedAt <= config.refreshRetryGraceMs
          && await hashToken(await deriveRefreshToken(refreshToken, family.rotationNonce))
            === family.currentRefreshHash);
      if (!current) {
        return rejected;
      }
      const confirmation = createOpaqueToken(deletionConfirmationPrefix);
      const expiresAt = at + config.accountDeletionConfirmationTtlMs;
      const stored = await store.putDeletionConfirmation({
        confirmation: {
          tokenHash: await hashToken(confirmation),
          familyId: family.familyId,
          playerId: family.playerId,
          expiresAt,
        },
        now: at,
      });
      // The family ended (or its player was deleted) since it was read.
      return stored
        ? { ok: true, value: { confirmation, expiresAt: new Date(expiresAt).toISOString() } }
        : rejected;
    },

    async verifyAccountDeletionConfirmation({ playerId, confirmation }) {
      if (typeof playerId !== 'string' || !isOpaqueToken(confirmation, deletionConfirmationPrefix)) {
        return { confirmed: false };
      }
      return {
        confirmed: await store.consumeDeletionConfirmation({
          tokenHash: await hashToken(confirmation),
          playerId,
          now: now(),
        }),
      };
    },

    async deletePlayer({ playerId }) {
      if (typeof playerId !== 'string' || playerId.trim() === '') {
        throw new TypeError('deletePlayer needs a player id.');
      }
      // The game-services Worker erases the player's notification devices
      // itself, so no endNotificationSession call is needed here.
      await store.deletePlayer(playerId);
    },

    async authenticate(authorization) {
      const token = readBearerToken(authorization);
      if (!isOpaqueToken(token, accessTokenPrefix)) {
        return undefined;
      }
      const found = await store.findAccessToken(await hashToken(token));
      const at = now();
      if (found === undefined || found.access.expiresAt <= at
        || found.family.revokedAt !== undefined || found.family.expiresAt <= at) {
        return undefined;
      }
      return {
        playerId: found.family.playerId,
        sessionId: found.family.familyId,
        installationId: found.family.installationId,
        expiresAt: new Date(found.family.expiresAt).toISOString(),
      };
    },

    async resolveObfuscatedAccountId(playerId) {
      return typeof playerId === 'string' && playerIdPattern.test(playerId) && await store.hasPlayer(playerId)
        ? deriveObfuscatedAccountId(playerId)
        : undefined;
    },

    async resolveAppAccountToken(playerId) {
      return typeof playerId === 'string' && playerIdPattern.test(playerId) && await store.hasPlayer(playerId)
        ? deriveAppAccountToken(playerId)
        : undefined;
    },

    async purge() {
      const at = now();
      // Bounded statements, repeated until the backlog is gone or the round cap
      // (purgeMaxRounds per run, so one cron invocation stays short); the next run continues.
      for (let round = 0; round < purgeMaxRounds; round += 1) {
        const { more } = await store.purge({
          now: at,
          // A day past the inactivity window: no live family's current or previous token is that old.
          refreshTokensBefore: at - config.refreshIdleMs - 24 * 60 * 60 * 1000,
          familiesEndedBefore: at - endedFamilyRetentionMs,
        });
        if (!more) {
          return;
        }
      }
    },
  };
}

function resolveConfig(overrides: Partial<IdentityServiceConfig> | undefined): IdentityServiceConfig {
  const config = { ...defaultIdentityServiceConfig, ...overrides };
  const positive = (value: number) => Number.isSafeInteger(value) && value > 0;
  if (!positive(config.accessTokenTtlMs) || !positive(config.refreshIdleMs)
    || !positive(config.maxGuestsPerInstallationPerDay)
    || !positive(config.accountDeletionConfirmationTtlMs)
    || !(Number.isSafeInteger(config.refreshRetryGraceMs) && config.refreshRetryGraceMs >= 0)
    || config.accessTokenTtlMs >= config.refreshIdleMs
    || config.refreshRetryGraceMs >= config.refreshIdleMs) {
    throw new IdentityConfigurationError(
      'Identity config: lifetimes must be positive whole milliseconds, the access token shorter than '
        + 'the inactivity window, and the retry grace shorter than the inactivity window.',
    );
  }
  return config;
}
