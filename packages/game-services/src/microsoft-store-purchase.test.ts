import type { ProductCatalog } from '@mpgd/catalog';

import {
  createDevelopmentGameServicesEvidenceVerifier,
  createGameServicesBackend,
  InMemoryGameServicesStore,
  type EntitlementLedgerGrant,
  type VerifyPurchaseRequest,
} from './index';
import {
  createInMemoryMicrosoftStoreRecoveryOwnershipStore,
  createMicrosoftStoreCollectionsClient,
  createMicrosoftStorePurchaseBoundary,
  microsoftStoreCollectionsConsumeUrl,
  microsoftStoreCollectionsQueryUrl,
  microsoftStoreDigitalGoodsEvidenceSchema,
  type MicrosoftStoreCollectionsClient,
  type MicrosoftStoreCollectionsCredentials,
  type MicrosoftStoreRecoveryOwnershipStore,
} from './microsoft-store-purchase';

const assert = {
  equal(actual: unknown, expected: unknown): void {
    if (actual !== expected) {
      throw new Error(`Expected ${String(expected)}, received ${String(actual)}.`);
    }
  },
  deepEqual(actual: unknown, expected: unknown): void {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(
        `Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}.`,
      );
    }
  },
  throws(callback: () => unknown, pattern: RegExp): void {
    try {
      callback();
    } catch (error) {
      if (error instanceof Error && pattern.test(error.message)) {
        return;
      }
      throw error;
    }
    throw new Error(`Expected callback to throw ${String(pattern)}.`);
  },
};

const inAppOfferToken = 'ttokdoku_hint_pack_20';
const storeId = '9N0000000001';
const collectionItemId = 'collection-item-20';
// Collections v9 examples serialize datetime fields with an explicit UTC offset.
const modifiedDate = '2030-01-02T03:04:05.0000000+00:00';
const credentials = {
  accessToken: 'entra-service-token',
  userStoreId: 'server-resolved-user-store-id',
  accountBindingId: 'store-account-link-1',
} as const satisfies MicrosoftStoreCollectionsCredentials;
const catalog = {
  version: 'microsoft-store-test',
  products: [
    {
      id: 'HINT_PACK_20',
      type: 'consumable',
      grant: { type: 'resource', resource: 'hint', amount: 20 },
      platformProductIds: { 'microsoft-store': inAppOfferToken },
    },
  ],
} as const satisfies ProductCatalog;
const placements = { version: 'microsoft-store-test', placements: [] } as const;

class TrackingStore extends InMemoryGameServicesStore {
  constructor(private readonly events: string[]) {
    super();
  }

  override recordEntitlementGrant(input: EntitlementLedgerGrant) {
    this.events.push(`ledger:${input.idempotencyKey}`);
    return super.recordEntitlementGrant(input);
  }
}

class FixtureCollectionsClient implements MicrosoftStoreCollectionsClient {
  readonly events: string[];
  readonly consumeTrackingIds: string[] = [];
  nextConsumeResponse: unknown;
  nextQueryError: unknown;
  queryResponse: unknown = {
    items: [
      {
        id: collectionItemId,
        modifiedDate,
        productId: storeId,
        productKind: 'UnmanagedConsumable',
        quantity: 1,
        status: 'Active',
        transactionId: 'provider-order-id',
      },
    ],
  };

  constructor(events: string[]) {
    this.events = events;
  }

  async queryProduct(input: { readonly storeId: string }): Promise<unknown> {
    this.events.push(`provider:query:${input.storeId}`);
    if (this.nextQueryError !== undefined) {
      const error = this.nextQueryError;
      this.nextQueryError = undefined;
      throw error;
    }
    return structuredClone(this.queryResponse);
  }

  async consumeProduct(input: {
    readonly storeId: string;
    readonly trackingId: string;
  }): Promise<unknown> {
    this.events.push(`provider:consume:${input.storeId}`);
    this.consumeTrackingIds.push(input.trackingId);
    if (this.nextConsumeResponse !== undefined) {
      const response = this.nextConsumeResponse;
      this.nextConsumeResponse = undefined;
      return response;
    }
    return {
      itemId: collectionItemId,
      productId: input.storeId,
      trackingId: input.trackingId,
      newQuantity: 0,
    };
  }
}

