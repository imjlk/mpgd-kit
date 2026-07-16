import type { AdPlacements, ProductCatalog } from '@mpgd/catalog';

import {
  createAppsInTossProductGrantCallback,
  createAppsInTossProductGrantVerificationPort,
  createAppsInTossProductionEvidenceVerifier,
  createAppsInTossPurchaseCallbackEvidence,
  createAppsInTossRewardCallbackEvidence,
  type AppsInTossPurchaseAuthority,
  type AppsInTossPurchaseAuthorityInput,
  type AppsInTossPurchaseAuthorityResult,
  type AppsInTossPurchaseOrderRecord,
  type AppsInTossRewardAuthority,
  type AppsInTossRewardAuthorityInput,
  type AppsInTossRewardAuthorityResult,
  type CreateAppsInTossProductionEvidenceVerifierInput,
} from './apps-in-toss-evidence-verification';
import type { GameServicesEvidenceVerifier } from './evidence-verification';
import {
  createGameServicesBackend,
  createInMemoryGameServicesStore,
  type InMemoryGameServicesStore,
} from './server';
import type { ClaimAdRewardRequest, VerifyPurchaseRequest, VerifyPurchaseResponse } from './types';

export const appsInTossProductionEvidenceConformanceScenarios = [
  'callback-only-fail-closed',
  'purchase-product-grant-callback',
  'purchase-authority-retry',
  'purchase-pending-order-restore',
  'purchase-authority-matching',
  'purchase-timestamp-normalization',
  'reward-authority-retry-and-replay',
  'authority-errors-and-reward-matching',
] as const;

export type AppsInTossProductionEvidenceConformanceScenario =
  (typeof appsInTossProductionEvidenceConformanceScenarios)[number];

export type CreateAppsInTossProductionEvidenceVerifier = (
  input?: CreateAppsInTossProductionEvidenceVerifierInput,
) => GameServicesEvidenceVerifier;

export interface RunAppsInTossProductionEvidenceConformanceInput {
  readonly createVerifier?: CreateAppsInTossProductionEvidenceVerifier;
  readonly now?: string;
}

export interface AppsInTossProductionEvidenceConformanceReport {
  readonly passedScenarios: readonly AppsInTossProductionEvidenceConformanceScenario[];
}

export interface AppsInTossProductionEvidenceAuthorityFixture {
  readonly purchaseAuthority: AppsInTossPurchaseAuthority;
  readonly rewardAuthority: AppsInTossRewardAuthority;
  enqueuePurchaseResult(result: AppsInTossPurchaseAuthorityResult | Error): void;
  enqueueRewardResult(result: AppsInTossRewardAuthorityResult | Error): void;
  readonly purchaseInputs: readonly AppsInTossPurchaseAuthorityInput[];
  readonly rewardInputs: readonly AppsInTossRewardAuthorityInput[];
}

type ScenarioRunner = (
  createVerifier: CreateAppsInTossProductionEvidenceVerifier,
  now: string,
) => Promise<void>;

const catalog = {
  version: 'conformance',
  products: [
    {
      id: 'CONFORMANCE_COINS',
      type: 'consumable',
      grant: {
        type: 'currency',
        currency: 'coin',
        amount: 10,
      },
      platformProductIds: {
        ait: 'ait.conformance.coins',
      },
    },
  ],
} as const satisfies ProductCatalog;

const placements = {
  version: 'conformance',
  placements: [
    {
      id: 'CONFORMANCE_REWARD',
      type: 'rewarded',
      reward: {
        type: 'continue',
        amount: 1,
      },
      frequencyCap: {
        cooldownSeconds: 1,
        maxPerSession: 1,
      },
      platformPlacementIds: {
        ait: 'ait.conformance.reward',
      },
    },
  ],
} as const satisfies AdPlacements;

