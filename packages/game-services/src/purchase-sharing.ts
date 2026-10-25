/**
 * Restore sharing (RFC "Restore sharing"): a guest lives in the device's
 * secure store, so a reinstall, a new device, or a second device on the same
 * store account is a new guest while the store keeps returning the
 * purchase's non-consumable with the buyer's account binding (Google Play
 * `obfuscatedAccountId`, StoreKit `appAccountToken`). Under the `share`
 * policy the backend accepts the store's own verification of a restored
 * non-consumable as the proof of ownership and grants the restoring player
 * its own entitlement, linked to the purchase. Earlier holders keep theirs,
 * up to `maxHolders` players per purchase; a refund or revocation of the
 * purchase revokes every holder. Consumables and subscriptions are never
 * shared.
 */

/** How the backend answers a restored non-consumable the store binds to another player. */
export interface PurchaseRestoreSharingPolicy {
  /**
   * `share` grants the restoring player its own entitlement; `refuse`
   * answers the store's binding mismatch (`GOOGLE_PLAY_ACCOUNT_MISMATCH`,
   * `APP_STORE_ACCOUNT_TOKEN_MISMATCH`) as before.
   */
  readonly mode: 'share' | 'refuse';
  /**
   * At most this many players hold one purchase at the same time (the first
   * grant included; a deleted player's retained record and reversed grants
   * do not count). A restore past it answers `pending` with
   * `PURCHASE_HOLDER_LIMIT_REACHED`; no holder is evicted. Defaults to 5.
   */
  readonly maxHolders?: number;
}

export const defaultPurchaseRestoreMaxHolders = 5;

/** The policy `createGameServicesBackend` uses when none is passed: restores across players are refused. */
export const refusePurchaseRestoreSharing: PurchaseRestoreSharingPolicy = Object.freeze({
  mode: 'refuse',
});

/** The reference stack's policy: share, up to the default number of holders. */
export const sharePurchaseRestores: PurchaseRestoreSharingPolicy = Object.freeze({
  mode: 'share',
});

/** The largest `maxHolders` a policy accepts; a purchase's holders are read one by one. */
export const maxPurchaseRestoreHolders = 100;

export interface ResolvedPurchaseRestoreSharingPolicy {
  readonly mode: 'share' | 'refuse';
  readonly maxHolders: number;
}

export function resolvePurchaseRestoreSharingPolicy(
  input: PurchaseRestoreSharingPolicy | undefined,
): ResolvedPurchaseRestoreSharingPolicy {
  const policy = input ?? refusePurchaseRestoreSharing;
  if (policy.mode !== 'share' && policy.mode !== 'refuse') {
    throw new Error('restoreSharing.mode must be share or refuse.');
  }
  const maxHolders = policy.maxHolders ?? defaultPurchaseRestoreMaxHolders;
  if (
    !Number.isSafeInteger(maxHolders)
    || maxHolders < 1
    || maxHolders > maxPurchaseRestoreHolders
  ) {
    throw new Error(
      `restoreSharing.maxHolders must be an integer from 1 to ${String(maxPurchaseRestoreHolders)}.`,
    );
  }
  return { mode: policy.mode, maxHolders };
}

/**
 * The player id account deletion keeps on a deleted player's retained
 * purchase records (L3b, `deleted:<deletionId>`): such a record holds no
 * entitlement and does not count toward `maxHolders`.
 */
export function isRetainedPurchasePlayerId(playerId: string): boolean {
  return playerId.startsWith('deleted:');
}
