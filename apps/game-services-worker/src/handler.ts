import type { AdPlacements } from '@mpgd/catalog';
import {
  createAdRewardEvidenceVerifierRegistry,
  createAppsInTossCommerceEvidenceEntry,
  createAppStoreCommerceEvidenceEntry,
  createCommerceEvidenceRegistry,
  createDevelopmentGameServicesEvidenceVerifier,
  createDevvitOrderLookupCommerceEvidenceEntry,
  createDevvitPaymentOrderCommerceEvidenceEntry,
  createGameServicesBackend,
  createGameServicesBackendApiHandler,
  createGameServicesHttpFetchHandler,
  createGameServicesRouter,
  createGameServicesRpcFetchHandler,
  createGooglePlayCommerceEvidenceEntry,
  createGooglePlayProductPurchaseBoundary,
  createGooglePlayPublisherClient,
  createInMemoryGameServicesStore,
  createInMemoryVerifiedLeaderboardService,
  createMicrosoftStoreCommerceEvidenceEntry,
  createVerifiedLeaderboardSnapshotFetchHandler,
  createVerse8Agent8EventLookupCommerceEvidenceEntry,
  devvitPaymentOrderEvidenceSchema,
  gameServicesBackendEndpoints,
  microsoftStoreDigitalGoodsEvidenceSchema,
  type AdRewardEvidenceVerifierRegistry,
  type AdRewardVerifierDescriptor,
  type AdRewardVerifierRegistration,
  type ClaimAdRewardRequest,
  type CommerceEvidenceFallbackStore,
  type CommerceEvidenceRegistry,
  type CommerceEvidenceRegistryEntry,
  type DevvitPaymentOrderAuthorityInput,
  type DevvitPaymentOrderAuthorityResult,
  type EvidenceVerificationDecision,
  type FinalizePurchaseGrantInput,
  type GameServicesBackendApi,
  type GameServicesDeploymentTargetBindings,
  type GameServicesEvidenceVerifier,
  type GameServicesPurchaseGrantFinalizer,
  type GameServicesStore,
  type GameServicesStoreTarget,
  type GetVerifiedLeaderboardSnapshotRequest,
  type PurchaseGrantFinalization,
  type PurchaseLedgerStatusRequest,
  type RecordLeaderboardScoreRequest,
  type RecordVerifiedLeaderboardAttemptRequest,
  type RecordVerifiedLeaderboardAttemptResponse,
  type VerifiedLeaderboardService,
  type VerifiedLeaderboardSnapshot,
  type VerifiedLeaderboardSnapshotPrincipal,
  type VerifyAdRewardEvidenceInput,
  type VerifyPurchaseEvidenceInput,
  type VerifyPurchaseRequest,
} from '@mpgd/game-services';
import type { ProductCatalog } from '@mpgd/catalog';
import {
  createVerse8AdsEvidenceVerifier,
  createVerse8AdsVerifierHttpClient,
} from '@mpgd/adapter-verse8/server';

import { createD1GameServicesStore } from './d1Store.js';
import {
  createAdMobSsvCallbackFetchHandler,
  createD1AdMobSsvEvidenceVerifier,
  type AdMobSsvWorkerConfig,
} from './admobSsvHandler.js';
import {
  assertDevelopmentNotificationSessionsAllowed,
  createNotificationsFetchHandler,
  type GameServicesNotificationsEnv,
} from './notificationsHandler.js';
import { createD1VerifiedLeaderboardService } from './verifiedLeaderboardD1.js';

/** `DB` and `MPGD_STORE` come from `GameServicesNotificationsEnv`, which every store here shares. */
export interface GameServicesWorkerEnv extends GameServicesNotificationsEnv {
  /** Local-only. Refused when MPGD_STORE is d1; see resolveWorkerEvidenceVerifier. */
  readonly MPGD_ALLOW_INSECURE_DEVELOPMENT_EVIDENCE?: 'true';
  /**
   * Mounts the unverified leaderboard record route on the public HTTP/oRPC ingress. Without it,
   * public requests to that route receive 404 and score writes stay on the service binding.
   */
  readonly MPGD_ALLOW_PUBLIC_LEADERBOARD_RECORD?: 'true';
  readonly VERIFIED_LEADERBOARD_AUTH?: VerifiedLeaderboardAuthBinding;
  /**
   * Optional ingress authentication for the public purchases, ad-rewards, and leaderboard
   * routes. When bound, every public grant request must carry an Authorization header that
   * the binding resolves to a player ID matching the request body.
   */
  readonly GAME_SERVICES_INGRESS_AUTH?: GameServicesIngressAuthBinding;
  readonly GAME_SERVICES_EVIDENCE_VERIFIER?: GameServicesEvidenceVerifierBinding;
  /** Explicit advertising schema/provider/deployment registrations, independent of client decoders. */
  readonly MPGD_AD_REWARD_VERIFIERS?: readonly AdRewardVerifierDescriptor[];
  readonly MPGD_DEPLOYMENT_TARGET_BINDINGS?: GameServicesDeploymentTargetBindings;
  readonly GAME_SERVICES_AD_REWARD_EVIDENCE_VERIFIER?: {
    verifyAdReward(input: Omit<VerifyAdRewardEvidenceInput, 'signal'> & { readonly providerId: string }): Promise<EvidenceVerificationDecision>;
  };
  readonly GAME_SERVICES_ANDROID_EVIDENCE_VERIFIER?: GameServicesEvidenceVerifierBinding;
  readonly GAME_SERVICES_IOS_EVIDENCE_VERIFIER?: GameServicesEvidenceVerifierBinding;
  readonly GAME_SERVICES_AIT_EVIDENCE_VERIFIER?: GameServicesEvidenceVerifierBinding;
  readonly GAME_SERVICES_MICROSOFT_STORE_EVIDENCE_VERIFIER?: GameServicesEvidenceVerifierBinding;
  readonly GAME_SERVICES_MICROSOFT_STORE_PURCHASE_FINALIZER?:
    GameServicesPurchaseGrantFinalizerBinding;
  readonly GAME_SERVICES_VERSE8_EVIDENCE_VERIFIER?: GameServicesEvidenceVerifierBinding;
  /**
   * Google Play finalizer (commerce v2 C2). The `google-play` registry entry
   * declares `finish: 'server'`, so a deployment that verifies Android
   * purchases must finalize them: either the in-Worker boundary
   * (`GAME_SERVICES_GOOGLE_PLAY_PACKAGE_NAME` plus the
   * `GAME_SERVICES_GOOGLE_PLAY_PUBLISHER_AUTH` service that mints Android
   * Publisher access tokens from the game-owned service account), or a private
   * `GAME_SERVICES_ANDROID_PURCHASE_FINALIZER` service that acknowledges or
   * consumes the purchase itself. Neither configured next to an Android
   * verifier is a startup error, not a silent gap.
   */
  readonly GAME_SERVICES_GOOGLE_PLAY_PACKAGE_NAME?: string;
  readonly GAME_SERVICES_GOOGLE_PLAY_PUBLISHER_AUTH?: GooglePlayPublisherAuthBinding;
  /**
   * Binds the Google response to the authenticated player. Without it, set
   * `GAME_SERVICES_GOOGLE_PLAY_ALLOW_UNBOUND_PLAYER = "true"` only together with
   * `GAME_SERVICES_INGRESS_AUTH`. The Worker refuses to start otherwise: an
   * unbound Play token would be granted to whatever `playerId` the body names.
   */
  readonly GAME_SERVICES_GOOGLE_PLAY_ACCOUNT_BINDING?: GooglePlayAccountBinding;
  readonly GAME_SERVICES_GOOGLE_PLAY_ALLOW_UNBOUND_PLAYER?: 'true';
  readonly GAME_SERVICES_ANDROID_PURCHASE_FINALIZER?: GameServicesPurchaseGrantFinalizerBinding;
  /**
   * The Android verifier binding acknowledges or consumes the purchase itself
   * (a v1 deployment): the google-play entry is registered with
   * `finish: 'client'` and no Play finalizer is required. A commerce v2 Play
   * provider, which declares `finish: 'server'`, is then told
   * `configuration-required` by the capabilities comparison.
   */
  readonly GAME_SERVICES_ANDROID_VERIFIER_FINALIZES?: 'true';
  /**
   * Server-push stores whose client envelopes (`devvit.order.v1`,
   * `verse8.agent8-event.v1`) are looked up against this Worker's ledger
   * (JSON var, for example `["devvit", "verse8"]`). The host's fulfillment
   * path must write that ledger; the lookup never grants from the envelope.
   */
  readonly MPGD_COMMERCE_LOOKUP_STORES?: readonly ('devvit' | 'verse8')[];
  /**
   * The Devvit payments authority the `devvit.payment-order.v1` entry binds a
   * fulfillment handler's order through (`createPlatformOrderVerifyRequest`):
   * a private service over the Devvit `payments` plugin's order read. Without
   * it the fulfillment path writes the ledger directly
   * (`createPlatformOrderLedgerGrant`), and a `devvit.payment-order.v1`
   * verify request is refused with `DEVVIT_PAYMENT_ORDER_AUTHORITY_REQUIRED`.
   */
  readonly GAME_SERVICES_DEVVIT_PAYMENT_ORDER_AUTHORITY?: DevvitPaymentOrderAuthorityBinding;
  readonly GAME_SERVICES_ANDROID_DEPLOYMENT_TARGET?: string;
  readonly GAME_SERVICES_IOS_DEPLOYMENT_TARGET?: string;
  readonly GAME_SERVICES_AIT_DEPLOYMENT_TARGET?: string;
  readonly GAME_SERVICES_MICROSOFT_STORE_DEPLOYMENT_TARGET?: string;
  readonly GAME_SERVICES_VERSE8_DEPLOYMENT_TARGET?: string;
  readonly VERSE8_ADS_VERIFIER_AUTHORIZATION?: string;
  readonly VERSE8_ADS_VERIFIER_BASE_URL?: string;
  readonly MPGD_ADMOB_SSV_ANDROID_AD_UNIT?: string;
  readonly MPGD_ADMOB_SSV_IOS_AD_UNIT?: string;
}

