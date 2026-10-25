import {
  notificationAdvertisingOptOutActionId,
  referenceNotificationProviders,
} from '@mpgd/platform/notifications';

import {
  fcmInstallationIdRefusal,
  notificationExpiredProviderCode,
  type NotificationRemoteDeliveryAnswer,
  type NotificationRemoteDeliveryProvider,
  type NotificationRemoteDeliveryRequest,
} from './delivery-provider.js';
import type { NotificationProviderRegistration } from './registry.js';

/**
 * The FCM remote delivery provider (notifications v2 RFC, "Delivery
 * providers"): HTTP v1 `messages:send` with an OAuth access token minted from
 * a service-account JWT signed through WebCrypto. It needs only `fetch` and
 * `crypto.subtle`, so it runs on Cloudflare Workers (no HTTP/2, no Node
 * crypto). iOS devices register through Firebase Messaging, so FCM relays to
 * APNs.
 *
 * Payload, as the Capacitor provider reads it (RFC "Capacitor"): the gate's
 * title and body as the FCM `notification`; `data` carries the send's routing
 * data plus `topic` (the topic id) and `route` (its root-relative route).
 * Android posts to the mapping's `channelId`, else to `mpgd-service`,
 * `mpgd-requested`, or `mpgd-advertising` by purpose. An advertising send
 * names the iOS category `mpgd-advertising`, whose opt-out action the app
 * registers. An Android FCM notification message cannot carry actions, so an
 * advertising send to an endpoint whose registration says its shell renders
 * advertising (`rendersAdvertising`) is a data message the shell renders
 * with the action (`fcmShellRenderedDataKeys`). An expiry becomes
 * `android.ttl` and the `apns-expiration` header. A replay of the
 * same send key sets `android.collapse_key` and `apns-collapse-id` so a
 * crash after HTTP 200, before the ledger write, does not show a second
 * notification.
 */

export const fcmMessagingScope = 'https://www.googleapis.com/auth/firebase.messaging';
export const fcmTokenEndpoint = 'https://oauth2.googleapis.com/token';
/**
 * The FCM HTTP v1 API takes registration tokens. A Firebase installation id
 * (FID, the `fcm-installation` kind) is reserved: the kit types it because
 * FCM is moving to FIDs, but HTTP v1 has no FID send target, so this
 * provider refuses one at registration and at send until FCM supports it.
 */
export const fcmAddressKinds = Object.freeze(['fcm-token'] as const);
/** Data keys this provider writes; a send's routing data may not use them. */
export const fcmReservedDataKeys = Object.freeze(['topic', 'route'] as const);
/** The iOS notification category of advertising, which carries the opt-out action. */
export const fcmAdvertisingCategory = 'mpgd-advertising';
/**
 * The data keys of an advertising push the Android shell renders itself
 * (RFC "Delivery providers"). An Android FCM notification message cannot
 * carry actions, so such a push has no `notification` block: the app's
 * messaging service receives it in the background too and posts it with the
 * opt-out action. `render` is `fcmShellRenderedAdvertising`; `title` and
 * `body` are the gate's rendered text, `channel` the Android channel,
 * `actionTitle` the opt-out action's title when the content carries the
 * action, and `expiresAt` the expiry in epoch milliseconds, after which the
 * shell does not show it. The send's `topic` and `route` stay in their own
 * keys, as on every push. A send's routing data may not use the `mpgd.`
 * prefix.
 */
export const fcmShellRenderedDataKeys = Object.freeze({
  render: 'mpgd.render',
  title: 'mpgd.title',
  body: 'mpgd.body',
  channel: 'mpgd.channel',
  actionTitle: 'mpgd.actionTitle',
  expiresAt: 'mpgd.expiresAt',
} as const);
/** The `mpgd.render` value of an advertising push the shell renders. */
export const fcmShellRenderedAdvertising = 'advertising';
/**
 * FCM's 4,096-byte limit, less room for what FCM and APNs add on the way
 * (the `aps` wrapper and FCM's own keys), so a message this check passes is
 * not refused for its size.
 */
