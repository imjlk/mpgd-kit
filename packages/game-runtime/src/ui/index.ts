import { observe, type ObserverErrorHandler } from '../observers.js';

export type UiListener<T> = (value: T) => void | Promise<void>;
export type UiCleanup = () => void | Promise<void>;

export interface GameUiScope<TSnapshot, TCommand, TEvent> {
  isDisposed(): boolean;
  /** Register owned cleanup; the returned function releases it once, early if needed. */
  own(cleanup: UiCleanup): () => void;
  subscribeSnapshot(listener: UiListener<TSnapshot>): () => void;
  subscribeSelector<TSelected>(
    selector: (snapshot: TSnapshot) => TSelected,
    listener: UiListener<TSelected>,
    equality?: (left: TSelected, right: TSelected) => boolean,
  ): () => void;
  onCommand(listener: UiListener<TCommand>): () => void;
  onEvent(listener: UiListener<TEvent>): () => void;
  /** False after scope disposal, including disposal through bridge destruction. */
  setSnapshot(snapshot: TSnapshot): boolean;
  emit(event: TEvent): boolean;
  dispatch(command: TCommand): boolean;
  dispose(): void;
}

export interface GameUiBridge<TSnapshot, TCommand, TEvent> {
  getSnapshot(): TSnapshot;
  setSnapshot(snapshot: TSnapshot): void;
  subscribeSnapshot(listener: UiListener<TSnapshot>): () => void;
  subscribeSelector<TSelected>(
    selector: (snapshot: TSnapshot) => TSelected,
    listener: UiListener<TSelected>,
    equality?: (left: TSelected, right: TSelected) => boolean,
  ): () => void;
  dispatch(command: TCommand): void;
  onCommand(listener: UiListener<TCommand>): () => void;
  emit(event: TEvent): void;
  onEvent(listener: UiListener<TEvent>): () => void;
  createScope(): GameUiScope<TSnapshot, TCommand, TEvent>;
  destroy(): void;
}

interface Subscription<T> {
  readonly listener: UiListener<T>;
  active: boolean;
}