function createRequest(overrides: Partial<VerifyPurchaseRequest> = {}): VerifyPurchaseRequest {
  return {
    target: 'microsoft-store',
    playerId: 'player-microsoft-store',
    productId: 'HINT_PACK_20',
    platformTransactionId: inAppOfferToken,
    idempotencyKey: 'microsoft-store-purchase-1',
    purchasedAt: '2030-01-02T03:04:05.000Z',
    evidence: {
      schema: microsoftStoreDigitalGoodsEvidenceSchema,
      payload: {
        itemId: inAppOfferToken,
        purchaseToken: inAppOfferToken,
      },
    },
    ...overrides,
  };
}

function createHarness(input: {
  readonly events?: string[];
  readonly sandbox?: string;
  readonly store?: TrackingStore;
  readonly storeIds?: Readonly<Record<string, string>>;
  readonly catalog?: ProductCatalog;
  readonly historicalProductMappings?: Readonly<Record<
    string,
    readonly { readonly inAppOfferToken: string; readonly storeId: string }[]
  >>;
  readonly resolveCredentials?: (
    playerId: string,
    signal: AbortSignal,
  ) => Promise<MicrosoftStoreCollectionsCredentials> | MicrosoftStoreCollectionsCredentials;
  readonly recoveryOwnershipStore?: MicrosoftStoreRecoveryOwnershipStore;
} = {}) {
  const events = input.events ?? [];
  const client = new FixtureCollectionsClient(events);
  const boundary = createMicrosoftStorePurchaseBoundary({
    client,
    inAppOfferTokens: {
      HINT_PACK_20: input.catalog?.products[0]?.platformProductIds['microsoft-store']
        ?? inAppOfferToken,
    },
    storeIds: input.storeIds ?? { HINT_PACK_20: storeId },
    ...(input.historicalProductMappings === undefined
      ? {}
      : { historicalProductMappings: input.historicalProductMappings }),
    resolveCredentials: input.resolveCredentials ?? (() => ({
      ...credentials,
      ...(input.sandbox === undefined ? {} : { sandbox: input.sandbox }),
    })),
    recoveryOwnershipStore: input.recoveryOwnershipStore ?? {
      async claim(ownership) {
        return ownership;
      },
      async get(ownership) {
        return {
          ...ownership,
          generation: ownership.generation ?? 'default-recovery-generation',
        };
      },
      async release() {},
    },
    now: () => '2030-01-02T03:04:06.000Z',
  });
  const developmentVerifier = createDevelopmentGameServicesEvidenceVerifier();
  const store = input.store ?? new TrackingStore(events);
  const backend = createGameServicesBackend({
    catalog: input.catalog ?? catalog,
    placements,
    store,
    evidenceVerifier: {
      verifyPurchase: (verificationInput) => boundary.verifyPurchase(verificationInput),
      verifyAdReward: (verificationInput) => (
        developmentVerifier.verifyAdReward(verificationInput)
      ),
    },
    purchaseGrantFinalizer: boundary,
    now: () => '2030-01-02T03:04:07.000Z',
  });
  return { backend, boundary, client, events, store };
}

function createRecoveryOwnershipInput(
  playerId: string,
  purchasedInAppOfferToken = inAppOfferToken,
  idempotencyKey = 'recovery-generation-1',
) {
  return {
    playerId,
    productId: 'HINT_PACK_20',
    inAppOfferToken,
    purchaseToken: purchasedInAppOfferToken,
    idempotencyKey,
    evidence: {
      schema: microsoftStoreDigitalGoodsEvidenceSchema,
      payload: {
        itemId: purchasedInAppOfferToken,
        purchaseToken: purchasedInAppOfferToken,
      },
    },
    signal: new AbortController().signal,
  } as const;
}

const durableRecoveryOwnership = createInMemoryMicrosoftStoreRecoveryOwnershipStore();
const ownershipHarness = createHarness({ recoveryOwnershipStore: durableRecoveryOwnership });
assert.deepEqual(
  await ownershipHarness.boundary.hasRecoveryOwnership(
    createRecoveryOwnershipInput('player-microsoft-store'),
  ),
  { status: 'denied' },
);

const trustedTokenOwnershipStore = createInMemoryMicrosoftStoreRecoveryOwnershipStore();
const trustedTokenOwnershipHarness = createHarness({
  recoveryOwnershipStore: trustedTokenOwnershipStore,
});
assert.deepEqual(
  await trustedTokenOwnershipHarness.boundary.claimRecoveryOwnership({
    ...createRecoveryOwnershipInput('player-attacker'),
    inAppOfferToken: 'attacker-controlled-token',
  }),
  { status: 'denied' },
);
assert.deepEqual(
  await trustedTokenOwnershipHarness.boundary.claimRecoveryOwnership(
    createRecoveryOwnershipInput('player-microsoft-store'),
  ),
  { status: 'granted', idempotencyKey: 'recovery-generation-1' },
);

