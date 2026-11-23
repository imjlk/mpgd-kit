/**
 * Google service-account OAuth, shared inside the package (not exported):
 * the key-file reader and the access token source behind
 * `parseGoogleServiceAccount` and `createGoogleAccessTokenSource`
 * (`google-access-token.ts`), and behind FCM's `parseFcmServiceAccount` and
 * `createFcmAccessTokenSource`. They differ only in the scope, the label in
 * their messages, and the error class a failure becomes.
 *
 * A token is minted with the JWT bearer grant (RFC 7523): a JWT signed with
 * the account's key through WebCrypto (RS256) is exchanged at Google's token
 * endpoint. Only `fetch`, `crypto.subtle`, and timers are used, so it runs on
 * Cloudflare Workers.
 */

export const googleTokenEndpoint = 'https://oauth2.googleapis.com/token';
const jwtBearerGrantType = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
/** The assertion's lifetime, and the longest a token is cached. */
const tokenLifetimeSeconds = 3600;
/** A cached token is refreshed this long before it expires. */
const tokenRefreshMarginMs = 5 * 60 * 1000;
/** How long a refused grant or an unusable key answers without asking Google again. */
const failedTokenCacheMs = 30_000;
/** How long a token endpoint that is down answers without asking again. */
const retryableTokenCacheMs = 5_000;
/** The longest an outage answers without asking again, whatever its `Retry-After`. */
const maxRetryableTokenCacheMs = 60_000;
const defaultTimeoutMs = 10_000;
/**
 * A token request still unsettled this long after its timeout is given up:
 * its timer did not run (the request context that started it ended), and
 * its callers would otherwise wait on it for ever.
 */
const abandonedMintGraceMs = 1_000;
/** The longest delay a timer takes; a longer one fires at once. */
const maxTimerDelayMs = 2_147_483_647;
/** A token answer is about 1 KiB; a larger body is not one. */
const maxTokenResponseBytes = 16_384;
/** Google's access tokens are about 2 KiB; this bounds what goes in a header. */
const maxAccessTokenLength = 8_192;
/** The longest `Retry-After` passed on, in seconds. */
const maxRetryAfterSeconds = 86_400;

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** The fields of a Google service-account key file a token source reads. */
export interface GoogleServiceAccount {
  readonly clientEmail: string;
  /** A PKCS #8 PEM `PRIVATE KEY` block, as a service-account key file holds it. */
  readonly privateKey: string;
  readonly privateKeyId?: string;
}

/** OAuth access tokens for one service account and one scope. */
export interface GoogleAccessTokenSource {
  /**
   * A valid access token, from the cache or minted. Concurrent callers share
   * one token request. A token is refreshed five minutes before it expires,
   * and answers until it expires while that refresh is under way or failing.
   * No caller waits longer than the timeout and a second, even on a request
   * whose Worker request context ended before it answered. `signal` ends only
   * this caller's wait, with the signal's reason: an already aborted signal
   * rejects at once, without a request, and a shared request goes on for the
   * other callers. It does not use `this`, so it can be passed on its own
   * (`getAccessToken: tokens.get`).
   */
  readonly get: (signal?: AbortSignal) => Promise<string>;
  /** Drops `token` from the cache after an API refused it (HTTP 401); the next `get` mints a new one. */
  readonly invalidate: (token: string) => void;
}

export interface CreateGoogleAccessTokenSourceInput {
  readonly serviceAccount: GoogleServiceAccount;
  /** The OAuth scope the tokens are for: a scope URL, or several separated by spaces. */
  readonly scope: string;
  /** The global `fetch` by default, read at each request. */
  readonly fetch?: FetchLike;
  readonly now?: () => number;
  readonly subtle?: SubtleCrypto;
  /** Bounds each token request, its response body included; 10 seconds by default. */
  readonly timeoutMs?: number;
}

/** Why no token was minted; the token source turns it into the error `get` rejects with. */
export interface AccessTokenFailure {
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;
  /** An unusable key's only: which step failed (the PEM, the import, or signing), never key material. */
  readonly cause?: unknown;
}

/**
 * Reads a service-account key file (its JSON text or the parsed object) and
 * answers its string fields by name. `label` names the credential in the
 * errors, which name a missing field and never include a value.
 */
