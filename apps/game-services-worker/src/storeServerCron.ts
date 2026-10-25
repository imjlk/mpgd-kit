import {
  createGooglePlayPublisherClient,
  googlePlayVoidedPurchasesWindowMs,
  googlePlayVoidedPurchasesWindowSlackMs,
  retryGooglePlayPurchaseFinalization,
  sweepGooglePlayVoidedPurchases,
  type GameServicesPurchaseGrantFinalizer,
  type GooglePlayVoidedPurchasesClient,
} from '@mpgd/game-services';

import { createD1GameServicesStore } from './d1Store.js';
import { notificationCronPeriodSeconds } from './notificationsHandler.js';
import {
  createD1GooglePlayFinalizationOutbox,
  createD1StoreServerCursors,
  googlePlayAcknowledgementWindowMs,
  type GooglePlayFinalizationOutbox,
  type StoreServerCursors,
} from './storeServerD1.js';

/**
 * The store server cron (L2): retries owed Play acknowledges and consumes,
 * then sweeps Play voided purchases on its own interval. It runs only with
 * a D1 store and the in-Worker Play boundary
 * (`GAME_SERVICES_GOOGLE_PLAY_PACKAGE_NAME` with
 * `GAME_SERVICES_GOOGLE_PLAY_PUBLISHER_AUTH`), shares the scheduled
 * invocation with the notifications cron, and keeps to its own budget so the
 * two together stay under the Workers Paid subrequest cap.
 */
export interface StoreServerCronEnv {
  readonly MPGD_STORE?: 'memory' | 'd1';
  readonly DB?: D1Database;
  /**
   * Minutes between voided purchase sweeps; 60 by default, `0` turns the
   * sweep off. Google allows 6,000 Voided Purchases API queries a day per
   * package and keeps 30 days of voids.
   */
  readonly MPGD_GOOGLE_PLAY_VOIDED_SWEEP_MINUTES?: string;
  /**
   * D1 calls, token-service calls, and Play requests one scheduled run of
   * this cron may make; 300 by default. The notifications cron has its own
   * budget (1,000 by default).
   */
  readonly MPGD_STORE_SERVER_SUBREQUEST_BUDGET?: string;
  /** Wall time one run may use, in seconds; 15 by default and below the cron period. */
  readonly MPGD_STORE_SERVER_CRON_BUDGET_SECONDS?: string;
}

export interface StoreServerCronDependencies {
  /** The in-Worker Play boundary; the cron does nothing for Play without it. */
  readonly googlePlay?: {
    readonly finalizer: GameServicesPurchaseGrantFinalizer;
    readonly voidedPurchases: GooglePlayVoidedPurchasesClient;
    readonly packageName: string;
  };
  readonly now?: () => number;
  readonly clock?: () => number;
}

export interface StoreServerCronReport {
  readonly retried: number;
  readonly finalized: number;
  readonly abandoned: number;
  readonly sweep?: {
    /** Caught up to the run's start; otherwise the next run continues. */
    readonly complete: boolean;
    /** Slices finished (and moved past) in this run. */
    readonly slices: number;
    readonly revoked: number;
    readonly alreadyProcessed: number;
    readonly notFound: number;
    readonly failed: number;
  };
  readonly operations: number;
}

/** Cursor names in `store_server_cursors`: the end of the last finished slice, and its length. */
export const voidedSweepCursor = 'google-play-voided:end';
export const voidedSweepSliceCursor = 'google-play-voided:slice-ms';

/** Re-read this much of the last complete window: Google records voids with some lag. */
const voidedSweepOverlapMs = 15 * 60 * 1000;
const finalizationTimeoutMs = 15_000;
/** Owed finalizations one run takes at most. */
const finalizationRetryBatch = 20;
/**
 * Window slice of the voided purchases sweep: a week, halved down to a
 * minute while a slice does not fit in one run, and back once caught up.
 */
const voidedSweepSliceMs = 7 * 24 * 60 * 60 * 1000;
const voidedSweepMinSliceMs = 60_000;
const voidedSweepMaxPagesPerSlice = 5;
/** Voided Purchases API pages one run reads; Google allows 30 queries in 30 seconds. */
const voidedSweepMaxPagesPerRun = 20;
const voidedSweepTimeoutMs = 30_000;
/** Kept inside Google's 30 days on top of the package's own slack, for a run's duration. */
const voidedSweepClockMarginMs = 5 * 60 * 1000;
/** D1 reads and writes, token-service calls, and Play requests assumed per item. */
const operationsPerRetry = 8;
const operationsPerVoidedPage = 2;
const operationsPerVoidedPurchase = 6;

