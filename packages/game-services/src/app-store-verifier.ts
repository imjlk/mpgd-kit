import type { ProductType } from '@mpgd/platform';

import type {
  EvidenceVerificationDecision,
  GameServicesEvidenceVerifier,
  VerifyPurchaseEvidenceInput,
} from './evidence-verification';

export type AppStoreEnvironment = 'Production' | 'Sandbox';

export const appStoreServerApiBaseUrls = Object.freeze({
  Production: 'https://api.storekit.apple.com',
  Sandbox: 'https://api.storekit-sandbox.apple.com',
} as const) satisfies Readonly<Record<AppStoreEnvironment, string>>;

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
  readonly getBearerToken: () => string | Promise<string>;
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
}

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
      const token = await options.getBearerToken();
      assertAuthorizationValue(token, 'App Store bearer token');
      const url = new URL(
        `/inApps/v1/transactions/${encodeURIComponent(input.transactionId)}`,
        appStoreServerApiBaseUrls[input.environment],
      );
      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${token}`,
        },
        signal: input.signal,
      });

      if (response.status === 200) {
        const body = await readBoundedJson(response, maxResponseBytes);
        assertRecord(body, 'App Store transaction response');
        assertNonEmptyString(body.signedTransactionInfo, 'signedTransactionInfo');
        return {
          status: 'found',
          signedTransactionInfo: body.signedTransactionInfo,
        };
      }

      if (response.status === 400) {
        return { status: 'rejected', reason: 'APP_STORE_INVALID_TRANSACTION_ID' };
      }

      if (response.status === 404) {
        return { status: 'rejected', reason: 'APP_STORE_TRANSACTION_NOT_FOUND' };
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

  let transactionResult: AppStoreServerApiTransactionResult;
  try {
    transactionResult = await options.serverApi.getTransactionInfo({
      transactionId: input.request.platformTransactionId,
      environment: options.environment,
      signal: input.signal,
    });
  } catch {
    return { status: 'pending', reason: 'APP_STORE_SERVER_API_UNAVAILABLE' };
  }

  try {
    assertAppStoreServerApiTransactionResult(transactionResult);
  } catch {
    return { status: 'pending', reason: 'APP_STORE_SERVER_API_INVALID_RESPONSE' };
  }
  if (transactionResult.status !== 'found') {
    return transactionResult;
  }

  let signatureResult: AppStoreSignedTransactionVerificationResult;
  try {
    signatureResult = await options.signedTransactionVerifier.verifyAndDecode({
      signedTransaction: transactionResult.signedTransactionInfo,
      environment: options.environment,
      bundleId: options.bundleId,
      signal: input.signal,
    });
  } catch {
    return { status: 'pending', reason: 'APP_STORE_SIGNATURE_VERIFIER_UNAVAILABLE' };
  }

  try {
    assertAppStoreSignedTransactionVerificationResult(signatureResult);
  } catch {
    return { status: 'pending', reason: 'APP_STORE_SIGNATURE_RESULT_INVALID' };
  }
  if (signatureResult.status === 'rejected') {
    return signatureResult;
  }

  const transaction = assertAppStoreTransactionPayload(signatureResult.payload);
  const expectedAccountToken = await resolveExpectedAppAccountToken(input, options);
  if (expectedAccountToken.status !== 'verified') {
    return expectedAccountToken;
  }

  const nowIso = now();
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(nowMs)) {
    return { status: 'pending', reason: 'APP_STORE_VERIFIER_CLOCK_INVALID' };
  }

  const rejection = validateTransaction(
    input,
    transaction,
    options,
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
  } catch {
    return { status: 'pending', reason: 'APP_STORE_ACCOUNT_BINDING_UNAVAILABLE' };
  }
}

function validateTransaction(
  input: VerifyPurchaseEvidenceInput,
  transaction: AppStoreTransactionPayload,
  options: CreateAppStoreEvidenceVerifierOptions,
  expectedAccountToken: string,
  nowMs: number,
  clockSkewMs: number,
): string | undefined {
  if (transaction.transactionId !== input.request.platformTransactionId) {
    return 'APP_STORE_TRANSACTION_ID_MISMATCH';
  }
  if (transaction.bundleId !== options.bundleId) {
    return 'APP_STORE_BUNDLE_ID_MISMATCH';
  }
  if (transaction.productId !== input.platformProductId) {
    return 'APP_STORE_PRODUCT_ID_MISMATCH';
  }
  if (transaction.environment !== options.environment) {
    return 'APP_STORE_ENVIRONMENT_MISMATCH';
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
  if (
    (transaction.type === 'Consumable' && transaction.quantity !== 1)
    || (transaction.type !== 'Consumable'
      && transaction.quantity !== undefined
      && transaction.quantity !== 1)
  ) {
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
  return [
    'app-store',
    transaction.environment,
    transaction.bundleId,
    transaction.transactionId,
  ].map(encodeVerificationIdSegment).join(':');
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
  return input as unknown as AppStoreTransactionPayload;
}

async function readBoundedJson(
  response: AppStoreFetchResponse,
  maxResponseBytes: number,
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
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      if (!(chunk.value instanceof Uint8Array)) {
        throw new Error('App Store Server API response body yielded an invalid chunk.');
      }
      byteLength += chunk.value.byteLength;
      if (byteLength > maxResponseBytes) {
        await reader.cancel('maxResponseBytes exceeded').catch(() => undefined);
        throw new Error('App Store Server API response exceeded maxResponseBytes.');
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(text) as unknown;
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
