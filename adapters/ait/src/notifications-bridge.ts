import {
  bridgeNotificationsEventProtocol,
  isThrownInstance,
  readThrownField,
  type BridgeNotificationsEvent,
  type BridgeNotificationsV2Method,
} from '@mpgd/bridge';
import {
  assertBridgeNotificationsV2Result,
  createNotificationsV2BridgeHandler,
  readBridgeNotificationsHostCode,
  type BridgeNotificationsV2Payload,
  type BridgeNotificationsV2Result,
  type NotificationsV2BridgeHandler,
} from '@mpgd/bridge/notifications';
import {
  assertNotificationEventEnvelope,
  isNotificationErrorCode,
  NotificationError,
  notificationsProtocol,
  notificationsProtocolVersion,
  type NotificationCapabilities,
  type NotificationEvent,
  type NotificationProvider,
  type NotificationProviderId,
} from '@mpgd/platform/notifications';

/**
 * Notifications v2 over the Apps in Toss game bridge (notifications RFC
 * "Bridge and versioning"). The host side serves the nine
 * `notifications.v2.*` methods from a `NotificationProvider` and pushes its
 * events in the `mpgd.notifications.v2` envelope; the game side is a
 * `NotificationProvider` over the installed bridge. Both sides validate every
 * payload and answer with the `@mpgd/bridge/notifications` validators. This
 * module imports no Apps in Toss SDK.
 */

export type AitNotificationsV2BridgeHandler = NotificationsV2BridgeHandler;

/**
 * Host side: `createNotificationsV2BridgeHandler` from
 * `@mpgd/bridge/notifications`, which checks every payload and answer, maps
 * failures fail-closed with the host code named in the message, and numbers
 * the provider's events per handler from 0, attaching the provider for the
 * first bridge listener so its buffered cold open reaches that listener. A
 * provider without `register` answers no address (`null`), as the Apps in
 * Toss profile always offers registration.
 */
export function createAitNotificationsV2BridgeHandler(
  provider: NotificationProvider,
): AitNotificationsV2BridgeHandler {
  return createNotificationsV2BridgeHandler({
    provider,
    label: 'Apps in Toss',
    registerOptional: true,
  });
}

// Game side.

export interface CreateAitBridgeNotificationProviderInput {
  /** The provider id the host serves; `apps-in-toss` for the Apps in Toss host. */
  readonly provider: NotificationProviderId;
  /** Sends one bridge request and returns its data; bridge errors reject as `PlatformOperationError`. */
  readonly request: (method: BridgeNotificationsV2Method, payload: unknown) => Promise<unknown>;
  readonly subscribe: (listener: (event: BridgeNotificationsEvent) => void) => () => void;
}

/**
 * `NotificationProvider` over a bridge that serves the `notifications.v2.*`
 * methods and the event envelope. It offers what the Apps in Toss profile
 * has: reads, requests, the `platform-user` registration, and the settings
 * answer, but no local notifications and no revocation. Answers are validated
 * again here, so a transport that skips validation stays fail-closed. A
 * bridge error with a `NOTIFICATIONS_*` code becomes a `NotificationError`
 * with that code and the host code the message names;
 * `UNSUPPORTED_METHOD` or `INVALID_BRIDGE_REQUEST` from a host that predates
 * the methods becomes `NOTIFICATIONS_V2_UNAVAILABLE`; any other failure
 * `NOTIFICATIONS_TEMPORARILY_UNAVAILABLE`, retryable unless the failure says
 * otherwise. An event envelope of another
 * protocol is ignored, and an invalid one is dropped with a warning.
 *
 * The host must be one this game can use: it serves `input.provider` and a
 * notifications protocol version this game's (`notificationsProtocolVersion`)
 * is compatible with (`isCompatibleNotificationsProtocolVersion`). The host
 * wrapper and the game are built separately, and an incompatible host may
 * read the same payloads differently, so the provider fails closed:
 *
 * - The verdict comes from a capability read. `getCapabilities` reads and
 *   judges every time; any other method, before the first verdict, reads
 *   once first (concurrent calls share that read). A read that fails, or an
 *   answer that breaks the contract, gives no verdict: the method rejects
 *   with that failure, and the next call reads again.
 * - Once a host is judged incompatible, every method rejects with
 *   `NOTIFICATIONS_CONFIGURATION_REQUIRED`, `getCapabilities` included, so
 *   the gateway reports notifications as `configuration-required`.
 * - `subscribe` is synchronous and cannot wait for a read. With no verdict
 *   yet it attaches at once and starts a read, because the host hands its
 *   buffered cold open to its first listener when that listener attaches;
 *   if the read then finds the host incompatible, every subscription is
 *   detached and receives nothing more. With an incompatible verdict,
 *   `subscribe` does not attach at all.
 */
