import type { BridgeNotificationsBackendMethod } from '@mpgd/bridge';
import {
  assertBridgeNotificationsBackendPayload,
  assertBridgeNotificationsBackendResult,
  notificationsBackendBridgeHostCodes,
  readBridgeNotificationsHostCode,
  type BridgeNotificationsBackendPayload,
  type BridgeNotificationsBackendResult,
} from '@mpgd/bridge/notifications';
import {
  isNotificationErrorCode,
  NotificationError,
  notificationsProtocol,
  type NotificationErrorCode,
} from '@mpgd/platform/notifications';
import type {
  NotificationRuntimeBackend,
  NotificationRuntimeSession,
} from '@mpgd/platform/notifications-runtime';

/**
 * The webview side of the notifications runtime's backend on Devvit
 * (notifications v2 RFC, "Bridge and versioning", "Backend methods"): a
 * `NotificationRuntimeBackend` over the Devvit server bridge, which serves
 * the Devvit notifications service from
 * `createDevvitNotificationsBackendBridgeHandler`
 * (`@mpgd/adapter-devvit/server`). Loaded in its own chunk.
 *
 * - **Session.** The client never chooses a player. It reads the session
 *   the server answers for the request's logged-in user (`getSession`,
 *   through `refreshSession()`), and `session()` answers the last one read.
 *   Every call names that player as `expectedPlayer`; the server acts for
 *   its own user and refuses a call whose player is not it. A refusal for a
 *   logged-out or changed user makes the client read the session again
 *   (announcing a new one through `onAuthenticated`) and answers
 *   `NOTIFICATIONS_TEMPORARILY_UNAVAILABLE`, which the runtime retries at
 *   its next trigger.
 * - **Errors.** A bridge error with a `NOTIFICATIONS_*` code keeps its code,
 *   retryable flag, and host code. `UNSUPPORTED_METHOD`,
 *   `INVALID_BRIDGE_REQUEST`, and `NOTIFICATIONS_V2_UNAVAILABLE` from a
 *   server that serves no backend are `NOTIFICATIONS_CONFIGURATION_REQUIRED`
 *   (not retryable), as the game-services client reads a Worker without the
 *   session routes. An answer outside the method's contract is
 *   `NOTIFICATIONS_CONFIGURATION_REQUIRED`. Anything else (the transport
 *   failing) and a request with no answer within `timeoutMs` is a retryable
 *   `NOTIFICATIONS_TEMPORARILY_UNAVAILABLE`; a request that timed out may
 *   still have reached the server. A payload the bridge contract refuses is
 *   `NOTIFICATIONS_INVALID_INPUT` and is not sent.
 */

export interface CreateDevvitNotificationsBackendClientInput {
  /** Sends one server bridge request and returns its data; a bridge error rejects with its `code`, `message`, and `retryable`. */
  readonly request: (method: BridgeNotificationsBackendMethod, payload: unknown) => Promise<unknown>;
  /**
   * How long one request may take before the client stops waiting and
   * answers `NOTIFICATIONS_TEMPORARILY_UNAVAILABLE`; 15 seconds by default,
   * at most 2147483647. Devvit ends a server request after 30 seconds.
   */
  readonly timeoutMs?: number;
  /**
   * While no session read has settled (the first one failed, offline or
   * timed out), `session()` and a call that finds no session start another
   * read, at most one this often; 5 seconds by default.
   */
  readonly retryIntervalMs?: number;
  /** The clock the retry interval reads, in milliseconds; `Date.now` by default. */
  readonly now?: () => number;
}

export interface DevvitNotificationsBackendClient extends NotificationRuntimeBackend {
  /**
   * Reads the session the server answers for the request's user, keeps it
   * for `session()`, and announces it through `onAuthenticated` when it is a
   * new one (a first sign-in, or another user). A logged-out answer clears
   * it. Concurrent reads share one request. A read that fails keeps the
   * session as it was and rejects.
   */
  refreshSession(): Promise<NotificationRuntimeSession | undefined>;
}

