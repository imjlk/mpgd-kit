import { resolveProductPlatformId, type ProductCatalog } from '@mpgd/catalog';
import type {
  EvidenceVerificationDecision,
  FinalizePurchaseGrantInput,
  GameServicesPurchaseGrantFinalizer,
  VerifyPurchaseEvidenceInput,
} from './evidence-verification.js';
import {
  onePlayIdentifier,
  onePlayIsIdentifier,
  onePlayRecord,
  type OnePlayMarketCode,
  type OnePlayPurchaseClient,
  type OnePlayPurchaseEnvironment,
} from './oneplay-purchase-client.js';

export const onePlayManagedPurchaseEvidenceSchema = 'oneplay.managed-purchase.v1';
export interface OnePlayCheckoutIntent {
  readonly clientId: string;
  readonly environment: OnePlayPurchaseEnvironment;
  readonly marketCode: OnePlayMarketCode;
  readonly deploymentTarget: string;
  readonly playerId: string;
  readonly productId: string;
  readonly platformProductId: string;
  readonly productType: 'consumable' | 'non_consumable';
  readonly idempotencyKey: string;
  readonly developerPayload: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}
/** Durable atomic uniqueness for claim identity and payload; keep records for purchases, PNS and refunds. */
export interface OnePlayCheckoutIntentStore {
  /** Insert or return the row for client/environment/market/deployment/player/idempotency. */
  issue(intent: OnePlayCheckoutIntent): Promise<OnePlayCheckoutIntent>;
  findByPayload(input: { readonly clientId: string; readonly environment: OnePlayPurchaseEnvironment; readonly marketCode: OnePlayMarketCode; readonly developerPayload: string }): Promise<OnePlayCheckoutIntent | undefined>;
}
export function createOnePlayCheckoutIntentIssuer(input: {
  readonly client: Pick<OnePlayPurchaseClient, 'clientId' | 'environment' | 'marketCode'>;
  readonly catalog: ProductCatalog;
  readonly store: OnePlayCheckoutIntentStore;
  readonly deploymentTarget?: string;
  readonly now?: () => number;
  readonly createPayload?: () => string;
}) {
  const deploymentTarget = onePlayIdentifier(input.deploymentTarget ?? 'oneplay');
  return {
    /** Derive playerId from authenticated server context, never SDK identity or request body. */
    async issue(request: { readonly playerId: string; readonly productId: string; readonly idempotencyKey: string }): Promise<{ readonly developerPayload: string }> {
      const product = input.catalog.products.find((candidate) => candidate.id === request.productId);
      const platformProductId = product === undefined ? undefined : resolveProductPlatformId(product, deploymentTarget);
      if (product === undefined || product.type === 'subscription' || platformProductId === undefined) { throw new TypeError('ONE play managed product is not configured.'); }
      const issuedAt = (input.now ?? Date.now)();
      if (!Number.isSafeInteger(issuedAt) || issuedAt < 0 || issuedAt > 8_639_999_913_600_000) { throw new TypeError('ONE play checkout time is invalid.'); }
      const intent: OnePlayCheckoutIntent = { clientId: onePlayIdentifier(input.client.clientId, 128), environment: input.client.environment, marketCode: input.client.marketCode,
        deploymentTarget, playerId: onePlayIdentifier(request.playerId), productId: product.id, platformProductId, productType: product.type,
        idempotencyKey: onePlayIdentifier(request.idempotencyKey), developerPayload: payload((input.createPayload ?? (() => globalThis.crypto.randomUUID()))()), issuedAt, expiresAt: issuedAt + 86_400_000 };
      const stored = await input.store.issue(intent);
      if (!validIntent(stored) || !sameIdentity(stored, intent) || stored.productId !== intent.productId || stored.platformProductId !== intent.platformProductId
        || stored.productType !== intent.productType || stored.expiresAt < issuedAt) { throw new Error('ONE play checkout intent conflict.'); }
      return { developerPayload: stored.developerPayload };
    },
  };
}
export interface OnePlayInspectedPurchase {
  readonly intent: OnePlayCheckoutIntent;
  readonly purchaseId: string;
  readonly purchaseToken: string;
  readonly purchaseTime: number;
  readonly purchaseState: 0 | 1;
  readonly consumptionState: 0 | 1;
  readonly acknowledgeState: 0 | 1;
  readonly verificationId: string;
}
export interface OnePlayPurchaseBoundary extends GameServicesPurchaseGrantFinalizer {
  verifyPurchase(input: VerifyPurchaseEvidenceInput): Promise<EvidenceVerificationDecision>;
  /** Independent API lookup for PNS / scheduled reconciliation. No notification can grant by itself. */
  inspect(input: { readonly productId: string; readonly purchaseToken: string; readonly signal: AbortSignal }): Promise<OnePlayInspectedPurchase | undefined>;
}
export function createOnePlayPurchaseBoundary(input: {
  readonly client: OnePlayPurchaseClient;
  readonly store: OnePlayCheckoutIntentStore;
  readonly deploymentTarget?: string;
  readonly now?: () => number;
}): OnePlayPurchaseBoundary {
  const { client, store } = input;
  const deploymentTarget = onePlayIdentifier(input.deploymentTarget ?? 'oneplay');
  const now = input.now ?? Date.now;
  // Provider and application clocks may differ within the five-minute verification tolerance.
  async function inspect(request: { readonly productId: string; readonly purchaseToken: string; readonly signal: AbortSignal }): Promise<OnePlayInspectedPurchase | undefined> {
    request.signal.throwIfAborted();
    const purchaseToken = onePlayIdentifier(request.purchaseToken, 4096);
    const raw = await client.getPurchaseDetails({ ...request, purchaseToken });
    request.signal.throwIfAborted();
    if (!onePlayRecord(raw) || !onePlayIsIdentifier(raw.purchaseId) || !onePlayIsIdentifier(raw.developerPayload, 200)
      || raw.quantity !== 1 || raw.purchaseState !== 0 && raw.purchaseState !== 1
      || raw.consumptionState !== 0 && raw.consumptionState !== 1 || raw.acknowledgeState !== 0 && raw.acknowledgeState !== 1
      || typeof raw.purchaseTime !== 'number' || !Number.isSafeInteger(raw.purchaseTime) || raw.purchaseTime < 0 || raw.purchaseTime > now() + 300_000) {
      return undefined;
    }
    const intent = await store.findByPayload({
      clientId: client.clientId,
      environment: client.environment,
      marketCode: client.marketCode,
      developerPayload: raw.developerPayload,
    });
    request.signal.throwIfAborted();
    if (intent === undefined || !validIntent(intent) || intent.clientId !== client.clientId || intent.environment !== client.environment || intent.marketCode !== client.marketCode
      || intent.deploymentTarget !== deploymentTarget || intent.platformProductId !== request.productId || intent.developerPayload !== raw.developerPayload
      || raw.purchaseTime < intent.issuedAt - 300_000 || raw.purchaseTime > intent.expiresAt + 300_000) {
      return undefined;
    }
    const digest = new Uint8Array(
      await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([client.clientId, client.environment, client.marketCode, purchaseToken]))),
    );
    request.signal.throwIfAborted();
    const verificationId = `oneplay:purchase:${[...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
    return {
      intent,
      purchaseId: raw.purchaseId,
      purchaseTime: raw.purchaseTime,
      purchaseState: raw.purchaseState,
      consumptionState: raw.consumptionState,
      acknowledgeState: raw.acknowledgeState,
      purchaseToken,
      verificationId,
    };
  }
  async function inspectClaim(request: VerifyPurchaseEvidenceInput | FinalizePurchaseGrantInput, allowCanonicalTransaction = false): Promise<OnePlayInspectedPurchase | undefined> {
    const envelope = request.request.evidence;
    if (request.request.target !== 'oneplay' || (request.request.deploymentTarget ?? request.request.target) !== deploymentTarget || request.product.type === 'subscription'
      || envelope?.schema !== onePlayManagedPurchaseEvidenceSchema || !onePlayIsIdentifier(envelope.payload.purchaseToken, 4096)) {
      return undefined;
    }
    const purchase = await inspect({
      productId: request.platformProductId,
      purchaseToken: envelope.payload.purchaseToken,
      signal: request.signal,
    });
    if (purchase === undefined || purchase.intent.playerId !== request.request.playerId || purchase.intent.productId !== request.request.productId
      || purchase.intent.idempotencyKey !== request.request.idempotencyKey || purchase.intent.productType !== request.product.type
      || purchase.purchaseId !== request.request.platformTransactionId && (!allowCanonicalTransaction || purchase.verificationId !== request.request.platformTransactionId) || envelope.payload.purchaseId !== purchase.purchaseId
      || envelope.payload.productId !== request.platformProductId || envelope.payload.developerPayload !== purchase.intent.developerPayload) {
      return undefined;
    }
    return purchase;
  }
  return {
    inspect,
    supportsPurchaseGrant: (request) => request.request.target === 'oneplay' && request.product.type !== 'subscription' && request.request.evidence?.schema === onePlayManagedPurchaseEvidenceSchema,
    async verifyPurchase(request) {
      try {
        const purchase = await inspectClaim(request);
        if (purchase === undefined) { return { status: 'rejected', reason: 'ONEPLAY_PURCHASE_BINDING_INVALID' }; }
        if (purchase.purchaseState !== 0) { return { status: 'rejected', reason: 'ONEPLAY_PURCHASE_CANCELLED' }; }
        if (purchase.consumptionState !== 0) { return { status: 'rejected', reason: 'ONEPLAY_PURCHASE_ALREADY_CONSUMED' }; }
        return { status: 'verified', verificationId: purchase.verificationId, platformEvidenceId: purchase.verificationId, verifiedAt: new Date(now()).toISOString(), payload: {
          onePlayPurchaseId: purchase.purchaseId, onePlayDeveloperPayload: purchase.intent.developerPayload, onePlayVerificationId: purchase.verificationId,
          onePlayClientId: client.clientId, onePlayEnvironment: client.environment, onePlayMarketCode: client.marketCode,
        } };
      } catch {
        request.signal.throwIfAborted();
        return { status: 'pending', reason: 'ONEPLAY_PURCHASE_API_UNAVAILABLE' };
      }
    },
    async finalizePurchaseGrant(request) {
      const action = request.product.type === 'consumable' ? 'consume' : 'acknowledge';
      try {
        const purchase = await inspectClaim(request, true);
        if (purchase === undefined || purchase.purchaseState !== 0 || purchase.verificationId !== request.evidenceVerificationId
          || request.evidencePayload?.onePlayVerificationId !== purchase.verificationId || request.evidencePayload.onePlayClientId !== client.clientId
          || request.evidencePayload.onePlayEnvironment !== client.environment || request.evidencePayload.onePlayMarketCode !== client.marketCode
          || request.evidencePayload.onePlayPurchaseId !== purchase.purchaseId || request.evidencePayload.onePlayDeveloperPayload !== purchase.intent.developerPayload) {
          return { status: 'pending', action, alreadyCompleted: false, reason: 'ONEPLAY_FINALIZATION_BINDING_INVALID' };
        }
        if (action === 'consume' && purchase.consumptionState === 1 || action === 'acknowledge' && purchase.acknowledgeState === 1) { return { status: 'completed', action, alreadyCompleted: true }; }
        const operation = { productId: request.platformProductId, purchaseToken: purchase.purchaseToken, developerPayload: purchase.intent.developerPayload, signal: request.signal };
        if (action === 'consume') { await client.consumePurchase(operation); } else { await client.acknowledgePurchase(operation); }
        request.signal.throwIfAborted();
        return { status: 'completed', action, alreadyCompleted: false };
      } catch {
        request.signal.throwIfAborted();
        return { status: 'pending', action, alreadyCompleted: false, reason: 'ONEPLAY_FINALIZATION_API_UNAVAILABLE' };
      }
    },
  };
}
function payload(value: unknown): string {
  const text = onePlayIdentifier(value, 200);
  if (new TextEncoder().encode(text).length > 200) {
    throw new TypeError('ONE play developer payload is too long.');
  }
  return text;
}
function validIntent(intent: OnePlayCheckoutIntent): boolean {
  return [intent.clientId, intent.deploymentTarget, intent.playerId, intent.productId, intent.platformProductId, intent.idempotencyKey].every((value) => onePlayIsIdentifier(value))
    && onePlayIsIdentifier(intent.developerPayload, 200) && new TextEncoder().encode(intent.developerPayload).length <= 200
    && ['SANDBOX', 'COMMERCIAL'].includes(intent.environment) && ['MKT_ONE', 'MKT_GLB'].includes(intent.marketCode)
    && ['consumable', 'non_consumable'].includes(intent.productType) && Number.isSafeInteger(intent.issuedAt) && Number.isSafeInteger(intent.expiresAt)
    && intent.issuedAt >= 0 && intent.expiresAt >= intent.issuedAt;
}
function sameIdentity(left: OnePlayCheckoutIntent, right: OnePlayCheckoutIntent): boolean {
  return left.clientId === right.clientId && left.environment === right.environment && left.marketCode === right.marketCode
    && left.deploymentTarget === right.deploymentTarget && left.playerId === right.playerId && left.idempotencyKey === right.idempotencyKey;
}
