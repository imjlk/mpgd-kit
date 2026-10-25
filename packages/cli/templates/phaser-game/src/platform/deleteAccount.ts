import {
  AccountDeletionError,
  isMonetizationOperationRecoverable,
  type AccountDeletionClient,
  type MonetizationOperationRecord,
} from '@mpgd/game-services';
import type { Locale } from '@mpgd/i18n';
import type { SecureCredentialStore, StorageAdapter } from '@mpgd/platform';

import { t } from '../i18n/messages';
import { defaultMonetizationJournalKey } from './monetizationJournal';

/**
 * The secure credential keys of the guest session
 * (`createGuestSessionCoordinator`'s default `credentialKey` and its family
 * entry). A game that passes another `credentialKey` registers its own
 * sign-out with `onStarterAccountDeleted`.
 */
export const starterGuestCredentialKeys = [
  'mpgd.guest.refresh',
  'mpgd.guest.refresh.family',
] as const;

export type StarterDeleteAccountOutcome =
  /** The server deleted the account; this device is signed out. */
  | { readonly outcome: 'deleted'; readonly retainedPurchaseRecords: number }
  /**
   * The session no longer authenticates after an earlier attempt whose
   * answer was lost: the account was most likely deleted. Signed out too.
   */
  | { readonly outcome: 'session-ended' }
  /** No signed-in session to delete. */
  | { readonly outcome: 'needs-session' }
  /** Not this time; `retryable` says whether trying again can help. */
  | { readonly outcome: 'failed'; readonly retryable: boolean }
  /** This build or server has no account deletion; point the player at the web page. */
  | { readonly outcome: 'unavailable' };

export interface StarterAccountDeletion {
  /** Whether the game should show the Delete account entry (a server-backed session exists). */
  readonly available: boolean;
  /** Whether a purchase on this device is still being processed, to warn before deleting. */
  hasPendingPurchase(): Promise<boolean>;
  /** Deletes the account on the server, then signs this device out. A second call joins the first. */
  deleteAccount(): Promise<StarterDeleteAccountOutcome>;
}

type SignOutStep = () => void | Promise<void>;

const signOutSteps = new Set<SignOutStep>();

/**
 * Registers a local sign-out step run after the account is deleted (for
 * example the guest session's `logout()`, the notifications runtime's
 * `unregister()`, a game-owned journal or save). Returns the unregister.
 */
export function onStarterAccountDeleted(step: SignOutStep): () => void {
  signOutSteps.add(step);
  return () => {
    signOutSteps.delete(step);
  };
}

/**
 * Delete account for the starter's settings: App Store guideline 5.1.1(v)
 * and Google Play require deletion in the app. The scene asks twice (see
 * `deleteAccountConfirmText`) before calling `deleteAccount()`; the server
 * (`POST /game-services/account/delete`) erases the player's data, keeps
 * the purchase records the law requires without the player id, and ends
 * every session. This device then forgets the session's credentials, the
 * purchase journal, and whatever `onStarterAccountDeleted` registered.
 */
export function createStarterAccountDeletion(input: {
  /** `context.gameServices.accountDeletion`; absent without a game-services URL. */
  readonly client?: Pick<AccountDeletionClient, 'deleteAccount'>;
  readonly storage: Pick<StorageAdapter, 'load' | 'save'>;
  readonly secureCredentials?: Pick<SecureCredentialStore, 'remove'>;
  readonly journalKey?: string;
}): StarterAccountDeletion {
  const client = input.client;
  const journalKey = input.journalKey ?? defaultMonetizationJournalKey;
  let running: Promise<StarterDeleteAccountOutcome> | undefined;
  /** An earlier attempt's answer was lost; the deletion may have completed. */
  let answerLost = false;

  const signOut = async (): Promise<void> => {
    // Every step runs; one failing does not keep the others' data around.
    const steps: (() => Promise<unknown> | unknown)[] = [
      ...starterGuestCredentialKeys.map((key) => () => input.secureCredentials?.remove({ key })),
      () => input.storage.save({ key: journalKey, value: null }),
      ...signOutSteps,
    ];
    for (const step of steps) {
      try {
        await step();
      } catch (error) {
        console.error('[delete-account] local sign-out step failed', error);
      }
    }
  };

  const run = async (): Promise<StarterDeleteAccountOutcome> => {
    if (client === undefined) {
      return { outcome: 'unavailable' };
    }
    try {
      const receipt = await client.deleteAccount();
      answerLost = false;
      await signOut();
      return { outcome: 'deleted', retainedPurchaseRecords: receipt.retainedPurchaseRecords };
    } catch (error) {
      if (!(error instanceof AccountDeletionError)) {
        console.error('[delete-account]', error);
        return { outcome: 'failed', retryable: true };
      }
      switch (error.code) {
        case 'UNAUTHORIZED':
          if (answerLost) {
            answerLost = false;
            await signOut();
            return { outcome: 'session-ended' };
          }
          return { outcome: 'needs-session' };
        case 'ACCOUNT_DELETION_NOT_CONFIGURED':
          return { outcome: 'unavailable' };
        case 'ACCOUNT_DELETION_UNREACHABLE':
          answerLost = true;
          return { outcome: 'failed', retryable: true };
        default:
          return { outcome: 'failed', retryable: error.retryable };
      }
    }
  };

  return {
    available: client !== undefined,
    async hasPendingPurchase() {
      try {
        const loaded = await input.storage.load({ key: journalKey });
        const records = (loaded?.value as { readonly records?: unknown } | null | undefined)?.records;
        if (typeof records !== 'object' || records === null) {
          return false;
        }
        return Object.values(records as Record<string, MonetizationOperationRecord>).some(
          (record) => record.kind !== 'rewarded-ad' && isMonetizationOperationRecoverable(record),
        );
      } catch {
        return false;
      }
    },
    deleteAccount() {
      running ??= run().finally(() => {
        running = undefined;
      });
      return running;
    },
  };
}

/** The confirmation shown before deleting: what goes, what stays, and a pending purchase warning. */
export function deleteAccountConfirmText(locale: Locale, pendingPurchase: boolean): string {
  const text = t(locale, 'deleteAccountConfirm');
  return pendingPurchase ? `${text}\n${t(locale, 'deleteAccountPendingPurchase')}` : text;
}

/** The player-facing line for an outcome, shared by the Phaser lobby and the lite button. */
export function deleteAccountOutcomeText(
  locale: Locale,
  result: StarterDeleteAccountOutcome,
): string {
  switch (result.outcome) {
    case 'deleted':
      return t(locale, 'deleteAccountDone');
    case 'session-ended':
      return t(locale, 'deleteAccountSessionEnded');
    case 'needs-session':
      return t(locale, 'deleteAccountNeedsSession');
    case 'unavailable':
      return t(locale, 'deleteAccountUnavailable');
    default:
      return result.retryable
        ? t(locale, 'deleteAccountFailed')
        : t(locale, 'deleteAccountRejected');
  }
}
