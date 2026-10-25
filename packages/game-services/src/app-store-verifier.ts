import type { PlatformEvidenceEnvelope, ProductType } from '@mpgd/platform';

import type {
  EvidenceVerificationDecision,
  GameServicesEvidenceVerifier,
  VerifyPurchaseEvidenceInput,
} from './evidence-verification.js';

export type AppStoreEnvironment = 'Production' | 'Sandbox';

export const appStoreServerApiBaseUrls = Object.freeze({
  Production: 'https://api.storekit.apple.com',
  Sandbox: 'https://api.storekit-sandbox.apple.com',
} as const) satisfies Readonly<Record<AppStoreEnvironment, string>>;

export class AppStoreDependencyUnavailableError extends Error {
  override readonly cause: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'AppStoreDependencyUnavailableError';
    this.cause = cause;
  }
}

class AppStoreResponseTooLargeError extends Error {
  constructor() {
    super('App Store Server API response exceeded maxResponseBytes.');
    this.name = 'AppStoreResponseTooLargeError';
  }
}

export type AppStoreServerApiTransactionResult =
  | {
      readonly status: 'found';
      readonly signedTransactionInfo: string;
    }
  | {
      readonly status: 'pending' | 'rejected';
      readonly reason: string;
    };

export interface AppStoreServerApiTransactionInput {
  readonly transactionId: string;
  readonly environment: AppStoreEnvironment;
  readonly signal: AbortSignal;
}

export interface AppStoreServerApiClient {
  getTransactionInfo(
    input: AppStoreServerApiTransactionInput,
  ): Promise<AppStoreServerApiTransactionResult>;
}

export type AppStoreInAppPurchaseType =
  | 'Auto-Renewable Subscription'
  | 'Consumable'
  | 'Non-Consumable'
  | 'Non-Renewing Subscription';

export interface AppStoreTransactionPayload {
  readonly transactionId: string;
  readonly originalTransactionId: string;
  readonly bundleId: string;
  readonly productId: string;
  readonly purchaseDate: number;
  readonly signedDate: number;
  readonly environment: AppStoreEnvironment;
  readonly type: AppStoreInAppPurchaseType;
  readonly quantity?: number;
  readonly appAccountToken?: string;
  readonly expiresDate?: number;
  readonly revocationDate?: number;
  readonly isUpgraded?: boolean;
  /**
   * Apple's `inAppOwnershipType`: `PURCHASED` for the buyer's own
   * transaction, `FAMILY_SHARED` for a family member's access. Only
   * `PURCHASED` (or an absent value) is granted.
   */
  readonly inAppOwnershipType?: string;
}

export type AppStoreSignedTransactionVerificationResult =
  | {
      readonly status: 'verified';
      readonly payload: AppStoreTransactionPayload;
    }
  | {
      readonly status: 'rejected';
      readonly reason: string;
    };

export interface AppStoreSignedTransactionVerifier {
  verifyAndDecode(input: {
    readonly signedTransaction: string;
    readonly environment: AppStoreEnvironment;
    readonly bundleId: string;
    readonly signal: AbortSignal;
  }): Promise<AppStoreSignedTransactionVerificationResult>;
}

export interface CreateAppStoreServerApiClientOptions {
  readonly getBearerToken: (input: {
    readonly signal: AbortSignal;
  }) => string | Promise<string>;
  readonly fetch?: AppStoreFetch;
  readonly maxResponseBytes?: number;
}

export interface CreateAppStoreEvidenceVerifierOptions {
  readonly bundleId: string;
  readonly environment: AppStoreEnvironment;
  readonly serverApi: AppStoreServerApiClient;
  readonly signedTransactionVerifier: AppStoreSignedTransactionVerifier;
  readonly resolveAppAccountToken: (input: {
    readonly playerId: string;
    readonly signal: AbortSignal;
  }) => string | Promise<string>;
  readonly now?: () => string;
  readonly clockSkewMs?: number;
  /**
   * How `app-store.signed-transaction.v1` request evidence is used. Defaults
   * to `{ mode: 'server-api' }`: the client JWS is verified offline to
   * establish authenticity and bind the transaction id, and the grant decision
   * is then taken on the transaction's current status fetched from the App
   * Store Server API (`Get Transaction Info`), so a refund that happened after
   * the client cached its JWS is seen. `{ mode: 'offline-only', maxSignedAgeMs }`
   * decides on the client JWS alone and is only for deployments without Server
   * API access: a JWS is a snapshot, so a transaction refunded after it was
   * signed is accepted until `signedDate` falls out of the window. `{ mode:
   * 'ignore' }` fetches by id for every request.
   */
  readonly signedTransactionEvidence?: AppStoreSignedTransactionEvidencePolicy;
  /**
   * Whether a Production deployment grants transactions Apple signed in the
   * sandbox (App Review, TestFlight, and sandbox testers buy in the sandbox
   * against the production build). Defaults to `{ mode: 'reject' }`, which
   * answers `APP_STORE_ENVIRONMENT_MISMATCH`. `{ mode: 'grant', ... }` follows
   * Apple's production-first order: the transaction is verified against
   * production, and only when the verified JWS says `Sandbox` (or production
   * answers `APP_STORE_TRANSACTION_NOT_FOUND`) is it verified again with the
   * sandbox verifier and Server API. The grant's verification id and ledger
   * payload carry `Sandbox`, so it stays apart from production revenue.
   * Only valid on a `Production` verifier.
   */
  readonly sandboxPurchases?: AppStoreSandboxPurchasePolicy;
}

