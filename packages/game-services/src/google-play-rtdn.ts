import { decodeBase64, decodeBase64Url } from './base64.js';
import {
  googlePlayVoidedPurchasesWindowMs,
  googlePlayVoidedPurchasesWindowSlackMs,
  revokeGooglePlayVoidedPurchase,
  type GooglePlayVoidedPurchase,
  type GooglePlayVoidedPurchasesClient,
} from './google-play-store-server.js';
import type { GameServicesStore } from './server.js';

/**
 * Google Play Real-time developer notifications (RTDN) delivered by a Cloud
 * Pub/Sub push subscription: the fast path for revoking a refunded or voided
 * one-time purchase. The Voided Purchases API sweep
 * (`sweepGooglePlayVoidedPurchases`) stays required next to it, because a
 * push can be lost (a misconfigured subscription, a message that outlives
 * its retention); both revoke through `revokeGooglePlayVoidedPurchase`, keyed
 * by the purchase token, so whichever comes second is a no-op.
 *
 * - RTDN reference: https://developer.android.com/google/play/billing/rtdn-reference
 * - Push authentication: https://cloud.google.com/pubsub/docs/authenticate-push-subscriptions
 * - Push acknowledgement (102, 200, 201, 202, 204 ack; anything else is
 *   redelivered): https://cloud.google.com/pubsub/docs/push
 * - Payload unwrapping: https://cloud.google.com/pubsub/docs/payload-unwrapping
 * - Voided Purchases API (6,000 queries a day, 30 in any 30 seconds):
 *   https://developers.google.com/android-publisher/voided-purchases
 */

/** Issuers of Google-signed ID tokens (Google's OpenID Connect guide). */
export const googleIdTokenIssuers: readonly string[] = Object.freeze([
  'https://accounts.google.com',
  'accounts.google.com',
]);

/**
 * Google's published ID token signing keys (the `jwks_uri` of
 * https://accounts.google.com/.well-known/openid-configuration).
 */
export const googleIdTokenJwksUrl = 'https://www.googleapis.com/oauth2/v3/certs';

/** Google's keys could not be read: answer non-2xx so Pub/Sub redelivers. */
export class GoogleIdTokenKeysUnavailableError extends Error {
  override readonly name = 'GoogleIdTokenKeysUnavailableError';
}

/** The source of Google's RS256 ID token signing keys; inject a fake in tests. */
export interface GoogleIdTokenSigningKeys {
  /**
   * The published public key with this key id, or undefined when Google does
   * not publish one. Throws `GoogleIdTokenKeysUnavailableError` when the keys
   * cannot be read.
   */
  getSigningKey(input: {
    readonly kid: string;
    readonly signal: AbortSignal;
  }): Promise<JsonWebKey | undefined>;
}

export interface GoogleIdTokenSigningKeysOptions {
  readonly fetch?: typeof fetch;
  readonly jwksUrl?: string;
  /** Milliseconds since the epoch; for the cache. */
  readonly now?: () => number;
}

const jwksMaxBytes = 64 * 1024;
const jwksTimeoutMs = 5_000;
const jwksDefaultCacheMs = 60 * 60 * 1000;
const jwksMinCacheMs = 60 * 1000;
const jwksMaxCacheMs = 24 * 60 * 60 * 1000;
/**
 * The keys are fetched at most this often, whatever the outcome: a forged
 * `kid` or an endpoint outage cannot drive one fetch per request.
 */
const jwksMinRefreshMs = 60 * 1000;

/**
 * Reads Google's ID token keys from `googleIdTokenJwksUrl`, cached for the
 * response's `Cache-Control: max-age` (one minute to a day; an hour without
 * one) and refreshed early for a key id it does not hold: Google rotates its
 * keys. Fetches, failed ones included, are at least a minute apart; in
 * between, an expired cache still answers and an outage is
 * `GoogleIdTokenKeysUnavailableError`. One instance per isolate shares the
 * cache.
 */
