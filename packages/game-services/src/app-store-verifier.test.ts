import {
  createAppStoreGameServicesEvidenceVerifier,
  createAppStoreServerApiClient,
  type AppStoreServerApiClient,
  type AppStoreSignedTransactionVerifier,
  type AppStoreTransactionPayload,
} from './app-store-verifier';
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

const baseTransaction = {
  transactionId: baseInput.request.platformTransactionId,
  originalTransactionId: '2000000123456000',
  bundleId: 'com.example.game',
  productId: baseInput.platformProductId,
  purchaseDate,
  signedDate,
  environment: 'Production',
  type: 'Consumable',
  appAccountToken: 'f15f2ed7-f92a-4c5a-90e1-15d26cd729f2',
} satisfies AppStoreTransactionPayload;

let requestedUrl = '';
let requestedAuthorization = '';
const serverApiClient = createAppStoreServerApiClient({
  getBearerToken: () => 'signed-provider-jwt',
  async fetch(url, init) {
    requestedUrl = url;
    requestedAuthorization = init.headers.authorization ?? '';
    return {
      status: 200,
      async text() {
        return JSON.stringify({ signedTransactionInfo: 'signed-transaction-jws' });
      },
    };
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
    return {
      status: 429,
      async text() {
        return '{}';
      },
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

console.log('App Store signed transaction verifier tests passed.');

function createVerifier(input: {
  readonly serverApi?: AppStoreServerApiClient;
  readonly signedTransactionVerifier?: AppStoreSignedTransactionVerifier;
  readonly transaction?: AppStoreTransactionPayload;
} = {}) {
  return createAppStoreGameServicesEvidenceVerifier({
    bundleId: baseTransaction.bundleId,
    environment: baseTransaction.environment,
    serverApi: input.serverApi ?? createFoundServerApi(),
    signedTransactionVerifier: input.signedTransactionVerifier
      ?? createSignedTransactionVerifier(input.transaction ?? baseTransaction),
    resolveAppAccountToken: () => baseTransaction.appAccountToken ?? '',
    now: () => '2026-07-16T13:00:00.000Z',
  });
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