export interface GameServicesEvidenceVerifierBinding {
  verifyPurchase(
    input: Omit<VerifyPurchaseEvidenceInput, 'signal'>,
  ): Promise<EvidenceVerificationDecision>;
  verifyAdReward(
    input: Omit<VerifyAdRewardEvidenceInput, 'signal'>,
  ): Promise<EvidenceVerificationDecision>;
}

export interface GameServicesPurchaseGrantFinalizerBinding {
  finalizePurchaseGrant(
    input: Omit<FinalizePurchaseGrantInput, 'signal'>,
  ): Promise<PurchaseGrantFinalization>;
}

/** Reads a Reddit order for the `devvit.payment-order.v1` entry; the AbortSignal stays local. */
export interface DevvitPaymentOrderAuthorityBinding {
  getOrder(
    input: Omit<DevvitPaymentOrderAuthorityInput, 'signal'>,
  ): Promise<DevvitPaymentOrderAuthorityResult>;
}

/** Mints an access token for the Android Publisher scope from the game-owned service account. */
export interface GooglePlayPublisherAuthBinding {
  getAccessToken(input: { readonly scope: string }): Promise<string>;
}

/** Resolves the obfuscated account (and profile) identifiers the purchase must carry. */
export interface GooglePlayAccountBinding {
  resolveObfuscatedAccountId(
    input: { readonly playerId: string },
  ): Promise<string | null | undefined>;
  resolveObfuscatedProfileId?(
    input: { readonly playerId: string },
  ): Promise<string | null | undefined>;
}

export interface VerifiedLeaderboardAuthBindingRequest {
  readonly authorization: string;
}

export interface VerifiedLeaderboardAuthBinding {
  authenticateVerifiedLeaderboardSnapshot(
    input: VerifiedLeaderboardAuthBindingRequest,
  ): Promise<VerifiedLeaderboardSnapshotPrincipal | undefined>;
}

export interface GameServicesIngressAuthBindingRequest {
  /** The complete Authorization header value received on the public request. */
  readonly authorization: string;
}

export interface GameServicesIngressPrincipal {
  readonly playerId: string;
}

export interface GameServicesIngressAuthBinding {
  /**
   * Resolves the Authorization header to the authenticated player. `undefined` and `null` both
   * mean "no principal" and produce 401 UNAUTHORIZED; a thrown error or any other result that
   * is not `{ playerId: string }` produces 500 AUTHENTICATION_FAILED.
   */
  authenticateGameServicesRequest(
    input: GameServicesIngressAuthBindingRequest,
  ): Promise<GameServicesIngressPrincipal | null | undefined>;
}

export interface GameServicesWorkerService {
  verifyPurchase(input: VerifyPurchaseRequest): Promise<unknown>;
  getPurchaseLedgerStatus(input: PurchaseLedgerStatusRequest): Promise<unknown>;
  /** Undefined when no commerce evidence registry entry is configured. */
  getCommerceCapabilities(): Promise<unknown>;
  claimAdReward(input: ClaimAdRewardRequest): Promise<unknown>;
  recordLeaderboardScore(input: RecordLeaderboardScoreRequest): Promise<unknown>;
  recordVerifiedAttempt(
    input: RecordVerifiedLeaderboardAttemptRequest,
  ): Promise<RecordVerifiedLeaderboardAttemptResponse>;
  getSnapshot(
    input: GetVerifiedLeaderboardSnapshotRequest,
  ): Promise<VerifiedLeaderboardSnapshot | undefined>;
}

const productCatalog = {
  version: 'worker-default',
  products: [
    {
      id: 'COINS_100',
      type: 'consumable',
      grant: {
        type: 'currency',
        currency: 'coin',
        amount: 100,
      },
      platformProductIds: {
        android: 'coins_100',
        'android-staging': 'coins_100_android_staging',
        ios: 'com.mpgd.game.coins100',
        ait: 'coins_100',
        'microsoft-store': 'coins_100',
        reddit: 'coins_100',
        verse8: 'coins_100',
        browser: 'coins_100',
      },
    },
  ],
} as const satisfies ProductCatalog;
const adPlacements = {
  version: 'worker-default',
  placements: [
    {
      id: 'CONTINUE_AFTER_FAIL',
      type: 'rewarded',
      reward: {
        type: 'continue',
        amount: 1,
      },
      frequencyCap: {
        cooldownSeconds: 60,
        maxPerSession: 3,
      },
      platformPlacementIds: {
        android: 'reward_continue',
        ios: 'reward_continue',
        ait: 'reward_continue',
        verse8: 'rewarded_continue',
        'verse8-staging': 'rewarded_continue_staging',
      },
    },
  ],
} as const satisfies AdPlacements;
const fallbackMemoryStore = createInMemoryGameServicesStore();
const fallbackVerifiedLeaderboardService = createInMemoryVerifiedLeaderboardService();

// The Worker entrypoint calls these factories per request with the same env
// object, so the store, registry (and its Play boundary), backend, and
// handlers are built once per env and reused. The shared Play boundary keeps
// one in-flight finalization lease per purchase across requests of the
// isolate, which is the intended same-process dedupe: a second request for a
// purchase whose acknowledge or consume is still running waits for that
// call instead of issuing another.
const fetchHandlersByEnv = new WeakMap<GameServicesWorkerEnv, (request: Request) => Promise<Response>>();
const servicesByEnv = new WeakMap<GameServicesWorkerEnv, GameServicesWorkerService>();
const backendsByEnv = new WeakMap<GameServicesWorkerEnv, GameServicesBackendApi>();
const storesByEnv = new WeakMap<GameServicesWorkerEnv, GameServicesStore>();
const registriesByEnv = new WeakMap<GameServicesWorkerEnv, WorkerCommerceEvidenceRegistry>();