export function createGoogleIdTokenSigningKeys(
  options: GoogleIdTokenSigningKeysOptions = {},
): GoogleIdTokenSigningKeys {
  const requestFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const jwksUrl = options.jwksUrl ?? googleIdTokenJwksUrl;
  const now = options.now ?? Date.now;
  let cached: { readonly keys: ReadonlyMap<string, JsonWebKey>; readonly expiresAt: number } | undefined;
  let fetchedAt = Number.NEGATIVE_INFINITY;
  let lastFetchFailed = false;
  let pending: Promise<ReadonlyMap<string, JsonWebKey>> | undefined;

  const startFetch = (signal: AbortSignal): Promise<ReadonlyMap<string, JsonWebKey>> => {
    fetchedAt = now();
    const load = loadGoogleIdTokenKeys(requestFetch, jwksUrl, signal).then(
      ({ keys, maxAgeMs }) => {
        cached = { keys, expiresAt: now() + maxAgeMs };
        lastFetchFailed = false;
        return keys;
      },
      (error: unknown) => {
        lastFetchFailed = true;
        throw error;
      },
    );
    pending = load;
    const clear = () => {
      if (pending === load) {
        pending = undefined;
      }
    };
    void load.then(clear, clear);
    return load;
  };

  return {
    async getSigningKey({ kid, signal }) {
      const known = cached?.keys.get(kid);
      if (known !== undefined && cached !== undefined && cached.expiresAt > now()) {
        return known;
      }
      let load = pending;
      if (load === undefined) {
        if (now() - fetchedAt < jwksMinRefreshMs) {
          // Throttled: answer from what is held. A key Google published
          // before still verifies (it rotates rarely); otherwise the last
          // fetch either lacked the key or failed.
          if (known !== undefined) {
            return known;
          }
          if (lastFetchFailed) {
            throw new GoogleIdTokenKeysUnavailableError(
              'Google ID token keys are unavailable; the next fetch waits a minute.',
            );
          }
          return undefined;
        }
        load = startFetch(signal);
      }
      try {
        return (await load).get(kid);
      } catch (error) {
        const stale = cached?.keys.get(kid);
        if (stale !== undefined) {
          return stale;
        }
        throw error;
      }
    },
  };
}

async function loadGoogleIdTokenKeys(
  requestFetch: typeof fetch,
  jwksUrl: string,
  signal: AbortSignal,
): Promise<{ readonly keys: ReadonlyMap<string, JsonWebKey>; readonly maxAgeMs: number }> {
  let response: Response;
  try {
    response = await requestFetch(jwksUrl, {
      method: 'GET',
      // Workers reject redirect: 'error'; a manual 3xx/opaque redirect is never ok and fails below.
      redirect: 'manual',
      signal: AbortSignal.any([signal, AbortSignal.timeout(jwksTimeoutMs)]),
    });
  } catch {
    throw new GoogleIdTokenKeysUnavailableError('Google ID token keys could not be fetched.');
  }
  if (!response.ok || response.redirected) {
    await response.body?.cancel().catch(() => undefined);
    throw new GoogleIdTokenKeysUnavailableError(
      `Google ID token keys returned HTTP ${response.status}.`,
    );
  }
  let body: unknown;
  try {
    body = JSON.parse(await readBoundedText(response, jwksMaxBytes));
  } catch {
    throw new GoogleIdTokenKeysUnavailableError('Google ID token keys are not readable JSON.');
  }
  const entries = isRecord(body) && Array.isArray(body.keys) ? body.keys as unknown[] : undefined;
  if (entries === undefined) {
    throw new GoogleIdTokenKeysUnavailableError('Google ID token keys have an invalid shape.');
  }
  const keys = new Map<string, JsonWebKey>();
  for (const entry of entries) {
    // Only RSA signing keys for RS256; anything else is skipped, never trusted.
    if (
      isRecord(entry)
      && entry.kty === 'RSA'
      && typeof entry.kid === 'string'
      && typeof entry.n === 'string'
      && typeof entry.e === 'string'
      && (entry.use === undefined || entry.use === 'sig')
      && (entry.alg === undefined || entry.alg === 'RS256')
    ) {
      keys.set(entry.kid, { kty: 'RSA', n: entry.n, e: entry.e, alg: 'RS256', ext: true });
    }
  }
  if (keys.size === 0) {
    throw new GoogleIdTokenKeysUnavailableError('Google ID token keys hold no RS256 key.');
  }
  return { keys, maxAgeMs: readMaxAgeMs(response.headers.get('cache-control')) };
}

