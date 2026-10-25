import { WorkerEntrypoint } from 'cloudflare:workers';

import {
  createIdentityBindings,
  createIdentityFetchHandler,
  resolveIdentityService,
  type GameIdentityWorkerEnv,
} from './handler.js';

function bindingsOf(env: GameIdentityWorkerEnv) {
  return createIdentityBindings(resolveIdentityService(env));
}

/** The client routes (`guestIdentityHttpRoutes`) and the purge cron. */
export default class GameIdentityWorker extends WorkerEntrypoint<GameIdentityWorkerEnv> {
  override async fetch(request: Request): Promise<Response> {
    return createIdentityFetchHandler(this.env)(request);
  }

  /** Purges ended families and expired tokens; a backlog continues on the next run. */
  override async scheduled(): Promise<void> {
    await resolveIdentityService(this.env).purge();
  }
}

/** `GAME_SERVICES_INGRESS_AUTH` of the game-services Worker. */
export class GameServicesIngressAuth extends WorkerEntrypoint<GameIdentityWorkerEnv> {
  async authenticateGameServicesRequest(input: { readonly authorization: string }) {
    return bindingsOf(this.env).ingressAuth.authenticateGameServicesRequest(input);
  }
}

/** `GAME_SERVICES_NOTIFICATIONS_AUTH` of the game-services Worker. */
export class NotificationSessions extends WorkerEntrypoint<GameIdentityWorkerEnv> {
  async authenticateNotificationSession(input: { readonly authorization: string }) {
    return bindingsOf(this.env).notificationSessions.authenticateNotificationSession(input);
  }
}

/** `GAME_SERVICES_GOOGLE_PLAY_ACCOUNT_BINDING` of the game-services Worker. */
export class GooglePlayAccountBinding extends WorkerEntrypoint<GameIdentityWorkerEnv> {
  async resolveObfuscatedAccountId(input: { readonly playerId: string }) {
    return bindingsOf(this.env).googlePlayAccountBinding.resolveObfuscatedAccountId(input);
  }
}

/**
 * The App Store `appAccountToken` of a player, for the game-owned iOS
 * verifier Worker's `resolveAppAccountToken` (`null` for an unknown player:
 * refuse the purchase).
 */
export class AppStoreAccountBinding extends WorkerEntrypoint<GameIdentityWorkerEnv> {
  async resolveAppAccountToken(input: { readonly playerId: string }) {
    return bindingsOf(this.env).appStoreAccountBinding.resolveAppAccountToken(input);
  }
}

export {
  createIdentityBindings,
  createIdentityFetchHandler,
  resolveIdentityService,
  type GameIdentityWorkerEnv,
  type GameServicesNotificationSessionBinding,
} from './handler.js';