const maxPayloadBytes = 3840;
/**
 * `android.collapse_key` and `apns-collapse-id` are at most 64 bytes. The
 * id is the SHA-256 of the send key, which is 64 hex characters.
 */
export const fcmCollapseIdBytes = 64;
/** The longest `Retry-After` this provider passes on; the service gives up after a day anyway. */
const maxRetryAfterSeconds = 86_400;
/** How long a refused grant or an unusable key answers without asking Google again. */
const failedTokenCacheMs = 30_000;
/** How long a token endpoint that is down answers without asking again. */
const retryableTokenCacheMs = 5_000;
const tokenLifetimeSeconds = 3600;
/** A cached token is refreshed this long before it expires. */
const tokenRefreshMarginMs = 5 * 60 * 1000;
const defaultTimeoutMs = 10_000;
const defaultRetryAfterSeconds = 60;

/** The fields of a Google service-account key this provider reads. */
export interface FcmServiceAccount {
  readonly projectId: string;
  readonly clientEmail: string;
  /** A PKCS #8 PEM `PRIVATE KEY` block, as a service-account key file holds it. */
  readonly privateKey: string;
  readonly privateKeyId?: string;
}

/**
 * Reads a service-account key file (its JSON text or the parsed object).
 * Errors name the missing field and never include a value.
 */
export function parseFcmServiceAccount(input: unknown): FcmServiceAccount {
  let value: unknown = input;
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input);
    } catch {
      throw new TypeError('The FCM service account is not JSON.');
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('The FCM service account must be an object.');
  }
  const record = value as Readonly<Record<string, unknown>>;
  const field = (name: string): string => {
    const text = record[name];
    if (typeof text !== 'string' || text.trim() === '') {
      throw new TypeError(`The FCM service account has no ${name}.`);
    }
    return text;
  };
  if (record.type !== undefined && record.type !== 'service_account') {
    throw new TypeError('The FCM credential is not a service account key.');
  }
  const privateKeyId = record.private_key_id;
  return {
    projectId: field('project_id'),
    clientEmail: field('client_email'),
    privateKey: field('private_key'),
    ...(typeof privateKeyId === 'string' && privateKeyId !== '' ? { privateKeyId } : {}),
  };
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface FcmAccessTokenSource {
  /** A valid access token, minted or from the cache. */
  get(): Promise<string>;
  /** Drops `token` from the cache after FCM refused it. */
  invalidate(token: string): void;
}

/** Why no access token could be minted, and whether trying again later can help. */
export class FcmAccessTokenError extends Error {
  override readonly name = 'FcmAccessTokenError';
  readonly retryable: boolean;
  readonly code: string;
  readonly retryAfterSeconds: number | undefined;

