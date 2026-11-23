import {
  createAccessTokenSource,
  errorOptionsOf,
  googleTokenEndpoint,
  readServiceAccountFields,
  type CreateGoogleAccessTokenSourceInput,
  type GoogleAccessTokenSource,
  type GoogleServiceAccount,
} from './google-oauth.js';

/**
 * OAuth access tokens for a Google service account, for any API scope: a JWT
 * signed with the account's key through WebCrypto is exchanged at Google's
 * token endpoint (`googleTokenEndpoint`). It needs only `fetch` and
 * `crypto.subtle`, so it runs on Cloudflare Workers. Backend only: a
 * service-account key never belongs in a game client.
 *
 * The Play Developer API source (`createGooglePlayPublisherAccessTokenSource`
 * from `@mpgd/game-services/google-play-publisher-client`) and the FCM one
 * (`createFcmAccessTokenSource` from `@mpgd/game-services/notifications`)
 * are this source with their scope.
 */

export { googleTokenEndpoint };
export type { CreateGoogleAccessTokenSourceInput, GoogleAccessTokenSource, GoogleServiceAccount };

/**
 * Reads a Google service-account key file (its JSON text or the parsed
 * object): `client_email`, `private_key`, and `private_key_id` when it is
 * there. Errors name the missing field and never include a value.
 */
export function parseGoogleServiceAccount(input: unknown): GoogleServiceAccount {
  const { field, privateKeyId } = readServiceAccountFields(input, 'Google');
  return {
    clientEmail: field('client_email'),
    privateKey: field('private_key'),
    ...(privateKeyId === undefined ? {} : { privateKeyId }),
  };
}

/**
 * Why no access token could be minted, and whether trying again later can
 * help. The message holds only the code: never the private key, the signed
 * assertion, the token, or Google's answer.
 */
export class GoogleAccessTokenError extends Error {
  override readonly name: string = 'GoogleAccessTokenError';
  readonly retryable: boolean;
  /**
   * `TOKEN_KEY_UNUSABLE` (the key does not import or sign; `cause` names the
   * step), `TOKEN_NETWORK_ERROR` (no answer within the timeout),
   * `TOKEN_MALFORMED_RESPONSE`, `TOKEN_REDIRECTED`, or `TOKEN_` and Google's
   * OAuth error code (`TOKEN_INVALID_GRANT`), else the HTTP status
   * (`TOKEN_HTTP_503`).
   */
  readonly code: string;
  readonly retryAfterSeconds: number | undefined;

  constructor(
    code: string,
    retryable: boolean,
    retryAfterSeconds?: number,
    options?: { readonly cause?: unknown },
  ) {
    super(`Google access token request failed: ${code}.`, options);
    this.code = code;
    this.retryable = retryable;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * Mints and caches OAuth access tokens for `input.scope` with the service
 * account's key. The key, the signed assertion, and the token live only in
 * this source's memory: they are never logged, persisted, or put in an
 * error. Concurrent callers share one token request, which `timeoutMs` (10
 * seconds by default) bounds with its response body, and no caller waits
 * longer than that and a second; an answer over 16 KiB, a redirect, or a
 * token that is not a bearer token is refused. A token is refreshed five
 * minutes before it expires. A failure rejects with a
 * `GoogleAccessTokenError` and answers for a while without asking Google
 * again (30 seconds for a refused grant or an unusable key, a few seconds for
 * an outage). Keep one source per isolate and account.
 */
export function createGoogleAccessTokenSource(
  input: CreateGoogleAccessTokenSourceInput,
): GoogleAccessTokenSource {
  return createAccessTokenSource(input, {
    label: 'Google',
    errorOf: (failure) =>
      new GoogleAccessTokenError(
        failure.code,
        failure.retryable,
        failure.retryAfterSeconds,
        errorOptionsOf(failure),
      ),
  });
}
