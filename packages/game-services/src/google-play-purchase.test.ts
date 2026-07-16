import type { ProductCatalog } from '@mpgd/catalog';

import {
  createGooglePlayProductPurchaseBoundary,
  type GooglePlayProductPurchaseClient,
} from './google-play-purchase';
import {
  createGooglePlayProductPurchaseConformanceFixture,
  googlePlayProductPurchaseConformanceEvidence,
} from './google-play-purchase-conformance';
import {
  createDevelopmentGameServicesEvidenceVerifier,
  createGameServicesBackend,
  InMemoryGameServicesStore,
  type EntitlementLedgerGrant,
  type VerifyPurchaseRequest,
} from './index';

const catalog = {
  version: 'google-play-conformance',
  products: [
    {
      id: 'COINS_100',
      type: 'consumable',
      grant: { type: 'currency', currency: 'coin', amount: 100 },
      platformProductIds: { android: 'coins_100_android' },
    },
    {
      id: 'REMOVE_ADS',
      type: 'non_consumable',
      grant: { type: 'entitlement', entitlement: 'remove_ads' },
      platformProductIds: { android: 'remove_ads_android' },
    },
    {
      id: 'PASS_MONTHLY',
      type: 'subscription',
      grant: { type: 'entitlement', entitlement: 'monthly_pass' },
      platformProductIds: { android: 'pass_monthly_android' },
    },
  ],
} as const satisfies ProductCatalog;
const placements = { version: 'google-play-conformance', placements: [] } as const;

class TrackingStore extends InMemoryGameServicesStore {
  readonly events: string[];

  constructor(events: string[]) {
    super();
    this.events = events;
  }

  override async recordEntitlementGrant(input: EntitlementLedgerGrant) {
    this.events.push(`ledger:${input.idempotencyKey}`);
    return super.recordEntitlementGrant(input);
  }
}

class FixtureGooglePlayClient implements GooglePlayProductPurchaseClient {
  readonly events: string[];
  readonly responses = new Map<string, Record<string, unknown>>();
  readonly failingConsumeTokens = new Set<string>();
  readonly failingAcknowledgeTokens = new Set<string>();

  constructor(events: string[]) {
    this.events = events;
  }

  async getProductPurchaseV2(input: { readonly purchaseToken: string }): Promise<unknown> {
    this.events.push(`provider:get:${input.purchaseToken}`);
    const response = this.responses.get(input.purchaseToken);
    if (response === undefined) {
      throw new Error('fixture purchase not found');
    }
    return cloneRecord(response);
  }

  async acknowledgeProductPurchase(input: { readonly purchaseToken: string }): Promise<void> {
    this.events.push(`provider:acknowledge:${input.purchaseToken}`);
    if (this.failingAcknowledgeTokens.has(input.purchaseToken)) {
      throw new Error('simulated acknowledge failure');
    }
    updateAcknowledgementState(
      this.requireResponse(input.purchaseToken),
      'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
    );
  }

  async consumeProductPurchase(input: { readonly purchaseToken: string }): Promise<void> {
    this.events.push(`provider:consume:${input.purchaseToken}`);
    if (this.failingConsumeTokens.has(input.purchaseToken)) {
      throw new Error('simulated consume failure');
    }
    updateConsumptionState(this.requireResponse(input.purchaseToken), 'CONSUMPTION_STATE_CONSUMED');
  }

  private requireResponse(purchaseToken: string): Record<string, unknown> {
    const response = this.responses.get(purchaseToken);
    if (response === undefined) {
      throw new Error(`Missing fixture response for ${purchaseToken}.`);
    }
    return response;
  }
}

function createHarness(input: {
  readonly token: string;
  readonly response: Readonly<Record<string, unknown>>;
  readonly allowUnboundAuthenticatedPlayer?: boolean;
  readonly resolveObfuscatedAccountId?: (playerId: string) => string | undefined;
}) {
  const events: string[] = [];
  const client = new FixtureGooglePlayClient(events);
  client.responses.set(input.token, cloneRecord(input.response));
  const store = new TrackingStore(events);
  const boundary = createGooglePlayProductPurchaseBoundary({
    client,
    packageName: 'dev.mpgd.conformance',
    now: () => '2030-01-02T03:04:06.000Z',
    ...(input.resolveObfuscatedAccountId === undefined
      ? {
          allowUnboundAuthenticatedPlayer:
            input.allowUnboundAuthenticatedPlayer ?? true,
        }
      : {
          resolveObfuscatedAccountId: input.resolveObfuscatedAccountId,
          ...(input.allowUnboundAuthenticatedPlayer === undefined
            ? {}
            : {
                allowUnboundAuthenticatedPlayer:
                  input.allowUnboundAuthenticatedPlayer,
              }),
        }),
  });
  const developmentVerifier = createDevelopmentGameServicesEvidenceVerifier();
  const backend = createGameServicesBackend({
    catalog,
    placements,
    store,
    evidenceVerifier: {
      verifyPurchase: (verificationInput) => boundary.verifyPurchase(verificationInput),
      verifyAdReward: (verificationInput) => {
        return developmentVerifier.verifyAdReward(verificationInput);
      },
    },
    purchaseGrantFinalizer: boundary,
    now: () => '2030-01-02T03:04:07.000Z',
  });

  return { backend, client, events, store };
}

