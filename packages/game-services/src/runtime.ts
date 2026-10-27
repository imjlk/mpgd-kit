import { createAccountDeletionClient, type AccountDeletionClient } from './account-deletion.js';
import type { AnalyticsSink } from '@mpgd/analytics';
import type { PlatformGateway, PlatformTarget } from '@mpgd/platform';

import {
  assertCommerceStaleLaunchedAfterMs,
  createGameServicesClient,
  createGameServicesFetchBackendTransport,
  createGameServicesHttpBackendApi,
  createGameServicesOrpcBackendApi,
  createGameServicesOrpcClient,
  resolveGameServicesRequestHeaders,
  type GameServicesBackendApi,
  type GameServicesBackendTransport,
  type GameServicesClient,
  type GameServicesHeaderResolver,
} from './client.js';
import type { GameServicesLedgerTarget } from './types.js';
import type { ClientRewardEvidenceRegistry } from './client-reward-evidence.js';
import type { CommerceReconcilerProduct } from './commerce-reconciler.js';
import {
  createRecoverableMonetizationClient,
  type MonetizationOperationStore,
  type RecoverableMonetizationClient,
} from './monetization-recovery.js';

export type GameServicesAuthorityMode = 'production' | 'non-production';
export type GameServicesRuntimeMode = 'disabled' | 'local' | 'http' | 'orpc';
export type GameServicesDisabledReason =
  | 'unsupported_target'
  | 'missing_authoritative_backend'
  | 'invalid_authoritative_backend'
  | 'local_backend_not_allowed'
  | 'local_backend_unavailable';

export interface GameServicesRuntime {
  readonly mode: GameServicesRuntimeMode;
  readonly reason?: GameServicesDisabledReason;
  readonly baseUrl?: string;
  readonly target?: GameServicesLedgerTarget;
  readonly client?: GameServicesClient;
  readonly monetizationRecovery?: RecoverableMonetizationClient;
  /**
   * The signed-in player's account deletion (`POST /game-services/account/delete`)
   * with the runtime's headers; present with an authoritative `baseUrl`.
   */
  readonly accountDeletion?: AccountDeletionClient;
}

interface CreateGameServicesRuntimeCommonInput {
  readonly gateway: PlatformGateway;
  readonly playerId: string;
  readonly authorityMode: GameServicesAuthorityMode;
  readonly target?: PlatformTarget | string;
  readonly deploymentTarget?: string;
  readonly baseUrl?: string;
  /** Static headers sent with every authoritative game-services request. */
  readonly headers?: Record<string, string>;
  /** Resolve rotating credentials at request time, not runtime creation time. */
  readonly getHeaders?: GameServicesHeaderResolver;
  readonly allowLocalBackend?: boolean;
  readonly localBackend?: GameServicesBackendApi;
  readonly analytics?: AnalyticsSink;
  readonly analyticsSessionId?: string;
  readonly now?: () => string;
  /** Durable, compare-and-swap journal for purchase and rewarded-ad recovery. */
  readonly operationStore?: MonetizationOperationStore;
  readonly rewardEvidenceRegistry?: ClientRewardEvidenceRegistry;
  /**
   * Catalog kinds and store SKUs the commerce v2 reconciler resolves without a
   * store read (`CommerceReconcilerProduct`), for example derived from the
   * product catalog's `platformProductIds` for the gateway target.
   */
  readonly commerceProducts?: readonly CommerceReconcilerProduct[];
  /**
   * The reconciler's `staleLaunchedAfterMs`: how long a `launched` purchase
   * with no store purchase keeps serializing its product before it ends
   * `failed`. Defaults to 24 hours; `Infinity` never expires it.
   */
  readonly commerceStaleLaunchedAfterMs?: number;
}

export type CreateGameServicesRuntimeInput = CreateGameServicesRuntimeCommonInput & (
  | {
      readonly transport?: 'http';
      /** A JSON endpoint transport, not a replacement for the Fetch API. */
      readonly httpTransport?: GameServicesBackendTransport;
    }
  | {
      readonly transport: 'orpc';
      readonly httpTransport?: never;
    }
);

