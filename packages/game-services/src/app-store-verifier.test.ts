import {
  AppStoreDependencyUnavailableError,
  appStoreSignedTransactionEvidenceSchema,
  createAppStoreGameServicesEvidenceVerifier,
  createAppStoreServerApiClient,
  createAppStoreSignedTransactionEvidence,
  createAppStoreVerificationId,
  createInMemoryAppStoreRevocationRegistry,
  isAppStoreVerificationId,
  type AppStoreRevocationLookup,
  type AppStoreRevocationRecord,
  type AppStoreServerApiClient,
  type AppStoreSignedTransactionEvidencePolicy,
  type AppStoreSignedTransactionVerifier,
  type AppStoreTransactionPayload,
} from './app-store-verifier';
import {
  appStoreConformanceSignedTransaction,
  createAppStoreSignedTransactionEvidenceFixture,
  createAppStoreTransactionConformanceFixture,
} from './app-store-verifier-conformance';
import type { VerifyPurchaseEvidenceInput } from './evidence-verification';

const controller = new AbortController();
const purchaseDate = Date.parse('2026-07-16T12:00:00.000Z');
const signedDate = Date.parse('2026-07-16T12:00:01.000Z');

const baseInput = {
  request: {
    target: 'ios',
    playerId: 'player-1',
    productId: 'COINS_100',
    platformTransactionId: '2000000123456789',
    idempotencyKey: 'purchase-app-store-1',
    purchasedAt: '2026-07-16T12:00:00.000Z',
  },
  product: {
    id: 'COINS_100',
    type: 'consumable',
    grant: {
      type: 'currency',
      currency: 'coin',
      amount: 100,
    },
    platformProductIds: {
      ios: 'com.example.game.coins100',
    },
  },
  platformProductId: 'com.example.game.coins100',
  signal: controller.signal,
  timeoutMs: 1_000,
} satisfies VerifyPurchaseEvidenceInput;

const baseTransaction = createAppStoreTransactionConformanceFixture({
  transactionId: baseInput.request.platformTransactionId,
  originalTransactionId: '2000000123456000',
  bundleId: 'com.example.game',
  productId: baseInput.platformProductId,
  purchaseDate,
  signedDate,
  environment: 'Production',
  type: 'Consumable',
  quantity: 1,
  appAccountToken: 'f15f2ed7-f92a-4c5a-90e1-15d26cd729f2',
}) satisfies AppStoreTransactionPayload;

const defaultConformanceTransaction = createAppStoreTransactionConformanceFixture();
assertEqual(
  defaultConformanceTransaction.purchaseDate,
  Date.parse('2020-01-02T03:04:05.000Z'),
  'the deterministic conformance baseline must not default to a future purchase date',
);

let requestedUrl = '';
let requestedAuthorization = '';
const serverApiClient = createAppStoreServerApiClient({
  getBearerToken: () => 'signed-provider-jwt',
  async fetch(url, init) {
    requestedUrl = url;
    requestedAuthorization = init.headers.authorization ?? '';
    return new Response(JSON.stringify({ signedTransactionInfo: 'signed-transaction-jws' }), {
      status: 200,
    });
  },
});

const apiResult = await serverApiClient.getTransactionInfo({
  transactionId: baseInput.request.platformTransactionId,
  environment: 'Production',
  signal: controller.signal,
});
assertEqual(apiResult.status, 'found', 'the Server API client should decode a found response');
assertEqual(
  requestedUrl,
  `https://api.storekit.apple.com/inApps/v1/transactions/${baseInput.request.platformTransactionId}`,
  'the production client should use the official transaction endpoint',
);
assertEqual(
  requestedAuthorization,
  'Bearer signed-provider-jwt',
  'the Server API client should use a runtime-generated bearer token',
);

const verifier = createVerifier({
  serverApi: serverApiClient,
  signedTransactionVerifier: createSignedTransactionVerifier(baseTransaction),
});
const verified = await verifier.verifyPurchase(baseInput);
assertEqual(verified.status, 'verified', 'a valid signed App Store transaction should verify');
if (verified.status !== 'verified') {
  throw new Error('Expected the valid App Store fixture to verify.');
}
assertEqual(
  verified.verificationId,
  '9:app-store:10:Production:16:com.example.game:16:2000000123456789',
  'the verification identity should be stable and transaction-scoped',
);
assertEqual(
  isAppStoreVerificationId(verified.verificationId),
  true,
  'recovery should recognize the canonical length-prefixed App Store identity',
);
assertEqual(
  isAppStoreVerificationId('app-store:Production:com.example.game:2000000123456789'),
  false,
  'recovery must not accept the legacy unencoded identity fixture',
);
for (const invalidId of [
  '9:app-store:invalid',
  '9:app-store:10:Production:16:com.example.game:16:2000000123456789:extra',
  '8:app-store:10:Production:16:com.example.game:16:2000000123456789',
  '9:app-store:10:Production:16:com.example.game:3:abc',
]) {
  assertEqual(
    isAppStoreVerificationId(invalidId),
    false,
    'recovery must reject malformed or incomplete App Store ledger identities',
  );
}
assertEqual(
  verified.payload?.appStoreOriginalTransactionId,
  baseTransaction.originalTransactionId,
  'verified evidence should retain the original transaction identity',
);
assertEqual(
  verified.payload?.appStorePurchaseDate,
  purchaseDate,
  "verified evidence should retain Apple's signed purchase date as provider authority",
);
assertEqual(
  verified.payload?.appStoreQuantity,
  1,
  'verified evidence should retain the single signed grant quantity',
);

const replayed = await verifier.verifyPurchase(baseInput);
assertEqual(
  replayed.status === 'verified' ? replayed.verificationId : '',
  verified.verificationId,
  'retries should return the same provider verification identity',
);

const nonConsumableProductId = 'com.example.game.removeads';
const nonConsumableOriginalTransactionId = '2000000123457000';
const firstNonConsumableInput = {
  ...baseInput,
  request: {
    ...baseInput.request,
    productId: 'REMOVE_ADS',
    platformTransactionId: '2000000123457001',
    idempotencyKey: 'purchase-app-store-remove-ads-1',
  },
  product: {
    ...baseInput.product,
    id: 'REMOVE_ADS',
    type: 'non_consumable',
    platformProductIds: { ios: nonConsumableProductId },
  },
  platformProductId: nonConsumableProductId,
} satisfies VerifyPurchaseEvidenceInput;
const restoredNonConsumableInput = {
  ...firstNonConsumableInput,
  request: {
    ...firstNonConsumableInput.request,
    platformTransactionId: '2000000123457002',
    idempotencyKey: 'purchase-app-store-remove-ads-restore',
  },
} satisfies VerifyPurchaseEvidenceInput;
const firstNonConsumable = await createVerifier({
  transaction: {
    ...baseTransaction,
    transactionId: firstNonConsumableInput.request.platformTransactionId,
    originalTransactionId: nonConsumableOriginalTransactionId,
    productId: nonConsumableProductId,
    type: 'Non-Consumable',
  },
}).verifyPurchase(firstNonConsumableInput);
const restoredNonConsumable = await createVerifier({
  transaction: {
    ...baseTransaction,
    transactionId: restoredNonConsumableInput.request.platformTransactionId,
    originalTransactionId: nonConsumableOriginalTransactionId,
    productId: nonConsumableProductId,
    type: 'Non-Consumable',
  },
}).verifyPurchase(restoredNonConsumableInput);
assertEqual(
  firstNonConsumable.status,
  'verified',
  'the original non-consumable transaction should verify',
);
assertEqual(
  restoredNonConsumable.status,
  'verified',
  'a restored non-consumable transaction should verify as the same grant identity',
);
assertEqual(
  restoredNonConsumable.status === 'verified' ? restoredNonConsumable.verificationId : '',
  firstNonConsumable.status === 'verified' ? firstNonConsumable.verificationId : '',
  'restored non-consumables must dedupe by the original transaction identity',
);

const rejectedSignature = await createVerifier({
  signedTransactionVerifier: {
    async verifyAndDecode() {
      return { status: 'rejected', reason: 'APP_STORE_SIGNATURE_INVALID' };
    },
  },
}).verifyPurchase(baseInput);
assertDecision(
  rejectedSignature,
  'rejected',
  'APP_STORE_SIGNATURE_INVALID',
  'invalid JWS signatures must fail closed',
);

const malformedVerifiedPayload = await createVerifier({
  signedTransactionVerifier: {
    async verifyAndDecode() {
      return { status: 'verified', payload: {} as AppStoreTransactionPayload };
    },
  },
}).verifyPurchase(baseInput);
assertDecision(
  malformedVerifiedPayload,
  'rejected',
  'APP_STORE_SIGNATURE_RESULT_INVALID',
  'a malformed payload returned as signature-verified must fail closed permanently',
);

