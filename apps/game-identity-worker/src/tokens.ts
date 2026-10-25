/**
 * Opaque bearer tokens and identifiers. A token is 256 random bits, prefixed
 * so a leaked one is recognizable (`mpgd_at_` access, `mpgd_rt_` refresh,
 * `mpgd_dc_` account deletion confirmation);
 * only its SHA-256 is stored. A slow password hash would add nothing: the
 * token's entropy, not a secret salt, is what makes a stored hash useless to
 * whoever reads the database.
 */
export const accessTokenPrefix = 'mpgd_at_';
export const refreshTokenPrefix = 'mpgd_rt_';
export const deletionConfirmationPrefix = 'mpgd_dc_';

/** A new opaque token with `prefix`. */
export function createOpaqueToken(prefix: string): string {
  return `${prefix}${base64Url(randomBytes(32))}`;
}

/** A new rotation nonce: 256 random bits, base64url. */
export function createRotationNonce(): string {
  return base64Url(randomBytes(32));
}

/**
 * The refresh token that replaces `previous` under `nonce`: SHA-256 of the
 * nonce and the previous token, base64url, with the refresh prefix. A retry
 * of `previous` derives the same successor again, so rotation is idempotent;
 * without the nonce (stored with the family, never sent) the previous token
 * alone predicts nothing.
 */
export async function deriveRefreshToken(previous: string, nonce: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${nonce}:${previous}`),
  );
  return `${refreshTokenPrefix}${base64Url(new Uint8Array(digest))}`;
}

/** A new identifier: `prefix` and 128 random bits in hex. */
export function createIdentifier(prefix: string): string {
  return `${prefix}${hex(randomBytes(16))}`;
}

/** The stored form of a token: lowercase hex SHA-256 of its UTF-8 text. */
export async function hashToken(token: string): Promise<string> {
  return hex(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))),
  );
}

/** Whether `value` has the shape of a token this service issues with `prefix`. */
export function isOpaqueToken(value: unknown, prefix: string): value is string {
  return typeof value === 'string'
    && value.startsWith(prefix)
    && /^[A-Za-z0-9_-]{43}$/u.test(value.slice(prefix.length));
}

/**
 * The bearer token of an `Authorization` header (`Bearer <token>`, the
 * scheme case-insensitive per RFC 9110 section 11.1), or `undefined`.
 */
export function readBearerToken(authorization: unknown): string | undefined {
  if (typeof authorization !== 'string') {
    return undefined;
  }
  const match = /^Bearer +([^\s]+)\s*$/iu.exec(authorization);
  return match?.[1];
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

export function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}