function readMaxAgeMs(cacheControl: string | null): number {
  const match = cacheControl === null
    ? null
    : /(?:^|[,\s])max-age=(\d{1,9})(?:$|[,\s])/iu.exec(cacheControl);
  const seconds = match?.[1] === undefined ? undefined : Number(match[1]);
  return seconds === undefined
    ? jwksDefaultCacheMs
    : Math.min(Math.max(seconds * 1000, jwksMinCacheMs), jwksMaxCacheMs);
}

export interface GooglePubSubPushAuthentication {
  /** The audience set on the push subscription (`--push-auth-token-audience`). */
  readonly audience: string;
  /** The service account the push subscription signs as (`--push-auth-service-account`). */
  readonly serviceAccountEmail: string;
  readonly keys: GoogleIdTokenSigningKeys;
  /** Clock skew allowed on `exp` and `iat`, in seconds; 60 by default. */
  readonly clockSkewSeconds?: number;
}

export type GooglePubSubPushTokenVerification =
  | { readonly status: 'verified' }
  | { readonly status: 'rejected'; readonly reason: string };

const maxTokenLength = 8 * 1024;

/**
 * Verifies the OIDC token a Pub/Sub push subscription with authentication
 * sends as `Authorization: Bearer <JWT>`: an RS256 signature by one of
 * Google's published keys, a Google issuer, the subscription's audience, its
 * service account (`email`, `email_verified`), and `exp`/`iat`. Throws
 * `GoogleIdTokenKeysUnavailableError` when Google's keys cannot be read.
 */