function cachedByEnv<T extends object>(
  cache: WeakMap<GameServicesWorkerEnv, T>,
  env: GameServicesWorkerEnv,
  build: () => T,
): T {
  const cached = cache.get(env);
  if (cached !== undefined) {
    return cached;
  }
  const built = build();
  cache.set(env, built);
  return built;
}

export function createWorkerFetchHandler(
  env: GameServicesWorkerEnv,
): (request: Request) => Promise<Response> {
  return cachedByEnv(fetchHandlersByEnv, env, () => buildWorkerFetchHandler(env));
}

function buildWorkerFetchHandler(
  env: GameServicesWorkerEnv,
): (request: Request) => Promise<Response> {
  assertGooglePlayUnboundPlayerRequiresIngressAuth(env);
  const admobConfig = resolveWorkerAdMobSsvConfig(env);
  const evidenceVerifier = resolveWorkerEvidenceVerifier(env, admobConfig);
  const backend = createWorkerBackend(env, evidenceVerifier);
  const verifiedLeaderboard = createWorkerVerifiedLeaderboardService(env);
  const httpStore = createWorkerStore(env);
  const httpRegistry = resolveWorkerCommerceEvidenceRegistry(env, httpStore);
  const commerceEvidenceRegistry = httpRegistry.status === 'ready'
    ? httpRegistry.registry
    : undefined;
  const registryError = httpRegistry.status === 'misconfigured' ? httpRegistry.error : undefined;
  const deploymentTargetBindings = resolveWorkerDeploymentTargetBindings(env);
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
  const rpcPrefix = '/rpc';
  const allowPublicLeaderboardRecord = env.MPGD_ALLOW_PUBLIC_LEADERBOARD_RECORD === 'true';
  const ingressAuth = env.GAME_SERVICES_INGRESS_AUTH;
  const rpcFetch = createGameServicesRpcFetchHandler(createGameServicesRouter(backend), {
    prefix: rpcPrefix,
    corsHeaders,
    ...(backend.version === undefined ? {} : { version: backend.version }),
  });
  const httpFetch = createGameServicesHttpFetchHandler(
    createGameServicesBackendApiHandler({
      catalog: productCatalog,
      placements: adPlacements,
      store: httpStore,
      deploymentTargetBindings,
      ...(evidenceVerifier === undefined
        ? {}
        : { evidenceVerifier }),
      ...(commerceEvidenceRegistry === undefined
        ? {}
        : { commerceEvidenceRegistry }),
    }),
    {
      corsHeaders,
      version: productCatalog.version,
    },
  );
  const snapshotFetch = createWorkerVerifiedLeaderboardSnapshotFetchHandler(
    env,
    verifiedLeaderboard,
    corsHeaders,
  );
  const admobFetch = admobConfig === undefined
    ? undefined
    : createAdMobSsvCallbackFetchHandler(admobConfig);
  const notificationsFetch = createNotificationsFetchHandler(env, corsHeaders);

  return async (request) => {
    const notificationsResponse = await notificationsFetch(request);
    if (notificationsResponse !== undefined) {
      return notificationsResponse;
    }
    const admobResponse = await admobFetch?.(request);
    if (admobResponse !== undefined) {
      return admobResponse;
    }
    const snapshotResponse = await snapshotFetch?.(request);

    if (snapshotResponse !== undefined) {
      return snapshotResponse;
    }

    const pathname = new URL(request.url).pathname;
    const grantRoute = resolvePublicGrantRoute(pathname, rpcPrefix);

    if (grantRoute === 'malformed') {
      // A segment with an undecodable percent-escape can never name a route we mount. Reject it
      // here instead of letting a downstream matcher decide how to interpret it.
      return jsonResponse({ error: 'UNKNOWN_ENDPOINT' }, 404, corsHeaders);
    }

    if (grantRoute !== undefined && request.method !== 'OPTIONS') {
      // Unverified score writes are a trusted-caller operation. Keep them off the public
      // ingress unless the deployment explicitly opts in; the service binding is unaffected.
      if (grantRoute.operation === 'recordLeaderboardScore' && !allowPublicLeaderboardRecord) {
        return jsonResponse({ error: 'UNKNOWN_ENDPOINT' }, 404, corsHeaders);
      }

      if (
        registryError !== undefined
        && (grantRoute.operation === 'verifyPurchase'
          || grantRoute.operation === 'getCommerceCapabilities')
      ) {
        // The commerce registry is misconfigured: the purchase routes stay
        // closed with the generic code; the error was logged at startup.
        return jsonResponse({ error: 'INTERNAL_ERROR' }, 500, corsHeaders);
      }

      // The capabilities read carries no player data and stays public; the
      // ledger status read is gated like a grant route when auth is bound,
      // and its body names the player whose grants it reads. Public verify
      // stays open when this binding is absent. The unbound Play opt-in is
      // refused at startup without it, so that open route cannot grant an
      // unbound token to a body-supplied playerId.
      if (ingressAuth !== undefined && grantRoute.operation !== 'getCommerceCapabilities') {
        const rejection = await authenticateIngressRequest(
          request,
          grantRoute,
          ingressAuth,
          corsHeaders,
        );

        if (rejection !== undefined) {
          return rejection;
        }
      }
    }

    if (pathname.startsWith(rpcPrefix)) {
      return rpcFetch(request);
    }

    return httpFetch(request);
  };
}

type PublicGrantOperation = keyof typeof gameServicesBackendEndpoints;

interface PublicGrantRoute {
  readonly transport: 'http' | 'rpc';
  readonly operation: PublicGrantOperation;
}

/**
 * Maps a public pathname to the grant operation it invokes. oRPC RPC paths mirror the
 * contract router keys mounted by createGameServicesRouter, independent of REST route metadata.
 *
 * Matching is done on the normalised path, not the raw URL.pathname: segments are
 * percent-decoded and empty segments are dropped. This is at least as permissive as every
 * downstream matcher, because oRPC's RPCHandler retries a non-matching path after decoding each
 * segment and also ignores a trailing slash, so `/rpc/%63ommerce/verifyPurchase` and
 * `/rpc/commerce/verifyPurchase/` reach `commerce.verifyPurchase` and must be gated the same
 * way as the canonical spelling. Returns 'malformed' when a segment cannot be decoded.
 */
function resolvePublicGrantRoute(
  pathname: string,
  rpcPrefix: string,
): PublicGrantRoute | 'malformed' | undefined {
  const segments = normalisePathSegments(pathname);

  if (segments === undefined) {
    return 'malformed';
  }

  const normalised = `/${segments.join('/')}`;
  const rpcSegments = normalisePathSegments(rpcPrefix) ?? [];
  const rpcRoute = (...procedure: readonly string[]): string =>
    `/${[...rpcSegments, ...procedure].join('/')}`;

  switch (normalised) {
    case gameServicesBackendEndpoints.verifyPurchase:
      return { transport: 'http', operation: 'verifyPurchase' };
    case gameServicesBackendEndpoints.getPurchaseLedgerStatus:
      return { transport: 'http', operation: 'getPurchaseLedgerStatus' };
    case gameServicesBackendEndpoints.getCommerceCapabilities:
      return { transport: 'http', operation: 'getCommerceCapabilities' };
    case gameServicesBackendEndpoints.claimAdReward:
      return { transport: 'http', operation: 'claimAdReward' };
    case gameServicesBackendEndpoints.recordLeaderboardScore:
      return { transport: 'http', operation: 'recordLeaderboardScore' };
    case rpcRoute('commerce', 'verifyPurchase'):
      return { transport: 'rpc', operation: 'verifyPurchase' };
    case rpcRoute('commerce', 'getPurchaseLedgerStatus'):
      return { transport: 'rpc', operation: 'getPurchaseLedgerStatus' };
    case rpcRoute('commerce', 'getCapabilities'):
      return { transport: 'rpc', operation: 'getCommerceCapabilities' };
    case rpcRoute('ads', 'claimReward'):
      return { transport: 'rpc', operation: 'claimAdReward' };
    case rpcRoute('leaderboard', 'recordScore'):
      return { transport: 'rpc', operation: 'recordLeaderboardScore' };
    default:
      return undefined;
  }
}

