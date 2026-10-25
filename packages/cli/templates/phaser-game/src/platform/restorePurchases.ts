import type { RecoverableMonetizationClient } from '@mpgd/game-services';
import type { Locale } from '@mpgd/i18n';
import type { PlatformGateway } from '@mpgd/platform';

import { t } from '../i18n/messages';
import { resolveStarterCommercePlayerId } from './commerceAccountBinding';

/**
 * Stores whose purchases are bound to the player (StoreKit
 * `appAccountToken`, Google Play `obfuscatedAccountId`): restoring needs the
 * server session's player (`guestIdentity.ts`), or an authenticated,
 * non-local platform session, so the backend can match the purchases.
 */
const accountBoundStores: ReadonlySet<string> = new Set(['app-store', 'google-play']);

/** Reconciler states of a purchase the backend ledger has granted. */
const settledStates: ReadonlySet<string> = new Set(['granted', 'finishing', 'finished']);

type RestoreRecovery = Pick<RecoverableMonetizationClient, 'restorePurchases' | 'commerceReconciler'>;

export type StarterRestoreOutcome =
  /** `granted`: purchases the backend ledger granted in this pass (0 when nothing new). */
  | { readonly outcome: 'restored'; readonly granted: number }
  /** Some purchases are still unconfirmed; `granted` were confirmed in this pass. */
  | { readonly outcome: 'incomplete'; readonly granted: number }
  /** No server session can bind the purchases (no identity service configured). */
  | { readonly outcome: 'needs-session' }
  /** The guest sign-in failed again (offline, an outage); the control is a retry. */
  | { readonly outcome: 'needs-connection' }
  | { readonly outcome: 'failed' }
  | { readonly outcome: 'unavailable' };

export interface StarterRestorePurchases {
  /** Whether the game should show a Restore Purchases control on this target. */
  readonly available: boolean;
  /**
   * Asks the store to resynchronize (StoreKit `AppStore.sync()`; Google Play
   * re-reads owned items) and runs the reconciler, which verifies every
   * purchase through the backend ledger before anything is granted. A second
   * tap while one runs joins it.
   */
  restore(): Promise<StarterRestoreOutcome>;
}

/**
 * Restore Purchases for the starter's store or settings UI. App Review
 * expects a restore control in an app that sells non-consumables (the
 * catalog's `REMOVE_ADS`); the grant itself still comes only from the
 * backend ledger through `monetizationRecovery.restorePurchases()`.
 */
export function createStarterRestorePurchases(input: {
  readonly gateway: Pick<PlatformGateway, 'commerce' | 'identity'>;
  /**
   * The recovery client, or a getter for it: a run whose guest sign-in
   * failed at boot has none until a later sign-in (`ensureSession`).
   */
  readonly monetizationRecovery?:
    | RestoreRecovery
    | (() => RestoreRecovery | undefined);
  /**
   * Signs in now if the run is not signed in yet (the session-gated game
   * services' `ensureSession`); a restore then tries once more before
   * answering `needs-connection`, which the control shows as a retry.
   */
  readonly ensureSession?: () => Promise<boolean>;
}): StarterRestorePurchases {
  const commerce = input.gateway.commerce;
  const source = input.monetizationRecovery;
  const recoveryNow = (): RestoreRecovery | undefined =>
    typeof source === 'function' ? source() : source;
  // Shown while the run can still sign in, so the player has a retry, never a dead control.
  const available = commerce !== undefined && (recoveryNow() !== undefined || input.ensureSession !== undefined);
  let running: Promise<StarterRestoreOutcome> | undefined;
  const run = async (): Promise<StarterRestoreOutcome> => {
    if (commerce === undefined) {
      return { outcome: 'unavailable' };
    }
    if (input.ensureSession !== undefined && !(await input.ensureSession())) {
      return { outcome: 'needs-connection' };
    }
    const recovery = recoveryNow();
    if (recovery === undefined) {
      return input.ensureSession === undefined
        ? { outcome: 'unavailable' }
        : { outcome: 'needs-connection' };
    }
    if (accountBoundStores.has(commerce.store)
      && await resolveStarterCommercePlayerId(input.gateway) === undefined) {
      return { outcome: 'needs-session' };
    }
    // The reconciler reports store failures as events, not rejections. A
    // failed resync (`restore`) is only this restore's; a failed read of the
    // store's purchases (`available`, the whole restore on stores without a
    // resync such as Google Play) may also come from a concurrent startup or
    // resume pass, so it makes the result unconfirmed rather than failed.
    let resyncFailed = false;
    let readFailed = false;
    // A purchase found, verified and finished within this pass is no longer
    // recoverable afterwards, so the summaries miss it; its transitions do not.
    const settledKeys = new Set<string>();
    const unsubscribe = recovery.commerceReconciler?.subscribe((event) => {
      if (event.type === 'transition' && settledStates.has(event.record.state)) {
        settledKeys.add(event.record.idempotencyKey);
      } else if (event.type === 'failure' && event.stage === 'restore') {
        resyncFailed = true;
      } else if (event.type === 'failure' && event.stage === 'available') {
        readFailed = true;
      }
    });
    try {
      const summaries = (await recovery.restorePurchases())
        .filter((summary) => summary.kind !== 'rewarded-ad');
      if (resyncFailed) {
        return { outcome: 'failed' };
      }
      for (const summary of summaries) {
        if (summary.status === 'granted') {
          settledKeys.add(summary.idempotencyKey);
        }
      }
      const granted = settledKeys.size;
      // A purchase the backend has not settled yet (verify unreachable, still
      // pending at the store, waiting on an operator) is reported as such,
      // never as "nothing to restore".
      if (readFailed || summaries.some((summary) => summary.status === 'pending'
        || summary.status === 'action-required' || summary.status === 'failed')) {
        return { outcome: 'incomplete', granted };
      }
      return { outcome: 'restored', granted };
    } catch (error) {
      console.error('[restore-purchases]', error);
      return { outcome: 'failed' };
    } finally {
      unsubscribe?.();
    }
  };
  return {
    available,
    restore() {
      running ??= run().finally(() => {
        running = undefined;
      });
      return running;
    },
  };
}

/** The player-facing line for a restore outcome, shared by the Phaser lobby and the lite button. */
export function restoreOutcomeText(locale: Locale, result: StarterRestoreOutcome): string {
  switch (result.outcome) {
    case 'restored':
      return result.granted === 0
        ? t(locale, 'restoreNothing')
        : t(locale, 'restoreDone', { count: result.granted });
    case 'incomplete':
      return result.granted === 0
        ? t(locale, 'restoreIncomplete')
        : t(locale, 'restorePartial', { count: result.granted });
    case 'needs-session':
      return t(locale, 'restoreNeedsSession');
    case 'needs-connection':
      return t(locale, 'restoreNeedsConnection');
    default:
      return t(locale, 'restoreFailed');
  }
}