export async function verifyGooglePubSubPushToken(
  input: GooglePubSubPushAuthentication & {
    readonly authorization: string | null | undefined;
    readonly signal: AbortSignal;
    /** Milliseconds since the epoch. */
    readonly now?: () => number;
  },
): Promise<GooglePubSubPushTokenVerification> {
  const audience = input.audience.trim();
  const serviceAccountEmail = input.serviceAccountEmail.trim().toLowerCase();
  if (audience.length === 0 || serviceAccountEmail.length === 0) {
    throw new TypeError('The push audience and service account email are required.');
  }
  const skewMs = (input.clockSkewSeconds ?? 60) * 1000;
  if (!Number.isFinite(skewMs) || skewMs < 0 || skewMs > 300_000) {
    throw new RangeError('clockSkewSeconds must be from 0 to 300.');
  }
  if (input.authorization === null || input.authorization === undefined) {
    return rejectedToken('GOOGLE_PUBSUB_PUSH_TOKEN_MISSING');
  }
  const match = input.authorization.length > maxTokenLength
    ? null
    : /^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/u.exec(
        input.authorization.trim(),
      );
  if (match === null) {
    return rejectedToken('GOOGLE_PUBSUB_PUSH_TOKEN_MALFORMED');
  }
  const [, encodedHeader = '', encodedClaims = '', encodedSignature = ''] = match;
  const header = readJsonSegment(encodedHeader);
  const claims = readJsonSegment(encodedClaims);
  const signature = decodeBase64Url(encodedSignature);
  if (header === undefined || claims === undefined || signature === undefined) {
    return rejectedToken('GOOGLE_PUBSUB_PUSH_TOKEN_MALFORMED');
  }
  if (header.alg !== 'RS256' || typeof header.kid !== 'string' || header.kid.length === 0) {
    return rejectedToken('GOOGLE_PUBSUB_PUSH_TOKEN_ALGORITHM');
  }
  const jwk = await input.keys.getSigningKey({ kid: header.kid, signal: input.signal });
  if (jwk === undefined) {
    return rejectedToken('GOOGLE_PUBSUB_PUSH_TOKEN_KEY_UNKNOWN');
  }
  let valid: boolean;
  try {
    const key = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    valid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      signature,
      new TextEncoder().encode(`${encodedHeader}.${encodedClaims}`),
    );
  } catch {
    valid = false;
  }
  if (!valid) {
    return rejectedToken('GOOGLE_PUBSUB_PUSH_TOKEN_SIGNATURE_INVALID');
  }
  // Signed by Google: the claims can be trusted from here on.
  if (typeof claims.iss !== 'string' || !googleIdTokenIssuers.includes(claims.iss)) {
    return rejectedToken('GOOGLE_PUBSUB_PUSH_TOKEN_ISSUER');
  }
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(audience)) {
    return rejectedToken('GOOGLE_PUBSUB_PUSH_TOKEN_AUDIENCE');
  }
  // Signature and audience do not pin the sender: any Google service account
  // can mint a token for any audience. The email does.
  if (typeof claims.email !== 'string' || claims.email.toLowerCase() !== serviceAccountEmail) {
    return rejectedToken('GOOGLE_PUBSUB_PUSH_TOKEN_EMAIL');
  }
  if (claims.email_verified !== true && claims.email_verified !== 'true') {
    return rejectedToken('GOOGLE_PUBSUB_PUSH_TOKEN_EMAIL_UNVERIFIED');
  }
  const nowMs = (input.now ?? Date.now)();
  if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp) || claims.exp * 1000 + skewMs <= nowMs) {
    return rejectedToken('GOOGLE_PUBSUB_PUSH_TOKEN_EXPIRED');
  }
  if (typeof claims.iat !== 'number' || !Number.isFinite(claims.iat) || claims.iat * 1000 - skewMs > nowMs) {
    return rejectedToken('GOOGLE_PUBSUB_PUSH_TOKEN_NOT_YET_VALID');
  }
  return { status: 'verified' };
}

function rejectedToken(reason: string): GooglePubSubPushTokenVerification {
  return { status: 'rejected', reason };
}

/** `voidedPurchaseNotification.productType` (RTDN reference). */
export const googlePlayRtdnProductType = Object.freeze({
  subscription: 1,
  oneTime: 2,
} as const);

/** `voidedPurchaseNotification.refundType` (RTDN reference). */
export const googlePlayRtdnRefundType = Object.freeze({
  fullRefund: 1,
  quantityBasedPartialRefund: 2,
} as const);

/** The decoded `message.data`: one notification kind besides `version`, `packageName`, `eventTimeMillis`. */
export interface GooglePlayDeveloperNotification {
  readonly version?: string;
  readonly packageName: string;
  /** Milliseconds since the epoch (an int64 string or a number in the JSON). */
  readonly eventTimeMillis?: number;
  readonly voidedPurchaseNotification?: {
    readonly purchaseToken?: unknown;
    readonly orderId?: unknown;
    readonly productType?: unknown;
    readonly refundType?: unknown;
  };
  readonly oneTimeProductNotification?: Readonly<Record<string, unknown>>;
  readonly subscriptionNotification?: Readonly<Record<string, unknown>>;
  readonly testNotification?: Readonly<Record<string, unknown>>;
  readonly [kind: string]: unknown;
}

export type GooglePlayDeveloperNotificationPush =
  | {
      readonly status: 'decoded';
      readonly messageId?: string;
      readonly notification: GooglePlayDeveloperNotification;
    }
  | { readonly status: 'rejected'; readonly reason: string; readonly messageId?: string };

/**
 * Decodes a Pub/Sub push body into the `DeveloperNotification` it carries.
 * Both push formats are accepted: the default wrapped body (`{ message:
 * { data, messageId }, subscription }`, the notification base64 in `data`)
 * and an unwrapped one (payload unwrapping on: the body is the notification
 * JSON itself, with a top-level `packageName` and no `message`). An
 * unwrapped push carries its message id only in the
 * `x-goog-pubsub-message-id` header when "write metadata" is on; pass it as
 * `messageId`.
 */
