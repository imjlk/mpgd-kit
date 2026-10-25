import type { SecureCredentialStore } from '@mpgd/platform';

/** These identifiers are deliberately not interchangeable authentication claims. */
export interface GuestInstallationIdentity {
  readonly installationId: string;
}

export interface VerifiedExternalAccount {
  readonly provider: string;
  readonly subject: string;
}

export interface NativeGamePlayerIdentity {
  readonly platform: 'game-center' | 'play-games';
  readonly platformPlayerId: string;
}

export interface StorePurchaseAccountBinding {
  readonly store: 'app-store' | 'google-play';
  readonly bindingId: string;
}

/** Only a trusted server may issue this opaque-token response. */
export interface ServerGuestSessionCredentials {
  readonly serverUserId: string;
  /** May rotate on refresh or binding; serverUserId remains the ownership key. */
  readonly sessionId: string;
  /**
   * The stable session-family id: one value for the session's whole life,
   * across every refresh, which a new guest (and any new sign-in) replaces.
   * It is the `sessionId` the identity service answers to the notifications
   * Worker's `authenticateNotificationSession`. Optional on the wire (`null`
   * reads as absent): when a backend omits it, the coordinator derives one
   * (see `createGuestSessionCoordinator`). A backend that omits it and starts
   * a new family at an account binding must give that binding a new
   * `sessionId`.
   */
  readonly sessionFamilyId?: string;
  readonly identityLevel: 'guest' | 'authenticated';
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accessExpiresAt: string;
}

/** Identity view: neither bearer token is returned to game code. */
export interface ServerGuestSessionView {
  readonly serverUserId: string;
  /** May rotate on refresh or binding. */
  readonly sessionId: string;
  /**
   * The stable session-family id: the backend's, or the one the coordinator
   * derived when the backend sent none. Use it, not `sessionId`, wherever a
   * session must keep one id across refreshes (the notifications client).
   */
  readonly sessionFamilyId: string;
  readonly identityLevel: 'guest' | 'authenticated';
  readonly accessExpiresAt: string;
}

export type AccountBindingOutcome =
  | { readonly status: 'bound' | 'already-bound'; readonly session: ServerGuestSessionCredentials }
  | { readonly status: 'conflict' };

/**
 * Implement on the game backend. Refresh/revoke must authenticate the opaque
 * refresh token, and bindAccount must verify both it and the external proof,
 * atomically deduplicate by idempotencyKey, and return conflict for an account
 * already owned by another server user. An installationId is never authority.
 */
export interface GuestSessionBackend {
  issueGuest(input: GuestInstallationIdentity): Promise<ServerGuestSessionCredentials>;
  refresh(input: { readonly refreshToken: string }): Promise<ServerGuestSessionCredentials>;
  revoke(input: { readonly refreshToken: string }): Promise<void>;
  bindAccount(input: {
    readonly refreshToken: string;
    readonly externalProof: string;
    readonly idempotencyKey: string;
  }): Promise<AccountBindingOutcome>;
  /**
   * A short-lived, single-use account deletion confirmation for the refresh
   * token's player, which the game-services deletion route requires besides
   * the access token (`accountDeletionConfirmationHeader`). It must
   * authenticate the refresh token like `refresh`, without rotating it, and
   * throw `GuestSessionRejectedError` for one refused for good. Optional: a
   * backend without it cannot delete accounts through the starter.
   */
  requestAccountDeletionConfirmation?(input: {
    readonly refreshToken: string;
  }): Promise<AccountDeletionConfirmationGrant>;
}

/** A deletion confirmation, as the identity service answers it. */
export interface AccountDeletionConfirmationGrant {
  /** Opaque; sent once, in `accountDeletionConfirmationHeader`. */
  readonly confirmation: string;
  /** When it stops being accepted (ISO 8601). */
  readonly expiresAt: string;
}