export function createGameServicesRuntime(
  input: CreateGameServicesRuntimeInput,
): GameServicesRuntime {
  assertAuthorityMode(input.authorityMode);
  assertTransport(input.transport);
  assertCommerceStaleLaunchedAfterMs(input.commerceStaleLaunchedAfterMs);
  if (input.transport === 'orpc' && input.httpTransport !== undefined) {
    throw new Error('Game Services httpTransport cannot be used with oRPC.');
  }

  const target = resolveGameServicesLedgerTarget(input.target ?? input.gateway.target);

  if (target === null) {
    return disabledRuntime('unsupported_target');
  }

  const baseUrl = normalizeBaseUrl(input.baseUrl);
  if (input.httpTransport !== undefined && baseUrl === undefined) {
    throw new Error('Game Services httpTransport requires an authoritative baseUrl.');
  }
  let backend: GameServicesBackendApi;
  let mode: Exclude<GameServicesRuntimeMode, 'disabled'>;

  if (baseUrl !== undefined) {
    const url = parseAbsoluteUrl(baseUrl);

    if (input.authorityMode === 'production' && !isPublicHttpsUrl(url)) {
      return disabledRuntime('invalid_authoritative_backend', target);
    }

    if (url === undefined) {
      throw new Error('Game Services baseUrl must be a valid absolute URL.');
    }

    mode = input.transport === 'orpc' ? 'orpc' : 'http';
    backend = mode === 'orpc'
      ? createGameServicesOrpcBackendApi(createGameServicesOrpcClient({
          url: baseUrl,
          ...(input.headers === undefined ? {} : { headers: input.headers }),
          ...(input.getHeaders === undefined ? {} : { getHeaders: input.getHeaders }),
        }))
      : createGameServicesHttpBackendApi({
          transport: withRuntimeHeaders(
            input.httpTransport ?? createGameServicesFetchBackendTransport({ baseUrl }),
            input,
          ),
        });
  } else {
    if (input.authorityMode === 'production') {
      return disabledRuntime('missing_authoritative_backend', target);
    }

    if (input.allowLocalBackend !== true) {
      return disabledRuntime('local_backend_not_allowed', target);
    }

    if (input.localBackend === undefined) {
      return disabledRuntime('local_backend_unavailable', target);
    }

    mode = 'local';
    backend = input.localBackend;
  }

  const clientInput = {
    gateway: input.gateway,
    backend,
    playerId: input.playerId,
    target,
    ...(input.deploymentTarget === undefined
      ? {}
      : { deploymentTarget: input.deploymentTarget }),
    ...(input.analytics === undefined ? {} : { analytics: input.analytics }),
    ...(input.analyticsSessionId === undefined
      ? {}
      : { analyticsSessionId: input.analyticsSessionId }),
    ...(input.now === undefined ? {} : { now: input.now }),
    ...(input.rewardEvidenceRegistry === undefined ? {} : { rewardEvidenceRegistry: input.rewardEvidenceRegistry }),
    ...(input.commerceProducts === undefined ? {} : { commerceProducts: input.commerceProducts }),
    ...(input.commerceStaleLaunchedAfterMs === undefined
      ? {}
      : { commerceStaleLaunchedAfterMs: input.commerceStaleLaunchedAfterMs }),
  };
  const monetizationRecovery = input.operationStore === undefined
    ? undefined
    : createRecoverableMonetizationClient({ ...clientInput, operationStore: input.operationStore });
  // The recovery client owns the reconciler over the durable journal; the
  // plain client shares it instead of journaling in memory.
  const client = createGameServicesClient({
    ...clientInput,
    ...(monetizationRecovery?.commerceReconciler === undefined
      ? {}
      : { commerceReconciler: monetizationRecovery.commerceReconciler }),
  });
  let routedClient = client;
  if (monetizationRecovery !== undefined) {
    routedClient = {
      ...client,
      purchase: monetizationRecovery.purchase,
      claimRewardedAd: monetizationRecovery.claimRewardedAd,
      // The recovery client owns the reconciler over the durable journal.
      ...(monetizationRecovery.commerceReconciler === undefined
        ? {}
        : { commerceReconciler: monetizationRecovery.commerceReconciler }),
    };
  }
  return {
    mode,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    target,
    client: routedClient,
    ...(monetizationRecovery === undefined ? {} : { monetizationRecovery }),
    ...(baseUrl === undefined
      ? {}
      : {
          accountDeletion: createAccountDeletionClient({
            // The deletion route is plain HTTP next to the oRPC handler: an
            // oRPC URL names the handler's `/rpc` prefix, which the route
            // does not sit under.
            baseUrl: input.transport === 'orpc' ? baseUrl.replace(/\/rpc\/?$/u, '') : baseUrl,
            ...(input.headers === undefined ? {} : { headers: input.headers }),
            ...(input.getHeaders === undefined ? {} : { getHeaders: input.getHeaders }),
          }),
        }),
  };
}

function withRuntimeHeaders(
  transport: GameServicesBackendTransport,
  input: CreateGameServicesRuntimeCommonInput,
): GameServicesBackendTransport {
  return {
    async send(request) {
      const headers = await resolveGameServicesRequestHeaders({
        headers: input.headers,
        getHeaders: input.getHeaders,
        requestHeaders: request.headers,
      });
      return transport.send({
        ...request,
        headers,
      });
    },
  };
}

export function resolveGameServicesLedgerTarget(
  target: PlatformTarget | string,
): GameServicesLedgerTarget | null {
  if (
    target === 'browser'
    || target === 'microsoft-store'
    || target === 'android'
    || target === 'ios'
    || target === 'ait'
    || target === 'reddit'
    || target === 'verse8'
    || target === 'oneplay'
  ) {
    return target;
  }

  return null;
}

