import { guestIdentityHttpRoutes } from '@mpgd/game-services/guest-session';

import type { GameServicesAccountDeletionBinding } from '../../game-services-worker/src/accountDeletion.js';
import type {
  GameServicesIngressAuthBinding,
  GooglePlayAccountBinding,
} from '../../game-services-worker/src/handler.js';
import type { GameServicesNotificationsAuthBinding } from '../../game-services-worker/src/notificationsHandler.js';
import { createD1IdentityStore } from './d1Store.js';
import {
  createGuestIdentityService,
  defaultIdentityServiceConfig,
  IdentityConfigurationError,
  type GuestIdentityService,
  type IdentityRefusal,
  type IdentityServiceConfig,
} from './identityService.js';
import { createMemoryIdentityStore, type IdentityStore } from './store.js';

/** The game-services Worker's service-binding method this Worker calls when a session ends. */
export interface GameServicesNotificationSessionBinding {
  endNotificationSession(input: { readonly sessionId: string }): Promise<unknown>;
}

export interface GameIdentityWorkerEnv {
  /** `d1` for any deployment (bind `DB`); `memory` keeps sessions in one isolate, for local development only. */
  readonly MPGD_STORE?: 'memory' | 'd1';
  readonly DB?: D1Database;
  /** Access token lifetime in seconds (default 900). */
  readonly IDENTITY_ACCESS_TOKEN_TTL_SECONDS?: string;
  /** Days a session family lives without a refresh (default 180). */
  readonly IDENTITY_REFRESH_IDLE_DAYS?: string;
  /**
   * Seconds a replaced refresh token may be retried while its successor is
   * unused (default 604800, 7 days, but at most half the inactivity window;
   * 0 off). An explicit value must stay below the inactivity window.
   */
  readonly IDENTITY_REFRESH_RETRY_GRACE_SECONDS?: string;
  /** New guests per installation in a rolling day (default 5). */
  readonly IDENTITY_MAX_GUESTS_PER_INSTALLATION_PER_DAY?: string;
  /**
   * Optional Workers Rate Limiting binding for guest issuance and account
   * deletion confirmations, keyed by the client address (`CF-Connecting-IP`). Its counts are per Cloudflare
   * location and approximate. Recommended for any deployment: the
   * installation id is client-chosen, so the per-installation limit only
   * stops a misbehaving client.
   */
  readonly IDENTITY_ISSUE_RATE_LIMITER?: RateLimit;
  /**
   * The game-services Worker, to end a revoked family's notification
   * session at once (`endNotificationSession`). Optional: without it the
   * devices are unbound when the family's `expiresAt` passes.
   */
  readonly GAME_SERVICES?: GameServicesNotificationSessionBinding;
}

/** The isolate's memory store (`MPGD_STORE = "memory"`), shared by the HTTP routes and the entrypoints. */
let isolateMemoryStore: IdentityStore | undefined;

/** The identity service for `env`. Throws on a configuration it refuses. */
export function resolveIdentityService(
  env: GameIdentityWorkerEnv,
  overrides: { readonly store?: IdentityStore; readonly now?: () => number } = {},
): GuestIdentityService {
  return createGuestIdentityService({
    store: overrides.store ?? resolveStore(env),
    config: resolveConfig(env),
    ...(overrides.now === undefined ? {} : { now: overrides.now }),
    ...(env.GAME_SERVICES === undefined
      ? {}
      : {
          endNotificationSession: async (sessionId: string) => {
            const answer = await env.GAME_SERVICES?.endNotificationSession({ sessionId });
            // The game-services Worker answers notifications errors as `{ ok: false, error }`.
            if (typeof answer === 'object' && answer !== null && 'ok' in answer && answer.ok === false) {
              throw new Error('endNotificationSession answered an error');
            }
          },
        }),
  });
}

function resolveStore(env: GameIdentityWorkerEnv): IdentityStore {
  if (env.MPGD_STORE === 'd1') {
    if (env.DB === undefined) {
      throw new IdentityConfigurationError(
        'MPGD_STORE = "d1" needs the DB binding (migrations 0001_guest_identity.sql and 0002_account_deletion.sql applied).',
      );
    }
    return createD1IdentityStore(env.DB);
  }
  if (env.MPGD_STORE === 'memory') {
    isolateMemoryStore ??= createMemoryIdentityStore();
    return isolateMemoryStore;
  }
  throw new IdentityConfigurationError(
    'Set MPGD_STORE to "d1" (with the DB binding) or, for local development, "memory".',
  );
}

