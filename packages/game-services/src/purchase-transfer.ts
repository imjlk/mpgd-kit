/**
 * Restore transfers (RFC "Restore transfers"): a guest lives in the device's
 * secure store, so a reinstall or a new device makes a new guest while the
 * store keeps returning the old guest's non-consumables with the old
 * account binding (Google Play `obfuscatedAccountId`, StoreKit
 * `appAccountToken`). Under the `move` policy the backend accepts the
 * store's own verification of a restored non-consumable as the proof of
 * ownership and moves its grant to the restoring player: the old grant is
 * reversed by a `transfer` entry and the new player's grant written in the
 * same ledger operation, so one player holds the purchase at a time.
 * Consumables and subscriptions never move.
 */

/** How the backend answers a restored non-consumable bound to another player. */
export interface PurchaseRestoreTransferPolicy {
  /**
   * `move` transfers the grant to the restoring player; `refuse` answers
   * the store's binding mismatch (`GOOGLE_PLAY_ACCOUNT_MISMATCH`,
   * `APP_STORE_ACCOUNT_TOKEN_MISMATCH`) as before.
   */
  readonly mode: 'move' | 'refuse';
  /**
   * At most this many moves of one purchase within `windowMs`; a restore
   * past it answers `pending` with `PURCHASE_TRANSFER_RATE_LIMITED` and
   * succeeds once the oldest move leaves the window. Blunts sharing one
   * purchase token between players. Defaults to 3.
   */
  readonly maxTransfersPerWindow?: number;
  /** The rate limit's sliding window in milliseconds. Defaults to 30 days. */
  readonly windowMs?: number;
}

export const defaultPurchaseTransferLimit = 3;
export const defaultPurchaseTransferWindowMs = 30 * 24 * 60 * 60 * 1000;

/** The policy `createGameServicesBackend` uses when none is passed: restores across players are refused. */
export const refusePurchaseRestoreTransfers: PurchaseRestoreTransferPolicy = Object.freeze({
  mode: 'refuse',
});

/** The reference stack's policy: move, with the default rate limit. */
export const movePurchaseRestoreTransfers: PurchaseRestoreTransferPolicy = Object.freeze({
  mode: 'move',
});

export interface ResolvedPurchaseRestoreTransferPolicy {
  readonly mode: 'move' | 'refuse';
  readonly maxTransfersPerWindow: number;
  readonly windowMs: number;
}

export function resolvePurchaseRestoreTransferPolicy(
  input: PurchaseRestoreTransferPolicy | undefined,
): ResolvedPurchaseRestoreTransferPolicy {
  const policy = input ?? refusePurchaseRestoreTransfers;
  if (policy.mode !== 'move' && policy.mode !== 'refuse') {
    throw new Error('restoreTransfers.mode must be move or refuse.');
  }
  const maxTransfersPerWindow = policy.maxTransfersPerWindow ?? defaultPurchaseTransferLimit;
  if (!Number.isSafeInteger(maxTransfersPerWindow) || maxTransfersPerWindow < 1) {
    throw new Error('restoreTransfers.maxTransfersPerWindow must be a positive integer.');
  }
  const windowMs = policy.windowMs ?? defaultPurchaseTransferWindowMs;
  if (!Number.isSafeInteger(windowMs) || windowMs < 1) {
    throw new Error('restoreTransfers.windowMs must be a positive integer of milliseconds.');
  }
  return { mode: policy.mode, maxTransfersPerWindow, windowMs };
}
