import {
  AppStoreDependencyUnavailableError,
  createAppStoreGameServicesEvidenceVerifier,
  createAppStoreServerApiClient,
  type AppStoreServerApiClient,
  type AppStoreSignedTransactionVerifier,
  type AppStoreTransactionPayload,
} from './app-store-verifier';
import { createAppStoreTransactionConformanceFixture } from './app-store-verifier-conformance';
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

const missingAccount = await createVerifier({
  transaction: createAppStoreTransactionConformanceFixture({
    ...baseTransaction,
    includeAppAccountToken: false,
  }),
}).verifyPurchase(baseInput);
assertDecision(
  missingAccount,
  'rejected',
  'APP_STORE_ACCOUNT_TOKEN_MISMATCH',
  'a signed transaction without the required account binding must fail closed',
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
assertDecision(
  missingQuantity,
  'rejected',
  'APP_STORE_QUANTITY_UNSUPPORTED',
  'a consumable without signed quantity must fail closed',
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

const invalidAuthorizationClient = createAppStoreServerApiClient({
  getBearerToken: () => 'invalid bearer token',
  async fetch() {
    throw new Error('fetch must not run for invalid authorization');
  },
});
await assertRejects(
  () => invalidAuthorizationClient.getTransactionInfo({
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
await assertRejects(
  () => oversizedClient.getTransactionInfo({
    transactionId: baseInput.request.platformTransactionId,
    environment: 'Production',
    signal: controller.signal,
  }),
  'response exceeded maxResponseBytes',
  'the Server API client must stop reading oversized response streams',
);
assertEqual(
  oversizedStreamCancelled,
  true,
  'the Server API client must cancel an oversized response stream before releasing it',
);

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
