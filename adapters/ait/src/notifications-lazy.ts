import { thrownMessage } from '@mpgd/bridge';
import { PlatformOperationError } from '@mpgd/platform';
import type { NotificationProvider } from '@mpgd/platform/notifications';

import type { CreateAitBridgeNotificationProviderInput } from './notifications-bridge.js';

/** What the provider uses from the bridge client chunk. */
export type AitBridgeNotificationClientModule = Pick<
  typeof import('./notifications-bridge.js'),
  'createAitBridgeNotificationProvider'
>;

type Loaded = AitBridgeNotificationClientModule;

export interface CreateLazyAitBridgeNotificationProviderOptions {
  /** Loads the client chunk; the dynamic import by default. Tests inject it. */
  readonly load?: () => Promise<AitBridgeNotificationClientModule>;
}

/** Delays before the client retries a failed load on its own while subscribers wait. */
const retryDelaysMs = [1_000, 4_000, 15_000];

/**
 * The game side of notifications v2 on Apps in Toss, in a separate chunk.
 * The bridge provider and its validators (`@mpgd/bridge/notifications`,
 * `@mpgd/platform/notifications`) are loaded only by a game whose host offers
 * the notifications channel, which the host does while a topic is mapped.
 * This module imports no notifications code, so the gateway can create the
 * provider synchronously; it starts loading the chunk at once.
 *
 * - Every method waits for the chunk, then calls the bridge provider. A chunk
 *   that fails to load rejects with a retryable
 *   `NOTIFICATIONS_TEMPORARILY_UNAVAILABLE`, and the next call loads again.
 * - `subscribe` attaches to the bridge channel, through the bridge
 *   provider's own `subscribe` (which skips other protocols and drops an
 *   invalid envelope), only once the chunk has loaded. The host emits the
 *   launch's cold open to its first listener when that listener attaches,
 *   so nothing is missed, and the host claims the
 *   launch for the event only when the event can be delivered: a game that
 *   unsubscribes first, or whose chunk never loads, leaves the launch to the
 *   launch intent. A subscriber waiting for a failed load attaches on the
 *   next successful one: the provider retries after 1, 4, and 15 seconds
 *   while someone waits, and any later call loads again after that.
 */
export function createLazyAitBridgeNotificationProvider(
  input: CreateAitBridgeNotificationProviderInput,
  options: CreateLazyAitBridgeNotificationProviderOptions = {},
): NotificationProvider {
  const importClient = options.load ?? (() => import('./notifications-bridge.js'));
  let loaded: Loaded | undefined;
  let loading: Promise<Loaded> | undefined;
  let retries = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  const waiting = new Set<(module: Loaded) => void>();
  const attachWaiting = (module: Loaded): void => {
    const attaches = [...waiting];
    waiting.clear();
    for (const attach of attaches) {
      try {
        attach(module);
      } catch (error) {
        // One host subscribe that throws must not keep the others waiting.
        console.warn('AIT notifications subscriber could not attach.', error);
      }
    }
  };
  const load = (): Promise<Loaded> => {
    if (loading !== undefined) {
      return loading;
    }
    const current = importClient();
    loading = current;
    current.then(
      (module) => {
        loaded = module;
        retries = 0;
        attachWaiting(module);
      },
      () => {
        if (loading === current) {
          loading = undefined;
        }
        // Waiting subscribers would otherwise depend on a later call to
        // load again: retry a few times on our own, one timer at a time.
        if (waiting.size === 0 || retryTimer !== undefined) {
          return;
        }
        const delay = retryDelaysMs[retries];
        if (delay === undefined) {
          console.warn(
            'AIT notifications bridge client did not load; waiting subscribers attach on the next call that loads it.',
          );
          return;
        }
        retries += 1;
        retryTimer = setTimeout(() => {
          retryTimer = undefined;
          if (waiting.size > 0) {
            void load().catch(() => {});
          }
        }, delay);
      },
    );
    return current;
  };
  let bridged: NotificationProvider | undefined;
  const bridgedBy = (module: Loaded): NotificationProvider => {
    bridged ??= module.createAitBridgeNotificationProvider(input);
    return bridged;
  };
  const provider = async (): Promise<NotificationProvider> => {
    let module: Loaded;
    try {
      module = await load();
    } catch (error) {
      throw new PlatformOperationError({
        code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE',
        message: `The notifications bridge client did not load: ${thrownMessage(error)}`,
        retryable: true,
      });
    }
    return bridgedBy(module);
  };
  // The channel exists, so the chunk is needed: load it now rather than on
  // the first capability read, which is bounded in time.
  void load().catch(() => {});

  return {
    provider: input.provider,
    getCapabilities: async () => (await provider()).getCapabilities(),
    getPermission: async (request) => (await provider()).getPermission(request),
    requestPermission: async (request) => (await provider()).requestPermission(request),
    register: async () => (await (await provider()).register?.()) ?? null,
    openSettings: async () => (await (await provider()).openSettings?.()) ?? 'unavailable',
    subscribe(listener) {
      let detach: (() => void) | undefined;
      let closed = false;
      const attach = (module: Loaded): void => {
        if (closed) {
          return;
        }
        // The bridge provider reads and filters each envelope; this layer
        // only stops delivery once the listener has left.
        const unsubscribe = bridgedBy(module).subscribe((event) => {
          if (!closed) {
            listener(event);
          }
        });
        if (closed) {
          // The listener left during the host's synchronous replay.
          unsubscribe();
        } else {
          detach = unsubscribe;
        }
      };
      if (loaded === undefined) {
        waiting.add(attach);
        void load().catch((error: unknown) => {
          console.warn('AIT notifications bridge client did not load yet.', error);
        });
      } else {
        try {
          attach(loaded);
        } catch (error) {
          // As on the waiting path: a host subscribe that throws is reported,
          // not thrown into the game.
          console.warn('AIT notifications subscriber could not attach.', error);
        }
      }
      return () => {
        closed = true;
        waiting.delete(attach);
        detach?.();
        detach = undefined;
      };
    },
  };
}
