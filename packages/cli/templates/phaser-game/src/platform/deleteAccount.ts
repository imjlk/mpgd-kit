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
  /**
   * The server deleted the account. `signedOut` is `false` when this device
   * could not forget the session's credentials or the purchase journal.
   */
  | { readonly outcome: 'deleted'; readonly retainedPurchaseRecords: number; readonly signedOut: boolean }
  /**
   * The server refused the session after an earlier attempt whose request
   * was sent but whose answer was lost: the account was most likely
   * deleted. Signed out too.
   */
  | { readonly outcome: 'session-ended'; readonly signedOut: boolean }
  /** No signed-in session to delete. */
  | { readonly outcome: 'needs-session' }
  /** Not this time; `retryable` says whether trying again can help. */
  | { readonly outcome: 'failed'; readonly retryable: boolean }
  /** This build or server has no account deletion; point the player at the web page. */
  | { readonly outcome: 'unavailable' };

export interface StarterAccountDeletion {
  /** Whether the game should show the Delete account entry: a deletion client and a signed-in session. */
  readonly available: boolean;
  /** Whether a purchase on this device is still being processed, to warn before deleting. */
  hasPendingPurchase(): Promise<boolean>;
  /** Deletes the account on the server, then signs this device out. A second call joins the first. */
  deleteAccount(): Promise<StarterDeleteAccountOutcome>;
}

type SignOutStep = () => void | Promise<void>;

const signOutSteps = new Set<SignOutStep>();

/**
 * An earlier attempt's request was sent but its answer was lost, so the
 * deletion may have completed. Kept for the page's life, across scenes.
 */
let answerLost = false;

/** The PlayScene run checkpoint's storage key. */
const starterRunKey = 'starter-run';

/** A local sign-out step that hangs is given up on after this long. */
const signOutStepTimeoutMs = 5_000;

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
  /** Whether a server-backed session is signed in (`resolveStarterServerSession()?.current()`). */
  readonly signedIn?: () => boolean;
}): StarterAccountDeletion {
  const client = input.client;
  const journalKey = input.journalKey ?? defaultMonetizationJournalKey;
  let running: Promise<StarterDeleteAccountOutcome> | undefined;

  /**
   * Answers whether the credentials (and the journal) were cleared;
   * registered steps only log. An inferred deletion keeps the journal: its
   * open purchases may still need the store's answer if the account exists.
   */
  const signOut = async (options: { readonly keepJournal?: boolean } = {}): Promise<boolean> => {
    // Every step runs; one failing or hanging does not keep the others' data around.
    const required: (() => Promise<unknown> | unknown)[] = [
      ...starterGuestCredentialKeys.map((key) => () => input.secureCredentials?.remove({ key })),
      ...(options.keepJournal === true
        ? []
        : [() => input.storage.save({ key: journalKey, value: null })]),
    ];
    // The starter's own run checkpoint (PlayScene); a game's saves register a step.
    const clearRun = (): Promise<void> => input.storage.save({ key: starterRunKey, value: null });
    let cleared = true;
    for (const step of [...required, clearRun, ...signOutSteps]) {
      try {
        await withTimeout(step);
      } catch (error) {
        console.error('[delete-account] local sign-out step failed', error);
        if (required.includes(step)) {
          cleared = false;
        }
      }
    }
    return cleared;
  };

  const run = async (): Promise<StarterDeleteAccountOutcome> => {
    if (client === undefined) {
      return { outcome: 'unavailable' };
    }
    try {
      const receipt = await client.deleteAccount();
      answerLost = false;
      return {
        outcome: 'deleted',
        retainedPurchaseRecords: receipt.retainedPurchaseRecords,
        signedOut: await signOut(),
      };
    } catch (error) {
      if (!(error instanceof AccountDeletionError)) {
        console.error('[delete-account]', error);
        return { outcome: 'failed', retryable: true };
      }
      if (error.code === 'ACCOUNT_DELETION_UNREACHABLE') {
        // Only a request that went out may have deleted the account.
        answerLost ||= error.requestSent;
        return { outcome: 'failed', retryable: true };
      }
      if (error.code === 'UNAUTHORIZED' && error.requestSent && answerLost) {
        answerLost = false;
        return { outcome: 'session-ended', signedOut: await signOut({ keepJournal: true }) };
      }
      if (error.requestSent && !error.retryable) {
        // A definite answer from the server: the account was not deleted. A
        // retryable one (a 5xx from a proxy) may hide a completed deletion.
        answerLost = false;
      }
      switch (error.code) {
        case 'UNAUTHORIZED':
          return { outcome: 'needs-session' };
        case 'ACCOUNT_DELETION_NOT_CONFIGURED':
          return { outcome: 'unavailable' };
        default:
          return { outcome: 'failed', retryable: error.retryable };
      }
    }
  };

  return {
    available: client !== undefined && (input.signedIn?.() ?? true),
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

function withTimeout(step: () => Promise<unknown> | unknown): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    Promise.resolve().then(step),
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('sign-out step timed out')), signOutStepTimeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Test seam: forget a lost answer remembered by an earlier deletion attempt. */
export function resetStarterAccountDeletionForTests(): void {
  answerLost = false;
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
      return result.signedOut
        ? t(locale, 'deleteAccountDone')
        : t(locale, 'deleteAccountDoneLocalFailed');
    case 'session-ended':
      return result.signedOut
        ? t(locale, 'deleteAccountSessionEnded')
        : t(locale, 'deleteAccountDoneLocalFailed');
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