const wrongAccount = await createVerifier({
  transaction: {
    ...baseTransaction,
    appAccountToken: 'c3353250-0bd1-4424-bc84-b119868d85f0',
  },
}).verifyPurchase(baseInput);
assertDecision(
  wrongAccount,
  'rejected',
  'APP_STORE_ACCOUNT_TOKEN_MISMATCH',
  'signed transactions must bind to the expected game account',
);
// Another account's valid purchase is reported as that account's (RFC
// "Another account's purchase"): the backend answers it as a retryable error.
assertEqual(
  wrongAccount.status === 'rejected' ? wrongAccount.anotherAccount : undefined,
  true,
  "a transaction bound to another token is another account's purchase",
);
// Every other check still decides first: a revoked transaction of another
// account is refused for every player.
const revokedWrongAccount = await createVerifier({
  transaction: {
    ...baseTransaction,
    appAccountToken: 'c3353250-0bd1-4424-bc84-b119868d85f0',
    revocationDate: baseTransaction.purchaseDate + 1_000,
  },
}).verifyPurchase(baseInput);
assertDecision(
  revokedWrongAccount,
  'rejected',
  'APP_STORE_TRANSACTION_REVOKED',
  "a revoked transaction of another account is refused, not reported as that account's",
);
assertEqual(
  revokedWrongAccount.status === 'rejected' ? revokedWrongAccount.anotherAccount : undefined,
  undefined,
  "a refused transaction is not another account's purchase",
);

const missingAccount = await createVerifier({
  transaction: createAppStoreTransactionConformanceFixture({
    ...baseTransaction,
    includeAppAccountToken: false,
  }),
}).verifyPurchase(baseInput);
assertDecision(
  missingAccount,
  'rejected',
  'APP_STORE_ACCOUNT_TOKEN_MISSING',
  'a signed transaction without the required account binding must fail closed',
);
assertEqual(
  missingAccount.status === 'rejected' ? missingAccount.anotherAccount : undefined,
  undefined,
  "a transaction without a token is no account's purchase",
);

const canonicalAccountToken = await createVerifier({
  transaction: {
    ...baseTransaction,
    appAccountToken: 'F15F2ED7-F92A-4C5A-90E1-15D26CD729F2',
  },
}).verifyPurchase(baseInput);
assertEqual(
  canonicalAccountToken.status,
  'verified',
  'UUID account identity comparison should be canonical and case-insensitive',
);

await assertRejects(
  () => createVerifier({
    resolveAppAccountToken: () => 'not-a-uuid',
  }).verifyPurchase(baseInput),
  'appAccountToken must be a UUID',
  'invalid server-side account configuration must surface as a verifier error',
);

const unavailableAccountBinding = await createVerifier({
  resolveAppAccountToken() {
    throw new AppStoreDependencyUnavailableError('account binding store unavailable');
  },
}).verifyPurchase(baseInput);
assertDecision(
  unavailableAccountBinding,
  'pending',
  'APP_STORE_ACCOUNT_BINDING_UNAVAILABLE',
  'an explicit account-binding outage should remain retryable without granting',
);

const wrongProduct = await createVerifier({
  transaction: {
    ...baseTransaction,
    productId: 'com.example.game.removeads',
  },
}).verifyPurchase(baseInput);
assertDecision(
  wrongProduct,
  'rejected',
  'APP_STORE_PRODUCT_ID_MISMATCH',
  'signed products must match the configured catalog product',
);

const differentClientObservationTime = await verifier.verifyPurchase({
  ...baseInput,
  request: {
    ...baseInput.request,
    purchasedAt: '2026-07-16T12:45:00.000Z',
  },
});
assertEqual(
  differentClientObservationTime.status,
  'verified',
  'the signed provider purchase date must remain authoritative over client observation time',
);
if (differentClientObservationTime.status !== 'verified') {
  throw new Error('Expected a valid client observation time to preserve provider authority.');
}
assertEqual(
  differentClientObservationTime.payload?.appStorePurchaseDate,
  purchaseDate,
  'client observation time must not replace the signed provider purchase date',
);

const invalidClientObservationTime = await verifier.verifyPurchase({
  ...baseInput,
  request: {
    ...baseInput.request,
    purchasedAt: 'not-a-timestamp',
  },
});
assertDecision(
  invalidClientObservationTime,
  'rejected',
  'APP_STORE_CLIENT_PURCHASE_TIME_INVALID',
  'malformed client observation time must fail closed without replacing provider authority',
);

const futureClientObservationTime = await verifier.verifyPurchase({
  ...baseInput,
  request: {
    ...baseInput.request,
    purchasedAt: '2026-07-16T13:10:00.000Z',
  },
});
assertDecision(
  futureClientObservationTime,
  'rejected',
  'APP_STORE_CLIENT_PURCHASE_TIME_IN_FUTURE',
  'client observation time beyond the configured clock skew must fail closed',
);

const revoked = await createVerifier({
  transaction: {
    ...baseTransaction,
    revocationDate: Date.parse('2026-07-16T12:30:00.000Z'),
  },
}).verifyPurchase(baseInput);
assertDecision(
  revoked,
  'rejected',
  'APP_STORE_TRANSACTION_REVOKED',
  'revoked transactions must never authorize a grant',
);

const upgraded = await createVerifier({
  transaction: {
    ...baseTransaction,
    isUpgraded: true,
  },
}).verifyPurchase(baseInput);
assertDecision(
  upgraded,
  'rejected',
  'APP_STORE_TRANSACTION_UPGRADED',
  'upgraded transactions must never authorize the replaced grant',
);

const expired = await createVerifier({
  transaction: {
    ...baseTransaction,
    expiresDate: Date.parse('2026-07-16T12:30:00.000Z'),
  },
}).verifyPurchase(baseInput);
assertDecision(
  expired,
  'rejected',
  'APP_STORE_TRANSACTION_EXPIRED',
  'expired transaction state must never authorize a grant',
);

const futurePurchase = await createVerifier({
  transaction: createAppStoreTransactionConformanceFixture({
    ...baseTransaction,
    purchaseDate: Date.parse('2026-07-16T13:10:00.000Z'),
    signedDate: Date.parse('2026-07-16T13:10:01.000Z'),
  }),
}).verifyPurchase(baseInput);
assertDecision(
  futurePurchase,
  'rejected',
  'APP_STORE_PURCHASE_DATE_IN_FUTURE',
  'provider purchase dates beyond the allowed clock skew must fail closed',
);

const futureSignature = await createVerifier({
  transaction: {
    ...baseTransaction,
    signedDate: Date.parse('2026-07-16T13:10:00.000Z'),
  },
}).verifyPurchase(baseInput);
assertDecision(
  futureSignature,
  'rejected',
  'APP_STORE_SIGNED_DATE_IN_FUTURE',
  'provider signatures beyond the allowed clock skew must fail closed',
);

const multipleQuantity = await createVerifier({
  transaction: {
    ...baseTransaction,
    quantity: 2,
  },
}).verifyPurchase(baseInput);
assertDecision(
  multipleQuantity,
  'rejected',
  'APP_STORE_QUANTITY_UNSUPPORTED',
  'multiple-item purchases must not receive a single static catalog grant',
);

const missingQuantity = await createVerifier({
  transaction: createAppStoreTransactionConformanceFixture({
    ...baseTransaction,
    includeQuantity: false,
  }),
}).verifyPurchase(baseInput);
assertEqual(
  missingQuantity.status,
  'verified',
  "an omitted optional quantity should preserve StoreKit's default single purchase",
);
assertEqual(
  missingQuantity.status === 'verified' ? missingQuantity.payload?.appStoreQuantity : 0,
  1,
  'an omitted optional quantity should record one effective catalog grant',
);

let subscriptionServerApiCalled = false;
const unsupportedSubscription = await createVerifier({
  serverApi: {
    async getTransactionInfo() {
      subscriptionServerApiCalled = true;
      return { status: 'found', signedTransactionInfo: 'unexpected' };
    },
  },
}).verifyPurchase({
  ...baseInput,
  product: {
    ...baseInput.product,
    type: 'subscription',
  },
});
assertDecision(
  unsupportedSubscription,
  'rejected',
  'APP_STORE_SUBSCRIPTION_UNSUPPORTED',
  'subscriptions require a lifecycle-aware ledger instead of a durable one-time grant',
);
assertEqual(
  subscriptionServerApiCalled,
  false,
  'unsupported subscriptions should fail before provider authorization is requested',
);

const retryable = await createVerifier({
  serverApi: {
    async getTransactionInfo() {
      return { status: 'pending', reason: 'APP_STORE_SERVER_API_UNAVAILABLE' };
    },
  },
}).verifyPurchase(baseInput);
assertDecision(
  retryable,
  'pending',
  'APP_STORE_SERVER_API_UNAVAILABLE',
  'retryable provider failures should not authorize a grant',
);

await assertRejects(
  () => createVerifier({
    serverApi: {
      async getTransactionInfo() {
        throw new Error('server API adapter bug');
      },
    },
  }).verifyPurchase(baseInput),
  'server API adapter bug',
  'unexpected Server API adapter errors must not be hidden as retryable outages',
);

