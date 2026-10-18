import { referenceNotificationProviders } from '@mpgd/platform/notifications';

import type {
  NotificationRemoteDeliveryAnswer,
  NotificationRemoteDeliveryProvider,
  NotificationRemoteDeliveryRequest,
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
 * registers; an Android FCM notification message cannot carry actions, so
 * the shell renders advertising natively (C1). An expiry becomes
 * `android.ttl` and the `apns-expiration` header.
 */

export const fcmMessagingScope = 'https://www.googleapis.com/auth/firebase.messaging';
export const fcmTokenEndpoint = 'https://oauth2.googleapis.com/token';
/** The FCM HTTP v1 API takes registration tokens; installation ids are not a send target. */
export const fcmAddressKinds = Object.freeze(['fcm-token'] as const);
/** Data keys this provider writes; a send's routing data may not use them. */
export const fcmReservedDataKeys = Object.freeze(['topic', 'route'] as const);
/** The iOS notification category of advertising, which carries the opt-out action. */
export const fcmAdvertisingCategory = 'mpgd-advertising';
/**
 * FCM's 4,096-byte limit, less room for what FCM and APNs add on the way
 * (the `aps` wrapper and FCM's own keys), so a message this check passes is
 * not refused for its size.
 */
const maxPayloadBytes = 3840;
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
      /** `MESSAGE_EXPIRED` for a message that would arrive too late, else `INVALID_MESSAGE`. */
      readonly code: 'INVALID_MESSAGE' | 'MESSAGE_EXPIRED';
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
  const android: Record<string, unknown> = {
    ...(expiresAt === undefined ? {} : { ttl: `${Math.floor((expiresAt - at) / 1000)}s` }),
    notification: { channel_id: channelId },
  };
  const category = request.topic.purpose === 'advertising' ? fcmAdvertisingCategory : undefined;
  const apns: Record<string, unknown> = {
    ...(expiresAt === undefined
      ? {}
      : { headers: { 'apns-expiration': String(Math.floor(expiresAt / 1000)) } }),
    ...(category === undefined ? {} : { payload: { aps: { category } } }),
  };
  const payload = {
    notification,
    data: { ...data },
    ...(Object.keys(android).length === 0 ? {} : { android }),
    ...(Object.keys(apns).length === 0 ? {} : { apns }),
  };
  // Everything but the token counts toward the size FCM and APNs carry.
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload)).length;
  if (payloadBytes > maxPayloadBytes) {
    return {
      status: 'invalid',
      reason: `the payload is ${payloadBytes} bytes; this provider sends at most ${maxPayloadBytes}`,
      code: 'INVALID_MESSAGE',
    };
  }
  return {
    status: 'ready',
    message: { token: recipient.address.value, ...payload },
  };
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

/** FCM's reserved data keys (`from`, `message_type`, and any `google` or `gcm` prefix), `topic` and `route`, and keys a plain object cannot hold. */
function isReservedDataKey(key: string): boolean {
  const lower = key.toLowerCase();
  return key === ''
    || key === '__proto__'
    || (fcmReservedDataKeys as readonly string[]).includes(key)
    || lower === 'from'
    || lower === 'notification'
    || lower === 'message_type'
    || lower.startsWith('google')
    || lower.startsWith('gcm');
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