export function readServiceAccountFields(
  input: unknown,
  label: string,
): { readonly field: (name: string) => string; readonly privateKeyId: string | undefined } {
  let value: unknown = input;
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input);
    } catch {
      // A parse error quotes the text, which holds the private key.
      throw new TypeError(`The ${label} service account is not JSON.`);
    }
  }
  if (!isRecord(value)) {
    throw new TypeError(`The ${label} service account must be an object.`);
  }
  const record = value;
  if (record.type !== undefined && record.type !== 'service_account') {
    throw new TypeError(`The ${label} credential is not a service account key.`);
  }
  const privateKeyId = record.private_key_id;
  return {
    field(name) {
      const text = record[name];
      if (typeof text !== 'string' || text.trim() === '') {
        throw new TypeError(`The ${label} service account has no ${name}.`);
      }
      return text;
    },
    privateKeyId: typeof privateKeyId === 'string' && privateKeyId !== '' ? privateKeyId : undefined,
  };
}

interface MintedToken {
  readonly token: string;
  readonly refreshAt: number;
  readonly expiresAt: number;
}

type MintResult =
  | { readonly ok: true; readonly minted: MintedToken }
  | { readonly ok: false; readonly failure: AccessTokenFailure };

interface PendingMint {
  readonly token: Promise<string>;
  readonly abandonAt: number;
}

/**
 * The access token source for `input.scope`. The private key, the signed
 * assertion, and the token live only in this closure: they are never logged,
 * persisted, or put in an error. Each token request is bounded by
 * `timeoutMs` and its answer by 16 KiB, and each caller's wait by
 * `timeoutMs` and a second; a redirect is refused, never followed, and an
 * answer that comes too late is cancelled. A failure becomes
 * `errorOf(failure)` and answers for a while (30 seconds for a refused grant
 * or an unusable key, a few seconds, or what `Retry-After` asked up to a
 * minute, for an outage) without asking again, so a fan-out does not ask
 * Google once per caller.
 */
