import type { BridgeNotificationsEvent } from '@mpgd/bridge';
import { PlatformOperationError } from '@mpgd/platform';
import type { NotificationEvent, NotificationProvider } from '@mpgd/platform/notifications';

import type { CreateAitBridgeNotificationProviderInput } from './notifications-bridge.js';

/**
 * The game side of notifications v2 on Apps in Toss, loaded on first use.
 * The bridge provider and its validators (`@mpgd/bridge/notifications`,
 * `@mpgd/platform/notifications`) are a separate chunk that only a game whose
 * host offers the notifications channel loads. This module imports no
 * notifications code, so the gateway can create the provider synchronously.
 *
 * - Every method loads the chunk, then calls the bridge provider. A chunk
 *   that fails to load rejects with a retryable
 *   `NOTIFICATIONS_TEMPORARILY_UNAVAILABLE`, and the next call tries again.
 * - `subscribe` attaches to the bridge channel at once, so an event the host
 *   emits while the chunk loads (the launch's cold open) is kept, and
 *   delivers the events in order once they are validated.
 */
export function createLazyAitBridgeNotificationProvider(
  input: CreateAitBridgeNotificationProviderInput,
): NotificationProvider {
  type Loaded = typeof import('./notifications-bridge.js');
  let loading: Promise<Loaded> | undefined;
  const load = (): Promise<Loaded> => {
    const current = loading ?? import('./notifications-bridge.js');
    loading = current;
    current.catch(() => {
      if (loading === current) {
        loading = undefined;
      }
    });
    return current;
  };
  let bridged: NotificationProvider | undefined;
  const provider = async (): Promise<NotificationProvider> => {
    let module: Loaded;
    try {
      module = await load();
    } catch (error) {
      throw new PlatformOperationError({
        code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE',
        message: `The notifications bridge client did not load: ${
          error instanceof Error ? error.message : String(error)
        }`,
        retryable: true,
      });
    }
    bridged ??= module.createAitBridgeNotificationProvider(input);
    return bridged;
  };

  return {
    provider: input.provider,
    getCapabilities: async () => (await provider()).getCapabilities(),
    getPermission: async (request) => (await provider()).getPermission(request),
    requestPermission: async (request) => (await provider()).requestPermission(request),
    register: async () => (await (await provider()).register?.()) ?? null,
    openSettings: async () => (await (await provider()).openSettings?.()) ?? 'unavailable',
    subscribe(listener) {
      const pending: BridgeNotificationsEvent[] = [];
      let read: ((envelope: unknown) => NotificationEvent | undefined) | undefined;
      let closed = false;
      const deliver = (envelope: unknown): void => {
        const event = read?.(envelope);
        if (event !== undefined) {
          listener(event);
        }
      };
      const detach = input.subscribe((envelope) => {
        if (read === undefined) {
          pending.push(envelope);
        } else {
          deliver(envelope);
        }
      });
      const attach = (attempt: number): void => {
        load().then(
          (module) => {
            if (closed) {
              return;
            }
            read = module.readAitBridgeNotificationEvent;
            for (const envelope of pending.splice(0)) {
              deliver(envelope);
            }
          },
          (error: unknown) => {
            if (closed) {
              return;
            }
            if (attempt < 2) {
              attach(attempt + 1);
              return;
            }
            console.warn('AIT notifications bridge client did not load; events are dropped.', error);
            pending.length = 0;
          },
        );
      };
      attach(0);
      return () => {
        closed = true;
        pending.length = 0;
        detach();
      };
    },
  };
}