export async function runScheduledStoreServer(
  env: StoreServerCronEnv,
  trigger: { readonly cron?: string },
  dependencies: StoreServerCronDependencies,
): Promise<StoreServerCronReport | undefined> {
  if (env.MPGD_STORE !== 'd1' || env.DB === undefined || dependencies.googlePlay === undefined) {
    return undefined;
  }
  const db = env.DB;
  const play = dependencies.googlePlay;
  const now = dependencies.now ?? Date.now;
  const clock = dependencies.clock ?? (() => performance.now());
  const periodSeconds = notificationCronPeriodSeconds(trigger.cron ?? '* * * * *');
  const wallSeconds = Math.min(
    readPositiveInteger(env.MPGD_STORE_SERVER_CRON_BUDGET_SECONDS, 15),
    Math.max(periodSeconds - 5, 1),
  );
  const deadline = clock() + wallSeconds * 1000;
  let remaining = readPositiveInteger(env.MPGD_STORE_SERVER_SUBREQUEST_BUDGET, 300);
  const take = (operations: number): boolean => {
    if (remaining < operations || clock() >= deadline) {
      return false;
    }
    remaining -= operations;
    return true;
  };
  const budgetAtStart = remaining;

  const store = createD1GameServicesStore(db);
  const outbox = createD1GooglePlayFinalizationOutbox(db);
  const cursors = createD1StoreServerCursors(db);
  const totals = { retried: 0, finalized: 0, abandoned: 0 };

  try {
    await retryOwedFinalizations({ outbox, store, play, now, take, totals });
  } catch (error) {
    console.error('Google Play finalization retry failed:', describe(error));
  }

  let sweep: StoreServerCronReport['sweep'];
  try {
    sweep = await sweepVoidedPurchases({ env, cursors, store, play, now, take });
  } catch (error) {
    console.error('Google Play voided purchases sweep failed:', describe(error));
  }

  const report = {
    ...totals,
    ...(sweep === undefined ? {} : { sweep }),
    operations: budgetAtStart - remaining,
  };
  if (
    report.retried > 0
    || report.abandoned > 0
    || (sweep !== undefined && (sweep.revoked > 0 || sweep.failed > 0 || !sweep.complete))
  ) {
    console.log('Store server cron:', JSON.stringify(report));
  }
  return report;
}

async function retryOwedFinalizations(input: {
  readonly outbox: GooglePlayFinalizationOutbox;
  readonly store: ReturnType<typeof createD1GameServicesStore>;
  readonly play: NonNullable<StoreServerCronDependencies['googlePlay']>;
  readonly now: () => number;
  readonly take: (operations: number) => boolean;
  readonly totals: { retried: number; finalized: number; abandoned: number };
}): Promise<void> {
  if (!input.take(1)) {
    return;
  }
  const due = await input.outbox.due({ nowMs: input.now(), limit: finalizationRetryBatch });
  for (const row of due) {
    if (!input.take(operationsPerRetry)) {
      return;
    }
    const nowMs = input.now();
    if (nowMs - row.firstSeenAtMs > googlePlayAcknowledgementWindowMs) {
      // Google refunds a purchase left unacknowledged for three days; the
      // voided sweep revokes the grant when the refund shows up.
      console.error(
        'Google Play finalization window passed for ledger entry',
        row.ledgerEntryId,
        'after',
        row.attempts,
        'attempt(s); last reason',
        row.lastReason ?? 'none',
      );
      await input.outbox.forget(row.ledgerEntryId);
      input.totals.abandoned += 1;
      continue;
    }
    input.totals.retried += 1;
    let result: Awaited<ReturnType<typeof retryGooglePlayPurchaseFinalization>>;
    try {
      result = await retryGooglePlayPurchaseFinalization({
        finalizer: input.play.finalizer,
        store: input.store,
        ledgerEntryId: row.ledgerEntryId,
        purchaseToken: row.purchaseToken,
        signal: AbortSignal.timeout(finalizationTimeoutMs),
        timeoutMs: finalizationTimeoutMs,
      });
    } catch (error) {
      await input.outbox.defer({
        ledgerEntryId: row.ledgerEntryId,
        reason: `PURCHASE_FINALIZER_ERROR:${describe(error)}`,
        nowMs: input.now(),
      });
      continue;
    }
    if (result.status === 'completed') {
      await input.outbox.forget(row.ledgerEntryId);
      input.totals.finalized += 1;
    } else if (result.status === 'abandoned') {
      console.error(
        'Google Play finalization abandoned for ledger entry',
        row.ledgerEntryId,
        result.reason,
      );
      await input.outbox.forget(row.ledgerEntryId);
      input.totals.abandoned += 1;
    } else {
      await input.outbox.defer({
        ledgerEntryId: row.ledgerEntryId,
        reason: result.reason ?? 'PURCHASE_FINALIZATION_PENDING',
        nowMs: input.now(),
      });
    }
  }
}