export function decodeGooglePlayDeveloperNotificationPush(
  body: unknown,
  options: { readonly messageId?: string | null } = {},
): GooglePlayDeveloperNotificationPush {
  let notification: unknown;
  let messageId: string | undefined;
  if (isRecord(body) && isRecord(body.message)) {
    const message = body.message;
    messageId = readMessageId(message.messageId) ?? readMessageId(message.message_id);
    const data = typeof message.data === 'string' ? decodeBase64(message.data) : undefined;
    try {
      notification = data === undefined
        ? undefined
        : JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
    } catch {
      notification = undefined;
    }
  } else if (isRecord(body) && body.message === undefined && typeof body.packageName === 'string') {
    notification = body;
    messageId = readMessageId(options.messageId);
  } else {
    const headerId = readMessageId(options.messageId);
    return {
      status: 'rejected',
      reason: 'GOOGLE_PLAY_RTDN_ENVELOPE_INVALID',
      ...(headerId === undefined ? {} : { messageId: headerId }),
    };
  }
  const withId = messageId === undefined ? {} : { messageId };
  if (!isRecord(notification) || typeof notification.packageName !== 'string') {
    return { status: 'rejected', reason: 'GOOGLE_PLAY_RTDN_NOTIFICATION_INVALID', ...withId };
  }
  const eventMillis = readInteger(notification.eventTimeMillis, 16);
  // A time Date can represent, after the epoch; anything else is dropped.
  const eventTimeMillis = eventMillis !== undefined && eventMillis > 0
      && eventMillis <= 8_640_000_000_000_000
    ? eventMillis
    : undefined;
  return {
    status: 'decoded',
    ...withId,
    notification: {
      ...withoutEventTime(notification),
      packageName: notification.packageName,
      ...(eventTimeMillis === undefined ? {} : { eventTimeMillis }),
    } as GooglePlayDeveloperNotification,
  };
}

export interface HandleGooglePlayDeveloperNotificationInput {
  readonly store: GameServicesStore;
  /** The app's package; a notification for another package is acknowledged and ignored. */
  readonly packageName: string;
  /**
   * The Voided Purchases API (the sweep's client). A voided notification is
   * only a trigger: the void is revoked once this lists it, with the listed
   * entry, so the ledger records what the sweep would.
   */
  readonly voidedPurchases: GooglePlayVoidedPurchasesClient;
  /** The push request body parsed from JSON. Authenticate the push before calling this. */
  readonly body: unknown;
  /** An unwrapped push's `x-goog-pubsub-message-id` header, for logs. */
  readonly messageId?: string | null;
  /** Bounds the Voided Purchases API lookup. */
  readonly signal: AbortSignal;
  readonly now?: () => string;
  /**
   * How long after the notification's `eventTimeMillis` a void that the
   * Voided Purchases API does not list yet, or whose grant this ledger does
   * not hold, is answered `retry` instead of `ignored`; 1 hour by default, at
   * most `maxUnmatchedVoidRetryMs` (6 hours), `0` acknowledges at once. It
   * covers Google's lag in listing the void and a purchase whose grant is
   * still being written; past it the message is acknowledged and the sweep
   * reads the void again.
   */
  readonly unmatchedVoidRetryMs?: number;
}

/** Default of `unmatchedVoidRetryMs`. */
export const defaultUnmatchedVoidRetryMs = 60 * 60 * 1000;
/** Upper bound of `unmatchedVoidRetryMs`. */
export const maxUnmatchedVoidRetryMs = 6 * 60 * 60 * 1000;
/**
 * The lookup window around the notification's event time: this much before
 * it (Google's own clocks), and up to `maxUnmatchedVoidRetryMs` after it
 * (Google lists a void a little after it records it), never past now.
 */
