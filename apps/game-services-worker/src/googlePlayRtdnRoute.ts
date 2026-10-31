import {
  createGoogleIdTokenSigningKeys,
  GoogleIdTokenKeysUnavailableError,
  googlePlayDeveloperNotificationHttpStatus,
  handleGooglePlayDeveloperNotification,
  verifyGooglePubSubPushToken,
  type GameServicesStore,
  type GoogleIdTokenSigningKeys,
  type GooglePlayVoidedPurchasesClient,
} from '@mpgd/game-services';

import { readBoundedText } from './boundedBody.js';

/**
 * Google Play Real-time developer notifications, pushed by a Cloud Pub/Sub
 * push subscription with authentication. Set this path (on the Worker's
 * host) as the subscription's push endpoint. It is the fast path for
 * revoking refunded Play purchases; the cron's Voided Purchases API sweep
 * stays on as the backstop.
 */
export const googlePlayRtdnPath = '/google-play/rtdn';

export interface GooglePlayRtdnEnv {
  /** The app's package; required with the RTDN settings below. */
  readonly GAME_SERVICES_GOOGLE_PLAY_PACKAGE_NAME?: string;
  /**
   * The push subscription's audience (`--push-auth-token-audience`, or the
   * push endpoint URL when it was left unset). Mounts the RTDN route.
   */
  readonly GAME_SERVICES_GOOGLE_PLAY_RTDN_AUDIENCE?: string;
  /** The service account the push subscription signs its OIDC token as. Mounts the RTDN route. */
  readonly GAME_SERVICES_GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT?: string;
}

/** Google's public keys, shared by every request this isolate serves. */
let isolateSigningKeys: GoogleIdTokenSigningKeys | undefined;

/**
 * Mounts `POST /google-play/rtdn` when either RTDN setting is present. With
 * one of the audience, the service account, or the package name missing, or
 * without the Voided Purchases client (the in-Worker Play boundary:
 * `GAME_SERVICES_GOOGLE_PLAY_PUBLISHER_AUTH`), the route answers 503 to every
 * push (fail closed: Pub/Sub keeps the messages and redelivers them once the
 * settings are complete). A push is never revoked without the Voided
 * Purchases API listing it.
 */
export function createWorkerGooglePlayRtdnFetchHandler(
  env: GooglePlayRtdnEnv,
  store: GameServicesStore,
  resolveVoidedPurchases: () => GooglePlayVoidedPurchasesClient | undefined,
): ((request: Request) => Promise<Response | undefined>) | undefined {
  const audience = env.GAME_SERVICES_GOOGLE_PLAY_RTDN_AUDIENCE?.trim() ?? '';
  const serviceAccountEmail = env.GAME_SERVICES_GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT?.trim() ?? '';
  const packageName = env.GAME_SERVICES_GOOGLE_PLAY_PACKAGE_NAME?.trim() ?? '';
  if (audience.length === 0 && serviceAccountEmail.length === 0) {
    return undefined;
  }
  if (audience.length === 0 || serviceAccountEmail.length === 0 || packageName.length === 0) {
    console.error(
      'Google Play RTDN refuses every push: GAME_SERVICES_GOOGLE_PLAY_RTDN_AUDIENCE, '
        + 'GAME_SERVICES_GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT, and '
        + 'GAME_SERVICES_GOOGLE_PLAY_PACKAGE_NAME are required together.',
    );
    return createGooglePlayRtdnFetchHandler({ configuration: 'incomplete' });
  }
  let voidedPurchases: GooglePlayVoidedPurchasesClient | undefined;
  try {
    voidedPurchases = resolveVoidedPurchases();
  } catch {
    // The Play boundary's own settings error; reported where it is built.
    voidedPurchases = undefined;
  }
  if (voidedPurchases === undefined) {
    console.error(
      'Google Play RTDN refuses every push: it confirms each void with the Voided Purchases '
        + 'API, which needs the in-Worker Play boundary (GAME_SERVICES_GOOGLE_PLAY_PACKAGE_NAME '
        + 'with GAME_SERVICES_GOOGLE_PLAY_PUBLISHER_AUTH).',
    );
    return createGooglePlayRtdnFetchHandler({ configuration: 'incomplete' });
  }
  isolateSigningKeys ??= createGoogleIdTokenSigningKeys();
  return createGooglePlayRtdnFetchHandler({
    store,
    packageName,
    audience,
    serviceAccountEmail,
    keys: isolateSigningKeys,
    voidedPurchases,
  });
}

