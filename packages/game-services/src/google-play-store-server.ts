import { revokeEntitlementGrant } from './commerce-ledger.js';
import type { GameServicesPurchaseGrantFinalizer } from './evidence-verification.js';
import {
  createGooglePlayProductVerificationId,
  googlePlayProductPurchaseEvidenceSchema,
} from './google-play-purchase.js';
import type { GameServicesStore } from './server.js';
import type {
  EntitlementRevocationReason,
  ProductGrantTransaction,
  PurchaseGrantFinalization,
} from './types.js';

/**
 * Server-side Google Play upkeep that does not wait for the game client:
 * revoking grants of voided purchases (refunds, chargebacks, Play's own
 * refund of a purchase left unacknowledged) and retrying the acknowledge or
 * consume of a grant whose client went away. Both read the ledger the
 * purchase verifier wrote; neither grants anything.
 *
 * - Voided Purchases API: https://developers.google.com/android-publisher/voided-purchases
 * - Three-day acknowledgement window: https://developer.android.com/google/play/billing/integrate#process
 */

/** One entry of `purchases.voidedpurchases.list` (in-app products, `type=0`). */
export interface GooglePlayVoidedPurchase {
  readonly purchaseToken: string;
  readonly orderId?: string;
  /** Milliseconds since the epoch, as Google's int64 string or a number. */
  readonly voidedTimeMillis?: string | number;
  readonly purchaseTimeMillis?: string | number;
  /** 0 user, 1 developer, 2 Google. */
  readonly voidedSource?: string | number;
  /**
   * 0 other, 1 remorse, 2 not received, 3 defective, 4 accidental purchase,
   * 5 fraud, 6 friendly fraud, 7 chargeback, 8 unacknowledged purchase.
   */
  readonly voidedReason?: string | number;
}

export interface GooglePlayVoidedPurchasesPage {
  readonly voidedPurchases: readonly GooglePlayVoidedPurchase[];
  readonly nextPageToken?: string;
}

export interface GooglePlayVoidedPurchasesClient {
  /**
   * One page of voided in-app purchases. `startTimeMillis` and
   * `endTimeMillis` filter on when Google recorded the void, at most 30 days
   * back; Google ignores them when `pageToken` is set.
   */
  listVoidedPurchases(input: {
    readonly packageName: string;
    readonly startTimeMillis: number;
    readonly endTimeMillis: number;
    readonly pageToken?: string;
    readonly maxResults?: number;
    readonly signal: AbortSignal;
  }): Promise<GooglePlayVoidedPurchasesPage>;
}

export type GooglePlayVoidedPurchaseOutcome =
  | { readonly status: 'revoked'; readonly ledgerEntryId: string; readonly alreadyProcessed: boolean }
  /** No purchase grant of this token on this ledger (granted elsewhere, or never). */
  | { readonly status: 'grant_not_found' }
  /** The ledger refused the revocation; logged, not retried. */
  | { readonly status: 'conflict'; readonly reason: string }
  | { readonly status: 'invalid'; readonly reason: string };

/** Google keeps voided purchases for 30 days. */
export const googlePlayVoidedPurchasesWindowMs = 30 * 24 * 60 * 60 * 1000;

/**
 * Appends the `revoke` entry for one voided purchase. The grant is found by
 * the purchase token's verification id, so the revocation is keyed by the
 * token: a purchase seen again by a later sweep (or an RTDN message) answers
 * the first entry with `alreadyProcessed`.
 */
export async function revokeGooglePlayVoidedPurchase(input: {
  readonly store: GameServicesStore;
  readonly packageName: string;
  readonly voided: GooglePlayVoidedPurchase;
  readonly now?: () => string;
}): Promise<GooglePlayVoidedPurchaseOutcome> {
  const { voided } = input;
  if (typeof voided?.purchaseToken !== 'string' || voided.purchaseToken.length === 0) {
    return { status: 'invalid', reason: 'GOOGLE_PLAY_VOIDED_PURCHASE_TOKEN_MISSING' };
  }
  const verificationId = await createGooglePlayProductVerificationId(
    input.packageName,
    voided.purchaseToken,
  );
  const grant = await findPurchaseGrant(input.store, verificationId);
  if (grant === undefined || grant.payload.target !== 'android') {
    return { status: 'grant_not_found' };
  }
  const voidedAt = readMillis(voided.voidedTimeMillis);
  const voidedReason = readCode(voided.voidedReason);
  const voidedSource = readCode(voided.voidedSource);
  const result = await revokeEntitlementGrant(input.store, {
    playerId: grant.playerId,
    revokesLedgerEntryId: grant.ledgerEntryId,
    idempotencyKey: `google-play:voided:${verificationId}`,
    reason: revocationReasonOf(voidedReason),
    revokedAt: voidedAt === undefined
      ? (input.now ?? (() => new Date().toISOString()))()
      : new Date(voidedAt).toISOString(),
    evidenceVerificationId: `${verificationId}:revoke`,
    payload: {
      target: 'android',
      store: 'google-play',
      googlePlayPackageName: input.packageName,
      ...(voided.orderId === undefined ? {} : { googlePlayOrderId: voided.orderId }),
      ...(voidedReason === undefined ? {} : { googlePlayVoidedReason: voidedReason }),
      ...(voidedSource === undefined ? {} : { googlePlayVoidedSource: voidedSource }),
      ...(voidedAt === undefined ? {} : { googlePlayVoidedTimeMillis: voidedAt }),
    },
  });
  if (result.status === 'revoked') {
    return {
      status: 'revoked',
      ledgerEntryId: result.ledgerEntryId,
      alreadyProcessed: result.alreadyProcessed,
    };
  }
  if (result.status === 'grant_not_found') {
    return { status: 'grant_not_found' };
  }
  return { status: 'conflict', reason: `GOOGLE_PLAY_VOIDED_${result.status.toUpperCase()}` };
}