export function createAitBridgeNotificationProvider(
  input: CreateAitBridgeNotificationProviderInput,
): NotificationProvider {
  const send = async <TMethod extends BridgeNotificationsV2Method>(
    method: TMethod,
    payload: BridgeNotificationsV2Payload<TMethod>,
  ): Promise<BridgeNotificationsV2Result<TMethod>> => {
    let data: unknown;
    try {
      data = await input.request(method, payload);
    } catch (error) {
      throw toNotificationError(error);
    }
    try {
      return assertBridgeNotificationsV2Result(method, data);
    } catch (error) {
      throw new NotificationError('NOTIFICATIONS_CONFIGURATION_REQUIRED', {
        message: `The bridge answered ${method} with invalid data.`,
        cause: error,
      });
    }
  };

  /** `undefined` until a read judges the host; then compatible, or the reason it is not. */
  let verdict: { readonly compatible: true } | { readonly compatible: false; readonly message: string } | undefined;
  let reading: Promise<NotificationCapabilities> | undefined;
  /** Detaches every live subscription; called when the host is judged incompatible. */
  const subscriptions = new Set<() => void>();
  const incompatible = (message: string): NotificationError =>
    new NotificationError('NOTIFICATIONS_CONFIGURATION_REQUIRED', { message });
  const judge = (answer: BridgeNotificationsV2Result<'notifications.v2.getCapabilities'>): void => {
    let message: string | undefined;
    if (answer.provider !== input.provider) {
      message = `The bridge serves notifications provider ${answer.provider}, not ${input.provider}.`;
    } else if (!isCompatibleNotificationsProtocolVersion(
      answer.protocolVersion,
      notificationsProtocolVersion,
    )) {
      message = `The bridge speaks notifications protocol ${
        answer.protocolVersion.slice(0, 64)
      }; this game speaks ${notificationsProtocolVersion}.`;
    }
    if (message === undefined) {
      verdict = { compatible: true };
      return;
    }
    verdict = { compatible: false, message };
    const detaches = [...subscriptions];
    subscriptions.clear();
    for (const detach of detaches) {
      try {
        detach();
      } catch (error) {
        console.warn('AIT notifications subscription could not detach.', error);
      }
    }
  };
  /** One capability read, shared by concurrent callers; a failure is not a verdict. */
  const read = (): Promise<NotificationCapabilities> => {
    reading ??= (async () => {
      try {
        const answer = await send('notifications.v2.getCapabilities', { protocol: notificationsProtocol });
        judge(answer);
        if (verdict?.compatible === false) {
          throw incompatible(verdict.message);
        }
        return answer.capabilities;
      } finally {
        reading = undefined;
      }
    })();
    return reading;
  };
  /** Resolves when the host is known to be compatible; rejects otherwise. */
  const ready = async (): Promise<void> => {
    if (verdict === undefined) {
      await read();
    } else if (!verdict.compatible) {
      throw incompatible(verdict.message);
    }
  };
  const call = async <TResult>(run: () => Promise<TResult>): Promise<TResult> => {
    await ready();
    return run();
  };

  return {
    provider: input.provider,
    async getCapabilities() {
      if (verdict?.compatible === false) {
        throw incompatible(verdict.message);
      }
      return read();
    },
    getPermission: (request) => call(() => send('notifications.v2.getPermission', request)),
    requestPermission: (request) => call(() => send('notifications.v2.requestPermission', request)),
    register: () =>
      call(async () =>
        (await send('notifications.v2.register', { protocol: notificationsProtocol })).registration),
    openSettings: () =>
      call(async () => (await send('notifications.v2.openSettings', { protocol: notificationsProtocol })).status),
    subscribe(listener) {
      if (verdict?.compatible === false) {
        console.warn(`AIT notifications events are not attached: ${verdict.message}`);
        return () => {};
      }
      let closed = false;
      const unsubscribe = input.subscribe((envelope) => {
        if (closed) {
          return;
        }
        const event = readAitBridgeNotificationEvent(envelope);
        if (event !== undefined) {
          listener(event);
        }
      });
      const detach = (): void => {
        if (closed) {
          return;
        }
        closed = true;
        subscriptions.delete(detach);
        unsubscribe();
      };
      subscriptions.add(detach);
      if (verdict === undefined) {
        // A failed read leaves the subscription attached and is read again
        // by the next call; only an incompatible verdict detaches it.
        void read().catch(() => {});
      }
      return detach;
    },
  };
}

