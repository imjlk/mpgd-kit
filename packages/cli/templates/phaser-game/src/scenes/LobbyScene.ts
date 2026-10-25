import Phaser from 'phaser';

import { t } from '../i18n/messages';
import {
  createStarterAccountDeletion,
  deleteAccountConfirmText,
  deleteAccountOutcomeText,
  starterAccountDeletionConfirmation,
  type StarterDeleteAccountOutcome,
} from '../platform/deleteAccount';
import {
  createStarterRestorePurchases,
  restoreOutcomeText,
  type StarterRestoreOutcome,
} from '../platform/restorePurchases';
import { resolveStarterServerSession } from '../platform/serverSession';
import { starterContextKey, type StarterContext } from '../runtime/gameContext';

export class LobbyScene extends Phaser.Scene {
  /** True while the Delete account panel is open; Enter then does not start the game. */
  private deleteAccountOpen = false;

  constructor() {
    super('LobbyScene');
  }

  create(): void {
    this.deleteAccountOpen = false;
    const rawContext = this.registry.get(starterContextKey);

    if (rawContext === undefined || rawContext === null) {
      throw new Error('Starter context is missing from Phaser registry.');
    }

    const context = rawContext as StarterContext;
    const locale = context.locale;
    const features = Object.values(context.runtime.features)
      .filter((feature) => feature.enabled)
      .map((feature) => feature.feature)
      .join(', ') || t(locale, 'featuresNone');
    const orientation = context.viewport.orientation;
    const orientationText =
      orientation.shouldShowRotatePrompt && orientation.preferredOrientation !== undefined
        ? t(locale, 'orientationMismatch', {
            mode: orientation.mode,
            orientation: orientation.preferredOrientation,
          })
        : t(locale, 'orientationPolicy', {
            mode: orientation.mode,
          });

    this.add
      .text(480, 106, t(locale, 'title'), {
        color: '#ffffff',
        fontFamily: 'Arial, sans-serif',
        fontSize: '40px',
        fontStyle: 'bold',
      })
      .setOrigin(0.5);
    this.add
      .text(480, 174, t(locale, 'target', { target: context.runtime.configTarget }), {
        color: '#9fb3c8',
        fontFamily: 'Arial, sans-serif',
        fontSize: '20px',
      })
      .setOrigin(0.5);
    this.add
      .text(480, 216, t(locale, 'features', { features }), {
        color: '#d6dee8',
        fontFamily: 'Arial, sans-serif',
        fontSize: '18px',
      })
      .setOrigin(0.5);
    this.add
      .text(
        480,
        258,
        t(locale, 'viewport', {
          sizeClass: context.viewport.layout.sizeClass,
          orientation: context.viewport.layout.orientation,
          controls: context.viewport.recommendation.primaryControls,
        }),
        {
          color: '#d6dee8',
          fontFamily: 'Arial, sans-serif',
          fontSize: '18px',
        },
      )
      .setOrigin(0.5);
    this.add
      .text(480, 300, orientationText, {
        color: orientation.shouldShowRotatePrompt ? '#f59e0b' : '#d6dee8',
        fontFamily: 'Arial, sans-serif',
        fontSize: '18px',
      })
      .setOrigin(0.5);
    this.add
      .text(480, 342, t(locale, 'backend', { mode: context.gameServices.mode }), {
        color: context.gameServices.mode === 'disabled' ? '#f59e0b' : '#2dd4bf',
        fontFamily: 'Arial, sans-serif',
        fontSize: '18px',
      })
      .setOrigin(0.5);
    this.add
      .text(480, 384, t(locale, 'tapToStart'), {
        color: '#ffffff',
        fontFamily: 'Arial, sans-serif',
        fontSize: '22px',
      })
      .setOrigin(0.5);

    this.addRestorePurchasesButton(context);
    this.addDeleteAccountEntry(context);

    this.input.once('pointerdown', () => this.scene.start('PlayScene'));
    const onEnter = (): void => {
      if (!this.deleteAccountOpen) {
        this.input.keyboard?.off('keydown-ENTER', onEnter);
        this.scene.start('PlayScene');
      }
    };
    this.input.keyboard?.on('keydown-ENTER', onEnter);
  }

