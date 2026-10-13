import typia from 'typia';

import {
  commerceBridgeMethods,
  commerceProtocol,
  type CommerceBridgeMethod,
  type CommerceEventEnvelope,
} from '@mpgd/platform/commerce';
// Types only: the main entry loads no `@mpgd/platform/notifications` code,
// so a game bundle that uses the bridge does not carry the notifications
// validators until it calls `@mpgd/bridge/notifications`.
import type {
  NotificationBridgeMethod,
  NotificationBridgeMethods,
  NotificationErrorCode,
  NotificationEventEnvelope,
} from '@mpgd/platform/notifications';

/**
 * Commerce v2 request methods (RFC "Bridge and versioning"). The literal
 * union below spells them out so the published declaration stays readable;
 * `bridgeCommerceV2Methods` and the type checks under it keep the list equal
 * to `commerceBridgeMethods` from `@mpgd/platform/commerce`.
 */
export type BridgeCommerceV2Method =
  | 'commerce.v2.getCapabilities'
  | 'commerce.v2.fetchProducts'
  | 'commerce.v2.requestPurchase'
  | 'commerce.v2.getAvailablePurchases'
  | 'commerce.v2.finishTransaction'
  | 'commerce.v2.restorePurchases';

/**
 * Notifications v2 request methods (notifications RFC "Bridge and
 * versioning"). Spelled out like the commerce union; the type check under
 * `bridgeNotificationsV2Methods` and the bridge tests keep the list equal to
 * `notificationBridgeMethods` from `@mpgd/platform/notifications`.
 */
export type BridgeNotificationsV2Method =
  | 'notifications.v2.getCapabilities'
  | 'notifications.v2.getPermission'
  | 'notifications.v2.requestPermission'
  | 'notifications.v2.revokePermission'
  | 'notifications.v2.register'
  | 'notifications.v2.scheduleLocal'
  | 'notifications.v2.cancelLocal'
  | 'notifications.v2.listLocal'
  | 'notifications.v2.openSettings';

export type BridgeMethod =
  | 'runtime.getCapabilities'
  | 'identity.getPlayer'
  | 'identity.getSession'
  | 'identity.requestUpgrade'
  | 'presentation.getLaunchIntent'
  | 'presentation.requestGameSurface'
  | 'share.share'
  | 'share.readInboundShare'
  | 'notifications.getStatus'
  | 'notifications.requestSubscription'
  | BridgeNotificationsV2Method
  | 'promotions.getAvailability'
  | 'promotions.grantReward'
  | 'commerce.getProducts'
  | 'commerce.purchase'
  | 'commerce.restore'
  | 'commerce.getEntitlements'
  | BridgeCommerceV2Method
  | 'ads.preload'
  | 'ads.getAvailability'
  | 'ads.prepare'
  | 'ads.show'
  | 'ads.showRewarded'
  | 'ads.showInterstitial'
  | 'ads.mountBanner'
  | 'ads.unmountBanner'
  | 'leaderboard.submitScore'
  | 'leaderboard.open'
  | 'storage.load'
  | 'storage.save'
  | 'credentials.load'
  | 'credentials.save'
  | 'credentials.remove';

export interface BridgeRequest<TPayload = unknown> {
  readonly id: string;
  readonly method: BridgeMethod;
  readonly payload: TPayload;
  readonly meta: {
    readonly target: string;
    readonly appVersion: string;
    readonly buildId: string;
    readonly sentAt: string;
  };
}

export type BridgeResponse<TData = unknown> =
  | {
      readonly id: string;
      readonly ok: true;
      readonly data: TData;
    }
  | {
      readonly id: string;
      readonly ok: false;
      readonly error: {
        readonly code: string;
        readonly message: string;
        readonly retryable: boolean;
      };
    };

export const bridgeCommerceV2Methods: readonly BridgeCommerceV2Method[] = commerceBridgeMethods;

// Both directions must hold: every platform method is a bridge method, and the
// bridge union names nothing the platform contract does not define.
type MethodsAgree<A extends string, B extends string> =
  [A] extends [B] ? [B] extends [A] ? true : never : never;
const bridgeCommerceV2MethodsAgree: MethodsAgree<BridgeCommerceV2Method, CommerceBridgeMethod> =
  true;
void bridgeCommerceV2MethodsAgree;

const bridgeCommerceV2MethodSet: ReadonlySet<string> = new Set(bridgeCommerceV2Methods);

export function isBridgeCommerceV2Method(method: string): method is BridgeCommerceV2Method {
  return bridgeCommerceV2MethodSet.has(method);
}