const historicalOwnershipStore = createInMemoryMicrosoftStoreRecoveryOwnershipStore();
const historicalOwnershipHarness = createHarness({
  recoveryOwnershipStore: historicalOwnershipStore,
  historicalProductMappings: {
    HINT_PACK_20: [{
      inAppOfferToken: 'ttokdoku_hint_pack_20_legacy',
      storeId: '9N0000000000',
    }],
  },
});
assert.deepEqual(
  await historicalOwnershipHarness.boundary.claimRecoveryOwnership(
    createRecoveryOwnershipInput(
      'player-microsoft-store',
      'ttokdoku_hint_pack_20_legacy',
    ),
  ),
  { status: 'granted', idempotencyKey: 'recovery-generation-1' },
);
assert.deepEqual(
  await historicalOwnershipHarness.boundary.hasRecoveryOwnership(
    createRecoveryOwnershipInput(
      'player-microsoft-store',
      'ttokdoku_hint_pack_20_legacy',
    ),
  ),
  { status: 'granted', idempotencyKey: 'recovery-generation-1' },
);
const historicalRecoveryWithGeneration = createRecoveryOwnershipInput(
  'player-microsoft-store',
  'ttokdoku_hint_pack_20_legacy',
);
const {
  idempotencyKey: ignoredRecoveryGeneration,
  ...generationlessHistoricalRecovery
} = historicalRecoveryWithGeneration;
void ignoredRecoveryGeneration;
assert.deepEqual(
  await historicalOwnershipHarness.boundary.hasRecoveryOwnership(
    generationlessHistoricalRecovery,
  ),
  { status: 'granted', idempotencyKey: 'recovery-generation-1' },
);
assert.deepEqual(
  await historicalOwnershipHarness.boundary.claimRecoveryOwnership(
    createRecoveryOwnershipInput('player-microsoft-store', 'unknown-token'),
  ),
  { status: 'denied' },
);
const unclaimedRecoveryResult = await ownershipHarness.backend.purchases.verifyPurchase(
  createRequest({ idempotencyKey: 'unclaimed-recovery' }),
);
assert.equal(unclaimedRecoveryResult.verified, false);
assert.equal(unclaimedRecoveryResult.reason, 'MICROSOFT_STORE_RECOVERY_OWNERSHIP_REQUIRED');
assert.deepEqual(ownershipHarness.events, []);
assert.deepEqual(
  await ownershipHarness.boundary.claimRecoveryOwnership(
    createRecoveryOwnershipInput(
      'player-microsoft-store',
      inAppOfferToken,
      'claimed-recovery',
    ),
  ),
  { status: 'granted', idempotencyKey: 'claimed-recovery' },
);
assert.deepEqual(
  await ownershipHarness.boundary.claimRecoveryOwnership(
    createRecoveryOwnershipInput(
      'player-microsoft-store',
      inAppOfferToken,
      'replacement-generation',
    ),
  ),
  { status: 'denied' },
);
assert.deepEqual(
  await ownershipHarness.boundary.claimRecoveryOwnership(
    createRecoveryOwnershipInput('player-other', inAppOfferToken, 'claimed-recovery'),
  ),
  { status: 'denied' },
);
const claimedRecoveryResult = await ownershipHarness.backend.purchases.verifyPurchase(
  createRequest({ idempotencyKey: 'claimed-recovery' }),
);
assert.equal(claimedRecoveryResult.verified, true);
assert.equal(claimedRecoveryResult.finalization?.status, 'completed');
assert.deepEqual(
  await ownershipHarness.boundary.hasRecoveryOwnership(
    createRecoveryOwnershipInput(
      'player-microsoft-store',
      inAppOfferToken,
      'claimed-recovery',
    ),
  ),
  { status: 'denied' },
);

const unavailableOwnershipHarness = createHarness({
  resolveCredentials() {
    throw new Error('identity unavailable');
  },
});
assert.deepEqual(
  await unavailableOwnershipHarness.boundary.claimRecoveryOwnership(
    createRecoveryOwnershipInput('player-microsoft-store'),
  ),
  { status: 'unavailable' },
);