function createRequest(input: {
  readonly token: string;
  readonly productId?: 'COINS_100' | 'REMOVE_ADS' | 'PASS_MONTHLY';
  readonly playerId?: string;
  readonly idempotencyKey?: string;
  readonly orderId?: string;
  readonly purchasedAt?: string;
  readonly schema?: string;
}): VerifyPurchaseRequest {
  return {
    target: 'android',
    playerId: input.playerId ?? 'player-google-play',
    productId: input.productId ?? 'COINS_100',
    platformTransactionId: input.orderId ?? 'GPA.conformance-1',
    idempotencyKey: input.idempotencyKey ?? `purchase:${input.token}`,
    purchasedAt: input.purchasedAt ?? '2030-01-02T03:04:05.000Z',
    evidence: {
      schema: input.schema ?? googlePlayProductPurchaseConformanceEvidence.schema,
      payload: { purchaseToken: input.token },
    },
  };
}

const consumable = createHarness({
  token: 'token-consumable',
  response: createGooglePlayProductPurchaseConformanceFixture(),
});
const consumableRequest = createRequest({ token: 'token-consumable' });
const firstConsumable = await consumable.backend.purchases.verifyPurchase(consumableRequest);

assertEqual(firstConsumable.verified, true, 'purchased consumable should be granted');
assertEqual(firstConsumable.finalization?.status, 'completed', 'consume should complete');
assertEqual(firstConsumable.finalization?.action, 'consume', 'consumables should be consumed');
assertEqual(
  firstConsumable.finalization?.alreadyCompleted,
  false,
  'first consume should perform provider work',
);
assertSequence(
  consumable.events,
  [
    'provider:get:token-consumable',
    'ledger:purchase:token-consumable',
    'provider:get:token-consumable',
    'provider:consume:token-consumable',
  ],
  'consumable verification must grant durably before consume',
);

const consumableRetry = await consumable.backend.purchases.verifyPurchase(consumableRequest);
assertEqual(consumableRetry.alreadyProcessed, true, 'retry should reuse the ledger grant');
assertEqual(
  consumableRetry.finalization?.alreadyCompleted,
  true,
  'retry should observe the provider-completed consume',
);
assertEqual(
  consumable.events.filter((event) => event.startsWith('ledger:')).length,
  1,
  'finalization retry must not create a duplicate grant',
);
assertEqual(
  consumable.events.filter((event) => event.startsWith('provider:consume:')).length,
  1,
  'already consumed purchase must not be consumed again',
);
const storedConsumable = (await consumable.store.listEntitlementTransactions())[0];
assert(
  !JSON.stringify({
    evidenceVerificationId: storedConsumable?.evidenceVerificationId,
    payload: storedConsumable?.payload,
  }).includes('token-consumable'),
  'the raw purchase token must not be persisted in the ledger',
);

assertThrows(
  () => createGooglePlayProductPurchaseBoundary({
    client: new FixtureGooglePlayClient([]),
    packageName: 'dev.mpgd.conformance',
  }),
  'account binding must not be disabled implicitly',
);

const nonConsumable = createHarness({
  token: 'token-non-consumable',
  response: createGooglePlayProductPurchaseConformanceFixture({
    productId: 'remove_ads_android',
  }),
});
const nonConsumableRequest = createRequest({
  token: 'token-non-consumable',
  productId: 'REMOVE_ADS',
});
const firstNonConsumable = await nonConsumable.backend.purchases.verifyPurchase(
  nonConsumableRequest,
);
const nonConsumableRetry = await nonConsumable.backend.purchases.verifyPurchase(
  nonConsumableRequest,
);