export type GuestSessionCoordinatorErrorCode =
  | 'GUEST_SESSION_CLOSED'
  | 'GUEST_SESSION_NOT_READY'
  | 'GUEST_SESSION_INVALID_INPUT'
  | 'GUEST_SESSION_INVALID_RESPONSE'
  | 'GUEST_SESSION_OWNERSHIP_CONFLICT'
  | 'GUEST_SESSION_BACKEND_FAILED'
  /**
   * The identity service refused the refresh token: revoked (logout,
   * replay), expired after inactivity, or unknown. That session cannot come
   * back: the coordinator stops using it (`current()` is `undefined`, and
   * `start()`, `refresh()` and `getHeaders()` fail with
   * `GUEST_SESSION_NOT_READY` without calling the backend). Log out (which
   * removes the stored token) and start a new coordinator for a new guest.
   */
  | 'GUEST_SESSION_REJECTED'
  | 'GUEST_SESSION_CREDENTIAL_LOAD_FAILED'
  | 'GUEST_SESSION_CREDENTIAL_SAVE_FAILED'
  | 'GUEST_SESSION_LOGOUT_UNCERTAIN'
  /** The backend has no `requestAccountDeletionConfirmation`. */
  | 'GUEST_SESSION_UNSUPPORTED';

/** Error messages intentionally contain no token, proof, or installation ID. */
export class GuestSessionCoordinatorError extends Error {
  readonly code: GuestSessionCoordinatorErrorCode;

  constructor(code: GuestSessionCoordinatorErrorCode) {
    super(`Guest session operation failed: ${code}.`);
    this.name = 'GuestSessionCoordinatorError';
    this.code = code;
  }
}

/**
 * A `GuestSessionBackend` throws this when the identity service refused the
 * refresh token for good (revoked, expired, replayed, or unknown), as
 * opposed to an outage. The coordinator reports it as `GUEST_SESSION_REJECTED`.
 */
export class GuestSessionRejectedError extends Error {
  constructor() {
    super('The identity service rejected the guest session.');
    this.name = 'GuestSessionRejectedError';
  }
}

export interface GuestSessionCoordinator {
  start(): Promise<ServerGuestSessionView>;
  /** The active session's view, or `undefined` before `start()` settles, after a failure, and after logout. */
  current(): ServerGuestSessionView | undefined;
  /**
   * Calls `listener` with the new view each time a session becomes active:
   * `start()`, each `refresh()`, and a bound `bindAccount()`. A refresh in
   * the same family repeats the family id. Returns the unsubscribe. A
   * listener that throws does not fail the operation. Nothing is announced
   * when a session stops being active (a failed save, logout): read
   * `current()` for that.
   */
  onSession(listener: (session: ServerGuestSessionView) => void): () => void;
  refresh(): Promise<ServerGuestSessionView>;
  bindAccount(input: {
    readonly externalProof: string;
    readonly idempotencyKey: string;
  }): Promise<{ readonly status: 'bound' | 'already-bound' | 'conflict' }>;
  getHeaders(): Readonly<Record<'authorization', string>>;
  /**
   * Asks the backend for an account deletion confirmation with the active
   * session's refresh token (queued with refreshes, so it never presents a
   * token a rotation in flight replaces). Fails with
   * `GUEST_SESSION_NOT_READY` without an active session,
   * `GUEST_SESSION_REJECTED` when the service refused the session for good
   * (as `refresh` does, the coordinator then stops using it), and
   * `GUEST_SESSION_UNSUPPORTED` when the backend cannot issue one.
   */
  requestAccountDeletionConfirmation(): Promise<string>;
  logout(): Promise<void>;
}

const defaultCredentialKey = 'mpgd.guest.refresh';

/** The credentials the coordinator holds, with the family id resolved. */
type ActiveGuestSession = ServerGuestSessionCredentials & { readonly sessionFamilyId: string };

/**
 * Serializes token mutation and closes synchronously on logout. Native secure
 * storage failures never fall back to ordinary game storage or mint a new guest.
 *
 * The session-family id is the backend's `sessionFamilyId` whenever it sends
 * one. A backend that omits it gets a derived id, which only ever changes in
 * the safe direction (a new id where the backend's family might be new):
 * - `issueGuest` starts a family at the new `sessionId`;
 * - a refresh keeps the family, however the `sessionId` rotates;
 * - a bound account keeps it while the `sessionId` stays, and starts one at
 *   the new `sessionId` when that changes (so such a backend must change
 *   the `sessionId` when a binding starts a new family);
 * - a restore from secure storage keeps the family saved with the refresh
 *   token (`<credentialKey>.family`), or starts one at the restored
 *   `sessionId` when none can be read;
 * - logout removes the saved family with the token.
 * The derived id is not the identity service's id, and does not need to be: the
 * notifications runtime only compares it with the id it registered under,
 * and registers again when it changes. Saving the family is best effort:
 * it is written before the token, so an interrupted save never pairs an
 * older family with a newer token, and a family that cannot be saved is
 * removed, so the next restore starts one. Only a store that fails both that
 * save and that removal, and then saves the token, can leave an older family
 * next to it; the token is saved regardless, since losing it would lose the
 * guest.
 */
