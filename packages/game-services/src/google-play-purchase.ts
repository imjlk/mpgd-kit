import type {
  FinalizePurchaseGrantInput,
  GameServicesEvidenceVerifier,
  GameServicesPurchaseGrantFinalizer,
  VerifyPurchaseEvidenceInput,
} from './evidence-verification';
import type { EntitlementLedgerPayload, PurchaseGrantFinalization } from './types';

export const googlePlayProductPurchaseEvidenceSchema = 'google-play.product-purchase.v2';

export type GooglePlayPurchaseState =
  | 'PURCHASED'
  | 'CANCELLED'
  | 'PENDING'
  | 'PURCHASE_STATE_UNSPECIFIED';
export type GooglePlayConsumptionState =
  | 'CONSUMPTION_STATE_YET_TO_BE_CONSUMED'
  | 'CONSUMPTION_STATE_CONSUMED'
  | 'CONSUMPTION_STATE_UNSPECIFIED';
export type GooglePlayAcknowledgementState =
  | 'ACKNOWLEDGEMENT_STATE_PENDING'
  | 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED'
  | 'ACKNOWLEDGEMENT_STATE_UNSPECIFIED';

export interface GooglePlayProductPurchaseClient {
  getProductPurchaseV2(input: {
    readonly packageName: string;
    readonly purchaseToken: string;
    readonly signal: AbortSignal;
  }): Promise<unknown>;
  acknowledgeProductPurchase(input: {
    readonly packageName: string;
    readonly productId: string;
    readonly purchaseToken: string;
    readonly signal: AbortSignal;
  }): Promise<void>;
  consumeProductPurchase(input: {
    readonly packageName: string;
    readonly productId: string;
    readonly purchaseToken: string;
    readonly signal: AbortSignal;
  }): Promise<void>;
}

export interface CreateGooglePlayProductPurchaseBoundaryInput {
  readonly client: GooglePlayProductPurchaseClient;
  readonly packageName: string;
  readonly now?: () => string;
  /**
   * Explicitly permits purchases without a Google account identifier. Use only
   * when the caller binds `playerId` to an authenticated application account.
   */
  readonly allowUnboundAuthenticatedPlayer?: boolean;
  readonly resolveObfuscatedAccountId?: (
    playerId: string,
    signal: AbortSignal,
  ) => Promise<string | undefined> | string | undefined;
}

export interface GooglePlayProductPurchaseBoundary extends GameServicesPurchaseGrantFinalizer {
  verifyPurchase(
    input: VerifyPurchaseEvidenceInput,
  ): ReturnType<GameServicesEvidenceVerifier['verifyPurchase']>;
}

interface InspectedGooglePlayPurchase {
  readonly purchaseToken: string;
  readonly purchaseTokenDigest: string;
  readonly productId: string;
  readonly orderId?: string;
  readonly purchaseCompletionTime: string;
  readonly consumptionState: GooglePlayConsumptionState;
  readonly acknowledgementState: GooglePlayAcknowledgementState;
  readonly obfuscatedExternalAccountId?: string;
}

type GooglePlayPurchaseInspection =
  | { readonly status: 'verified'; readonly purchase: InspectedGooglePlayPurchase }
  | { readonly status: 'pending'; readonly reason: string }
  | { readonly status: 'rejected'; readonly reason: string };