  constructor(code: string, retryable: boolean, retryAfterSeconds?: number, options?: { readonly cause?: unknown }) {
    super(`FCM access token request failed: ${code}.`, options);
    this.code = code;
    this.retryable = retryable;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * Mints and caches OAuth access tokens for the FCM scope. The token lives
 * only in this object's memory: it is never logged, persisted, or put in an
 * error. Concurrent callers share one request, a failed request is not
 * cached, and a token is refreshed five minutes before it expires.
 */
export function createFcmAccessTokenSource(input: {
  readonly serviceAccount: FcmServiceAccount;
  readonly fetch?: FetchLike;
  readonly now?: () => number;
  readonly subtle?: SubtleCrypto;
  readonly timeoutMs?: number;
}): FcmAccessTokenSource {
  const { serviceAccount } = input;
  const fetcher: FetchLike = input.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const now = input.now ?? Date.now;
  const subtle = input.subtle ?? globalThis.crypto.subtle;
  const timeoutMs = input.timeoutMs ?? defaultTimeoutMs;
  let signingKey: Promise<CryptoKey> | undefined;
  let cached: { readonly token: string; readonly refreshAt: number; readonly expiresAt: number } | undefined;
  let failed: { readonly error: FcmAccessTokenError; readonly until: number } | undefined;
  let pending: Promise<string> | undefined;

  const key = (): Promise<CryptoKey> => {
    signingKey ??= importPrivateKey(subtle, serviceAccount.privateKey).catch((error: unknown) => {
      signingKey = undefined;
      throw error;
    });
    return signingKey;
  };
  /** The signed assertion; a key that cannot sign is a configuration error, never retried as a rate limit. */
  const signedAssertion = async (claims: object): Promise<string> => {
    try {
      return await signJwt(subtle, await key(), {
        header: {
          alg: 'RS256',
          typ: 'JWT',
          ...(serviceAccount.privateKeyId === undefined ? {} : { kid: serviceAccount.privateKeyId }),
        },
        claims,
      });
    } catch (error) {
      // The cause says which step failed (the PEM, the import, or signing); it never holds the key.
      throw new FcmAccessTokenError('TOKEN_KEY_UNUSABLE', false, undefined, { cause: error });
    }
  };
  const mint = async (): Promise<string> => {
    const issuedAt = Math.floor(now() / 1000);
    const assertion = await signedAssertion({
      iss: serviceAccount.clientEmail,
      scope: fcmMessagingScope,
      aud: fcmTokenEndpoint,
      iat: issuedAt,
      exp: issuedAt + tokenLifetimeSeconds,
    });
    let response: Response;
    try {
      response = await fetcher(fcmTokenEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion,
        }).toString(),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new FcmAccessTokenError('TOKEN_NETWORK_ERROR', true);
    }
    const body = await readJson(response);
    if (!response.ok) {
      const error = typeof body?.error === 'string' ? body.error : `HTTP_${response.status}`;
      const retryable = response.status === 429 || response.status >= 500;
      throw new FcmAccessTokenError(
        `TOKEN_${providerCodeOf(error)}`,
        retryable,
        retryable ? retryAfterOf(response, now()) : undefined,
      );
    }
    const token = body?.access_token;
    if (typeof token !== 'string' || token === '') {
      throw new FcmAccessTokenError('TOKEN_MALFORMED_RESPONSE', true);
    }
    const expiresIn = typeof body?.expires_in === 'number' && Number.isFinite(body.expires_in) && body.expires_in > 0
      ? Math.min(body.expires_in, tokenLifetimeSeconds)
      : tokenLifetimeSeconds;
    const expiresAt = issuedAt * 1000 + expiresIn * 1000;
    cached = { token, refreshAt: expiresAt - tokenRefreshMarginMs, expiresAt };
    return token;
  };

  return {
    async get() {
      if (cached !== undefined && now() < cached.refreshAt) {
        return cached.token;
      }
      // Inside the refresh margin a token that has not expired still sends
      // while a refresh fails.
      const usable = cached !== undefined && now() < cached.expiresAt ? cached.token : undefined;
      // A refresh already under way, or one that failed a moment ago, does not hold up a usable token.
      if (usable !== undefined && pending !== undefined) {
        return usable;
      }
      if (failed !== undefined && now() < failed.until) {
        if (usable !== undefined) {
          return usable;
        }
        // A refused grant fails the same way for a while: a fan-out does not ask Google per send.
        throw failed.error;
      }
      pending ??= mint()
        .then((token) => {
          failed = undefined;
          return token;
        })
        .catch((error: unknown) => {
          if (error instanceof FcmAccessTokenError) {
            // A refused grant waits 30 s; an outage waits a few seconds, or
            // as long as it asked, so a fan-out does not ask once per send.
            const wait = error.retryable
              ? Math.max(retryableTokenCacheMs, Math.min((error.retryAfterSeconds ?? 0) * 1000, 60_000))
              : failedTokenCacheMs;
            failed = { error, until: now() + wait };
          }
          throw error;
        })
        .finally(() => {
          pending = undefined;
        });
      if (usable === undefined) {
        return pending;
      }
      try {
        return await pending;
      } catch {
        return usable;
      }
    },
    invalidate(token) {
      if (cached?.token === token) {
        cached = undefined;
      }
    },
  };
}

export interface CreateFcmDeliveryProviderInput {
  readonly serviceAccount: FcmServiceAccount;
  /** Defaults to the service account's project. */
  readonly projectId?: string;
  /** The provider id; `fcm` by default. */
  readonly id?: string;
  readonly fetch?: FetchLike;
  readonly now?: () => number;
  readonly subtle?: SubtleCrypto;
  /** Per HTTP request; 10 seconds by default. */
  readonly timeoutMs?: number;
  /** A shared token source, for example one per isolate. */
  readonly tokens?: FcmAccessTokenSource;
}

/** The FCM HTTP v1 message this provider sends, or why it cannot send one. */
export type FcmMessageBuild =
  | { readonly status: 'ready'; readonly message: Readonly<Record<string, unknown>> }
  | {
      readonly status: 'invalid';
      readonly reason: string;
      /**
       * `MESSAGE_EXPIRED` (`notificationExpiredProviderCode`) for a message
       * that would arrive too late, `INSTALLATION_ID_RESERVED` for an FID
       * recipient, else `INVALID_MESSAGE`.
       */
      readonly code: 'INVALID_MESSAGE' | 'INSTALLATION_ID_RESERVED' | typeof notificationExpiredProviderCode;
    };

/**
 * Builds the HTTP v1 `message` for one delivery and checks it against FCM's
 * rules before anything is sent: a registration token address, a title and
 * a body, string routing data without FCM's or this provider's reserved
 * keys, an expiry at least a second away, and a payload within FCM's limit
 * with room for what APNs adds. A message that passes is "known valid", so an
 * `INVALID_ARGUMENT` answer that names the token means a dead token.
 */
export function buildFcmMessage(request: NotificationRemoteDeliveryRequest): FcmMessageBuild {
  const { recipient, content } = request;
  if (recipient.kind === 'device' && recipient.address.kind === 'fcm-installation') {
    return {
      status: 'invalid',
      reason: fcmInstallationIdRefusal,
      code: 'INSTALLATION_ID_RESERVED',
    };
  }
  if (recipient.kind !== 'device' || recipient.address.kind !== 'fcm-token') {
    return {
      status: 'invalid',
      reason: 'FCM sends to registration tokens only',
      code: 'INVALID_MESSAGE',
    };
  }
  if (content.title === undefined || content.body === undefined) {
    return {
      status: 'invalid',
      reason: 'FCM content needs a title and a body',
      code: 'INVALID_MESSAGE',
    };
  }
  // A null-prototype object keeps a `__proto__` key from vanishing silently.
  const data: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, value] of Object.entries(request.data ?? {})) {
    if (isReservedDataKey(key)) {
      return {
        status: 'invalid',
        reason: `the data key ${JSON.stringify(key)} is reserved`,
        code: 'INVALID_MESSAGE',
      };
    }
    if (typeof value !== 'string') {
      return {
        status: 'invalid',
        reason: `the data value of ${JSON.stringify(key)} is not a string`,
        code: 'INVALID_MESSAGE',
      };
    }
    data[key] = value;
  }
  data.topic = request.topic.id;
  data.route = content.route;
  const notification = { title: content.title, body: content.body };
  const mapped = request.topic.mapping?.['channelId'];
  const channelId = typeof mapped === 'string' && mapped !== ''
    ? mapped
    : `mpgd-${request.topic.purpose}`;
  const expiresAt = request.expiresAt === undefined ? undefined : Date.parse(request.expiresAt);
  const at = Date.parse(request.at);
  if (expiresAt !== undefined && (!Number.isFinite(expiresAt) || !Number.isFinite(at))) {
    return {
      status: 'invalid',
      reason: 'the expiry or the call time is not a timestamp',
      code: 'INVALID_MESSAGE',
    };
  }
  if (expiresAt !== undefined && expiresAt - at < 1000) {
    // A time to live of 0 means "now, if reachable" to FCM: an expired message is not sent at all.
    return {
      status: 'invalid',
      reason: 'the message expires before it could arrive',
      code: 'MESSAGE_EXPIRED',
    };
  }
  // Same id on both transports: a replay of this send replaces the first
  // instead of showing beside it. Collapse is per token, so two devices of
  // one send do not hide each other.
  const collapseId = fcmCollapseId(request.sendKey);
  const ttl = expiresAt === undefined ? {} : { ttl: `${Math.floor((expiresAt - at) / 1000)}s` };
  if (request.topic.purpose === 'advertising' && recipient.address.rendersAdvertising === true) {
    // A data message without a `notification` block reaches the shell's
    // messaging service in the background too, which renders it with the
    // opt-out action. Normal priority, FCM's default for data and
    // notification messages alike: FCM keeps high priority for urgent,
    // time-sensitive messages, and advertising is not one. The shell's
    // renderer checks the expiry again, since arrival decides.
    const actionTitle = content.actions
      ?.find((action) => action.id === notificationAdvertisingOptOutActionId)
      ?.title;
    const rendered: Record<string, string> = Object.create(null) as Record<string, string>;
    Object.assign(rendered, data, {
      [fcmShellRenderedDataKeys.render]: fcmShellRenderedAdvertising,
      [fcmShellRenderedDataKeys.title]: content.title,
      [fcmShellRenderedDataKeys.body]: content.body,
      [fcmShellRenderedDataKeys.channel]: channelId,
      ...(actionTitle === undefined ? {} : { [fcmShellRenderedDataKeys.actionTitle]: actionTitle }),
      ...(expiresAt === undefined ? {} : { [fcmShellRenderedDataKeys.expiresAt]: String(expiresAt) }),
    });
    return sizedMessage(recipient.address.value, {
      data: { ...rendered },
      android: { collapse_key: collapseId, ...ttl },
    });
  }
  const android: Record<string, unknown> = {
    collapse_key: collapseId,
    ...ttl,
    notification: { channel_id: channelId },
  };
  const category = request.topic.purpose === 'advertising' ? fcmAdvertisingCategory : undefined;
  const apns: Record<string, unknown> = {
    headers: {
      'apns-collapse-id': collapseId,
      ...(expiresAt === undefined ? {} : { 'apns-expiration': String(Math.floor(expiresAt / 1000)) }),
    },
    ...(category === undefined ? {} : { payload: { aps: { category } } }),
  };
  return sizedMessage(recipient.address.value, {
    notification,
    data: { ...data },
    android,
    apns,
  });
}