const unavailableSignatureVerifier = await createVerifier({
  signedTransactionVerifier: {
    async verifyAndDecode() {
      throw new AppStoreDependencyUnavailableError('signature verifier unavailable');
    },
  },
}).verifyPurchase(baseInput);
assertDecision(
  unavailableSignatureVerifier,
  'pending',
  'APP_STORE_SIGNATURE_VERIFIER_UNAVAILABLE',
  'an explicit signature-verifier outage should remain retryable without granting',
);

const wrongTarget = await verifier.verifyPurchase({
  ...baseInput,
  request: {
    ...baseInput.request,
    target: 'android',
  },
});
assertDecision(
  wrongTarget,
  'rejected',
  'APP_STORE_TARGET_MISMATCH',
  'the App Store verifier must reject non-iOS evidence',
);

const adReward = await verifier.verifyAdReward({
  request: {
    target: 'ios',
    playerId: 'player-1',
    placementId: 'CONTINUE_AFTER_FAIL',
    platformImpressionId: 'impression-1',
    idempotencyKey: 'reward-1',
    completedAt: '2026-07-16T12:00:00.000Z',
  },
  placement: {
    id: 'CONTINUE_AFTER_FAIL',
    type: 'rewarded',
    reward: { type: 'continue', amount: 1 },
    frequencyCap: { cooldownSeconds: 0 },
    platformPlacementIds: { ios: 'rewarded-continue' },
  },
  platformPlacementId: 'rewarded-continue',
  signal: controller.signal,
  timeoutMs: 1_000,
});
assertDecision(
  adReward,
  'rejected',
  'APP_STORE_AD_REWARD_UNSUPPORTED',
  'the purchase verifier must not accept ad callbacks',
);

const rateLimitedClient = createAppStoreServerApiClient({
  getBearerToken: () => 'signed-provider-jwt',
  async fetch() {
    return new Response('{}', { status: 429 });
  },
});
const malformedJsonClient = createAppStoreServerApiClient({
  getBearerToken: () => 'signed-provider-jwt',
  async fetch() {
    return new Response('{', { status: 200 });
  },
});
const malformedJson = await malformedJsonClient.getTransactionInfo({
  transactionId: baseInput.request.platformTransactionId,
  environment: 'Production',
  signal: controller.signal,
});
assertDecision(
  malformedJson,
  'pending',
  'APP_STORE_SERVER_API_INVALID_RESPONSE',
  'a truncated App Store 200 response should remain retryable without granting',
);

const missingSignedTransactionClient = createAppStoreServerApiClient({
  getBearerToken: () => 'signed-provider-jwt',
  async fetch() {
    return new Response('{}', { status: 200 });
  },
});
const missingSignedTransaction = await missingSignedTransactionClient.getTransactionInfo({
  transactionId: baseInput.request.platformTransactionId,
  environment: 'Production',
  signal: controller.signal,
});
assertDecision(
  missingSignedTransaction,
  'pending',
  'APP_STORE_SERVER_API_INVALID_RESPONSE',
  'an App Store 200 response without signedTransactionInfo should remain retryable',
);

let rateLimitBodyCancelled = false;
const cancellingRateLimitedClient = createAppStoreServerApiClient({
  getBearerToken: () => 'signed-provider-jwt',
  async fetch() {
    return {
      status: 429,
      body: new ReadableStream({
        cancel() {
          rateLimitBodyCancelled = true;
        },
      }),
    };
  },
});
const rateLimited = await rateLimitedClient.getTransactionInfo({
  transactionId: baseInput.request.platformTransactionId,
  environment: 'Sandbox',
  signal: controller.signal,
});
assertDecision(
  rateLimited,
  'pending',
  'APP_STORE_SERVER_API_UNAVAILABLE',
  'rate limits should be represented as retryable without trusting the client',
);
await cancellingRateLimitedClient.getTransactionInfo({
  transactionId: baseInput.request.platformTransactionId,
  environment: 'Sandbox',
  signal: controller.signal,
});
assertEqual(
  rateLimitBodyCancelled,
  true,
  'non-200 App Store response bodies must be cancelled before returning',
);

let missingTransactionBodyCancelled = false;
const missingTransactionClient = createAppStoreServerApiClient({
  getBearerToken: () => 'signed-provider-jwt',
  async fetch() {
    return {
      status: 404,
      body: new ReadableStream({
        cancel() {
          missingTransactionBodyCancelled = true;
        },
      }),
    };
  },
});
const missingTransaction = await missingTransactionClient.getTransactionInfo({
  transactionId: baseInput.request.platformTransactionId,
  environment: 'Production',
  signal: controller.signal,
});
assertDecision(
  missingTransaction,
  'pending',
  'APP_STORE_TRANSACTION_NOT_FOUND',
  'a fresh App Store transaction miss should remain retryable',
);
assertEqual(
  missingTransactionBodyCancelled,
  true,
  'not-found App Store response bodies must be cancelled before returning',
);

const unavailableTokenVerifier = createVerifier({
  serverApi: createAppStoreServerApiClient({
    getBearerToken() {
      throw new AppStoreDependencyUnavailableError('token signing dependency unavailable');
    },
  }),
});
const unavailableToken = await unavailableTokenVerifier.verifyPurchase(baseInput);
assertDecision(
  unavailableToken,
  'pending',
  'APP_STORE_SERVER_API_UNAVAILABLE',
  'an explicitly transient bearer-token provider outage should remain retryable',
);

await assertRejects(
  () => createVerifier({
    serverApi: createAppStoreServerApiClient({
      getBearerToken() {
        throw new Error('token provider configuration bug');
      },
    }),
  }).verifyPurchase(baseInput),
  'token provider configuration bug',
  'permanent bearer-token provider errors must escape the retryable outage path',
);

const tokenAbortController = new AbortController();
tokenAbortController.abort(new Error('token caller cancelled'));
await assertRejects(
  () => createVerifier({
    serverApi: createAppStoreServerApiClient({
      getBearerToken({ signal }) {
        throw signal.reason;
      },
    }),
  }).verifyPurchase({
    ...baseInput,
    signal: tokenAbortController.signal,
  }),
  'token caller cancelled',
  'bearer-token generation must receive and propagate caller cancellation',
);

const transportFailureVerifier = createVerifier({
  serverApi: createAppStoreServerApiClient({
    getBearerToken: () => 'signed-provider-jwt',
    async fetch() {
      throw new TypeError('network unavailable');
    },
  }),
});
const transportFailure = await transportFailureVerifier.verifyPurchase(baseInput);
assertDecision(
  transportFailure,
  'pending',
  'APP_STORE_SERVER_API_UNAVAILABLE',
  'the built-in transport should classify network failures as explicit retryable outages',
);

const abortedController = new AbortController();
abortedController.abort(new Error('caller cancelled'));
const abortedTransportVerifier = createVerifier({
  serverApi: createAppStoreServerApiClient({
    getBearerToken: () => 'signed-provider-jwt',
    async fetch(_url, init) {
      throw init.signal.reason;
    },
  }),
});
await assertRejects(
  () =>
    abortedTransportVerifier.verifyPurchase({
      ...baseInput,
      signal: abortedController.signal,
    }),
  'caller cancelled',
  'caller cancellation must propagate instead of becoming a retryable provider outage',
);

const streamingAbortController = new AbortController();
const streamingAbortVerifier = createVerifier({
  serverApi: createAppStoreServerApiClient({
    getBearerToken: () => 'signed-provider-jwt',
    async fetch() {
      return {
        status: 200,
        body: new ReadableStream({
          pull(streamController) {
            streamingAbortController.abort(new Error('stream caller cancelled'));
            streamController.error(streamingAbortController.signal.reason);
          },
        }),
      };
    },
  }),
});
await assertRejects(
  () =>
    streamingAbortVerifier.verifyPurchase({
      ...baseInput,
      signal: streamingAbortController.signal,
    }),
  'stream caller cancelled',
  'cancellation during response streaming must propagate instead of becoming retryable',
);

const interruptedStreamVerifier = createVerifier({
  serverApi: createAppStoreServerApiClient({
    getBearerToken: () => 'signed-provider-jwt',
    async fetch() {
      return {
        status: 200,
        body: new ReadableStream({
          start(streamController) {
            streamController.error(new TypeError('response stream disconnected'));
          },
        }),
      };
    },
  }),
});
const interruptedStream = await interruptedStreamVerifier.verifyPurchase(baseInput);
assertDecision(
  interruptedStream,
  'pending',
  'APP_STORE_SERVER_API_UNAVAILABLE',
  'response-stream transport failures should remain explicitly retryable',
);

const invalidAuthorizationClient = createAppStoreServerApiClient({
  getBearerToken: () => 'invalid bearer token',
  async fetch() {
    throw new Error('fetch must not run for invalid authorization');
  },
});
await assertRejects(
  () =>
    invalidAuthorizationClient.getTransactionInfo({
      transactionId: baseInput.request.platformTransactionId,
      environment: 'Production',
      signal: controller.signal,
    }),
  'must not contain whitespace',
  'invalid bearer-token configuration must not be hidden as a transient network failure',
);