const scenarioRunners = {
  'callback-only-fail-closed': runCallbackOnlyFailClosedScenario,
  'purchase-product-grant-callback': runPurchaseProductGrantCallbackScenario,
  'purchase-authority-retry': runPurchaseAuthorityRetryScenario,
  'purchase-pending-order-restore': runPurchasePendingOrderRestoreScenario,
  'purchase-authority-matching': runPurchaseAuthorityMatchingScenario,
  'purchase-timestamp-normalization': runPurchaseTimestampNormalizationScenario,
  'reward-authority-retry-and-replay': runRewardAuthorityRetryAndReplayScenario,
  'authority-errors-and-reward-matching': runAuthorityErrorsAndRewardMatchingScenario,
} satisfies Record<AppsInTossProductionEvidenceConformanceScenario, ScenarioRunner>;

/**
 * Runs deterministic client-callback, authority, and ledger scenarios without
 * requiring Apps in Toss credentials or platform SDK imports.
 */
export async function runAppsInTossProductionEvidenceConformance(
  input: RunAppsInTossProductionEvidenceConformanceInput = {},
): Promise<AppsInTossProductionEvidenceConformanceReport> {
  const createVerifier = input.createVerifier ?? createAppsInTossProductionEvidenceVerifier;
  const now = input.now ?? '2030-01-02T03:04:05.000Z';
  const passedScenarios: AppsInTossProductionEvidenceConformanceScenario[] = [];

  for (const scenario of appsInTossProductionEvidenceConformanceScenarios) {
    const runScenario = scenarioRunners[scenario];
    try {
      await runScenario(createVerifier, now);
    } catch (error) {
      throw new Error(`Apps in Toss production evidence conformance failed: ${scenario}.`, {
        cause: error,
      });
    }

    passedScenarios.push(scenario);
  }

  return { passedScenarios };
}

export function createAppsInTossProductionEvidenceAuthorityFixture():
AppsInTossProductionEvidenceAuthorityFixture {
  const purchaseResults: Array<AppsInTossPurchaseAuthorityResult | Error> = [];
  const rewardResults: Array<AppsInTossRewardAuthorityResult | Error> = [];
  const purchaseInputs: AppsInTossPurchaseAuthorityInput[] = [];
  const rewardInputs: AppsInTossRewardAuthorityInput[] = [];

  return {
    purchaseAuthority: {
      async getOrderStatus(input) {
        purchaseInputs.push(input);
        return shiftFixtureResult(purchaseResults, {
          decision: 'rejected',
          reason: 'AIT_PURCHASE_AUTHORITY_FIXTURE_EXHAUSTED',
        });
      },
    },
    rewardAuthority: {
      async verifyReward(input) {
        rewardInputs.push(input);
        return shiftFixtureResult(rewardResults, {
          decision: 'rejected',
          reason: 'AIT_REWARD_AUTHORITY_FIXTURE_EXHAUSTED',
        });
      },
    },
    enqueuePurchaseResult(result) {
      purchaseResults.push(result);
    },
    enqueueRewardResult(result) {
      rewardResults.push(result);
    },
    get purchaseInputs() {
      return [...purchaseInputs];
    },
    get rewardInputs() {
      return [...rewardInputs];
    },
  };
}

async function runCallbackOnlyFailClosedScenario(
  createVerifier: CreateAppsInTossProductionEvidenceVerifier,
  now: string,
): Promise<void> {
  const context = createScenarioContext(createVerifier, now);
  const purchase = await context.backend.purchases.verifyPurchase(purchaseRequest());
  const reward = await context.backend.adRewards.claimAdReward(rewardRequest());

  assertEqual(purchase.verified, false, 'callback-only purchase must not grant');
  assertEqual(
    purchase.reason,
    'AIT_PURCHASE_AUTHORITY_UNAVAILABLE',
    'callback-only purchase must identify the missing authority',
  );
  assertEqual(reward.granted, false, 'callback-only reward must not grant');
  assertEqual(
    reward.reason,
    'AIT_REWARD_AUTHORITY_UNAVAILABLE',
    'callback-only reward must identify the missing authority',
  );
  await assertEntitlementCount(context.store, 0, 'callback-only evidence');
}