export interface SweepGooglePlayVoidedPurchasesInput {
  readonly client: GooglePlayVoidedPurchasesClient;
  readonly store: GameServicesStore;
  readonly packageName: string;
  /** Clamped to Google's 30-day window. */
  readonly startTimeMillis: number;
  readonly endTimeMillis: number;
  readonly signal: AbortSignal;
  /** Pages read before the sweep stops as incomplete; 10 by default. */
  readonly maxPages?: number;
  /** Asked before every page and voided purchase; `false` stops the sweep as incomplete. */
  readonly shouldContinue?: (next: 'page' | 'purchase') => boolean;
  readonly now?: () => string;
  readonly onOutcome?: (
    voided: GooglePlayVoidedPurchase,
    outcome: GooglePlayVoidedPurchaseOutcome,
  ) => void;
}

export interface GooglePlayVoidedPurchasesSweep {
  /** Every page in the window was read; the caller may advance its cursor to `endTimeMillis`. */
  readonly complete: boolean;
  readonly pages: number;
  readonly revoked: number;
  readonly alreadyProcessed: number;
  readonly notFound: number;
  readonly failed: number;
}

/**
 * Reads the voided purchases of one time window and revokes their grants.
 * The sweep is the reliable path even next to RTDN, because a Pub/Sub push
 * can be missed: run it on a schedule with a window that overlaps the last
 * complete one (revocations are idempotent per token). An incomplete sweep
 * (page budget, `shouldContinue`) must be repeated from the same start.
 */
export async function sweepGooglePlayVoidedPurchases(
  input: SweepGooglePlayVoidedPurchasesInput,
): Promise<GooglePlayVoidedPurchasesSweep> {
  const maxPages = input.maxPages ?? 10;
  if (!Number.isSafeInteger(maxPages) || maxPages < 1) {
    throw new RangeError('maxPages must be a positive integer.');
  }
  const endTimeMillis = Math.floor(input.endTimeMillis);
  const startTimeMillis = Math.max(
    Math.floor(input.startTimeMillis),
    endTimeMillis - googlePlayVoidedPurchasesWindowMs + 60_000,
  );
  if (!Number.isSafeInteger(endTimeMillis) || startTimeMillis > endTimeMillis) {
    throw new RangeError('The voided purchases window is empty or invalid.');
  }
  const shouldContinue = input.shouldContinue ?? (() => true);
  const totals = { pages: 0, revoked: 0, alreadyProcessed: 0, notFound: 0, failed: 0 };
  let pageToken: string | undefined;
  do {
    if (totals.pages >= maxPages || !shouldContinue('page')) {
      return { complete: false, ...totals };
    }
    const page = await input.client.listVoidedPurchases({
      packageName: input.packageName,
      startTimeMillis,
      endTimeMillis,
      ...(pageToken === undefined ? {} : { pageToken }),
      signal: input.signal,
    });
    totals.pages += 1;
    for (const voided of page.voidedPurchases) {
      if (!shouldContinue('purchase')) {
        return { complete: false, ...totals };
      }
      const outcome = await revokeGooglePlayVoidedPurchase({
        store: input.store,
        packageName: input.packageName,
        voided,
        ...(input.now === undefined ? {} : { now: input.now }),
      });
      if (outcome.status === 'revoked') {
        totals[outcome.alreadyProcessed ? 'alreadyProcessed' : 'revoked'] += 1;
      } else if (outcome.status === 'grant_not_found') {
        totals.notFound += 1;
      } else {
        totals.failed += 1;
      }
      input.onOutcome?.(voided, outcome);
    }
    pageToken = page.nextPageToken === undefined || page.nextPageToken.length === 0
      ? undefined
      : page.nextPageToken;
  } while (pageToken !== undefined);
  return { complete: true, ...totals };
}

/**
 * Retries the acknowledge or consume of a durable Play grant from the ledger
 * entry and the purchase token the Worker kept for it (the ledger itself
 * stores only the token digest). The finalizer is the same Play boundary the
 * purchase path uses, so the provider state is re-read before acting and an
 * already completed purchase answers `completed`. A grant that was reversed
 * is never finalized: Google is refunding it.
 */