/**
 * Answer for a commerce v2 request that reaches a transport without a v2
 * provider. Non-retryable: the caller must fall back to v1 or a server route,
 * not retry the same transport.
 */
export const commerceV2UnavailableBridgeErrorCode = 'COMMERCE_V2_UNAVAILABLE' as const;

export function createCommerceV2UnavailableBridgeError(
  request: Pick<BridgeRequest, 'id' | 'method'>,
  transport: string,
): BridgeResponse {
  return createBridgeError(
    request.id,
    commerceV2UnavailableBridgeErrorCode,
    `${transport} does not provide commerce v2; ${request.method} is unavailable.`,
  );
}

// Listed here rather than imported, so the main entry stays free of
// `@mpgd/platform/notifications` code. The checks below keep both the union
// and this list equal to the platform contract's methods; the bridge tests
// also compare the order.
const notificationsV2MethodList = [
  'notifications.v2.getCapabilities',
  'notifications.v2.getPermission',
  'notifications.v2.requestPermission',
  'notifications.v2.revokePermission',
  'notifications.v2.register',
  'notifications.v2.scheduleLocal',
  'notifications.v2.cancelLocal',
  'notifications.v2.listLocal',
  'notifications.v2.openSettings',
] as const;
export const bridgeNotificationsV2Methods: readonly BridgeNotificationsV2Method[] =
  Object.freeze(notificationsV2MethodList);
const bridgeNotificationsV2MethodsAgree: MethodsAgree<
  BridgeNotificationsV2Method,
  NotificationBridgeMethod
> = true;
void bridgeNotificationsV2MethodsAgree;
const bridgeNotificationsV2MethodListAgrees: MethodsAgree<
  (typeof notificationsV2MethodList)[number],
  NotificationBridgeMethod
> = true;
void bridgeNotificationsV2MethodListAgrees;

const bridgeNotificationsV2MethodSet: ReadonlySet<string> = new Set(bridgeNotificationsV2Methods);

export function isBridgeNotificationsV2Method(
  method: string,
): method is BridgeNotificationsV2Method {
  return bridgeNotificationsV2MethodSet.has(method);
}

/**
 * Answer for a notifications v2 request that reaches a transport without v2
 * (notifications RFC "Bridge and versioning"). Not retryable: the same
 * transport answers the same way again, so the caller keeps the v1
 * `notifications` adapter instead of retrying.
 */
export const notificationsV2UnavailableBridgeErrorCode =
  'NOTIFICATIONS_V2_UNAVAILABLE' as const satisfies NotificationErrorCode;

export function createNotificationsV2UnavailableBridgeError(
  request: Pick<BridgeRequest, 'id' | 'method'>,
  transport: string,
): BridgeResponse {
  return createBridgeError(
    request.id,
    notificationsV2UnavailableBridgeErrorCode,
    `${transport} does not provide notifications v2; ${request.method} is unavailable.`,
  );
}

/** The payload a notifications v2 method takes. */
export type BridgeNotificationsV2Payload<TMethod extends BridgeNotificationsV2Method> =
  NotificationBridgeMethods[TMethod]['payload'];

/** The data a notifications v2 method answers with. */
export type BridgeNotificationsV2Result<TMethod extends BridgeNotificationsV2Method> =
  NotificationBridgeMethods[TMethod]['result'];

/**
 * Event side of the bridge: every protocol shares one event channel, and each
 * envelope names its protocol. A transport numbers each protocol's events per
 * session from 0 (`createBridgeEventSource` does).
 */
export type BridgeEvent = BridgeCommerceEvent | BridgeNotificationsEvent;

/** `{ protocol: 'mpgd.commerce.v2', sequence, event }` */
export type BridgeCommerceEvent = CommerceEventEnvelope;

/** `{ protocol: 'mpgd.notifications.v2', sequence, event }` */
export type BridgeNotificationsEvent = NotificationEventEnvelope;

export type BridgeEventProtocol = BridgeEvent['protocol'];

/** The event an envelope of `TProtocol` carries. */
export type BridgeEventOf<TProtocol extends BridgeEventProtocol> = Extract<
  BridgeEvent,
  { readonly protocol: TProtocol }
>['event'];

export const bridgeCommerceEventProtocol = commerceProtocol;
export const bridgeNotificationsEventProtocol =
  'mpgd.notifications.v2' as const satisfies NotificationEventEnvelope['protocol'];

/**
 * The commerce v2 event protocol, named when commerce was the only protocol
 * on the event channel.
 * @deprecated Use `bridgeCommerceEventProtocol`; a listener tells the
 * protocols apart by each envelope's `protocol`.
 */
export const bridgeEventProtocol = commerceProtocol;