/**
 * Splits a pathname into percent-decoded, non-empty segments. A decoded segment that itself
 * contains a slash is kept as one segment, so `/rpc/commerce%2FverifyPurchase` does not collapse
 * into the canonical route. Returns undefined when any segment has an invalid percent-escape.
 */
function normalisePathSegments(pathname: string): readonly string[] | undefined {
  const segments: string[] = [];

  for (const rawSegment of pathname.split('/')) {
    if (rawSegment.length === 0) {
      continue;
    }

    let segment: string;

    try {
      segment = decodeURIComponent(rawSegment);
    } catch {
      return undefined;
    }

    if (segment.includes('/')) {
      // Keep this one opaque segment distinct from a real slash-separated route by re-encoding
      // the slash; the join below must not produce the canonical path.
      segment = segment.replaceAll('/', '%2F');
    }

    segments.push(segment);
  }

  return segments;
}

/**
 * Returns a rejection response when the ingress auth binding does not accept the request, or
 * undefined when the caller is authenticated as the player named in the request body.
 */
async function authenticateIngressRequest(
  request: Request,
  route: PublicGrantRoute,
  auth: GameServicesIngressAuthBinding,
  corsHeaders: Readonly<Record<string, string>>,
): Promise<Response | undefined> {
  const authorization = request.headers.get('Authorization');

  if (authorization === null || authorization.length === 0) {
    return jsonResponse({ error: 'UNAUTHORIZED' }, 401, corsHeaders);
  }

  // The binding crosses an RPC boundary, so treat its result as untyped until checked.
  let principal: unknown;

  try {
    principal = await auth.authenticateGameServicesRequest({ authorization });
  } catch {
    return jsonResponse({ error: 'AUTHENTICATION_FAILED' }, 500, corsHeaders);
  }

  // undefined and null are both "no principal": null is the usual not-found value across RPC.
  if (principal === undefined || principal === null) {
    return jsonResponse({ error: 'UNAUTHORIZED' }, 401, corsHeaders);
  }

  const playerId = readRecord(principal)?.playerId;

  if (typeof playerId !== 'string' || playerId.length === 0) {
    return jsonResponse({ error: 'AUTHENTICATION_FAILED' }, 500, corsHeaders);
  }

  let body: unknown;

  try {
    // Clone so the downstream handler can still consume the original request body.
    const text = await request.clone().text();
    body = text.length === 0 ? {} : JSON.parse(text);
  } catch {
    return jsonResponse({ error: 'BAD_REQUEST' }, 400, corsHeaders);
  }

  // oRPC RPC requests wrap the procedure input as { json: input }; HTTP bodies are the input.
  const input = route.transport === 'rpc' ? readRecord(body)?.json : body;

  if (readRecord(input)?.playerId !== playerId) {
    return jsonResponse({ error: 'PLAYER_ID_MISMATCH' }, 403, corsHeaders);
  }

  return undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function jsonResponse(
  body: unknown,
  status: number,
  corsHeaders: Readonly<Record<string, string>>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...corsHeaders,
    },
  });
}

function createWorkerVerifiedLeaderboardSnapshotFetchHandler(
  env: GameServicesWorkerEnv,
  reader: VerifiedLeaderboardService,
  corsHeaders: Readonly<Record<string, string>>,
): ((request: Request) => Promise<Response | undefined>) | undefined {
  const auth = env.VERIFIED_LEADERBOARD_AUTH;

  if (auth === undefined) {
    return undefined;
  }

  return createVerifiedLeaderboardSnapshotFetchHandler({
    reader,
    corsHeaders,
    authenticate(request) {
      const authorization = request.headers.get('Authorization');

      if (authorization === null || authorization.length === 0) {
        return undefined;
      }

      return auth.authenticateVerifiedLeaderboardSnapshot({ authorization });
    },
  });
}

export function createWorkerService(env: GameServicesWorkerEnv): GameServicesWorkerService {
  return cachedByEnv(servicesByEnv, env, () => buildWorkerService(env));
}

function buildWorkerService(env: GameServicesWorkerEnv): GameServicesWorkerService {
  assertGooglePlayUnboundPlayerRequiresIngressAuth(env);
  assertDevelopmentNotificationSessionsAllowed(env);
  const admobConfig = resolveWorkerAdMobSsvConfig(env);
  const backend = createWorkerBackend(env, resolveWorkerEvidenceVerifier(env, admobConfig));
  const verifiedLeaderboard = createWorkerVerifiedLeaderboardService(env);

  return {
    verifyPurchase(input) {
      return backend.purchases.verifyPurchase(input);
    },
    async getPurchaseLedgerStatus(input) {
      const read = backend.purchases.getPurchaseLedgerStatus;
      if (read === undefined) {
        throw new Error('This backend has no ledger status read.');
      }
      return read.call(backend.purchases, input);
    },
    async getCommerceCapabilities() {
      return backend.purchases.getCommerceCapabilities?.call(backend.purchases);
    },
    claimAdReward(input) {
      return backend.adRewards.claimAdReward(input);
    },
    recordLeaderboardScore(input) {
      return backend.leaderboard.recordScore(input);
    },
    recordVerifiedAttempt(input) {
      return verifiedLeaderboard.recordVerifiedAttempt(input);
    },
    getSnapshot(input) {
      return verifiedLeaderboard.getSnapshot(input);
    },
  };
}

function createWorkerBackend(
  env: GameServicesWorkerEnv,
  evidenceVerifier: GameServicesEvidenceVerifier | undefined,
): GameServicesBackendApi {
  return cachedByEnv(backendsByEnv, env, () => buildWorkerBackend(env, evidenceVerifier));
}

function buildWorkerBackend(
  env: GameServicesWorkerEnv,
  evidenceVerifier: GameServicesEvidenceVerifier | undefined,
): GameServicesBackendApi {
  const store = createWorkerStore(env);
  const registry = resolveWorkerCommerceEvidenceRegistry(env, store);
  const backend = createGameServicesBackend({
    catalog: productCatalog,
    placements: adPlacements,
    store,
    deploymentTargetBindings: resolveWorkerDeploymentTargetBindings(env),
    ...(evidenceVerifier === undefined
      ? {}
      : { evidenceVerifier }),
    ...(registry.status === 'ready' && registry.registry !== undefined
      ? { commerceEvidenceRegistry: registry.registry }
      : {}),
    version: productCatalog.version,
  });
  if (registry.status === 'ready') {
    return backend;
  }
  // A misconfigured commerce registry fails the purchase routes, not the
  // rewarded-ad and leaderboard routes that share this Worker.
  const { error } = registry;
  return {
    ...backend,
    purchases: {
      ...backend.purchases,
      verifyPurchase: () => Promise.reject(error),
      getCommerceCapabilities: () => Promise.reject(error),
    },
  };
}

type WorkerCommerceEvidenceRegistry =
  | { readonly status: 'ready'; readonly registry: CommerceEvidenceRegistry | undefined }
  | { readonly status: 'misconfigured'; readonly error: Error };

const reportedRegistryErrors = new WeakSet<GameServicesWorkerEnv>();

/**
 * The registry, or the configuration error that keeps the purchase routes
 * closed; the error is logged once per environment at construction so a
 * deployment sees it at startup while ads and leaderboards keep serving.
 */
function resolveWorkerCommerceEvidenceRegistry(
  env: GameServicesWorkerEnv,
  store: GameServicesStore,
): WorkerCommerceEvidenceRegistry {
  return cachedByEnv(registriesByEnv, env, () => buildWorkerCommerceEvidenceRegistry(env, store));
}