export async function retryGooglePlayPurchaseFinalization(input: {
  readonly finalizer: GameServicesPurchaseGrantFinalizer;
  readonly store: GameServicesStore;
  readonly ledgerEntryId: string;
  readonly purchaseToken: string;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
}): Promise<
  | PurchaseGrantFinalization
  | { readonly status: 'abandoned'; readonly reason: string }
> {
  const grant = await input.store.getEntitlementTransaction(input.ledgerEntryId);
  if (grant === undefined || grant.source !== 'purchase' || grant.payload.target !== 'android') {
    return { status: 'abandoned', reason: 'GOOGLE_PLAY_FINALIZATION_GRANT_NOT_FOUND' };
  }
  const reversals = await input.store.findEntitlementRevocations?.({
    ledgerEntryIds: [grant.ledgerEntryId],
  });
  if (reversals !== undefined && reversals.length > 0) {
    return { status: 'abandoned', reason: 'GOOGLE_PLAY_FINALIZATION_GRANT_REVERSED' };
  }
  const payload = grant.payload;
  const productType = readOneTimeProductType(payload.productType);
  const platformProductId = payload.platformProductId;
  const platformTransactionId = payload.platformTransactionId;
  const purchasedAt = payload.purchasedAt;
  const evidenceVerificationId = grant.evidenceVerificationId ?? payload.evidenceVerificationId;
  if (
    productType === undefined
    || typeof platformProductId !== 'string' || platformProductId.length === 0
    || typeof platformTransactionId !== 'string' || platformTransactionId.length === 0
    || typeof purchasedAt !== 'string' || purchasedAt.length === 0
    || typeof evidenceVerificationId !== 'string'
    || grant.grant === undefined
  ) {
    return { status: 'abandoned', reason: 'GOOGLE_PLAY_FINALIZATION_CONTEXT_UNAVAILABLE' };
  }
  if (
    evidenceVerificationId
      !== await createGooglePlayProductVerificationId(
        typeof payload.googlePlayPackageName === 'string' ? payload.googlePlayPackageName : '',
        input.purchaseToken,
      )
  ) {
    // The kept token is not the one this grant was verified with.
    return { status: 'abandoned', reason: 'GOOGLE_PLAY_FINALIZATION_EVIDENCE_MISMATCH' };
  }
  const deploymentTarget = typeof payload.deploymentTarget === 'string'
    ? payload.deploymentTarget
    : undefined;
  const store = typeof payload.store === 'string' ? payload.store : undefined;
  const request = {
    target: 'android' as const,
    ...(store === undefined ? {} : { store }),
    ...(deploymentTarget === undefined ? {} : { deploymentTarget }),
    playerId: grant.playerId,
    productId: grant.grantId,
    platformTransactionId,
    idempotencyKey: grant.idempotencyKey,
    purchasedAt,
    evidence: {
      schema: googlePlayProductPurchaseEvidenceSchema,
      payload: { purchaseToken: input.purchaseToken },
    },
  };
  const product = {
    id: grant.grantId,
    type: productType,
    grant: grant.grant,
    platformProductIds: { [deploymentTarget ?? 'android']: platformProductId },
  };
  const finalizationInput = {
    request,
    product,
    platformProductId,
    evidenceVerificationId,
    evidencePayload: payload,
    ledgerEntryId: grant.ledgerEntryId,
    alreadyProcessed: true,
    timeoutMs: input.timeoutMs,
  };
  if (input.finalizer.supportsPurchaseGrant?.(finalizationInput) === false) {
    return { status: 'abandoned', reason: 'GOOGLE_PLAY_FINALIZATION_UNSUPPORTED' };
  }
  return input.finalizer.finalizePurchaseGrant({ ...finalizationInput, signal: input.signal });
}

function readOneTimeProductType(input: unknown): 'consumable' | 'non_consumable' | undefined {
  return input === 'consumable' || input === 'non_consumable' ? input : undefined;
}

function revocationReasonOf(voidedReason: number | undefined): EntitlementRevocationReason {
  return voidedReason === 7 ? 'chargeback' : 'voided';
}

function readMillis(input: unknown): number | undefined {
  const value = typeof input === 'string' && /^[0-9]{1,16}$/u.test(input) ? Number(input) : input;
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    && value <= 8_640_000_000_000_000
    ? value
    : undefined;
}

function readCode(input: unknown): number | undefined {
  const value = typeof input === 'string' && /^[0-9]{1,3}$/u.test(input) ? Number(input) : input;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

async function findPurchaseGrant(
  store: GameServicesStore,
  evidenceVerificationId: string,
): Promise<ProductGrantTransaction | undefined> {
  const grant = store.findEntitlementTransactionByEvidenceVerificationId === undefined
    ? (await store.listEntitlementTransactions()).find((transaction) => {
        return transaction.source === 'purchase'
          && (transaction.evidenceVerificationId
            ?? transaction.payload.evidenceVerificationId) === evidenceVerificationId;
      })
    : await store.findEntitlementTransactionByEvidenceVerificationId({
        source: 'purchase',
        evidenceVerificationId,
      });
  return grant?.source === 'purchase' ? grant : undefined;
}