export function createAccessTokenSource(
  input: CreateGoogleAccessTokenSourceInput,
  options: {
    /** Names the account in the messages of an unusable key (`FCM`, `Google`). */
    readonly label: string;
    readonly errorOf: (failure: AccessTokenFailure) => Error;
  },
): GoogleAccessTokenSource {
  const { serviceAccount, scope } = input;
  if (typeof scope !== 'string' || scope.trim() === '' || /[\x00-\x1f\x7f]/u.test(scope)) {
    throw new TypeError('The OAuth scope must be scope URLs separated by spaces.');
  }
  const timeoutMs = input.timeoutMs ?? defaultTimeoutMs;
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('The token request timeout must be a positive number of milliseconds.');
  }
  const fetcher: FetchLike = input.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const now = input.now ?? Date.now;
  const subtle = input.subtle ?? globalThis.crypto.subtle;
  let signingKey: Promise<CryptoKey> | undefined;
  let cached: MintedToken | undefined;
  let failed: { readonly error: Error; readonly until: number } | undefined;
  let pending: PendingMint | undefined;

  const key = (): Promise<CryptoKey> => {
    signingKey ??= importPrivateKey(subtle, serviceAccount.privateKey, options.label).catch(
      (error: unknown) => {
        signingKey = undefined;
        throw error;
      },
    );
    return signingKey;
  };
  /** One token request: the bounded exchange of the assertion for a token. */
  const exchange = async (
    assertion: string,
    issuedAt: number,
    signal: AbortSignal,
  ): Promise<MintResult> => {
    let request: Promise<Response> | undefined;
    let response: Response;
    try {
      request = fetcher(googleTokenEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: jwtBearerGrantType, assertion }).toString(),
        // A followed redirect would send the assertion on; a 3xx fails below.
        redirect: 'manual',
        signal,
      });
      // Raced as well as signalled: an injected fetch may ignore the signal.
      response = await untilAborted(request, signal);
    } catch {
      // An answer that comes after the deadline is cancelled when it comes.
      void request
        ?.then((late) => late.body?.cancel(), () => undefined)
        .catch(() => undefined);
      // A timeout or a dropped connection. The error is not kept: it can quote the request.
      return mintFailure('TOKEN_NETWORK_ERROR', true);
    }
    if (response.redirected) {
      // A fetch that followed a redirect anyway: the answer is not Google's token endpoint's.
      void response.body?.cancel().catch(() => undefined);
      return mintFailure('TOKEN_REDIRECTED', false);
    }
    const body = await readBoundedJson(response, signal);
    if (!response.ok) {
      const error = body.status === 'ok' && typeof body.value.error === 'string'
        ? body.value.error
        : `HTTP_${response.status}`;
      const retryable = response.status === 429 || response.status >= 500;
      return mintFailure(
        `TOKEN_${providerCodeOf(error)}`,
        retryable,
        retryable ? retryAfterOf(response, now()) : undefined,
      );
    }
    if (body.status !== 'ok') {
      // A body that stalled is an outage like a request that did; anything else is not a token answer.
      return body.status === 'timed-out'
        ? mintFailure('TOKEN_NETWORK_ERROR', true)
        : mintFailure('TOKEN_MALFORMED_RESPONSE', true);
    }
    const token = body.value.access_token;
    const tokenType = body.value.token_type;
    if (
      !isBearerToken(token)
      || (tokenType !== undefined
        && (typeof tokenType !== 'string' || tokenType.toLowerCase() !== 'bearer'))
    ) {
      return mintFailure('TOKEN_MALFORMED_RESPONSE', true);
    }
    const expiresIn = body.value.expires_in;
    const lifetime = typeof expiresIn === 'number' && Number.isFinite(expiresIn) && expiresIn > 0
      ? Math.min(expiresIn, tokenLifetimeSeconds)
      : tokenLifetimeSeconds;
    const expiresAt = issuedAt * 1000 + lifetime * 1000;
    return { ok: true, minted: { token, refreshAt: expiresAt - tokenRefreshMarginMs, expiresAt } };
  };
  const mint = async (): Promise<MintResult> => {
    // A timer, not AbortSignal.timeout: the deadline also bounds a fetch that
    // ignores its signal, and the timer is cleared once the request settles.
    // It starts with the mint, so the request is given up when `start` says.
    const deadline = new AbortController();
    const timer = setTimeout(() => {
      deadline.abort();
    }, timerDelayOf(timeoutMs));
    try {
      const issuedAt = Math.floor(now() / 1000);
      let assertion: string;
      try {
        assertion = await signJwt(subtle, await key(), {
          header: {
            alg: 'RS256',
            typ: 'JWT',
            ...(serviceAccount.privateKeyId === undefined
              ? {}
              : { kid: serviceAccount.privateKeyId }),
          },
          claims: {
            iss: serviceAccount.clientEmail,
            scope,
            aud: googleTokenEndpoint,
            iat: issuedAt,
            exp: issuedAt + tokenLifetimeSeconds,
          },
        });
      } catch (error) {
        // A key that cannot sign is a configuration error, never retried as an
        // outage. The cause says which step failed; it never holds the key.
        return {
          ok: false,
          failure: { code: 'TOKEN_KEY_UNUSABLE', retryable: false, cause: error },
        };
      }
      if (deadline.signal.aborted) {
        // Signing took the whole timeout: no request is sent.
        return mintFailure('TOKEN_NETWORK_ERROR', true);
      }
      return await exchange(assertion, issuedAt, deadline.signal);
    } finally {
      clearTimeout(timer);
    }
  };
  const start = (): PendingMint => {
    const abandonAt = now() + timeoutMs + abandonedMintGraceMs;
    const token: Promise<string> = mint().then(
      (result) => {
        // A mint given up as abandoned no longer writes the cache.
        const current = pending?.token === token;
        if (current) {
          pending = undefined;
        }
        if (result.ok) {
          if (current) {
            cached = result.minted;
            failed = undefined;
          }
          return result.minted.token;
        }
        const error = options.errorOf(result.failure);
        if (current) {
          failed = { error, until: now() + failureCacheMs(result.failure) };
        }
        throw error;
      },
      (error: unknown) => {
        if (pending?.token === token) {
          pending = undefined;
        }
        throw error;
      },
    );
    return { token, abandonAt };
  };
  /**
   * The shared request's token for one caller, who stops waiting when its
   * signal aborts or when the request is past `abandonAt`. On Workers a
   * request whose context ended (its first caller gave up) never settles and
   * its own timer never runs; this caller's timer runs in this caller's
   * context, and drops the request so the next caller starts a new one.
   */
  const waitFor = (entry: PendingMint, signal: AbortSignal | undefined): Promise<string> =>
    new Promise<string>((resolve, reject) => {
      const stop = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      };
      const abort = (): void => {
        stop();
        reject(signal?.reason);
      };
      const timer = setTimeout(
        () => {
          stop();
          if (pending === entry) {
            pending = undefined;
          }
          reject(options.errorOf({ code: 'TOKEN_NETWORK_ERROR', retryable: true }));
        },
        timerDelayOf(entry.abandonAt - now()),
      );
      signal?.addEventListener('abort', abort, { once: true });
      entry.token.then(
        (token) => {
          stop();
          resolve(token);
        },
        (error: unknown) => {
          stop();
          reject(error);
        },
      );
    });

  return {
    async get(signal) {
      if (signal !== undefined && isAborted(signal)) {
        // A caller that already gave up starts no request, even with a token cached.
        throw signal.reason;
      }
      const at = now();
      if (cached !== undefined && at < cached.refreshAt) {
        return cached.token;
      }
      // Inside the refresh margin a token that has not expired still answers
      // while a refresh fails.
      const usable = cached !== undefined && at < cached.expiresAt ? cached.token : undefined;
      if (pending !== undefined && at >= pending.abandonAt) {
        // Past its timeout the request never settles: stop waiting on it.
        pending = undefined;
      }
      // A refresh already under way, or one that failed a moment ago, does not hold up a usable token.
      if (usable !== undefined && pending !== undefined) {
        return usable;
      }
      if (failed !== undefined && at < failed.until) {
        if (usable !== undefined) {
          return usable;
        }
        // A refused grant fails the same way for a while: a fan-out does not ask Google per caller.
        throw failed.error;
      }
      pending ??= start();
      // The caller's signal ends its own wait, never the shared request.
      const minted = waitFor(pending, signal);
      if (usable === undefined) {
        return minted;
      }
      try {
        return await minted;
      } catch (error) {
        if (signal !== undefined && isAborted(signal)) {
          throw error;
        }
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

/** The `Error` options of a failure: its cause, only when it has one. */
export function errorOptionsOf(
  failure: AccessTokenFailure,
): { readonly cause: unknown } | undefined {
  return failure.cause === undefined ? undefined : { cause: failure.cause };
}

/** `retryAfterSeconds` is passed only for an outage that asked for it. */
function mintFailure(code: string, retryable: boolean, retryAfterSeconds?: number): MintResult {
  return {
    ok: false,
    failure: {
      code,
      retryable,
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    },
  };
}

/** A refused grant waits 30 s; an outage waits a few seconds, or as long as it asked, up to a minute. */
function failureCacheMs(failure: AccessTokenFailure): number {
  return failure.retryable
    ? Math.max(
        retryableTokenCacheMs,
        Math.min((failure.retryAfterSeconds ?? 0) * 1000, maxRetryableTokenCacheMs),
      )
    : failedTokenCacheMs;
}

/** An RFC 6750 bearer token (`b64token`) short enough for a header. */
function isBearerToken(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= maxAccessTokenLength
    && /^[A-Za-z0-9\-._~+/]+=*$/u.test(value);
}

type BodyRead =
  | { readonly status: 'ok'; readonly value: Readonly<Record<string, unknown>> }
  | { readonly status: 'invalid' | 'timed-out' };

/**
 * The response's JSON object, read up to `maxTokenResponseBytes` and before
 * `signal` aborts. A body over the limit is cancelled. Nothing of the body
 * leaves this function but the parsed object: a JSON parse error quotes it,
 * and it can hold a token.
 */
async function readBoundedJson(response: Response, signal: AbortSignal): Promise<BodyRead> {
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    const stream = response.body;
    if (stream === null) {
      return { status: 'invalid' };
    }
    reader = stream.getReader();
  } catch {
    return { status: 'invalid' };
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await untilAborted(reader.read(), signal);
      if (next.done) {
        break;
      }
      size += next.value.byteLength;
      if (size > maxTokenResponseBytes) {
        void reader.cancel().catch(() => undefined);
        return { status: 'invalid' };
      }
      chunks.push(next.value);
    }
  } catch {
    void reader.cancel().catch(() => undefined);
    return { status: signal.aborted ? 'timed-out' : 'invalid' };
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return isRecord(parsed) ? { status: 'ok', value: parsed } : { status: 'invalid' };
  } catch {
    return { status: 'invalid' };
  }
}

/** Read through a call, so a check before an `await` does not narrow one after it. */
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

/** A timer delay: no less than zero, and no more than a timer takes. */
function timerDelayOf(ms: number): number {
  return Math.min(Math.max(ms, 0), maxTimerDelayMs);
}

/** `promise`, or the signal's reason as soon as it aborts, whichever comes first. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => undefined);
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      void promise.catch(() => undefined);
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

/** An upstream error string as a short provider code: upper case, `[A-Z0-9_]`, at most 64 characters. */
export function providerCodeOf(text: string): string {
  return text.toUpperCase().replace(/[^A-Z0-9_]+/gu, '_').slice(0, 64) || 'UNKNOWN';
}

/** `Retry-After` in seconds (a number or an HTTP date), at most a day. */
export function retryAfterOf(response: Response, now: number): number | undefined {
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

async function importPrivateKey(subtle: SubtleCrypto, pem: string, label: string): Promise<CryptoKey> {
  const body = pem
    .replace(/-----(?:BEGIN|END) PRIVATE KEY-----/gu, '')
    .replace(/\\n|\s/gu, '');
  let der: Uint8Array<ArrayBuffer>;
  try {
    der = Uint8Array.from(atob(body), (char) => char.charCodeAt(0));
  } catch {
    throw new TypeError(`The ${label} service account private key is not PKCS #8 PEM.`);
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
    throw new TypeError(`The ${label} service account private key could not be imported.`);
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

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