let oversizedStreamCancelled = false;
const oversizedClient = createAppStoreServerApiClient({
  getBearerToken: () => 'signed-provider-jwt',
  maxResponseBytes: 8,
  async fetch() {
    return {
      status: 200,
      body: new ReadableStream({
        start(streamController) {
          streamController.enqueue(
            new TextEncoder().encode(JSON.stringify({ signedTransactionInfo: 'too-large' })),
          );
        },
        cancel() {
          oversizedStreamCancelled = true;
        },
      }),
    };
  },
});
const oversizedResponse = await oversizedClient.getTransactionInfo({
  transactionId: baseInput.request.platformTransactionId,
  environment: 'Production',
  signal: controller.signal,
});
assertDecision(
  oversizedResponse,
  'pending',
  'APP_STORE_SERVER_API_INVALID_RESPONSE',
  'the Server API client must contain oversized response failures without authorizing a grant',
);
assertEqual(
  oversizedStreamCancelled,
  true,
  'the Server API client must cancel an oversized response stream before releasing it',
);

// Commerce v2 (RFC B3): `app-store.signed-transaction.v1` evidence is verified
// offline through the signed-transaction verifier; the Server API is the
// fallback for requests without it.
{
  const clientJws = appStoreConformanceSignedTransaction;
  const evidenceInput = {
    ...baseInput,
    request: {
      ...baseInput.request,
      evidence: createAppStoreSignedTransactionEvidenceFixture({
        transactionId: baseInput.request.platformTransactionId,
        originalTransactionId: baseTransaction.originalTransactionId,
        bundleId: baseTransaction.bundleId,
      }),
    },
  } satisfies VerifyPurchaseEvidenceInput;
  assertEqual(
    evidenceInput.request.evidence.schema,
    appStoreSignedTransactionEvidenceSchema,
    'the fixture envelope uses the published evidence schema',
  );
  assertEqual(
    evidenceInput.request.evidence.payload.signedTransaction,
    clientJws,
    'the fixture envelope carries the placeholder JWS',
  );

  const freshJws = 'signed-transaction-jws';
  /**
   * A verifier whose signature port decodes the client JWS to `client` and
   * the Server API JWS to `fresh` (both default to the base transaction), and
   * whose Server API answers `found` unless `serverApi` overrides it.
   */
  function createOfflineHarness(input: {
    readonly client?: AppStoreTransactionPayload;
    readonly fresh?: AppStoreTransactionPayload;
    readonly policy?: AppStoreSignedTransactionEvidencePolicy;
    readonly serverApi?: AppStoreServerApiClient;
  } = {}): {
    readonly verifier: ReturnType<typeof createVerifier>;
    readonly serverApiCalls: string[];
    readonly verifiedJws: string[];
  } {
    const serverApiCalls: string[] = [];
    const verifiedJws: string[] = [];
    const client = input.client ?? baseTransaction;
    const fresh = input.fresh ?? baseTransaction;
    const verifier = createAppStoreGameServicesEvidenceVerifier({
      bundleId: baseTransaction.bundleId,
      environment: baseTransaction.environment,
      serverApi: {
        async getTransactionInfo(request) {
          serverApiCalls.push(request.transactionId);
          if (input.serverApi !== undefined) {
            return input.serverApi.getTransactionInfo(request);
          }
          return { status: 'found', signedTransactionInfo: freshJws };
        },
      },
      signedTransactionVerifier: {
        async verifyAndDecode(request) {
          verifiedJws.push(request.signedTransaction);
          if (request.signedTransaction === clientJws) {
            return { status: 'verified', payload: client };
          }
          if (request.signedTransaction === freshJws) {
            return { status: 'verified', payload: fresh };
          }
          return { status: 'rejected', reason: 'APP_STORE_SIGNATURE_INVALID' };
        },
      },
      resolveAppAccountToken: () => baseTransaction.appAccountToken ?? '',
      now: () => '2026-07-16T13:00:00.000Z',
      ...(input.policy === undefined ? {} : { signedTransactionEvidence: input.policy }),
    });
    return { verifier, serverApiCalls, verifiedJws };
  }

  // Default policy: the client JWS proves authenticity and binds the id; the
  // grant decision reads the transaction's current status from the Server API.
  const offline = createOfflineHarness();
  const offlineVerified = await offline.verifier.verifyPurchase(evidenceInput);
  assertEqual(offlineVerified.status, 'verified', 'signed-transaction evidence verifies');
  assertEqual(
    offline.verifiedJws.join(','),
    `${clientJws},${freshJws}`,
    'the client JWS is verified first, then the fresh Server API JWS',
  );
  assertEqual(
    offline.serverApiCalls.join(','),
    baseInput.request.platformTransactionId,
    'the default policy confirms the current transaction status through the Server API',
  );
  assertEqual(
    offlineVerified.status === 'verified' ? offlineVerified.verificationId : '',
    verified.verificationId,
    'the evidence path yields the same verification identity as the evidence-less path',
  );
  assertEqual(
    offlineVerified.status === 'verified'
      ? offlineVerified.payload?.appStoreOriginalTransactionId
      : '',
    baseTransaction.originalTransactionId,
    'the evidence path retains the signed original transaction identity',
  );

  // A JWS cached before a refund carries no revocationDate; the fresh status does.
  const refundedAfterSigning = createOfflineHarness({
    fresh: { ...baseTransaction, revocationDate: signedDate + 60_000 },
  });
  assertDecision(
    await refundedAfterSigning.verifier.verifyPurchase(evidenceInput),
    'rejected',
    'APP_STORE_TRANSACTION_REVOKED',
    'a transaction refunded after the client JWS was signed is rejected by default',
  );
  assertEqual(
    refundedAfterSigning.serverApiCalls.length,
    1,
    'the refund is seen because the current status was fetched',
  );
  const freshDisagrees = createOfflineHarness({
    fresh: { ...baseTransaction, transactionId: '2000000123456790' },
  });
  assertDecision(
    await freshDisagrees.verifier.verifyPurchase(evidenceInput),
    'rejected',
    'APP_STORE_SIGNED_TRANSACTION_ID_MISMATCH',
    'a Server API answer for another transaction than the client JWS is rejected',
  );
  const serverApiDown = createOfflineHarness({
    serverApi: {
      async getTransactionInfo() {
        throw new AppStoreDependencyUnavailableError('App Store Server API is down.');
      },
    },
  });
  assertDecision(
    await serverApiDown.verifier.verifyPurchase(evidenceInput),
    'pending',
    'APP_STORE_SERVER_API_UNAVAILABLE',
    'without the current status a valid client JWS stays pending, never granted',
  );

  const tampered = createOfflineHarness();
  const tamperedDecision = await tampered.verifier.verifyPurchase({
    ...evidenceInput,
    request: {
      ...evidenceInput.request,
      evidence: createAppStoreSignedTransactionEvidenceFixture({
        signedTransaction: `${clientJws}.tampered`,
        transactionId: baseInput.request.platformTransactionId,
      }),
    },
  });
  assertDecision(
    tamperedDecision,
    'rejected',
    'APP_STORE_SIGNATURE_INVALID',
    'a tampered client JWS is rejected by the signature verifier',
  );
  assertEqual(
    tampered.serverApiCalls.length,
    0,
    'a rejected JWS never falls back to the Server API',
  );

  const mismatched = createOfflineHarness({
    client: { ...baseTransaction, transactionId: '2000000123456790' },
  });
  assertDecision(
    await mismatched.verifier.verifyPurchase(evidenceInput),
    'rejected',
    'APP_STORE_SIGNED_TRANSACTION_ID_MISMATCH',
    'a JWS decoding to another transaction id than the request is rejected',
  );
  assertEqual(
    mismatched.serverApiCalls.length,
    0,
    'an id mismatch never falls back to the Server API',
  );

  const payloadMismatch = createOfflineHarness();
  assertDecision(
    await payloadMismatch.verifier.verifyPurchase({
      ...evidenceInput,
      request: {
        ...evidenceInput.request,
        evidence: createAppStoreSignedTransactionEvidenceFixture({ transactionId: '2000000123456790' }),
      },
    }),
    'rejected',
    'APP_STORE_SIGNED_TRANSACTION_ID_MISMATCH',
    'an envelope transactionId that differs from the request is rejected before verification',
  );
  assertEqual(
    payloadMismatch.verifiedJws.length,
    0,
    'an envelope id mismatch never runs the verifier',
  );

  const malformedEvidence = createOfflineHarness();
  assertDecision(
    await malformedEvidence.verifier.verifyPurchase({
      ...evidenceInput,
      request: {
        ...evidenceInput.request,
        evidence: { schema: appStoreSignedTransactionEvidenceSchema, payload: { signedTransaction: '' } },
      },
    }),
    'rejected',
    'APP_STORE_SIGNED_TRANSACTION_EVIDENCE_INVALID',
    'an envelope without a JWS is rejected',
  );
  assertEqual(
    malformedEvidence.serverApiCalls.length + malformedEvidence.verifiedJws.length,
    0,
    'malformed evidence reaches neither the verifier nor the Server API',
  );

  const otherAccountPayload = {
    ...baseTransaction,
    appAccountToken: '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f',
  };
  const otherAccount = createOfflineHarness({
    client: otherAccountPayload,
    fresh: otherAccountPayload,
  });
  const otherAccountDecision = await otherAccount.verifier.verifyPurchase(evidenceInput);
  assertDecision(
    otherAccountDecision,
    'rejected',
    'APP_STORE_ACCOUNT_TOKEN_MISMATCH',
    'the evidence path applies the same account binding check as the evidence-less path',
  );
  assertEqual(
    otherAccountDecision.status === 'rejected' ? otherAccountDecision.anotherAccount : undefined,
    true,
    "the evidence path reports another account's purchase",
  );

  // Offline-only: the client JWS decides, within the freshness window and
  // against the revocations App Store Server Notifications recorded.
  const offlinePolicy = (
    maxSignedAgeMs: number,
    revocations: AppStoreRevocationLookup = createInMemoryAppStoreRevocationRegistry(),
  ): AppStoreSignedTransactionEvidencePolicy => ({
    mode: 'offline-only',
    maxSignedAgeMs,
    revocations,
  });
  const offlineOnly = createOfflineHarness({ policy: offlinePolicy(2 * 60 * 60 * 1000) });
  assertEqual(
    (await offlineOnly.verifier.verifyPurchase(evidenceInput)).status,
    'verified',
    'offline-only verifies a fresh client JWS',
  );
  assertEqual(offlineOnly.serverApiCalls.length, 0, 'offline-only never calls the Server API');
  assertEqual(
    offlineOnly.verifiedJws.join(','),
    clientJws,
    'offline-only verifies only the client JWS',
  );
  const staleOfflineOnly = createOfflineHarness({ policy: offlinePolicy(30 * 60 * 1000) });
  assertDecision(
    await staleOfflineOnly.verifier.verifyPurchase(evidenceInput),
    'rejected',
    'APP_STORE_SIGNED_TRANSACTION_STALE',
    'offline-only rejects a client JWS signed before the freshness window',
  );
  const refundedOfflineOnly = createOfflineHarness({
    policy: offlinePolicy(2 * 60 * 60 * 1000),
    fresh: { ...baseTransaction, revocationDate: signedDate + 60_000 },
  });
  assertEqual(
    (await refundedOfflineOnly.verifier.verifyPurchase(evidenceInput)).status,
    'verified',
    'offline-only cannot see a refund Apple has not notified yet: the documented risk of that mode',
  );
  const revokedOfflineOnly = createOfflineHarness({
    policy: offlinePolicy(2 * 60 * 60 * 1000),
    client: { ...baseTransaction, revocationDate: signedDate + 1_000 },
  });
  assertDecision(
    await revokedOfflineOnly.verifier.verifyPurchase(evidenceInput),
    'rejected',
    'APP_STORE_TRANSACTION_REVOKED',
    'offline-only applies the revocation check to the client JWS',
  );
  const otherAccountOfflineOnly = createOfflineHarness({
    policy: offlinePolicy(2 * 60 * 60 * 1000),
    client: otherAccountPayload,
  });
  assertDecision(
    await otherAccountOfflineOnly.verifier.verifyPurchase(evidenceInput),
    'rejected',
    'APP_STORE_ACCOUNT_TOKEN_MISMATCH',
    'offline-only applies the account binding check to the client JWS',
  );

  // A refund the backend recorded before the first grant: the client still
  // holds the JWS signed before it, inside the window, and no ledger grant
  // exists to reverse. Offline-only refuses it as revoked.
  function revocationOf(transaction: AppStoreTransactionPayload): AppStoreRevocationRecord {
    return {
      verificationId: createAppStoreVerificationId({
        environment: transaction.environment,
        bundleId: transaction.bundleId,
        transactionId: transaction.type === 'Non-Consumable'
          ? transaction.originalTransactionId
          : transaction.transactionId,
      }),
      environment: transaction.environment,
      bundleId: transaction.bundleId,
      transactionId: transaction.transactionId,
      originalTransactionId: transaction.originalTransactionId,
      productId: transaction.productId,
      reason: 'refund',
      revokedAt: new Date(signedDate + 60_000).toISOString(),
      notificationType: 'REFUND',
      notificationUUID: 'uuid-refund-before-grant',
    };
  }
  const refundRegistry = createInMemoryAppStoreRevocationRegistry();
  assertEqual(
    (await refundRegistry.recordRevocation({
      record: revocationOf(baseTransaction),
      signal: controller.signal,
    })).alreadyRecorded,
    false,
    'the first record of a refund is kept',
  );
  assertEqual(
    (await refundRegistry.recordRevocation({
      record: { ...revocationOf(baseTransaction), notificationUUID: 'uuid-redelivered' },
      signal: controller.signal,
    })).alreadyRecorded,
    true,
    'a second record for the same grant identity answers the first',
  );
  assertEqual(
    (await refundRegistry.findRevocation({
      verificationId: revocationOf(baseTransaction).verificationId,
      environment: baseTransaction.environment,
      bundleId: baseTransaction.bundleId,
      transactionId: baseTransaction.transactionId,
      originalTransactionId: baseTransaction.originalTransactionId,
      signal: controller.signal,
    }))?.notificationUUID,
    'uuid-refund-before-grant',
    'the registry keeps the first notification of a refund',
  );
  const lookups: string[] = [];
  const recordingRegistry: AppStoreRevocationLookup = {
    async findRevocation(input) {
      lookups.push(`${input.verificationId}|${input.transactionId}|${input.originalTransactionId}`);
      return refundRegistry.findRevocation(input);
    },
  };
  const refundedBeforeGrant = createOfflineHarness({
    policy: offlinePolicy(2 * 60 * 60 * 1000, recordingRegistry),
  });
  assertDecision(
    await refundedBeforeGrant.verifier.verifyPurchase(evidenceInput),
    'rejected',
    'APP_STORE_TRANSACTION_REVOKED',
    'offline-only refuses a pre-refund JWS within the window once the refund is recorded',
  );
  assertEqual(
    lookups.join(','),
    `${revocationOf(baseTransaction).verificationId}|${baseTransaction.transactionId}|${baseTransaction.originalTransactionId}`,
    'offline-only looks the grant identity up once, with the decoded transaction ids',
  );
  assertEqual(
    refundedBeforeGrant.serverApiCalls.length,
    0,
    'the recorded refund is read without the Server API',
  );
  lookups.length = 0;
  assertDecision(
    await createOfflineHarness({
      policy: offlinePolicy(30 * 60 * 1000, recordingRegistry),
    }).verifier.verifyPurchase(evidenceInput),
    'rejected',
    'APP_STORE_SIGNED_TRANSACTION_STALE',
    'a stale JWS is refused before the registry is read',
  );
  assertEqual(lookups.length, 0, 'the registry is read only for a decision that would grant');
  assertEqual(
    (await createOfflineHarness({
      policy: offlinePolicy(2 * 60 * 60 * 1000, recordingRegistry),
      client: { ...baseTransaction, transactionId: '2000000123456790' },
    }).verifier.verifyPurchase({
      ...evidenceInput,
      request: {
        ...evidenceInput.request,
        platformTransactionId: '2000000123456790',
        evidence: createAppStoreSignedTransactionEvidenceFixture({
          transactionId: '2000000123456790',
        }),
      },
    })).status,
    'verified',
    'a consumable refund refuses only its own transaction',
  );

  // The record refuses only a JWS signed at or before the revocation (plus
  // the default 5-minute clock skew, which widens the refusal). A JWS signed
  // later without a revocationDate shows that Apple reversed the refund.
  const recordedRevokedAtMs = Date.parse(revocationOf(baseTransaction).revokedAt);
  const defaultClockSkewMs = 5 * 60 * 1000;
  assertDecision(
    await createOfflineHarness({
      policy: offlinePolicy(2 * 60 * 60 * 1000, refundRegistry),
      client: { ...baseTransaction, signedDate: recordedRevokedAtMs + defaultClockSkewMs },
    }).verifier.verifyPurchase(evidenceInput),
    'rejected',
    'APP_STORE_TRANSACTION_REVOKED',
    'a JWS signed within the clock skew after the revocation is still refused',
  );
  assertEqual(
    (await createOfflineHarness({
      policy: offlinePolicy(2 * 60 * 60 * 1000, refundRegistry),
      client: { ...baseTransaction, signedDate: recordedRevokedAtMs + defaultClockSkewMs + 1 },
    }).verifier.verifyPurchase(evidenceInput)).status,
    'verified',
    'a JWS signed after the recorded refund without a revocationDate (a reversed refund) is granted',
  );
  assertDecision(
    await createOfflineHarness({
      policy: offlinePolicy(2 * 60 * 60 * 1000, refundRegistry),
      client: {
        ...baseTransaction,
        signedDate: recordedRevokedAtMs + defaultClockSkewMs + 1,
        revocationDate: recordedRevokedAtMs,
      },
    }).verifier.verifyPurchase(evidenceInput),
    'rejected',
    'APP_STORE_TRANSACTION_REVOKED',
    'a JWS signed after the refund that carries it is refused by the payload check',
  );
  const unparseableRegistry = createInMemoryAppStoreRevocationRegistry();
  await unparseableRegistry.recordRevocation({
    record: { ...revocationOf(baseTransaction), revokedAt: 'not-a-time' },
    signal: controller.signal,
  });
  assertDecision(
    await createOfflineHarness({
      policy: offlinePolicy(2 * 60 * 60 * 1000, unparseableRegistry),
      client: { ...baseTransaction, signedDate: recordedRevokedAtMs + 60 * 60 * 1000 },
    }).verifier.verifyPurchase(evidenceInput),
    'rejected',
    'APP_STORE_TRANSACTION_REVOKED',
    'a record whose revokedAt does not parse refuses every JWS',
  );

  // A non-consumable is keyed by its original transaction: a restore of a
  // refunded purchase (a new transaction id) is refused too.
  const nonConsumableTransaction: AppStoreTransactionPayload = {
    ...baseTransaction,
    productId: 'com.example.game.remove_ads',
    type: 'Non-Consumable',
  };
  const nonConsumableRegistry = createInMemoryAppStoreRevocationRegistry();
  await nonConsumableRegistry.recordRevocation({
    record: revocationOf({ ...nonConsumableTransaction, transactionId: '2000000123456001' }),
    signal: controller.signal,
  });
  const nonConsumableInput = {
    ...evidenceInput,
    product: {
      id: 'REMOVE_ADS',
      type: 'non_consumable',
      grant: { type: 'entitlement', entitlement: 'remove_ads' },
      platformProductIds: { ios: nonConsumableTransaction.productId },
    },
    platformProductId: nonConsumableTransaction.productId,
  } satisfies VerifyPurchaseEvidenceInput;
  assertDecision(
    await createOfflineHarness({
      policy: offlinePolicy(2 * 60 * 60 * 1000, nonConsumableRegistry),
      client: nonConsumableTransaction,
    }).verifier.verifyPurchase(nonConsumableInput),
    'rejected',
    'APP_STORE_TRANSACTION_REVOKED',
    'a refunded non-consumable is refused by its original transaction id',
  );
  assertDecision(
    await createOfflineHarness({
      policy: offlinePolicy(2 * 60 * 60 * 1000, nonConsumableRegistry),
      client: { ...nonConsumableTransaction, appAccountToken: otherAccountPayload.appAccountToken },
    }).verifier.verifyPurchase({
      ...nonConsumableInput,
      request: { ...nonConsumableInput.request, intent: 'restore' },
    }),
    'rejected',
    'APP_STORE_TRANSACTION_REVOKED',
    'a refunded non-consumable is never reported restorable to another player',
  );

  // The registry's availability.
  assertDecision(
    await createOfflineHarness({
      policy: offlinePolicy(2 * 60 * 60 * 1000, {
        async findRevocation() {
          throw new AppStoreDependencyUnavailableError('revocation store down');
        },
      }),
    }).verifier.verifyPurchase(evidenceInput),
    'pending',
    'APP_STORE_REVOCATION_LOOKUP_UNAVAILABLE',
    'a registry outage keeps the purchase pending, never a grant',
  );
  await assertRejects(
    async () =>
      createOfflineHarness({
        policy: offlinePolicy(2 * 60 * 60 * 1000, {
          async findRevocation() {
            throw new Error('revocation lookup bug');
          },
        }),
      }).verifier.verifyPurchase(evidenceInput),
    'revocation lookup bug',
    'any other registry error propagates',
  );
  const offlinePolicyRequest = createOfflineHarness({
    policy: offlinePolicy(2 * 60 * 60 * 1000, {
      async findRevocation() {
        throw new Error('a request without evidence never reads the registry');
      },
    }),
  });
  assertEqual(
    (await offlinePolicyRequest.verifier.verifyPurchase(baseInput)).status,
    'verified',
    'offline-only keeps the Server API lookup for a request without evidence',
  );

  // Ignore: the evidence is not read and the transaction is fetched by id.
  const ignored = createOfflineHarness({ policy: { mode: 'ignore' } });
  assertEqual(
    (await ignored.verifier.verifyPurchase(evidenceInput)).status,
    'verified',
    'with evidence ignored the Server API lookup verifies the request',
  );
  assertEqual(
    ignored.verifiedJws.join(','),
    freshJws,
    'with evidence ignored only the Server API JWS is verified',
  );
  assertEqual(
    ignored.serverApiCalls.join(','),
    baseInput.request.platformTransactionId,
    'with evidence ignored the transaction is fetched by id',
  );
  for (const policy of [
    { mode: 'offline-only' },
    { mode: 'offline-only', maxSignedAgeMs: 0 },
    // A client JWS cannot show a later refund: offline-only needs the
    // revocations notifications recorded.
    { mode: 'offline-only', maxSignedAgeMs: 60_000 },
    { mode: 'offline-only', maxSignedAgeMs: 60_000, revocations: {} },
    { mode: 'offline-only', maxSignedAgeMs: 60_000, revocations: null },
    { mode: 'cached' },
  ]) {
    await assertRejects(
      async () =>
        createAppStoreGameServicesEvidenceVerifier({
          bundleId: baseTransaction.bundleId,
          environment: baseTransaction.environment,
          serverApi: createFoundServerApi(),
          signedTransactionVerifier: createSignedTransactionVerifier(baseTransaction),
          resolveAppAccountToken: () => baseTransaction.appAccountToken ?? '',
          signedTransactionEvidence: policy as AppStoreSignedTransactionEvidencePolicy,
        }),
      'signedTransactionEvidence',
      `an invalid evidence policy ${JSON.stringify(policy)} is rejected at construction`,
    );
  }

  const absent = createOfflineHarness();
  assertEqual(
    (await absent.verifier.verifyPurchase(baseInput)).status,
    'verified',
    'a request without evidence keeps the Server API path',
  );
  assertEqual(
    absent.serverApiCalls.join(','),
    baseInput.request.platformTransactionId,
    'a request without evidence fetches the transaction by id',
  );
  const otherSchema = createOfflineHarness();
  assertEqual(
    (await otherSchema.verifier.verifyPurchase({
      ...baseInput,
      request: {
        ...baseInput.request,
        evidence: { schema: 'google-play.product-purchase.v2', payload: { purchaseToken: 'x' } },
      },
    })).status,
    'verified',
    'evidence of another schema is ignored and the Server API path verifies the request',
  );
  assertEqual(
    otherSchema.serverApiCalls.join(','),
    baseInput.request.platformTransactionId,
    'evidence of another schema keeps the Server API lookup',
  );

  assertEqual(
    JSON.stringify(
      createAppStoreSignedTransactionEvidence({
        signedTransaction: clientJws,
        transactionId: '1',
        originalTransactionId: '0',
        bundleId: 'com.example.game',
      }),
    ),
    JSON.stringify({
      schema: appStoreSignedTransactionEvidenceSchema,
      payload: {
        signedTransaction: clientJws,
        transactionId: '1',
        originalTransactionId: '0',
        bundleId: 'com.example.game',
      },
    }),
    'the evidence builder emits the published envelope',
  );
  await assertRejects(
    async () =>
      createAppStoreSignedTransactionEvidence({ signedTransaction: '', transactionId: '1' }),
    'signedTransaction must be a non-empty string',
    'the evidence builder rejects an empty JWS',
  );
}

