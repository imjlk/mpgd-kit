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
  /**
   * The installation's shell renders advertising pushes itself, with the
   * opt-out action (an Android shell with the kit's renderer). The backend
   * keeps it only for a target whose pushes need it, and the FCM provider
   * then sends advertising as a data message the shell renders.
   */
  readonly rendersAdvertising?: boolean;
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
  | {
      readonly status: 'ambiguous';
      readonly providerCode?: string;
      /**
       * A bulk call that reached some of its recipients and did not say which
       * (BK1). A replay would reach those recipients again, so the delivery is
       * not replayed: it stays in flight until its key's retention ends, and
       * the backend reports it. Only a batch answer sets it.
       */
      readonly unattributed?: true;
    };

/**
 * A provider's bulk path (RFC open question 5, BK1): one provider call for
 * several recipients of one topic, each with its own ledger key and answer.
 * A provider without it sends one recipient per call.
 */
export interface NotificationRemoteBulkCapability {
  /** The most recipients one `sendBatch` call takes. */
  readonly maxRecipients: number;
  /**
   * The fewest recipients the bulk API is meant for; a smaller batch goes
   * one recipient per `send` call. 2 by default.
   */
  readonly minRecipients?: number;
  /**
   * Whether the provider's answer names each recipient. `false` means it
   * answers the batch as a whole (counts only): the provider then gives
   * every recipient the same answer, `accepted` only when the counts prove
   * each one, and `ambiguous` with `unattributed` when they prove only that
   * some were reached.
   */
  readonly perRecipientOutcomes: boolean;
  /**
   * A daily window, in a time zone, in which the host holds bulk messages
   * until it ends (Apps in Toss holds `send-bulk-message` from 21:00 to
   * 08:00). The service sends one recipient per call inside it, so the
   * gate's timing stands.
   */
  readonly holdWindow?: {
    /** `HH:MM`, inclusive. */
    readonly start: string;
    /** `HH:MM`, exclusive; earlier than `start` when the window spans midnight. */
    readonly end: string;
    /** An IANA time zone. */
    readonly timeZone: string;
  };
}

/** How long a provider may keep starting calls for one `sendBatch`. */
export interface NotificationRemoteBatchOptions {
  /**
   * Milliseconds from the start of `sendBatch` after which the provider
   * starts no further call (one batch may take several, such as one per
   * text): the requests' claims must outlive the calls. A request it did not
   * start answers `rate-limited`, which proves nothing was sent.
   */
  readonly startWithinMs?: number;
}

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
  /** The bulk path, declared with `sendBatch`; without it every recipient is one `send`. */
  readonly bulk?: NotificationRemoteBulkCapability;
  /**
   * One provider call for `requests` (at most `bulk.maxRecipients`, each a
   * different recipient of the same send kind): the answers in the order of
   * the requests, one per request. The service runs the gate for each
   * request before the call and settles each answer on that request's own
   * ledger key; an answer that is missing or not one of the five kinds is
   * `ambiguous`, as a throw is for every request.
   */
  sendBatch?(
    requests: readonly NotificationRemoteDeliveryRequest[],
    options?: NotificationRemoteBatchOptions,
  ): Promise<readonly NotificationRemoteDeliveryAnswer[]>;
  /**
   * The host's permission at send time, for a provider whose registry entry
   * is `serverReadable` (Devvit `isOptedIn`). The gate requires it there.
   */
  readPermission?(input: {
    readonly player: string;
    readonly topic: string;
  }): Promise<NotificationPermissionState>;
}