export type BridgeEventListener = (event: BridgeEvent) => void;

/**
 * Implemented by transports that can deliver events; the unsubscribe stops
 * delivery. A listener receives every protocol on the channel and ignores the
 * ones it does not handle.
 */
export interface BridgeEventSource {
  subscribe(listener: BridgeEventListener): () => void;
}

/** Where a host's events of one protocol come from, such as a provider's `subscribe`. */
export interface BridgeEventStream<TEvent> {
  subscribe(listener: (event: TEvent) => void): () => void;
}

/**
 * The host side of one protocol's events for one bridge session; create one
 * per session. It subscribes to `stream` when the first bridge listener
 * attaches, so events the stream buffered until its first subscriber reach
 * that listener, and unsubscribes when the last one leaves. Each event goes
 * out as `{ protocol, sequence, event }`, where `sequence` starts at 0 and
 * counts this session's events of that protocol, including across a detach.
 *
 * - A listener that throws, or returns a promise that rejects, does not keep
 *   the event from the others; the failure is reported with `console.warn`.
 * - An event the stream emits during a delivery (a listener can make it emit)
 *   waits for that delivery, so every listener sees the sequence in order.
 * - The last listener leaving during a delivery detaches the stream only once
 *   the delivery ends, so a listener that replaces itself keeps the stream
 *   attached and receives no event twice.
 * - If `stream.subscribe` throws, every subscription made during that call,
 *   including any a listener made while the stream replayed its buffer, is
 *   dropped, so none stays registered without an attached stream.
 * - An event emitted while no bridge listener is attached never reaches the
 *   bridge. A provider buffers only until its first subscriber, so a session
 *   should keep one listener for its life.
 */
export function createBridgeEventSource(
  protocol: typeof bridgeCommerceEventProtocol,
  stream: BridgeEventStream<BridgeEventOf<typeof bridgeCommerceEventProtocol>>,
): BridgeEventSource;
export function createBridgeEventSource(
  protocol: typeof bridgeNotificationsEventProtocol,
  stream: BridgeEventStream<BridgeEventOf<typeof bridgeNotificationsEventProtocol>>,
): BridgeEventSource;
export function createBridgeEventSource(
  protocol: BridgeEventProtocol,
  stream: BridgeEventStream<BridgeEventOf<BridgeEventProtocol>>,
): BridgeEventSource {
  // One entry per subscribe call, so the same listener subscribed twice is
  // two subscriptions with their own unsubscribe.
  const subscriptions = new Set<{ readonly listener: BridgeEventListener }>();
  const pending: BridgeEvent[] = [];
  let sequence = 0;
  let delivering = false;
  let detach: (() => void) | undefined;
  let detachAfterDelivery = false;
  let attaching = false;

  const reportListenerFailure = (error: unknown): void => {
    console.warn(`A ${protocol} bridge event listener failed.`, error);
  };
  const deliver = (event: BridgeEventOf<BridgeEventProtocol>): void => {
    // The overloads pair each protocol with its own events.
    pending.push({ protocol, sequence, event } as BridgeEvent);
    sequence += 1;
    if (delivering) {
      return;
    }
    delivering = true;
    try {
      for (let envelope = pending.shift(); envelope !== undefined; envelope = pending.shift()) {
        for (const subscription of [...subscriptions]) {
          // A listener another one removed during this delivery gets nothing more.
          if (!subscriptions.has(subscription)) {
            continue;
          }
          try {
            const returned: unknown = subscription.listener(envelope);
            if (isPromiseLike(returned)) {
              void returned.then(undefined, reportListenerFailure);
            }
          } catch (error) {
            reportListenerFailure(error);
          }
        }
      }
    } finally {
      delivering = false;
      if (detachAfterDelivery) {
        detachAfterDelivery = false;
        detachWhenIdle();
      }
    }
  };
  const detachWhenIdle = (): void => {
    if (subscriptions.size > 0 || detach === undefined) {
      return;
    }
    if (delivering) {
      // Detaching mid-delivery would let a listener that replaces itself
      // attach the stream a second time while the stream is still emitting.
      detachAfterDelivery = true;
      return;
    }
    const unsubscribe = detach;
    detach = undefined;
    unsubscribe();
  };

  return {
    subscribe(listener) {
      const subscription = { listener };
      // A listener may subscribe another while the stream delivers what it
      // buffered; the stream is attached once.
      if (detach !== undefined || attaching) {
        subscriptions.add(subscription);
      } else {
        const registeredBefore = new Set(subscriptions);
        subscriptions.add(subscription);
        attaching = true;
        try {
          detach = stream.subscribe(deliver);
        } catch (error) {
          // Drop this subscription and any a listener made during the replay.
          for (const added of [...subscriptions]) {
            if (!registeredBefore.has(added)) {
              subscriptions.delete(added);
            }
          }
          throw error;
        } finally {
          attaching = false;
        }
      }
      return () => {
        if (subscriptions.delete(subscription)) {
          detachWhenIdle();
        }
      };
    },
  };
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (typeof value === 'object' || typeof value === 'function')
    && value !== null
    && typeof (value as { readonly then?: unknown }).then === 'function';
}