export function createGooglePlayProductPurchaseBoundary(
  input: CreateGooglePlayProductPurchaseBoundaryInput,
): GooglePlayProductPurchaseBoundary {
  const packageName = assertIdentifier(input.packageName, 'packageName', 256);
  if (
    input.resolveObfuscatedAccountId === undefined
    && input.allowUnboundAuthenticatedPlayer !== true
  ) {
    throw new TypeError(
      'Google Play purchases require account binding or explicit authenticated-player attribution.',
    );
  }
  const now = input.now ?? (() => new Date().toISOString());
  const inFlightFinalizations = new Map<string, Promise<PurchaseGrantFinalization>>();

  return {
    supportsPurchaseGrant(finalizationInput) {
      return finalizationInput.request.target === 'android'
        && finalizationInput.product.type !== 'subscription'
        && finalizationInput.request.evidence?.schema
          === googlePlayProductPurchaseEvidenceSchema;
    },

    async verifyPurchase(verificationInput) {
      if (verificationInput.request.target !== 'android') {
        return {
          status: 'rejected',
          reason: 'GOOGLE_PLAY_TARGET_REQUIRED',
        };
      }

      if (verificationInput.product.type === 'subscription') {
        return {
          status: 'rejected',
          reason: 'GOOGLE_PLAY_SUBSCRIPTION_VERIFIER_REQUIRED',
        };
      }

      const purchaseToken = readPurchaseToken(verificationInput.request.evidence);
      if (purchaseToken === undefined) {
        return {
          status: 'rejected',
          reason: 'GOOGLE_PLAY_PURCHASE_TOKEN_REQUIRED',
        };
      }

      const accountBinding = await resolveGooglePlayAccountBinding(
        input,
        verificationInput.request.playerId,
        verificationInput.signal,
      );
      if (accountBinding.status === 'rejected') {
        return rejected(accountBinding.reason);
      }
      const inspection = await inspectGooglePlayPurchase({
        client: input.client,
        packageName,
        purchaseToken,
        expectedProductId: verificationInput.platformProductId,
        expectedProductType: verificationInput.product.type,
        orderMatch: {
          mode: 'if-present',
          orderId: verificationInput.request.platformTransactionId,
        },
        accountBinding,
        allowConsumed: false,
        signal: verificationInput.signal,
      });

      if (inspection.status !== 'verified') {
        return inspection;
      }

      return {
        status: 'verified',
        verificationId: createGooglePlayVerificationId(
          inspection.purchase.purchaseTokenDigest,
        ),
        verifiedAt: now(),
        platformEvidenceId: inspection.purchase.orderId ?? null,
        payload: createVerificationPayload(packageName, inspection.purchase),
      };
    },

    async finalizePurchaseGrant(finalizationInput) {
      if (finalizationInput.product.type === 'subscription') {
        return {
          status: 'pending',
          alreadyCompleted: false,
          reason: 'GOOGLE_PLAY_SUBSCRIPTION_VERIFIER_REQUIRED',
        };
      }

      const action = finalizationInput.product.type === 'consumable'
        ? 'consume'
        : 'acknowledge';
      const purchaseToken = readPurchaseToken(finalizationInput.request.evidence);

      if (purchaseToken === undefined) {
        return {
          status: 'pending',
          action,
          alreadyCompleted: false,
          reason: 'GOOGLE_PLAY_PURCHASE_TOKEN_REQUIRED',
        };
      }

      const purchaseTokenDigest = await digestPurchaseToken(packageName, purchaseToken);
      if (
        finalizationInput.evidenceVerificationId
        !== createGooglePlayVerificationId(purchaseTokenDigest)
      ) {
        return {
          status: 'pending',
          action,
          alreadyCompleted: false,
          reason: 'GOOGLE_PLAY_FINALIZATION_EVIDENCE_MISMATCH',
        };
      }
      const verifiedContext = readGooglePlayVerifiedContext(
        finalizationInput.evidencePayload,
        packageName,
        finalizationInput.platformProductId,
        purchaseTokenDigest,
      );

      const existing = inFlightFinalizations.get(finalizationInput.evidenceVerificationId);
      if (existing !== undefined) {
        return existing;
      }

      const finalization = finalizeGooglePlayPurchase(
        input,
        packageName,
        purchaseToken,
        finalizationInput.product.type,
        action,
        verifiedContext,
        finalizationInput,
      );
      inFlightFinalizations.set(finalizationInput.evidenceVerificationId, finalization);

      try {
        return await finalization;
      } finally {
        if (inFlightFinalizations.get(finalizationInput.evidenceVerificationId) === finalization) {
          inFlightFinalizations.delete(finalizationInput.evidenceVerificationId);
        }
      }
    },
  };
}