const unavailableOwnershipStoreHarness = createHarness({
  recoveryOwnershipStore: {
    async claim() {
      throw new Error('ownership store unavailable');
    },
    async get() {
      throw new Error('ownership store unavailable');
    },
    async release() {},
  },
});
assert.deepEqual(
  await unavailableOwnershipStoreHarness.boundary.claimRecoveryOwnership(
    createRecoveryOwnershipInput('player-microsoft-store'),
  ),
  { status: 'unavailable' },
);

let sandboxOwnershipClaimCount = 0;
const sandboxOwnershipHarness = createHarness({
  sandbox: 'XDKS.1',
  recoveryOwnershipStore: {
    async claim(ownership) {
      sandboxOwnershipClaimCount += 1;
      return ownership;
    },
    async get() {
      throw new Error('must not read ownership for unsupported sandbox');
    },
    async release() {},
  },
});
assert.deepEqual(
  await sandboxOwnershipHarness.boundary.claimRecoveryOwnership(
    createRecoveryOwnershipInput('player-microsoft-store'),
  ),
  { status: 'denied' },
);
assert.equal(sandboxOwnershipClaimCount, 0);

const generationOwnershipStore = createInMemoryMicrosoftStoreRecoveryOwnershipStore();
const oldGeneration = {
  accountBindingHash: 'binding-hash',
  storeId,
  playerId: 'player-microsoft-store',
  generation: 'old-generation',
} as const;
const newGeneration = { ...oldGeneration, generation: 'new-generation' } as const;
await generationOwnershipStore.claim(oldGeneration);
await generationOwnershipStore.release(oldGeneration);
await generationOwnershipStore.claim(newGeneration);
await generationOwnershipStore.release(oldGeneration);
assert.deepEqual(await generationOwnershipStore.get(newGeneration), newGeneration);

const completed = createHarness();
const completedResult = await completed.backend.purchases.verifyPurchase(createRequest());
assert.equal(completedResult.verified, true);
assert.equal(completedResult.finalization?.status, 'completed');
assert.equal(completedResult.finalization?.action, 'consume');
assert.deepEqual(completed.events, [
  `provider:query:${storeId}`,
  'ledger:microsoft-store-purchase-1',
  `provider:consume:${storeId}`,
]);

const releaseUnavailable = createHarness({
  recoveryOwnershipStore: {
    async claim(ownership) {
      return ownership;
    },
    async get(ownership) {
      return { ...ownership, generation: 'release-generation' };
    },
    async release() {
      throw new Error('ownership release unavailable');
    },
  },
});
const releaseUnavailableResult = await releaseUnavailable.backend.purchases.verifyPurchase(
  createRequest({ idempotencyKey: 'release-generation' }),
);
assert.equal(releaseUnavailableResult.verified, true);
assert.equal(releaseUnavailableResult.finalization?.status, 'pending');
assert.equal(
  releaseUnavailableResult.finalization?.reason,
  'MICROSOFT_STORE_RECOVERY_OWNERSHIP_RELEASE_UNAVAILABLE',
);
assert.deepEqual(releaseUnavailable.events, [
  `provider:query:${storeId}`,
  'ledger:release-generation',
  `provider:consume:${storeId}`,
]);

const wrongKind = createHarness();
wrongKind.client.queryResponse = {
  items: [
    {
      id: collectionItemId,
      modifiedDate,
      productId: storeId,
      productKind: 'Durable',
      quantity: 1,
      status: 'Active',
    },
  ],
};
const wrongKindResult = await wrongKind.backend.purchases.verifyPurchase(createRequest());
assert.equal(wrongKindResult.verified, false);
assert.equal(wrongKindResult.reason, 'MICROSOFT_STORE_PRODUCT_KIND_MISMATCH');
assert.deepEqual(wrongKind.events, [`provider:query:${storeId}`]);

let missingMappingRejected = false;
try {
  createHarness({ storeIds: { HINT_PACK_120: '9N0000000002' } });
} catch (error) {
  missingMappingRejected = error instanceof TypeError
    && error.message
      === 'Microsoft Store Digital Goods mapping requires a Store ID: HINT_PACK_20';
}
assert.equal(missingMappingRejected, true);

