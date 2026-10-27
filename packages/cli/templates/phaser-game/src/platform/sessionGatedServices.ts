import {
  gameServicesPlayerChangedCode,
  gameServicesRuntimeDisposedCode,
  type GameServicesClient,
  type GameServicesPurchaseResult,
  type GameServicesRewardedAdResult,
  type GameServicesRuntime,
} from '@mpgd/game-services';

/** The diagnostic of a purchase refused because the run is not signed in yet (retryable). */
export const starterSessionRequiredCode = 'STARTER_SESSION_REQUIRED';

function refusedPurchase(code: string): GameServicesPurchaseResult {
  return {
    status: 'failed',
    purchase: {
      status: 'failed',
      entitlementIds: [],
      diagnostic: { code, retryable: true },
    },
  };
}

function sessionRequiredReward(): GameServicesRewardedAdResult {
  return { status: 'unavailable', reward: { status: 'unavailable', rewardGranted: false } };
}

/** A purchase, restore, or reward claim was asked for before the guest sign-in succeeded. */
export class StarterSessionRequiredError extends Error {
  readonly code: string;

  constructor(code: string = starterSessionRequiredCode) {
    super(
      code === starterSessionRequiredCode
        ? 'The game is not signed in to its identity service yet; try again when it is online.'
        : 'Another player signed in; the game restarts for that player.',
    );
    this.name = 'StarterSessionRequiredError';
    this.code = code;
  }
}

/** The game services of a run that booted before its guest sign-in succeeded. */
export type StarterSessionGatedServices = GameServicesRuntime & {
  /**
   * Signs in now if needed (once more before a purchase or restore); `true`
   * when the services are up. Absent when the configuration has no client.
   */
  readonly ensureSession?: () => Promise<boolean>;
  /**
   * Calls `listener` once the services came up for the signed-in player
   * (not for the services of an earlier sign-in); returns the unsubscribe.
   * Delete account uses it to appear in a run that signed in late.
   */
  readonly onReady: (listener: () => void) => () => void;
};

/**
 * Game services that come up when the player is signed in, for a run whose
 * boot-time sign-in failed (offline, an outage). The real services are bound
 * to a player id for their whole life (the purchase journal and the backend
 * ledger are keyed by it), so they are created only once the server player
 * is known (`create`), never with the platform's local placeholder:
 *
 * - `client` is present from the start, so the game action coordinator
 *   exists for the run. A purchase or reward claim signs in first
 *   (`ensurePlayer`); when that still fails it answers a plain refusal
 *   before any store UI opens (`failed` with the retryable diagnostic
 *   `STARTER_SESSION_REQUIRED`; a reward `unavailable`), never a thrown
 *   error, which would latch the action coordinator into
 *   `reconciliation-required` for the rest of the run. A leaderboard
 *   submission throws `StarterSessionRequiredError`.
 * - `monetizationRecovery` is `undefined` until then, and the Restore
 *   Purchases control signs in first through `ensureSession`. Rewarded ads
 *   stay off for the whole run (`main.ts` `canShow`, `PlayScene`): the
 *   runtime binds its late reward evidence recovery at boot.
 * - When the player becomes known, the services are created once; the
 *   caller runs the game runtime's `reconcile()` from `onActivated` (the
 *   startup recovery, with the action coordinator's). A later sign-in naming
 *   another player (not expected within one run) closes them for good, as
 *   the services' own session check does: purchases answer `failed` with the
 *   retryable diagnostic `GAME_SERVICES_PLAYER_CHANGED`, recovery and Delete
 *   account go away, and `onPlayerChanged` asks the host to boot again for
 *   that player once the old services stopped. They are never re-created
 *   for the new player inside this run: the scenes, the action coordinator,
 *   and the notifications still hold the boot player.
 * - `accountDeletion` is `undefined` until then, and the services' after
 *   (read live); `onReady` tells Delete account to appear then.
 * - `ensureSession` is present only when the configuration has a client
 *   (a disabled configuration has nothing a sign-in could bring up).
 *
 * `probe` is a runtime built from the same configuration with a placeholder
 * player; only its `mode`, `reason`, `baseUrl`, `target`, and whether it has
 * a client are read.
 */
