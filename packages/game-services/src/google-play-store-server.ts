import { createGooglePlayTokenPurchaseKey } from '@mpgd/platform/commerce';

import {
  findPurchaseGrantByEvidenceVerificationId,
  isEntitlementGrantReversed,
  readPurchaseVerificationId,
  revokeEntitlementGrant,
} from './commerce-ledger.js';
import type { GameServicesPurchaseGrantFinalizer } from './evidence-verification.js';
import {
  createGooglePlayProductVerificationId,
  googlePlayProductPurchaseEvidenceSchema,
} from './google-play-purchase.js';
import type { GameServicesStore } from './server.js';
import type { EntitlementRevocationReason, PurchaseGrantFinalization } from './types.js';

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
  /** Entries of the page the client could not read (no purchase token); reported, never revoked. */
  readonly droppedEntries?: number;
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
 * Kept off the oldest edge of that window: Google refuses a `startTime` older
 * than 30 days at the time it receives the request, which is a little after
 * the caller's clock read.
 */
export const googlePlayVoidedPurchasesWindowSlackMs = 60_000;

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
  const grant = await findPurchaseGrantByEvidenceVerificationId(input.store, verificationId);
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
  /** Raised to Google's 30-day window, measured from `now` (`clamped` reports it). */
  readonly startTimeMillis: number;
  readonly endTimeMillis: number;
  readonly signal: AbortSignal;
  /**
   * Pages read before the sweep stops as incomplete; 10 by default. A window
   * that does not fit is not finished by repeating it (the listing does not
   * shrink as grants are revoked): raise the cap or split the window into
   * shorter ones.
   */
  readonly maxPages?: number;
  /** Asked before every page and voided purchase; `false` stops the sweep as incomplete. */
  readonly shouldContinue?: (next: 'page' | 'purchase') => boolean;
  /** The clock, for the revocation time of a void without one and the 30-day window. */
  readonly now?: () => string;
  /** Every voided purchase's outcome; the purchase token is left out so it can be logged. */
  readonly onOutcome?: (
    voided: Omit<GooglePlayVoidedPurchase, 'purchaseToken'>,
    outcome:
      | GooglePlayVoidedPurchaseOutcome
      | {
          readonly status: 'error';
          readonly reason: 'GOOGLE_PLAY_VOIDED_STORE_ERROR';
          /** The error's name and message; store errors carry no purchase token. */
          readonly detail: string;
        },
  ) => void;
}