const historicalInAppOfferToken = 'ttokdoku_hint_pack_20_legacy';
const historicalStoreId = '9N0000000000';
const historicalMapping = createHarness({
  historicalProductMappings: {
    HINT_PACK_20: [{
      inAppOfferToken: historicalInAppOfferToken,
      storeId: historicalStoreId,
    }],
  },
});
historicalMapping.client.queryResponse = {
  items: [{
    id: collectionItemId,
    modifiedDate,
    productId: historicalStoreId,
    productKind: 'UnmanagedConsumable',
    quantity: 1,
    status: 'Active',
  }],
};
const historicalMappingResult = await historicalMapping.backend.purchases.verifyPurchase(
  createRequest({
    platformTransactionId: historicalInAppOfferToken,
    idempotencyKey: 'historical-product-mapping',
    evidence: {
      schema: microsoftStoreDigitalGoodsEvidenceSchema,
      payload: {
        itemId: historicalInAppOfferToken,
        purchaseToken: historicalInAppOfferToken,
      },
    },
  }),
);
assert.equal(historicalMappingResult.verified, true);
assert.equal(historicalMappingResult.finalization?.status, 'completed');
assert.deepEqual(historicalMapping.events, [
  `provider:query:${historicalStoreId}`,
  'ledger:historical-product-mapping',
  `provider:consume:${historicalStoreId}`,
]);

const unknownHistoricalToken = createHarness();
const unknownHistoricalTokenResult = await unknownHistoricalToken.backend.purchases.verifyPurchase(
  createRequest({
    platformTransactionId: historicalInAppOfferToken,
    idempotencyKey: 'unknown-historical-product-mapping',
    evidence: {
      schema: microsoftStoreDigitalGoodsEvidenceSchema,
      payload: {
        itemId: historicalInAppOfferToken,
        purchaseToken: historicalInAppOfferToken,
      },
    },
  }),
);
assert.equal(unknownHistoricalTokenResult.verified, false);
assert.equal(
  unknownHistoricalTokenResult.reason,
  'MICROSOFT_STORE_DIGITAL_GOODS_EVIDENCE_REQUIRED',
);
assert.deepEqual(unknownHistoricalToken.events, []);

const notPropagated = createHarness();
notPropagated.client.queryResponse = {};
const notPropagatedResult = await notPropagated.backend.purchases.verifyPurchase(
  createRequest({ idempotencyKey: 'not-propagated' }),
);
assert.equal(notPropagatedResult.verified, false);
assert.equal(notPropagatedResult.reason, 'MICROSOFT_STORE_PURCHASE_NOT_PROPAGATED');
assert.deepEqual(notPropagated.events, [`provider:query:${storeId}`]);

const emptyItems = createHarness();
emptyItems.client.queryResponse = { items: [] };
const emptyItemsResult = await emptyItems.backend.purchases.verifyPurchase(
  createRequest({ idempotencyKey: 'empty-items' }),
);
assert.equal(emptyItemsResult.verified, false);
assert.equal(emptyItemsResult.reason, 'MICROSOFT_STORE_PURCHASE_NOT_PROPAGATED');
assert.deepEqual(emptyItems.events, [`provider:query:${storeId}`]);

const multipleUnits = createHarness();
multipleUnits.client.queryResponse = {
  items: [
    {
      id: collectionItemId,
      modifiedDate,
      productId: storeId,
      productKind: 'UnmanagedConsumable',
      quantity: 2,
      status: 'Active',
    },
  ],
};
const multipleUnitsResult = await multipleUnits.backend.purchases.verifyPurchase(
  createRequest({ idempotencyKey: 'multiple-units' }),
);
assert.equal(multipleUnitsResult.verified, false);
assert.equal(multipleUnitsResult.reason, 'MICROSOFT_STORE_PURCHASE_QUANTITY_MISMATCH');
assert.deepEqual(multipleUnits.events, [`provider:query:${storeId}`]);

const collectionsUnavailable = createHarness();
collectionsUnavailable.client.nextQueryError = new Error('provider unavailable');
const collectionsUnavailableResult = await collectionsUnavailable.backend.purchases.verifyPurchase(
  createRequest({ idempotencyKey: 'collections-unavailable' }),
);
assert.equal(collectionsUnavailableResult.verified, false);
assert.equal(collectionsUnavailableResult.reason, 'MICROSOFT_STORE_COLLECTIONS_UNAVAILABLE');
assert.deepEqual(collectionsUnavailable.events, [`provider:query:${storeId}`]);

const credentialsUnavailable = createHarness({
  resolveCredentials() {
    throw new Error('identity service unavailable');
  },
});
const credentialsUnavailableResult = await credentialsUnavailable.backend.purchases.verifyPurchase(
  createRequest({ idempotencyKey: 'credentials-unavailable' }),
);
assert.equal(credentialsUnavailableResult.verified, false);
assert.equal(credentialsUnavailableResult.reason, 'MICROSOFT_STORE_CREDENTIALS_UNAVAILABLE');
assert.deepEqual(credentialsUnavailable.events, []);