export function createGuestSessionCoordinator(input: {
  readonly backend: GuestSessionBackend;
  readonly credentials: SecureCredentialStore;
  readonly installationId: string;
  readonly credentialKey?: string;
  readonly now?: () => number;
}): GuestSessionCoordinator {
  if (typeof input.installationId !== 'string' || input.installationId.trim() === '') {
    throw new GuestSessionCoordinatorError('GUEST_SESSION_INVALID_INPUT');
  }
  const credentialKey = input.credentialKey ?? defaultCredentialKey;
  if (credentialKey.trim() === '') {
    throw new GuestSessionCoordinatorError('GUEST_SESSION_INVALID_INPUT');
  }
  const familyKey = `${credentialKey}.family`;
  const now = input.now ?? Date.now;
  let current: ActiveGuestSession | undefined;
  /** The family id last written to secure storage, as far as this coordinator knows. */
  let savedFamily: string | undefined;
  const listeners = new Set<(session: ServerGuestSessionView) => void>();
  let status: 'idle' | 'active' | 'failed' | 'closed' = 'idle';
  let tail: Promise<void> = Promise.resolve();
  let startInFlight: Promise<ServerGuestSessionView> | undefined;
  let refreshInFlight: Promise<ServerGuestSessionView> | undefined;
  let logoutInFlight: Promise<void> | undefined;

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = tail.then(operation, operation);
    tail = next.then(() => undefined, () => undefined);
    return next;
  }

  function assertOpen(): void {
    if (status === 'closed') {
      throw new GuestSessionCoordinatorError('GUEST_SESSION_CLOSED');
    }
  }

  function requireCurrent(): ActiveGuestSession {
    if (status !== 'active' || current === undefined) {
      throw new GuestSessionCoordinatorError('GUEST_SESSION_NOT_READY');
    }
    return current;
  }

  async function loadStoredRefreshToken(): Promise<string | null> {
    try {
      const stored = await input.credentials.load({ key: credentialKey });
      if (stored !== null && (typeof stored !== 'string' || stored === '')) {
        throw new Error('Invalid stored refresh token.');
      }
      return stored;
    } catch {
      throw new GuestSessionCoordinatorError('GUEST_SESSION_CREDENTIAL_LOAD_FAILED');
    }
  }

  async function fromBackend<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof GuestSessionRejectedError) {
        // The session can never come back: stop using it (current() is
        // undefined, start() and getHeaders() fail fast) until logout.
        if (status !== 'closed') {
          status = 'failed';
        }
        throw new GuestSessionCoordinatorError('GUEST_SESSION_REJECTED');
      }
      // Backend exceptions can contain URLs, proofs, or tokens. The public
      // coordinator surface intentionally exposes only a stable error code.
      throw new GuestSessionCoordinatorError('GUEST_SESSION_BACKEND_FAILED');
    }
  }

  /** The family saved with the stored refresh token, or `undefined` when none can be read. */
  async function loadStoredFamily(): Promise<string | undefined> {
    try {
      const stored = await input.credentials.load({ key: familyKey });
      return typeof stored === 'string' && stored.trim() !== '' ? stored : undefined;
    } catch {
      // A family that cannot be read starts a new one: at worst one more registration.
      return undefined;
    }
  }

  /**
   * Removes the saved family. A failed removal leaves the key: harmless at
   * logout (no token is left to pair it with), and in `persist` the one case
   * where an older family can stay next to a newer token.
   */
  async function removeSavedFamily(): Promise<void> {
    savedFamily = undefined;
    try {
      await input.credentials.remove({ key: familyKey });
    } catch {
      // Nothing more can be done without the native store.
    }
  }

  async function persist(next: ActiveGuestSession): Promise<void> {
    // The family goes before the token: a crash or a failure between the two
    // writes leaves a newer family next to an older token (at worst one more
    // registration after a restore), never an older family next to a newer
    // token, which a restore would read for a family the backend may have
    // replaced. A family that cannot be saved is removed for the same reason.
    if (savedFamily !== next.sessionFamilyId) {
      try {
        await input.credentials.save({ key: familyKey, value: next.sessionFamilyId });
        savedFamily = next.sessionFamilyId;
      } catch {
        await removeSavedFamily();
      }
    }
    try {
      await input.credentials.save({ key: credentialKey, value: next.refreshToken });
    } catch {
      // Keep the latest token only for an explicit revoke; never expose it as
      // an active session after native persistence failed.
      current = next;
      if (status !== 'closed') {
        status = 'failed';
      }
      throw new GuestSessionCoordinatorError('GUEST_SESSION_CREDENTIAL_SAVE_FAILED');
    }
    current = next;
    if (status !== 'closed') {
      status = 'active';
    }
  }

  /** Saves `next`, makes it the active session unless logout closed it, and announces it. */
  async function activate(next: ActiveGuestSession): Promise<ServerGuestSessionView> {
    await persist(next);
    assertOpen();
    const active = view(next);
    announce(active);
    return active;
  }

  /** Tells the listeners, after an operation made `session` active. */
  function announce(session: ServerGuestSessionView): void {
    for (const listener of [...listeners]) {
      try {
        listener(session);
      } catch {
        // A listener's failure is the game's; the session is active regardless.
      }
    }
  }

  return {
    async start() {
      assertOpen();
      if (status === 'active' && current !== undefined) {
        return Promise.resolve(view(current));
      }
      if (startInFlight !== undefined) {
        return startInFlight;
      }
      if (status === 'failed') {
        return Promise.reject(new GuestSessionCoordinatorError('GUEST_SESSION_NOT_READY'));
      }
      startInFlight = enqueue(async () => {
        assertOpen();
        const stored = await loadStoredRefreshToken();
        let next: ActiveGuestSession;
        if (stored === null) {
          // A new guest is a new family; a family saved for an older token is
          // not read. (Defensive: nothing has set savedFamily before a first start.)
          savedFamily = undefined;
          next = withFamily(validateSession(await fromBackend(
            () => input.backend.issueGuest({ installationId: input.installationId }),
          )), undefined);
        } else {
          const family = await loadStoredFamily();
          savedFamily = family;
          next = withFamily(validateSession(await fromBackend(
            () => input.backend.refresh({ refreshToken: stored }),
          )), family);
        }
        return activate(next);
      }).finally(() => { startInFlight = undefined; });
      return startInFlight;
    },
    async refresh() {
      assertOpen();
      if (refreshInFlight !== undefined) {
        return refreshInFlight;
      }
      refreshInFlight = enqueue(async () => {
        const previous = requireCurrent();
        const next = withFamily(validateSession(await fromBackend(() => input.backend.refresh({
          refreshToken: previous.refreshToken,
        }))), previous.sessionFamilyId);
        assertSameOwner(previous, next);
        return activate(next);
      }).finally(() => { refreshInFlight = undefined; });
      return refreshInFlight;
    },
    async bindAccount(binding) {
      assertOpen();
      if (typeof binding.externalProof !== 'string' || binding.externalProof.trim() === ''
        || typeof binding.idempotencyKey !== 'string' || binding.idempotencyKey.trim() === '') {
        throw new GuestSessionCoordinatorError('GUEST_SESSION_INVALID_INPUT');
      }
      return enqueue(async () => {
        const previous = requireCurrent();
        const result = await fromBackend(() => input.backend.bindAccount({
          refreshToken: previous.refreshToken,
          externalProof: binding.externalProof,
          idempotencyKey: binding.idempotencyKey,
        }));
        if (typeof result !== 'object' || result === null || !('status' in result)) {
          throw new GuestSessionCoordinatorError('GUEST_SESSION_INVALID_RESPONSE');
        }
        if (result.status === 'conflict') {
          assertOpen();
          return { status: 'conflict' as const };
        }
        if (result.status !== 'bound' && result.status !== 'already-bound') {
          throw new GuestSessionCoordinatorError('GUEST_SESSION_INVALID_RESPONSE');
        }
        const bound = validateSession(result.session);
        // The same session id is the same session; a new one may be a new family.
        const next = withFamily(
          bound,
          bound.sessionId === previous.sessionId ? previous.sessionFamilyId : undefined,
        );
        assertSameOwner(previous, next);
        if (next.identityLevel !== 'authenticated') {
          throw new GuestSessionCoordinatorError('GUEST_SESSION_INVALID_RESPONSE');
        }
        await activate(next);
        return { status: result.status };
      });
    },
    requestAccountDeletionConfirmation() {
      assertOpen();
      const request = input.backend.requestAccountDeletionConfirmation?.bind(input.backend);
      if (request === undefined) {
        return Promise.reject(new GuestSessionCoordinatorError('GUEST_SESSION_UNSUPPORTED'));
      }
      return enqueue(async () => {
        assertOpen();
        const active = requireCurrent();
        const grant: unknown = await fromBackend(() => request({ refreshToken: active.refreshToken }));
        if (!isRecord(grant) || typeof grant.confirmation !== 'string' || grant.confirmation.trim() === ''
          || typeof grant.expiresAt !== 'string' || !Number.isFinite(Date.parse(grant.expiresAt))) {
          throw new GuestSessionCoordinatorError('GUEST_SESSION_INVALID_RESPONSE');
        }
        return grant.confirmation;
      });
    },
    current() {
      return status === 'active' && current !== undefined ? view(current) : undefined;
    },
    onSession(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getHeaders() {
      assertOpen();
      const active = requireCurrent();
      if (Date.parse(active.accessExpiresAt) <= now()) {
        throw new GuestSessionCoordinatorError('GUEST_SESSION_NOT_READY');
      }
      return { authorization: `Bearer ${active.accessToken}` };
    },
    logout() {
      if (logoutInFlight !== undefined) {
        return logoutInFlight;
      }
      status = 'closed';
      const attempt = enqueue(async () => {
        let token = current?.refreshToken;
        if (token === undefined) {
          try {
            token = (await input.credentials.load({ key: credentialKey })) ?? undefined;
          } catch {
            // Keep the credential intact so a later logout can retry the load.
            throw new GuestSessionCoordinatorError('GUEST_SESSION_LOGOUT_UNCERTAIN');
          }
        }
        if (token !== undefined) {
          try {
            await input.backend.revoke({ refreshToken: token });
          } catch {
            // Do not delete a still-live refresh token on revoke failure.
            throw new GuestSessionCoordinatorError('GUEST_SESSION_LOGOUT_UNCERTAIN');
          }
        }
        try {
          await input.credentials.remove({ key: credentialKey });
        } catch {
          throw new GuestSessionCoordinatorError('GUEST_SESSION_LOGOUT_UNCERTAIN');
        }
        // Without its token a saved family is never read (a new guest starts its own).
        await removeSavedFamily();
        current = undefined;
      });
      logoutInFlight = attempt;
      void attempt.catch(() => {
        // A failed revoke or remove can be retried on this closed coordinator.
        logoutInFlight = undefined;
      });
      return logoutInFlight;
    },
  };
}