async function sweepVoidedPurchases(input: {
  readonly env: StoreServerCronEnv;
  readonly cursors: StoreServerCursors;
  readonly store: ReturnType<typeof createD1GameServicesStore>;
  readonly play: NonNullable<StoreServerCronDependencies['googlePlay']>;
  readonly now: () => number;
  readonly take: (operations: number) => boolean;
}): Promise<StoreServerCronReport['sweep']> {
  const intervalMinutes = readNonNegativeInteger(
    input.env.MPGD_GOOGLE_PLAY_VOIDED_SWEEP_MINUTES,
    60,
  );
  if (intervalMinutes === 0 || !input.take(2)) {
    return undefined;
  }
  const nowMs = input.now();
  const lastEnd = await input.cursors.read(voidedSweepCursor);
  // Caught up within the interval: nothing to do yet. A run that stopped
  // behind (a backlog, a budget) is continued on the next trigger.
  if (lastEnd !== undefined && nowMs - lastEnd < intervalMinutes * 60_000) {
    return undefined;
  }
  // Google keeps 30 days and filters on when it recorded the void. The first
  // sweep starts at the oldest edge; later ones overlap the last complete
  // slice so a void recorded late is still read.
  const oldest = nowMs - googlePlayVoidedPurchasesWindowMs + googlePlayVoidedPurchasesWindowSlackMs
    + voidedSweepClockMarginMs;
  let sliceStart = Math.max(
    lastEnd === undefined ? oldest : lastEnd - voidedSweepOverlapMs,
    oldest,
  );
  let sliceMs = (await input.cursors.read(voidedSweepSliceCursor)) ?? voidedSweepSliceMs;
  const totals = { revoked: 0, alreadyProcessed: 0, notFound: 0, failed: 0 };
  let slices = 0;
  let pages = 0;
  let complete = false;
  // The window is read in slices, each finished before the cursor moves past
  // it, so a backlog larger than one run's budget is worked through over
  // several runs instead of re-reading the same first pages. A slice that
  // cannot be finished in one run is halved for the next.
  for (;;) {
    const sliceEnd = Math.min(sliceStart + sliceMs, nowMs);
    const sweep = await sweepGooglePlayVoidedPurchases({
      client: input.play.voidedPurchases,
      store: input.store,
      packageName: input.play.packageName,
      startTimeMillis: sliceStart,
      endTimeMillis: sliceEnd,
      signal: AbortSignal.timeout(voidedSweepTimeoutMs),
      maxPages: voidedSweepMaxPagesPerSlice,
      now: () => new Date(input.now()).toISOString(),
      shouldContinue: (next) => {
        if (next === 'page') {
          if (pages >= voidedSweepMaxPagesPerRun || !input.take(operationsPerVoidedPage)) {
            return false;
          }
          pages += 1;
          return true;
        }
        return input.take(operationsPerVoidedPurchase);
      },
      onOutcome: (voided, outcome) => {
        if (
          outcome.status === 'conflict'
          || outcome.status === 'invalid'
          || outcome.status === 'error'
        ) {
          // The order id identifies the purchase in Play Console; the token is never logged.
          console.error(
            'Google Play voided purchase not applied:',
            outcome.reason,
            voided.orderId ?? 'no order id',
          );
        }
      },
    });
    totals.revoked += sweep.revoked;
    totals.alreadyProcessed += sweep.alreadyProcessed;
    totals.notFound += sweep.notFound;
    totals.failed += sweep.failed;
    if (!sweep.complete) {
      if (slices === 0 && sliceMs > voidedSweepMinSliceMs) {
        sliceMs = Math.max(Math.floor(sliceMs / 2), voidedSweepMinSliceMs);
        await input.cursors.write(voidedSweepSliceCursor, sliceMs, new Date(nowMs));
      }
      console.error(
        'Google Play voided purchases sweep stopped before',
        new Date(sliceEnd).toISOString(),
        '; it continues on the next run.',
      );
      break;
    }
    slices += 1;
    await input.cursors.write(voidedSweepCursor, sliceEnd, new Date(nowMs));
    if (sliceEnd >= nowMs) {
      complete = true;
      if (sliceMs < voidedSweepSliceMs) {
        await input.cursors.write(voidedSweepSliceCursor, voidedSweepSliceMs, new Date(nowMs));
      }
      break;
    }
    sliceStart = sliceEnd;
  }
  return { complete, slices, ...totals };
}

/**
 * The Play pieces this cron needs, from the same Worker settings as the
 * purchase path: the Voided Purchases client over the token service, and
 * the finalizer the purchase path uses (unwrapped: the cron updates the
 * outbox itself).
 */
export function createStoreServerGooglePlayDependencies(input: {
  readonly packageName: string;
  readonly getAccessToken: () => Promise<string>;
  readonly finalizer: GameServicesPurchaseGrantFinalizer;
}): NonNullable<StoreServerCronDependencies['googlePlay']> {
  return {
    packageName: input.packageName,
    finalizer: input.finalizer,
    voidedPurchases: createGooglePlayPublisherClient({ getAccessToken: input.getAccessToken }),
  };
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = value === undefined || value.trim() === '' ? fallback : Number(value);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : fallback;
}

function readNonNegativeInteger(value: string | undefined, fallback: number): number {
  const parsed = value === undefined || value.trim() === '' ? fallback : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function describe(error: unknown): string {
  // Error messages from the Play client never carry the token or URL.
  return error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error';
}