/** The message for `token`, unless its payload is over the size this provider sends. */
function sizedMessage(token: string, payload: Readonly<Record<string, unknown>>): FcmMessageBuild {
  // Everything but the token counts toward the size FCM and APNs carry.
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload)).length;
  if (payloadBytes > maxPayloadBytes) {
    return {
      status: 'invalid',
      reason: `the payload is ${payloadBytes} bytes; this provider sends at most ${maxPayloadBytes}`,
      code: 'INVALID_MESSAGE',
    };
  }
  return { status: 'ready', message: { token, ...payload } };
}

/**
 * Maps an FCM error answer to the provider answer kinds (RFC "Delivery
 * providers"): `UNREGISTERED` is `unregistered`, and so is
 * `INVALID_ARGUMENT` for a message `buildFcmMessage` passed when the answer
 * names the token and no other field; `QUOTA_EXCEEDED` is
 * `rate-limited`; `UNAVAILABLE` and `INTERNAL` are `ambiguous`;
 * `SENDER_ID_MISMATCH`, `THIRD_PARTY_AUTH_ERROR`, and every other refusal are
 * `rejected` with reason `configuration`. An answer without an FCM error code
 * falls back on its HTTP status: 5xx is `ambiguous`, 429 `rate-limited`.
 */
export function classifyFcmError(input: {
  readonly status: number;
  readonly body: unknown;
  readonly retryAfterSeconds?: number;
}): NotificationRemoteDeliveryAnswer {
  const error = isRecord(input.body) && isRecord(input.body.error) ? input.body.error : undefined;
  const details = errorDetailsOf(input.body);
  const raw = errorCodeOf(details) ?? (typeof error?.status === 'string' ? error.status : undefined);
  // FCM's own codes are short upper-case words; anything else is cut down before it reaches logs.
  const code = raw === undefined ? undefined : providerCodeOf(raw);
  const rateLimited = (): NotificationRemoteDeliveryAnswer => ({
    status: 'rate-limited',
    retryAfterSeconds: input.retryAfterSeconds ?? defaultRetryAfterSeconds,
  });
  switch (code) {
    case 'UNREGISTERED':
      return { status: 'unregistered' };
    case 'INVALID_ARGUMENT': {
      const fields = details
        .flatMap((detail) => (Array.isArray(detail.fieldViolations) ? detail.fieldViolations : []))
        .filter(isRecord)
        .map((violation) => violation.field);
      // Only an answer that names the token proves the address is dead; any
      // other refusal of a message that passed buildFcmMessage is the setup's.
      return fields.length > 0 && fields.every((field) => field === 'message.token')
        ? { status: 'unregistered' }
        : { status: 'rejected', reason: 'configuration', providerCode: code };
    }
    case 'QUOTA_EXCEEDED':
    case 'RESOURCE_EXHAUSTED':
      return rateLimited();
    case 'UNAVAILABLE':
    case 'INTERNAL':
      return { status: 'ambiguous', providerCode: code };
    case 'SENDER_ID_MISMATCH':
    case 'THIRD_PARTY_AUTH_ERROR':
      return { status: 'rejected', reason: 'configuration', providerCode: code };
    default:
      break;
  }
  if (input.status === 429) {
    return rateLimited();
  }
  if (input.status >= 500) {
    return { status: 'ambiguous', providerCode: code ?? `HTTP_${input.status}` };
  }
  return {
    status: 'rejected',
    reason: 'configuration',
    providerCode: code ?? `HTTP_${input.status}`,
  };
}