const invalidCredentials = createHarness({
  resolveCredentials: () => ({ ...credentials, accessToken: ' ' }),
});
const invalidCredentialsResult = await invalidCredentials.backend.purchases.verifyPurchase(
  createRequest({ idempotencyKey: 'invalid-credentials' }),
);
assert.equal(invalidCredentialsResult.verified, false);
assert.equal(invalidCredentialsResult.reason, 'MICROSOFT_STORE_CREDENTIALS_INVALID');
assert.deepEqual(invalidCredentials.events, []);

const untrustedToken = createHarness();
const untrustedTokenResult = await untrustedToken.backend.purchases.verifyPurchase(
  createRequest({
    platformTransactionId: 'client-invented-transaction',
  }),
);
assert.equal(untrustedTokenResult.verified, false);
assert.equal(untrustedTokenResult.reason, 'MICROSOFT_STORE_DIGITAL_GOODS_EVIDENCE_REQUIRED');
assert.deepEqual(untrustedToken.events, []);

const sandbox = createHarness({ sandbox: 'XDKS.1' });
const sandboxResult = await sandbox.backend.purchases.verifyPurchase(
  createRequest({ idempotencyKey: 'sandbox-purchase' }),
);
assert.equal(sandboxResult.verified, false);
assert.equal(sandboxResult.reason, 'MICROSOFT_STORE_XSTS_REQUIRED_FOR_SANDBOX');
assert.deepEqual(sandbox.events, []);

let credentialResolutionCount = 0;
const invalidFinalizationCredentials = createHarness({
  resolveCredentials: () => {
    credentialResolutionCount += 1;
    return credentialResolutionCount === 1
      ? credentials
      : { ...credentials, userStoreId: '' };
  },
});
const invalidFinalizationCredentialsResult =
  await invalidFinalizationCredentials.backend.purchases.verifyPurchase(
    createRequest({ idempotencyKey: 'invalid-finalization-credentials' }),
  );
assert.equal(invalidFinalizationCredentialsResult.verified, true);
assert.equal(invalidFinalizationCredentialsResult.finalization?.status, 'pending');
assert.equal(
  invalidFinalizationCredentialsResult.finalization?.reason,
  'MICROSOFT_STORE_CREDENTIALS_INVALID',
);
assert.deepEqual(invalidFinalizationCredentials.events, [
  `provider:query:${storeId}`,
  'ledger:invalid-finalization-credentials',
]);

let changedBindingResolutionCount = 0;
const changedFinalizationBinding = createHarness({
  resolveCredentials: () => {
    changedBindingResolutionCount += 1;
    return changedBindingResolutionCount === 1
      ? credentials
      : { ...credentials, accountBindingId: 'store-account-link-2' };
  },
});
const changedFinalizationBindingResult =
  await changedFinalizationBinding.backend.purchases.verifyPurchase(
    createRequest({ idempotencyKey: 'changed-finalization-binding' }),
  );
assert.equal(changedFinalizationBindingResult.verified, true);
assert.equal(changedFinalizationBindingResult.finalization?.status, 'pending');
assert.equal(
  changedFinalizationBindingResult.finalization?.reason,
  'MICROSOFT_STORE_ACCOUNT_BINDING_CHANGED',
);
assert.deepEqual(changedFinalizationBinding.events, [
  `provider:query:${storeId}`,
  'ledger:changed-finalization-binding',
]);

let renewedUserStoreIdResolutionCount = 0;
const renewedUserStoreId = createHarness({
  resolveCredentials: () => {
    renewedUserStoreIdResolutionCount += 1;
    return renewedUserStoreIdResolutionCount === 1
      ? credentials
      : { ...credentials, userStoreId: 'renewed-user-store-id-for-the-same-account' };
  },
});
const renewedUserStoreIdResult = await renewedUserStoreId.backend.purchases.verifyPurchase(
  createRequest({ idempotencyKey: 'renewed-user-store-id' }),
);
assert.equal(renewedUserStoreIdResult.verified, true);
assert.equal(renewedUserStoreIdResult.finalization?.status, 'completed');
assert.deepEqual(renewedUserStoreId.events, [
  `provider:query:${storeId}`,
  'ledger:renewed-user-store-id',
  `provider:consume:${storeId}`,
]);

