import {
  referenceNotificationProviders,
  type NotificationAction,
} from '@mpgd/platform/notifications';

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
 * Payload: the gate's title and body as the FCM `notification`; `data`
 * carries the send's routing data plus `mpgd.topic`, `mpgd.route`, and, when
 * the content has actions (the advertising opt-out under the Korean rules),
 * `mpgd.actions` as JSON. Android uses the mapping's `channelId`; iOS gets the
 * first action's id as the APNs category. An expiry becomes `android.ttl` and
 * the `apns-expiration` header.
 */

export const fcmMessagingScope = 'https://www.googleapis.com/auth/firebase.messaging';
export const fcmTokenEndpoint = 'https://oauth2.googleapis.com/token';
/** The FCM HTTP v1 API takes registration tokens; installation ids are not a send target. */
export const fcmAddressKinds = Object.freeze(['fcm-token'] as const);
/** Data keys this provider writes; a send's routing data may not use the prefix. */
export const fcmReservedDataPrefix = 'mpgd.';
/** FCM's limit on a message's notification and data payload. */
const maxPayloadBytes = 4096;
const tokenLifetimeSeconds = 3600;
/** A cached token is refreshed this long before it expires. */
const tokenRefreshMarginMs = 5 * 60 * 1000;
const defaultTimeoutMs = 10_000;
const defaultRetryAfterSeconds = 60;

/** The fields of a Google service-account key this provider reads. */
export interface FcmServiceAccount {
  readonly projectId: string;
  readonly clientEmail: string;
  /** PKCS #8 PEM (`-----BEGIN PRIVATE KEY-----`). */
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