assertEqual(firstNonConsumable.finalization?.action, 'acknowledge');
assertEqual(firstNonConsumable.finalization?.status, 'completed');
assertEqual(nonConsumableRetry.alreadyProcessed, true);
assertEqual(nonConsumableRetry.finalization?.alreadyCompleted, true);
assertEqual(
  nonConsumable.events.filter((event) => event.startsWith('provider:acknowledge:')).length,
  1,
  'acknowledged retry must not acknowledge again',
);
assertEqual((await nonConsumable.store.listEntitlementTransactions()).length, 1);

const pending = createHarness({
  token: 'token-pending',
  response: createGooglePlayProductPurchaseConformanceFixture({ purchaseState: 'PENDING' }),
});
const pendingResult = await pending.backend.purchases.verifyPurchase(
  createRequest({ token: 'token-pending' }),
);
assertEqual(pendingResult.verified, false, 'pending purchases must not grant');
assertEqual(pendingResult.reason, 'GOOGLE_PLAY_PURCHASE_PENDING');
assertEqual((await pending.store.listEntitlementTransactions()).length, 0);
assert(
  pending.events.every((event) => !event.startsWith('provider:consume:')),
  'pending purchases must not be consumed',
);

const recoverable = createHarness({
  token: 'token-recoverable',
  response: createGooglePlayProductPurchaseConformanceFixture(),
});
recoverable.client.failingConsumeTokens.add('token-recoverable');
const recoverableRequest = createRequest({ token: 'token-recoverable' });
const failedFinalization = await recoverable.backend.purchases.verifyPurchase(recoverableRequest);

assertEqual(failedFinalization.verified, true, 'durable grant survives provider failure');
assertEqual(failedFinalization.finalization?.status, 'pending');
assertEqual(failedFinalization.finalization?.reason, 'GOOGLE_PLAY_API_ERROR');
assertEqual((await recoverable.store.listEntitlementTransactions()).length, 1);

recoverable.client.failingConsumeTokens.delete('token-recoverable');
const recoveredFinalization = await recoverable.backend.purchases.verifyPurchase(
  recoverableRequest,
);
assertEqual(recoveredFinalization.alreadyProcessed, true);
assertEqual(recoveredFinalization.finalization?.status, 'completed');
assertEqual((await recoverable.store.listEntitlementTransactions()).length, 1);

const replay = createHarness({
  token: 'token-replay',
  response: createGooglePlayProductPurchaseConformanceFixture({
    productId: 'remove_ads_android',
  }),
});
await replay.backend.purchases.verifyPurchase(
  createRequest({
    token: 'token-replay',
    productId: 'REMOVE_ADS',
    playerId: 'player-original',
    idempotencyKey: 'purchase:replay:original',
  }),
);
const replayAttempt = await replay.backend.purchases.verifyPurchase(
  createRequest({
    token: 'token-replay',
    productId: 'REMOVE_ADS',
    playerId: 'player-attacker',
    idempotencyKey: 'purchase:replay:attacker',
  }),
);
assertEqual(replayAttempt.verified, false, 'one token must not grant two ledger entries');
assertEqual(replayAttempt.reason, 'EVIDENCE_ALREADY_PROCESSED');
assertEqual((await replay.store.listEntitlementTransactions()).length, 1);

await assertRejectedFixture(
  'token-cancelled',
  createGooglePlayProductPurchaseConformanceFixture({ purchaseState: 'CANCELLED' }),
  'GOOGLE_PLAY_PURCHASE_CANCELLED',
);
await assertRejectedFixture(
  'token-refunded',
  createGooglePlayProductPurchaseConformanceFixture({ refundableQuantity: 0 }),
  'GOOGLE_PLAY_PURCHASE_REFUNDED',
);
const missingRefundableQuantity = cloneRecord(createGooglePlayProductPurchaseConformanceFixture());
deleteProductOfferField(missingRefundableQuantity, 'refundableQuantity');
await assertRejectedFixture(
  'token-refundable-missing',
  missingRefundableQuantity,
  'GOOGLE_PLAY_REFUNDABLE_QUANTITY_INVALID',
);
await assertRejectedFixture(
  'token-refundable-exceeds-quantity',
  createGooglePlayProductPurchaseConformanceFixture({ refundableQuantity: 2 }),
  'GOOGLE_PLAY_REFUNDABLE_QUANTITY_INVALID',
);
await assertRejectedFixture(
  'token-quantity',
  createGooglePlayProductPurchaseConformanceFixture({ quantity: 2 }),
  'GOOGLE_PLAY_QUANTITY_UNSUPPORTED',
);
await assertRejectedFixture(
  'token-product-mismatch',
  createGooglePlayProductPurchaseConformanceFixture({ productId: 'unexpected_product' }),
  'GOOGLE_PLAY_PRODUCT_MISMATCH',
);
const missingConsumptionState = cloneRecord(createGooglePlayProductPurchaseConformanceFixture());
deleteProductOfferField(missingConsumptionState, 'consumptionState');
await assertRejectedFixture(
  'token-consumption-unspecified',
  missingConsumptionState,
  'GOOGLE_PLAY_CONSUMPTION_STATE_UNSPECIFIED',
);