function resolveConfig(env: GameIdentityWorkerEnv): IdentityServiceConfig {
  const read = (value: string | undefined, name: string, unit: number, fallback: number) => {
    if (value === undefined || value.trim() === '') {
      return fallback;
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      throw new IdentityConfigurationError(`${name} must be a whole number.`);
    }
    return parsed * unit;
  };
  const refreshIdleMs = read(
    env.IDENTITY_REFRESH_IDLE_DAYS,
    'IDENTITY_REFRESH_IDLE_DAYS',
    24 * 60 * 60 * 1000,
    defaultIdentityServiceConfig.refreshIdleMs,
  );
  return {
    accessTokenTtlMs: read(
      env.IDENTITY_ACCESS_TOKEN_TTL_SECONDS,
      'IDENTITY_ACCESS_TOKEN_TTL_SECONDS',
      1000,
      defaultIdentityServiceConfig.accessTokenTtlMs,
    ),
    refreshIdleMs,
    refreshRetryGraceMs: read(
      env.IDENTITY_REFRESH_RETRY_GRACE_SECONDS,
      'IDENTITY_REFRESH_RETRY_GRACE_SECONDS',
      1000,
      // The default grace stays inside a short inactivity window.
      Math.min(defaultIdentityServiceConfig.refreshRetryGraceMs, Math.floor(refreshIdleMs / 2)),
    ),
    maxGuestsPerInstallationPerDay: read(
      env.IDENTITY_MAX_GUESTS_PER_INSTALLATION_PER_DAY,
      'IDENTITY_MAX_GUESTS_PER_INSTALLATION_PER_DAY',
      1,
      defaultIdentityServiceConfig.maxGuestsPerInstallationPerDay,
    ),
    // Fixed on purpose: the time between the second tap and the request, not a deployment choice.
    accountDeletionConfirmationTtlMs: defaultIdentityServiceConfig.accountDeletionConfirmationTtlMs,
  };
}

/** The largest request body a route reads. */
export const identityRequestBodyLimitBytes = 4096;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  // At most one preflight a day per route (browsers may cap it lower), not one per request.
  'Access-Control-Max-Age': '86400',
} as const;

const refusalStatus: Readonly<Record<IdentityRefusal | 'UNAVAILABLE', number>> = {
  INVALID_REQUEST: 400,
  GUEST_SESSION_REJECTED: 401,
  RATE_LIMITED: 429,
  ACCOUNT_BINDING_UNSUPPORTED: 501,
  UNAVAILABLE: 503,
};

/**
 * The HTTP routes of `guestIdentityHttpRoutes`. Token answers carry
 * `Cache-Control: no-store` (RFC 6749 section 5.1). A refusal is
 * `{ error }`; a store or configuration failure is `503 UNAVAILABLE`, logged
 * by error name only (never a token), and a configuration error with the
 * setting its message names.
 */
export function createIdentityFetchHandler(
  env: GameIdentityWorkerEnv,
  overrides: { readonly store?: IdentityStore; readonly now?: () => number } = {},
): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    const path = url.pathname;
    const route = Object.entries(guestIdentityHttpRoutes).find(
      ([, routePath]) => routePath === path,
    )?.[0];
    if (route === undefined) {
      return json({ error: 'UNKNOWN_ENDPOINT' }, 404);
    }
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }
    if (request.method !== 'POST') {
      return json({ error: 'METHOD_NOT_ALLOWED' }, 405, { Allow: 'POST, OPTIONS' });
    }
    const body = await readJsonBody(request);
    if (body === undefined) {
      return json({ error: 'INVALID_REQUEST' }, 400);
    }
    // The memory store keeps sessions in one isolate: a deployment left on it
    // would lose its guests at every isolate restart, so it serves local hosts only.
    if (env.MPGD_STORE === 'memory' && overrides.store === undefined && !isLocalDevelopmentHost(url.hostname)) {
      console.error(
        '[identity] MPGD_STORE = "memory" serves local development hosts only (loopback, *.localhost, '
          + '10.0.2.2); a device on the LAN or a deployment needs MPGD_STORE = "d1".',
      );
      return json({ error: 'UNAVAILABLE' }, 503);
    }
    try {
      const service = resolveIdentityService(env, overrides);
      switch (route) {
        case 'issueGuest': {
          const address = request.headers.get('CF-Connecting-IP');
          if (env.IDENTITY_ISSUE_RATE_LIMITER !== undefined && address !== null
            && !(await env.IDENTITY_ISSUE_RATE_LIMITER.limit({ key: `guest:${address}` })).success) {
            return json({ error: 'RATE_LIMITED' }, 429);
          }
          return answer(await service.issueGuest({ installationId: body.installationId }));
        }
        case 'refresh':
          return answer(await service.refresh({ refreshToken: body.refreshToken }));
        case 'revoke':
          await service.revoke({ refreshToken: body.refreshToken });
          return json({}, 200);
        case 'bindAccount':
          return answer(await service.bindAccount(body));
        case 'requestAccountDeletionConfirmation': {
          // Each answer is a D1 write: the same address limiter as guest issuance.
          const address = request.headers.get('CF-Connecting-IP');
          if (env.IDENTITY_ISSUE_RATE_LIMITER !== undefined && address !== null
            && !(await env.IDENTITY_ISSUE_RATE_LIMITER.limit({ key: `deletion-confirmation:${address}` })).success) {
            return json({ error: 'RATE_LIMITED' }, 429);
          }
          return answer(
            await service.issueAccountDeletionConfirmation({ refreshToken: body.refreshToken }),
          );
        }
        default:
          // A route added to the shared contract that this Worker does not serve yet.
          return json({ error: 'UNKNOWN_ENDPOINT' }, 404);
      }
    } catch (error) {
      // A configuration error's message names the setting; any other error is
      // logged by name only, since a store error could quote a statement.
      console.error('[identity] request failed:', describeFailure(error));
      return json({ error: 'UNAVAILABLE' }, 503);
    }
  };
}