async function finalizeGooglePlayPurchase(
  input: CreateGooglePlayProductPurchaseBoundaryInput,
  packageName: string,
  purchaseToken: string,
  productType: 'consumable' | 'non_consumable',
  action: 'consume' | 'acknowledge',
  verifiedContext: GooglePlayVerifiedContext | undefined,
  finalizationInput: FinalizePurchaseGrantInput,
): Promise<PurchaseGrantFinalization> {
  if (finalizationInput.request.target !== 'android') {
    return {
      status: 'pending',
      action,
      alreadyCompleted: false,
      reason: 'GOOGLE_PLAY_TARGET_REQUIRED',
    };
  }

  try {
    const accountBinding = verifiedContext?.accountBinding
      ?? await resolveGooglePlayAccountBinding(
        input,
        finalizationInput.request.playerId,
        finalizationInput.signal,
      );
    if (accountBinding.status === 'rejected') {
      return {
        status: 'pending',
        action,
        alreadyCompleted: false,
        reason: accountBinding.reason,
      };
    }
    const inspection = await inspectGooglePlayPurchase({
      client: input.client,
      packageName,
      purchaseToken,
      expectedProductId: finalizationInput.platformProductId,
      expectedProductType: productType,
      orderMatch: createGooglePlayFinalizationOrderMatch(
        verifiedContext,
        finalizationInput.request.platformTransactionId,
      ),
      accountBinding,
      allowConsumed: true,
      signal: finalizationInput.signal,
    });

    if (inspection.status !== 'verified') {
      return {
        status: 'pending',
        action,
        alreadyCompleted: false,
        reason: inspection.reason,
      };
    }

    if (action === 'consume') {
      if (inspection.purchase.consumptionState === 'CONSUMPTION_STATE_CONSUMED') {
        return {
          status: 'completed',
          action,
          alreadyCompleted: true,
        };
      }

      if (
        inspection.purchase.consumptionState
        !== 'CONSUMPTION_STATE_YET_TO_BE_CONSUMED'
      ) {
        return {
          status: 'pending',
          action,
          alreadyCompleted: false,
          reason: 'GOOGLE_PLAY_CONSUMPTION_STATE_UNSPECIFIED',
        };
      }

      await input.client.consumeProductPurchase({
        packageName,
        productId: finalizationInput.platformProductId,
        purchaseToken,
        signal: finalizationInput.signal,
      });
    } else {
      if (
        inspection.purchase.acknowledgementState
        === 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED'
      ) {
        return {
          status: 'completed',
          action,
          alreadyCompleted: true,
        };
      }

      if (
        inspection.purchase.acknowledgementState
        !== 'ACKNOWLEDGEMENT_STATE_PENDING'
      ) {
        return {
          status: 'pending',
          action,
          alreadyCompleted: false,
          reason: 'GOOGLE_PLAY_ACKNOWLEDGEMENT_STATE_UNSPECIFIED',
        };
      }

      await input.client.acknowledgeProductPurchase({
        packageName,
        productId: finalizationInput.platformProductId,
        purchaseToken,
        signal: finalizationInput.signal,
      });
    }

    return {
      status: 'completed',
      action,
      alreadyCompleted: false,
    };
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw error;
    }

    return {
      status: 'pending',
      action,
      alreadyCompleted: false,
      reason: 'GOOGLE_PLAY_API_ERROR',
    };
  }
}