export interface GooglePlayVoidedPurchasesSweep {
  /**
   * Every page in the window was read and every entry applied or refused;
   * the caller may advance its cursor to `endTimeMillis`. A store error on
   * an entry (`errored`) leaves the sweep incomplete, since reading the window
   * again retries it. Entries counted in `failed` are not retried that way:
   * they need an operator (see `onOutcome`).
   */
  readonly complete: boolean;
  /** The requested start was older than Google keeps and was raised: voids before it are gone. */
  readonly clamped: boolean;
  readonly pages: number;
  readonly revoked: number;
  readonly alreadyProcessed: number;
  readonly notFound: number;
  /** Ledger refusals and unreadable entries. */
  readonly failed: number;
  /** Entries a store error kept from being applied; the window must be read again. */
  readonly errored: number;
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
  const requestedStart = input.startTimeMillis;
  const endTimeMillis = input.endTimeMillis;
  const nowMillis = input.now === undefined ? Date.now() : Date.parse(input.now());
  if (!Number.isSafeInteger(requestedStart) || !Number.isSafeInteger(endTimeMillis)) {
    throw new RangeError('The voided purchases window must be integer milliseconds.');
  }
  if (!Number.isFinite(nowMillis)) {
    throw new RangeError('now() must return an ISO timestamp.');
  }
  const oldest = nowMillis - googlePlayVoidedPurchasesWindowMs + googlePlayVoidedPurchasesWindowSlackMs;
  const startTimeMillis = Math.max(requestedStart, oldest);
  if (startTimeMillis > endTimeMillis) {
    throw new RangeError('The voided purchases window is empty or invalid.');
  }
  const clamped = startTimeMillis > requestedStart;
  const shouldContinue = input.shouldContinue ?? (() => true);
  const totals = {
    pages: 0,
    revoked: 0,
    alreadyProcessed: 0,
    notFound: 0,
    failed: 0,
    errored: 0,
  };
  let pageToken: string | undefined;
  do {
    if (totals.pages >= maxPages || !shouldContinue('page')) {
      return { complete: false, clamped, ...totals };
    }
    const page = await input.client.listVoidedPurchases({
      packageName: input.packageName,
      startTimeMillis,
      endTimeMillis,
      ...(pageToken === undefined ? {} : { pageToken }),
      signal: input.signal,
    });
    totals.pages += 1;
    totals.failed += page.droppedEntries ?? 0;
    for (const voided of page.voidedPurchases) {
      if (!shouldContinue('purchase')) {
        return { complete: false, clamped, ...totals };
      }
      const { purchaseToken: _token, ...loggable } = voided;
      let outcome: GooglePlayVoidedPurchaseOutcome;
      try {
        outcome = await revokeGooglePlayVoidedPurchase({
          store: input.store,
          packageName: input.packageName,
          voided,
          ...(input.now === undefined ? {} : { now: input.now }),
        });
      } catch (error) {
        if (input.signal.aborted) {
          throw error;
        }
        // One entry's store failure does not hide the rest of the window.
        totals.errored += 1;
        input.onOutcome?.(loggable, {
          status: 'error',
          reason: 'GOOGLE_PLAY_VOIDED_STORE_ERROR',
          detail: error instanceof Error
            ? `${error.name}: ${error.message}`.slice(0, 200)
            : 'unknown error',
        });
        continue;
      }
      if (outcome.status === 'revoked') {
        totals[outcome.alreadyProcessed ? 'alreadyProcessed' : 'revoked'] += 1;
      } else if (outcome.status === 'grant_not_found') {
        totals.notFound += 1;
      } else {
        totals.failed += 1;
      }
      input.onOutcome?.(loggable, outcome);
    }
    pageToken = page.nextPageToken === undefined || page.nextPageToken.length === 0
      ? undefined
      : page.nextPageToken;
  } while (pageToken !== undefined);
  return { complete: totals.errored === 0, clamped, ...totals };
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
  if (await isEntitlementGrantReversed(input.store, grant.ledgerEntryId)) {
    return { status: 'abandoned', reason: 'GOOGLE_PLAY_FINALIZATION_GRANT_REVERSED' };
  }
  const payload = grant.payload;
  const productType = readOneTimeProductType(payload.productType);
  const platformProductId = payload.platformProductId;
  // An orderless purchase (Google omitted the order id) was recorded without
  // one; the boundary matches it by token, as the client's token key does.
  const platformTransactionId = typeof payload.platformTransactionId === 'string'
      && payload.platformTransactionId.length > 0
    ? payload.platformTransactionId
    : await createGooglePlayTokenPurchaseKey(input.purchaseToken);
  const purchasedAt = payload.purchasedAt;
  // A grant a restore transfer wrote is acknowledged as the purchase it records.
  const evidenceVerificationId = readPurchaseVerificationId(grant);
  if (
    productType === undefined
    || typeof platformProductId !== 'string' || platformProductId.length === 0
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
    platformProductIds: { android: platformProductId },
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
  const result = await finalizeWithin(
    input.finalizer,
    finalizationInput,
    input.signal,
    input.timeoutMs,
  );
  if (result.status === 'pending' && result.reason === 'GOOGLE_PLAY_FINALIZATION_EVIDENCE_MISMATCH') {
    // The boundary is configured for another package than the grant: no
    // retry can succeed.
    return { status: 'abandoned', reason: result.reason };
  }
  return result;
}

/**
 * Runs the finalizer within `timeoutMs` like the purchase path does: the
 * provider signal is aborted at the deadline and the retry answers pending,
 * even when a provider call ignores the abort.
 */
async function finalizeWithin(
  finalizer: GameServicesPurchaseGrantFinalizer,
  input: Omit<Parameters<GameServicesPurchaseGrantFinalizer['finalizePurchaseGrant']>[0], 'signal'>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<PurchaseGrantFinalization> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('timeoutMs must be a positive integer.');
  }
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) {
    abort();
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      finalizer.finalizePurchaseGrant({ ...input, signal: controller.signal }),
      new Promise<PurchaseGrantFinalization>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve({
            status: 'pending',
            alreadyCompleted: false,
            reason: 'GOOGLE_PLAY_FINALIZATION_TIMEOUT',
          });
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    signal.removeEventListener('abort', abort);
  }
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
