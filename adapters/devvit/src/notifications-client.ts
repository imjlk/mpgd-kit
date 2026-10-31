import { isThrownInstance, readThrownField, type BridgeNotificationsV2Method } from '@mpgd/bridge';
import {
  assertBridgeNotificationsV2Result,
  readBridgeNotificationsHostCode,
  type BridgeNotificationsV2Payload,
  type BridgeNotificationsV2Result,
} from '@mpgd/bridge/notifications';
import type { NotificationSubscriptionAdapter } from '@mpgd/platform';
import {
  isNotificationErrorCode,
  isValidNotificationTimeZone,
  NotificationError,
  notificationsProtocol,
  toNotificationSubscriptionAdapter,
  type NotificationEndpointRegistration,
  type NotificationProvider,
} from '@mpgd/platform/notifications';

import { devvitNotificationProviderId } from './notifications-contract.js';

/**
 * The webview side of notifications v2 on Devvit, loaded in its own chunk
 * by `createDevvitPlatformGateway({ notifications })`: a
 * `NotificationProvider` over the Devvit server bridge, which serves the
 * game-rendered opt-in from `createDevvitNotificationsV2BridgeHandler`
 * (`@mpgd/adapter-devvit/server`), and the v1 adapter served from it.
 */

export interface CreateDevvitBridgeNotificationProviderInput {
  /** Sends one server bridge request and returns its data; bridge errors reject with their code. */
  readonly request: (method: BridgeNotificationsV2Method, payload: unknown) => Promise<unknown>;
  /** The webview's IANA zone, which the registration carries; `Intl` by default. */
  readonly timeZone?: () => string | undefined;
  /** The webview's locale, which the registration carries; `navigator.language` by default. */
  readonly locale?: () => string | undefined;
}

/**
 * The Devvit profile's provider: reads, the opt-in request, the opt-out
 * (`revokePermission`, because the game renders the consent), and the
 * `platform-user` registration with the webview's locale and zone. No
 * local notifications and no settings link exist, and no event reaches the
 * webview: a notification opens its post, and the game routes from that
 * post's data. Answers are validated again here, so a server that skips
 * validation stays fail-closed.
 *
 * Errors: a bridge error with a `NOTIFICATIONS_*` code becomes a
 * `NotificationError` with that code (and the host code its message names);
 * `NOTIFICATIONS_V2_UNAVAILABLE` from a server without the handler stays
 * that; `UNSUPPORTED_METHOD` or `INVALID_BRIDGE_REQUEST` from a server that
 * predates the methods becomes `NOTIFICATIONS_V2_UNAVAILABLE`; anything else
 * (the oRPC transport failing) is `NOTIFICATIONS_TEMPORARILY_UNAVAILABLE`,
 * retryable unless the failure says otherwise.
 */
export function createDevvitBridgeNotificationProvider(
  input: CreateDevvitBridgeNotificationProviderInput,
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
        message: `The Devvit server answered ${method} with invalid data.`,
        cause: error,
      });
    }
  };
  const timeZone = input.timeZone ?? defaultTimeZone;
  const locale = input.locale ?? defaultLocale;

  return {
    provider: devvitNotificationProviderId,
    async getCapabilities() {
      const answer = await send('notifications.v2.getCapabilities', { protocol: notificationsProtocol });
      if (answer.provider !== devvitNotificationProviderId) {
        throw new NotificationError('NOTIFICATIONS_CONFIGURATION_REQUIRED', {
          message: `The Devvit server serves notifications provider ${answer.provider}, not ${devvitNotificationProviderId}.`,
        });
      }
      return answer.capabilities;
    },
    getPermission: (request) => send('notifications.v2.getPermission', request),
    requestPermission: (request) => send('notifications.v2.requestPermission', request),
    revokePermission: (request) => send('notifications.v2.revokePermission', request),
    async register(): Promise<NotificationEndpointRegistration | null> {
      const { registration } = await send('notifications.v2.register', { protocol: notificationsProtocol });
      if (registration === null || registration.address.kind !== 'platform-user') {
        return registration;
      }
      // The server knows the user; only the webview knows its locale and zone.
      const zone = registration.timeZone ?? readOptional(timeZone);
      const language = registration.locale ?? readOptional(locale);
      return {
        ...registration,
        ...(language === undefined || language.length === 0 || language.length > 2048 ? {} : { locale: language }),
        ...(zone === undefined || !isValidNotificationTimeZone(zone) ? {} : { timeZone: zone }),
      };
    },
    subscribe() {
      // Devvit has no server-to-webview notifications channel.
      return () => {};
    },
  };
}

/**
 * The v1 `NotificationSubscriptionAdapter` served from the v2 provider (RFC
 * "Migration and PR plan", through `toNotificationSubscriptionAdapter`), so
 * v1 and v2 report the same readiness. Every state comes from the host
 * (Devvit `isOptedIn` through the server); a topic outside `topics` reads
 * `configuration-required` and requests `unavailable`.
 */
export function createDevvitNotificationSubscriptionAdapter(
  provider: Pick<NotificationProvider, 'getPermission' | 'requestPermission'>,
  topics: readonly string[],
): NotificationSubscriptionAdapter {
  return toNotificationSubscriptionAdapter(
    {
      async getPermission(request) {
        const snapshot = await provider.getPermission(request);
        return {
          ...snapshot,
          sources: Object.fromEntries(
            Object.keys(snapshot.topics).map((topic) => [topic, 'host' as const]),
          ),
        };
      },
      requestPermission: ({ topics: requested }) =>
        provider.requestPermission({ topics: requested }),
    },
    topics.map((id) => ({ id })),
  );
}

function readOptional(read: () => string | undefined): string | undefined {
  try {
    const value = read();
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

function defaultTimeZone(): string | undefined {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function defaultLocale(): string | undefined {
  const navigatorLike = (globalThis as { readonly navigator?: { readonly language?: unknown } }).navigator;
  return typeof navigatorLike?.language === 'string' ? navigatorLike.language : undefined;
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
  const explicit = typeof failure.retryable === 'boolean' ? { retryable: failure.retryable } : {};
  if (isNotificationErrorCode(failure.code)) {
    const hostCode = message === undefined ? undefined : readBridgeNotificationsHostCode(message);
    return new NotificationError(failure.code, {
      ...(message === undefined ? {} : { message }),
      ...explicit,
      ...(hostCode === undefined ? {} : { hostCode }),
      cause: error,
    });
  }
  if (failure.code === 'UNSUPPORTED_METHOD' || failure.code === 'INVALID_BRIDGE_REQUEST') {
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
