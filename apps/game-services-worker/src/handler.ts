import type { AdPlacements } from '@mpgd/catalog';
import {
  createGameServicesBackend,
  createGameServicesBackendApiHandler,
  createDevelopmentGameServicesEvidenceVerifier,
  createGameServicesHttpFetchHandler,
  createGameServicesRpcFetchHandler,
  createGameServicesRouter,
  createInMemoryGameServicesStore,
  createInMemoryVerifiedLeaderboardService,
  createVerifiedLeaderboardSnapshotFetchHandler,
  microsoftStoreDigitalGoodsEvidenceSchema,
  type ClaimAdRewardRequest,
  type GameServicesBackendApi,
  type GameServicesDeploymentTargetBindings,
  type GameServicesEvidenceVerifier,
  type GameServicesPurchaseGrantFinalizer,
  type EvidenceVerificationDecision,
  type FinalizePurchaseGrantInput,
  type GameServicesStore,
  type GameServicesStoreTarget,
  type GetVerifiedLeaderboardSnapshotRequest,
  type RecordLeaderboardScoreRequest,
  type RecordVerifiedLeaderboardAttemptRequest,
  type RecordVerifiedLeaderboardAttemptResponse,
  type VerifiedLeaderboardService,
  type VerifiedLeaderboardSnapshotPrincipal,
  type VerifiedLeaderboardSnapshot,
  type VerifyPurchaseRequest,
  type VerifyPurchaseEvidenceInput,
  type VerifyAdRewardEvidenceInput,
  type PurchaseGrantFinalization,
} from '@mpgd/game-services';
import type { ProductCatalog } from '@mpgd/catalog';
import {
  createVerse8AdsEvidenceVerifier,
  createVerse8AdsVerifierHttpClient,
} from '@mpgd/adapter-verse8/server';

import { createD1GameServicesStore } from './d1Store.js';
import { createD1VerifiedLeaderboardService } from './verifiedLeaderboardD1.js';

export interface GameServicesWorkerEnv {
  readonly DB?: D1Database;
  readonly MPGD_STORE?: 'memory' | 'd1';
  readonly MPGD_ALLOW_INSECURE_DEVELOPMENT_EVIDENCE?: 'true';
  readonly VERIFIED_LEADERBOARD_AUTH?: VerifiedLeaderboardAuthBinding;
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
  const backend = createWorkerBackend(env);
  const verifiedLeaderboard = createWorkerVerifiedLeaderboardService(env);
  const evidenceVerifier = resolveWorkerEvidenceVerifier(env);
  const purchaseGrantFinalizer = resolveWorkerPurchaseGrantFinalizer(env);
  const deploymentTargetBindings = resolveWorkerDeploymentTargetBindings(env);
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
  const rpcFetch = createGameServicesRpcFetchHandler(
    createGameServicesRouter(backend),
    {
      prefix: '/rpc',
      corsHeaders,
      ...(backend.version === undefined ? {} : { version: backend.version }),
    },
  );
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

  return async (request) => {
    const snapshotResponse = await snapshotFetch?.(request);

    if (snapshotResponse !== undefined) {
      return snapshotResponse;
    }

    const pathname = new URL(request.url).pathname;

    if (pathname.startsWith('/rpc')) {
      return rpcFetch(request);
    }

    return httpFetch(request);
  };
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
  const backend = createWorkerBackend(env);
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

function createWorkerBackend(env: GameServicesWorkerEnv): GameServicesBackendApi {
  assertMicrosoftStorePurchaseBindings(env);
  const evidenceVerifier = resolveWorkerEvidenceVerifier(env);
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
): GameServicesEvidenceVerifier | undefined {
  const verse8Verifier = resolveVerse8AdsEvidenceVerifier(env);

  if (hasTargetSpecificEvidenceVerifierBinding(env)) {
    return createWorkerEvidenceVerifier(
      (target) => resolveTargetSpecificEvidenceVerifierBinding(env, target),
      verse8Verifier,
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
    );
  }

  const developmentVerifier = env.MPGD_ALLOW_INSECURE_DEVELOPMENT_EVIDENCE === 'true'
    ? createDevelopmentGameServicesEvidenceVerifier()
    : undefined;

  if (verse8Verifier !== undefined || developmentVerifier !== undefined) {
    return createWorkerEvidenceVerifier(
      () => undefined,
      verse8Verifier,
      developmentVerifier,
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
        : fallbackVerifier?.verifyAdReward(input)
          ?? unavailableEvidenceVerificationDecision();
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