function buildWorkerCommerceEvidenceRegistry(
  env: GameServicesWorkerEnv,
  store: GameServicesStore,
): WorkerCommerceEvidenceRegistry {
  try {
    return { status: 'ready', registry: createWorkerCommerceEvidenceRegistry(env, store) };
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    if (!reportedRegistryErrors.has(env)) {
      reportedRegistryErrors.add(env);
      console.error('GameServices Worker commerce registry is misconfigured:', failure.message);
    }
    return { status: 'misconfigured', error: failure };
  }
}

/**
 * The commerce v2 evidence registry (RFC "Evidence registry") composed from
 * the Worker's bindings. Every store with an explicit purchase binding gets
 * its reference entry; a `finish: 'server'` store without its finalizer
 * (Google Play, Microsoft Store) fails here, at startup. Requests whose
 * schema no entry claims keep the aggregate `GAME_SERVICES_EVIDENCE_VERIFIER`
 * (or the local development verifier) as the v1 fallback, so a deployment
 * that only configured the aggregate binding is unchanged: without any entry
 * the backend runs without a registry and publishes no capabilities.
 */
function createWorkerCommerceEvidenceRegistry(
  env: GameServicesWorkerEnv,
  store: GameServicesStore,
): CommerceEvidenceRegistry | undefined {
  assertMicrosoftStorePurchaseBindings(env);
  const entries: CommerceEvidenceRegistryEntry[] = [];
  const bindingVerifier = (
    binding: GameServicesEvidenceVerifierBinding,
  ): Pick<GameServicesEvidenceVerifier, 'verifyPurchase'> => ({
    verifyPurchase({ request, product, platformProductId, timeoutMs }) {
      // AbortSignal is not structured-cloneable across a Worker Service Binding; the
      // remote binding receives timeoutMs and enforces it within its own request scope.
      return binding.verifyPurchase({ request, product, platformProductId, timeoutMs });
    },
  });

  const googlePlay = resolveWorkerGooglePlayBoundary(env);
  const androidVerifier = env.GAME_SERVICES_ANDROID_EVIDENCE_VERIFIER;
  const androidFinalizer = googlePlay
    ?? (env.GAME_SERVICES_ANDROID_PURCHASE_FINALIZER === undefined
      ? undefined
      : bindingFinalizer(env.GAME_SERVICES_ANDROID_PURCHASE_FINALIZER, supportsGooglePlayGrant));
  const androidVerifierFinalizes = env.GAME_SERVICES_ANDROID_VERIFIER_FINALIZES === 'true';
  const aggregate = env.GAME_SERVICES_EVIDENCE_VERIFIER;
  if (androidVerifier !== undefined) {
    // A verifier binding keeps its v1 contract: it decides about a request
    // without an envelope and about schemas of its own.
    if (androidVerifierFinalizes) {
      entries.push(
        createGooglePlayCommerceEvidenceEntry({
          verifier: bindingVerifier(androidVerifier),
          finish: 'client',
          acceptsMissingEvidence: true,
          acceptsUnclaimedSchemas: true,
        }),
      );
    } else if (androidFinalizer !== undefined) {
      entries.push(
        createGooglePlayCommerceEvidenceEntry({
          verifier: bindingVerifier(androidVerifier),
          finalizer: androidFinalizer,
          acceptsMissingEvidence: true,
          acceptsUnclaimedSchemas: true,
        }),
      );
    } else {
      throw new Error(
        'Android purchases are verified but never finalized: the google-play registry entry '
          + 'declares finish: server. Configure GAME_SERVICES_GOOGLE_PLAY_PACKAGE_NAME with '
          + 'GAME_SERVICES_GOOGLE_PLAY_PUBLISHER_AUTH (the in-Worker Play boundary), bind '
          + 'GAME_SERVICES_ANDROID_PURCHASE_FINALIZER, or set '
          + 'GAME_SERVICES_ANDROID_VERIFIER_FINALIZES = "true" when the verifier binding '
          + 'acknowledges purchases itself.',
      );
    }
  } else if (googlePlay !== undefined) {
    // The in-Worker Play boundary verifies the token and finalizes.
    entries.push(
      createGooglePlayCommerceEvidenceEntry({ verifier: googlePlay, finalizer: googlePlay }),
    );
  } else if (androidFinalizer !== undefined && aggregate !== undefined) {
    // The aggregate verifier serves Android purchases and the bound finalizer
    // acknowledges them: the pair is the google-play entry.
    entries.push(
      createGooglePlayCommerceEvidenceEntry({
        verifier: bindingVerifier(aggregate),
        finalizer: androidFinalizer,
        acceptsMissingEvidence: true,
        acceptsUnclaimedSchemas: true,
      }),
    );
  }

  if (env.GAME_SERVICES_IOS_EVIDENCE_VERIFIER !== undefined) {
    entries.push(
      createAppStoreCommerceEvidenceEntry({
        verifier: bindingVerifier(env.GAME_SERVICES_IOS_EVIDENCE_VERIFIER),
        acceptsUnclaimedSchemas: true,
      }),
    );
  }

  if (env.GAME_SERVICES_AIT_EVIDENCE_VERIFIER !== undefined) {
    entries.push(
      createAppsInTossCommerceEvidenceEntry({
        verifier: bindingVerifier(env.GAME_SERVICES_AIT_EVIDENCE_VERIFIER),
        acceptsMissingEvidence: true,
        acceptsUnclaimedSchemas: true,
      }),
    );
  }

  if (
    env.GAME_SERVICES_MICROSOFT_STORE_EVIDENCE_VERIFIER !== undefined
    && env.GAME_SERVICES_MICROSOFT_STORE_PURCHASE_FINALIZER !== undefined
  ) {
    const microsoftStoreVerifier = bindingVerifier(
      env.GAME_SERVICES_MICROSOFT_STORE_EVIDENCE_VERIFIER,
    );
    entries.push(createMicrosoftStoreCommerceEvidenceEntry({
      verifier: {
        verifyPurchase(input) {
          // Store consumables are verified only with their Digital Goods
          // envelope, so the paired consume finalizer can run after the grant.
          if (!hasMicrosoftStorePurchaseEvidence(input)) {
            return Promise.resolve({
              status: 'rejected',
              reason: 'MICROSOFT_STORE_PURCHASE_FINALIZER_UNSUPPORTED',
            });
          }
          return microsoftStoreVerifier.verifyPurchase(input);
        },
      },
      finalizer: bindingFinalizer(
        env.GAME_SERVICES_MICROSOFT_STORE_PURCHASE_FINALIZER,
        supportsMicrosoftStorePurchaseGrant,
      ),
      acceptsMissingEvidence: true,
    }));
  }

  const lookupStores = resolveWorkerLookupStores(env);
  const devvitAuthority = env.GAME_SERVICES_DEVVIT_PAYMENT_ORDER_AUTHORITY;
  for (const lookupStore of lookupStores) {
    if (lookupStore === 'verse8') {
      entries.push(createVerse8Agent8EventLookupCommerceEvidenceEntry({ ledger: store }));
      continue;
    }
    const lookup = createDevvitOrderLookupCommerceEvidenceEntry({ ledger: store });
    if (devvitAuthority !== undefined) {
      entries.push(lookup);
      continue;
    }
    // The devvit store now has an entry, so its other schemas never reach the
    // aggregate: a fulfillment verify (`devvit.payment-order.v1`) is refused
    // with the reason it needs the authority binding rather than an
    // anonymous EVIDENCE_SCHEMA_UNSUPPORTED. The fulfillment path writes the
    // ledger directly (createPlatformOrderLedgerGrant) in this setup.
    entries.push({
      ...lookup,
      acceptsUnclaimedSchemas: true,
      verifier: {
        verifyPurchase(input) {
          const schema = input.request.evidence?.schema;
          if (schema === devvitPaymentOrderEvidenceSchema) {
            return Promise.resolve({
              status: 'rejected',
              reason: 'DEVVIT_PAYMENT_ORDER_AUTHORITY_REQUIRED',
            });
          }
          if (schema !== lookup.schema) {
            return Promise.resolve({ status: 'rejected', reason: 'EVIDENCE_SCHEMA_UNSUPPORTED' });
          }
          return lookup.verifier.verifyPurchase(input);
        },
      },
    });
  }
  if (devvitAuthority !== undefined) {
    // The fulfillment handler's own record, bound through the payments authority.
    entries.push(createDevvitPaymentOrderCommerceEvidenceEntry({
      authority: {
        getOrder({ signal, ...bindingInput }) {
          // AbortSignal is not structured-cloneable across a Worker Service Binding.
          void signal;
          return devvitAuthority.getOrder(bindingInput);
        },
      },
    }));
  }

  if (entries.length === 0) {
    return undefined;
  }

  // Stores without an entry keep the v1 aggregate path (or the local
  // development verifier), and the fallback declares the stores it serves so
  // the capabilities endpoint publishes them. In strict target mode the
  // fallback only answers "unavailable". The registry never routes a store
  // that has its own entry to the fallback.
  const fallback = resolveWorkerUnregisteredPurchaseVerifier(env);
  if (fallback === undefined) {
    return createCommerceEvidenceRegistry(entries);
  }
  const registered = new Set(entries.map((entry) => entry.store));
  const fallbackStores = fallback.stores?.filter((declared) => !registered.has(declared.store));
  return createCommerceEvidenceRegistry(entries, {
    unregistered: {
      verifier: fallback.verifier,
      // The declared stores are published; every other store without an
      // entry keeps reaching the aggregate as it did before the registry.
      ...(fallbackStores === undefined
        ? {}
        : { stores: fallbackStores, servesUndeclaredStores: true }),
    },
  });
}