/**
 * The event a bridge envelope carries, or `undefined` for an envelope of
 * another protocol (not ours to judge) or an invalid one (dropped with a
 * warning). An envelope without a protocol is malformed and reaches the
 * validator.
 */
function readAitBridgeNotificationEvent(envelope: unknown): NotificationEvent | undefined {
  const protocol: unknown = typeof envelope === 'object' && envelope !== null
    ? (envelope as { readonly protocol?: unknown }).protocol
    : undefined;
  if (typeof protocol === 'string' && protocol !== bridgeNotificationsEventProtocol) {
    return undefined;
  }
  try {
    return assertNotificationEventEnvelope(envelope).event;
  } catch (error) {
    console.warn('AIT bridge delivered an invalid notifications event.', error);
    return undefined;
  }
}

/**
 * Whether a host speaking notifications protocol `host` can serve a game
 * speaking `game`, both semantic versions such as `2.0.0-draft.1`. While
 * either is a pre-release, the draft contract can change between drafts, so
 * the versions must be equal, or share the major and the whole pre-release
 * tag (`draft.1`): `2.0.0-draft.1` does not serve `2.0.0-draft.2` or `2.0.0`.
 * Between two releases, the major decides, as the commerce evidence registry
 * compares commerce protocol versions. A version that is not a semantic
 * version is never compatible.
 */
export function isCompatibleNotificationsProtocolVersion(host: string, game: string): boolean {
  const hostVersion = parseProtocolVersion(host);
  const gameVersion = parseProtocolVersion(game);
  if (hostVersion === undefined || gameVersion === undefined) {
    return false;
  }
  // Two releases have no pre-release tag, so this compares their majors;
  // with a pre-release on either side, the tags must match too (an exact
  // match has both).
  return hostVersion.major === gameVersion.major && hostVersion.prerelease === gameVersion.prerelease;
}

/** A SemVer 2.0.0 pre-release identifier: a number without leading zeros, or alphanumerics. */
const prereleaseIdentifier = '(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)';
const protocolVersionPattern = new RegExp(
  `^(0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)`
    + `(?:-(${prereleaseIdentifier}(?:\\.${prereleaseIdentifier})*))?`
    + '(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$',
  'u',
);

function parseProtocolVersion(
  version: string,
): { readonly major: string; readonly prerelease: string | undefined } | undefined {
  const match = protocolVersionPattern.exec(version);
  const major = match?.[1];
  return major === undefined ? undefined : { major, prerelease: match?.[2] };
}

function toNotificationError(error: unknown): NotificationError {
  if (isThrownInstance(error, NotificationError)) {
    return error;
  }
  // Each field read once; one whose getter or Proxy trap throws counts as missing.
  const failure = {
    code: readThrownField(error, 'code'),
    message: readThrownField(error, 'message'),
    retryable: readThrownField(error, 'retryable'),
  };
  const message = typeof failure.message === 'string' ? failure.message : undefined;
  // Only an explicit flag overrides the code's default: a raw transport
  // failure (a plain Error) stays retryable as NOTIFICATIONS_TEMPORARILY_UNAVAILABLE.
  const explicit = typeof failure.retryable === 'boolean' ? { retryable: failure.retryable } : {};
  if (isNotificationErrorCode(failure.code)) {
    // The host handler names the host's own code in the message; it is the
    // only place a bridge error can carry it.
    const hostCode = message === undefined ? undefined : readBridgeNotificationsHostCode(message);
    return new NotificationError(failure.code, {
      ...(message === undefined ? {} : { message }),
      ...explicit,
      ...(hostCode === undefined ? {} : { hostCode }),
      cause: error,
    });
  }
  if (failure.code === 'UNSUPPORTED_METHOD' || failure.code === 'INVALID_BRIDGE_REQUEST') {
    // A host that predates the methods.
    return new NotificationError('NOTIFICATIONS_V2_UNAVAILABLE', {
      ...(message === undefined ? {} : { message }),
      cause: error,
    });
  }
  return new NotificationError('NOTIFICATIONS_TEMPORARILY_UNAVAILABLE', {
    ...(message === undefined ? {} : { message }),
    ...explicit,
    cause: error,
  });
}