const missingAcknowledgementState = cloneRecord(
  createGooglePlayProductPurchaseConformanceFixture({ productId: 'remove_ads_android' }),
);
delete missingAcknowledgementState.acknowledgementState;
const missingAcknowledgement = createHarness({
  token: 'token-acknowledgement-unspecified',
  response: missingAcknowledgementState,
});
const missingAcknowledgementResult = await missingAcknowledgement.backend.purchases.verifyPurchase(
  createRequest({
    token: 'token-acknowledgement-unspecified',
    productId: 'REMOVE_ADS',
  }),
);
assertEqual(missingAcknowledgementResult.reason, 'GOOGLE_PLAY_ACKNOWLEDGEMENT_STATE_UNSPECIFIED');
assertEqual((await missingAcknowledgement.store.listEntitlementTransactions()).length, 0);

const orderMismatch = createHarness({
  token: 'token-order-mismatch',
  response: createGooglePlayProductPurchaseConformanceFixture({ orderId: 'GPA.provider' }),
});
const orderMismatchResult = await orderMismatch.backend.purchases.verifyPurchase(
  createRequest({
    token: 'token-order-mismatch',
    orderId: 'GPA.client',
  }),
);
assertEqual(orderMismatchResult.reason, 'GOOGLE_PLAY_ORDER_MISMATCH');
assertEqual((await orderMismatch.store.listEntitlementTransactions()).length, 0);

const missingOrderResponse = cloneRecord(createGooglePlayProductPurchaseConformanceFixture());
delete missingOrderResponse.orderId;
const missingOrder = createHarness({
  token: 'token-order-missing',
  response: missingOrderResponse,
});
const missingOrderResult = await missingOrder.backend.purchases.verifyPurchase(
  createRequest({ token: 'token-order-missing' }),
);
assertEqual(missingOrderResult.verified, true, 'provider order ids are optional');
const storedMissingOrder = (await missingOrder.store.listEntitlementTransactions())[0];
assertEqual(storedMissingOrder?.payload.googlePlayOrderId, undefined);

const providerTime = '2030-02-03T04:05:06.000Z';
const clientTime = '2029-01-02T03:04:05.000Z';
const mismatchedClientTime = createHarness({
  token: 'token-client-time-mismatch',
  response: createGooglePlayProductPurchaseConformanceFixture({
    purchaseCompletionTime: providerTime,
  }),
});
const mismatchedClientTimeResult = await mismatchedClientTime.backend.purchases.verifyPurchase(
  createRequest({
    token: 'token-client-time-mismatch',
    purchasedAt: clientTime,
  }),
);
assertEqual(
  mismatchedClientTimeResult.verified,
  true,
  'client timestamps must not override provider verification',
);
const storedMismatchedClientTime = (
  await mismatchedClientTime.store.listEntitlementTransactions()
)[0];
assertEqual(
  storedMismatchedClientTime?.payload.googlePlayPurchaseCompletionTime,
  providerTime,
  'the provider completion time is the authoritative purchase time',
);
assertEqual(
  storedMismatchedClientTime?.payload.purchasedAt,
  clientTime,
  'the generic request timestamp remains client-reported metadata',
);

const accountMismatch = createHarness({
  token: 'token-account-mismatch',
  response: createGooglePlayProductPurchaseConformanceFixture({
    obfuscatedExternalAccountId: 'account:provider',
  }),
  resolveObfuscatedAccountId: () => 'account:expected',
});
const accountMismatchResult = await accountMismatch.backend.purchases.verifyPurchase(
  createRequest({ token: 'token-account-mismatch' }),
);
assertEqual(accountMismatchResult.reason, 'GOOGLE_PLAY_ACCOUNT_MISMATCH');
assertEqual((await accountMismatch.store.listEntitlementTransactions()).length, 0);