async function runPurchaseAuthorityRetryScenario(
  createVerifier: CreateAppsInTossProductionEvidenceVerifier,
  now: string,
): Promise<void> {
  const fixture = createAppsInTossProductionEvidenceAuthorityFixture();
  fixture.enqueuePurchaseResult(resolvedOrder());
  const context = createScenarioContext(createVerifier, now, {
    purchaseAuthority: fixture.purchaseAuthority,
  });
  const request = purchaseRequest();
  const first = await context.backend.purchases.verifyPurchase(request);
  const retry = await context.backend.purchases.verifyPurchase(request);

  assertEqual(first.verified, true, 'authority-confirmed purchase must grant');
  assertEqual(first.alreadyProcessed, false, 'first purchase must be new');
  assertEqual(retry.verified, true, 'same purchase retry must remain accepted');
  assertEqual(retry.alreadyProcessed, true, 'same purchase retry must deduplicate');
  assertEqual(fixture.purchaseInputs.length, 1, 'ledger retry must not re-query authority');
  await assertEntitlementCount(context.store, 1, 'purchase retry');

  const [transaction] = await context.store.listEntitlementTransactions();
  assertEqual(
    transaction?.evidenceVerificationId,
    'apps-in-toss:purchase:ait-order-1',
    'purchase must persist the stable authority identity',
  );
}

async function runPurchaseProductGrantCallbackScenario(
  createVerifier: CreateAppsInTossProductionEvidenceVerifier,
  now: string,
): Promise<void> {
  const failClosedContext = createScenarioContext(createVerifier, now);
  const failClosedCallback = createAppsInTossProductGrantCallback({
    purchaseVerification: createConformanceProductGrantVerificationPort(
      failClosedContext.backend.purchases.verifyPurchase,
    ),
    playerId: 'ait-player-1',
    productId: 'CONFORMANCE_COINS',
    platformSku: 'ait.conformance.coins',
    now: () => now,
  });

  assertEqual(
    await failClosedCallback({ orderId: 'ait-order-fail-closed' }),
    false,
    'product-grant callback must fail closed without authority',
  );
  const transportFailureCallback = createAppsInTossProductGrantCallback({
    purchaseVerification: createAppsInTossProductGrantVerificationPort(
      async () => {
        throw new Error('simulated callback transport failure');
      },
    ),
    playerId: 'ait-player-1',
    productId: 'CONFORMANCE_COINS',
    platformSku: 'ait.conformance.coins',
    now: () => now,
  });
  assertEqual(
    await transportFailureCallback({ orderId: 'ait-order-transport-failure' }),
    false,
    'product-grant transport failure must return false to the SDK',
  );
  const deadlineSignals: AbortSignal[] = [];
  const deadlineCallback = createAppsInTossProductGrantCallback({
    purchaseVerification: createAppsInTossProductGrantVerificationPort(
      ({ signal }) => {
        deadlineSignals.push(signal);
        return new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new Error('simulated abort-aware transport deadline')),
            { once: true },
          );
        });
      },
    ),
    playerId: 'ait-player-1',
    productId: 'CONFORMANCE_COINS',
    platformSku: 'ait.conformance.coins',
    timeoutMs: 1,
    now: () => now,
  });
  assertEqual(
    await deadlineCallback({ orderId: 'ait-order-deadline' }),
    false,
    'product-grant deadline must return false to the SDK',
  );
  assertEqual(deadlineSignals[0]?.aborted, true, 'product-grant deadline must abort transport');
  await assertEntitlementCount(failClosedContext.store, 0, 'fail-closed product-grant callback');

  const fixture = createAppsInTossProductionEvidenceAuthorityFixture();
  fixture.enqueuePurchaseResult(resolvedOrder());
  const context = createScenarioContext(createVerifier, now, {
    purchaseAuthority: fixture.purchaseAuthority,
  });
  const callback = createAppsInTossProductGrantCallback({
    purchaseVerification: createConformanceProductGrantVerificationPort(
      context.backend.purchases.verifyPurchase,
    ),
    playerId: 'ait-player-1',
    productId: 'CONFORMANCE_COINS',
    platformSku: 'ait.conformance.coins',
    now: () => now,
  });

  assertEqual(
    await callback({ orderId: 'ait-order-1' }),
    true,
    'product-grant callback must wait for an authoritative ledger grant',
  );
  await assertEntitlementCount(context.store, 1, 'authoritative product-grant callback');
  const [transaction] = await context.store.listEntitlementTransactions();
  assertEqual(
    transaction?.idempotencyKey,
    'apps-in-toss:purchase:ait-order-1',
    'product-grant callback must derive restart-stable order idempotency',
  );
}