/** The FCM provider: `{ id, send }` over HTTP v1. */
export function createFcmDeliveryProvider(
  input: CreateFcmDeliveryProviderInput,
): NotificationRemoteDeliveryProvider {
  const projectId = input.projectId ?? input.serviceAccount.projectId;
  // Project ids, including legacy domain-scoped ones (`example.com:my-project`).
  if (!isFirebaseProjectId(projectId)) {
    throw new TypeError('The FCM project id is not a Firebase project id.');
  }
  const fetcher: FetchLike = input.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const timeoutMs = input.timeoutMs ?? defaultTimeoutMs;
  const tokens = input.tokens ?? createFcmAccessTokenSource({
    serviceAccount: input.serviceAccount,
    fetch: fetcher,
    ...(input.now === undefined ? {} : { now: input.now }),
    ...(input.subtle === undefined ? {} : { subtle: input.subtle }),
    timeoutMs,
  });
  const endpoint = `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/messages:send`;

  return {
    id: input.id ?? 'fcm',
    async send(request) {
      const built = buildFcmMessage(request);
      if (built.status === 'invalid') {
        // Nothing was sent, and the same send would fail again (an expired
        // message keeps its own code, so lateness is not read as a setup error).
        return { status: 'rejected', reason: 'configuration', providerCode: built.code };
      }
      const body = JSON.stringify({ message: built.message });
      for (let attempt = 0; attempt < 2; attempt += 1) {
        let token: string;
        try {
          token = await tokens.get();
        } catch (error) {
          // No token means nothing was sent.
          if (error instanceof FcmAccessTokenError && !error.retryable) {
            return { status: 'rejected', reason: 'configuration', providerCode: error.code };
          }
          return {
            status: 'rate-limited',
            retryAfterSeconds: error instanceof FcmAccessTokenError
              ? (error.retryAfterSeconds ?? defaultRetryAfterSeconds)
              : defaultRetryAfterSeconds,
          };
        }
        let response: Response;
        try {
          response = await fetcher(endpoint, {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body,
            signal: AbortSignal.timeout(timeoutMs),
          });
        } catch {
          // A timeout or a dropped connection: FCM may have taken the message.
          return { status: 'ambiguous', providerCode: 'NETWORK_ERROR' };
        }
        const answer = await readJson(response);
        if (response.ok) {
          const name = answer?.name;
          return typeof name === 'string' && name !== ''
            ? { status: 'accepted', providerMessageId: name }
            : { status: 'accepted' };
        }
        if (response.status === 401 && attempt === 0 && fcmErrorCodeOf(answer) === undefined) {
          // The token was revoked or expired early: mint a new one once.
          tokens.invalidate(token);
          continue;
        }
        const retryAfterSeconds = retryAfterOf(response, (input.now ?? Date.now)());
        return classifyFcmError({
          status: response.status,
          body: answer,
          ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
        });
      }
      // Not reached: the second attempt always answers above. The loop's
      // type needs an answer here, and a fresh token refused again would be
      // the setup's to fix.
      return { status: 'rejected', reason: 'configuration', providerCode: 'UNAUTHENTICATED' };
    },
  };
}

