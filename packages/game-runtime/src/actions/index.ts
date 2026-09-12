import type {
  GameServicesOperationClient,
  GameServicesPurchaseInput,
  GameServicesPurchaseProgress,
  GameServicesPurchaseResult,
  GameServicesRewardedAdInput,
  GameServicesRewardedAdProgress,
  GameServicesRewardedAdResult,
} from '@mpgd/game-services/operations';

import type { ExecutionBlock, GameExecutionController } from '../index.js';
import { observe, type ObserverErrorHandler } from '../observers.js';
import {
  createGameUiBridge,
  type GameUiBridge,
  type GameUiScope,
  type UiListener,
} from '../ui/index.js';

export type GameActionKind = 'purchase' | 'rewarded-ad';
interface Inputs { purchase: GameServicesPurchaseInput; 'rewarded-ad': GameServicesRewardedAdInput }
interface Results { purchase: GameServicesPurchaseResult; 'rewarded-ad': GameServicesRewardedAdResult }
interface Progress { purchase: GameServicesPurchaseProgress; 'rewarded-ad': GameServicesRewardedAdProgress }

export type GameActionSnapshot<K extends GameActionKind> = Readonly<{ kind: K } & (
  | { status: 'idle' }
  | { status: 'running'; operationId: number; progress?: Progress[K] }
  | { status: Results[K]['status'] | 'exception'; operationId: number }
)>;
export type PurchaseActionSnapshot = GameActionSnapshot<'purchase'>;
export type RewardedAdActionSnapshot = GameActionSnapshot<'rewarded-ad'>;
export type GameActionErrorCode = 'disposed' | 'busy' | 'key-conflict' | 'already-completed'
  | 'reconciliation-required' | 'history-full' | 'invalid-input';

/** Scheduling/preflight rejection, distinct from a service result or external exception. */
export class GameActionExecutionError extends Error {
  constructor(readonly code: GameActionErrorCode) {
    super(`Game action cannot start: ${code}`);
    this.name = 'GameActionExecutionError';
  }
}

export interface GameActionView<K extends GameActionKind> {
  execute(input: Inputs[K]): Promise<Results[K]>;
  /** Detaches this view; it cannot cancel an already started service operation. */
  dispose(): void;
}

export interface GameActionController<K extends GameActionKind> extends GameActionView<K> {
  getSnapshot(): GameActionSnapshot<K>;
  /** No initial delivery. Observer failures cannot change the service result. */
  subscribe(listener: UiListener<GameActionSnapshot<K>>): () => void;
  isDisposed(): boolean;
  /** Only actions explicitly executed/joined through this view may update its scope. */
  bindScope<S, C, E>(scope: GameUiScope<S, C, E>, projection: {
    snapshot(value: GameActionSnapshot<K>): S;
    event?(value: GameActionSnapshot<K>): E;
  }): GameActionView<K>;
}

export interface GameActionCoordinator {
  createPurchaseController(): GameActionController<'purchase'>;
  createRewardedAdController(): GameActionController<'rewarded-ad'>;
  getAvailability(): 'ready' | 'busy' | 'reconciliation-required' | 'history-full' | 'disposed';
  /** Terminal for new calls; pending external work still settles and releases its own block. */
  dispose(): void;
}

interface Flight<K extends GameActionKind> {
  readonly id: number;
  readonly kind: K;
  readonly key: string;
  readonly fingerprint: string;
  readonly promise: Promise<Results[K]>;
  readonly bridge: GameUiBridge<GameActionSnapshot<K>, never, never>;
  settled: boolean;
  start(canStart: () => boolean): void;
}

type AnyFlight = Flight<'purchase'> | Flight<'rewarded-ad'>;