export type AppStoreSandboxPurchasePolicy =
  | { readonly mode: 'reject' }
  | {
      readonly mode: 'grant';
      /**
       * A verifier scoped to the sandbox environment and the same bundle, for
       * example `createAppleSignedTransactionVerifier({ environment: 'Sandbox', ... })`.
       */
      readonly signedTransactionVerifier: AppStoreSignedTransactionVerifier;
      /** Defaults to the verifier's `serverApi`, which selects the sandbox host per call. */
      readonly serverApi?: AppStoreServerApiClient;
    };

export type AppStoreSignedTransactionEvidencePolicy =
  | { readonly mode: 'ignore' }
  | { readonly mode: 'server-api' }
  | {
      readonly mode: 'offline-only';
      /** Maximum age of the JWS `signedDate` at verification time; older evidence is rejected. */
      readonly maxSignedAgeMs: number;
    };

/**
 * Evidence schema of a commerce v2 App Store purchase (RFC B3): the payload's
 * `signedTransaction` is the StoreKit-verified JWS the client received. The
 * server verifies it offline and, by default, confirms the transaction's
 * current status through the Server API before a grant.
 */
export const appStoreSignedTransactionEvidenceSchema = 'app-store.signed-transaction.v1';

export interface AppStoreSignedTransactionEvidencePayload {
  readonly signedTransaction: string;
  readonly transactionId: string;
  readonly originalTransactionId?: string;
  readonly bundleId?: string;
}

/** Builds the `app-store.signed-transaction.v1` envelope a client submits with `verifyPurchase`. */
export function createAppStoreSignedTransactionEvidence(
  payload: AppStoreSignedTransactionEvidencePayload,
): PlatformEvidenceEnvelope {
  assertNonEmptyString(payload.signedTransaction, 'signedTransaction');
  assertNonEmptyString(payload.transactionId, 'transactionId');
  return {
    schema: appStoreSignedTransactionEvidenceSchema,
    payload: {
      signedTransaction: payload.signedTransaction,
      transactionId: payload.transactionId,
      ...(payload.originalTransactionId === undefined
        ? {}
        : { originalTransactionId: payload.originalTransactionId }),
      ...(payload.bundleId === undefined ? {} : { bundleId: payload.bundleId }),
    },
  };
}

type SignedTransactionEvidenceRead =
  | { readonly status: 'absent' }
  | { readonly status: 'present'; readonly signedTransaction: string }
  | { readonly status: 'rejected'; readonly reason: string };

/**
 * Reads the client JWS from `app-store.signed-transaction.v1` evidence. Any
 * other schema, or no evidence, is `absent` (the Server API path); a present
 * envelope whose payload is malformed, or whose `transactionId` differs from
 * the request, is rejected before any verifier runs.
 */
function readSignedTransactionEvidence(
  request: VerifyPurchaseEvidenceInput['request'],
): SignedTransactionEvidenceRead {
  const evidence = request.evidence;
  if (evidence?.schema !== appStoreSignedTransactionEvidenceSchema) {
    return { status: 'absent' };
  }
  const payload: unknown = evidence.payload;
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { status: 'rejected', reason: 'APP_STORE_SIGNED_TRANSACTION_EVIDENCE_INVALID' };
  }
  const { signedTransaction, transactionId } = payload as Readonly<Record<string, unknown>>;
  if (
    typeof signedTransaction !== 'string'
    || signedTransaction.length === 0
    || signedTransaction.length > maxSignedTransactionEvidenceLength
  ) {
    return { status: 'rejected', reason: 'APP_STORE_SIGNED_TRANSACTION_EVIDENCE_INVALID' };
  }
  if (transactionId !== undefined && transactionId !== request.platformTransactionId) {
    return { status: 'rejected', reason: 'APP_STORE_SIGNED_TRANSACTION_ID_MISMATCH' };
  }
  return { status: 'present', signedTransaction };
}