const consumeRecovery = createHarness();
consumeRecovery.client.nextConsumeResponse = { malformed: true };
const pendingConsume = await consumeRecovery.backend.purchases.verifyPurchase(
  createRequest({ idempotencyKey: 'consume-recovery-original' }),
);
const { evidence: ignoredRecoveryEvidence, ...evidenceLessRecoveryRequest } = createRequest({
  idempotencyKey: 'consume-recovery-original',
});
void ignoredRecoveryEvidence;
const recoveredConsume = await consumeRecovery.backend.purchases.verifyPurchase(
  evidenceLessRecoveryRequest,
);
assert.equal(pendingConsume.verified, true);
assert.equal(pendingConsume.finalization?.status, 'pending');
assert.equal(recoveredConsume.verified, true);
assert.equal(recoveredConsume.alreadyProcessed, true);
assert.equal(recoveredConsume.finalization?.status, 'completed');
assert.deepEqual(consumeRecovery.events, [
  `provider:query:${storeId}`,
  'ledger:consume-recovery-original',
  `provider:consume:${storeId}`,
  `provider:consume:${storeId}`,
]);
assert.equal(consumeRecovery.client.consumeTrackingIds.length, 2);
assert.equal(
  consumeRecovery.client.consumeTrackingIds[0],
  consumeRecovery.client.consumeTrackingIds[1],
);

const migratedStoreEvents: string[] = [];
const beforeStoreIdMigration = createHarness({ events: migratedStoreEvents });
beforeStoreIdMigration.client.nextConsumeResponse = { malformed: true };
const beforeStoreIdMigrationResult = await beforeStoreIdMigration.backend.purchases.verifyPurchase(
  createRequest({ idempotencyKey: 'store-id-migration' }),
);
const afterStoreIdMigration = createHarness({
  events: migratedStoreEvents,
  store: beforeStoreIdMigration.store,
  storeIds: { HINT_PACK_20: '9N0000000009' },
});
const afterStoreIdMigrationResult = await afterStoreIdMigration.backend.purchases.verifyPurchase(
  createRequest({ idempotencyKey: 'store-id-migration' }),
);
assert.equal(beforeStoreIdMigrationResult.finalization?.status, 'pending');
assert.equal(afterStoreIdMigrationResult.verified, true);
assert.equal(afterStoreIdMigrationResult.alreadyProcessed, true);
assert.equal(afterStoreIdMigrationResult.finalization?.status, 'completed');
assert.deepEqual(migratedStoreEvents, [
  `provider:query:${storeId}`,
  'ledger:store-id-migration',
  `provider:consume:${storeId}`,
  `provider:consume:${storeId}`,
]);

const offerTokenMigrationEvents: string[] = [];
const legacyCatalog = {
  ...catalog,
  products: [{
    ...catalog.products[0],
    platformProductIds: { 'microsoft-store': historicalInAppOfferToken },
  }],
} satisfies ProductCatalog;
const beforeOfferTokenMigration = createHarness({
  events: offerTokenMigrationEvents,
  catalog: legacyCatalog,
  storeIds: { HINT_PACK_20: historicalStoreId },
});
beforeOfferTokenMigration.client.queryResponse = {
  items: [{
    id: collectionItemId,
    modifiedDate,
    productId: historicalStoreId,
    productKind: 'UnmanagedConsumable',
    quantity: 1,
    status: 'Active',
  }],
};
beforeOfferTokenMigration.client.nextConsumeResponse = { malformed: true };
const beforeOfferTokenMigrationResult =
  await beforeOfferTokenMigration.backend.purchases.verifyPurchase(createRequest({
    platformTransactionId: historicalInAppOfferToken,
    idempotencyKey: 'offer-token-migration-original',
    evidence: {
      schema: microsoftStoreDigitalGoodsEvidenceSchema,
      payload: {
        itemId: historicalInAppOfferToken,
        purchaseToken: historicalInAppOfferToken,
      },
    },
  }));
const afterOfferTokenMigration = createHarness({
  events: offerTokenMigrationEvents,
  store: beforeOfferTokenMigration.store,
  historicalProductMappings: {
    HINT_PACK_20: [{
      inAppOfferToken: historicalInAppOfferToken,
      storeId: historicalStoreId,
    }],
  },
});
afterOfferTokenMigration.client.queryResponse = structuredClone(
  beforeOfferTokenMigration.client.queryResponse,
);
const afterOfferTokenMigrationResult =
  await afterOfferTokenMigration.backend.purchases.verifyPurchase(createRequest({
    platformTransactionId: historicalInAppOfferToken,
    idempotencyKey: 'offer-token-migration-recovery',
    evidence: {
      schema: microsoftStoreDigitalGoodsEvidenceSchema,
      payload: {
        itemId: historicalInAppOfferToken,
        purchaseToken: historicalInAppOfferToken,
      },
    },
  }));