/** A configuration error with its message (it names the setting); anything else by name only. */
function describeFailure(error: unknown): string {
  if (error instanceof IdentityConfigurationError) {
    return `${error.name}: ${error.message}`;
  }
  return error instanceof Error ? error.name : 'unknown error';
}

/** Loopback, `*.localhost`, and `10.0.2.2` (the Android emulator's host), as the game-services Worker reads them. */
export function isLocalDevelopmentHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'localhost'
    || host.endsWith('.localhost')
    || host === '127.0.0.1'
    || host === '[::1]'
    || host === '10.0.2.2';
}

function answer(
  result: { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: IdentityRefusal },
): Response {
  return result.ok
    ? json(result.value, 200)
    : json({ error: result.error }, refusalStatus[result.error]);
}

async function readJsonBody(request: Request): Promise<Readonly<Record<string, unknown>> | undefined> {
  const declared = Number(request.headers.get('Content-Length') ?? '0');
  if (declared > identityRequestBodyLimitBytes || request.body === null) {
    return undefined;
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    size += value.byteLength;
    if (size > identityRequestBodyLimitBytes) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Readonly<Record<string, unknown>>
      : undefined;
  } catch {
    return undefined;
  }
}

function json(body: unknown, status: number, extraHeaders: Readonly<Record<string, string>> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      ...extraHeaders,
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

/**
 * The service-binding methods the game-services Worker calls, as plain
 * objects (the entrypoint classes in `index.ts` delegate to them). `null`
 * means "no principal" or "unknown player"; the game-services Worker answers
 * 401 or refuses the purchase binding then.
 */
export function createIdentityBindings(service: GuestIdentityService): {
  readonly ingressAuth: GameServicesIngressAuthBinding;
  readonly notificationSessions: GameServicesNotificationsAuthBinding;
  readonly googlePlayAccountBinding: Required<Pick<GooglePlayAccountBinding, 'resolveObfuscatedAccountId'>>;
  readonly appStoreAccountBinding: {
    resolveAppAccountToken(input: { readonly playerId: string }): Promise<string | null>;
  };
  readonly accountDeletion: GameServicesAccountDeletionBinding;
} {
  return {
    ingressAuth: {
      async authenticateGameServicesRequest({ authorization }) {
        const principal = await service.authenticate(authorization);
        return principal === undefined ? null : { playerId: principal.playerId };
      },
    },
    notificationSessions: {
      async authenticateNotificationSession({ authorization }) {
        return await service.authenticate(authorization) ?? null;
      },
    },
    googlePlayAccountBinding: {
      async resolveObfuscatedAccountId({ playerId }) {
        return await service.resolveObfuscatedAccountId(playerId) ?? null;
      },
    },
    appStoreAccountBinding: {
      async resolveAppAccountToken({ playerId }) {
        return await service.resolveAppAccountToken(playerId) ?? null;
      },
    },
    accountDeletion: {
      async deletePlayer({ playerId }) {
        await service.deletePlayer({ playerId });
        return {};
      },
      async verifyAccountDeletionConfirmation({ playerId, confirmation }) {
        return service.verifyAccountDeletionConfirmation({ playerId, confirmation });
      },
    },
  };
}
