import type {
  NotificationDeliveryContent,
  NotificationPermissionState,
  NotificationProviderId,
  NotificationTemplateData,
  NotificationTopicDeclaration,
} from '@mpgd/platform/notifications';

/**
 * The server-side remote delivery provider contract (notifications v2 RFC,
 * "Delivery providers" and "Provider answers"). It is built only from
 * `@mpgd/platform/notifications` types and literal unions, so a provider
 * module (FCM here, Apps in Toss in its own module) fits it structurally
 * without importing anything from this package.
 *
 * A provider sends exactly what the policy gate rendered: the service runs
 * `evaluateNotificationDelivery` immediately before every call, and a provider
 * never decides policy.
 */

/**
 * Why a Firebase installation id (FID, `fcm-installation`) is refused, at
 * registration and at send. The kind is reserved: FCM is moving to FIDs, but
 * HTTP v1 has no FID send target yet. It lives here, beside the address
 * kinds, so the service can use it without importing the FCM provider.
 */
export const fcmInstallationIdRefusal =
  'Firebase installation ids (fcm-installation) are reserved and refused until FCM can send to them; register the FCM registration token (fcm-token).';

/** A device address as the endpoint registry stores it; FCM keeps the kinds apart. */
export interface NotificationDeviceAddress {
  readonly kind: 'fcm-token' | 'fcm-installation';
  readonly value: string;
  readonly environment?: 'production' | 'sandbox';
}

/** Who one delivery goes to: a device endpoint, or a resolved platform identity. */
export type NotificationRemoteRecipient =
  | {
      readonly kind: 'device';
      /** The game-services session's installation the endpoint belongs to. */
      readonly installationId: string;
      readonly address: NotificationDeviceAddress;
    }
  | {
      readonly kind: 'platform-user';
      /**
       * The provider's own recipient id, resolved by the backend from the
       * player's authenticated identity (an Apps in Toss user key, a Reddit
       * user id), never from a key the client sent.
       */
      readonly id: string;
    };

/** One recipient's delivery of one send, after the gate allowed it. */
export interface NotificationRemoteDeliveryRequest {
  /**
   * The ledger key of this delivery: the send key for a platform-user
   * recipient, `<send key>:<encodeURIComponent(installationId)>` for a device
   * endpoint. A replay of the same delivery carries the same key, so a
   * provider that can deduplicate (a provider-side idempotency key or
   * outbox) uses it.
   */
  readonly idempotencyKey: string;
  /** The send's own idempotency key. */
  readonly sendKey: string;
  readonly provider: NotificationProviderId;
  readonly player: string;
  /** The topic as declared for the recipient's target, with that target's mapping. */
  readonly topic: NotificationTopicDeclaration;
  readonly recipient: NotificationRemoteRecipient;
  /** The content the gate rendered; under `kr` it already carries the advertising label, sender, opt-out line, and action. */
  readonly content: NotificationDeliveryContent;
  /** RFC 3339: the message must not be shown after this instant (FCM `android.ttl` and `apns-expiration`). */
  readonly expiresAt?: string;
  readonly templateData?: NotificationTemplateData;
  /** Untrusted routing data the open carries; never a grant. */
  readonly data?: Readonly<Record<string, string>>;
  /** The send's post or comment link, else the mapping's (providers whose entry sets `link`). */
  readonly link?: string;
  /** The locale the content was resolved for. */
  readonly locale?: string;
  /** The time of the call, RFC 3339; a provider computes relative expiries from it. */
  readonly at: string;
}

/**
 * Every provider answer maps to one of five kinds (RFC "Provider answers"):
 *
 * - `accepted`: the provider took the message.
 * - `unregistered`: the address is dead; the endpoint is invalidated.
 * - `rate-limited`: the provider proves nothing was sent; the delivery waits
 *   `retryAfterSeconds` (60 when absent), then backs off.
 * - `rejected`: the provider proves nothing was sent and the same send would
 *   fail again. `agreement` also records a provider denial.
 * - `ambiguous`: the provider cannot say whether it sent (a timeout, a 5xx
 *   answer). The claim is kept until its lease ends.
 *
 * A provider that throws is treated as `ambiguous`.
 */
export type NotificationRemoteDeliveryAnswer =
  | { readonly status: 'accepted'; readonly providerMessageId?: string }
  | { readonly status: 'unregistered' }
  | { readonly status: 'rate-limited'; readonly retryAfterSeconds?: number }
  | {
      readonly status: 'rejected';
      readonly reason: 'configuration' | 'recipient' | 'agreement';
      /** The provider's own error code, for logs; never shown to players. */
      readonly providerCode?: string;
    }
  | { readonly status: 'ambiguous'; readonly providerCode?: string };

/**
 * The provider code of a `rejected` answer for a message that would arrive
 * after its expiry: nothing was sent, and it is routine, not a setup error.
 */
export const notificationExpiredProviderCode = 'MESSAGE_EXPIRED';

/** A server-side remote delivery provider: `{ id, send }`. */
export interface NotificationRemoteDeliveryProvider {
  /** Equals the registry entry's `provider`. */
  readonly id: NotificationProviderId;
  send(request: NotificationRemoteDeliveryRequest): Promise<NotificationRemoteDeliveryAnswer>;
  /**
   * The host's permission at send time, for a provider whose registry entry
   * is `serverReadable` (Devvit `isOptedIn`). The gate requires it there.
   */
  readPermission?(input: {
    readonly player: string;
    readonly topic: string;
  }): Promise<NotificationPermissionState>;
}