/**
 * The registry registration for FCM: the reference `fcm` entry, the
 * `android` and `ios` targets, and registration-token addresses only.
 */
export function createFcmProviderRegistration(
  input: CreateFcmDeliveryProviderInput & { readonly targets?: readonly string[] },
): NotificationProviderRegistration {
  const { targets, ...provider } = input;
  const delivery = createFcmDeliveryProvider(provider);
  return {
    entry: { ...referenceNotificationProviders.fcm, provider: delivery.id },
    delivery,
    targets: targets ?? ['android', 'ios'],
    addressKinds: [...fcmAddressKinds],
  };
}

/**
 * A Firebase project id (lowercase letters, digits, and hyphens), or a
 * legacy domain-scoped one (`example.com:my-project`): every label starts
 * and ends with a letter or digit, 5 to 100 characters in all.
 */
function isFirebaseProjectId(id: string): boolean {
  const label = '[a-z0-9](?:[a-z0-9-]*[a-z0-9])?';
  return id.length >= 5
    && id.length <= 100
    && new RegExp(`^(?:${label}(?:\\.${label})*:)?${label}$`, 'u').test(id);
}

/** FCM's reserved data keys (`from`, `message_type`, and any `google` or `gcm` prefix), `topic` and `route`, the shell renderer's `mpgd.` keys, and keys a plain object cannot hold. */
function isReservedDataKey(key: string): boolean {
  const lower = key.toLowerCase();
  return key === ''
    || key === '__proto__'
    || (fcmReservedDataKeys as readonly string[]).includes(key)
    || lower === 'from'
    || lower === 'notification'
    || lower === 'message_type'
    // Keys the Capacitor provider drops from an open's data.
    || key === 'collapse_key'
    || key === 'aps'
    || key === 'fcm_options'
    || lower.startsWith('google')
    || lower.startsWith('gcm')
    // The shell renderer's keys (`fcmShellRenderedDataKeys`) and the keys it
    // adds to an open.
    || lower.startsWith('mpgd.');
}