/** The default `timeoutMs`: a request still unanswered after this is no longer awaited. */
export const defaultDevvitNotificationsBackendTimeoutMs = 15_000;

/** The default `retryIntervalMs` between session reads while none has settled. */
export const defaultDevvitNotificationsBackendRetryIntervalMs = 5_000;

/** Bridge codes a server that serves no notifications backend answers with. */
const backendUnavailableCodes: ReadonlySet<unknown> = new Set([
  'UNSUPPORTED_METHOD',
  'INVALID_BRIDGE_REQUEST',
  'NOTIFICATIONS_V2_UNAVAILABLE',
]);

/** Host codes of a call the server refused for its session; nothing was read or changed. */
const sessionRefusalHostCodes: ReadonlySet<string | undefined> = new Set([
  notificationsBackendBridgeHostCodes.signedOut,
  notificationsBackendBridgeHostCodes.sessionChanged,
]);

/** Creates the client. It holds no session until `refreshSession()` has read one. */
export function createDevvitNotificationsBackendClient(
  input: CreateDevvitNotificationsBackendClientInput,
): DevvitNotificationsBackendClient {
  const timeoutMs = input.timeoutMs ?? defaultDevvitNotificationsBackendTimeoutMs;
  // setTimeout takes at most 2^31 - 1 ms; a longer delay would fire at once.
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new NotificationError('NOTIFICATIONS_INVALID_INPUT', {
      message: 'The Devvit notifications backend timeoutMs must be a positive number of milliseconds, at most 2147483647.',
    });
  }
  const retryIntervalMs = input.retryIntervalMs ?? defaultDevvitNotificationsBackendRetryIntervalMs;
  if (!Number.isFinite(retryIntervalMs) || retryIntervalMs < 0) {
    throw new NotificationError('NOTIFICATIONS_INVALID_INPUT', {
      message: 'The Devvit notifications backend retryIntervalMs must be a non-negative number of milliseconds.',
    });
  }
  const now = input.now ?? Date.now;
  let current: NotificationRuntimeSession | undefined;
  let refreshing: Promise<NotificationRuntimeSession | undefined> | undefined;
  /** When the last session read started or settled, whichever is later. */
  let lastReadAt: number | undefined;
  /**
   * Whether a session read settled for good: the server answered (a
   * logged-out answer too), or it failed in a way a retry cannot change (a
   * server without the backend, or an answer outside the contract, which
   * only a fixed server or a reload changes). Until then `session()` and a
   * call that finds no session start a read (`retryIfUnsettled`), so a
   * first read that failed (offline, timed out) is tried again even though
   * the runtime makes no backend call while it sees no session.
   */
  let sessionSettled = false;
  const listeners = new Set<(session: NotificationRuntimeSession) => void>();

  const send = async <TMethod extends BridgeNotificationsBackendMethod>(
    method: TMethod,
    payload: BridgeNotificationsBackendPayload<TMethod>,
  ): Promise<BridgeNotificationsBackendResult<TMethod>> => {
    try {
      assertBridgeNotificationsBackendPayload(method, payload);
    } catch (error) {
      throw new NotificationError('NOTIFICATIONS_INVALID_INPUT', {
        message: `${method}: the request is outside the bridge contract; it was not sent.`,
        cause: error,
      });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let data: unknown;
    try {
      data = await Promise.race([
        input.request(method, payload),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new NotificationError('NOTIFICATIONS_TEMPORARILY_UNAVAILABLE', {
              message: `${method}: the Devvit server did not answer within ${timeoutMs} ms; the client stopped `
                + 'waiting, and the server may still have handled it.',
            }));
          }, timeoutMs);
        }),
      ]);
    } catch (error) {
      throw toNotificationError(method, error);
    } finally {
      clearTimeout(timer);
    }
    try {
      return assertBridgeNotificationsBackendResult(method, data);
    } catch (error) {
      throw new NotificationError('NOTIFICATIONS_CONFIGURATION_REQUIRED', {
        message: `The Devvit server answered ${method} outside the notifications backend contract.`,
        cause: error,
      });
    }
  };

  const announce = (session: NotificationRuntimeSession): void => {
    for (const listener of [...listeners]) {
      try {
        listener(session);
      } catch {
        // One listener failing never keeps the session from the others.
      }
    }
  };

  const refreshSession = (): Promise<NotificationRuntimeSession | undefined> => {
    if (refreshing !== undefined) {
      return refreshing;
    }
    lastReadAt = now();
    const attempt = (async () => {
      let session: NotificationRuntimeSession | null;
      try {
        ({ session } = await send('notifications.backend.getSession', { protocol: notificationsProtocol }));
      } catch (error) {
        if (error instanceof NotificationError && !error.retryable) {
          sessionSettled = true;
        }
        throw error;
      }
      sessionSettled = true;
      if (session === null) {
        current = undefined;
        return undefined;
      }
      const previous = current;
      const next: NotificationRuntimeSession = { id: session.id, player: session.player };
      if (previous?.id === next.id && previous.player === next.player) {
        return previous;
      }
      current = next;
      announce(next);
      return next;
    })();
    refreshing = attempt;
    // The next read asks again once this one settles, whatever it answered;
    // a retry waits the interval from the settle, so a read that timed out
    // is not followed by another at once.
    void attempt.then(
      () => {
        refreshing = undefined;
        lastReadAt = now();
      },
      () => {
        refreshing = undefined;
        lastReadAt = now();
      },
    );
    return attempt;
  };

  const requireSession = (method: BridgeNotificationsBackendMethod): NotificationRuntimeSession => {
    if (current === undefined) {
      retryIfUnsettled();
      throw new NotificationError('NOTIFICATIONS_TEMPORARILY_UNAVAILABLE', {
        message: `${method} needs a signed-in player; no request was sent.`,
      });
    }
    return current;
  };

  /**
   * While no session is known and no read has settled (none was made, or
   * the last one failed in a way a retry may fix), starts a read in the
   * background, at most one at a time and one per `retryIntervalMs`, so the
   * runtime hears of a signed-in player through onAuthenticated instead of
   * waiting forever.
   */
  const retryIfUnsettled = (): void => {
    if (
      current !== undefined
      || sessionSettled
      || refreshing !== undefined
      || (lastReadAt !== undefined && withinRetryInterval(now() - lastReadAt, retryIntervalMs))
    ) {
      return;
    }
    void refreshSession().catch(() => undefined);
  };

  /**
   * Reads the session again after the server refused a call for `refused`.
   * A read already in flight may have been answered before the user
   * changed. When its answer contradicts the refusal, one more read asks the
   * server again: the refused session itself, or, after a refusal that said
   * another user is signed in, no user. A failed read leaves the session as
   * it was; the next refusal reads again.
   */
  const rereadAfterRefusal = async (
    refused: NotificationRuntimeSession,
    hostCode: string | undefined,
  ): Promise<void> => {
    const contradicts = (read: NotificationRuntimeSession | undefined): boolean =>
      read === undefined
        ? hostCode === notificationsBackendBridgeHostCodes.sessionChanged
        : read.id === refused.id && read.player === refused.player;
    try {
      if (contradicts(await refreshSession())) {
        await refreshSession();
      }
    } catch (error) {
      // A read failed in a way a retry may fix after a stale answer cleared
      // the session: read again later rather than wait for a refusal that
      // cannot come.
      if (current === undefined && error instanceof NotificationError && error.retryable) {
        sessionSettled = false;
      }
      // The refusal is what the caller needs to see.
    }
  };

  /**
   * One call for the current session's player. A refusal for its session
   * reads the session again before it answers, so the runtime sees the
   * player the server serves now when it reacts.
   */
  const call = async <TMethod extends Exclude<BridgeNotificationsBackendMethod, 'notifications.backend.getSession'>>(
    method: TMethod,
    body: Omit<BridgeNotificationsBackendPayload<TMethod>, 'expectedPlayer'>,
    session: NotificationRuntimeSession = requireSession(method),
  ): Promise<BridgeNotificationsBackendResult<TMethod>> => {
    try {
      return await send(method, {
        ...body,
        expectedPlayer: session.player,
      } as BridgeNotificationsBackendPayload<TMethod>);
    } catch (error) {
      if (error instanceof NotificationError && sessionRefusalHostCodes.has(error.hostCode)) {
        await rereadAfterRefusal(session, error.hostCode);
      }
      throw error;
    }
  };

  return {
    session() {
      retryIfUnsettled();
      return current;
    },
    onAuthenticated(listener) {
      // The session already read when the runtime subscribes is not a new one.
      const entry = (session: NotificationRuntimeSession): void => listener(session);
      listeners.add(entry);
      return () => {
        listeners.delete(entry);
      };
    },
    refreshSession,
    async recordConsent(record) {
      await call('notifications.backend.recordConsent', { record });
    },
    async listConsent() {
      return (await call('notifications.backend.listConsent', {})).records;
    },
    async registerEndpoint(registration) {
      await call('notifications.backend.registerEndpoint', { registration });
    },
    async unregisterEndpoint({ provider, player }) {
      const session = current;
      if (session === undefined || session.player !== player) {
        // A Devvit registration belongs to the Reddit user, not to a device,
        // and another user's request cannot reach it.
        return;
      }
      try {
        await call('notifications.backend.unregisterEndpoint', { provider }, session);
      } catch (error) {
        // The user left before the call reached the server: nothing on this
        // webview belongs to that user any more. (On Devvit the service keeps
        // the user's platform-user locale and zone; sends still need the
        // user's opt-in.)
        if (error instanceof NotificationError && sessionRefusalHostCodes.has(error.hostCode)) {
          return;
        }
        throw error;
      }
    },
    async setReminder(reminder) {
      return (await call('notifications.backend.setReminder', { reminder })).status;
    },
    async cancelReminder({ key }) {
      return (await call('notifications.backend.cancelReminder', { key })).cancelled;
    },
    async listNotices() {
      return (await call('notifications.backend.listNotices', {})).notices;
    },
    async recordNotice({ channel, kind, record, dueBy }) {
      await call('notifications.backend.recordNotice', {
        notice: { kind, record: { kind: record.kind, at: record.at }, dueBy },
        channel,
      });
    },
  };
}