export function createGameUiBridge<TSnapshot, TCommand, TEvent = never>(input: {
  readonly initialSnapshot: TSnapshot;
  readonly onListenerError?: ObserverErrorHandler;
}): GameUiBridge<TSnapshot, TCommand, TEvent> {
  let snapshot = input.initialSnapshot;
  const onError = input.onListenerError;
  const snapshots = new Set<Subscription<TSnapshot>>();
  const commands = new Set<Subscription<TCommand>>();
  const events = new Set<Subscription<TEvent>>();
  const scopes = new Set<GameUiScope<TSnapshot, TCommand, TEvent>>();
  const queue: (() => void)[] = [];
  let destroyed = false;
  let delivering = false;

  function assertActive(): void {
    if (destroyed) {
      throw new Error('Game UI bridge is destroyed.');
    }
  }

  function subscribe<T>(subscriptions: Set<Subscription<T>>, listener: UiListener<T>): () => void {
    assertActive();
    if (typeof listener !== 'function') {
      throw new TypeError('UI listener must be a function.');
    }
    const subscription: Subscription<T> = { listener, active: true };
    subscriptions.add(subscription);
    return () => {
      subscription.active = false;
      subscriptions.delete(subscription);
    };
  }

  function publish<T>(subscriptions: Set<Subscription<T>>, value: T): void {
    const recipients = [...subscriptions];
    queue.push(() => {
      for (const subscription of recipients) {
        if (!destroyed && subscription.active) {
          observe(() => subscription.listener(value), onError);
        }
      }
    });
    if (delivering) {
      return;
    }
    delivering = true;
    try {
      for (let cursor = 0; !destroyed && cursor < queue.length; cursor += 1) {
        queue[cursor]?.();
      }
    } finally {
      queue.length = 0;
      delivering = false;
    }
  }

  const bridge: GameUiBridge<TSnapshot, TCommand, TEvent> = {
    getSnapshot: () => snapshot,
    setSnapshot(next): void {
      assertActive();
      if (!Object.is(snapshot, next)) {
        snapshot = next;
        publish(snapshots, next);
      }
    },
    subscribeSnapshot: (listener) => subscribe(snapshots, listener),
    subscribeSelector<TSelected>(
      selector: (value: TSnapshot) => TSelected,
      listener: UiListener<TSelected>,
      equality: (left: TSelected, right: TSelected) => boolean = Object.is,
    ): () => void {
      assertActive();
      if (
        typeof selector !== 'function'
        || typeof listener !== 'function'
        || typeof equality !== 'function'
      ) {
        throw new TypeError('Selector, listener and equality must be functions.');
      }
      // Selectors and equality functions must be pure. An initial failure registers nothing.
      let selected = selector(snapshot);
      return subscribe(snapshots, (next) => {
        const nextSelected = selector(next);
        if (!equality(selected, nextSelected)) {
          selected = nextSelected;
          return listener(nextSelected);
        }
      });
    },
    dispatch(command): void {
      assertActive();
      publish(commands, command);
    },
    onCommand: (listener) => subscribe(commands, listener),
    emit(event): void {
      assertActive();
      publish(events, event);
    },
    onEvent: (listener) => subscribe(events, listener),
    createScope(): GameUiScope<TSnapshot, TCommand, TEvent> {
      assertActive();
      const cleanups = new Set<() => void>();
      let disposed = false;
      function assertScopeActive(): void {
        assertActive();
        if (disposed) {
          throw new Error('Game UI scope is disposed.');
        }
      }
      function register(registerListener: () => () => void): () => void {
        assertScopeActive();
        const unsubscribe = registerListener();
        // Selector callbacks can dispose the scope during registration.
        if (disposed || destroyed) {
          unsubscribe();
          return () => {};
        }
        return scope.own(unsubscribe);
      }
      function guarded<T>(listener: UiListener<T>): UiListener<T> {
        if (typeof listener !== 'function') {
          throw new TypeError('UI listener must be a function.');
        }
        return (value) => {
          if (!disposed && !destroyed) {
            return listener(value);
          }
        };
      }
      const scope: GameUiScope<TSnapshot, TCommand, TEvent> = {
        isDisposed: () => disposed,
        own(cleanup): () => void {
          if (typeof cleanup !== 'function') {
            throw new TypeError('Scope cleanup must be a function.');
          }
          let active = true;
          const release = (): void => {
            if (active) {
              active = false;
              cleanups.delete(release);
              observe(cleanup, onError);
            }
          };
          if (disposed || destroyed) {
            release();
          } else {
            cleanups.add(release);
          }
          return release;
        },
        subscribeSnapshot: (listener) => register(() => bridge.subscribeSnapshot(guarded(listener))),
        subscribeSelector: (selector, listener, equality) => register(
          () => bridge.subscribeSelector(selector, guarded(listener), equality),
        ),
        onCommand: (listener) => register(() => bridge.onCommand(guarded(listener))),
        onEvent: (listener) => register(() => bridge.onEvent(guarded(listener))),
        setSnapshot(next): boolean {
          if (disposed || destroyed) {
            return false;
          }
          bridge.setSnapshot(next);
          return true;
        },
        emit(event): boolean {
          if (disposed || destroyed) {
            return false;
          }
          bridge.emit(event);
          return true;
        },
        dispatch(command): boolean {
          if (disposed || destroyed) {
            return false;
          }
          bridge.dispatch(command);
          return true;
        },
        dispose(): void {
          if (disposed) {
            return;
          }
          disposed = true;
          scopes.delete(scope);
          // Revoke all scope callbacks before cleanup can reenter the bridge.
          const owned = [...cleanups];
          for (const cleanup of owned) {
            cleanup();
          }
        },
      };
      scopes.add(scope);
      return Object.freeze(scope);
    },
    destroy(): void {
      if (destroyed) {
        return;
      }
      destroyed = true;
      for (const scope of [...scopes]) {
        scope.dispose();
      }
      snapshots.clear();
      commands.clear();
      events.clear();
      queue.length = 0;
    },
  };
  return Object.freeze(bridge);
}