export const googlePlayRtdnLookupLeadMs = 15 * 60 * 1000;
/** Voided Purchases API pages one notification reads at most (a page holds up to 1,000 voids). */
export const googlePlayRtdnLookupMaxPages = 2;

export type GooglePlayDeveloperNotificationOutcome =
  /** The grant was reversed (or already had been: a redelivery, or the sweep came first). */
  | {
      readonly status: 'revoked';
      readonly messageId?: string;
      readonly ledgerEntryId: string;
      readonly alreadyProcessed: boolean;
      readonly orderId?: string;
    }
  /** Nothing to do (a test, a subscription, a partial refund, another package): acknowledge. */
  | {
      readonly status: 'ignored';
      readonly reason: string;
      readonly messageId?: string;
      readonly orderId?: string;
    }
  /** The ledger refused the revocation; a redelivery cannot fix it, so acknowledge and alert. */
  | {
      readonly status: 'conflict';
      readonly reason: string;
      readonly messageId?: string;
      readonly orderId?: string;
    }
  /** Malformed: acknowledged so Pub/Sub does not redeliver it until retention runs out. */
  | { readonly status: 'rejected'; readonly reason: string; readonly messageId?: string }
  /**
   * Answer non-2xx so Pub/Sub redelivers: the Voided Purchases API failed or
   * does not list the void yet, or this ledger may still be writing its grant.
   */
  | {
      readonly status: 'retry';
      readonly reason: string;
      readonly messageId?: string;
      readonly orderId?: string;
    };

/**
 * Applies one RTDN push to the ledger. A `voidedPurchaseNotification` of a
 * one-time product with a full refund is confirmed with the Voided Purchases
 * API (one window around the event time, matched on the purchase token) and
 * the listed entry is revoked through `revokeGooglePlayVoidedPurchase`: the
 * sweep's path, idempotency key, reason, source, and void time. A push alone
 * never revokes, so a message published to the topic by anyone but Google
 * cannot reverse a grant Google did not void. A void not listed yet, or
 * whose grant this ledger does not hold, is `retry` while recent
 * (`unmatchedVoidRetryMs`), `ignored` after; a lookup failure is `retry`. A
 * quantity-based partial refund is ignored without a lookup, as the sweep
 * (which lists full refunds only) ignores it. Test, subscription, one-time
 * product purchase, and every other kind are `ignored`: the kit sells no
 * Play subscriptions, and a purchase is granted only when the game verifies
 * it. A thrown error (a store outage) is not an outcome: answer 5xx so
 * Pub/Sub redelivers.
 */