async function runPurchasePendingOrderRestoreScenario(
  createVerifier: CreateAppsInTossProductionEvidenceVerifier,
  now: string,
): Promise<void> {
  const fixture = createAppsInTossProductionEvidenceAuthorityFixture();
  fixture.enqueuePurchaseResult(new Error('simulated partner-server failure'));
  fixture.enqueuePurchaseResult(resolvedOrder({ status: 'PAYMENT_COMPLETED' }));
  const context = createScenarioContext(createVerifier, now, {
    purchaseAuthority: fixture.purchaseAuthority,
  });
  const initial = await context.backend.purchases.verifyPurchase(purchaseRequest());
  const restored = await context.backend.purchases.verifyPurchase(purchaseRequest({
    evidence: createAppsInTossPurchaseCallbackEvidence({
      orderId: 'ait-order-1',
      platformSku: 'ait.conformance.coins',
      source: 'pending-order-restore',
    }),
  }));

  assertEqual(initial.verified, false, 'server failure must not grant');
  assertEqual(
    initial.reason,
    'EVIDENCE_VERIFIER_ERROR',
    'server failure must surface as verifier failure',
  );
  assertEqual(restored.verified, true, 'restored payment-completed order must grant');
  assertEqual(restored.alreadyProcessed, false, 'restored order must create one grant');
  await assertEntitlementCount(context.store, 1, 'pending order restore');

  const [transaction] = await context.store.listEntitlementTransactions();
  assertEqual(
    transaction?.payload.appsInTossOrderStatus,
    'PAYMENT_COMPLETED',
    'restore must retain the authoritative order status',
  );
  assertEqual(
    transaction?.payload.appsInTossGrantCompletionRequired,
    true,
    'payment-completed recovery must require SDK grant completion',
  );
}

async function runPurchaseAuthorityMatchingScenario(
  createVerifier: CreateAppsInTossProductionEvidenceVerifier,
  now: string,
): Promise<void> {
  const fixture = createAppsInTossProductionEvidenceAuthorityFixture();
  fixture.enqueuePurchaseResult(resolvedOrder({ playerId: 'different-player' }));
  fixture.enqueuePurchaseResult(
    resolvedOrder({
      orderId: 'ait-order-sku',
      sku: 'different-sku',
    }),
  );
  fixture.enqueuePurchaseResult(
    resolvedOrder({
      orderId: 'ait-order-refunded',
      status: 'REFUNDED',
    }),
  );
  fixture.enqueuePurchaseResult(
    resolvedOrder({
      orderId: 'ait-order-progress',
      status: 'ORDER_IN_PROGRESS',
    }),
  );
  const context = createScenarioContext(createVerifier, now, {
    purchaseAuthority: fixture.purchaseAuthority,
  });

  const playerMismatch = await context.backend.purchases.verifyPurchase(purchaseRequest());
  const skuMismatch = await context.backend.purchases.verifyPurchase(
    purchaseRequest({
      platformTransactionId: 'ait-order-sku',
      idempotencyKey: 'purchase-sku',
      evidence: purchaseEvidence('ait-order-sku'),
    }),
  );
  const refunded = await context.backend.purchases.verifyPurchase(
    purchaseRequest({
      platformTransactionId: 'ait-order-refunded',
      idempotencyKey: 'purchase-refunded',
      evidence: purchaseEvidence('ait-order-refunded'),
    }),
  );
  const progress = await context.backend.purchases.verifyPurchase(
    purchaseRequest({
      platformTransactionId: 'ait-order-progress',
      idempotencyKey: 'purchase-progress',
      evidence: purchaseEvidence('ait-order-progress'),
    }),
  );

  assertEqual(
    playerMismatch.reason,
    'AIT_PURCHASE_AUTHORITY_PLAYER_MISMATCH',
    'purchase player mismatch',
  );
  assertEqual(skuMismatch.reason, 'AIT_PURCHASE_AUTHORITY_SKU_MISMATCH', 'purchase sku mismatch');
  assertEqual(refunded.reason, 'AIT_PURCHASE_ORDER_REFUNDED', 'refunded purchase');
  assertEqual(progress.reason, 'AIT_PURCHASE_ORDER_ORDER_IN_PROGRESS', 'in-progress purchase');
  await assertEntitlementCount(context.store, 0, 'purchase mismatches and status');
}

