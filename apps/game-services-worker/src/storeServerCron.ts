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
    readonly errored: number;
  };
  readonly operations: number;
}

/** Cursor names in `store_server_cursors`: the end of the last finished slice, and its length. */
export const voidedSweepCursor = 'google-play-voided:end';
export const voidedSweepSliceCursor = 'google-play-voided:slice-ms';
/**
 * 0 once caught up. While behind (continue on the next trigger): 2 when the
 * read up to the cursor was clean (by the run that moved it, or kept from a
 * run that already left 2) and the cursor is at least the overlap in the
 * past, so the next run starts exactly at it; 1 otherwise, so the next run
 * re-reads the overlap before it.
 */
export const voidedSweepBehindCursor = 'google-play-voided:behind';
/**
 * How far the re-read of the overlap before the cursor got: a dense overlap
 * is worked through in slices over several runs without moving the cursor.
 */
export const voidedSweepRereadCursor = 'google-play-voided:reread';
/** Runs in a row whose first slice was held back only by store errors. */
export const voidedSweepStallCursor = 'google-play-voided:stalls';

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
/** Runs a slice may be held back by store errors alone before it is skipped (about half an hour). */
const voidedSweepMaxStalls = 30;
/** D1 reads and writes, token-service calls, and Play requests assumed per item. */
const operationsPerRetry = 8;
const operationsPerVoidedPage = 2;
const operationsPerVoidedPurchase = 6;