  /**
   * Restore Purchases, shown where the target sells through a store. App
   * Review expects it while the catalog sells a non-consumable (REMOVE_ADS).
   * Its tap stops propagation so it does not also start the game.
   */
  private addRestorePurchasesButton(context: StarterContext): void {
    const services = context.gameServices;
    const restore = createStarterRestorePurchases({
      gateway: context.platform,
      // Read at tap time: a run that signs in late gets its recovery client then.
      monetizationRecovery: () => services.monetizationRecovery,
      ...(services.ensureSession === undefined ? {} : { ensureSession: services.ensureSession }),
    });
    if (!restore.available) {
      return;
    }
    const locale = context.locale;
    const status = this.add
      .text(480, 500, '', {
        color: '#d6dee8',
        fontFamily: 'Arial, sans-serif',
        fontSize: '16px',
      })
      .setOrigin(0.5);
    this.add
      .text(480, 456, t(locale, 'restorePurchases'), {
        color: '#5eead4',
        fontFamily: 'Arial, sans-serif',
        fontSize: '20px',
      })
      .setOrigin(0.5)
      .setPadding(16, 10, 16, 10)
      .setInteractive({ useHandCursor: true })
      .on(
        'pointerdown',
        (
          _pointer: Phaser.Input.Pointer,
          _x: number,
          _y: number,
          event: Phaser.Types.Input.EventData,
        ) => {
          event.stopPropagation();
          status.setText(t(locale, 'restoreWorking'));
          void restore.restore()
            .catch((): StarterRestoreOutcome => ({ outcome: 'failed' }))
            .then((result) => {
              if (status.active) {
                status.setText(restoreOutcomeText(locale, result));
              }
            });
        },
      );
  }
  /**
   * Delete account, shown where the game has a game-services backend (App
   * Store guideline 5.1.1(v) and Google Play require deletion in the app).
   * The first tap explains what is deleted and kept; only the second,
   * "Delete permanently", deletes. Taps stop propagation so they do not
   * also start the game.
   */
  private addDeleteAccountEntry(context: StarterContext): void {
    // No backend yet (a run whose guest sign-in failed at boot gets one later, and the
    // lobby's next visit shows the entry): read no session, which `once` would pin.
    if (context.gameServices.accountDeletion === undefined) {
      return;
    }
    // The commerce client's session (`once`), so the entry and the request agree.
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
      if (context.gameServices.accountDeletion !== undefined && session !== undefined) {
        // Signed in later (a guest session starts in the background): add it then.
        const stop = session.onAuthenticated(() => {
          stop();
          if (this.scene.isActive()) {
            this.addDeleteAccountEntry(context);
          }
        });
        this.events.once('shutdown', stop);
      }
      return;
    }
    const locale = context.locale;
    const swallow = (
      _pointer: Phaser.Input.Pointer,
      _x: number,
      _y: number,
      event: Phaser.Types.Input.EventData,
    ): void => {
      event.stopPropagation();
    };
    const entry = this.add
      .text(944, 16, t(locale, 'deleteAccount'), {
        color: '#fca5a5',
        fontFamily: 'Arial, sans-serif',
        fontSize: '16px',
      })
      .setOrigin(1, 0)
      .setPadding(12, 8, 12, 8)
      .setInteractive({ useHandCursor: true });
    const panel = this.add.container(0, 0).setVisible(false).setDepth(10);
    const backdrop = this.add
      .rectangle(480, 270, 960, 540, 0x020617, 0.92)
      .setInteractive()
      .on('pointerdown', swallow);
    const message = this.add
      .text(480, 200, '', {
        align: 'center',
        color: '#ffffff',
        fontFamily: 'Arial, sans-serif',
        fontSize: '18px',
        wordWrap: { width: 760 },
      })
      .setOrigin(0.5);
    const status = this.add
      .text(480, 470, '', {
        color: '#d6dee8',
        fontFamily: 'Arial, sans-serif',
        fontSize: '16px',
      })
      .setOrigin(0.5);
    const confirm = this.add
      .text(360, 400, t(locale, 'deleteAccountConfirmButton'), {
        backgroundColor: '#b91c1c',
        color: '#ffffff',
        fontFamily: 'Arial, sans-serif',
        fontSize: '20px',
      })
      .setOrigin(0.5)
      .setPadding(16, 10, 16, 10)
      .setInteractive({ useHandCursor: true });
    const cancel = this.add
      .text(600, 400, t(locale, 'deleteAccountCancel'), {
        color: '#ffffff',
        fontFamily: 'Arial, sans-serif',
        fontSize: '20px',
      })
      .setOrigin(0.5)
      .setPadding(16, 10, 16, 10)
      .setInteractive({ useHandCursor: true });
    panel.add([backdrop, message, status, confirm, cancel]);
    let deleting = false;
    let signedOut = false;
    entry.on('pointerdown', (...args: Parameters<typeof swallow>) => {
      swallow(...args);
      if (deleting) {
        return;
      }
      this.deleteAccountOpen = true;
      status.setText('');
      confirm.setVisible(true);
      cancel.setText(t(locale, 'deleteAccountCancel'));
      message.setText(deleteAccountConfirmText(locale, false));
      panel.setVisible(true);
      void deletion.hasPendingPurchase().then((pending) => {
        if (pending && message.active) {
          message.setText(deleteAccountConfirmText(locale, true));
        }
      });
    });
    cancel.on('pointerdown', (...args: Parameters<typeof swallow>) => {
      swallow(...args);
      if (deleting) {
        return;
      }
      if (signedOut) {
        // A fresh start drops every in-memory trace of the deleted player
        // (the session, the reconciler, the notifications runtime).
        globalThis.location.reload();
        return;
      }
      this.deleteAccountOpen = false;
      panel.setVisible(false);
    });
    confirm.on('pointerdown', (...args: Parameters<typeof swallow>) => {
      swallow(...args);
      if (deleting) {
        return;
      }
      deleting = true;
      confirm.setAlpha(0.5);
      cancel.setAlpha(0.5);
      status.setText(t(locale, 'deleteAccountWorking'));
      void deletion.deleteAccount()
        .catch((): StarterDeleteAccountOutcome => ({ outcome: 'failed', retryable: true }))
        .then((result) => {
          deleting = false;
          if (!status.active) {
            return;
          }
          confirm.setAlpha(1);
          cancel.setAlpha(1);
          status.setText(deleteAccountOutcomeText(locale, result));
          if (result.outcome === 'deleted' || result.outcome === 'session-ended') {
            // Signed out: the entry goes; Close restarts the game.
            signedOut = true;
            confirm.setVisible(false);
            entry.setVisible(false);
            cancel.setText(t(locale, 'deleteAccountClose'));
          }
        });
    });
  }
}
