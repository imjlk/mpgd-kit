import {
  bridgeNotificationsEventProtocol,
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
 * `getCapabilities` fails closed with `NOTIFICATIONS_CONFIGURATION_REQUIRED`
 * when the host serves another provider id or speaks a notifications
 * protocol version this game's (`notificationsProtocolVersion`) is not
 * compatible with (`isCompatibleNotificationsProtocolVersion`): the host
 * wrapper and the game are built separately, and an incompatible host may
 * read the same payloads differently. The gateway then reports
 * notifications as `configuration-required`.
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
  return {
    provider: input.provider,
    async getCapabilities() {
      const answer = await send('notifications.v2.getCapabilities', { protocol: notificationsProtocol });
      if (answer.provider !== input.provider) {
        throw new NotificationError('NOTIFICATIONS_CONFIGURATION_REQUIRED', {
          message: `The bridge serves notifications provider ${answer.provider}, not ${input.provider}.`,
        });
      }
      if (!isCompatibleNotificationsProtocolVersion(answer.protocolVersion, notificationsProtocolVersion)) {
        throw new NotificationError('NOTIFICATIONS_CONFIGURATION_REQUIRED', {
          message: `The bridge speaks notifications protocol ${
            answer.protocolVersion.slice(0, 64)
          }; this game speaks ${notificationsProtocolVersion}.`,
        });
      }
      return answer.capabilities;
    },
    getPermission: (request) => send('notifications.v2.getPermission', request),
    requestPermission: (request) => send('notifications.v2.requestPermission', request),
    async register() {
      return (await send('notifications.v2.register', { protocol: notificationsProtocol }))
        .registration;
    },
    async openSettings() {
      return (await send('notifications.v2.openSettings', { protocol: notificationsProtocol }))
        .status;
    },
    subscribe(listener) {
      return input.subscribe((envelope) => {
        const event = readAitBridgeNotificationEvent(envelope);
        if (event !== undefined) {
          listener(event);
        }
      });
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

const protocolVersionPattern =
  /^(0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

function parseProtocolVersion(
  version: string,
): { readonly major: string; readonly prerelease: string | undefined } | undefined {
  const match = protocolVersionPattern.exec(version);
  const major = match?.[1];
  return major === undefined ? undefined : { major, prerelease: match?.[2] };
}

function toNotificationError(error: unknown): NotificationError {
  if (error instanceof NotificationError) {
    return error;
  }
  const failure = typeof error === 'object' && error !== null
    ? error as { readonly code?: unknown; readonly message?: unknown; readonly retryable?: unknown }
    : {};
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