{
  // App Review: a Production deployment and a transaction Apple signed in the sandbox.
  const sandboxTransaction = { ...baseTransaction, environment: 'Sandbox' as const };
  const sandboxHarness = (input: {
    readonly sandboxPurchases?: 'grant' | 'reject';
    readonly productionApi?: 'not-found' | 'found-sandbox';
    readonly ownership?: string;
  } = {}) => {
    const calls: string[] = [];
    const transaction = input.ownership === undefined
      ? sandboxTransaction
      : { ...sandboxTransaction, inAppOwnershipType: input.ownership };
    const serverApi: AppStoreServerApiClient = {
      async getTransactionInfo({ environment }) {
        calls.push(`api:${environment}`);
        if (environment === 'Production' && input.productionApi !== 'found-sandbox') {
          return { status: 'pending', reason: 'APP_STORE_TRANSACTION_NOT_FOUND' };
        }
        return { status: 'found', signedTransactionInfo: 'signed-transaction-jws' };
      },
    };
    // Apple's adapter scoped to one environment refuses the other one after
    // the signature check.
    const scopedVerifier = (scope: 'Production' | 'Sandbox'): AppStoreSignedTransactionVerifier => ({
      async verifyAndDecode({ environment, signedTransaction }) {
        calls.push(`jws:${scope}:${environment}:${signedTransaction}`);
        if (environment !== scope) {
          return { status: 'rejected', reason: 'APP_STORE_VERIFIER_SCOPE_MISMATCH' };
        }
        return scope === transaction.environment
          ? { status: 'verified', payload: transaction }
          : { status: 'rejected', reason: 'APP_STORE_ENVIRONMENT_MISMATCH' };
      },
    });
    const verifier = createAppStoreGameServicesEvidenceVerifier({
      bundleId: baseTransaction.bundleId,
      environment: 'Production',
      serverApi,
      signedTransactionVerifier: scopedVerifier('Production'),
      resolveAppAccountToken: () => baseTransaction.appAccountToken ?? '',
      now: () => '2026-07-16T13:00:00.000Z',
      ...(input.sandboxPurchases === undefined
        ? {}
        : {
            sandboxPurchases: input.sandboxPurchases === 'grant'
              ? { mode: 'grant' as const, signedTransactionVerifier: scopedVerifier('Sandbox') }
              : { mode: 'reject' as const },
          }),
    });
    return { verifier, calls };
  };

  const rejectedByDefault = sandboxHarness();
  assertDecision(
    await rejectedByDefault.verifier.verifyPurchase(baseInput),
    'pending',
    'APP_STORE_TRANSACTION_NOT_FOUND',
    'without the opt-in a production miss stays pending and is never looked up in the sandbox',
  );
  assertEqual(rejectedByDefault.calls.join(','), 'api:Production', 'no sandbox lookup by default');
  const explicitReject = sandboxHarness({
    sandboxPurchases: 'reject',
    productionApi: 'found-sandbox',
  });
  assertDecision(
    await explicitReject.verifier.verifyPurchase(baseInput),
    'rejected',
    'APP_STORE_ENVIRONMENT_MISMATCH',
    'mode reject refuses a sandbox transaction on a production deployment',
  );

  const reviewPurchase = sandboxHarness({ sandboxPurchases: 'grant' });
  const reviewDecision = await reviewPurchase.verifier.verifyPurchase(baseInput);
  assertEqual(reviewDecision.status, 'verified', 'mode grant verifies a sandbox purchase');
  assertEqual(
    reviewPurchase.calls.join(','),
    'api:Production,api:Sandbox,jws:Sandbox:Sandbox:signed-transaction-jws',
    'production is asked first; the sandbox Server API and verifier only after its miss',
  );
  if (reviewDecision.status === 'verified') {
    assertEqual(
      reviewDecision.verificationId,
      '9:app-store:7:Sandbox:16:com.example.game:16:2000000123456789',
      'a sandbox grant has its own verification identity',
    );
    assertEqual(
      reviewDecision.payload?.appStoreEnvironment,
      'Sandbox',
      'the ledger payload records the sandbox environment',
    );
  }

  const reviewEvidence = sandboxHarness({ sandboxPurchases: 'grant' });
  const evidenceDecision = await reviewEvidence.verifier.verifyPurchase({
    ...baseInput,
    request: {
      ...baseInput.request,
      evidence: createAppStoreSignedTransactionEvidenceFixture({
        signedTransaction: 'signed-transaction-jws',
        transactionId: baseInput.request.platformTransactionId,
      }),
    },
  });
  assertEqual(evidenceDecision.status, 'verified', 'a sandbox client JWS verifies in mode grant');
  assertEqual(
    reviewEvidence.calls.join(','),
    'jws:Production:Production:signed-transaction-jws,'
      + 'jws:Sandbox:Sandbox:signed-transaction-jws,api:Sandbox,'
      + 'jws:Sandbox:Sandbox:signed-transaction-jws',
    'the client JWS is verified in production first, then in full in the sandbox, '
      + 'and its status is read from the sandbox Server API only',
  );

  const productionOnlyMiss = sandboxHarness({
    sandboxPurchases: 'grant',
    productionApi: 'found-sandbox',
  });
  assertDecision(
    await productionOnlyMiss.verifier.verifyPurchase(baseInput),
    'rejected',
    'APP_STORE_ENVIRONMENT_MISMATCH',
    'a production Server API answer is never re-verified in the sandbox',
  );

  const familyShared = sandboxHarness({ sandboxPurchases: 'grant', ownership: 'FAMILY_SHARED' });
  assertDecision(
    await familyShared.verifier.verifyPurchase(baseInput),
    'rejected',
    'APP_STORE_FAMILY_SHARED_UNSUPPORTED',
    'a family-shared transaction is refused explicitly',
  );
  const otherOwnership = sandboxHarness({ sandboxPurchases: 'grant', ownership: 'ORGANIZATION' });
  assertDecision(
    await otherOwnership.verifier.verifyPurchase(baseInput),
    'rejected',
    'APP_STORE_OWNERSHIP_UNSUPPORTED',
    'an ownership type other than PURCHASED is refused',
  );
  const ownPurchase = sandboxHarness({ sandboxPurchases: 'grant', ownership: 'PURCHASED' });
  assertEqual(
    (await ownPurchase.verifier.verifyPurchase(baseInput)).status,
    'verified',
    'the buyer’s own transaction is granted',
  );

  await assertRejects(
    async () =>
      createAppStoreGameServicesEvidenceVerifier({
        bundleId: baseTransaction.bundleId,
        environment: 'Sandbox',
        serverApi: createFoundServerApi(),
        signedTransactionVerifier: createSignedTransactionVerifier(sandboxTransaction),
        resolveAppAccountToken: () => baseTransaction.appAccountToken ?? '',
        sandboxPurchases: {
          mode: 'grant',
          signedTransactionVerifier: createSignedTransactionVerifier(sandboxTransaction),
        },
      }),
    'sandboxPurchases applies only to a Production verifier',
    'the sandbox opt-in is refused on a sandbox verifier',
  );
  await assertRejects(
    async () =>
      createAppStoreGameServicesEvidenceVerifier({
        bundleId: baseTransaction.bundleId,
        environment: 'Production',
        serverApi: createFoundServerApi(),
        signedTransactionVerifier: createSignedTransactionVerifier(baseTransaction),
        resolveAppAccountToken: () => baseTransaction.appAccountToken ?? '',
        sandboxPurchases: { mode: 'grant' } as never,
      }),
    'sandboxPurchases.signedTransactionVerifier must be an object',
    'mode grant requires a sandbox verifier',
  );
}