export function createSessionGatedGameServices(input: {
  readonly probe: GameServicesRuntime;
  readonly ensurePlayer: () => Promise<string | undefined>;
  readonly onPlayer: (listener: (playerId: string) => void) => () => void;
  readonly create: (playerId: string) => GameServicesRuntime;
  /**
   * Called once, when the services were created (by a background sign-in or
   * one a purchase or restore started): run the game runtime's `reconcile()`.
   */
  readonly onActivated?: () => void;
  /** Called at once when a later sign-in names another player: block input or show a switching screen. */
  readonly onPlayerChanging?: (playerId: string) => void;
  /** Called once, after a sign-in named another player closed the services: boot again for it. */
  readonly onPlayerChanged?: (playerId: string) => void;
  readonly warn?: (message: string, error?: unknown) => void;
}): StarterSessionGatedServices {
  const warn = input.warn ?? ((message: string, error?: unknown) => console.warn(message, error ?? ''));
  let inner: GameServicesRuntime | undefined;
  let innerPlayer: string | undefined;
  /** Set once another player signed in, or the services were disposed: nothing comes up again. */
  let closedCode: string | undefined;
  const readyListeners = new Set<() => void>();
  /** The services the scenes may use now: none once closed. */
  const live = (): GameServicesRuntime | undefined => (closedCode === undefined
    ? inner
    : undefined);

  const activate = (playerId: string): void => {
    if (closedCode !== undefined) {
      return;
    }
    if (inner !== undefined) {
      if (playerId !== innerPlayer) {
        closedCode = gameServicesPlayerChangedCode;
        readyListeners.clear();
        warn(
          '[game-services] a later sign-in named another player; the services closed until restart.',
        );
        notifyChanging(input.onPlayerChanging, playerId, warn);
        // Fail closed first; the host restarts once the old reconciler has stopped.
        void inner.dispose().catch((error: unknown) => {
          warn('[game-services] the services could not be closed cleanly', error);
        }).finally(() => input.onPlayerChanged?.(playerId));
      }
      return;
    }
    try {
      inner = input.create(playerId);
      innerPlayer = playerId;
    } catch (error) {
      // Stays gated: purchases keep answering the session refusal, never a raw error.
      warn('[game-services] the services could not be created after sign-in', error);
      return;
    }
    try {
      input.onActivated?.();
    } catch (error) {
      // The services are up; only the caller's follow-up failed.
      warn('[game-services] the activation callback failed', error);
    }
    for (const listener of [...readyListeners]) {
      readyListeners.delete(listener);
      try {
        listener();
      } catch (error) {
        warn('[game-services] a ready listener failed', error);
      }
    }
  };
  input.onPlayer(activate);

  const ready = async (): Promise<GameServicesRuntime> => {
    if (inner === undefined && closedCode === undefined) {
      const playerId = await input.ensurePlayer();
      if (playerId !== undefined) {
        activate(playerId);
      }
    }
    const services = live();
    if (services === undefined) {
      throw new StarterSessionRequiredError(closedCode);
    }
    return services;
  };
  const readyClientOrUndefined = async (): Promise<GameServicesClient | undefined> => {
    try {
      return await readyClient();
    } catch (error) {
      if (error instanceof StarterSessionRequiredError) {
        return undefined;
      }
      throw error;
    }
  };
  const readyClient = async (): Promise<GameServicesClient> => {
    const client = (await ready()).client;
    if (client === undefined) {
      throw new StarterSessionRequiredError();
    }
    return client;
  };

  let client: GameServicesClient | undefined;
  if (input.probe.client !== undefined) {
    client = {
      purchase: async (purchase, options) => {
        const ready = await readyClientOrUndefined();
        return ready === undefined
          ? refusedPurchase(closedCode ?? starterSessionRequiredCode)
          : ready.purchase(purchase, options);
      },
      claimRewardedAd: async (reward, options) => {
        const ready = await readyClientOrUndefined();
        return ready === undefined ? sessionRequiredReward() : ready.claimRewardedAd(reward, options);
      },
      submitLeaderboardScore: async (score) => (await readyClient()).submitLeaderboardScore(score),
    };
    // Read live: the reconciler of the services created after sign-in.
    Object.defineProperty(client, 'commerceReconciler', {
      enumerable: true,
      get: () => live()?.client?.commerceReconciler,
    });
  }

  const services = {
    onReady(listener: () => void) {
      readyListeners.add(listener);
      return () => {
        readyListeners.delete(listener);
      };
    },
    ...(input.probe.reason === undefined ? {} : { reason: input.probe.reason }),
    ...(input.probe.baseUrl === undefined ? {} : { baseUrl: input.probe.baseUrl }),
    ...(input.probe.target === undefined ? {} : { target: input.probe.target }),
    ...(client === undefined
      ? {}
      : {
          client,
          // Only a configuration with a client can come up; a disabled one offers nothing to retry.
          async ensureSession() {
            try {
              await ready();
              return true;
            } catch {
              return false;
            }
          },
        }),
    async dispose() {
      closedCode ??= gameServicesRuntimeDisposedCode;
      readyListeners.clear();
      await inner?.dispose();
    },
  } as StarterSessionGatedServices;
  // Read live: `undefined` until the player is known, so rewarded ads stay off until then,
  // and Delete account appears once there is an account (the lobby's next visit).
  Object.defineProperties(services, {
    mode: { enumerable: true, get: () => inner?.mode ?? input.probe.mode },
    monetizationRecovery: { enumerable: true, get: () => live()?.monetizationRecovery },
    accountDeletion: { enumerable: true, get: () => live()?.accountDeletion },
  });
  return services;
}