/**
 * The reference stores a v1 aggregate verifier serves, with their finish
 * owners. Without a Play finalizer the aggregate cannot finish Android
 * purchases, so `google-play` is published with the client finish owner: v1
 * Android requests keep reaching the aggregate, and a commerce v2 Play
 * provider (which declares `server`) is told `configuration-required`.
 */
const aggregateFallbackStores: readonly CommerceEvidenceFallbackStore[] = [
  { store: 'google-play', finish: 'client', targets: ['android'] },
  { store: 'app-store', finish: 'client', targets: ['ios'] },
  { store: 'apps-in-toss', finish: 'host', targets: ['ait'] },
  // `oneplay` is server-finished and the Worker binds no OnePlay finalizer,
  // so it is served (undeclared) but not published.
];

function resolveWorkerUnregisteredPurchaseVerifier(
  env: GameServicesWorkerEnv,
): {
  readonly verifier: Pick<GameServicesEvidenceVerifier, 'verifyPurchase'>;
  /** Published for the capabilities endpoint; absent, any store without an entry is served. */
  readonly stores?: readonly CommerceEvidenceFallbackStore[];
} | undefined {
  if (hasTargetSpecificEvidenceVerifierBinding(env)) {
    // Strict target-specific mode: a store without its own binding fails closed
    // with the same observable state as before the registry, and nothing is
    // published for it.
    return {
      verifier: {
        verifyPurchase() {
          return Promise.resolve(unavailableEvidenceVerificationDecision());
        },
      },
    };
  }
  const aggregate = env.GAME_SERVICES_EVIDENCE_VERIFIER;
  if (aggregate !== undefined) {
    // Android purchases through the aggregate are only published (and
    // finalized) with a Play finalizer; see the google-play entry above.
    return { verifier: bindingVerifierOf(aggregate), stores: aggregateFallbackStores };
  }
  if (env.MPGD_ALLOW_INSECURE_DEVELOPMENT_EVIDENCE === 'true') {
    const development = createDevelopmentGameServicesEvidenceVerifier();
    return {
      verifier: {
        verifyPurchase(input) {
          // Store consumables need a paired finalizer, never the development fallback.
          if (input.request.target === 'microsoft-store') {
            return Promise.resolve(unavailableEvidenceVerificationDecision());
          }
          return development.verifyPurchase(input);
        },
      },
      stores: aggregateFallbackStores,
    };
  }
  return undefined;
}

function bindingVerifierOf(
  binding: GameServicesEvidenceVerifierBinding,
): Pick<GameServicesEvidenceVerifier, 'verifyPurchase'> {
  return {
    verifyPurchase({ request, product, platformProductId, timeoutMs }) {
      return binding.verifyPurchase({ request, product, platformProductId, timeoutMs });
    },
  };
}

function resolveWorkerLookupStores(
  env: GameServicesWorkerEnv,
): readonly ('devvit' | 'verse8')[] {
  const configured = env.MPGD_COMMERCE_LOOKUP_STORES;
  if (configured === undefined) {
    return [];
  }
  if (!Array.isArray(configured)) {
    throw new Error('MPGD_COMMERCE_LOOKUP_STORES must be a JSON array of store ids.');
  }
  const stores = new Set<'devvit' | 'verse8'>();
  for (const candidate of configured) {
    if (candidate !== 'devvit' && candidate !== 'verse8') {
      throw new Error(
        `MPGD_COMMERCE_LOOKUP_STORES names ${String(candidate)}; only devvit and verse8 have `
          + 'a ledger lookup entry.',
      );
    }
    stores.add(candidate);
  }
  return [...stores];
}

/**
 * The unbound Play opt-in grants a token with no obfuscated account to the
 * request `playerId`. That is safe only when ingress auth already binds that
 * player. Refuse to start otherwise, the same way the insecure development
 * verifier is refused for a durable store: a swallowed registry error would
 * still leave the Worker running.
 */
function assertGooglePlayUnboundPlayerRequiresIngressAuth(env: GameServicesWorkerEnv): void {
  if (
    env.GAME_SERVICES_GOOGLE_PLAY_ALLOW_UNBOUND_PLAYER === 'true'
    && env.GAME_SERVICES_INGRESS_AUTH === undefined
  ) {
    throw new Error(
      'GAME_SERVICES_GOOGLE_PLAY_ALLOW_UNBOUND_PLAYER=true is refused unless '
      + 'GAME_SERVICES_INGRESS_AUTH is bound. An unbound Play token is granted to the '
      + 'request playerId, which is safe only when ingress auth already binds that player. '
      + 'Remove the flag or bind GAME_SERVICES_INGRESS_AUTH.',
    );
  }
}

/**
 * The in-Worker Google Play boundary: the Android Publisher client over the
 * token service, with the account binding service or the explicit unbound
 * opt-in. Both the package name and the auth service are required together.
 */
function resolveWorkerGooglePlayBoundary(
  env: GameServicesWorkerEnv,
): ReturnType<typeof createGooglePlayProductPurchaseBoundary> | undefined {
  const packageName = env.GAME_SERVICES_GOOGLE_PLAY_PACKAGE_NAME?.trim();
  const auth = env.GAME_SERVICES_GOOGLE_PLAY_PUBLISHER_AUTH;
  if ((packageName === undefined || packageName.length === 0) && auth === undefined) {
    return undefined;
  }
  if (packageName === undefined || packageName.length === 0 || auth === undefined) {
    throw new Error(
      'GAME_SERVICES_GOOGLE_PLAY_PACKAGE_NAME and GAME_SERVICES_GOOGLE_PLAY_PUBLISHER_AUTH must '
        + 'be configured together.',
    );
  }
  const accountBinding = env.GAME_SERVICES_GOOGLE_PLAY_ACCOUNT_BINDING;
  const allowUnbound = env.GAME_SERVICES_GOOGLE_PLAY_ALLOW_UNBOUND_PLAYER === 'true';
  // Also enforced at Worker construction. Repeated here so this boundary cannot
  // be built with the opt-in while public verify still trusts the body playerId.
  assertGooglePlayUnboundPlayerRequiresIngressAuth(env);
  if (accountBinding === undefined && !allowUnbound) {
    throw new Error(
      'Google Play purchases require GAME_SERVICES_GOOGLE_PLAY_ACCOUNT_BINDING or the explicit '
        + 'GAME_SERVICES_GOOGLE_PLAY_ALLOW_UNBOUND_PLAYER = "true" opt-in.',
    );
  }
  const scope = 'https://www.googleapis.com/auth/androidpublisher';
  return createGooglePlayProductPurchaseBoundary({
    client: createGooglePlayPublisherClient({
      getAccessToken: () => auth.getAccessToken({ scope }),
    }),
    packageName,
    ...(allowUnbound ? { allowUnboundAuthenticatedPlayer: true } : {}),
    ...(accountBinding === undefined
      ? {}
      : {
          resolveObfuscatedAccountId: async (playerId: string) =>
            (await accountBinding.resolveObfuscatedAccountId({ playerId })) ?? undefined,
          ...(accountBinding.resolveObfuscatedProfileId === undefined
            ? {}
            : {
                resolveObfuscatedProfileId: async (playerId: string) =>
                  (await accountBinding.resolveObfuscatedProfileId?.({ playerId })) ?? undefined,
              }),
        }),
  });
}