function view(session: ActiveGuestSession): ServerGuestSessionView {
  return {
    serverUserId: session.serverUserId,
    sessionId: session.sessionId,
    sessionFamilyId: session.sessionFamilyId,
    identityLevel: session.identityLevel,
    accessExpiresAt: session.accessExpiresAt,
  };
}

/** The backend's family id, else the family it continues, else a new one at its session id. */
function withFamily(
  session: ServerGuestSessionCredentials,
  continued: string | undefined,
): ActiveGuestSession {
  return { ...session, sessionFamilyId: session.sessionFamilyId ?? continued ?? session.sessionId };
}

// A server may already have consumed the previous refresh token. Persist a
// well-formed rotated token even when the device clock makes access look expired.
function validateSession(value: unknown): ServerGuestSessionCredentials {
  if (!isRecord(value)
    || typeof value.serverUserId !== 'string' || value.serverUserId.trim() === ''
    || typeof value.sessionId !== 'string' || value.sessionId.trim() === ''
    || (value.sessionFamilyId !== undefined && value.sessionFamilyId !== null
      && (typeof value.sessionFamilyId !== 'string' || value.sessionFamilyId.trim() === ''))
    || (value.identityLevel !== 'guest' && value.identityLevel !== 'authenticated')
    || typeof value.accessToken !== 'string' || value.accessToken.trim() === ''
    || typeof value.refreshToken !== 'string' || value.refreshToken.trim() === ''
    || typeof value.accessExpiresAt !== 'string'
    || !Number.isFinite(Date.parse(value.accessExpiresAt))) {
    throw new GuestSessionCoordinatorError('GUEST_SESSION_INVALID_RESPONSE');
  }
  return {
    serverUserId: value.serverUserId,
    sessionId: value.sessionId,
    // `null` reads as absent, as many serializers write an omitted field.
    ...(typeof value.sessionFamilyId === 'string' ? { sessionFamilyId: value.sessionFamilyId } : {}),
    identityLevel: value.identityLevel,
    accessToken: value.accessToken,
    refreshToken: value.refreshToken,
    accessExpiresAt: value.accessExpiresAt,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertSameOwner(
  previous: ServerGuestSessionCredentials,
  next: ServerGuestSessionCredentials,
): void {
  if (previous.serverUserId !== next.serverUserId) {
    throw new GuestSessionCoordinatorError('GUEST_SESSION_OWNERSHIP_CONFLICT');
  }
}

/**
 * A guest session as the game-services clients read a server-backed
 * session: the starter's `StarterServerSession`, and the notifications
 * client's identity and header resolver.
 */
export interface GuestServerSession {
  /**
   * The active session, or `undefined` while none is: `playerId` is the
   * server user, and `sessionId` is the session-family id, which stays the
   * same across refreshes.
   */
  current(): { readonly playerId: string; readonly sessionId: string } | undefined;
  /**
   * Calls `listener` when a session becomes current after the subscription:
   * the first `start()`, or a binding that starts a new family. A refresh in
   * the same family is not announced. Returns the unsubscribe.
   */
  onAuthenticated(
    listener: (session: { readonly playerId: string; readonly sessionId: string }) => void,
  ): () => void;
  /**
   * The `Authorization` header. An expired access token is refreshed first,
   * and a failed refresh throws its error (`GUEST_SESSION_BACKEND_FAILED`,
   * `GUEST_SESSION_REJECTED`, `GUEST_SESSION_OWNERSHIP_CONFLICT`, ...). A token that expires within
   * `refreshAheadMs` is answered at once while a refresh runs in the
   * background: once per token, and at most once per
   * `guestServerSessionRefreshAheadIntervalMs`, so a backend whose tokens
   * live shorter than the lead is not refreshed on every request; a failed
   * background refresh is retried when the token has expired.
   */
  getHeaders(): Promise<Readonly<Record<'authorization', string>>>;
  /**
   * An account deletion confirmation for the current session
   * (`GuestSessionCoordinator.requestAccountDeletionConfirmation`), which the
   * game-services deletion route requires. Optional, so another session
   * holder (a development session) may leave it out.
   */
  requestAccountDeletionConfirmation?(): Promise<string>;
}

/** How long before its access token expires `createGuestServerSession` refreshes a session: one minute. */
export const defaultGuestServerSessionRefreshAheadMs = 60_000;

/** The least time between two background refreshes of `createGuestServerSession`. */
export const guestServerSessionRefreshAheadIntervalMs = 10_000;

/**
 * Reads a `GuestSessionCoordinator` as a server-backed session, with the
 * session-family id as the session id, which the notifications client and
 * the Worker need (it must not change on refresh). The game still starts
 * the coordinator, binds accounts, and logs out through it. If you gave
 * `createGuestSessionCoordinator` a `now`, pass the same function here, so
 * both read expiry on one clock.
 */
export function createGuestServerSession(
  coordinator: GuestSessionCoordinator,
  options: { readonly refreshAheadMs?: number; readonly now?: () => number } = {},
): GuestServerSession {
  const refreshAheadMs = options.refreshAheadMs ?? defaultGuestServerSessionRefreshAheadMs;
  if (!Number.isFinite(refreshAheadMs) || refreshAheadMs < 0) {
    throw new GuestSessionCoordinatorError('GUEST_SESSION_INVALID_INPUT');
  }
  const now = options.now ?? Date.now;
  /** The token (by its expiry) a background refresh last ran for, and when. */
  let refreshedAheadFor: string | undefined;
  let lastRefreshAheadAt: number | undefined;
  /** The one mapping: the server user is the player, and the family id is the session id. */
  const toSession = (active: ServerGuestSessionView) => ({
    playerId: active.serverUserId,
    sessionId: active.sessionFamilyId,
  });
  const sessionOf = (active: ServerGuestSessionView | undefined) =>
    active === undefined ? undefined : toSession(active);
  return {
    current: () => sessionOf(coordinator.current()),
    onAuthenticated(listener) {
      // The session current at subscription is not a new one; its refreshes are not either.
      let announced = sessionOf(coordinator.current());
      return coordinator.onSession((active) => {
        const next = toSession(active);
        if (announced?.playerId === next.playerId && announced.sessionId === next.sessionId) {
          return;
        }
        announced = next;
        listener(next);
      });
    },
    requestAccountDeletionConfirmation: () => coordinator.requestAccountDeletionConfirmation(),
    async getHeaders() {
      const active = coordinator.current();
      if (active !== undefined) {
        const expiresAt = Date.parse(active.accessExpiresAt);
        const at = now();
        if (expiresAt <= at) {
          // Concurrent callers share the coordinator's one refresh.
          await coordinator.refresh();
        } else if (
          expiresAt - refreshAheadMs <= at
          && refreshedAheadFor !== active.accessExpiresAt
          // A clock that went back counts as the interval passed.
          && (lastRefreshAheadAt === undefined
            || at < lastRefreshAheadAt
            || at - lastRefreshAheadAt >= guestServerSessionRefreshAheadIntervalMs)
        ) {
          refreshedAheadFor = active.accessExpiresAt;
          lastRefreshAheadAt = at;
          // The token is still valid: answer it now; a failure is retried once it expires.
          coordinator.refresh().catch(() => undefined);
        }
      }
      return coordinator.getHeaders();
    },
  };
}

/**
 * The HTTP routes of a guest identity service, relative to its base URL:
 * the contract between `createGuestSessionHttpBackend` and the reference
 * identity Worker (`apps/game-identity-worker`). Every route takes a JSON
 * `POST` body. `issueGuest` and `refresh` answer `200` with
 * `ServerGuestSessionCredentials`; `revoke` answers `200` with `{}`, also for
 * a token it does not know (RFC 7009 section 2.2); a refusal answers
 * `{ error: GuestIdentityHttpErrorCode }`. `bindAccount` answers `200` with
 * an `AccountBindingOutcome` (a `conflict` too), or a refusal; the reference
 * Worker binds nothing yet and answers `ACCOUNT_BINDING_UNSUPPORTED`.
 * `requestAccountDeletionConfirmation` takes `{ refreshToken }` and answers
 * `200` with an `AccountDeletionConfirmationGrant`. A refresh token any
 * route refuses for good is `GUEST_SESSION_REJECTED`.
 */
export const guestIdentityHttpRoutes = Object.freeze({
  issueGuest: '/identity/v1/guest',
  refresh: '/identity/v1/refresh',
  revoke: '/identity/v1/revoke',
  bindAccount: '/identity/v1/bind-account',
  requestAccountDeletionConfirmation: '/identity/v1/account-deletion-confirmation',
} as const);

/**
 * - `INVALID_REQUEST` (400): a body the route does not take.
 * - `GUEST_SESSION_REJECTED` (401): the refresh token is revoked, expired,
 *   replayed, or unknown; the session cannot come back.
 * - `RATE_LIMITED` (429): too many guests for this installation or address.
 * - `ACCOUNT_BINDING_UNSUPPORTED` (501): the service binds no external account.
 * - `UNAVAILABLE` (503): the service could not answer; retry later.
 */
export type GuestIdentityHttpErrorCode =
  | 'INVALID_REQUEST'
  | 'GUEST_SESSION_REJECTED'
  | 'RATE_LIMITED'
  | 'ACCOUNT_BINDING_UNSUPPORTED'
  | 'UNAVAILABLE';

/** A failed identity request. The message names the route and the code, never a token. */
export class GuestSessionHttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(route: string, status: number, code: string) {
    super(`Guest identity request ${route} failed: ${status} ${code}.`);
    this.name = 'GuestSessionHttpError';
    this.status = status;
    this.code = code;
  }
}

/** How long one identity request may take by default: 15 seconds. */
export const defaultGuestSessionHttpTimeoutMs = 15_000;

/**
 * A `GuestSessionBackend` over a guest identity service's HTTP routes
 * (`guestIdentityHttpRoutes`). A `refresh` the service refuses with
 * `GUEST_SESSION_REJECTED` throws `GuestSessionRejectedError` (the
 * coordinator's `GUEST_SESSION_REJECTED`); any other failure throws
 * `GuestSessionHttpError` or the fetch error, which the coordinator reports
 * as `GUEST_SESSION_BACKEND_FAILED`. `baseUrl` must be `https:`, except on a
 * local development host (`localhost`, `*.localhost`, `127.0.0.1`, `[::1]`,
 * `10.0.2.2`). Requests never follow a redirect, so a token is only ever sent
 * to `baseUrl`'s origin.
 */
export function createGuestSessionHttpBackend(input: {
  readonly baseUrl: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}): GuestSessionBackend {
  const base = parseGuestIdentityBaseUrl(input.baseUrl);
  const timeoutMs = input.timeoutMs ?? defaultGuestSessionHttpTimeoutMs;
  // setTimeout fires at once past a signed 32-bit delay.
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new GuestSessionCoordinatorError('GUEST_SESSION_INVALID_INPUT');
  }
  const fetchImpl = input.fetch ?? ((request: Request) => globalThis.fetch(request));

  async function post(route: string, body: Readonly<Record<string, string>>): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(
        new Request(new URL(route.slice(1), base), {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(body),
          redirect: 'manual',
          signal: controller.signal,
        }),
      );
      // A fetch that followed a redirect anyway (some polyfills ignore
      // `manual`) answered from another origin: never trust that answer.
      if (response.redirected) {
        throw new GuestSessionHttpError(route, response.status, 'REDIRECTED');
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        payload = undefined;
      }
      if (response.status !== 200) {
        const code = isRecord(payload) && typeof payload.error === 'string' && /^[A-Z_]{1,64}$/u.test(payload.error)
          ? payload.error
          : 'UNKNOWN';
        throw new GuestSessionHttpError(route, response.status, code);
      }
      // A 200 that is not a JSON object (a captive portal's page, a body cut
      // off by the timeout) is a failure, so a revoke is never assumed done.
      if (!isRecord(payload)) {
        throw new GuestSessionHttpError(route, response.status, 'INVALID_BODY');
      }
      return payload;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async issueGuest({ installationId }) {
      return await post(guestIdentityHttpRoutes.issueGuest, { installationId }) as ServerGuestSessionCredentials;
    },
    async refresh({ refreshToken }) {
      return await withRejection(post(guestIdentityHttpRoutes.refresh, { refreshToken })) as ServerGuestSessionCredentials;
    },
    async revoke({ refreshToken }) {
      await post(guestIdentityHttpRoutes.revoke, { refreshToken });
    },
    async bindAccount({ refreshToken, externalProof, idempotencyKey }) {
      return await withRejection(post(guestIdentityHttpRoutes.bindAccount, {
        refreshToken,
        externalProof,
        idempotencyKey,
      })) as AccountBindingOutcome;
    },
    async requestAccountDeletionConfirmation({ refreshToken }) {
      return await withRejection(
        post(guestIdentityHttpRoutes.requestAccountDeletionConfirmation, { refreshToken }),
      ) as AccountDeletionConfirmationGrant;
    },
  };
}

/** The service's `401 GUEST_SESSION_REJECTED` as `GuestSessionRejectedError`; other failures unchanged. */
async function withRejection<T>(request: Promise<T>): Promise<T> {
  try {
    return await request;
  } catch (error) {
    if (error instanceof GuestSessionHttpError && error.status === 401 && error.code === 'GUEST_SESSION_REJECTED') {
      throw new GuestSessionRejectedError();
    }
    throw error;
  }
}

function parseGuestIdentityBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new GuestSessionCoordinatorError('GUEST_SESSION_INVALID_INPUT');
  }
  const host = url.hostname.toLowerCase();
  const local = host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1'
    || host === '[::1]' || host === '10.0.2.2';
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && local))
    || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new GuestSessionCoordinatorError('GUEST_SESSION_INVALID_INPUT');
  }
  // Routes resolve under the base path, so `https://host/api` serves `/api/identity/v1/...`.
  if (!url.pathname.endsWith('/')) {
    url.pathname = `${url.pathname}/`;
  }
  return url;
}
