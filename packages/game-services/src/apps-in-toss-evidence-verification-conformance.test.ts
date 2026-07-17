import {
  appsInTossPurchaseCallbackEvidenceSchema,
  appsInTossRewardCallbackEvidenceSchema,
  createAppsInTossPurchaseCallbackEvidence,
  createAppsInTossRewardCallbackEvidence,
} from './apps-in-toss-evidence-verification';
import {
  appsInTossProductionEvidenceConformanceScenarios,
  createAppsInTossProductionEvidenceAuthorityFixture,
  runAppsInTossProductionEvidenceConformance,
} from './apps-in-toss-evidence-verification-conformance';

const report = await runAppsInTossProductionEvidenceConformance();

assertJsonEqual(
  report,
  { passedScenarios: appsInTossProductionEvidenceConformanceScenarios },
  'all callback, authority, retry, replay, and recovery scenarios',
);

const fixture = createAppsInTossProductionEvidenceAuthorityFixture();
fixture.enqueuePurchaseResult({
  decision: 'pending',
  reason: 'PURCHASE_PENDING',
});
fixture.enqueueRewardResult({
  decision: 'rejected',
  reason: 'REWARD_REJECTED',
});
const signal = new AbortController().signal;
const purchaseInput = {
  orderId: 'order-1',
  playerId: 'player-1',
  platformSku: 'sku-1',
  signal,
};
const rewardInput = {
  correlationId: 'correlation-1',
  playerId: 'player-1',
  platformPlacementId: 'placement-1',
  signal,
};

assertJsonEqual(
  await fixture.purchaseAuthority.getOrderStatus(purchaseInput),
  { decision: 'pending', reason: 'PURCHASE_PENDING' },
  'deterministic purchase authority result',
);
assertJsonEqual(
  await fixture.rewardAuthority.verifyReward(rewardInput),
  { decision: 'rejected', reason: 'REWARD_REJECTED' },
  'deterministic reward authority result',
);
assertEqual(fixture.purchaseInputs[0]?.signal, signal, 'purchase authority signal forwarding');
assertEqual(fixture.rewardInputs[0]?.signal, signal, 'reward authority signal forwarding');
assertJsonEqual(
  stripSignal(fixture.purchaseInputs[0]),
  stripSignal(purchaseInput),
  'recorded purchase authority input',
);
assertJsonEqual(
  stripSignal(fixture.rewardInputs[0]),
  stripSignal(rewardInput),
  'recorded reward authority input',
);

assertJsonEqual(
  createAppsInTossPurchaseCallbackEvidence({
    orderId: 'order-1',
    platformSku: 'sku-1',
    source: 'pending-order-restore',
  }),
  {
    schema: appsInTossPurchaseCallbackEvidenceSchema,
    payload: {
      orderId: 'order-1',
      sku: 'sku-1',
      source: 'pending-order-restore',
    },
  },
  'versioned purchase callback evidence',
);
assertJsonEqual(
  createAppsInTossRewardCallbackEvidence({
    correlationId: 'correlation-1',
    platformPlacementId: 'placement-1',
  }),
  {
    schema: appsInTossRewardCallbackEvidenceSchema,
    payload: {
      event: 'user-earned-reward',
      correlationId: 'correlation-1',
      placementId: 'placement-1',
    },
  },
  'versioned reward callback evidence',
);

console.log('Apps in Toss production evidence conformance tests passed.');

function stripSignal<T extends { readonly signal: AbortSignal }>(
  input: T | undefined,
): Omit<T, 'signal'> | undefined {
  if (input === undefined) {
    return undefined;
  }

  const { signal: _signal, ...rest } = input;
  return rest;
}

function assertJsonEqual(actual: unknown, expected: unknown, label: string): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);

  if (actualJson !== expectedJson) {
    throw new Error(`${label}: expected ${expectedJson}, received ${actualJson}.`);
  }
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, received ${String(actual)}.`);
  }
}