export function resolveGameServicesAuthorityMode(profile: string): GameServicesAuthorityMode {
  if (profile.length === 0 || profile.trim() !== profile) {
    throw new Error('Game Services profile must be non-empty without surrounding whitespace.');
  }

  return profile === 'production' ? 'production' : 'non-production';
}

export function resolveGameServicesTransport(
  transport: string | undefined,
): 'http' | 'orpc' {
  if (transport === undefined || transport.length === 0 || transport === 'http') {
    return 'http';
  }

  if (transport === 'orpc') {
    return 'orpc';
  }

  throw new Error('Game Services transport must be http or orpc.');
}

function disabledRuntime(
  reason: GameServicesDisabledReason,
  target?: GameServicesLedgerTarget,
): GameServicesRuntime {
  return {
    mode: 'disabled',
    reason,
    ...(target === undefined ? {} : { target }),
  };
}

function normalizeBaseUrl(baseUrl: string | undefined): string | undefined {
  const normalized = baseUrl?.trim();

  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}

/**
 * Whether a game-services URL may carry a session's credentials in a
 * production build: an absolute https URL with no credentials and a public
 * host, the rule the authoritative commerce backend follows. The
 * notifications client's starter wiring uses it too.
 */
export function isPublicGameServicesUrl(baseUrl: string): boolean {
  return isPublicHttpsUrl(parseAbsoluteUrl(baseUrl.trim()));
}

function isPublicHttpsUrl(url: URL | undefined): boolean {
  return url !== undefined
    && url.protocol === 'https:'
    && url.username.length === 0
    && url.password.length === 0
    && !isNonPublicHostname(url.hostname);
}

function parseAbsoluteUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function isNonPublicHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/u, '');

  if (
    normalized === 'localhost'
    || normalized.endsWith('.localhost')
    || normalized.endsWith('.local')
  ) {
    return true;
  }

  if (/^(?:\d{1,3}\.){3}\d{1,3}$/u.test(normalized)) {
    return isNonPublicIpv4(normalized);
  }

  return normalized.includes(':') && isNonPublicIpv6(normalized);
}

function isNonPublicIpv4(address: string): boolean {
  const [first = 0, second = 0, third = 0] = address.split('.').map(Number);

  return first === 0
    || first === 10
    || first === 127
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 0 && third === 0)
    || (first === 192 && second === 0 && third === 2)
    || (first === 192 && second === 168)
    || (first === 198 && (second === 18 || second === 19))
    || (first === 198 && second === 51 && third === 100)
    || (first === 203 && second === 0 && third === 113)
    || first >= 224;
}

function isNonPublicIpv6(address: string): boolean {
  const words = expandIpv6(address);

  if (words === undefined) {
    return true;
  }

  if (words.slice(0, 7).every((word) => word === 0)) {
    return true;
  }

  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
    return isNonPublicIpv4(wordsToIpv4(words));
  }

  if (words.slice(0, 6).every((word) => word === 0)) {
    return isNonPublicIpv4(wordsToIpv4(words));
  }

  const first = words[0] ?? 0;

  return (first & 0xfe00) === 0xfc00
    || (first & 0xffc0) === 0xfe80
    || (first & 0xff00) === 0xff00
    || (first === 0x2001 && words[1] === 0x0db8);
}

function wordsToIpv4(words: readonly number[]): string {
  return `${(words[6] ?? 0) >> 8}.${(words[6] ?? 0) & 0xff}.`
    + `${(words[7] ?? 0) >> 8}.${(words[7] ?? 0) & 0xff}`;
}

function expandIpv6(address: string): readonly number[] | undefined {
  const sections = address.split('::');

  if (sections.length > 2) {
    return undefined;
  }

  const head = ipv6Words(sections[0] ?? '');
  const tail = ipv6Words(sections[1] ?? '');

  if (head === undefined || tail === undefined) {
    return undefined;
  }

  const omitted = 8 - head.length - tail.length;

  if ((sections.length === 1 && omitted !== 0) || (sections.length === 2 && omitted < 1)) {
    return undefined;
  }

  return [...head, ...Array.from({ length: omitted }, () => 0), ...tail];
}

function ipv6Words(section: string): readonly number[] | undefined {
  if (section.length === 0) {
    return [];
  }

  const words: number[] = [];

  for (const segment of section.split(':')) {
    if (!/^[0-9a-f]{1,4}$/u.test(segment)) {
      return undefined;
    }

    words.push(Number.parseInt(segment, 16));
  }

  return words;
}

function assertAuthorityMode(
  authorityMode: GameServicesAuthorityMode,
): asserts authorityMode is GameServicesAuthorityMode {
  if (authorityMode !== 'production' && authorityMode !== 'non-production') {
    throw new Error('authorityMode must be production or non-production.');
  }
}

function assertTransport(
  transport: CreateGameServicesRuntimeInput['transport'],
): void {
  if (transport !== undefined && transport !== 'http' && transport !== 'orpc') {
    throw new Error('Game Services transport must be http or orpc.');
  }
}