function bindingFinalizer(
  binding: GameServicesPurchaseGrantFinalizerBinding,
  supports: (input: Pick<FinalizePurchaseGrantInput, 'request' | 'product'>) => boolean,
): GameServicesPurchaseGrantFinalizer {
  return {
    supportsPurchaseGrant(input) {
      return supports(input);
    },
    finalizePurchaseGrant(input) {
      const { signal, ...bindingInput } = input;
      // AbortSignal is not structured-cloneable across a Worker Service Binding. The remote
      // binding receives timeoutMs and must enforce that timeout within its own request scope.
      void signal;
      return binding.finalizePurchaseGrant(bindingInput);
    },
  };
}

function supportsGooglePlayGrant(
  input: Pick<FinalizePurchaseGrantInput, 'request' | 'product'>,
): boolean {
  return input.request.target === 'android' && input.product.type !== 'subscription';
}

function assertMicrosoftStorePurchaseBindings(env: GameServicesWorkerEnv): void {
  const hasVerifier = env.GAME_SERVICES_MICROSOFT_STORE_EVIDENCE_VERIFIER !== undefined;
  const hasFinalizer = env.GAME_SERVICES_MICROSOFT_STORE_PURCHASE_FINALIZER !== undefined;

  if (hasVerifier !== hasFinalizer) {
    const missingBinding = hasVerifier
      ? 'GAME_SERVICES_MICROSOFT_STORE_PURCHASE_FINALIZER'
      : 'GAME_SERVICES_MICROSOFT_STORE_EVIDENCE_VERIFIER';
    throw new Error(
      'Microsoft Store evidence verifier and purchase finalizer bindings must be configured '
        + `together. Missing: ${missingBinding}.`,
    );
  }
}

function resolveWorkerDeploymentTargetBindings(
  env: GameServicesWorkerEnv,
): GameServicesDeploymentTargetBindings {
  return {
    ...env.MPGD_DEPLOYMENT_TARGET_BINDINGS,
    ...(env.GAME_SERVICES_MICROSOFT_STORE_DEPLOYMENT_TARGET === undefined
      ? {}
      : { 'microsoft-store': env.GAME_SERVICES_MICROSOFT_STORE_DEPLOYMENT_TARGET }),
    ...(env.GAME_SERVICES_ANDROID_DEPLOYMENT_TARGET === undefined
      ? {}
      : { android: env.GAME_SERVICES_ANDROID_DEPLOYMENT_TARGET }),
    ...(env.GAME_SERVICES_IOS_DEPLOYMENT_TARGET === undefined
      ? {}
      : { ios: env.GAME_SERVICES_IOS_DEPLOYMENT_TARGET }),
    ...(env.GAME_SERVICES_AIT_DEPLOYMENT_TARGET === undefined
      ? {}
      : { ait: env.GAME_SERVICES_AIT_DEPLOYMENT_TARGET }),
    ...(env.GAME_SERVICES_VERSE8_DEPLOYMENT_TARGET === undefined
      ? {}
      : { verse8: env.GAME_SERVICES_VERSE8_DEPLOYMENT_TARGET }),
  };
}

/**
 * The ids the per-target evidence verifier bindings are looked up by: an ad
 * reward target, or the open store id a purchase request names. Only
 * `microsoft-store`, `android`, `ios`, `ait`, and `verse8` have a binding; any
 * other id has none.
 */
type EvidenceVerifierBindingTarget = ClaimAdRewardRequest['target'] | GameServicesStoreTarget;

function resolveWorkerEvidenceVerifier(
  env: GameServicesWorkerEnv,
  admobConfig: AdMobSsvWorkerConfig | undefined,
): GameServicesEvidenceVerifier | undefined {
  const allowDevelopmentEvidence = env.MPGD_ALLOW_INSECURE_DEVELOPMENT_EVIDENCE === 'true';

  if (allowDevelopmentEvidence && env.MPGD_STORE === 'd1') {
    // The development verifier accepts any client-submitted evidence. Combined with a durable
    // store and a body-supplied playerId, a leaked flag would mean unlimited free grants.
    throw new Error(
      'MPGD_ALLOW_INSECURE_DEVELOPMENT_EVIDENCE=true is refused when MPGD_STORE is d1. '
        + 'The development evidence verifier is local-only; remove the flag or configure a '
        + 'production evidence verifier binding.',
    );
  }

  const verse8Verifier = resolveVerse8AdsEvidenceVerifier(env);
  const admobVerifier = admobConfig === undefined
    ? undefined
    : createD1AdMobSsvEvidenceVerifier(admobConfig);

  const targetBindings = hasTargetSpecificEvidenceVerifierBinding(env);
  const resolveBinding = (target: EvidenceVerifierBindingTarget) => {
    if (targetBindings) {
      return resolveTargetSpecificEvidenceVerifierBinding(env, target);
    }
    // Store consumables need a paired finalizer, never the aggregate fallback.
    return target === 'microsoft-store' || target === 'verse8' && verse8Verifier !== undefined
      ? undefined
      : env.GAME_SERVICES_EVIDENCE_VERIFIER;
  };
  const developmentVerifier = allowDevelopmentEvidence && !targetBindings
      && env.GAME_SERVICES_EVIDENCE_VERIFIER === undefined
    ? createDevelopmentGameServicesEvidenceVerifier()
    : undefined;
  const adRegistry = createWorkerAdRewardRegistry(
    env,
    resolveBinding,
    verse8Verifier,
    admobVerifier,
    admobConfig?.adUnits,
  );
  if (targetBindings || env.GAME_SERVICES_EVIDENCE_VERIFIER !== undefined
    || verse8Verifier !== undefined || developmentVerifier !== undefined
    || admobVerifier !== undefined || env.GAME_SERVICES_AD_REWARD_EVIDENCE_VERIFIER !== undefined) {
    return createWorkerEvidenceVerifier(resolveBinding, adRegistry, developmentVerifier);
  }

  return undefined;
}

function hasTargetSpecificEvidenceVerifierBinding(env: GameServicesWorkerEnv): boolean {
  return env.GAME_SERVICES_MICROSOFT_STORE_EVIDENCE_VERIFIER !== undefined
    || env.GAME_SERVICES_ANDROID_EVIDENCE_VERIFIER !== undefined
    || env.GAME_SERVICES_IOS_EVIDENCE_VERIFIER !== undefined
    || env.GAME_SERVICES_AIT_EVIDENCE_VERIFIER !== undefined
    || env.GAME_SERVICES_VERSE8_EVIDENCE_VERIFIER !== undefined;
}

function resolveTargetSpecificEvidenceVerifierBinding(
  env: GameServicesWorkerEnv,
  target: EvidenceVerifierBindingTarget,
): GameServicesEvidenceVerifierBinding | undefined {
  switch (target) {
    case 'microsoft-store':
      return env.GAME_SERVICES_MICROSOFT_STORE_EVIDENCE_VERIFIER;
    case 'android':
      return env.GAME_SERVICES_ANDROID_EVIDENCE_VERIFIER;
    case 'ios':
      return env.GAME_SERVICES_IOS_EVIDENCE_VERIFIER;
    case 'ait':
      return env.GAME_SERVICES_AIT_EVIDENCE_VERIFIER;
    case 'verse8':
      return env.GAME_SERVICES_VERSE8_EVIDENCE_VERIFIER;
    default:
      return undefined;
  }
}

