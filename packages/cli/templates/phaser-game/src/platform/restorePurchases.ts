import type { RecoverableMonetizationClient } from '@mpgd/game-services';
import type { Locale } from '@mpgd/i18n';
import type { PlatformGateway } from '@mpgd/platform';

import { t } from '../i18n/messages';
import { resolveStarterCommercePlayerId } from './commerceAccountBinding';

/**
 * Stores whose purchases are bound to the signed-in player (StoreKit
 * `appAccountToken`, Google Play `obfuscatedAccountId`): restoring needs an
 * authenticated, non-local session so the backend can match the purchases.
 */
const accountBoundStores: ReadonlySet<string> = new Set(['app-store', 'google-play']);

export type StarterRestoreOutcome =
  /** `granted`: purchases the backend ledger granted in this pass (0 when nothing new). */
  | { readonly outcome: 'restored'; readonly granted: number }
  /** Some purchases are still unconfirmed; `granted` were confirmed in this pass. */
  | { readonly outcome: 'incomplete'; readonly granted: number }
  | { readonly outcome: 'needs-session' }
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
  readonly monetizationRecovery?: Pick<
    RecoverableMonetizationClient,
    'restorePurchases' | 'commerceReconciler'
  >;
}): StarterRestorePurchases {
  const commerce = input.gateway.commerce;
  const recovery = input.monetizationRecovery;
  const available = commerce !== undefined && recovery !== undefined;
  let running: Promise<StarterRestoreOutcome> | undefined;
  const run = async (): Promise<StarterRestoreOutcome> => {
    if (commerce === undefined || recovery === undefined) {
      return { outcome: 'unavailable' };
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
    const unsubscribe = recovery.commerceReconciler?.subscribe((event) => {
      if (event.type === 'failure' && event.stage === 'restore') {
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
      const granted = summaries.filter((summary) => summary.status === 'granted').length;
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
      return t(locale, 'restoreIncomplete');
    case 'needs-session':
      return t(locale, 'restoreNeedsSession');
    default:
      return t(locale, 'restoreFailed');
  }
}