export type GooglePlayRtdnFetchHandlerInput =
  | { readonly configuration: 'incomplete' }
  | {
      readonly configuration?: 'complete';
      readonly store: GameServicesStore;
      readonly packageName: string;
      readonly audience: string;
      readonly serviceAccountEmail: string;
      readonly keys: GoogleIdTokenSigningKeys;
      /** The sweep's Voided Purchases API client: every void is confirmed with it. */
      readonly voidedPurchases: GooglePlayVoidedPurchasesClient;
      /** Milliseconds since the epoch. */
      readonly now?: () => number;
      readonly unmatchedVoidRetryMs?: number;
    };

export function createGooglePlayRtdnFetchHandler(
  input: GooglePlayRtdnFetchHandlerInput,
): (request: Request) => Promise<Response | undefined> {
  return async (request) => {
    if (!matchesPath(new URL(request.url).pathname)) {
      return undefined;
    }
    if (request.method !== 'POST') {
      return json({ error: 'METHOD_NOT_ALLOWED' }, 405, { allow: 'POST' });
    }
    if (input.configuration === 'incomplete') {
      return json({ error: 'GOOGLE_PLAY_RTDN_NOT_CONFIGURED' }, 503);
    }
    const now = input.now ?? Date.now;
    let authentication: Awaited<ReturnType<typeof verifyGooglePubSubPushToken>>;
    try {
      authentication = await verifyGooglePubSubPushToken({
        authorization: request.headers.get('authorization'),
        audience: input.audience,
        serviceAccountEmail: input.serviceAccountEmail,
        keys: input.keys,
        signal: AbortSignal.timeout(keyTimeoutMs),
        now,
      });
    } catch (error) {
      if (error instanceof GoogleIdTokenKeysUnavailableError) {
        console.error('Google Play RTDN push not verified:', error.message);
        return json({ error: 'GOOGLE_KEYS_UNAVAILABLE' }, 503);
      }
      throw error;
    }
    if (authentication.status === 'rejected') {
      // Not acknowledged: a push from a subscription with the wrong audience
      // or service account is kept by Pub/Sub until the settings match.
      console.warn('Google Play RTDN push refused:', authentication.reason);
      return json({ error: 'UNAUTHENTICATED' }, 401, { 'www-authenticate': 'Bearer' });
    }
    // Authenticated from here: a body this route cannot read is acknowledged
    // (200) so Pub/Sub does not redeliver it until its retention runs out.
    const text = Number(request.headers.get('content-length') ?? '0') > maxBodyBytes
      ? undefined
      : await readBoundedText(request, maxBodyBytes);
    let body: unknown;
    try {
      body = text === undefined ? undefined : JSON.parse(text);
    } catch {
      body = undefined;
    }
    if (body === undefined) {
      console.error('Google Play RTDN push acknowledged unread: GOOGLE_PLAY_RTDN_BODY_INVALID');
      return json({ status: 'rejected', reason: 'GOOGLE_PLAY_RTDN_BODY_INVALID' }, 200);
    }
    try {
      const outcome = await handleGooglePlayDeveloperNotification({
        store: input.store,
        packageName: input.packageName,
        voidedPurchases: input.voidedPurchases,
        body,
        // An unwrapped push (payload unwrapping with "write metadata")
        // carries its message id only in this header.
        messageId: request.headers.get('x-goog-pubsub-message-id'),
        signal: AbortSignal.timeout(lookupTimeoutMs),
        now: () => new Date(now()).toISOString(),
        ...(input.unmatchedVoidRetryMs === undefined
          ? {}
          : { unmatchedVoidRetryMs: input.unmatchedVoidRetryMs }),
      });
      // The message id and order id trace a delivery; the purchase token is never logged.
      const detail = outcome.status === 'revoked'
        ? `alreadyProcessed=${String(outcome.alreadyProcessed)}`
        : outcome.reason;
      const orderId = 'orderId' in outcome ? (outcome.orderId ?? '-') : '-';
      const log = outcome.status === 'conflict' || outcome.status === 'rejected'
        ? console.error
        : outcome.status === 'retry'
          ? console.warn
          : console.log;
      log('Google Play RTDN', outcome.status, outcome.messageId ?? '-', detail, orderId);
      return json(outcome, googlePlayDeveloperNotificationHttpStatus(outcome));
    } catch (error) {
      // A store failure: not acknowledged, so Pub/Sub redelivers.
      console.error(
        'Google Play RTDN failed:',
        error instanceof Error ? error.name : 'unknown error',
      );
      return json({ error: 'INTERNAL_ERROR' }, 500);
    }
  };
}

/** RTDN messages are a few hundred bytes; the envelope and base64 add little. */
const maxBodyBytes = 64 * 1024;
const keyTimeoutMs = 10_000;
/** The Voided Purchases API lookup (two pages at most); Pub/Sub's push deadline is longer. */
const lookupTimeoutMs = 15_000;

function matchesPath(pathname: string): boolean {
  return pathname === googlePlayRtdnPath || pathname === `${googlePlayRtdnPath}/`;
}

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}