const maxSignedTransactionEvidenceLength = 512 * 1024;

export interface AppStoreFetchResponse {
  readonly status: number;
  readonly body: ReadableStream<Uint8Array> | null;
}

export type AppStoreFetch = (
  url: string,
  init: {
    readonly method: 'GET';
    readonly headers: Readonly<Record<string, string>>;
    readonly signal: AbortSignal;
  },
) => Promise<AppStoreFetchResponse>;

export function createAppStoreServerApiClient(
  options: CreateAppStoreServerApiClientOptions,
): AppStoreServerApiClient {
  const fetch = options.fetch ?? readGlobalFetch();
  const maxResponseBytes = readPositiveSafeInteger(
    options.maxResponseBytes ?? 128 * 1024,
    'maxResponseBytes',
  );

  return {
    async getTransactionInfo(input) {
      assertNonEmptyString(input.transactionId, 'transactionId');
      assertAppStoreEnvironment(input.environment);
      const token = await options.getBearerToken({ signal: input.signal });
      assertAuthorizationValue(token, 'App Store bearer token');
      const url = new URL(
        `/inApps/v1/transactions/${encodeURIComponent(input.transactionId)}`,
        appStoreServerApiBaseUrls[input.environment],
      );
      let response: AppStoreFetchResponse;
      try {
        response = await fetch(url.toString(), {
          method: 'GET',
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${token}`,
          },
          signal: input.signal,
        });
      } catch (error) {
        if (input.signal.aborted) {
          throw error;
        }
        throw new AppStoreDependencyUnavailableError(
          'App Store Server API transport is unavailable.',
          error,
        );
      }

      if (response.status === 200) {
        let body: unknown;
        try {
          body = await readBoundedJson(response, maxResponseBytes, input.signal);
          assertRecord(body, 'App Store transaction response');
          assertNonEmptyString(body.signedTransactionInfo, 'signedTransactionInfo');
        } catch (error) {
          if (
            input.signal.aborted
            || error instanceof AppStoreDependencyUnavailableError
          ) {
            throw error;
          }
          return { status: 'pending', reason: 'APP_STORE_SERVER_API_INVALID_RESPONSE' };
        }
        return {
          status: 'found',
          signedTransactionInfo: body.signedTransactionInfo,
        };
      }

      await cancelResponseBody(response);

      if (response.status === 400) {
        return { status: 'rejected', reason: 'APP_STORE_INVALID_TRANSACTION_ID' };
      }

      if (response.status === 404) {
        return { status: 'pending', reason: 'APP_STORE_TRANSACTION_NOT_FOUND' };
      }

      if (response.status === 401 || response.status === 403) {
        return { status: 'pending', reason: 'APP_STORE_AUTHORIZATION_FAILED' };
      }

      if (response.status === 429 || response.status >= 500) {
        return { status: 'pending', reason: 'APP_STORE_SERVER_API_UNAVAILABLE' };
      }

      return { status: 'rejected', reason: 'APP_STORE_SERVER_API_REJECTED' };
    },
  };
}

export function createAppStoreGameServicesEvidenceVerifier(
  options: CreateAppStoreEvidenceVerifierOptions,
): GameServicesEvidenceVerifier {
  assertNonEmptyString(options.bundleId, 'bundleId');
  assertAppStoreEnvironment(options.environment);
  assertSignedTransactionEvidencePolicy(options.signedTransactionEvidence);
  assertSandboxPurchasePolicy(options.sandboxPurchases, options.environment);
  const clockSkewMs = readNonNegativeSafeInteger(
    options.clockSkewMs ?? 5 * 60 * 1000,
    'clockSkewMs',
  );
  const now = options.now ?? (() => new Date().toISOString());

  return {
    async verifyPurchase(input) {
      return verifyAppStorePurchase(input, options, now, clockSkewMs);
    },
    async verifyAdReward() {
      return {
        status: 'rejected',
        reason: 'APP_STORE_AD_REWARD_UNSUPPORTED',
      };
    },
  };
}

async function verifyAppStorePurchase(
  input: VerifyPurchaseEvidenceInput,
  options: CreateAppStoreEvidenceVerifierOptions,
  now: () => string,
  clockSkewMs: number,
): Promise<EvidenceVerificationDecision> {
  if (input.request.target !== 'ios') {
    return { status: 'rejected', reason: 'APP_STORE_TARGET_MISMATCH' };
  }
  if (input.product.type === 'subscription') {
    return { status: 'rejected', reason: 'APP_STORE_SUBSCRIPTION_UNSUPPORTED' };
  }

  // Commerce v2 evidence carries the client's StoreKit-verified JWS. Its
  // signature establishes authenticity and binds the transaction id; the
  // grant decision is then taken on the transaction's current status from
  // the Server API (default), or on the JWS alone within a freshness window
  // (offline-only). Without evidence (current clients) the transaction is
  // fetched by id as before.
  const policy = options.signedTransactionEvidence ?? defaultSignedTransactionEvidencePolicy;
  const evidence = policy.mode === 'ignore'
    ? { status: 'absent' as const }
    : readSignedTransactionEvidence(input.request);
  if (evidence.status === 'rejected') {
    return { status: 'rejected', reason: evidence.reason };
  }

  const sandbox = readSandboxGrantPolicy(options);
  let environment: AppStoreEnvironment = options.environment;
  let offlineTransaction: AppStoreTransactionPayload | undefined;
  if (evidence.status === 'present') {
    let offline = await verifySignedTransaction(
      evidence.signedTransaction,
      input,
      options,
      environment,
    );
    if (sandbox !== undefined && isSandboxSignal(offline)) {
      // Production first: only a JWS the production verifier places in the
      // sandbox is verified again, in full, by the sandbox verifier.
      environment = 'Sandbox';
      offline = await verifySignedTransaction(
        evidence.signedTransaction,
        input,
        options,
        environment,
      );
    }
    if (offline.status !== 'verified') {
      return offline;
    }
    if (offline.payload.transactionId !== input.request.platformTransactionId) {
      // A client-supplied JWS for another transaction is a stable rejection,
      // distinct from a Server API answer that disagrees with the request.
      return { status: 'rejected', reason: 'APP_STORE_SIGNED_TRANSACTION_ID_MISMATCH' };
    }
    offlineTransaction = offline.payload;
  }

  let transaction: AppStoreTransactionPayload;
  if (offlineTransaction !== undefined && policy.mode === 'offline-only') {
    transaction = offlineTransaction;
  } else {
    // A JWS is a snapshot: the current status (refund, revocation) is read
    // from the Server API before any grant.
    let transactionResult = await fetchTransactionInfo(input, options, environment);
    if (
      sandbox !== undefined
      && environment === 'Production'
      && transactionResult.status === 'pending'
      && transactionResult.reason === 'APP_STORE_TRANSACTION_NOT_FOUND'
    ) {
      // Apple keeps sandbox transaction ids out of production: a production
      // miss is looked up in the sandbox before it is reported as pending.
      environment = 'Sandbox';
      transactionResult = await fetchTransactionInfo(input, options, environment);
    }
    if (transactionResult.status !== 'found') {
      return { status: transactionResult.status, reason: transactionResult.reason };
    }
    const fresh = await verifySignedTransaction(
      transactionResult.signedTransactionInfo,
      input,
      options,
      environment,
    );
    if (fresh.status !== 'verified') {
      return fresh;
    }
    if (
      offlineTransaction !== undefined
      && fresh.payload.transactionId !== offlineTransaction.transactionId
    ) {
      return { status: 'rejected', reason: 'APP_STORE_SIGNED_TRANSACTION_ID_MISMATCH' };
    }
    transaction = fresh.payload;
  }

  const expectedAccountToken = await resolveExpectedAppAccountToken(input, options);
  if (expectedAccountToken.status !== 'verified') {
    return expectedAccountToken;
  }

  const nowIso = now();
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(nowMs)) {
    return { status: 'pending', reason: 'APP_STORE_VERIFIER_CLOCK_INVALID' };
  }

  if (
    offlineTransaction !== undefined
    && policy.mode === 'offline-only'
    && nowMs - transaction.signedDate > policy.maxSignedAgeMs
  ) {
    // Offline-only never sees a later refund; a JWS older than the window is
    // not fresh enough to decide a grant on.
    return { status: 'rejected', reason: 'APP_STORE_SIGNED_TRANSACTION_STALE' };
  }

  const rejection = validateTransaction(
    input,
    transaction,
    options.bundleId,
    environment,
    expectedAccountToken.value,
    nowMs,
    clockSkewMs,
  );
  if (rejection !== undefined) {
    return { status: 'rejected', reason: rejection };
  }

  return {
    status: 'verified',
    verificationId: createVerificationId(transaction),
    verifiedAt: new Date(nowMs).toISOString(),
    payload: {
      appStoreBundleId: transaction.bundleId,
      appStoreEnvironment: transaction.environment,
      appStoreOriginalTransactionId: transaction.originalTransactionId,
      appStorePurchaseDate: transaction.purchaseDate,
      appStoreQuantity: transaction.quantity ?? 1,
      appStoreSignedDate: transaction.signedDate,
      appStoreTransactionType: transaction.type,
    },
  };
}

const defaultSignedTransactionEvidencePolicy: AppStoreSignedTransactionEvidencePolicy = {
  mode: 'server-api',
};

type AppStoreSandboxGrantPolicy = Extract<AppStoreSandboxPurchasePolicy, { readonly mode: 'grant' }>;

function readSandboxGrantPolicy(
  options: CreateAppStoreEvidenceVerifierOptions,
): AppStoreSandboxGrantPolicy | undefined {
  return options.environment === 'Production' && options.sandboxPurchases?.mode === 'grant'
    ? options.sandboxPurchases
    : undefined;
}

/**
 * Whether the production verifier placed a JWS in the sandbox: Apple's
 * adapter refuses it with `APP_STORE_ENVIRONMENT_MISMATCH` after the
 * signature check, and a custom verifier may return the decoded `Sandbox`
 * payload. Either way it is verified again by the sandbox verifier before
 * anything is read from it.
 */
function isSandboxSignal(
  result: Awaited<ReturnType<typeof verifySignedTransaction>>,
): boolean {
  return result.status === 'verified'
    ? result.payload.environment === 'Sandbox'
    : result.reason === 'APP_STORE_ENVIRONMENT_MISMATCH';
}

async function fetchTransactionInfo(
  input: VerifyPurchaseEvidenceInput,
  options: CreateAppStoreEvidenceVerifierOptions,
  environment: AppStoreEnvironment,
): Promise<AppStoreServerApiTransactionResult> {
  const serverApi = environment === options.environment
    ? options.serverApi
    : (readSandboxGrantPolicy(options)?.serverApi ?? options.serverApi);
  let transactionResult: AppStoreServerApiTransactionResult;
  try {
    transactionResult = await serverApi.getTransactionInfo({
      transactionId: input.request.platformTransactionId,
      environment,
      signal: input.signal,
    });
  } catch (error) {
    if (!(error instanceof AppStoreDependencyUnavailableError)) {
      throw error;
    }
    return { status: 'pending', reason: 'APP_STORE_SERVER_API_UNAVAILABLE' };
  }
  try {
    assertAppStoreServerApiTransactionResult(transactionResult);
  } catch {
    return { status: 'pending', reason: 'APP_STORE_SERVER_API_INVALID_RESPONSE' };
  }
  return transactionResult;
}

function assertSandboxPurchasePolicy(
  input: unknown,
  environment: AppStoreEnvironment,
): asserts input is AppStoreSandboxPurchasePolicy | undefined {
  if (input === undefined) {
    return;
  }
  assertRecord(input, 'sandboxPurchases');
  if (input.mode === 'reject') {
    return;
  }
  if (input.mode !== 'grant') {
    throw new Error('sandboxPurchases.mode must be reject or grant.');
  }
  if (environment !== 'Production') {
    throw new Error('sandboxPurchases applies only to a Production verifier.');
  }
  assertRecord(input.signedTransactionVerifier, 'sandboxPurchases.signedTransactionVerifier');
  if (typeof input.signedTransactionVerifier.verifyAndDecode !== 'function') {
    throw new Error('sandboxPurchases.signedTransactionVerifier must verify sandbox JWS.');
  }
  if (input.serverApi !== undefined) {
    assertRecord(input.serverApi, 'sandboxPurchases.serverApi');
  }
}

function assertSignedTransactionEvidencePolicy(
  input: unknown,
): asserts input is AppStoreSignedTransactionEvidencePolicy | undefined {
  if (input === undefined) {
    return;
  }
  assertRecord(input, 'signedTransactionEvidence');
  if (input.mode === 'ignore' || input.mode === 'server-api') {
    return;
  }
  if (input.mode === 'offline-only') {
    readPositiveSafeInteger(input.maxSignedAgeMs, 'signedTransactionEvidence.maxSignedAgeMs');
    return;
  }
  throw new Error('signedTransactionEvidence.mode must be ignore, server-api, or offline-only.');
}

/** Verifies one JWS through the signature port and validates the decoded payload shape. */
async function verifySignedTransaction(
  signedTransaction: string,
  input: VerifyPurchaseEvidenceInput,
  options: CreateAppStoreEvidenceVerifierOptions,
  environment: AppStoreEnvironment,
): Promise<
  | { readonly status: 'verified'; readonly payload: AppStoreTransactionPayload }
  | { readonly status: 'pending' | 'rejected'; readonly reason: string }
> {
  const verifier = environment === options.environment
    ? options.signedTransactionVerifier
    : readSandboxGrantPolicy(options)?.signedTransactionVerifier;
  if (verifier === undefined) {
    return { status: 'rejected', reason: 'APP_STORE_ENVIRONMENT_MISMATCH' };
  }
  let signatureResult: AppStoreSignedTransactionVerificationResult;
  try {
    signatureResult = await verifier.verifyAndDecode({
      signedTransaction,
      environment,
      bundleId: options.bundleId,
      signal: input.signal,
    });
  } catch (error) {
    if (!(error instanceof AppStoreDependencyUnavailableError)) {
      throw error;
    }
    return { status: 'pending', reason: 'APP_STORE_SIGNATURE_VERIFIER_UNAVAILABLE' };
  }

  try {
    assertAppStoreSignedTransactionVerificationResult(signatureResult);
  } catch {
    return { status: 'rejected', reason: 'APP_STORE_SIGNATURE_RESULT_INVALID' };
  }
  if (signatureResult.status === 'rejected') {
    return { status: 'rejected', reason: signatureResult.reason };
  }
  return { status: 'verified', payload: signatureResult.payload };
}

async function resolveExpectedAppAccountToken(
  input: VerifyPurchaseEvidenceInput,
  options: CreateAppStoreEvidenceVerifierOptions,
): Promise<
  | { readonly status: 'verified'; readonly value: string }
  | { readonly status: 'pending'; readonly reason: string }
> {
  try {
    const value = await options.resolveAppAccountToken({
      playerId: input.request.playerId,
      signal: input.signal,
    });
    return { status: 'verified', value: normalizeAppAccountToken(value) };
  } catch (error) {
    if (!(error instanceof AppStoreDependencyUnavailableError)) {
      throw error;
    }
    return { status: 'pending', reason: 'APP_STORE_ACCOUNT_BINDING_UNAVAILABLE' };
  }
}

function validateTransaction(
  input: VerifyPurchaseEvidenceInput,
  transaction: AppStoreTransactionPayload,
  bundleId: string,
  environment: AppStoreEnvironment,
  expectedAccountToken: string,
  nowMs: number,
  clockSkewMs: number,
): string | undefined {
  if (transaction.transactionId !== input.request.platformTransactionId) {
    return 'APP_STORE_TRANSACTION_ID_MISMATCH';
  }
  if (transaction.bundleId !== bundleId) {
    return 'APP_STORE_BUNDLE_ID_MISMATCH';
  }
  if (transaction.productId !== input.platformProductId) {
    return 'APP_STORE_PRODUCT_ID_MISMATCH';
  }
  if (transaction.environment !== environment) {
    return 'APP_STORE_ENVIRONMENT_MISMATCH';
  }
  if (transaction.inAppOwnershipType === 'FAMILY_SHARED') {
    // A family member's access to the organizer's non-consumable: it carries
    // no app account token of this player, and refusing it explicitly keeps
    // one purchase from granting several players. Leave Family Sharing off
    // for the game's In-App Purchases in App Store Connect.
    return 'APP_STORE_FAMILY_SHARED_UNSUPPORTED';
  }
  if (
    transaction.inAppOwnershipType !== undefined
    && transaction.inAppOwnershipType !== 'PURCHASED'
  ) {
    return 'APP_STORE_OWNERSHIP_UNSUPPORTED';
  }
  if (
    transaction.appAccountToken === undefined
    || normalizeAppAccountToken(transaction.appAccountToken) !== expectedAccountToken
  ) {
    return 'APP_STORE_ACCOUNT_TOKEN_MISMATCH';
  }
  if (toCatalogProductType(transaction.type) !== input.product.type) {
    return 'APP_STORE_PRODUCT_TYPE_MISMATCH';
  }
  const clientPurchaseObservedAt = Date.parse(input.request.purchasedAt);
  if (!Number.isFinite(clientPurchaseObservedAt)) {
    return 'APP_STORE_CLIENT_PURCHASE_TIME_INVALID';
  }
  if (clientPurchaseObservedAt > nowMs + clockSkewMs) {
    return 'APP_STORE_CLIENT_PURCHASE_TIME_IN_FUTURE';
  }
  if (transaction.quantity !== undefined && transaction.quantity !== 1) {
    return 'APP_STORE_QUANTITY_UNSUPPORTED';
  }
  if (transaction.purchaseDate > nowMs + clockSkewMs) {
    return 'APP_STORE_PURCHASE_DATE_IN_FUTURE';
  }
  if (transaction.signedDate < transaction.purchaseDate) {
    return 'APP_STORE_SIGNED_DATE_INVALID';
  }
  if (transaction.signedDate > nowMs + clockSkewMs) {
    return 'APP_STORE_SIGNED_DATE_IN_FUTURE';
  }
  if (transaction.revocationDate !== undefined) {
    return 'APP_STORE_TRANSACTION_REVOKED';
  }
  if (transaction.isUpgraded === true) {
    return 'APP_STORE_TRANSACTION_UPGRADED';
  }
  if (transaction.expiresDate !== undefined && transaction.expiresDate <= nowMs) {
    return 'APP_STORE_TRANSACTION_EXPIRED';
  }
  return undefined;
}

function createVerificationId(transaction: AppStoreTransactionPayload): string {
  const grantTransactionId = transaction.type === 'Non-Consumable'
    ? transaction.originalTransactionId
    : transaction.transactionId;
  return createAppStoreVerificationId({
    environment: transaction.environment,
    bundleId: transaction.bundleId,
    transactionId: grantTransactionId,
  });
}

export function createAppStoreVerificationId(input: {
  readonly environment: AppStoreEnvironment;
  readonly bundleId: string;
  readonly transactionId: string;
}): string {
  return [
    'app-store',
    input.environment,
    input.bundleId,
    input.transactionId,
  ].map(encodeVerificationIdSegment).join(':');
}

/** Identify IDs emitted by this verifier without duplicating its encoding format. */
export function isAppStoreVerificationId(verificationId: string): boolean {
  const parts = verificationId.split(':');
  if (parts.length !== 8) {
    return false;
  }
  const values: string[] = [];
  for (let index = 0; index < parts.length; index += 2) {
    const rawLength = parts[index];
    const encoded = parts[index + 1];
    if (rawLength === undefined || encoded === undefined
      || !/^(0|[1-9][0-9]*)$/u.test(rawLength)) {
      return false;
    }
    try {
      const value = decodeURIComponent(encoded);
      if (value.length !== Number(rawLength)
        || encodeVerificationIdSegment(value) !== `${rawLength}:${encoded}`) {
        return false;
      }
      values.push(value);
    } catch {
      return false;
    }
  }
  return values[0] === 'app-store'
    && (values[1] === 'Production' || values[1] === 'Sandbox')
    && typeof values[2] === 'string' && values[2].length > 0
    && typeof values[3] === 'string' && /^[1-9][0-9]{0,19}$/u.test(values[3]);
}

function encodeVerificationIdSegment(value: string): string {
  return `${value.length}:${encodeURIComponent(value)}`;
}

function toCatalogProductType(type: AppStoreInAppPurchaseType): ProductType {
  switch (type) {
    case 'Consumable':
      return 'consumable';
    case 'Non-Consumable':
      return 'non_consumable';
    case 'Auto-Renewable Subscription':
    case 'Non-Renewing Subscription':
      return 'subscription';
  }
}

function assertAppStoreServerApiTransactionResult(
  input: unknown,
): asserts input is AppStoreServerApiTransactionResult {
  assertRecord(input, 'AppStoreServerApiTransactionResult');
  if (input.status === 'found') {
    assertNonEmptyString(input.signedTransactionInfo, 'signedTransactionInfo');
    return;
  }
  if (input.status === 'pending' || input.status === 'rejected') {
    assertNonEmptyString(input.reason, 'reason');
    return;
  }
  throw new Error('AppStoreServerApiTransactionResult.status is invalid.');
}

function assertAppStoreSignedTransactionVerificationResult(
  input: unknown,
): asserts input is AppStoreSignedTransactionVerificationResult {
  assertRecord(input, 'AppStoreSignedTransactionVerificationResult');
  if (input.status === 'verified') {
    assertAppStoreTransactionPayload(input.payload);
    return;
  }
  if (input.status === 'rejected') {
    assertNonEmptyString(input.reason, 'reason');
    return;
  }
  throw new Error('AppStoreSignedTransactionVerificationResult.status is invalid.');
}

export function assertAppStoreTransactionPayload(
  input: unknown,
): AppStoreTransactionPayload {
  assertRecord(input, 'AppStoreTransactionPayload');
  assertNonEmptyString(input.transactionId, 'transactionId');
  assertNonEmptyString(input.originalTransactionId, 'originalTransactionId');
  assertNonEmptyString(input.bundleId, 'bundleId');
  assertNonEmptyString(input.productId, 'productId');
  assertNonNegativeSafeInteger(input.purchaseDate, 'purchaseDate');
  assertNonNegativeSafeInteger(input.signedDate, 'signedDate');
  assertAppStoreEnvironment(input.environment);
  assertAppStoreInAppPurchaseType(input.type);
  assertOptionalPositiveSafeInteger(input.quantity, 'quantity');
  assertOptionalAppAccountToken(input.appAccountToken);
  assertOptionalNonNegativeSafeInteger(input.expiresDate, 'expiresDate');
  assertOptionalNonNegativeSafeInteger(input.revocationDate, 'revocationDate');
  assertOptionalBoolean(input.isUpgraded, 'isUpgraded');
  if (input.inAppOwnershipType !== undefined) {
    assertNonEmptyString(input.inAppOwnershipType, 'inAppOwnershipType');
  }
  return input as unknown as AppStoreTransactionPayload;
}

async function readBoundedJson(
  response: AppStoreFetchResponse,
  maxResponseBytes: number,
  signal: AbortSignal,
): Promise<unknown> {
  if (response.body === null) {
    throw new Error('App Store Server API response body is missing.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let byteLength = 0;
  let text = '';
  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (error) {
        if (signal.aborted) {
          throw error;
        }
        throw new AppStoreDependencyUnavailableError(
          'App Store Server API response stream is unavailable.',
          error,
        );
      }
      if (chunk.done) {
        break;
      }
      if (!(chunk.value instanceof Uint8Array)) {
        throw new Error('App Store Server API response body yielded an invalid chunk.');
      }
      byteLength += chunk.value.byteLength;
      if (byteLength > maxResponseBytes) {
        throw new AppStoreResponseTooLargeError();
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(text) as unknown;
}

async function cancelResponseBody(response: AppStoreFetchResponse): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

function readGlobalFetch(): AppStoreFetch {
  if (typeof globalThis.fetch !== 'function') {
    throw new Error('A fetch implementation is required for App Store Server API requests.');
  }
  return globalThis.fetch as AppStoreFetch;
}

function assertAuthorizationValue(input: unknown, label: string): asserts input is string {
  assertNonEmptyString(input, label);
  if (/\s/u.test(input)) {
    throw new Error(`${label} must not contain whitespace or header control characters.`);
  }
}

function normalizeAppAccountToken(input: unknown): string {
  assertNonEmptyString(input, 'appAccountToken');
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(input)) {
    throw new Error('appAccountToken must be a UUID.');
  }
  const normalized = input.toLowerCase();
  if (normalized === '00000000-0000-0000-0000-000000000000') {
    throw new Error('appAccountToken must not be the nil UUID.');
  }
  return normalized;
}

function assertOptionalAppAccountToken(input: unknown): asserts input is string | undefined {
  if (input !== undefined) {
    normalizeAppAccountToken(input);
  }
}

function assertAppStoreEnvironment(input: unknown): asserts input is AppStoreEnvironment {
  if (input !== 'Production' && input !== 'Sandbox') {
    throw new Error('environment must be Production or Sandbox.');
  }
}

function assertAppStoreInAppPurchaseType(
  input: unknown,
): asserts input is AppStoreInAppPurchaseType {
  if (
    input !== 'Auto-Renewable Subscription'
    && input !== 'Consumable'
    && input !== 'Non-Consumable'
    && input !== 'Non-Renewing Subscription'
  ) {
    throw new Error('type must be a supported App Store in-app purchase type.');
  }
}

function assertRecord(input: unknown, label: string): asserts input is Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error(`${label} must be an object.`);
  }
}

function assertNonEmptyString(input: unknown, label: string): asserts input is string {
  if (typeof input !== 'string' || input.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
}

function assertNonNegativeSafeInteger(
  input: unknown,
  label: string,
): asserts input is number {
  if (!Number.isSafeInteger(input) || (input as number) < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
}

function assertOptionalNonNegativeSafeInteger(
  input: unknown,
  label: string,
): asserts input is number | undefined {
  if (input !== undefined) {
    assertNonNegativeSafeInteger(input, label);
  }
}

function assertOptionalPositiveSafeInteger(
  input: unknown,
  label: string,
): asserts input is number | undefined {
  if (input !== undefined && (!Number.isSafeInteger(input) || (input as number) <= 0)) {
    throw new Error(`${label} must be a positive safe integer when provided.`);
  }
}

function assertOptionalBoolean(
  input: unknown,
  label: string,
): asserts input is boolean | undefined {
  if (input !== undefined && typeof input !== 'boolean') {
    throw new Error(`${label} must be a boolean when provided.`);
  }
}

function readPositiveSafeInteger(input: unknown, label: string): number {
  if (!Number.isSafeInteger(input) || (input as number) <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return input as number;
}

function readNonNegativeSafeInteger(input: unknown, label: string): number {
  assertNonNegativeSafeInteger(input, label);
  return input;
}