/** One budget request: granted, or refused by the wall deadline or the subrequest budget. */
type StoreServerTake = 'ok' | 'deadline' | 'budget';

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
  const budgetAtStart = remaining;
  const take = (operations: number): StoreServerTake => {
    if (clock() >= deadline) {
      return 'deadline';
    }
    if (remaining < operations) {
      return 'budget';
    }
    remaining -= operations;
    return 'ok';
  };
  // Owed finalizations may use half the subrequest budget and half the wall
  // time, so the sweep always has the other half and a slow Play cannot
  // starve it.
  const retryBudget = Math.floor(budgetAtStart / 2);
  const retryDeadline = clock() + (wallSeconds * 1000) / 2;
  let retryUsed = 0;
  const takeForRetry = (operations: number): boolean => {
    if (
      retryUsed + operations > retryBudget
      || clock() >= retryDeadline
      || take(operations) !== 'ok'
    ) {
      return false;
    }
    retryUsed += operations;
    return true;
  };
  const retryTimeLeftMs = () =>
    Math.max(Math.min(finalizationTimeoutMs, Math.floor(retryDeadline - clock())), 1);

  const store = createD1GameServicesStore(db);
  const outbox = createD1GooglePlayFinalizationOutbox(db);
  const cursors = createD1StoreServerCursors(db);
  const totals = { retried: 0, finalized: 0, abandoned: 0 };

  try {
    await retryOwedFinalizations({
      outbox,
      store,
      play,
      now,
      take: takeForRetry,
      timeLeftMs: retryTimeLeftMs,
      totals,
    });
  } catch (error) {
    console.error('Google Play finalization retry failed:', describe(error));
  }

  let sweep: StoreServerCronReport['sweep'];
  try {
    sweep = await sweepVoidedPurchases({
      env,
      cursors,
      store,
      play,
      now,
      take,
      // Kept inside Google's 30 days for as long as this run may last.
      clockMarginMs: wallSeconds * 1000 + 60_000,
    });
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
    || (sweep !== undefined
      && (sweep.revoked > 0 || sweep.failed > 0 || sweep.errored > 0 || !sweep.complete))
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
  readonly timeLeftMs: () => number;
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
        signal: AbortSignal.timeout(input.timeLeftMs()),
        timeoutMs: input.timeLeftMs(),
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
  readonly take: (operations: number) => StoreServerTake;
  readonly clockMarginMs: number;
}): Promise<StoreServerCronReport['sweep']> {
  const intervalMinutes = readNonNegativeInteger(
    input.env.MPGD_GOOGLE_PLAY_VOIDED_SWEEP_MINUTES,
    60,
  );
  if (intervalMinutes === 0) {
    return undefined;
  }
  // At most five cursor reads open the run.
  const opening = input.take(5);
  if (opening !== 'ok') {
    console.error('Google Play voided purchases sweep skipped this run:', opening);
    return undefined;
  }
  const nowMs = input.now();
  const lastEnd = await input.cursors.read(voidedSweepCursor);
  const behind = await input.cursors.read(voidedSweepBehindCursor);
  // Caught up within the interval: nothing to do yet. A run that stopped
  // behind (a backlog, a budget) is continued on the next trigger.
  const isBehind = behind === 1 || behind === 2;
  if (!isBehind && lastEnd !== undefined && nowMs - lastEnd < intervalMinutes * 60_000) {
    return undefined;
  }
  // Google keeps 30 days and filters on when it recorded the void. The first
  // sweep starts at the oldest edge; later ones re-read an overlap before
  // the cursor so a void recorded late is still read.
  const oldest = nowMs - googlePlayVoidedPurchasesWindowMs + googlePlayVoidedPurchasesWindowSlackMs
    + input.clockMarginMs;
  if (lastEnd !== undefined && lastEnd - voidedSweepOverlapMs < oldest) {
    console.error(
      'Google Play voided purchases before',
      new Date(oldest).toISOString(),
      'are no longer listed by Google; the sweep was behind since',
      new Date(lastEnd).toISOString(),
    );
  }
  const cursorAtStart = lastEnd ?? oldest;
  // A run left in state 2 starts exactly at the cursor; otherwise (caught up,
  // or state 1) the overlap before it is re-read, so a backlog pays for it
  // once per clean stop.
  let openingStart = oldest;
  let rereadInUse = false;
  if (lastEnd !== undefined && behind === 2) {
    openingStart = lastEnd;
  } else if (lastEnd !== undefined) {
    // The overlap is re-read in ordinary slices; a run that stopped inside it
    // (state 1) resumes where it got instead of starting the overlap again.
    // A caught-up run always re-reads the whole overlap.
    const reread = behind === 1 ? await input.cursors.read(voidedSweepRereadCursor) : undefined;
    rereadInUse = reread !== undefined
      && reread > lastEnd - voidedSweepOverlapMs
      && reread < lastEnd;
    openingStart = rereadInUse && reread !== undefined
      ? reread
      : lastEnd - voidedSweepOverlapMs;
  }
  let sliceStart = Math.max(openingStart, oldest);
  let stalls = (await input.cursors.read(voidedSweepStallCursor)) ?? 0;
  let cursorNow = cursorAtStart;
  /**
   * The behind state a stopped run leaves: 2 (start exactly at the cursor)
   * when what lies before the cursor was read cleanly, by this run or the one
   * before, and the cursor is far enough in the past that late-recorded voids
   * have shown up; 1 (re-read the overlap) otherwise.
   */
  const stoppedState = (): 1 | 2 =>
    (movedCursor || behind === 2) && cursorNow <= nowMs - voidedSweepOverlapMs ? 2 : 1;
  let movedCursor = false;
  const resetStalls = async () => {
    if (stalls !== 0) {
      stalls = 0;
      await input.cursors.write(voidedSweepStallCursor, 0, new Date(nowMs));
    }
  };
  /** Moves the cursor past a finished (or skipped) slice; true once caught up. */
  const finishSlice = async (sliceEnd: number): Promise<boolean> => {
    if (sliceEnd < cursorAtStart && sliceEnd < nowMs) {
      // A slice of the overlap re-read: remember how far it got, never move
      // the cursor back. Remembered even when young: not remembering it
      // would make a run that cannot finish the overlap repeat it forever.
      await input.cursors.write(voidedSweepRereadCursor, sliceEnd, new Date(nowMs));
      rereadInUse = true;
      slices += 1;
      return false;
    }
    // Never behind the cursor (a cursor ahead of this run's clock stays).
    const nextCursor = Math.max(sliceEnd, cursorAtStart);
    // Counted only once written, so a failed write never reports progress.
    await input.cursors.write(voidedSweepCursor, nextCursor, new Date(nowMs));
    if (rereadInUse) {
      // The overlap of the old cursor is done; a later run must not resume it.
      await input.cursors.write(voidedSweepRereadCursor, 0, new Date(nowMs));
      rereadInUse = false;
    }
    slices += 1;
    cursorNow = nextCursor;
    movedCursor = true;
    if (sliceEnd < nowMs) {
      return false;
    }
    complete = true;
    if (behind !== 0) {
      await input.cursors.write(voidedSweepBehindCursor, 0, new Date(nowMs));
    }
    if (sliceMs < voidedSweepSliceMs) {
      await input.cursors.write(voidedSweepSliceCursor, voidedSweepSliceMs, new Date(nowMs));
    }
    return true;
  };
  let sliceMs = clampSliceMs(await input.cursors.read(voidedSweepSliceCursor));
  const totals = { revoked: 0, alreadyProcessed: 0, notFound: 0, failed: 0, errored: 0 };
  let slices = 0;
  let pages = 0;
  let complete = false;
  // The window is read in slices, each finished before the cursor moves past
  // it, so a backlog larger than one run's budget is worked through over
  // several runs instead of re-reading the same first pages. A slice whose
  // voids do not fit in the run's budget is halved for the next run.
  try {
    for (;;) {
      // Ordinary slices, the overlap included, so halving can shrink any of
      // them down to a minute.
      const sliceEnd = Math.min(sliceStart + sliceMs, nowMs);
      let stoppedBy: StoreServerTake | 'run-page-cap' | undefined;
      // At the one-minute floor a slice may use the run's remaining pages:
      // it cannot be split further.
      const slicePageCap = sliceMs > voidedSweepMinSliceMs
        ? voidedSweepMaxPagesPerSlice
        : Math.max(voidedSweepMaxPagesPerRun - pages, 1);
      const sweep = await sweepGooglePlayVoidedPurchases({
        client: input.play.voidedPurchases,
        store: input.store,
        packageName: input.play.packageName,
        startTimeMillis: sliceStart,
        endTimeMillis: sliceEnd,
        signal: AbortSignal.timeout(voidedSweepTimeoutMs),
        maxPages: slicePageCap,
        now: () => new Date(input.now()).toISOString(),
        shouldContinue: (next) => {
          if (next === 'page' && pages >= voidedSweepMaxPagesPerRun) {
            stoppedBy = 'run-page-cap';
            return false;
          }
          const taken = input.take(
            next === 'page' ? operationsPerVoidedPage : operationsPerVoidedPurchase,
          );
          if (taken !== 'ok') {
            stoppedBy = taken;
            return false;
          }
          if (next === 'page') {
            pages += 1;
          }
          return true;
        },
        onOutcome: (voided, outcome) => {
          if (outcome.status === 'error') {
            console.error(
              'Google Play voided purchase not applied:',
              outcome.reason,
              outcome.detail,
              voided.orderId ?? 'no order id',
            );
          } else if (outcome.status === 'conflict' || outcome.status === 'invalid') {
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
      totals.errored += sweep.errored;
      if (!sweep.complete) {
        // Halve only when the slice itself did not fit: its own page cap, or
        // the budget running out while its voids were applied. A deadline, the
        // run's page cap, or a store error says nothing about the slice.
        // A slice that hit its own page cap is too large even when an entry
        // also failed: its unread pages must not be skipped with it.
        const hitSlicePageCap = stoppedBy === undefined && sweep.pages >= slicePageCap;
        const sliceTooLarge = hitSlicePageCap
          || (stoppedBy === 'budget' && sweep.pages > 0 && sweep.errored === 0);
        // Every page was read and only store errors held the slice: after
        // voidedSweepMaxStalls runs at the same cursor, move on and say so,
        // so one void that always fails cannot hold every later one back.
        const onlyErrored = stoppedBy === undefined && sweep.errored > 0 && !hitSlicePageCap;
        if (onlyErrored && slices === 0 && stalls + 1 >= voidedSweepMaxStalls) {
          console.error(
            'Google Play voided purchases: skipping',
            sweep.errored,
            'void(s) that failed on',
            voidedSweepMaxStalls,
            'runs before',
            new Date(sliceEnd).toISOString(),
            '; revoke them by hand (see the order ids logged above).',
          );
          await resetStalls();
          const caughtUp = await finishSlice(sliceEnd);
          if (caughtUp) {
            break;
          }
          sliceStart = sliceEnd;
          continue;
        }
        if (onlyErrored && slices === 0) {
          stalls += 1;
          await input.cursors.write(voidedSweepStallCursor, stalls, new Date(nowMs));
        }
        if (slices === 0 && sliceTooLarge) {
          if (sliceMs > voidedSweepMinSliceMs) {
            sliceMs = Math.max(Math.floor(sliceMs / 2), voidedSweepMinSliceMs);
            await input.cursors.write(voidedSweepSliceCursor, sliceMs, new Date(nowMs));
          } else if (stoppedBy === 'budget') {
            console.error(
              'Google Play voided purchases: one minute of voids does not fit in a run; '
                + 'raise MPGD_STORE_SERVER_SUBREQUEST_BUDGET.',
            );
          } else {
            console.error(
              'Google Play voided purchases: one minute of voids fills every page a run may read.',
            );
          }
        }
        const stopped = stoppedState();
        if (behind !== stopped) {
          await input.cursors.write(voidedSweepBehindCursor, stopped, new Date(nowMs));
        }
        console.error(
          'Google Play voided purchases sweep stopped before',
          new Date(sliceEnd).toISOString(),
          `(${stoppedBy ?? (sweep.errored > 0 ? 'store error' : 'page cap')});`,
          'it continues on the next run.',
        );
        break;
      }
      await resetStalls();
      if (await finishSlice(sliceEnd)) {
        break;
      }
      sliceStart = sliceEnd;
    }
  } catch (error) {
    // A run that already completed keeps its state; otherwise the stopped
    // state decides whether the next run re-reads the overlap.
    if (!complete) {
      await input.cursors
        .write(voidedSweepBehindCursor, stoppedState(), new Date(nowMs))
        .catch(() => undefined);
    }
    throw error;
  }
  return { complete, slices, ...totals };
}

function clampSliceMs(stored: number | undefined): number {
  return stored === undefined || !Number.isFinite(stored)
    ? voidedSweepSliceMs
    : Math.min(Math.max(Math.floor(stored), voidedSweepMinSliceMs), voidedSweepSliceMs);
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