async function runPurchaseTimestampNormalizationScenario(
  createVerifier: CreateAppsInTossProductionEvidenceVerifier,
  now: string,
): Promise<void> {
  const fixture = createAppsInTossProductionEvidenceAuthorityFixture();
  fixture.enqueuePurchaseResult(
    resolvedOrder({
      orderId: 'ait-order-kst',
      statusDeterminedAt: '2025-09-12T16:57:12',
    }),
  );
  fixture.enqueuePurchaseResult(
    resolvedOrder({
      orderId: 'ait-order-invalid-date',
      statusDeterminedAt: '2025-02-30T16:57:12',
    }),
  );
  const context = createScenarioContext(createVerifier, now, {
    purchaseAuthority: fixture.purchaseAuthority,
  });

  const kstOrder = await context.backend.purchases.verifyPurchase(
    purchaseRequest({
      platformTransactionId: 'ait-order-kst',
      idempotencyKey: 'purchase-kst',
      evidence: purchaseEvidence('ait-order-kst'),
    }),
  );
  const invalidDate = await context.backend.purchases.verifyPurchase(
    purchaseRequest({
      platformTransactionId: 'ait-order-invalid-date',
      idempotencyKey: 'purchase-invalid-date',
      evidence: purchaseEvidence('ait-order-invalid-date'),
    }),
  );

  assertEqual(kstOrder.verified, true, 'documented KST timestamp must verify deterministically');
  assertEqual(
    invalidDate.reason,
    'AIT_PURCHASE_AUTHORITY_TIMESTAMP_INVALID',
    'calendar-overflow timestamp must be rejected',
  );
  const [transaction] = await context.store.listEntitlementTransactions();
  assertEqual(
    transaction?.payload.evidenceVerifiedAt,
    '2025-09-12T07:57:12.000Z',
    'offset-free order timestamps must normalize as documented KST',
  );
  await assertEntitlementCount(context.store, 1, 'deterministic timestamp normalization');
}

async function runRewardAuthorityRetryAndReplayScenario(
  createVerifier: CreateAppsInTossProductionEvidenceVerifier,
  now: string,
): Promise<void> {
  const fixture = createAppsInTossProductionEvidenceAuthorityFixture();
  fixture.enqueueRewardResult(verifiedReward());
  fixture.enqueueRewardResult(verifiedReward());
  const context = createScenarioContext(createVerifier, now, {
    rewardAuthority: fixture.rewardAuthority,
  });
  const request = rewardRequest();
  const first = await context.backend.adRewards.claimAdReward(request);
  const retry = await context.backend.adRewards.claimAdReward(request);
  const replay = await context.backend.adRewards.claimAdReward({
    ...request,
    idempotencyKey: 'reward-replay',
  });

  assertEqual(first.granted, true, 'authority-confirmed reward must grant');
  assertEqual(first.alreadyProcessed, false, 'first reward must be new');
  assertEqual(retry.granted, true, 'same reward retry must remain accepted');
  assertEqual(retry.alreadyProcessed, true, 'same reward retry must deduplicate');
  assertEqual(replay.granted, false, 'replayed authority evidence must not grant');
  assertEqual(
    replay.reason,
    'EVIDENCE_ALREADY_PROCESSED',
    'replayed authority evidence must be rejected explicitly',
  );
  assertEqual(fixture.rewardInputs.length, 2, 'retry must skip authority, replay must query it');
  await assertEntitlementCount(context.store, 1, 'reward retry and replay');
}

