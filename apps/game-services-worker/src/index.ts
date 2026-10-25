import type {
  ClaimAdRewardRequest,
  GetVerifiedLeaderboardSnapshotRequest,
  PurchaseLedgerStatusRequest,
  RecordLeaderboardScoreRequest,
  RecordVerifiedLeaderboardAttemptRequest,
  VerifyPurchaseRequest,
} from '@mpgd/game-services';
import { WorkerEntrypoint } from 'cloudflare:workers';

import {
  createWorkerAccountDeletionService,
  createWorkerFetchHandler,
  createWorkerService,
  createWorkerStoreServerDependencies,
  runWorkerScheduledAccountDeletion,
  type GameServicesWorkerEnv,
} from './handler.js';
import { runScheduledStoreServer } from './storeServerCron.js';
import {
  asWorkerNotificationRpcResult,
  consumeNotificationDispatchBatch,
  deliverWorkerNotification,
  endWorkerNotificationSession,
  runScheduledNotifications,
} from './notificationsHandler.js';

export class GameServicesWorker extends WorkerEntrypoint<GameServicesWorkerEnv> {
  override async fetch(request: Request): Promise<Response> {
    return createWorkerFetchHandler(this.env)(request);
  }

  async verifyPurchase(input: VerifyPurchaseRequest) {
    return createWorkerService(this.env).verifyPurchase(input);
  }

  async getPurchaseLedgerStatus(input: PurchaseLedgerStatusRequest) {
    return createWorkerService(this.env).getPurchaseLedgerStatus(input);
  }

  async getCommerceCapabilities() {
    return createWorkerService(this.env).getCommerceCapabilities();
  }

  async claimAdReward(input: ClaimAdRewardRequest) {
    return createWorkerService(this.env).claimAdReward(input);
  }

  async recordLeaderboardScore(input: RecordLeaderboardScoreRequest) {
    return createWorkerService(this.env).recordLeaderboardScore(input);
  }

  async recordVerifiedAttempt(input: RecordVerifiedLeaderboardAttemptRequest) {
    return createWorkerService(this.env).recordVerifiedAttempt(input);
  }

  async getSnapshot(input: GetVerifiedLeaderboardSnapshotRequest) {
    return createWorkerService(this.env).getSnapshot(input);
  }

  /**
   * One notifications send for a game server (never a client route). Any
   * Worker with this binding can send to any player, as with the other
   * service-binding methods; a notifications error comes back as
   * `{ ok: false, error: { code, message, retryable } }`.
   */
  async deliverNotification(input: unknown) {
    return asWorkerNotificationRpcResult(() => deliverWorkerNotification(this.env, input));
  }

  /** The identity Worker ends a session: the endpoints it registered are unbound. */
  async endNotificationSession(input: { readonly sessionId: string }) {
    return asWorkerNotificationRpcResult(() => endWorkerNotificationSession(this.env, input));
  }

  /** The notifications dispatch queue's consumer. */
  override async queue(batch: MessageBatch<unknown>): Promise<void> {
    await consumeNotificationDispatchBatch(this.env, batch);
  }

  /**
   * The cron trigger: notification purges and the scheduler (reminders,
   * notice pushes, due rows), and the store server upkeep (owed Play
   * acknowledges and consumes, the Play voided purchases sweep), and the
   * account deletion upkeep (pending erasures, the purge of purchase records
   * kept past their retention period). Each keeps to its own subrequest
   * budget; one failing never skips the others.
   */
  override async scheduled(controller: ScheduledController): Promise<void> {
    const [notifications] = await Promise.allSettled([
      runScheduledNotifications(this.env, { cron: controller.cron }),
      runStoreServer(this.env, controller.cron),
      runAccountDeletion(this.env),
    ]);
    // Both runs finish before the event ends; a notifications failure is
    // reported after the store server run, never instead of it.
    if (notifications.status === 'rejected') {
      throw notifications.reason;
    }
  }
}

/**
 * Account deletion for support tooling (a web deletion request an operator
 * handles), like the player's own `POST /game-services/account/delete`. A
 * named entrypoint of its own, so only a Worker bound to
 * `entrypoint = "GameServicesAccountDeletion"` can delete players; Workers
 * bound to the default entrypoint (for example to send notifications)
 * cannot. Rejects when `GAME_SERVICES_ACCOUNT_DELETION` is not bound.
 */
export class GameServicesAccountDeletion extends WorkerEntrypoint<GameServicesWorkerEnv> {
  async deletePlayerAccount(input: { readonly playerId: string }) {
    const service = createWorkerAccountDeletionService(this.env);
    if (service === undefined) {
      throw new Error('ACCOUNT_DELETION_NOT_CONFIGURED: bind GAME_SERVICES_ACCOUNT_DELETION.');
    }
    return service.deletePlayerAccount({ playerId: input.playerId });
  }
}

async function runAccountDeletion(env: GameServicesWorkerEnv): Promise<void> {
  try {
    await runWorkerScheduledAccountDeletion(env);
  } catch (error) {
    console.error(
      'Account deletion cron failed:',
      error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error',
    );
  }
}

async function runStoreServer(env: GameServicesWorkerEnv, cron: string): Promise<void> {
  try {
    await runScheduledStoreServer(env, { cron }, createWorkerStoreServerDependencies(env));
  } catch (error) {
    console.error(
      // A configuration error (the Play boundary settings); provider errors
      // are caught inside the run and carry no purchase data.
      'Store server cron failed:',
      error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error',
    );
  }
}

export {
  createWorkerFetchHandler,
  createWorkerService,
  type GameServicesIngressAuthBinding,
  type GameServicesIngressAuthBindingRequest,
  type GameServicesIngressPrincipal,
  type DevvitPaymentOrderAuthorityBinding,
  type GameServicesWorkerEnv,
  type GooglePlayAccountBinding,
  type GooglePlayPublisherAuthBinding,
  type VerifiedLeaderboardAuthBinding,
  type VerifiedLeaderboardAuthBindingRequest,
} from './handler.js';
export { type GameServicesAccountDeletionBinding } from './accountDeletion.js';
export {
  type GameServicesNotificationsAuthBinding,
  type GameServicesNotificationsIdentityBinding,
} from './notificationsHandler.js';
export default GameServicesWorker;
