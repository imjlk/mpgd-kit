import type { RecoverableMonetizationClient } from '@mpgd/game-services';
import type { PlatformGateway } from '@mpgd/platform';

import { resolveStarterCommercePlayerId } from './commerceAccountBinding';

/**
 * Stores whose purchases are bound to the signed-in player (StoreKit
 * `appAccountToken`, Google Play `obfuscatedAccountId`): restoring needs an
 * authenticated, non-local session so the backend can match the purchases.
 */
const accountBoundStores: ReadonlySet<string> = new Set(['app-store', 'google-play']);

export type StarterRestoreOutcome =
  | { readonly outcome: 'restored'; readonly granted: number }
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
  readonly monetizationRecovery?: Pick<RecoverableMonetizationClient, 'restorePurchases'>;
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
    try {
      const summaries = await recovery.restorePurchases();
      return {
        outcome: 'restored',
        // Purchases (not rewarded ads) the backend ledger reports as granted.
        granted: summaries
          .filter((summary) => summary.kind !== 'rewarded-ad' && summary.status === 'granted')
          .length,
      };
    } catch (error) {
      console.error('[restore-purchases]', error);
      return { outcome: 'failed' };
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