  constructor(code: string, retryable: boolean, retryAfterSeconds?: number) {
    super(`FCM access token request failed: ${code}.`);
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
  let cached: { readonly token: string; readonly refreshAt: number } | undefined;
  let pending: Promise<string> | undefined;

  const key = (): Promise<CryptoKey> => {
    signingKey ??= importPrivateKey(subtle, serviceAccount.privateKey).catch((error: unknown) => {
      signingKey = undefined;
      throw error;
    });
    return signingKey;
  };
  const mint = async (): Promise<string> => {
    const issuedAt = Math.floor(now() / 1000);
    const assertion = await signJwt(subtle, await key(), {
      header: {
        alg: 'RS256',
        typ: 'JWT',
        ...(serviceAccount.privateKeyId === undefined ? {} : { kid: serviceAccount.privateKeyId }),
      },
      claims: {
        iss: serviceAccount.clientEmail,
        scope: fcmMessagingScope,
        aud: fcmTokenEndpoint,
        iat: issuedAt,
        exp: issuedAt + tokenLifetimeSeconds,
      },
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
        `TOKEN_${error.toUpperCase()}`,
        retryable,
        retryable ? retryAfterOf(response) : undefined,
      );
    }
    const token = body?.access_token;
    if (typeof token !== 'string' || token === '') {
      throw new FcmAccessTokenError('TOKEN_MALFORMED_RESPONSE', true);
    }
    const expiresIn = typeof body?.expires_in === 'number' && Number.isFinite(body.expires_in) && body.expires_in > 0
      ? Math.min(body.expires_in, tokenLifetimeSeconds)
      : tokenLifetimeSeconds;
    cached = { token, refreshAt: issuedAt * 1000 + expiresIn * 1000 - tokenRefreshMarginMs };
    return token;
  };

  return {
    async get() {
      if (cached !== undefined && now() < cached.refreshAt) {
        return cached.token;
      }
      pending ??= mint().finally(() => {
        pending = undefined;
      });
      return pending;
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
  | { readonly status: 'invalid'; readonly reason: string };

/**
 * Builds the HTTP v1 `message` for one delivery and checks it against FCM's
 * rules before anything is sent: a registration token address, a title and
 * a body, routing data without FCM's or this provider's reserved keys, and a
 * payload within 4,096 bytes. A message that passes is "known valid", which
 * is what lets an `INVALID_ARGUMENT` answer mean a dead token.
 */
export function buildFcmMessage(request: NotificationRemoteDeliveryRequest): FcmMessageBuild {
  const { recipient, content } = request;
  if (recipient.kind !== 'device' || recipient.address.kind !== 'fcm-token') {
    return { status: 'invalid', reason: 'FCM sends to registration tokens only' };
  }
  if (content.title === undefined || content.body === undefined) {
    return { status: 'invalid', reason: 'FCM content needs a title and a body' };
  }
  const data: Record<string, string> = {};
  for (const [key, value] of Object.entries(request.data ?? {})) {
    if (isReservedDataKey(key)) {
      return { status: 'invalid', reason: `the data key ${JSON.stringify(key)} is reserved` };
    }
    data[key] = value;
  }
  data[`${fcmReservedDataPrefix}topic`] = request.topic.id;
  data[`${fcmReservedDataPrefix}route`] = content.route;
  const actions: readonly NotificationAction[] = content.actions ?? [];
  if (actions.length > 0) {
    data[`${fcmReservedDataPrefix}actions`] = JSON.stringify(actions);
  }
  const notification = { title: content.title, body: content.body };
  const payloadBytes = new TextEncoder().encode(JSON.stringify({ notification, data })).length;
  if (payloadBytes > maxPayloadBytes) {
    return {
      status: 'invalid',
      reason: `the payload is ${payloadBytes} bytes; FCM accepts ${maxPayloadBytes}`,
    };
  }
  const channelId = request.topic.mapping?.['channelId'];
  const expiresAt = request.expiresAt === undefined ? undefined : Date.parse(request.expiresAt);
  const at = Date.parse(request.at);
  if (expiresAt !== undefined && (!Number.isFinite(expiresAt) || !Number.isFinite(at))) {
    return { status: 'invalid', reason: 'the expiry or the call time is not a timestamp' };
  }
  const android: Record<string, unknown> = {
    ...(expiresAt === undefined ? {} : { ttl: `${Math.max(0, Math.floor((expiresAt - at) / 1000))}s` }),
    ...(typeof channelId === 'string' && channelId !== ''
      ? { notification: { channel_id: channelId } }
      : {}),
  };
  const category = actions[0]?.id;
  const apns: Record<string, unknown> = {
    ...(expiresAt === undefined
      ? {}
      : { headers: { 'apns-expiration': String(Math.floor(expiresAt / 1000)) } }),
    ...(category === undefined ? {} : { payload: { aps: { category } } }),
  };
  return {
    status: 'ready',
    message: {
      token: recipient.address.value,
      notification,
      data,
      ...(Object.keys(android).length === 0 ? {} : { android }),
      ...(Object.keys(apns).length === 0 ? {} : { apns }),
    },
  };
}

/**
 * Maps an FCM error answer to the provider answer kinds (RFC "Delivery
 * providers"): `UNREGISTERED` is `unregistered`, and so is
 * `INVALID_ARGUMENT` for a message `buildFcmMessage` passed unless the
 * answer names a field other than the token; `QUOTA_EXCEEDED` is
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
  const details = Array.isArray(error?.details) ? error.details.filter(isRecord) : [];
  const fcmCode = details
    .map((detail) => detail.errorCode)
    .find((code): code is string => typeof code === 'string');
  const code = fcmCode ?? (typeof error?.status === 'string' ? error.status : undefined);
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
      return fields.every((field) => field === 'message.token')
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
  if (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/u.test(projectId)) {
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
        // Nothing was sent, and the same send would fail again.
        return { status: 'rejected', reason: 'configuration', providerCode: 'INVALID_MESSAGE' };
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
        if (response.status === 401 && attempt === 0) {
          // The token was revoked or expired early: mint a new one once.
          tokens.invalidate(token);
          continue;
        }
        const retryAfterSeconds = retryAfterOf(response);
        return classifyFcmError({
          status: response.status,
          body: answer,
          ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
        });
      }
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

function isReservedDataKey(key: string): boolean {
  const lower = key.toLowerCase();
  return key.startsWith(fcmReservedDataPrefix)
    || lower === 'from'
    || lower === 'notification'
    || lower === 'message_type'
    || lower.startsWith('google.')
    || lower.startsWith('gcm.');
}

async function importPrivateKey(subtle: SubtleCrypto, pem: string): Promise<CryptoKey> {
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----/gu, '')
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

/** `Retry-After` in seconds when it is a positive number of seconds or an HTTP date. */
function retryAfterOf(response: Response): number | undefined {
  const header = response.headers.get('retry-after');
  if (header === null || header.trim() === '') {
    return undefined;
  }
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.ceil(seconds);
  }
  const date = Date.parse(header);
  if (Number.isFinite(date)) {
    const delta = Math.ceil((date - Date.now()) / 1000);
    return delta > 0 ? delta : undefined;
  }
  return undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