export async function handleGooglePlayDeveloperNotification(
  input: HandleGooglePlayDeveloperNotificationInput,
): Promise<GooglePlayDeveloperNotificationOutcome> {
  const unmatchedVoidRetryMs = input.unmatchedVoidRetryMs ?? defaultUnmatchedVoidRetryMs;
  if (
    !Number.isSafeInteger(unmatchedVoidRetryMs)
    || unmatchedVoidRetryMs < 0
    || unmatchedVoidRetryMs > maxUnmatchedVoidRetryMs
  ) {
    throw new RangeError(
      `unmatchedVoidRetryMs must be an integer from 0 to ${maxUnmatchedVoidRetryMs} ms.`,
    );
  }
  const packageName = input.packageName.trim();
  if (packageName.length === 0) {
    throw new TypeError('packageName is required.');
  }
  const decoded = decodeGooglePlayDeveloperNotificationPush(
    input.body,
    input.messageId === undefined ? {} : { messageId: input.messageId },
  );
  if (decoded.status === 'rejected') {
    return decoded;
  }
  const { notification } = decoded;
  const withId = decoded.messageId === undefined ? {} : { messageId: decoded.messageId };
  if (notification.packageName !== packageName) {
    return { status: 'ignored', reason: 'GOOGLE_PLAY_RTDN_PACKAGE_MISMATCH', ...withId };
  }
  const voided = notification.voidedPurchaseNotification;
  if (!isRecord(voided)) {
    return { status: 'ignored', reason: ignoredKindReason(notification), ...withId };
  }
  const orderId = typeof voided.orderId === 'string' && voided.orderId.length > 0
    ? voided.orderId
    : undefined;
  const withOrder = { ...withId, ...(orderId === undefined ? {} : { orderId }) };
  const purchaseToken = typeof voided.purchaseToken === 'string' ? voided.purchaseToken : '';
  if (purchaseToken.length === 0) {
    return { status: 'rejected', reason: 'GOOGLE_PLAY_RTDN_PURCHASE_TOKEN_MISSING', ...withId };
  }
  const productType = readInteger(voided.productType, 3);
  if (productType === googlePlayRtdnProductType.subscription) {
    return { status: 'ignored', reason: 'GOOGLE_PLAY_RTDN_SUBSCRIPTION_VOIDED', ...withOrder };
  }
  if (productType !== undefined && productType !== googlePlayRtdnProductType.oneTime) {
    return { status: 'ignored', reason: 'GOOGLE_PLAY_RTDN_PRODUCT_TYPE_UNKNOWN', ...withOrder };
  }
  // Absent: a notification from before partial refunds, which voided the whole purchase.
  const refundType = readInteger(voided.refundType, 3) ?? googlePlayRtdnRefundType.fullRefund;
  if (refundType !== googlePlayRtdnRefundType.fullRefund) {
    return {
      status: 'ignored',
      reason: refundType === googlePlayRtdnRefundType.quantityBasedPartialRefund
        ? 'GOOGLE_PLAY_RTDN_PARTIAL_REFUND'
        : 'GOOGLE_PLAY_RTDN_REFUND_TYPE_UNKNOWN',
      ...withOrder,
    };
  }
  const now = input.now ?? (() => new Date().toISOString());
  const nowMillis = Date.parse(now());
  if (!Number.isFinite(nowMillis)) {
    throw new RangeError('now() must return an ISO timestamp.');
  }
  const eventTimeMillis = notification.eventTimeMillis;
  // Both ways, so a little clock skew still retries and a far-future time
  // cannot keep the message unacknowledged. Without an event time there is
  // no bound: acknowledge, the sweep reads the void.
  const recent = eventTimeMillis !== undefined
    && Math.abs(nowMillis - eventTimeMillis) < unmatchedVoidRetryMs;
  const unmatched = (reason: string): GooglePlayDeveloperNotificationOutcome =>
    recent
      ? { status: 'retry', reason, ...withOrder }
      : { status: 'ignored', reason, ...withOrder };

  let listed: GooglePlayVoidedPurchase | undefined;
  try {
    listed = await findVoidedPurchase({
      client: input.voidedPurchases,
      packageName,
      purchaseToken,
      anchorMillis: eventTimeMillis ?? nowMillis,
      nowMillis,
      signal: input.signal,
    });
  } catch {
    // The client's errors carry no token or URL; the host logs the outcome.
    return { status: 'retry', reason: 'GOOGLE_PLAY_RTDN_VOIDED_LOOKUP_FAILED', ...withOrder };
  }
  if (listed === undefined) {
    return unmatched('GOOGLE_PLAY_RTDN_VOID_NOT_LISTED');
  }
  const outcome = await revokeGooglePlayVoidedPurchase({
    store: input.store,
    packageName,
    voided: listed,
    now: () => new Date(nowMillis).toISOString(),
  });
  if (outcome.status === 'revoked') {
    return {
      status: 'revoked',
      ...withOrder,
      ledgerEntryId: outcome.ledgerEntryId,
      alreadyProcessed: outcome.alreadyProcessed,
    };
  }
  if (outcome.status === 'grant_not_found') {
    return unmatched('GOOGLE_PLAY_RTDN_GRANT_NOT_FOUND');
  }
  if (outcome.status === 'invalid') {
    return { status: 'rejected', reason: outcome.reason, ...withId };
  }
  return { status: 'conflict', reason: outcome.reason, ...withOrder };
}

