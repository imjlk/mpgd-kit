import { t } from '../i18n/messages';
import {
  createStarterRestorePurchases,
  type StarterRestoreOutcome,
} from '../platform/restorePurchases';
import type { StarterContext } from '../runtime/gameContext';

/**
 * Restore Purchases for the lite template: a button over the game, shown
 * where the target sells through a store (App Review expects it while the
 * catalog sells a non-consumable such as REMOVE_ADS). The grant still comes
 * only from the backend ledger (`restorePurchases.ts`). Returns the disposer.
 */
export function mountRestorePurchasesButton(mount: HTMLElement, context: StarterContext): () => void {
  const restore = createStarterRestorePurchases({
    gateway: context.platform,
    ...(context.gameServices.monetizationRecovery === undefined
      ? {}
      : { monetizationRecovery: context.gameServices.monetizationRecovery }),
  });
  if (!restore.available) {
    return () => undefined;
  }
  if (getComputedStyle(mount).position === 'static') {
    mount.style.position = 'relative';
  }
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = t(context.locale, 'restorePurchases');
  button.style.cssText = 'position:absolute;bottom:8px;left:8px;padding:8px 12px;';
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  status.style.cssText = 'position:absolute;bottom:44px;left:8px;margin:0;padding:4px 8px;'
    + 'color:#d6dee8;background:#0b1726cc;font:13px system-ui,sans-serif;border-radius:6px;';
  status.hidden = true;
  // Taps on the button stay out of the game's own tap handling.
  button.addEventListener('pointerdown', (event) => event.stopPropagation());
  button.addEventListener('click', () => {
    button.disabled = true;
    status.hidden = false;
    status.textContent = t(context.locale, 'restoreWorking');
    void restore.restore().then((result) => {
      button.disabled = false;
      status.textContent = restoreOutcomeText(context, result);
    });
  });
  mount.append(button, status);
  return () => {
    button.remove();
    status.remove();
  };
}

function restoreOutcomeText(context: StarterContext, result: StarterRestoreOutcome): string {
  switch (result.outcome) {
    case 'restored':
      return t(context.locale, 'restoreDone', { count: result.granted });
    case 'needs-session':
      return t(context.locale, 'restoreNeedsSession');
    default:
      return t(context.locale, 'restoreFailed');
  }
}