/** The `details` of an FCM error answer. */
function errorDetailsOf(body: unknown): readonly Readonly<Record<string, unknown>>[] {
  const error = isRecord(body) && isRecord(body.error) ? body.error : undefined;
  return Array.isArray(error?.details) ? error.details.filter(isRecord) : [];
}

/** The FCM `errorCode` among an error answer's details, if any. */
function errorCodeOf(details: readonly Readonly<Record<string, unknown>>[]): string | undefined {
  return details
    .map((detail) => detail.errorCode)
    .find((code): code is string => typeof code === 'string');
}

/** The FCM `errorCode` in an error answer, if any. */
function fcmErrorCodeOf(body: unknown): string | undefined {
  return errorCodeOf(errorDetailsOf(body));
}

/** An upstream error string as a short provider code: upper case, `[A-Z0-9_]`, at most 64 characters. */
function providerCodeOf(text: string): string {
  return text.toUpperCase().replace(/[^A-Z0-9_]+/gu, '_').slice(0, 64) || 'UNKNOWN';
}

async function importPrivateKey(subtle: SubtleCrypto, pem: string): Promise<CryptoKey> {
  const body = pem
    .replace(/-----(?:BEGIN|END) PRIVATE KEY-----/gu, '')
    .replace(/\\n|\s/gu, '');
  let der: Uint8Array<ArrayBuffer>;
  try {
    der = Uint8Array.from(atob(body), (char) => char.charCodeAt(0));
  } catch {
    throw new TypeError('The FCM service account private key is not PKCS #8 PEM.');
  }
  try {
    return await subtle.importKey(
      'pkcs8',
      der,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign'],
    );
  } catch {
    // The key itself never appears in the error.
    throw new TypeError('The FCM service account private key could not be imported.');
  }
}