{
  // Review follow-ups for the sandbox opt-in.
  const sandboxTransaction = { ...baseTransaction, environment: 'Sandbox' as const };
  const productionCalls: string[] = [];
  const sandboxCalls: string[] = [];
  const recordingApi = (calls: string[], answer: 'found' | 'not-found'): AppStoreServerApiClient => ({
    async getTransactionInfo({ environment }) {
      calls.push(environment);
      return answer === 'found'
        ? { status: 'found', signedTransactionInfo: 'signed-transaction-jws' }
        : { status: 'pending', reason: 'APP_STORE_TRANSACTION_NOT_FOUND' };
    },
  });
  const verifierCalls: string[] = [];
  const permissiveVerifier = (
    payload: AppStoreTransactionPayload,
    name = 'verifier',
  ): AppStoreSignedTransactionVerifier => ({
    async verifyAndDecode({ environment }) {
      verifierCalls.push(`${name}:${environment}`);
      return { status: 'verified', payload };
    },
  });
  const base = {
    bundleId: baseTransaction.bundleId,
    environment: 'Production' as const,
    resolveAppAccountToken: () => baseTransaction.appAccountToken ?? '',
    now: () => '2026-07-16T13:00:00.000Z',
  };

  // The sandbox policy's own Server API client serves the sandbox only.
  const overridden = createAppStoreGameServicesEvidenceVerifier({
    ...base,
    serverApi: recordingApi(productionCalls, 'not-found'),
    // A custom production verifier that decodes without an environment check:
    // its Sandbox payload is re-verified by the sandbox verifier.
    signedTransactionVerifier: permissiveVerifier(sandboxTransaction, 'production'),
    sandboxPurchases: {
      mode: 'grant',
      signedTransactionVerifier: permissiveVerifier(sandboxTransaction, 'sandbox'),
      serverApi: recordingApi(sandboxCalls, 'found'),
    },
  });
  assertEqual(
    (await overridden.verifyPurchase(baseInput)).status,
    'verified',
    'a production miss is verified through the sandbox policy’s client',
  );
  assertEqual(productionCalls.join(','), 'Production', 'production is asked once');
  assertEqual(
    sandboxCalls.join(','),
    'Sandbox',
    'the sandbox client is asked for the sandbox only',
  );
  assertEqual(
    verifierCalls.join(','),
    'sandbox:Sandbox',
    'the sandbox Server API answer is verified by the sandbox verifier only',
  );

  sandboxCalls.length = 0;
  productionCalls.length = 0;
  verifierCalls.length = 0;
  const signalled = await overridden.verifyPurchase({
    ...baseInput,
    request: {
      ...baseInput.request,
      evidence: createAppStoreSignedTransactionEvidenceFixture({
        signedTransaction: 'client-jws',
        transactionId: baseInput.request.platformTransactionId,
      }),
    },
  });
  assertEqual(signalled.status, 'verified', 'a verified Sandbox payload is a sandbox signal');
  assertEqual(sandboxCalls.join(','), 'Sandbox', 'its status is read from the sandbox only');
  assertEqual(productionCalls.length, 0, 'the production Server API is skipped for a sandbox JWS');
  assertEqual(
    verifierCalls.join(','),
    'production:Production,sandbox:Sandbox,sandbox:Sandbox',
    'the client JWS is checked in production, then both JWS by the sandbox verifier',
  );

  // A Server API answer from another environment than the client JWS.
  const crossed = createAppStoreGameServicesEvidenceVerifier({
    ...base,
    serverApi: recordingApi([], 'found'),
    signedTransactionVerifier: {
      async verifyAndDecode({ signedTransaction }) {
        return {
          status: 'verified',
          payload: signedTransaction === 'client-jws' ? baseTransaction : sandboxTransaction,
        };
      },
    },
  });
  assertDecision(
    await crossed.verifyPurchase({
      ...baseInput,
      request: {
        ...baseInput.request,
        evidence: createAppStoreSignedTransactionEvidenceFixture({
          signedTransaction: 'client-jws',
          transactionId: baseInput.request.platformTransactionId,
        }),
      },
    }),
    'rejected',
    'APP_STORE_SIGNED_TRANSACTION_ENVIRONMENT_MISMATCH',
    'the decision stays in the client JWS environment',
  );

  // Offline-only decides on the client JWS: no Server API call at all.
  const offlineCalls: string[] = [];
  const sandboxRegistry = createInMemoryAppStoreRevocationRegistry();
  const sandboxLookups: string[] = [];
  const offlineSandbox = createAppStoreGameServicesEvidenceVerifier({
    ...base,
    serverApi: recordingApi(offlineCalls, 'found'),
    signedTransactionVerifier: {
      async verifyAndDecode() {
        return { status: 'rejected', reason: 'APP_STORE_ENVIRONMENT_MISMATCH' };
      },
    },
    signedTransactionEvidence: {
      mode: 'offline-only',
      maxSignedAgeMs: 24 * 60 * 60 * 1000,
      revocations: {
        async findRevocation(input) {
          sandboxLookups.push(`${input.environment}|${input.verificationId}`);
          return sandboxRegistry.findRevocation(input);
        },
      },
    },
    sandboxPurchases: {
      mode: 'grant',
      signedTransactionVerifier: permissiveVerifier(sandboxTransaction),
    },
  });
  const offlineSandboxInput = {
    ...baseInput,
    request: {
      ...baseInput.request,
      evidence: createAppStoreSignedTransactionEvidenceFixture({
        signedTransaction: 'client-jws',
        transactionId: baseInput.request.platformTransactionId,
      }),
    },
  };
  const offlineDecision = await offlineSandbox.verifyPurchase(offlineSandboxInput);
  assertEqual(
    offlineDecision.status,
    'verified',
    'offline-only verifies a sandbox JWS in the sandbox',
  );
  assertEqual(offlineCalls.length, 0, 'offline-only makes no Server API call');
  const sandboxVerificationId = createAppStoreVerificationId({
    environment: 'Sandbox',
    bundleId: sandboxTransaction.bundleId,
    transactionId: sandboxTransaction.transactionId,
  });
  assertEqual(
    sandboxLookups.join(','),
    `Sandbox|${sandboxVerificationId}`,
    'a sandbox JWS is looked up under its sandbox grant identity',
  );
  const sandboxRevocation = {
    verificationId: createAppStoreVerificationId({
      environment: 'Production',
      bundleId: sandboxTransaction.bundleId,
      transactionId: sandboxTransaction.transactionId,
    }),
    environment: 'Production' as const,
    bundleId: sandboxTransaction.bundleId,
    transactionId: sandboxTransaction.transactionId,
    originalTransactionId: sandboxTransaction.originalTransactionId,
    productId: sandboxTransaction.productId,
    reason: 'refund' as const,
    revokedAt: '2026-07-16T12:30:00.000Z',
    notificationType: 'REFUND',
    notificationUUID: 'uuid-production-refund',
  };
  await sandboxRegistry.recordRevocation({ record: sandboxRevocation, signal: controller.signal });
  assertEqual(
    (await offlineSandbox.verifyPurchase(offlineSandboxInput)).status,
    'verified',
    'a production refund of the same id never refuses a sandbox transaction',
  );
  await sandboxRegistry.recordRevocation({
    record: {
      ...sandboxRevocation,
      verificationId: sandboxVerificationId,
      environment: 'Sandbox',
      notificationUUID: 'uuid-sandbox-refund',
    },
    signal: controller.signal,
  });
  assertDecision(
    await offlineSandbox.verifyPurchase(offlineSandboxInput),
    'rejected',
    'APP_STORE_TRANSACTION_REVOKED',
    'a recorded sandbox refund refuses the sandbox JWS',
  );

  // A client JWS verified in production keeps a production miss pending.
  const lagCalls: string[] = [];
  const lagging = createAppStoreGameServicesEvidenceVerifier({
    ...base,
    serverApi: recordingApi(lagCalls, 'not-found'),
    signedTransactionVerifier: permissiveVerifier(baseTransaction),
    sandboxPurchases: {
      mode: 'grant',
      signedTransactionVerifier: permissiveVerifier(sandboxTransaction),
    },
  });
  assertDecision(
    await lagging.verifyPurchase({
      ...baseInput,
      request: {
        ...baseInput.request,
        evidence: createAppStoreSignedTransactionEvidenceFixture({
          signedTransaction: 'client-jws',
          transactionId: baseInput.request.platformTransactionId,
        }),
      },
    }),
    'pending',
    'APP_STORE_TRANSACTION_NOT_FOUND',
    'a production JWS is never looked up in the sandbox',
  );
  assertEqual(lagCalls.join(','), 'Production', 'only production is asked');

  // A transient sandbox signature outage stays pending.
  const unavailableSandbox = createAppStoreGameServicesEvidenceVerifier({
    ...base,
    serverApi: recordingApi([], 'not-found'),
    signedTransactionVerifier: permissiveVerifier(baseTransaction),
    sandboxPurchases: {
      mode: 'grant',
      signedTransactionVerifier: {
        async verifyAndDecode() {
          throw new AppStoreDependencyUnavailableError('sandbox OCSP down');
        },
      },
      serverApi: recordingApi([], 'found'),
    },
  });
  assertDecision(
    await unavailableSandbox.verifyPurchase(baseInput),
    'pending',
    'APP_STORE_SIGNATURE_VERIFIER_UNAVAILABLE',
    'a sandbox verifier outage is retryable, never a grant',
  );

  await assertRejects(
    async () =>
      createAppStoreGameServicesEvidenceVerifier({
        ...base,
        serverApi: createFoundServerApi(),
        signedTransactionVerifier: createSignedTransactionVerifier(baseTransaction),
        sandboxPurchases: {
          mode: 'grant',
          signedTransactionVerifier: createSignedTransactionVerifier(sandboxTransaction),
          serverApi: {} as AppStoreServerApiClient,
        },
      }),
    'sandboxPurchases.serverApi must implement getTransactionInfo',
    'a sandbox Server API client without getTransactionInfo is refused at construction',
  );
}