export const bridgeStorageLoadProtocol = 'mpgd.storage.load.v1' as const;
export const bridgeCredentialLoadProtocol = 'mpgd.credentials.load.v1' as const;

export type BridgeCredentialLoadData =
  | {
      readonly __mpgdBridgeProtocol: typeof bridgeCredentialLoadProtocol;
      readonly found: false;
    }
  | {
      readonly __mpgdBridgeProtocol: typeof bridgeCredentialLoadProtocol;
      readonly found: true;
      readonly value: string;
    };

export function decodeBridgeCredentialLoadData(input: unknown): string | null {
  if (typeof input !== 'object' || input === null
    || !('__mpgdBridgeProtocol' in input)
    || input.__mpgdBridgeProtocol !== bridgeCredentialLoadProtocol
    || !('found' in input)) {
    throw new Error('Credential bridge load returned an invalid response.');
  }
  if (input.found === false && !('value' in input)) {
    return null;
  }
  if (input.found === true && 'value' in input
    && typeof input.value === 'string' && input.value !== '') {
    return input.value;
  }
  throw new Error('Credential bridge load returned an invalid response.');
}

export type BridgeStorageLoadData =
  | {
      readonly __mpgdBridgeProtocol: typeof bridgeStorageLoadProtocol;
      readonly found: false;
    }
  | {
      readonly __mpgdBridgeProtocol: typeof bridgeStorageLoadProtocol;
      readonly found: true;
      readonly value: unknown;
    };

export const assertBridgeRequest = typia.createAssert<BridgeRequest>();
export const assertBridgeResponse = typia.createAssert<BridgeResponse>();

let bridgeEventAssert: ((input: unknown) => BridgeEvent) | undefined;

/**
 * Validates an event envelope of either protocol and rejects unknown keys.
 * The validator covers every event of both protocols, so it is built on the
 * first call: a bundle that never validates a bridge event leaves it out.
 * An `endpoint-changed` registration also needs a `timeZone` that `Intl`
 * knows, as `assertNotificationEndpointRegistration` requires of a
 * `register` answer.
 */
export function assertBridgeEvent(input: unknown): BridgeEvent {
  bridgeEventAssert ??= typia.createAssertEquals<BridgeEvent>();
  const envelope = bridgeEventAssert(input);
  if (envelope.protocol === bridgeNotificationsEventProtocol
    && envelope.event.type === 'endpoint-changed') {
    const { timeZone } = envelope.event.registration;
    if (timeZone !== undefined && !isKnownTimeZone(timeZone)) {
      throw new TypeError(`Unknown time zone in the registration: ${timeZone}`);
    }
  }
  return envelope;
}

// The rule of `isValidNotificationTimeZone` from `@mpgd/platform/notifications`,
// kept here so the main entry loads none of that module's code.
function isKnownTimeZone(timeZone: string): boolean {
  try {
    void new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function decodeBridgeStorageLoadData(
  input: unknown,
): { readonly value: unknown } | null {
  if (input === null) {
    return null;
  }

  if (input === undefined) {
    throw new Error('Storage bridge load returned an invalid response.');
  }

  if (
    typeof input !== 'object' ||
    !(input !== null && '__mpgdBridgeProtocol' in input) ||
    input.__mpgdBridgeProtocol !== bridgeStorageLoadProtocol
  ) {
    return { value: input };
  }

  const response = input as {
    readonly __mpgdBridgeProtocol: typeof bridgeStorageLoadProtocol;
    readonly found?: unknown;
    readonly value?: unknown;
  };

  if (response.found === false) {
    return null;
  }

  if (response.found !== true) {
    throw new Error('Storage bridge load returned an invalid response.');
  }

  if (!Object.prototype.hasOwnProperty.call(response, 'value')) {
    throw new Error('Storage bridge load returned an invalid response.');
  }

  return { value: response.value };
}

export function createBridgeError(
  id: string,
  code: string,
  message: string,
  retryable = false,
): BridgeResponse {
  return {
    id,
    ok: false,
    error: {
      code,
      message,
      retryable,
    },
  };
}
