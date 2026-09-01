import type { MicrosoftStoreCollectionsCredentials } from './microsoft-store-purchase';

export const microsoftStoreIdentityCredentialsSchema =
  'mpgd.microsoft-store.identity-credentials.v1' as const;
export const microsoftStoreIdentityCredentialsRequestUrl =
  'https://microsoft-store-authority.internal/v1/credentials' as const;

const defaultTimeoutMs = 8_000;
const maximumResponseBytes = 16 * 1_024;
const gameIdPattern = /^[a-z0-9][a-z0-9-]{0,63}$/u;

export interface MicrosoftStoreIdentityCredentialsRequest {
  readonly schema: typeof microsoftStoreIdentityCredentialsSchema;
  readonly gameId: string;
  readonly playerId: string;
}

export interface MicrosoftStoreIdentityCredentialsResponse
  extends MicrosoftStoreCollectionsCredentials {
  readonly schema: typeof microsoftStoreIdentityCredentialsSchema;
  readonly gameId: string;
  readonly playerId: string;
}

export interface MicrosoftStoreIdentityAuthorityFetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export class MicrosoftStoreIdentityAuthorityError extends Error {
  override readonly name = 'MicrosoftStoreIdentityAuthorityError';

  constructor(
    readonly code:
      | 'MICROSOFT_STORE_ACCOUNT_LINK_REQUIRED'
      | 'MICROSOFT_STORE_IDENTITY_RESPONSE_INVALID'
      | 'MICROSOFT_STORE_IDENTITY_UNAVAILABLE',
    options?: ErrorOptions,
  ) {
    super(code, options);
  }
}

export function parseMicrosoftStoreIdentityCredentialsRequest(
  value: unknown,
): MicrosoftStoreIdentityCredentialsRequest {
  const record = requireExactRecord(value, ['schema', 'gameId', 'playerId']);
  if (record.schema !== microsoftStoreIdentityCredentialsSchema) {
    throw new TypeError('Microsoft Store identity request schema is invalid.');
  }
  return Object.freeze({
    schema: microsoftStoreIdentityCredentialsSchema,
    gameId: requireGameId(record.gameId),
    playerId: requireText(record.playerId, 'playerId', 256),
  });
}

export function createMicrosoftStoreIdentityCredentialsResponse(input: {
  readonly request: MicrosoftStoreIdentityCredentialsRequest;
  readonly credentials: MicrosoftStoreCollectionsCredentials;
}): MicrosoftStoreIdentityCredentialsResponse {
  const request = parseMicrosoftStoreIdentityCredentialsRequest(input.request);
  return parseMicrosoftStoreIdentityCredentialsResponse({
    schema: microsoftStoreIdentityCredentialsSchema,
    gameId: request.gameId,
    playerId: request.playerId,
    accessToken: input.credentials.accessToken,
    userStoreId: input.credentials.userStoreId,
    accountBindingId: input.credentials.accountBindingId,
    ...(input.credentials.sandbox === undefined
      ? {}
      : { sandbox: input.credentials.sandbox }),
  }, request);
}

export function parseMicrosoftStoreIdentityCredentialsResponse(
  value: unknown,
  expectedRequest?: MicrosoftStoreIdentityCredentialsRequest,
): MicrosoftStoreIdentityCredentialsResponse {
  const record = requireExactRecord(
    value,
    ['schema', 'gameId', 'playerId', 'accessToken', 'userStoreId', 'accountBindingId'],
    ['sandbox'],
  );
  if (record.schema !== microsoftStoreIdentityCredentialsSchema) {
    throw new TypeError('Microsoft Store identity response schema is invalid.');
  }
  const response = Object.freeze({
    schema: microsoftStoreIdentityCredentialsSchema,
    gameId: requireGameId(record.gameId),
    playerId: requireText(record.playerId, 'response playerId', 256),
    accessToken: requireToken(record.accessToken, 'Microsoft Store access token', 4_096),
    userStoreId: requireToken(record.userStoreId, 'Microsoft Store User Store ID', 4_096),
    accountBindingId: requireText(
      record.accountBindingId,
      'Microsoft Store account binding ID',
      512,
    ),
    ...(record.sandbox === undefined
      ? {}
      : { sandbox: requireText(record.sandbox, 'Microsoft Store sandbox', 256) }),
  });
  if (
    expectedRequest !== undefined
    && (
      response.gameId !== expectedRequest.gameId
      || response.playerId !== expectedRequest.playerId
    )
  ) {
    throw new TypeError('Microsoft Store identity response scope does not match the request.');
  }
  return response;
}

/**
 * Resolves short-lived Store credentials over a private service binding. The authority request is
 * scoped by both game and player so a shared provider Worker cannot accidentally reuse one game's
 * account link for another game. The returned credentials must never be exposed to a browser.
 */
