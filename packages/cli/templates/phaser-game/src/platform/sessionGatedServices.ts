import type { GameServicesClient, GameServicesRuntime } from '@mpgd/game-services';

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
 *   exists for the run. Its calls sign in first (`ensurePlayer`) and fail with
 *   `StarterSessionRequiredError` before any store UI opens when that still
 *   fails.
 * - `monetizationRecovery` is `undefined` until then: rewarded ads stay off
 *   (the runtime shows none without it, so no ad is watched for a reward that
 *   could not be claimed), and the Restore Purchases control signs in first
 *   through `ensureSession`.
 * - When the player becomes known, the services are created once; the
 *   caller runs the game runtime's `reconcile()` then (the startup recovery,
 *   with the action coordinator's). A later sign-in naming another player
 *   (not expected within one run) is ignored with a warning.
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
      // Stays gated: purchases keep answering StarterSessionRequiredError, never a raw error.
      warn('[game-services] the services could not be created after sign-in', error);
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
      purchase: async (purchase, options) => (await readyClient()).purchase(purchase, options),
      claimRewardedAd: async (reward, options) => (await readyClient()).claimRewardedAd(reward, options),
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
  // Read live: `undefined` until the player is known, so rewarded ads stay off until then.
  Object.defineProperties(services, {
    mode: { enumerable: true, get: () => inner?.mode ?? input.probe.mode },
    monetizationRecovery: { enumerable: true, get: () => inner?.monetizationRecovery },
  });
  return services;
}
