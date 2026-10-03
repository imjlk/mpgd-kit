import type { AdPlacements } from '@mpgd/catalog';
import {
  createDevelopmentGameServicesEvidenceVerifier,
  createGameServicesBackend,
  createGameServicesBackendApiHandler,
  createGameServicesHttpFetchHandler,
  createGameServicesRouter,
  createGameServicesRpcFetchHandler,
  createInMemoryGameServicesStore,
  createInMemoryVerifiedLeaderboardService,
  createVerifiedLeaderboardSnapshotFetchHandler,
  gameServicesBackendEndpoints,
  microsoftStoreDigitalGoodsEvidenceSchema,
  type ClaimAdRewardRequest,
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
import { createD1VerifiedLeaderboardService } from './verifiedLeaderboardD1.js';

export interface GameServicesWorkerEnv {
  readonly DB?: D1Database;
  readonly MPGD_STORE?: 'memory' | 'd1';
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
  readonly GAME_SERVICES_ANDROID_EVIDENCE_VERIFIER?: GameServicesEvidenceVerifierBinding;
  readonly GAME_SERVICES_IOS_EVIDENCE_VERIFIER?: GameServicesEvidenceVerifierBinding;
  readonly GAME_SERVICES_AIT_EVIDENCE_VERIFIER?: GameServicesEvidenceVerifierBinding;
  readonly GAME_SERVICES_MICROSOFT_STORE_EVIDENCE_VERIFIER?: GameServicesEvidenceVerifierBinding;
  readonly GAME_SERVICES_MICROSOFT_STORE_PURCHASE_FINALIZER?:
    GameServicesPurchaseGrantFinalizerBinding;
  readonly GAME_SERVICES_VERSE8_EVIDENCE_VERIFIER?: GameServicesEvidenceVerifierBinding;
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

export function createWorkerFetchHandler(
  env: GameServicesWorkerEnv,
): (request: Request) => Promise<Response> {
  const admobConfig = resolveWorkerAdMobSsvConfig(env);
  const evidenceVerifier = resolveWorkerEvidenceVerifier(env, admobConfig);
  const backend = createWorkerBackend(env, evidenceVerifier);
  const verifiedLeaderboard = createWorkerVerifiedLeaderboardService(env);
  const purchaseGrantFinalizer = resolveWorkerPurchaseGrantFinalizer(env);
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
      store: createWorkerStore(env),
      deploymentTargetBindings,
      ...(evidenceVerifier === undefined
        ? {}
        : { evidenceVerifier }),
      ...(purchaseGrantFinalizer === undefined
        ? {}
        : { purchaseGrantFinalizer }),
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

  return async (request) => {
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

      if (ingressAuth !== undefined) {
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
    case gameServicesBackendEndpoints.claimAdReward:
      return { transport: 'http', operation: 'claimAdReward' };
    case gameServicesBackendEndpoints.recordLeaderboardScore:
      return { transport: 'http', operation: 'recordLeaderboardScore' };
    case rpcRoute('commerce', 'verifyPurchase'):
      return { transport: 'rpc', operation: 'verifyPurchase' };
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
  const admobConfig = resolveWorkerAdMobSsvConfig(env);
  const backend = createWorkerBackend(env, resolveWorkerEvidenceVerifier(env, admobConfig));
  const verifiedLeaderboard = createWorkerVerifiedLeaderboardService(env);

  return {
    verifyPurchase(input) {
      return backend.purchases.verifyPurchase(input);
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
  assertMicrosoftStorePurchaseBindings(env);
  const purchaseGrantFinalizer = resolveWorkerPurchaseGrantFinalizer(env);

  return createGameServicesBackend({
    catalog: productCatalog,
    placements: adPlacements,
    store: createWorkerStore(env),
    deploymentTargetBindings: resolveWorkerDeploymentTargetBindings(env),
    ...(evidenceVerifier === undefined
      ? {}
      : { evidenceVerifier }),
    ...(purchaseGrantFinalizer === undefined
      ? {}
      : { purchaseGrantFinalizer }),
    version: productCatalog.version,
  });
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

function resolveWorkerPurchaseGrantFinalizer(
  env: GameServicesWorkerEnv,
): GameServicesPurchaseGrantFinalizer | undefined {
  const binding = env.GAME_SERVICES_MICROSOFT_STORE_PURCHASE_FINALIZER;
  if (binding === undefined) {
    return undefined;
  }

  return {
    supportsPurchaseGrant(input) {
      return supportsMicrosoftStorePurchaseGrant(input);
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

function resolveWorkerDeploymentTargetBindings(
  env: GameServicesWorkerEnv,
): GameServicesDeploymentTargetBindings {
  return {
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

  if (hasTargetSpecificEvidenceVerifierBinding(env)) {
    return createWorkerEvidenceVerifier(
      (target) => resolveTargetSpecificEvidenceVerifierBinding(env, target),
      verse8Verifier,
      undefined,
      admobVerifier,
      admobConfig?.adUnits,
    );
  }

  if (env.GAME_SERVICES_EVIDENCE_VERIFIER !== undefined) {
    const binding = env.GAME_SERVICES_EVIDENCE_VERIFIER;

    return createWorkerEvidenceVerifier(
      (target) => {
        // Microsoft Store consumables require a paired verifier/finalizer boundary. Never let
        // the legacy aggregate verifier grant Store evidence without a consume finalizer.
        if (target === 'microsoft-store') {
          return undefined;
        }
        return target === 'verse8' && verse8Verifier !== undefined ? undefined : binding;
      },
      verse8Verifier,
      undefined,
      admobVerifier,
      admobConfig?.adUnits,
    );
  }

  const developmentVerifier = allowDevelopmentEvidence
    ? createDevelopmentGameServicesEvidenceVerifier()
    : undefined;

  if (verse8Verifier !== undefined || developmentVerifier !== undefined
    || admobVerifier !== undefined) {
    return createWorkerEvidenceVerifier(
      () => undefined,
      verse8Verifier,
      developmentVerifier,
      admobVerifier,
      admobConfig?.adUnits,
    );
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
  target: ClaimAdRewardRequest['target'] | GameServicesStoreTarget,
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
    default: {
      const unsupportedTarget: never = target;

      throw new Error(`Unsupported evidence verifier target: ${String(unsupportedTarget)}`);
    }
  }
}

function createWorkerEvidenceVerifier(
  resolveBinding: (
    target: ClaimAdRewardRequest['target'] | GameServicesStoreTarget,
  ) => GameServicesEvidenceVerifierBinding | undefined,
  verse8Verifier?: GameServicesEvidenceVerifier,
  fallbackVerifier?: GameServicesEvidenceVerifier,
  admobVerifier?: GameServicesEvidenceVerifier,
  admobAdUnits?: AdMobSsvWorkerConfig['adUnits'],
): GameServicesEvidenceVerifier {
  return {
    async verifyPurchase(input) {
      const { request, product, platformProductId, timeoutMs } = input;
      const binding = resolveBinding(request.target);

      if (request.target === 'microsoft-store' && !hasMicrosoftStorePurchaseEvidence(input)) {
        return {
          status: 'rejected',
          reason: 'MICROSOFT_STORE_PURCHASE_FINALIZER_UNSUPPORTED',
        };
      }
      if (binding !== undefined) {
        return binding.verifyPurchase({
          request,
          product,
          platformProductId,
          timeoutMs,
        });
      }

      if (request.target === 'microsoft-store') {
        // Store grants are never safe through the generic development fallback because they must
        // be paired with authoritative Collections consumption.
        return unavailableEvidenceVerificationDecision();
      }
      return fallbackVerifier?.verifyPurchase(input)
        ?? unavailableEvidenceVerificationDecision();
    },
    async verifyAdReward(input) {
      const { request, placement, platformPlacementId, timeoutMs } = input;
      if ((request.target === 'android' || request.target === 'ios')
        && admobVerifier !== undefined && admobAdUnits?.[request.target] !== undefined) {
        return admobVerifier.verifyAdReward(input);
      }
      const binding = resolveBinding(request.target);

      if (binding !== undefined) {
        return binding.verifyAdReward({
          request,
          placement,
          ...(platformPlacementId === undefined ? {} : { platformPlacementId }),
          timeoutMs,
        });
      }

      return request.target === 'verse8' && verse8Verifier !== undefined
        ? verse8Verifier.verifyAdReward(input)
        : (fallbackVerifier?.verifyAdReward(input)
          ?? unavailableEvidenceVerificationDecision());
    },
  };
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
  const db = resolveD1Database(env);
  return db === undefined ? fallbackMemoryStore : createD1GameServicesStore(db);
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