function toNotificationError(method: BridgeNotificationsBackendMethod, error: unknown): NotificationError {
  if (error instanceof NotificationError) {
    return error;
  }
  const failure = typeof error === 'object' && error !== null
    ? error as { readonly code?: unknown; readonly message?: unknown; readonly retryable?: unknown }
    : {};
  const message = typeof failure.message === 'string' ? failure.message : undefined;
  if (backendUnavailableCodes.has(failure.code)) {
    return new NotificationError('NOTIFICATIONS_CONFIGURATION_REQUIRED', {
      message: `${method}: the Devvit server serves no notifications backend (wire `
        + 'createDevvitNotificationsBackendBridgeHandler into its bridge).',
      cause: error,
    });
  }
  const explicit = typeof failure.retryable === 'boolean' ? { retryable: failure.retryable } : {};
  if (isNotificationErrorCode(failure.code)) {
    const hostCode = message === undefined ? undefined : readBridgeNotificationsHostCode(message);
    return new NotificationError(failure.code as NotificationErrorCode, {
      ...(message === undefined ? {} : { message }),
      ...explicit,
      ...(hostCode === undefined ? {} : { hostCode }),
      cause: error,
    });
  }
  return new NotificationError('NOTIFICATIONS_TEMPORARILY_UNAVAILABLE', {
    message: `${method}: the Devvit server could not be reached.`,
    ...explicit,
    cause: error,
  });
}

/**
 * Whether `elapsed` milliseconds are still inside the retry interval. A
 * clock that went backwards (a negative or non-finite difference) counts
 * as past it, so a clock change never holds a retry back.
 */
function withinRetryInterval(elapsed: number, retryIntervalMs: number): boolean {
  return elapsed >= 0 && elapsed < retryIntervalMs;
}