/**
 * Closes `services` once the server session names another player than
 * `playerId` (an account switch within the run): `onPlayerChanging` hears it
 * at once (the runtime's own `sessionPlayerId` check already refuses every
 * request from that moment; block input or show a switching screen), then
 * the services are disposed (an open store sheet first journals its answer)
 * and `onPlayerChanged` asks the host to restart for that player. Services
 * created for another player than the session's current one stay closed,
 * which `warn` reports. `onDisposed` runs once, after the services were
 * disposed either way (the store binding pin is released there).
 * `dispose()` also stops watching.
 */
export function bindStarterServicesToPlayer(input: {
  readonly services: GameServicesRuntime;
  readonly playerId: string;
  readonly session: {
    current(): { readonly playerId: string } | undefined;
    onAuthenticated(listener: (session: { readonly playerId: string }) => void): () => void;
  };
  readonly onPlayerChanging?: (playerId: string) => void;
  readonly onPlayerChanged?: (playerId: string) => void;
  readonly onDisposed?: () => void;
  readonly warn?: (message: string, error?: unknown) => void;
}): GameServicesRuntime {
  const warn = input.warn ?? ((message: string, error?: unknown) => console.warn(message, error ?? ''));
  const { services } = input;
  const current = input.session.current()?.playerId;
  if (current !== undefined && current !== input.playerId) {
    warn(
      "[game-services] created for a player that is not the server session's; they stay closed. "
        + "Create them with the session's player.",
    );
  }
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= services.dispose().catch((error: unknown) => {
      warn('[game-services] the services could not be closed cleanly', error);
    }).finally(() => input.onDisposed?.());
    return closing;
  };
  let changed = false;
  /** The unsubscribe, once `onAuthenticated` returned it. */
  const watching: { stop?: () => void } = {};
  const onSession = (next: { readonly playerId: string }): void => {
    if (changed || next.playerId === input.playerId) {
      return;
    }
    changed = true;
    watching.stop?.();
    notifyChanging(input.onPlayerChanging, next.playerId, warn);
    void close().finally(() => input.onPlayerChanged?.(next.playerId));
  };
  watching.stop = input.session.onAuthenticated(onSession);
  if (changed) {
    // The session announced another player while subscribing.
    watching.stop();
  }
  return {
    ...services,
    async dispose() {
      watching.stop?.();
      await close();
    },
  };
}

/** Tells the host at once that another player signed in; a throwing callback is only reported. */
function notifyChanging(
  callback: ((playerId: string) => void) | undefined,
  playerId: string,
  warn: (message: string, error?: unknown) => void,
): void {
  try {
    callback?.(playerId);
  } catch (error) {
    warn('[game-services] the player change callback failed', error);
  }
}