/**
 * The v1 purchase path, used by the backend only when no commerce evidence
 * registry entry is configured (then the registry is absent and this
 * verifier serves every purchase); with a registry it serves rewarded ads.
 */
function createWorkerEvidenceVerifier(
  resolveBinding: (
    target: EvidenceVerifierBindingTarget,
  ) => GameServicesEvidenceVerifierBinding | undefined,
  adRegistry: AdRewardEvidenceVerifierRegistry,
  fallbackVerifier?: GameServicesEvidenceVerifier,
): GameServicesEvidenceVerifier {
  return {
    async verifyPurchase(input) {
      const { request, product, platformProductId, timeoutMs } = input;
      const binding = resolveBinding(request.target);

      if (request.target === 'microsoft-store') {
        // Store grants are never safe through the generic development fallback because they must
        // be paired with authoritative Collections consumption; with the pair bound, the
        // registry entry serves them instead of this path.
        return unavailableEvidenceVerificationDecision();
      }
      if (binding !== undefined) {
        return binding.verifyPurchase({
          request,
          product,
          platformProductId,
          timeoutMs,
        });
      }

      return fallbackVerifier?.verifyPurchase(input)
        ?? unavailableEvidenceVerificationDecision();
    },
    async verifyAdReward(input) {
      const decision = await adRegistry.verifyAdReward(input);
      return decision.status === 'rejected' && decision.reason === 'AD_REWARD_VERIFIER_UNREGISTERED'
        && fallbackVerifier !== undefined ? fallbackVerifier.verifyAdReward(input) : decision;
    },
  };
}

function createWorkerAdRewardRegistry(
  env: GameServicesWorkerEnv,
  resolveBinding: (target: ClaimAdRewardRequest['target']) => GameServicesEvidenceVerifierBinding | undefined,
  verse8Verifier: GameServicesEvidenceVerifier | undefined,
  admobVerifier: GameServicesEvidenceVerifier | undefined,
  admobAdUnits: AdMobSsvWorkerConfig['adUnits'] | undefined,
): AdRewardEvidenceVerifierRegistry {
  const registrations: AdRewardVerifierRegistration[] = [];
  const deploymentTargets = resolveWorkerDeploymentTargetBindings(env);
  // SDK selection is deployment assembly data. Claim dispatch only uses the registry.
  const builtins = [
    {
      providerId: 'admob-rewarded',
      schema: 'mpgd.admob.client-reward.v1',
      target: 'android',
      native: admobAdUnits?.android === undefined ? undefined : admobVerifier,
    },
    {
      providerId: 'admob-rewarded',
      schema: 'mpgd.admob.client-reward.v1',
      target: 'ios',
      native: admobAdUnits?.ios === undefined ? undefined : admobVerifier,
    },
    {
      providerId: 'apps-in-toss-ads',
      schema: 'apps-in-toss.rewarded-ad.callback.v1',
      target: 'ait',
      native: undefined,
    },
    {
      providerId: 'verse8-ads',
      schema: 'verse8.ads.reward.v1',
      target: 'verse8',
      native: undefined,
    },
  ] as const;
  for (const entry of builtins) {
    const binding = resolveBinding(entry.target);
    const verifier = entry.native ?? (binding === undefined && entry.target === 'verse8' ? verse8Verifier : undefined);
    if (verifier === undefined && binding === undefined) {
      continue;
    }
    registrations.push({
      providerId: entry.providerId, schema: entry.schema,
      acceptsMissingEvidence: entry.native !== undefined,
      bindings: [{ target: entry.target, deploymentTarget: deploymentTargets[entry.target] ?? entry.target }],
      verify: (input) => {
        if (verifier !== undefined) { return verifier.verifyAdReward(input); }
        const { signal, ...bindingInput } = input;
        void signal;
        // Native bindings use clone-safe data and enforce the received timeout budget.
        if (binding === undefined) { return Promise.resolve(unavailableEvidenceVerificationDecision()); }
        return binding.verifyAdReward(bindingInput);
      },
    });
  }
  for (const descriptor of env.MPGD_AD_REWARD_VERIFIERS ?? []) {
    const binding = env.GAME_SERVICES_AD_REWARD_EVIDENCE_VERIFIER;
    if (binding === undefined) {
      throw new Error(
        'Registered ad reward providers require GAME_SERVICES_AD_REWARD_EVIDENCE_VERIFIER.',
      );
    }
    const providerId = descriptor.providerId;
    registrations.push({
      ...descriptor,
      verify: (input) => {
        const { signal, ...bindingInput } = input;
        void signal;
        return binding.verifyAdReward({ ...bindingInput, providerId });
      },
    });
  }
  return createAdRewardEvidenceVerifierRegistry(registrations);
}

function resolveWorkerAdMobSsvConfig(
  env: GameServicesWorkerEnv,
): AdMobSsvWorkerConfig | undefined {
  const android = env.MPGD_ADMOB_SSV_ANDROID_AD_UNIT?.trim();
  const ios = env.MPGD_ADMOB_SSV_IOS_AD_UNIT?.trim();
  if (!android && !ios) {
    return undefined;
  }
  const db = resolveD1Database(env);
  if (db === undefined) {
    throw new Error('AdMob SSV callback intake requires MPGD_STORE=d1 and a DB binding.');
  }
  return {
    db,
    placements: adPlacements,
    adUnits: {
      ...(android ? { android } : {}),
      ...(ios ? { ios } : {}),
    },
  };
}

function supportsMicrosoftStorePurchaseGrant(
  input: Pick<FinalizePurchaseGrantInput, 'request' | 'product'>,
): boolean {
  return input.request.target === 'microsoft-store'
    && input.product.type === 'consumable';
}

function hasMicrosoftStorePurchaseEvidence(
  input: Pick<FinalizePurchaseGrantInput, 'request' | 'product'>,
): boolean {
  return supportsMicrosoftStorePurchaseGrant(input)
    && input.request.evidence?.schema === microsoftStoreDigitalGoodsEvidenceSchema;
}

function resolveVerse8AdsEvidenceVerifier(
  env: GameServicesWorkerEnv,
): GameServicesEvidenceVerifier | undefined {
  const authorization = env.VERSE8_ADS_VERIFIER_AUTHORIZATION?.trim();

  if (authorization === undefined || authorization.length === 0) {
    return undefined;
  }

  return createVerse8AdsEvidenceVerifier({
    client: createVerse8AdsVerifierHttpClient({
      authorization,
      ...(env.VERSE8_ADS_VERIFIER_BASE_URL === undefined
        ? {}
        : { baseUrl: env.VERSE8_ADS_VERIFIER_BASE_URL }),
    }),
  });
}

function unavailableEvidenceVerificationDecision(): EvidenceVerificationDecision {
  return {
    status: 'rejected',
    reason: 'EVIDENCE_VERIFIER_UNAVAILABLE',
  };
}

function createWorkerStore(env: GameServicesWorkerEnv): GameServicesStore {
  return cachedByEnv(storesByEnv, env, () => {
    const db = resolveD1Database(env);
    return db === undefined ? fallbackMemoryStore : createD1GameServicesStore(db);
  });
}

function createWorkerVerifiedLeaderboardService(
  env: GameServicesWorkerEnv,
): VerifiedLeaderboardService {
  const db = resolveD1Database(env);
  return db === undefined
    ? fallbackVerifiedLeaderboardService
    : createD1VerifiedLeaderboardService(db);
}

function resolveD1Database(env: GameServicesWorkerEnv): D1Database | undefined {
  if (env.MPGD_STORE !== 'd1') {
    return undefined;
  }

  if (env.DB === undefined) {
    throw new Error('MPGD_STORE is d1 but DB binding is not configured.');
  }

  return env.DB;
}
