import type { PlatformEvidenceEnvelope, PlatformProviderAvailability } from '@mpgd/platform';
import {
  assertStorePurchase,
  CommerceError,
  type CommerceCapabilities,
  type StoreId,
  type StorePurchase,
} from '@mpgd/platform/commerce';

/**
 * Commerce v2 contract pieces shared by the Verse8 iframe provider and the
 * Agent8 server helper: the store id, the RFC profile, the
 * `verse8.agent8-event.v1` evidence envelope, and the purchase mapping. This
 * module imports no Verse8 or Agent8 SDK.
 */

/** The open store id of the Verse8 provider (RFC "Capabilities"). */
export const verse8CommerceStoreId = 'verse8' as const;

/**
 * Evidence schema of a VXShop purchase the Agent8 server recorded from the
 * reserved `$onItemPurchased` event. It names the purchase; the backend's
 * server-push lookup decides from the ledger that event wrote, never from
 * this envelope alone.
 */
export const verse8Agent8EventEvidenceSchema = 'verse8.agent8-event.v1' as const;

/** Bounds what one recorded-purchase list can turn into reported purchases. */
export const maximumVerse8ReportedPurchases = 64;

export interface Verse8Agent8EventEvidencePayload {
  /**
   * `Verse8Agent8PurchaseEvent.purchaseId` as the Agent8 helper stores it (a
   * decimal string; the helper itself validates the integer).
   */
  readonly purchaseId: string;
  /** The VXShop product id (`platformProductIds.verse8`). */
  readonly productId: string;
  readonly quantity: number;
}

/** A VXShop purchase the Agent8 server recorded from `$onItemPurchased`. */
export interface Verse8RecordedPurchase {
  readonly purchaseId: string;
  /** The VXShop product id (`platformProductIds.verse8`). */
  readonly productId: string;
  readonly quantity: number;
  /** ISO timestamp the Agent8 helper stored the grant at. */
  readonly grantedAt?: string;
}

/**
 * The RFC profile row for `verse8`: consumable and durable one-time products,
 * no subscription, no quantity (VXShop buys one unit per dialog), no
 * available-purchase list (VXShop lists nothing a client could finish; the
 * Agent8 event is the only record), `lifecycle.finish: 'none'` (the Agent8
 * event settles on the server; the client has nothing to finish),
 * `authority.evidence: 'server-push'`, and `accountBinding: 'host'` (the
 * purchasing account comes from the Agent8 event, never from the iframe).
 * `lifecycle.pending` covers the server-side pending of a server-push store:
 * verify answers `pending` until the Agent8 event wrote the ledger; VXShop
 * reports no store-side pending purchase. `restore` re-reads the recorded
 * purchases and reports them as events.
 */
export function createVerse8CommerceCapabilities(
  availability: PlatformProviderAvailability,
): CommerceCapabilities {
  return {
    purchase: { consumable: true, durable: true, subscription: false, quantity: false },
    catalog: { products: true, offers: false, localizedPrice: false },
    lifecycle: {
      availablePurchases: false,
      pending: true,
      restore: true,
      events: true,
      finish: 'none',
    },
    authority: { evidence: 'server-push', accountBinding: 'host' },
    availability,
  };
}

export function createVerse8Agent8EventEvidence(
  payload: Verse8Agent8EventEvidencePayload,
): PlatformEvidenceEnvelope {
  return {
    schema: verse8Agent8EventEvidenceSchema,
    payload: {
      purchaseId: payload.purchaseId,
      productId: payload.productId,
      quantity: payload.quantity,
    },
  };
}

/**
 * Validates a `verse8.agent8-event.v1` envelope the way a server registry
 * entry must before it looks the purchase up: the schema, a bounded purchase
 * id, a bounded product id, and a positive integer quantity. Throws
 * `TypeError` otherwise. The lookup itself decides whether the Agent8 record
 * exists; the helper that writes it validates the integer purchase id.
 */
export function assertVerse8Agent8EventEvidence(
  envelope: PlatformEvidenceEnvelope,
): Verse8Agent8EventEvidencePayload {
  if (envelope.schema !== verse8Agent8EventEvidenceSchema) {
    throw new TypeError(
      `Verse8 Agent8 event evidence schema must be ${verse8Agent8EventEvidenceSchema}.`,
    );
  }
  const { payload } = envelope;
  const purchaseId = readVerse8Identifier(payload.purchaseId);
  if (purchaseId === undefined) {
    throw new TypeError('Verse8 Agent8 event evidence must carry a purchaseId.');
  }
  const productId = readVerse8Identifier(payload.productId);
  if (productId === undefined) {
    throw new TypeError('Verse8 Agent8 event evidence must carry a productId.');
  }
  const { quantity } = payload;
  if (typeof quantity !== 'number' || !Number.isSafeInteger(quantity) || quantity <= 0) {
    throw new TypeError('Verse8 Agent8 event evidence quantity must be a positive integer.');
  }
  return { purchaseId, productId, quantity };
}

/** A bounded, trimmed, control-character-free identifier, or nothing. */
export function readVerse8Identifier(value: unknown): string | undefined {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > 256
    || value.trim() !== value
    || /[\p{Cc}\p{Cf}]/u.test(value)
  ) {
    return undefined;
  }
  return value;
}

/** An ISO timestamp for an Agent8 grant time, or nothing when it is absent or unparseable. */
export function readVerse8Time(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

export interface Verse8StorePurchaseInput {
  readonly store: StoreId;
  readonly purchase: Verse8RecordedPurchase;
  readonly logicalId: string;
}

/**
 * A recorded VXShop purchase as a `purchased` store purchase: the Agent8
 * purchase id is both `transactionId` and `token` (RFC "Client contract":
 * host order id), the evidence is the `verse8.agent8-event.v1` envelope, and
 * the account binding is the host identity. The purchase quantity is kept on
 * the purchase; a recorded purchase the contract rejects throws
 * `INVALID_RESPONSE`.
 */
export function createVerse8StorePurchase(input: Verse8StorePurchaseInput): StorePurchase {
  const { purchase } = input;
  const purchasedAt = readVerse8Time(purchase.grantedAt);
  try {
    return assertStorePurchase({
      store: input.store,
      transactionId: purchase.purchaseId,
      storeSku: purchase.productId,
      logicalId: input.logicalId,
      quantity: purchase.quantity,
      state: 'purchased',
      ...(purchasedAt === undefined ? {} : { purchasedAt }),
      token: purchase.purchaseId,
      evidence: createVerse8Agent8EventEvidence({
        purchaseId: purchase.purchaseId,
        productId: purchase.productId,
        quantity: purchase.quantity,
      }),
      accountBinding: { kind: 'host-identity' },
    });
  } catch (error) {
    throw new CommerceError('INVALID_RESPONSE', {
      message: 'The Agent8 server reported an invalid VXShop purchase.',
      cause: error,
    });
  }
}
