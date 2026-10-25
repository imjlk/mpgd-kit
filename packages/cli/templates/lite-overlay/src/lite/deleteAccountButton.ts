import { t } from '../i18n/messages';
import {
  createStarterAccountDeletion,
  deleteAccountConfirmText,
  deleteAccountOutcomeText,
  starterAccountDeletionConfirmation,
  type StarterDeleteAccountOutcome,
} from '../platform/deleteAccount';
import { resolveStarterServerSession } from '../platform/serverSession';
import type { StarterContext } from '../runtime/gameContext';

/**
 * Delete account for the lite template: a button over the game, shown where
 * the game has a game-services backend (App Store guideline 5.1.1(v) and
 * Google Play require deletion in the app). The first tap opens a panel that
 * says what is deleted and kept; only "Delete permanently" deletes
 * (`deleteAccount.ts`). Returns the disposer.
 */
export function mountDeleteAccountButton(mount: HTMLElement, context: StarterContext): () => void {
  // No backend yet: read no session, which `once` would pin. A run whose guest sign-in
  // failed at boot gets the backend after a later sign-in (`onReady`); mount then.
  if (context.gameServices.accountDeletion === undefined) {
    const onReady = (context.gameServices as { readonly onReady?: (listener: () => void) => () => void })
      .onReady;
    if (onReady === undefined) {
      return () => undefined;
    }
    let dispose = (): void => undefined;
    const stop = onReady(() => {
      stop();
      dispose = mountDeleteAccountButton(mount, context);
    });
    return () => {
      stop();
      dispose();
    };
  }
  // The commerce client's session (`once`), so the button and the request agree.
  const session = resolveStarterServerSession({ once: true });
  const confirmation = starterAccountDeletionConfirmation(session);
  const deletion = createStarterAccountDeletion({
    ...(context.gameServices.accountDeletion === undefined
      ? {}
      : { client: context.gameServices.accountDeletion }),
    storage: context.platform.storage,
    ...(context.platform.secureCredentials === undefined
      ? {}
      : { secureCredentials: context.platform.secureCredentials }),
    signedIn: () => session?.current() !== undefined,
    // The identity service's confirmation, so an access token alone cannot delete the account.
    ...(confirmation === undefined ? {} : { requestConfirmation: confirmation }),
  });
  if (!deletion.available) {
    if (context.gameServices.accountDeletion === undefined || session === undefined) {
      return () => undefined;
    }
    // Signed in later (a guest session starts in the background): mount then.
    let dispose = (): void => undefined;
    const stop = session.onAuthenticated(() => {
      stop();
      dispose = mountDeleteAccountButton(mount, context);
    });
    return () => {
      stop();
      dispose();
    };
  }
  const locale = context.locale;
  const previousPosition = mount.style.position;
  if (getComputedStyle(mount).position === 'static') {
    mount.style.position = 'relative';
  }
  const open = document.createElement('button');
  open.type = 'button';
  open.textContent = t(locale, 'deleteAccount');
  open.style.cssText = 'position:absolute;top:8px;right:8px;padding:6px 10px;';
  const panel = document.createElement('div');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-labelledby', 'mpgd-delete-account-message');
  // Shown by display, not `hidden`: an inline display would override it.
  panel.style.cssText = 'position:absolute;inset:0;display:none;flex-direction:column;'
    + 'align-items:center;justify-content:center;gap:16px;padding:24px;box-sizing:border-box;'
    + 'background:#020617eb;color:#fff;font:15px system-ui,sans-serif;text-align:center;';
  const message = document.createElement('p');
  message.id = 'mpgd-delete-account-message';
  message.style.cssText = 'margin:0;max-width:640px;white-space:pre-line;';
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.style.cssText = 'margin:0;min-height:1.4em;';
  const confirm = document.createElement('button');
  confirm.type = 'button';
  confirm.textContent = t(locale, 'deleteAccountConfirmButton');
  confirm.style.cssText = 'padding:8px 14px;background:#b91c1c;color:#fff;border:0;';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = t(locale, 'deleteAccountCancel');
  cancel.style.cssText = 'padding:8px 14px;';
  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;gap:12px;';
  actions.append(confirm, cancel);
  panel.append(message, actions, status);
  // Taps on the controls stay out of the game's own tap handling.
  for (const element of [open, panel]) {
    element.addEventListener('pointerdown', (event) => event.stopPropagation());
  }
  let deleting = false;
  let signedOut = false;
  const close = (): void => {
    if (deleting) {
      return;
    }
    if (signedOut) {
      // A fresh start drops every in-memory trace of the deleted player.
      globalThis.location.reload();
      return;
    }
    panel.style.display = 'none';
    open.focus();
  };
  panel.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      close();
    }
  });
  open.addEventListener('click', () => {
    if (deleting) {
      return;
    }
    status.textContent = '';
    confirm.hidden = false;
    cancel.textContent = t(locale, 'deleteAccountCancel');
    message.textContent = deleteAccountConfirmText(locale, false);
    panel.style.display = 'flex';
    cancel.focus();
    void deletion.hasPendingPurchase().then((pending) => {
      if (pending) {
        message.textContent = deleteAccountConfirmText(locale, true);
      }
    });
  });
  cancel.addEventListener('click', close);
  confirm.addEventListener('click', () => {
    if (deleting) {
      return;
    }
    deleting = true;
    confirm.setAttribute('aria-disabled', 'true');
    status.textContent = t(locale, 'deleteAccountWorking');
    void deletion.deleteAccount()
      .catch((): StarterDeleteAccountOutcome => ({ outcome: 'failed', retryable: true }))
      .then((result) => {
        deleting = false;
        confirm.removeAttribute('aria-disabled');
        status.textContent = deleteAccountOutcomeText(locale, result);
        if (result.outcome === 'deleted' || result.outcome === 'session-ended') {
          // Signed out: Close restarts the game.
          signedOut = true;
          confirm.hidden = true;
          open.hidden = true;
          cancel.textContent = t(locale, 'deleteAccountClose');
          cancel.focus();
        }
      });
  });
  mount.append(open, panel);
  return () => {
    open.remove();
    panel.remove();
    mount.style.position = previousPosition;
  };
}
