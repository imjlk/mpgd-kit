import type { GameServicesBackendApi } from './client.js';
import type { VerifyPurchaseResponse } from './types.js';
import {
  onePlayManagedPurchaseEvidenceSchema,
  type OnePlayInspectedPurchase,
  type OnePlayPurchaseBoundary,
} from './oneplay-purchase.js';
import {
  onePlayIsIdentifier,
  onePlayRecord,
  type OnePlayPurchaseClient,
} from './oneplay-purchase-client.js';

export interface OnePlayPnsNotification {
  readonly clientId: string;
  readonly productId: string;
  readonly purchaseToken: string;
  readonly purchaseId: string;
  readonly developerPayload: string;
  readonly purchaseState: 'COMPLETED' | 'CANCELED';
}
/** RSA SHA512 over compact UTF-8 JSON after removing signature, following the official PNS example. */
export async function verifyOnePlayPns(input: {
  readonly rawBody: Uint8Array<ArrayBuffer>;
  /** ONEconsole license public key, base64 SPKI or PUBLIC KEY PEM. */
  readonly publicKey: string;
  readonly client: Pick<OnePlayPurchaseClient, 'clientId' | 'environment' | 'marketCode'>;
  readonly subtle?: SubtleCrypto;
}): Promise<OnePlayPnsNotification | undefined> {
  if (input.rawBody.length > 65_536 || input.publicKey.length > 8192) {
    return undefined;
  }
  try {
    const body: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(input.rawBody),
    );
    if (!onePlayRecord(body) || typeof body.signature !== 'string' || body.signature.length > 2048
      || body.clientId !== input.client.clientId || body.environment !== input.client.environment || body.marketCode !== input.client.marketCode
      || body.msgVersion !== (input.client.environment === 'SANDBOX' ? '3.1.0D' : '3.1.0') || body.messageType !== 'SINGLE_PAYMENT_TRANSACTION'
      || body.purchaseState !== 'COMPLETED' && body.purchaseState !== 'CANCELED'
      || !onePlayIsIdentifier(body.productId) || !onePlayIsIdentifier(body.purchaseId) || !onePlayIsIdentifier(body.purchaseToken, 4096) || !onePlayIsIdentifier(body.developerPayload, 200)) {
      return undefined;
    }
    const { signature, ...message } = body;
    const keyBytes = base64(
      input.publicKey.replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\s/gu, ''),
    );
    const subtle = input.subtle ?? globalThis.crypto.subtle;
    const key = await subtle.importKey(
      'spki',
      keyBytes,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-512' },
      false,
      ['verify'],
    );
    if (!await subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      base64(signature),
      new TextEncoder().encode(JSON.stringify(message)),
    )) {
      return undefined;
    }
    return {
      clientId: body.clientId,
      productId: body.productId,
      purchaseId: body.purchaseId,
      purchaseToken: body.purchaseToken,
      developerPayload: body.developerPayload,
      purchaseState: body.purchaseState,
    };
  } catch {
    return undefined;
  }
}
export type OnePlayPnsResult =
  | { readonly status: 'processed'; readonly state: 'completed'; readonly grant: VerifyPurchaseResponse }
  | { readonly status: 'processed'; readonly state: 'cancelled'; readonly verificationId: string }
  | { readonly status: 'pending' | 'rejected'; readonly reason: string };
export function createOnePlayPnsReceiver(input: {
  readonly publicKey: string;
  readonly client: Pick<OnePlayPurchaseClient, 'clientId' | 'environment' | 'marketCode'>;
  readonly boundary: OnePlayPurchaseBoundary;
  readonly backend: Pick<GameServicesBackendApi, 'purchases'>;
  /** Durably fence and revoke by verificationId; the ledger grant transaction must honor that fence atomically. Never revoke by client identity alone. */
  readonly onCancelled: (purchase: OnePlayInspectedPurchase) => Promise<void>;
}) {
  if (typeof input.onCancelled !== 'function') {
    throw new TypeError('ONE play PNS requires an authoritative cancellation handler.');
  }
  return {
    async receive(rawBody: Uint8Array<ArrayBuffer>, suppliedSignal?: AbortSignal): Promise<OnePlayPnsResult> {
      const signal = suppliedSignal ?? AbortSignal.timeout(10_000);
      signal.throwIfAborted();
      const notification = await verifyOnePlayPns({ rawBody, publicKey: input.publicKey, client: input.client });
      signal.throwIfAborted();
      if (notification === undefined) { return { status: 'rejected', reason: 'ONEPLAY_PNS_INVALID' }; }
      let purchase: OnePlayInspectedPurchase | undefined;
      try {
        purchase = await input.boundary.inspect({ productId: notification.productId, purchaseToken: notification.purchaseToken, signal });
      } catch {
        signal.throwIfAborted();
        return { status: 'pending', reason: 'ONEPLAY_PURCHASE_API_UNAVAILABLE' };
      }
      if (purchase === undefined || purchase.intent.clientId !== input.client.clientId || purchase.intent.environment !== input.client.environment
        || purchase.intent.marketCode !== input.client.marketCode || purchase.purchaseId !== notification.purchaseId || purchase.intent.developerPayload !== notification.developerPayload) {
        return { status: 'rejected', reason: 'ONEPLAY_PNS_BINDING_INVALID' };
      }
      if ((purchase.purchaseState === 0 ? 'COMPLETED' : 'CANCELED') !== notification.purchaseState) { return { status: 'pending', reason: 'ONEPLAY_PNS_STATE_CHANGED' }; }
      if (purchase.purchaseState === 1) {
        await input.onCancelled(purchase);
        signal.throwIfAborted();
        return { status: 'processed', state: 'cancelled', verificationId: purchase.verificationId };
      }
      const intent = purchase.intent;
      const grant = await input.backend.purchases.verifyPurchase({ target: 'oneplay', ...(intent.deploymentTarget === 'oneplay' ? {} : { deploymentTarget: intent.deploymentTarget }),
        playerId: intent.playerId, productId: intent.productId, platformTransactionId: purchase.purchaseId, idempotencyKey: intent.idempotencyKey,
        purchasedAt: new Date(purchase.purchaseTime).toISOString(), evidence: { schema: onePlayManagedPurchaseEvidenceSchema, payload: {
          purchaseToken: purchase.purchaseToken, purchaseId: purchase.purchaseId, productId: intent.platformProductId, developerPayload: intent.developerPayload,
        } } });
      signal.throwIfAborted();
      if (!grant.verified || grant.finalization?.status !== 'completed') { return { status: 'pending', reason: grant.reason ?? grant.finalization?.reason ?? (grant.verified && grant.finalization === undefined ? 'ONEPLAY_FINALIZATION_REQUIRED' : 'ONEPLAY_LEDGER_PENDING') }; }
      return { status: 'processed', state: 'completed', grant };
    },
  };
}
function base64(value: string): Uint8Array<ArrayBuffer> {
  if (!value || value.length % 4 !== 0 || !/^[A-Za-z\d+/]+={0,2}$/u.test(value)) {
    throw new TypeError('Invalid ONE play signature encoding.');
  }
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}