async function signJwt(
  subtle: SubtleCrypto,
  key: CryptoKey,
  input: { readonly header: object; readonly claims: object },
): Promise<string> {
  const encoder = new TextEncoder();
  const signingInput = `${base64Url(encoder.encode(JSON.stringify(input.header)))}.${
    base64Url(encoder.encode(JSON.stringify(input.claims)))
  }`;
  const signature = await subtle.sign('RSASSA-PKCS1-v1_5', key, encoder.encode(signingInput));
  return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

async function readJson(response: Response): Promise<Readonly<Record<string, unknown>> | undefined> {
  try {
    const parsed: unknown = await response.json();
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** `Retry-After` in seconds (a number or an HTTP date), at most a day. */
function retryAfterOf(response: Response, now: number): number | undefined {
  const header = response.headers.get('retry-after');
  if (header === null || header.trim() === '') {
    return undefined;
  }
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.min(Math.ceil(seconds), maxRetryAfterSeconds);
  }
  const date = Date.parse(header);
  if (Number.isFinite(date)) {
    const delta = Math.ceil((date - now) / 1000);
    return delta > 0 ? Math.min(delta, maxRetryAfterSeconds) : undefined;
  }
  return undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Collapse id for one send key: SHA-256 hex, exactly 64 bytes, so it fits
 * `android.collapse_key` and `apns-collapse-id`. Sync because
 * `buildFcmMessage` is sync; Workers have no sync WebCrypto digest.
 */
export function fcmCollapseId(sendKey: string): string {
  const hex = sha256Hex(new TextEncoder().encode(sendKey));
  return hex.length === fcmCollapseIdBytes ? hex : hex.slice(0, fcmCollapseIdBytes);
}

const sha256K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

function sha256Hex(data: Uint8Array): string {
  const bitLength = data.length * 8;
  const paddedLength = (Math.floor((data.length + 8) / 64) + 1) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);
  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const words = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4);
    }
    for (let index = 16; index < 64; index += 1) {
      const earlier = words[index - 15] ?? 0;
      const recent = words[index - 2] ?? 0;
      const s0 = rotr(earlier, 7) ^ rotr(earlier, 18) ^ (earlier >>> 3);
      const s1 = rotr(recent, 17) ^ rotr(recent, 19) ^ (recent >>> 10);
      words[index] = ((words[index - 16] ?? 0) + s0 + (words[index - 7] ?? 0) + s1) >>> 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let index = 0; index < 64; index += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + (sha256K[index] ?? 0) + (words[index] ?? 0)) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((word) => word.toString(16).padStart(8, '0'))
    .join('');
}