async function runAuthorityErrorsAndRewardMatchingScenario(
  createVerifier: CreateAppsInTossProductionEvidenceVerifier,
  now: string,
): Promise<void> {
  const fixture = createAppsInTossProductionEvidenceAuthorityFixture();
  const diagnosticReason = `Authority temporarily unavailable: ${'x'.repeat(512)} `;
  fixture.enqueuePurchaseResult({ decision: 'rejected', reason: diagnosticReason });
  fixture.enqueuePurchaseResult({ decision: 'pending', reason: diagnosticReason });
  fixture.enqueueRewardResult(new Error('simulated reward authority failure'));
  fixture.enqueueRewardResult(
    verifiedReward({
      correlationId: 'different-correlation',
    }),
  );
  fixture.enqueueRewardResult(
    verifiedReward({
      correlationId: 'ait-correlation-player',
      playerId: 'different-player',
    }),
  );
  fixture.enqueueRewardResult(
    verifiedReward({
      correlationId: 'ait-correlation-placement',
      platformPlacementId: 'different-placement',
    }),
  );
  fixture.enqueueRewardResult({ decision: 'pending' });
  fixture.enqueueRewardResult({ decision: 'rejected', reason: diagnosticReason });
  fixture.enqueueRewardResult({ decision: 'pending', reason: diagnosticReason });
  const context = createScenarioContext(createVerifier, now, {
    purchaseAuthority: fixture.purchaseAuthority,
    rewardAuthority: fixture.rewardAuthority,
  });
  const purchaseRejected = await context.backend.purchases.verifyPurchase(
    purchaseRequest({ idempotencyKey: 'purchase-free-form-rejected' }),
  );
  const purchasePending = await context.backend.purchases.verifyPurchase(
    purchaseRequest({ idempotencyKey: 'purchase-free-form-pending' }),
  );
  const failed = await context.backend.adRewards.claimAdReward(rewardRequest());
  const correlationMismatch = await context.backend.adRewards.claimAdReward(
    rewardRequest({
      idempotencyKey: 'reward-correlation',
      evidence: rewardEvidence('ait-correlation-mismatch'),
    }),
  );
  const playerMismatch = await context.backend.adRewards.claimAdReward(
    rewardRequest({
      idempotencyKey: 'reward-player',
      evidence: rewardEvidence('ait-correlation-player'),
    }),
  );
  const placementMismatch = await context.backend.adRewards.claimAdReward(
    rewardRequest({
      idempotencyKey: 'reward-placement',
      evidence: rewardEvidence('ait-correlation-placement'),
    }),
  );
  const pending = await context.backend.adRewards.claimAdReward(
    rewardRequest({
      idempotencyKey: 'reward-pending',
      evidence: rewardEvidence('ait-correlation-pending'),
    }),
  );
  const rewardRejected = await context.backend.adRewards.claimAdReward(
    rewardRequest({
      idempotencyKey: 'reward-free-form-rejected',
      evidence: rewardEvidence('ait-correlation-free-form-rejected'),
    }),
  );
  const rewardPending = await context.backend.adRewards.claimAdReward(
    rewardRequest({
      idempotencyKey: 'reward-free-form-pending',
      evidence: rewardEvidence('ait-correlation-free-form-pending'),
    }),
  );

  assertEqual(purchaseRejected.reason, diagnosticReason, 'purchase rejection reason forwarding');
  assertEqual(purchasePending.reason, diagnosticReason, 'purchase pending reason forwarding');
  assertEqual(failed.reason, 'EVIDENCE_VERIFIER_ERROR', 'reward authority error');
  assertEqual(
    correlationMismatch.reason,
    'AIT_REWARD_AUTHORITY_CORRELATION_ID_MISMATCH',
    'reward correlation mismatch',
  );
  assertEqual(
    playerMismatch.reason,
    'AIT_REWARD_AUTHORITY_PLAYER_MISMATCH',
    'reward player mismatch',
  );
  assertEqual(
    placementMismatch.reason,
    'AIT_REWARD_AUTHORITY_PLACEMENT_MISMATCH',
    'reward placement mismatch',
  );
  assertEqual(pending.reason, 'AIT_REWARD_AUTHORITY_PENDING', 'reward pending decision');
  assertEqual(rewardRejected.reason, diagnosticReason, 'reward rejection reason forwarding');
  assertEqual(rewardPending.reason, diagnosticReason, 'reward pending reason forwarding');
  await assertEntitlementCount(context.store, 0, 'reward errors and mismatches');
}

