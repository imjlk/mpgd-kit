import type { PlatformEvidenceEnvelope, PlatformProviderAvailability } from '@mpgd/platform';
import {
  assertStorePurchase,
  CommerceError,
  type CommerceCapabilities,
  type StoreId,
  type StorePurchase,
} from '@mpgd/platform/commerce';

/**
 * Commerce v2 contract pieces shared by the Devvit webview provider and the
 * Devvit server bridge handler: the store id, the RFC profile, the
 * `devvit.order.v1` evidence envelope, and the order-to-purchase mapping.
 * This module imports no Devvit SDK.
 */

/** The open store id of the Devvit provider (RFC "Capabilities"). */
export const devvitCommerceStoreId = 'devvit' as const;

/**
 * Evidence schema of a Devvit order reported by the client (a checkout result
 * or the server's paid-order list). It names the order; the backend's
 * server-push lookup decides from the ledger the fulfillment handler wrote
 * (`devvit.payment-order.v1`), never from this envelope alone.
 */
export const devvitOrderEvidenceSchema = 'devvit.order.v1' as const;

/** Bounds what one order list can turn into available purchases. */
export const maximumDevvitAvailableOrders = 64;

export type DevvitOrderEvidenceSource = 'checkout' | 'order-list';
export type DevvitOrderEnvironment = 'sandbox' | 'production';
/** The Reddit order status an order-list envelope reports: paid and awaiting delivery, or delivered. */
export type DevvitOrderEvidenceStatus = 'PAID' | 'DELIVERED';

export interface DevvitOrderEvidencePayload {
  readonly orderId: string;
  readonly sku: string;
  readonly source: DevvitOrderEvidenceSource;
  readonly environment?: DevvitOrderEnvironment;
  readonly status?: DevvitOrderEvidenceStatus;
}

/**
 * A paid Devvit order as the order list reports it: `delivered` says whether
 * Reddit already acknowledged its delivery (`DELIVERED`), which it does as
 * soon as the fulfillment handler answered; absent, the order is `PAID` and
 * the handler has not settled it yet.
 */
export interface DevvitPaidOrder {
  readonly orderId: string;
  readonly sku: string;
  /** ISO timestamp of the payment (`Order.updatedAt`, else `createdAt`). */
  readonly paidAt?: string;
  readonly environment?: DevvitOrderEnvironment;
  readonly delivered?: boolean;
}

/**
 * The RFC profile row for `devvit`: consumable and durable one-time products,
 * no subscription, no quantity, `lifecycle.finish: 'none'` (the fulfillment
 * handler settles on the server; the client has nothing to finish),
 * `authority.evidence: 'server-push'`, and `accountBinding: 'host'` (the
 * purchasing Reddit account comes from the server request context).
 * `lifecycle.pending` covers the server-side pending of a server-push store:
 * verify answers `pending` until the fulfillment push wrote the ledger; Devvit
 * reports no store-side pending purchase.
 */
export function createDevvitCommerceCapabilities(
  availability: PlatformProviderAvailability,
): CommerceCapabilities {
  return {
    purchase: { consumable: true, durable: true, subscription: false, quantity: false },
    catalog: { products: true, offers: false, localizedPrice: false },
    lifecycle: {
      availablePurchases: true,
      pending: true,
      restore: true,
      events: true,
      finish: 'none',
    },
    authority: { evidence: 'server-push', accountBinding: 'host' },
    availability,
  };
}

export function createDevvitOrderEvidence(
  payload: DevvitOrderEvidencePayload,
): PlatformEvidenceEnvelope {
  return {
    schema: devvitOrderEvidenceSchema,
    payload: {
      orderId: payload.orderId,
      sku: payload.sku,
      source: payload.source,
      ...(payload.environment === undefined ? {} : { environment: payload.environment }),
      ...(payload.status === undefined ? {} : { status: payload.status }),
    },
  };
}

/**
 * Validates a `devvit.order.v1` envelope the way a server registry entry must
 * before it looks the order up: the schema, a bounded order id and SKU, a
 * known source, and optional environment and status. Throws `TypeError`
 * otherwise.
 */
export function assertDevvitOrderEvidence(
  envelope: PlatformEvidenceEnvelope,
): DevvitOrderEvidencePayload {
  if (envelope.schema !== devvitOrderEvidenceSchema) {
    throw new TypeError(`Devvit order evidence schema must be ${devvitOrderEvidenceSchema}.`);
  }
  const { payload } = envelope;
  const orderId = readDevvitIdentifier(payload.orderId);
  const sku = readDevvitIdentifier(payload.sku);
  if (orderId === undefined) {
    throw new TypeError('Devvit order evidence must carry an orderId.');
  }
  if (sku === undefined) {
    throw new TypeError('Devvit order evidence must carry a sku.');
  }
  const { source, environment, status } = payload;
  if (source !== 'checkout' && source !== 'order-list') {
    throw new TypeError('Devvit order evidence source must be checkout or order-list.');
  }
  if (environment !== undefined && environment !== 'sandbox' && environment !== 'production') {
    throw new TypeError('Devvit order evidence environment must be sandbox or production.');
  }
  if (status !== undefined && status !== 'PAID' && status !== 'DELIVERED') {
    throw new TypeError('Devvit order evidence status must be PAID or DELIVERED.');
  }
  return {
    orderId,
    sku,
    source,
    ...(environment === undefined ? {} : { environment }),
    ...(status === undefined ? {} : { status }),
  };
}

/** A bounded, trimmed, control-character-free identifier, or nothing. */
export function readDevvitIdentifier(value: unknown): string | undefined {
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

/** An ISO timestamp for a Devvit order time, or nothing when it is absent or unparseable. */
export function readDevvitOrderTime(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

export interface DevvitStorePurchaseInput {
  readonly store: StoreId;
  readonly orderId: string;
  readonly sku: string;
  readonly logicalId: string;
  readonly source: DevvitOrderEvidenceSource;
  readonly paidAt?: string | undefined;
  readonly environment?: DevvitOrderEnvironment | undefined;
  /** Known from the order list only; a checkout result carries no status. */
  readonly delivered?: boolean | undefined;
}

/**
 * A paid Devvit order as a `purchased` store purchase: the order id is both
 * `transactionId` and `token` (RFC "Client contract": host order id), the
 * evidence is the `devvit.order.v1` envelope, and the account binding is the
 * host identity. An order the contract rejects throws `INVALID_RESPONSE`.
 */
export function createDevvitStorePurchase(input: DevvitStorePurchaseInput): StorePurchase {
  try {
    return assertStorePurchase({
      store: input.store,
      transactionId: input.orderId,
      storeSku: input.sku,
      logicalId: input.logicalId,
      quantity: 1,
      state: 'purchased',
      ...(input.paidAt === undefined ? {} : { purchasedAt: input.paidAt }),
      token: input.orderId,
      evidence: createDevvitOrderEvidence({
        orderId: input.orderId,
        sku: input.sku,
        source: input.source,
        ...(input.environment === undefined ? {} : { environment: input.environment }),
        ...(input.delivered === undefined ? {} : { status: input.delivered ? 'DELIVERED' : 'PAID' }),
      }),
      accountBinding: { kind: 'host-identity' },
    });
  } catch (error) {
    throw new CommerceError('INVALID_RESPONSE', {
      message: 'Devvit reported an invalid order.',
      cause: error,
    });
  }
}
