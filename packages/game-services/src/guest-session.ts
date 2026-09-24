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
  readonly sessionId: string;
  readonly identityLevel: 'guest' | 'authenticated';
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accessExpiresAt: string;
}

/** Identity view: neither bearer token is returned to game code. */
export type ServerGuestSessionView = Omit<ServerGuestSessionCredentials, 'accessToken' | 'refreshToken'>;

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
}

export type GuestSessionCoordinatorErrorCode =
  | 'GUEST_SESSION_CLOSED'
  | 'GUEST_SESSION_NOT_READY'
  | 'GUEST_SESSION_INVALID_RESPONSE'
  | 'GUEST_SESSION_OWNERSHIP_CONFLICT'
  | 'GUEST_SESSION_CREDENTIAL_SAVE_FAILED'
  | 'GUEST_SESSION_LOGOUT_UNCERTAIN';

/** Error messages intentionally contain no token, proof, or installation ID. */
export class GuestSessionCoordinatorError extends Error {
  readonly code: GuestSessionCoordinatorErrorCode;

  constructor(code: GuestSessionCoordinatorErrorCode) {
    super(`Guest session operation failed: ${code}.`);
    this.name = 'GuestSessionCoordinatorError';
    this.code = code;
  }
}

export interface GuestSessionCoordinator {
  start(): Promise<ServerGuestSessionView>;
  refresh(): Promise<ServerGuestSessionView>;
  bindAccount(input: {
    readonly externalProof: string;
    readonly idempotencyKey: string;
  }): Promise<{ readonly status: 'bound' | 'already-bound' | 'conflict' }>;
  getHeaders(): Readonly<Record<'authorization', string>>;
  logout(): Promise<void>;
}

const defaultCredentialKey = 'mpgd.guest.refresh';

/**
 * Serializes token mutation and closes synchronously on logout. Native secure
 * storage failures never fall back to ordinary game storage or mint a new guest.
 */
export function createGuestSessionCoordinator(input: {
  readonly backend: GuestSessionBackend;
  readonly credentials: SecureCredentialStore;
  readonly installationId: string;
  readonly credentialKey?: string;
  readonly now?: () => number;
}): GuestSessionCoordinator {
  if (input.installationId.trim() === '') {
    throw new GuestSessionCoordinatorError('GUEST_SESSION_INVALID_RESPONSE');
  }
  const credentialKey = input.credentialKey ?? defaultCredentialKey;
  const now = input.now ?? Date.now;
  let current: ServerGuestSessionCredentials | undefined;
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

  function requireCurrent(): ServerGuestSessionCredentials {
    if (status !== 'active' || current === undefined) {
      throw new GuestSessionCoordinatorError('GUEST_SESSION_NOT_READY');
    }
    return current;
  }

  async function persist(next: ServerGuestSessionCredentials): Promise<void> {
    try {
      await input.credentials.save({ key: credentialKey, value: next.refreshToken });
    } catch {
      // Keep the latest token only for an explicit revoke; never expose it as
      // an active session after native persistence failed.
      current = next;
      status = 'failed';
      throw new GuestSessionCoordinatorError('GUEST_SESSION_CREDENTIAL_SAVE_FAILED');
    }
    current = next;
    if (status !== 'closed') {
      status = 'active';
    }
  }

  return {
    start() {
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
        const stored = await input.credentials.load({ key: credentialKey });
        const next = validateSession(stored === null
          ? await input.backend.issueGuest({ installationId: input.installationId })
          : await input.backend.refresh({ refreshToken: stored }), now);
        await persist(next);
        assertOpen();
        return view(next);
      }).finally(() => { startInFlight = undefined; });
      return startInFlight;
    },
    refresh() {
      assertOpen();
      if (refreshInFlight !== undefined) {
        return refreshInFlight;
      }
      refreshInFlight = enqueue(async () => {
        const previous = requireCurrent();
        const next = validateSession(await input.backend.refresh({
          refreshToken: previous.refreshToken,
        }), now);
        assertSameOwner(previous, next);
        await persist(next);
        assertOpen();
        return view(next);
      }).finally(() => { refreshInFlight = undefined; });
      return refreshInFlight;
    },
    bindAccount(binding) {
      assertOpen();
      if (binding.externalProof.trim() === '' || binding.idempotencyKey.trim() === '') {
        return Promise.reject(new GuestSessionCoordinatorError('GUEST_SESSION_INVALID_RESPONSE'));
      }
      return enqueue(async () => {
        const previous = requireCurrent();
        const result = await input.backend.bindAccount({
          refreshToken: previous.refreshToken,
          externalProof: binding.externalProof,
          idempotencyKey: binding.idempotencyKey,
        });
        if (result.status === 'conflict') {
          assertOpen();
          return { status: 'conflict' as const };
        }
        if (result.status !== 'bound' && result.status !== 'already-bound') {
          throw new GuestSessionCoordinatorError('GUEST_SESSION_INVALID_RESPONSE');
        }
        const next = validateSession(result.session, now);
        assertSameOwner(previous, next);
        if (next.identityLevel !== 'authenticated') {
          throw new GuestSessionCoordinatorError('GUEST_SESSION_INVALID_RESPONSE');
        }
        await persist(next);
        assertOpen();
        return { status: result.status };
      });
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
      logoutInFlight = enqueue(async () => {
        let revokeFailed = false;
        let token = current?.refreshToken;
        if (token === undefined) {
          try {
            token = (await input.credentials.load({ key: credentialKey })) ?? undefined;
          } catch {
            revokeFailed = true;
          }
        }
        if (token !== undefined) {
          try {
            await input.backend.revoke({ refreshToken: token });
          } catch {
            revokeFailed = true;
          }
        }
        try {
          await input.credentials.remove({ key: credentialKey });
        } catch {
          revokeFailed = true;
        }
        current = undefined;
        if (revokeFailed) {
          throw new GuestSessionCoordinatorError('GUEST_SESSION_LOGOUT_UNCERTAIN');
        }
      });
      return logoutInFlight;
    },
  };
}

function view(session: ServerGuestSessionCredentials): ServerGuestSessionView {
  return {
    serverUserId: session.serverUserId,
    sessionId: session.sessionId,
    identityLevel: session.identityLevel,
    accessExpiresAt: session.accessExpiresAt,
  };
}

function validateSession(
  value: ServerGuestSessionCredentials,
  now: () => number,
): ServerGuestSessionCredentials {
  if (typeof value !== 'object' || value === null
    || typeof value.serverUserId !== 'string' || value.serverUserId.trim() === ''
    || typeof value.sessionId !== 'string' || value.sessionId.trim() === ''
    || (value.identityLevel !== 'guest' && value.identityLevel !== 'authenticated')
    || typeof value.accessToken !== 'string' || value.accessToken.trim() === ''
    || typeof value.refreshToken !== 'string' || value.refreshToken.trim() === ''
    || typeof value.accessExpiresAt !== 'string'
    || !Number.isFinite(Date.parse(value.accessExpiresAt))
    || Date.parse(value.accessExpiresAt) <= now()) {
    throw new GuestSessionCoordinatorError('GUEST_SESSION_INVALID_RESPONSE');
  }
  return value;
}

function assertSameOwner(
  previous: ServerGuestSessionCredentials,
  next: ServerGuestSessionCredentials,
): void {
  if (previous.serverUserId !== next.serverUserId || previous.sessionId !== next.sessionId) {
    throw new GuestSessionCoordinatorError('GUEST_SESSION_OWNERSHIP_CONFLICT');
  }
}
