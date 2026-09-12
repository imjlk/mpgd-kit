import { executionChannels } from '../channels.js';
import type { ExecutionBlock, ExecutionChannel, GameExecutionController } from '../index.js';
import { observe, type ObserverErrorHandler } from '../observers.js';

/** Compatible with PlatformGateway.lifecycle without importing a platform SDK. */
export interface GameLifecycleSource {
  onPause(callback: () => void): () => void;
  onResume(callback: () => void): () => void;
}

export type GameLifecycleState = 'active' | 'inactive' | 'unknown';

export type LifecycleInitialization =
  | { readonly initialState: GameLifecycleState; readonly readState?: never }
  | { readonly readState: () => GameLifecycleState; readonly initialState?: never };

export interface GameLifecycleBinding {
  dispose(): void;
}

export function bindGameLifecycle(input: LifecycleInitialization & {
  readonly controller: GameExecutionController;
  readonly source: GameLifecycleSource;
  readonly reason?: string;
  readonly channels?: readonly ExecutionChannel[];
  readonly onError?: ObserverErrorHandler;
}): GameLifecycleBinding {
  const { controller, source, onError } = input;
  const reason = input.reason ?? 'lifecycle';
  const channels: ExecutionChannel[] = [...(input.channels ?? executionChannels)];
  if (typeof reason !== 'string' || reason.trim().length === 0 || channels.length === 0) {
    throw new TypeError('Lifecycle reason and channels must be non-empty.');
  }
  if (channels.some((channel) => !executionChannels.includes(channel))) {
    throw new TypeError('Unknown lifecycle execution channel.');
  }
  const readState = input.readState;
  let state: GameLifecycleState = 'unknown';
  if (readState === undefined) {
    state = validateState(input.initialState);
  } else if (typeof readState !== 'function') {
    throw new TypeError('Lifecycle readState must be a function.');
  }
  let disposed = false;
  let initializing = true;
  let applying = false;
  let dirty = false;
  let eventsSeen = 0;
  let block: ExecutionBlock | undefined;
  const unsubscribes: (() => void)[] = [];

  function dispose(): void {
    if (disposed) {
      return;
    }
    disposed = true;
    for (const unsubscribe of unsubscribes.splice(0)) {
      observe(unsubscribe, onError);
    }
    const owned = block;
    block = undefined;
    owned?.release();
  }

  function reconcile(): void {
    dirty = true;
    if (disposed || initializing || applying) {
      return;
    }
    applying = true;
    try {
      while (dirty && !disposed) {
        dirty = false;
        if (controller.getSnapshot().status === 'destroyed') {
          dispose();
          break;
        }
        if (state !== 'active' && block === undefined) {
          const acquired = controller.acquireBlock({ reason, channels });
          if (disposed) {
            acquired.release();
          } else {
            block = acquired;
          }
        } else if (state === 'active' && block !== undefined) {
          const owned = block;
          block = undefined;
          owned.release();
        }
      }
    } finally {
      applying = false;
    }
  }

  function receive(next: GameLifecycleState): void {
    if (!disposed) {
      eventsSeen += 1;
      state = next;
      reconcile();
    }
  }

  function own(unsubscribe: () => void): void {
    if (disposed) {
      observe(unsubscribe, onError);
    } else {
      unsubscribes.push(unsubscribe);
    }
  }

  try {
    own(controller.subscribe((snapshot) => {
      if (snapshot.status === 'destroyed') {
        dispose();
      }
    }));
    own(source.onPause(() => receive('inactive')));
    if (!disposed) {
      own(source.onResume(() => receive('active')));
    }
    if (!disposed && readState !== undefined) {
      const beforeRead = eventsSeen;
      const initial = validateState(readState());
      // A synchronously observed event during the read is newer than its return value.
      if (eventsSeen === beforeRead) {
        state = initial;
      }
    }
    initializing = false;
    reconcile();
  } catch (error) {
    dispose();
    throw error;
  }
  return Object.freeze({ dispose });
}

function validateState(state: unknown): GameLifecycleState {
  if (state !== 'active' && state !== 'inactive' && state !== 'unknown') {
    throw new TypeError('Provide an explicit active, inactive, or unknown lifecycle state.');
  }
  return state;
}
