import {
  AccountDeletionError,
  GuestSessionCoordinatorError,
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

/**
 * The `requestConfirmation` of `createStarterAccountDeletion` for a server
 * session that can ask the identity service for one (the guest session's
 * `requestAccountDeletionConfirmation`), or `undefined` for one that cannot
 * (a development session, whose server needs none). A session the identity
 * service refused (`GUEST_SESSION_REJECTED`, now or in an earlier refresh)
 * is `AccountDeletionError('UNAUTHORIZED')`; a backend that cannot issue one
 * (`GUEST_SESSION_UNSUPPORTED`) is `ACCOUNT_DELETION_NOT_CONFIGURED`. Any
 * other failure (offline, a failed credential save) passes through, a
 * retryable failure that says nothing about an earlier request.
 */
export function starterAccountDeletionConfirmation(
  session: { requestAccountDeletionConfirmation?(): Promise<string> } | undefined,
): (() => Promise<string>) | undefined {
  const request = session?.requestAccountDeletionConfirmation;
  if (session === undefined || request === undefined) {
    return undefined;
  }
  return async () => {
    try {
      return await request.call(session);
    } catch (error) {
      if (error instanceof GuestSessionCoordinatorError && error.code === 'GUEST_SESSION_REJECTED') {
        throw new AccountDeletionError('UNAUTHORIZED', { cause: error });
      }
      if (error instanceof GuestSessionCoordinatorError && error.code === 'GUEST_SESSION_UNSUPPORTED') {
        throw new AccountDeletionError('ACCOUNT_DELETION_NOT_CONFIGURED', { cause: error });
      }
      throw error;
    }
  };
}

export type StarterDeleteAccountOutcome =
  /**
   * The server deleted the account. `signedOut` is `false` when this device
   * could not forget the session's credentials, the purchase journal, or
   * the run checkpoint.
   */
  | { readonly outcome: 'deleted'; readonly retainedPurchaseRecords: number; readonly signedOut: boolean }
  /**
   * The server refused the session after an earlier attempt whose request
   * was sent but whose answer was lost: the account was most likely
   * deleted. `signedOut` reports whether this device forgot the session.
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
/** Steps that close a session holder, run before the credentials are removed. */
const sessionSteps = new Set<SignOutStep>();

/**
 * An earlier attempt's request was sent but its answer was lost or was a
 * retryable server failure, so the deletion may have completed. Kept for
 * the page's life, across scenes.
 */
let answerLost = false;

/** The PlayScene run checkpoint's storage key; the scene saves under it. */
export const starterRunKey = 'starter-run';

/** A local sign-out step that hangs is given up on after this long. */
const signOutStepTimeoutMs = 5_000;

/**
 * Registers a local sign-out step run after the account is deleted (for
 * example the guest session's `logout()`, the notifications runtime's
 * `unregister()`, a game-owned journal or save). Returns the unregister.
 */
export function onStarterAccountDeleted(
  step: SignOutStep,
  options: {
    /**
     * `session`: the step closes something that may still write the
     * session's credentials (the guest session coordinator's `logout()`,
     * which closes it at once and waits for a refresh in flight). It runs
     * before the credentials are removed, so a refresh that answers late
     * cannot write the deleted account's token back.
     */
    readonly phase?: 'session' | 'after';
  } = {},
): () => void {
  const steps = options.phase === 'session' ? sessionSteps : signOutSteps;
  steps.add(step);
  return () => {
    steps.delete(step);
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
  /**
   * Asks the identity service for a deletion confirmation (it takes the
   * session's refresh token, which a stolen access token does not give),
   * right after the player's second tap. Without it the request carries
   * none, which only a development server accepts. It throws
   * `AccountDeletionError('UNAUTHORIZED')` when the identity service refused
   * the session (which is what a completed deletion looks like after a lost
   * answer); anything else it throws is a retryable failure.
   */
  readonly requestConfirmation?: () => Promise<string>;
}): StarterAccountDeletion {
  const client = input.client;
  const journalKey = input.journalKey ?? defaultMonetizationJournalKey;
  let running: Promise<StarterDeleteAccountOutcome> | undefined;

  /**
   * Answers whether the credentials, the journal (unless kept), and the run checkpoint were cleared;
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
    required.push(() => input.storage.save({ key: starterRunKey, value: null }));
    let cleared = true;
    for (const step of [...sessionSteps, ...required, ...signOutSteps]) {
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
      let confirmation: string | undefined;
      try {
        confirmation = await input.requestConfirmation?.();
      } catch (error) {
        // Nothing reached the game server, so only a refused session says
        // anything about an earlier attempt.
        if (error instanceof AccountDeletionError && error.code === 'UNAUTHORIZED') {
          if (error.requestSent && answerLost) {
            answerLost = false;
            return { outcome: 'session-ended', signedOut: await signOut({ keepJournal: true }) };
          }
          return { outcome: 'needs-session' };
        }
        if (error instanceof AccountDeletionError && error.code === 'ACCOUNT_DELETION_NOT_CONFIGURED') {
          return { outcome: 'unavailable' };
        }
        console.error('[delete-account] confirmation', error);
        return { outcome: 'failed', retryable: true };
      }
      const receipt = await client.deleteAccount(
        confirmation === undefined ? {} : { confirmation },
      );
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
        // A definite answer from the server: the account was not deleted.
        answerLost = false;
      } else if (error.requestSent) {
        // A retryable one (a 5xx from a proxy, a deletion whose identity step
        // answered late) may hide a completed deletion: the next attempt reads
        // a refused session as that.
        answerLost = true;
      }
      switch (error.code) {
        case 'UNAUTHORIZED':
          return { outcome: 'needs-session' };
        case 'ACCOUNT_DELETION_NOT_CONFIGURED':
          return { outcome: 'unavailable' };
        case 'ACCOUNT_DELETION_CONFIRMATION_REQUIRED':
          // Expired or already used, the next tap asks for a new one;
          // without a way to ask, the server's check cannot be met.
          return input.requestConfirmation === undefined
            ? { outcome: 'unavailable' }
            : { outcome: 'failed', retryable: true };
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