export async function resolveMicrosoftStoreIdentityCredentials(input: {
  readonly authority: MicrosoftStoreIdentityAuthorityFetcher;
  readonly gameId: string;
  readonly playerId: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}): Promise<MicrosoftStoreIdentityCredentialsResponse> {
  const request = parseMicrosoftStoreIdentityCredentialsRequest({
    schema: microsoftStoreIdentityCredentialsSchema,
    gameId: input.gameId,
    playerId: input.playerId,
  });
  const timeoutMs = input.timeoutMs ?? defaultTimeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 25_000) {
    throw new TypeError('Microsoft Store identity timeout is invalid.');
  }
  const abort = createAbortScope(input.signal, timeoutMs);
  try {
    let response: Response;
    try {
      response = await input.authority.fetch(microsoftStoreIdentityCredentialsRequestUrl, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(request),
        signal: abort.signal,
      });
    } catch (cause) {
      if (isAbortCause(abort.signal, cause)) {
        throw abort.signal.reason;
      }
      throw unavailable(cause);
    }

    if (!response.ok) {
      await discardResponseBody(response, abort.signal);
      const accountLinkRequired = response.status === 404 || response.status === 409;
      const code = accountLinkRequired
        ? 'MICROSOFT_STORE_ACCOUNT_LINK_REQUIRED'
        : 'MICROSOFT_STORE_IDENTITY_UNAVAILABLE';
      const options = accountLinkRequired
        ? undefined
        : { cause: authorityHttpStatusError(response.status) };
      throw new MicrosoftStoreIdentityAuthorityError(code, options);
    }

    try {
      return parseMicrosoftStoreIdentityCredentialsResponse(
        await readBoundedJson(response, maximumResponseBytes, abort.signal),
        request,
      );
    } catch (cause) {
      if (cause instanceof MicrosoftStoreIdentityAuthorityError) {
        throw cause;
      }
      if (isAbortCause(abort.signal, cause)) {
        throw abort.signal.reason;
      }
      throw invalidResponse(cause);
    }
  } finally {
    abort.cleanup();
  }
}

function requireExactRecord(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Microsoft Store identity payload must be an object.');
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  if (
    requiredKeys.some((key) => !Object.hasOwn(record, key))
    || Object.keys(record).some((key) => !allowed.has(key))
  ) {
    throw new TypeError('Microsoft Store identity payload shape is invalid.');
  }
  return record;
}

function requireGameId(value: unknown): string {
  if (typeof value !== 'string' || !gameIdPattern.test(value)) {
    throw new TypeError('Microsoft Store identity gameId is invalid.');
  }
  return value;
}

function requireText(value: unknown, label: string, maximumLength: number): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > maximumLength
    || value.trim() !== value
    || /[\p{Cc}\p{Cf}]/u.test(value)
    || !isWellFormedUnicode(value)
  ) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}

function requireToken(value: unknown, label: string, maximumLength: number): string {
  const token = requireText(value, label, maximumLength);
  if (/\s/u.test(token)) {
    throw new TypeError(`${label} is invalid.`);
  }
  return token;
}

function isWellFormedUnicode(input: string): boolean {
  for (let index = 0; index < input.length; index += 1) {
    const codeUnit = input.charCodeAt(index);

    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = input.charCodeAt(index + 1);

      if (
        index + 1 >= input.length
        || nextCodeUnit < 0xdc00
        || nextCodeUnit > 0xdfff
      ) {
        return false;
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }

  return true;
}

function createAbortScope(
  upstream: AbortSignal | undefined,
  timeoutMs: number,
): Readonly<{ signal: AbortSignal; cleanup(): void }> {
  const controller = new AbortController();
  const onAbort = () => controller.abort(upstream?.reason);
  if (upstream?.aborted === true) {
    onAbort();
  } else {
    upstream?.addEventListener('abort', onAbort, { once: true });
  }
  const timeout = setTimeout(
    () => controller.abort(new Error('Microsoft Store identity request timed out.')),
    timeoutMs,
  );
  return Object.freeze({
    signal: controller.signal,
    cleanup() {
      clearTimeout(timeout);
      upstream?.removeEventListener('abort', onAbort);
    },
  });
}

async function readBoundedJson(
  response: Response,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<unknown> {
  const contentLengthHeader = response.headers.get('content-length');
  if (contentLengthHeader !== null) {
    if (!/^\d+$/u.test(contentLengthHeader)) {
      await discardResponseBody(response, signal);
      throw new TypeError('Microsoft Store identity response content length is invalid.');
    }
    const contentLength = Number(contentLengthHeader);
    if (!Number.isSafeInteger(contentLength)) {
      await discardResponseBody(response, signal);
      throw new TypeError('Microsoft Store identity response content length is invalid.');
    }
    if (contentLength > maximumBytes) {
      await discardResponseBody(response, signal);
      throw new TypeError('Microsoft Store identity response is too large.');
    }
  }
  if (response.body === null) {
    throw new TypeError('Microsoft Store identity response body is missing.');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      if (signal.aborted) {
        throw signal.reason;
      }
      const result = await reader.read();
      if (result.done) {
        break;
      }
      if (!(result.value instanceof Uint8Array)) {
        throw new TypeError('Microsoft Store identity response chunk is invalid.');
      }
      total += result.value.byteLength;
      if (total > maximumBytes) {
        throw new TypeError('Microsoft Store identity response is too large.');
      }
      chunks.push(result.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
}

function unavailable(cause?: unknown): MicrosoftStoreIdentityAuthorityError {
  return new MicrosoftStoreIdentityAuthorityError(
    'MICROSOFT_STORE_IDENTITY_UNAVAILABLE',
    cause === undefined ? undefined : { cause },
  );
}

function invalidResponse(cause?: unknown): MicrosoftStoreIdentityAuthorityError {
  return new MicrosoftStoreIdentityAuthorityError(
    'MICROSOFT_STORE_IDENTITY_RESPONSE_INVALID',
    cause === undefined ? undefined : { cause },
  );
}

function authorityHttpStatusError(status: number): Error {
  return new Error(`Microsoft Store identity authority returned HTTP ${String(status)}.`);
}

async function discardResponseBody(response: Response, signal: AbortSignal): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
  if (signal.aborted) {
    throw signal.reason;
  }
}

function isAbortCause(signal: AbortSignal, cause: unknown): boolean {
  return signal.aborted
    && (
      cause === signal.reason
      || (cause instanceof Error && cause.name === 'AbortError')
    );
}