async function inspectGooglePlayPurchase(input: {
  readonly client: GooglePlayProductPurchaseClient;
  readonly packageName: string;
  readonly purchaseToken: string;
  readonly expectedProductId: string;
  readonly expectedProductType: 'consumable' | 'non_consumable';
  readonly orderMatch: GooglePlayOrderMatch;
  readonly accountBinding: VerifiedGooglePlayAccountBinding;
  readonly allowConsumed: boolean;
  readonly signal: AbortSignal;
}): Promise<GooglePlayPurchaseInspection> {
  const raw = await input.client.getProductPurchaseV2({
    packageName: input.packageName,
    purchaseToken: input.purchaseToken,
    signal: input.signal,
  });

  if (!isRecord(raw)) {
    return rejected('GOOGLE_PLAY_RESPONSE_INVALID');
  }

  const stateContext = raw.purchaseStateContext;
  const purchaseState = isRecord(stateContext)
    ? readPurchaseState(stateContext.purchaseState)
    : undefined;

  if (purchaseState === 'PENDING') {
    return {
      status: 'pending',
      reason: 'GOOGLE_PLAY_PURCHASE_PENDING',
    };
  }
  if (purchaseState === 'CANCELLED') {
    return rejected('GOOGLE_PLAY_PURCHASE_CANCELLED');
  }
  if (purchaseState !== 'PURCHASED') {
    return rejected('GOOGLE_PLAY_PURCHASE_STATE_UNSPECIFIED');
  }

  const lineItems = raw.productLineItem;
  if (!Array.isArray(lineItems) || lineItems.length !== 1 || !isRecord(lineItems[0])) {
    return rejected('GOOGLE_PLAY_LINE_ITEM_COUNT_UNSUPPORTED');
  }

  const lineItem = lineItems[0];
  if (lineItem.productId !== input.expectedProductId) {
    return rejected('GOOGLE_PLAY_PRODUCT_MISMATCH');
  }

  const offerDetails = lineItem.productOfferDetails;
  if (!isRecord(offerDetails)) {
    return rejected('GOOGLE_PLAY_OFFER_DETAILS_INVALID');
  }

  const quantity = offerDetails.quantity;
  if (!Number.isSafeInteger(quantity) || quantity !== 1) {
    return rejected('GOOGLE_PLAY_QUANTITY_UNSUPPORTED');
  }

  const refundableQuantity = offerDetails.refundableQuantity;
  if (
    typeof refundableQuantity !== 'number'
    || !Number.isSafeInteger(refundableQuantity)
    || refundableQuantity < 0
    || refundableQuantity > quantity
  ) {
    return rejected('GOOGLE_PLAY_REFUNDABLE_QUANTITY_INVALID');
  }
  if (refundableQuantity !== quantity) {
    return rejected('GOOGLE_PLAY_PURCHASE_REFUNDED');
  }

  const consumptionState = readConsumptionState(offerDetails.consumptionState);
  if (input.expectedProductType === 'consumable'
    && consumptionState === 'CONSUMPTION_STATE_UNSPECIFIED') {
    return rejected('GOOGLE_PLAY_CONSUMPTION_STATE_UNSPECIFIED');
  }
  if (
    !input.allowConsumed
    && consumptionState === 'CONSUMPTION_STATE_CONSUMED'
  ) {
    return rejected('GOOGLE_PLAY_PURCHASE_ALREADY_CONSUMED');
  }

  const acknowledgementState = readAcknowledgementState(raw.acknowledgementState);
  if (input.expectedProductType === 'non_consumable'
    && acknowledgementState === 'ACKNOWLEDGEMENT_STATE_UNSPECIFIED') {
    return rejected('GOOGLE_PLAY_ACKNOWLEDGEMENT_STATE_UNSPECIFIED');
  }
  const orderId = readOptionalIdentifier(raw.orderId, 512);
  if (raw.orderId !== undefined && orderId === undefined) {
    return rejected('GOOGLE_PLAY_ORDER_INVALID');
  }
  if (
    (input.orderMatch.mode === 'exact' && orderId !== input.orderMatch.orderId)
    || (
      input.orderMatch.mode === 'if-present'
      && orderId !== undefined
      && orderId !== input.orderMatch.orderId
    )
  ) {
    return rejected('GOOGLE_PLAY_ORDER_MISMATCH');
  }

  const purchaseCompletionTime = readTimestamp(raw.purchaseCompletionTime);
  if (purchaseCompletionTime === undefined) {
    return rejected('GOOGLE_PLAY_COMPLETION_TIME_INVALID');
  }

  const obfuscatedExternalAccountId = readOptionalIdentifier(raw.obfuscatedExternalAccountId, 256);
  if (
    raw.obfuscatedExternalAccountId !== undefined
    && obfuscatedExternalAccountId === undefined
  ) {
    return rejected('GOOGLE_PLAY_ACCOUNT_INVALID');
  }
  if (input.accountBinding.status === 'bound'
    && obfuscatedExternalAccountId !== input.accountBinding.accountId) {
    return rejected('GOOGLE_PLAY_ACCOUNT_MISMATCH');
  }
  // The unbound opt-in is safe only when the provider response is also unbound.
  if (input.accountBinding.status === 'unbound' && obfuscatedExternalAccountId !== undefined) {
    return rejected('GOOGLE_PLAY_ACCOUNT_MISMATCH');
  }

  return {
    status: 'verified',
    purchase: {
      purchaseToken: input.purchaseToken,
      purchaseTokenDigest: await digestPurchaseToken(
        input.packageName,
        input.purchaseToken,
      ),
      productId: input.expectedProductId,
      ...(orderId === undefined ? {} : { orderId }),
      purchaseCompletionTime,
      consumptionState,
      acknowledgementState,
      ...(obfuscatedExternalAccountId === undefined
        ? {}
        : { obfuscatedExternalAccountId }),
    },
  };
}

