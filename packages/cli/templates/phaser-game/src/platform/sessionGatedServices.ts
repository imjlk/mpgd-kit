import type {
  GameServicesClient,
  GameServicesPurchaseResult,
  GameServicesRewardedAdResult,
  GameServicesRuntime,
} from '@mpgd/game-services';

/** The diagnostic of a purchase refused because the run is not signed in yet (retryable). */
export const starterSessionRequiredCode = 'STARTER_SESSION_REQUIRED';

function sessionRequiredPurchase(): GameServicesPurchaseResult {
  return {
    status: 'failed',
    purchase: {
      status: 'failed',
      entitlementIds: [],
      diagnostic: { code: starterSessionRequiredCode, retryable: true },
    },
  };
}

function sessionRequiredReward(): GameServicesRewardedAdResult {
  return { status: 'unavailable', reward: { status: 'unavailable', rewardGranted: false } };
}

/** A purchase, restore, or reward claim was asked for before the guest sign-in succeeded. */
export class StarterSessionRequiredError extends Error {
  readonly code = 'STARTER_SESSION_REQUIRED';

  constructor() {
    super('The game is not signed in to its identity service yet; try again when it is online.');
    this.name = 'StarterSessionRequiredError';
  }
}

/** The game services of a run that booted before its guest sign-in succeeded. */
export type StarterSessionGatedServices = GameServicesRuntime & {
  /**
   * Signs in now if needed (once more before a purchase or restore); `true`
   * when the services are up. Absent when the configuration has no client.
   */
  readonly ensureSession?: () => Promise<boolean>;
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
 *   startup recovery, with the action coordinator's). A later sign-in naming another player
 *   (not expected within one run) is ignored with a warning.
 * - `accountDeletion` is `undefined` until then, and the services' after
 *   (read live), so Delete account shows from the lobby's next visit.
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
  readonly warn?: (message: string, error?: unknown) => void;
}): StarterSessionGatedServices {
  const warn = input.warn ?? ((message: string, error?: unknown) => console.warn(message, error ?? ''));
  let inner: GameServicesRuntime | undefined;
  let innerPlayer: string | undefined;

  const activate = (playerId: string): void => {
    if (inner !== undefined) {
      if (playerId !== innerPlayer) {
        warn(
          '[game-services] a later sign-in named another player; the services keep the first until restart.',
        );
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
  };
  input.onPlayer(activate);

  const ready = async (): Promise<GameServicesRuntime> => {
    if (inner === undefined) {
      const playerId = await input.ensurePlayer();
      if (playerId !== undefined) {
        activate(playerId);
      }
    }
    if (inner === undefined) {
      throw new StarterSessionRequiredError();
    }
    return inner;
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
        return ready === undefined ? sessionRequiredPurchase() : ready.purchase(purchase, options);
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
      get: () => inner?.client?.commerceReconciler,
    });
  }

  const services = {
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
  } as StarterSessionGatedServices;
  // Read live: `undefined` until the player is known, so rewarded ads stay off until then,
  // and Delete account appears once there is an account (the lobby's next visit).
  Object.defineProperties(services, {
    mode: { enumerable: true, get: () => inner?.mode ?? input.probe.mode },
    monetizationRecovery: { enumerable: true, get: () => inner?.monetizationRecovery },
    accountDeletion: { enumerable: true, get: () => inner?.accountDeletion },
  });
  return services;
}