/** Bind one coordinator to one runtime/client (including its player identity), above all screens. */
export function createGameActionCoordinator(options: {
  readonly execution: GameExecutionController;
  readonly client: Pick<GameServicesOperationClient, 'purchase' | 'claimRewardedAd'>;
  /** Never evicts keys: once full, new keys are rejected until application teardown. Default 1024. */
  readonly maxRememberedKeys?: number;
  readonly onObserverError?: ObserverErrorHandler;
}): GameActionCoordinator {
  const { execution, client, onObserverError } = options;
  const capacity = options.maxRememberedKeys ?? 1024;
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 10000) {
    throw new RangeError('maxRememberedKeys must be an integer from 1 to 10000.');
  }
  const history = new Map<string, string>();
  let current: AnyFlight | undefined;
  let last: AnyFlight | undefined;
  let nextId = 0;
  let disposed = false;
  let needsReconciliation = false;

  function isDisposed(): boolean {
    return disposed || execution.getSnapshot().status === 'destroyed';
  }

  function reserve<K extends GameActionKind>(kind: K, supplied: Inputs[K]): Flight<K> {
    if (isDisposed()) {
      throw new GameActionExecutionError('disposed');
    }
    const key = supplied.idempotencyKey;
    const productId = kind === 'purchase' ? (supplied as Inputs['purchase']).productId : undefined;
    const source = kind === 'purchase' ? (supplied as Inputs['purchase']).source : undefined;
    const placementId = kind === 'rewarded-ad'
      ? (supplied as Inputs['rewarded-ad']).placementId
      : undefined;
    if (typeof key !== 'string' || key.trim() === ''
      || (kind === 'purchase' && (typeof productId !== 'string' || productId.trim() === ''
        || !['shop', 'stage_fail', 'result', 'event'].includes(source ?? '')))
      || (kind === 'rewarded-ad' && (typeof placementId !== 'string' || placementId.trim() === ''))) {
      throw new GameActionExecutionError('invalid-input');
    }
    // Copy only the flat public input; later caller mutation cannot change this invocation.
    const input = Object.freeze(
      kind === 'purchase'
        ? { productId, source, idempotencyKey: key }
        : { placementId, idempotencyKey: key },
    ) as Inputs[K];
    const fingerprint = JSON.stringify([kind, productId, source, placementId]);
    const prior = history.get(key);
    if (prior !== undefined && prior !== fingerprint) {
      throw new GameActionExecutionError('key-conflict');
    }
    const retained = current?.key === key ? current : last?.key === key ? last : undefined;
    if (retained !== undefined) {
      return retained as Flight<K>;
    }
    if (prior !== undefined) {
      throw new GameActionExecutionError('already-completed');
    }
    if (needsReconciliation) {
      throw new GameActionExecutionError('reconciliation-required');
    }
    if (current !== undefined) {
      throw new GameActionExecutionError('busy');
    }
    if (history.size >= capacity) {
      throw new GameActionExecutionError('history-full');
    }

    const id = ++nextId;
    const bridge = createGameUiBridge<GameActionSnapshot<K>, never, never>({
      initialSnapshot: Object.freeze({ kind, status: 'running', operationId: id }),
      ...(onObserverError === undefined ? {} : { onListenerError: onObserverError }),
    });
    let resolve!: (value: Results[K]) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<Results[K]>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    // A nested observer can join without attaching a rejection handler of its own.
    void promise.catch(() => {});
    let started = false;
    let block: ExecutionBlock | undefined;
    let invoked = false;

    function finish(status: Results[K]['status'] | 'exception'): void {
      flight.settled = true;
      if (invoked && (status === 'pending' || status === 'exception')) {
        needsReconciliation = true;
      }
      current = undefined;
      last = flight as AnyFlight;
      if (!invoked) {
        history.delete(key);
        last = undefined;
      }
      // Reentrant release observers can start another operation; only this flight is touched below.
      bridge.setSnapshot(Object.freeze({ kind, status, operationId: id }));
      observe(() => block?.release(), onObserverError);
      bridge.destroy();
    }

    function progress(value: Progress[K]): void {
      if (flight.settled || value.kind !== kind) {
        return;
      }
      // Whitelist fields: ports cannot leak raw receipts/responses through additional properties.
      const base = { kind, sequence: value.sequence };
      let safe: Progress[K];
      switch (value.phase) {
        case 'platform-result':
        case 'completed':
          safe = Object.freeze({
            ...base,
            phase: value.phase,
            status: value.status,
          }) as unknown as Progress[K];
          break;
        case 'server-result':
          safe = Object.freeze({
            ...base,
            phase: value.phase,
            accepted: value.accepted,
          }) as unknown as Progress[K];
          break;
        case 'exception':
          safe = Object.freeze({
            ...base,
            phase: value.phase,
            at: value.at,
          }) as unknown as Progress[K];
          break;
        default:
          safe = Object.freeze({ ...base, phase: value.phase }) as unknown as Progress[K];
      }
      bridge.setSnapshot(
        Object.freeze({ kind, status: 'running', operationId: id, progress: safe }),
      );
    }

    const flight: Flight<K> = {
      id, kind, key, fingerprint, promise, bridge, settled: false,
      start(canStart): void {
        if (started) {
          return;
        }
        started = true;
        void (async () => {
          try {
            if (isDisposed() || !canStart()) {
              throw new GameActionExecutionError('disposed');
            }
            block = execution.acquireBlock({ reason: `action:${kind}`, channels: ['simulation', 'gameplay-input'] });
            if (isDisposed() || !canStart()) {
              throw new GameActionExecutionError('disposed');
            }
            invoked = true;
            const result = await (kind === 'purchase'
              ? client.purchase(input as Inputs['purchase'], { onProgress: (value) => observe(() => progress(value as Progress[K]), onObserverError) })
              : client.claimRewardedAd(input as Inputs['rewarded-ad'], { onProgress: (value) => observe(() => progress(value as Progress[K]), onObserverError) })) as Results[K];
            finish(result.status);
            resolve(result);
          } catch (error) {
            finish('exception');
            reject(error);
          }
        })();
      },
    };
    history.set(key, fingerprint);
    current = flight as AnyFlight;
    return flight;
  }

  function makeController<K extends GameActionKind>(kind: K): GameActionController<K> {
    if (isDisposed()) {
      throw new GameActionExecutionError('disposed');
    }
    let ownerDisposed = false;
    let snapshot: GameActionSnapshot<K> = Object.freeze({ kind, status: 'idle' });
    const bridge = createGameUiBridge<GameActionSnapshot<K>, never, never>({
      initialSnapshot: snapshot,
      ...(onObserverError === undefined ? {} : { onListenerError: onObserverError }),
    });
    let trackedId: number | undefined;
    let detach = (): void => {};

    function execute(input: Inputs[K], attach?: (flight: Flight<K>) => void): Promise<Results[K]> {
      try {
        if (ownerDisposed) {
          throw new GameActionExecutionError('disposed');
        }
        const flight = reserve(kind, input);
        if (trackedId !== flight.id) {
          detach();
          trackedId = flight.id;
          const update = (value: GameActionSnapshot<K>): void => {
            if (trackedId !== flight.id) {
              return;
            }
            snapshot = value;
            if (!ownerDisposed) {
              bridge.setSnapshot(value);
            }
          };
          if (!flight.settled) {
            detach = flight.bridge.subscribeSnapshot(update);
          }
          update(flight.bridge.getSnapshot());
        }
        observe(() => attach?.(flight), onObserverError);
        flight.start(() => !ownerDisposed);
        return flight.promise;
      } catch (error) {
        return Promise.reject(error);
      }
    }

    return Object.freeze({
      execute,
      getSnapshot: () => snapshot,
      subscribe: bridge.subscribeSnapshot,
      isDisposed: () => ownerDisposed,
      dispose(): void {
        ownerDisposed = true;
        bridge.destroy();
        // Keep the current flight observer until settlement so its authoritative result remains readable.
      },
      bindScope<S, C, E>(scope: GameUiScope<S, C, E>, projection: {
        snapshot(value: GameActionSnapshot<K>): S;
        event?(value: GameActionSnapshot<K>): E;
      }): GameActionView<K> {
        if (ownerDisposed || scope.isDisposed()) {
          throw new GameActionExecutionError('disposed');
        }
        let viewDisposed = false;
        let viewId: number | undefined;
        let detachView = (): void => {};
        const dispose = (): void => {
          viewDisposed = true;
          detachView();
        };
        const release = scope.own(dispose);
        return Object.freeze({
          dispose: release,
          execute(input: Inputs[K]): Promise<Results[K]> {
            if (viewDisposed || scope.isDisposed()) {
              return Promise.reject(new GameActionExecutionError('disposed'));
            }
            return execute(input, (flight) => {
              if (viewId === flight.id || viewDisposed || scope.isDisposed()) {
                return;
              }
              detachView();
              viewId = flight.id;
              const update = (value: GameActionSnapshot<K>): void => {
                if (viewDisposed || scope.isDisposed() || viewId !== flight.id) {
                  return;
                }
                observe(() => {
                  scope.setSnapshot(projection.snapshot(value)); }, onObserverError);
                const projectEvent = projection.event;
                if (value.status !== 'running' && value.status !== 'idle'
                  && !viewDisposed && !scope.isDisposed() && viewId === flight.id && projectEvent !== undefined) {
                  observe(() => {
                    scope.emit(projectEvent(value)); }, onObserverError);
                }
              };
              if (!flight.settled) {
                detachView = flight.bridge.subscribeSnapshot(update);
              }
              update(flight.bridge.getSnapshot());
            });
          },
        });
      },
    });
  }

  return Object.freeze({
    createPurchaseController: () => makeController('purchase'),
    createRewardedAdController: () => makeController('rewarded-ad'),
    getAvailability() {
      if (isDisposed()) {
        return 'disposed';
      }
      if (current !== undefined) {
        return 'busy';
      }
      if (needsReconciliation) {
        return 'reconciliation-required';
      }
      return history.size >= capacity ? 'history-full' : 'ready';
    },
    dispose(): void {
      disposed = true; },
  });
}

export function createPurchaseActionController(input: { coordinator: GameActionCoordinator }): GameActionController<'purchase'> {
  return input.coordinator.createPurchaseController();
}

export function createRewardedAdActionController(input: { coordinator: GameActionCoordinator }): GameActionController<'rewarded-ad'> {
  return input.coordinator.createRewardedAdController();
}