type GooglePlayAccountBinding =
  | { readonly status: 'bound'; readonly accountId: string }
  | { readonly status: 'unbound' }
  | { readonly status: 'rejected'; readonly reason: string };

type VerifiedGooglePlayAccountBinding = Exclude<
  GooglePlayAccountBinding,
  { readonly status: 'rejected' }
>;

interface GooglePlayVerifiedContext {
  readonly orderId?: string;
  readonly accountBinding: VerifiedGooglePlayAccountBinding;
}

type GooglePlayOrderMatch =
  | { readonly mode: 'if-present'; readonly orderId: string }
  | { readonly mode: 'exact'; readonly orderId: string }
  | { readonly mode: 'token-only' };

function createGooglePlayFinalizationOrderMatch(
  verifiedContext: GooglePlayVerifiedContext | undefined,
  clientOrderId: string,
): GooglePlayOrderMatch {
  if (verifiedContext === undefined) {
    return { mode: 'if-present', orderId: clientOrderId };
  }
  if (verifiedContext.orderId === undefined) {
    return { mode: 'token-only' };
  }
  return { mode: 'exact', orderId: verifiedContext.orderId };
}

function readGooglePlayVerifiedContext(
  payload: EntitlementLedgerPayload | undefined,
  packageName: string,
  productId: string,
  purchaseTokenDigest: string,
): GooglePlayVerifiedContext | undefined {
  if (
    payload?.googlePlayPackageName !== packageName
    || payload.googlePlayProductId !== productId
    || payload.googlePlayPurchaseTokenDigest !== purchaseTokenDigest
  ) {
    return undefined;
  }

  const orderId = readOptionalIdentifier(payload.googlePlayOrderId, 512);
  if (payload.googlePlayOrderId !== undefined && orderId === undefined) {
    return undefined;
  }
  const accountId = readOptionalIdentifier(payload.googlePlayObfuscatedExternalAccountId, 256);
  if (
    payload.googlePlayObfuscatedExternalAccountId !== undefined
    && accountId === undefined
  ) {
    return undefined;
  }

  return {
    ...(orderId === undefined ? {} : { orderId }),
    accountBinding: accountId === undefined
      ? { status: 'unbound' }
      : { status: 'bound', accountId },
  };
}

async function resolveGooglePlayAccountBinding(
  input: CreateGooglePlayProductPurchaseBoundaryInput,
  playerId: string,
  signal: AbortSignal,
): Promise<GooglePlayAccountBinding> {
  if (input.resolveObfuscatedAccountId === undefined) {
    return { status: 'unbound' };
  }

  const resolved = await input.resolveObfuscatedAccountId(playerId, signal);
  if (resolved === undefined && input.allowUnboundAuthenticatedPlayer === true) {
    return { status: 'unbound' };
  }

  const accountId = readOptionalIdentifier(resolved, 256);
  if (accountId === undefined) {
    return {
      status: 'rejected',
      reason: 'GOOGLE_PLAY_ACCOUNT_BINDING_REQUIRED',
    };
  }

  return { status: 'bound', accountId };
}