console.log('App Store signed transaction verifier tests passed.');

function createVerifier(input: {
  readonly serverApi?: AppStoreServerApiClient;
  readonly signedTransactionVerifier?: AppStoreSignedTransactionVerifier;
  readonly transaction?: AppStoreTransactionPayload;
  readonly resolveAppAccountToken?: () => string | Promise<string>;
} = {}) {
  return createAppStoreGameServicesEvidenceVerifier({
    bundleId: baseTransaction.bundleId,
    environment: baseTransaction.environment,
    serverApi: input.serverApi ?? createFoundServerApi(),
    signedTransactionVerifier: input.signedTransactionVerifier
      ?? createSignedTransactionVerifier(input.transaction ?? baseTransaction),
    resolveAppAccountToken:
      input.resolveAppAccountToken ?? (() => baseTransaction.appAccountToken ?? ''),
    now: () => '2026-07-16T13:00:00.000Z',
  });
}

async function assertRejects(
  operation: () => Promise<unknown>,
  expectedMessagePart: string,
  message: string,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    const actualMessage = error instanceof Error ? error.message : String(error);
    if (actualMessage.includes(expectedMessagePart)) {
      return;
    }
    throw new Error(
      `${message}: expected error containing ${expectedMessagePart}, received ${actualMessage}.`,
    );
  }
  throw new Error(`${message}: expected operation to reject.`);
}

function createFoundServerApi(): AppStoreServerApiClient {
  return {
    async getTransactionInfo() {
      return { status: 'found', signedTransactionInfo: 'signed-transaction-jws' };
    },
  };
}

function createSignedTransactionVerifier(
  payload: AppStoreTransactionPayload,
): AppStoreSignedTransactionVerifier {
  return {
    async verifyAndDecode(input) {
      assertEqual(
        input.signedTransaction,
        'signed-transaction-jws',
        'only the Server API signed transaction should reach signature verification',
      );
      return { status: 'verified', payload };
    },
  };
}

function assertDecision(
  decision: { readonly status: string; readonly reason?: string },
  status: string,
  reason: string,
  message: string,
): void {
  assertEqual(decision.status, status, `${message} (status)`);
  assertEqual(decision.reason, reason, `${message} (reason)`);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}.`);
  }
}