function createScenarioContext(
  createVerifier: CreateAppsInTossProductionEvidenceVerifier,
  now: string,
  authorities: CreateAppsInTossProductionEvidenceVerifierInput = {},
): {
  readonly backend: ReturnType<typeof createGameServicesBackend>;
  readonly store: InMemoryGameServicesStore;
} {
  const store = createInMemoryGameServicesStore();

  return {
    backend: createGameServicesBackend({
      catalog,
      placements,
      store,
      now: () => now,
      evidenceVerifier: createVerifier(authorities),
    }),
    store,
  };
}

function purchaseRequest(
  overrides: Partial<VerifyPurchaseRequest> = {},
): VerifyPurchaseRequest {
  return {
    target: 'ait',
    playerId: 'ait-player-1',
    productId: 'CONFORMANCE_COINS',
    platformTransactionId: 'ait-order-1',
    idempotencyKey: 'purchase-1',
    purchasedAt: '2030-01-02T03:00:00.000Z',
    evidence: purchaseEvidence('ait-order-1'),
    ...overrides,
  };
}

function rewardRequest(
  overrides: Partial<ClaimAdRewardRequest> = {},
): ClaimAdRewardRequest {
  return {
    target: 'ait',
    playerId: 'ait-player-1',
    placementId: 'CONFORMANCE_REWARD',
    idempotencyKey: 'reward-1',
    completedAt: '2030-01-02T03:01:00.000Z',
    evidence: rewardEvidence('ait-correlation-1'),
    ...overrides,
  };
}

function purchaseEvidence(orderId: string) {
  return createAppsInTossPurchaseCallbackEvidence({
    orderId,
    platformSku: 'ait.conformance.coins',
    source: 'process-product-grant',
  });
}

function rewardEvidence(correlationId: string) {
  return createAppsInTossRewardCallbackEvidence({
    correlationId,
    platformPlacementId: 'ait.conformance.reward',
  });
}

function resolvedOrder(
  overrides: Partial<AppsInTossPurchaseOrderRecord> = {},
): AppsInTossPurchaseAuthorityResult {
  return {
    decision: 'resolved',
    order: {
      orderId: 'ait-order-1',
      playerId: 'ait-player-1',
      sku: 'ait.conformance.coins',
      status: 'PURCHASED',
      statusDeterminedAt: '2030-01-02T03:02:00+09:00',
      ...overrides,
    },
  };
}

function verifiedReward(
  overrides: Partial<Extract<AppsInTossRewardAuthorityResult, { decision: 'verified' }>> = {},
): AppsInTossRewardAuthorityResult {
  return {
    decision: 'verified',
    authorityEventId: 'ait-authority-event-1',
    correlationId: 'ait-correlation-1',
    playerId: 'ait-player-1',
    platformPlacementId: 'ait.conformance.reward',
    verifiedAt: '2030-01-02T03:02:00.000Z',
    ...overrides,
  };
}

function createConformanceProductGrantVerificationPort(
  verifyPurchase: (request: VerifyPurchaseRequest) => Promise<VerifyPurchaseResponse>,
) {
  return createAppsInTossProductGrantVerificationPort(async ({ request, signal }) => {
    if (signal.aborted) {
      throw signal.reason;
    }
    const response = await verifyPurchase(request);
    if (signal.aborted) {
      throw signal.reason;
    }
    return response;
  });
}

function shiftFixtureResult<T>(queue: Array<T | Error>, exhaustedResult: T): T {
  const result = queue.shift();

  if (result === undefined) {
    return exhaustedResult;
  }

  if (result instanceof Error) {
    throw result;
  }

  return result;
}

async function assertEntitlementCount(
  store: InMemoryGameServicesStore,
  expected: number,
  label: string,
): Promise<void> {
  assertEqual(
    (await store.listEntitlementTransactions()).length,
    expected,
    `${label} ledger count`,
  );
}

function assertEqual<T extends string | number | boolean | null | undefined>(
  actual: T,
  expected: T,
  label: string,
): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, received ${String(actual)}.`);
  }
}