const missingAccountBinding = createHarness({
  token: 'token-account-binding-missing',
  response: createGooglePlayProductPurchaseConformanceFixture(),
  resolveObfuscatedAccountId: () => undefined,
});
const missingAccountBindingResult = await missingAccountBinding.backend.purchases.verifyPurchase(
  createRequest({ token: 'token-account-binding-missing' }),
);
assertEqual(missingAccountBindingResult.reason, 'GOOGLE_PLAY_ACCOUNT_BINDING_REQUIRED');
assertEqual(missingAccountBinding.events.length, 0, 'missing account binding must fail closed');
assertEqual((await missingAccountBinding.store.listEntitlementTransactions()).length, 0);

const wrongSchema = createHarness({
  token: 'token-wrong-schema',
  response: createGooglePlayProductPurchaseConformanceFixture(),
});
const wrongSchemaResult = await wrongSchema.backend.purchases.verifyPurchase(
  createRequest({
    token: 'token-wrong-schema',
    schema: 'client.callback.v1',
  }),
);
assertEqual(wrongSchemaResult.reason, 'GOOGLE_PLAY_PURCHASE_TOKEN_REQUIRED');
assertEqual(wrongSchema.events.length, 0, 'client callbacks alone must not call Google or grant');

const subscription = createHarness({
  token: 'token-subscription',
  response: createGooglePlayProductPurchaseConformanceFixture({
    productId: 'pass_monthly_android',
  }),
});
const subscriptionResult = await subscription.backend.purchases.verifyPurchase(
  createRequest({
    token: 'token-subscription',
    productId: 'PASS_MONTHLY',
  }),
);
assertEqual(subscriptionResult.reason, 'GOOGLE_PLAY_SUBSCRIPTION_VERIFIER_REQUIRED');
assertEqual(subscription.events.length, 0);

const concurrent = createHarness({
  token: 'token-concurrent',
  response: createGooglePlayProductPurchaseConformanceFixture(),
});
const concurrentRequest = createRequest({ token: 'token-concurrent' });
const concurrentResults = await Promise.all([
  concurrent.backend.purchases.verifyPurchase(concurrentRequest),
  concurrent.backend.purchases.verifyPurchase(concurrentRequest),
]);
assert(
  concurrentResults.every((result) => result.verified),
  'concurrent retry should grant',
);
assertEqual((await concurrent.store.listEntitlementTransactions()).length, 1);
assertEqual(
  concurrent.events.filter((event) => event.startsWith('provider:consume:')).length,
  1,
  'same-instance concurrent finalization should share one consume call',
);

console.log('Google Play purchase verification and finalization conformance tests passed.');

async function assertRejectedFixture(
  token: string,
  response: Readonly<Record<string, unknown>>,
  reason: string,
): Promise<void> {
  const harness = createHarness({ token, response });
  const result = await harness.backend.purchases.verifyPurchase(createRequest({ token }));
  assertEqual(result.verified, false);
  assertEqual(result.reason, reason);
  assertEqual((await harness.store.listEntitlementTransactions()).length, 0);
}

function updateConsumptionState(
  response: Record<string, unknown>,
  state: string,
): void {
  const lineItems = response.productLineItem;
  if (!Array.isArray(lineItems) || !isRecord(lineItems[0])) {
    throw new Error('Invalid product line item fixture.');
  }
  const offerDetails = lineItems[0].productOfferDetails;
  if (!isRecord(offerDetails)) {
    throw new Error('Invalid product offer fixture.');
  }
  offerDetails.consumptionState = state;
}

function deleteProductOfferField(response: Record<string, unknown>, field: string): void {
  const lineItems = response.productLineItem;
  if (!Array.isArray(lineItems) || !isRecord(lineItems[0])) {
    throw new Error('Invalid product line item fixture.');
  }
  const offerDetails = lineItems[0].productOfferDetails;
  if (!isRecord(offerDetails)) {
    throw new Error('Invalid product offer fixture.');
  }
  delete offerDetails[field];
}

function updateAcknowledgementState(response: Record<string, unknown>, state: string): void {
  response.acknowledgementState = state;
}

function cloneRecord(input: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function assertSequence(actual: readonly string[], expected: readonly string[], message: string): void {
  assertEqual(JSON.stringify(actual), JSON.stringify(expected), message);
}

function assertEqual(actual: unknown, expected: unknown, message = 'values should match'): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}.`);
  }
}

function assertThrows(action: () => unknown, message: string): void {
  try {
    action();
  } catch {
    return;
  }
  throw new Error(message);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}