function createVerificationPayload(
  packageName: string,
  purchase: InspectedGooglePlayPurchase,
): EntitlementLedgerPayload {
  return {
    googlePlayPackageName: packageName,
    googlePlayProductId: purchase.productId,
    googlePlayPurchaseTokenDigest: purchase.purchaseTokenDigest,
    googlePlayPurchaseCompletionTime: purchase.purchaseCompletionTime,
    googlePlayConsumptionState: purchase.consumptionState,
    googlePlayAcknowledgementState: purchase.acknowledgementState,
    ...(purchase.orderId === undefined ? {} : { googlePlayOrderId: purchase.orderId }),
    ...(purchase.obfuscatedExternalAccountId === undefined
      ? {}
      : { googlePlayObfuscatedExternalAccountId: purchase.obfuscatedExternalAccountId }),
  };
}

function readPurchaseToken(
  evidence: VerifyPurchaseEvidenceInput['request']['evidence'],
): string | undefined {
  if (evidence?.schema !== googlePlayProductPurchaseEvidenceSchema) {
    return undefined;
  }

  return readOptionalIdentifier(evidence.payload.purchaseToken, 4096);
}

function readPurchaseState(input: unknown): GooglePlayPurchaseState | undefined {
  if (
    input === 'PURCHASED'
    || input === 'CANCELLED'
    || input === 'PENDING'
    || input === 'PURCHASE_STATE_UNSPECIFIED'
  ) {
    return input;
  }
  return undefined;
}

function readConsumptionState(input: unknown): GooglePlayConsumptionState {
  if (
    input === 'CONSUMPTION_STATE_YET_TO_BE_CONSUMED'
    || input === 'CONSUMPTION_STATE_CONSUMED'
  ) {
    return input;
  }
  return 'CONSUMPTION_STATE_UNSPECIFIED';
}

function readAcknowledgementState(input: unknown): GooglePlayAcknowledgementState {
  if (
    input === 'ACKNOWLEDGEMENT_STATE_PENDING'
    || input === 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED'
  ) {
    return input;
  }
  return 'ACKNOWLEDGEMENT_STATE_UNSPECIFIED';
}

function readTimestamp(input: unknown): string | undefined {
  if (typeof input !== 'string' || input.length === 0 || !Number.isFinite(Date.parse(input))) {
    return undefined;
  }
  return input;
}

function readOptionalIdentifier(input: unknown, maxLength: number): string | undefined {
  if (
    typeof input !== 'string'
    || input.length === 0
    || input.length > maxLength
    || input.trim() !== input
    || /[\u0000-\u001f\u007f]/u.test(input)
  ) {
    return undefined;
  }
  return input;
}

function assertIdentifier(input: unknown, label: string, maxLength: number): string {
  const identifier = readOptionalIdentifier(input, maxLength);
  if (identifier === undefined) {
    throw new TypeError(`${label} must be a non-empty identifier.`);
  }
  return identifier;
}

async function digestPurchaseToken(packageName: string, purchaseToken: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) {
    throw new Error('Web Crypto is required to hash Google Play purchase tokens.');
  }

  const bytes = new TextEncoder().encode(JSON.stringify([packageName, purchaseToken]));
  const digest = new Uint8Array(await subtle.digest('SHA-256', bytes));
  return [...digest].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function createGooglePlayVerificationId(purchaseTokenDigest: string): string {
  return `google-play:product:${purchaseTokenDigest}`;
}

function rejected(
  reason: string,
): Extract<GooglePlayPurchaseInspection, { readonly status: 'rejected' }> {
  return { status: 'rejected', reason };
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}