assert.equal(beforeOfferTokenMigrationResult.finalization?.status, 'pending');
assert.equal(afterOfferTokenMigrationResult.verified, true);
assert.equal(afterOfferTokenMigrationResult.alreadyProcessed, true);
assert.equal(afterOfferTokenMigrationResult.finalization?.status, 'completed');
assert.deepEqual(offerTokenMigrationEvents, [
  `provider:query:${historicalStoreId}`,
  'ledger:offer-token-migration-original',
  `provider:consume:${historicalStoreId}`,
  `provider:query:${historicalStoreId}`,
  `provider:consume:${historicalStoreId}`,
]);

let duplicateStoreIdRejected = false;
try {
  createMicrosoftStorePurchaseBoundary({
    client: new FixtureCollectionsClient([]),
    inAppOfferTokens: {
      HINT_PACK_20: inAppOfferToken,
      HINT_PACK_120: 'ttokdoku_hint_pack_120',
    },
    storeIds: {
      HINT_PACK_20: storeId,
      HINT_PACK_120: storeId,
    },
    resolveCredentials: () => credentials,
    recoveryOwnershipStore: createInMemoryMicrosoftStoreRecoveryOwnershipStore(),
  });
} catch (error) {
  duplicateStoreIdRejected = error instanceof TypeError
    && error.message === `Duplicate Microsoft Store product mapping: ${storeId}`;
}
assert.equal(duplicateStoreIdRejected, true);

let duplicateHistoricalTokenRejected = false;
try {
  createMicrosoftStorePurchaseBoundary({
    client: new FixtureCollectionsClient([]),
    inAppOfferTokens: {
      HINT_PACK_20: inAppOfferToken,
      HINT_PACK_120: 'ttokdoku_hint_pack_120',
    },
    storeIds: {
      HINT_PACK_20: storeId,
      HINT_PACK_120: '9N0000000120',
    },
    historicalProductMappings: {
      HINT_PACK_20: [{
        inAppOfferToken: 'ttokdoku_hint_pack_120',
        storeId: historicalStoreId,
      }],
    },
    resolveCredentials: () => credentials,
    recoveryOwnershipStore: createInMemoryMicrosoftStoreRecoveryOwnershipStore(),
  });
} catch (error) {
  duplicateHistoricalTokenRejected = error instanceof TypeError
    && error.message
      === 'Duplicate Microsoft Store Digital Goods mapping: ttokdoku_hint_pack_120';
}
assert.equal(duplicateHistoricalTokenRejected, true);

const requests: {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Record<string, unknown>;
}[] = [];
const httpClient = createMicrosoftStoreCollectionsClient({
  userAgent: 'mpgd-game-services-test',
  fetch: async (url, init) => {
    requests.push({
      url,
      headers: init.headers,
      body: JSON.parse(init.body) as Record<string, unknown>,
    });
    return {
      status: 200,
      body: new Response(url === microsoftStoreCollectionsQueryUrl
        ? JSON.stringify({ items: [] })
        : JSON.stringify({
            itemId: collectionItemId,
            productId: storeId,
            trackingId: '12345678-1234-5234-9234-123456789abc',
            newQuantity: 0,
          })).body,
    };
  },
});
await httpClient.queryProduct({ credentials, storeId, signal: new AbortController().signal });
await httpClient.consumeProduct({
  credentials,
  storeId,
  trackingId: '12345678-1234-5234-9234-123456789abc',
  signal: new AbortController().signal,
});
assert.equal(requests[0]?.url, microsoftStoreCollectionsQueryUrl);
assert.equal(requests[1]?.url, microsoftStoreCollectionsConsumeUrl);
assert.equal(requests[0]?.headers.authorization, 'Bearer entra-service-token');
assert.deepEqual(requests[0]?.body.beneficiaries, [
  {
    identityType: 'b2b',
    identityValue: 'server-resolved-user-store-id',
    localTicketReference: '',
  },
]);
assert.equal(
  (requests[1]?.body.beneficiary as Record<string, unknown> | undefined)?.identityValue,
  'server-resolved-user-store-id',
);
assert.equal(requests[1]?.body.skuId, undefined);
assert.equal(requests[1]?.body.removeQuantity, undefined);

console.log('Microsoft Store purchase boundary tests passed.');