/**
 * The listed void of this token in a window around the notification, or
 * undefined when Google does not list it (yet). One query per page, at most
 * `googlePlayRtdnLookupMaxPages`; Google allows 6,000 a day and 30 in any 30
 * seconds per package, shared with the sweep.
 */
async function findVoidedPurchase(input: {
  readonly client: GooglePlayVoidedPurchasesClient;
  readonly packageName: string;
  readonly purchaseToken: string;
  readonly anchorMillis: number;
  readonly nowMillis: number;
  readonly signal: AbortSignal;
}): Promise<GooglePlayVoidedPurchase | undefined> {
  const oldest = input.nowMillis - googlePlayVoidedPurchasesWindowMs
    + googlePlayVoidedPurchasesWindowSlackMs;
  const anchor = Math.min(Math.max(input.anchorMillis, oldest), input.nowMillis);
  const startTimeMillis = Math.max(anchor - googlePlayRtdnLookupLeadMs, oldest);
  const endTimeMillis = Math.max(
    Math.min(anchor + maxUnmatchedVoidRetryMs, input.nowMillis),
    startTimeMillis + 1,
  );
  let pageToken: string | undefined;
  for (let page = 0; page < googlePlayRtdnLookupMaxPages; page += 1) {
    const result = await input.client.listVoidedPurchases({
      packageName: input.packageName,
      startTimeMillis,
      endTimeMillis,
      ...(pageToken === undefined ? {} : { pageToken }),
      signal: input.signal,
    });
    const match = result.voidedPurchases.find(
      (entry) => entry.purchaseToken === input.purchaseToken,
    );
    if (match !== undefined) {
      return match;
    }
    pageToken = result.nextPageToken === undefined || result.nextPageToken.length === 0
      ? undefined
      : result.nextPageToken;
    if (pageToken === undefined) {
      return undefined;
    }
  }
  // More voids in the window than the pages read: not found here; the
  // retry or the sweep reads it.
  return undefined;
}

/** The HTTP status to answer Pub/Sub with: 200 acknowledges, 503 asks for a redelivery. */
export function googlePlayDeveloperNotificationHttpStatus(
  outcome: GooglePlayDeveloperNotificationOutcome,
): 200 | 503 {
  return outcome.status === 'retry' ? 503 : 200;
}

function ignoredKindReason(notification: GooglePlayDeveloperNotification): string {
  if (isRecord(notification.testNotification)) {
    return 'GOOGLE_PLAY_RTDN_TEST';
  }
  if (isRecord(notification.subscriptionNotification)) {
    return 'GOOGLE_PLAY_RTDN_SUBSCRIPTION';
  }
  if (isRecord(notification.oneTimeProductNotification)) {
    return 'GOOGLE_PLAY_RTDN_ONE_TIME_PRODUCT';
  }
  return 'GOOGLE_PLAY_RTDN_KIND_UNHANDLED';
}

function readMessageId(input: unknown): string | undefined {
  return typeof input === 'string' && input.length > 0 && input.length <= 128
      && /^[\x21-\x7e]+$/u.test(input)
    ? input
    : undefined;
}

function withoutEventTime(notification: Record<string, unknown>): Record<string, unknown> {
  const { eventTimeMillis: _eventTimeMillis, ...rest } = notification;
  return rest;
}

function readInteger(input: unknown, maxDigits: number): number | undefined {
  const value = typeof input === 'string' && new RegExp(`^[0-9]{1,${maxDigits}}$`, 'u').test(input)
    ? Number(input)
    : input;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function readJsonSegment(segment: string): Record<string, unknown> | undefined {
  const bytes = decodeBase64Url(segment);
  if (bytes === undefined) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

async function readBoundedText(response: Response, limit: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('Response exceeds the size limit.');
  }
  if (response.body === null) {
    return '';
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) {
      break;
    }
    size += next.value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      throw new Error('Response exceeds the size limit.');
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
