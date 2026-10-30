import type {
  GameServicesOperationClient,
  GameServicesPurchaseInput,
  GameServicesPurchaseProgress,
  GameServicesPurchaseResult,
  GameServicesRewardedAdInput,
  GameServicesRewardedAdProgress,
  GameServicesRewardedAdResult,
} from '@mpgd/game-services/operations';

import { matchCoordinatorRefusal, type CoordinatorRefusal } from '../commerce/refusals.js';
import type { ExecutionBlock, GameExecutionController } from '../index.js';
import { observe, type ObserverErrorHandler } from '../observers.js';
import type { FullScreenPresentationScope } from '../presentation/index.js';
import {
  createGameUiBridge,
  type GameUiBridge,
  type GameUiScope,
  type UiListener,
} from '../ui/index.js';

export type GameActionKind = 'purchase' | 'rewarded-ad';
interface Inputs {
  purchase: GameServicesPurchaseInput;
  'rewarded-ad': GameServicesRewardedAdInput;
}
interface Results {
  purchase: GameServicesPurchaseResult;
  'rewarded-ad': GameServicesRewardedAdResult;
}
interface Progress {
  purchase: GameServicesPurchaseProgress;
  'rewarded-ad': GameServicesRewardedAdProgress;
}

export type GameActionSnapshot<K extends GameActionKind> = Readonly<{ kind: K } & (
  | { status: 'idle' }
  | { status: 'running'; operationId: number; progress?: Progress[K] }
  | { status: Results[K]['status'] | 'exception'; operationId: number }
)>;
export type PurchaseActionSnapshot = GameActionSnapshot<'purchase'>;
export type RewardedAdActionSnapshot = GameActionSnapshot<'rewarded-ad'>;
/** Whether a new action can start now; `busy` also while any presentation owns the shared scope. */
export type GameActionAvailability = 'ready' | 'busy' | 'reconciliation-required' | 'history-full' | 'disposed';
export type GameActionErrorCode = 'disposed' | 'busy' | 'key-conflict' | 'already-completed'
  | 'reconciliation-required' | 'history-full' | 'invalid-input'
  | 'reconciliation-unavailable' | 'invalid-reconciliation';

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

/** Immutable invocation identity; no receipt, token or platform payload is retained. */
type PendingOperation<K extends GameActionKind> = Readonly<{ kind: K; operationId: number; input: Inputs[K] }>;
export type GameActionPendingOperation = PendingOperation<'purchase'> | PendingOperation<'rewarded-ad'>;

/** Structural subset of game-services ProductGrantTransaction, returned by a trusted recovery port. */
export interface GameActionRecoveredGrant {
  readonly playerId: string;
  readonly source: 'purchase' | 'ad_reward';
  readonly grantId: string;
  readonly idempotencyKey: string;
  readonly ledgerEntryId: string;
}

export interface GameActionReconciliationPort {
  /** Must identify the same fixed player as the operation client. Recreate on account change. */
  readonly playerId: string;
  /** Read/recover an authoritative committed ledger grant; never open purchase/ad UI here.
   * Return undefined while no committed grant can be confirmed.
   * Do not await coordinator.reconcile() here: it joins this query and would deadlock. */
  recover(operation: GameActionPendingOperation & { readonly playerId: string }): Promise<{
    readonly operationId: number;
    readonly transaction: GameActionRecoveredGrant;
  } | undefined>;
}

export type GameActionReconciliationResult =
  | Readonly<{ status: 'not-required' }>
  | Readonly<{ status: 'pending'; operation: GameActionPendingOperation }>
  | Readonly<{ status: 'reconciled'; operation: GameActionPendingOperation; ledgerEntryId: string }>;

export interface GameActionCoordinator {
  createPurchaseController(): GameActionController<'purchase'>;
  createRewardedAdController(): GameActionController<'rewarded-ad'>;
  getPendingOperation(): GameActionPendingOperation | undefined;
  /** Trusted journal recovery only. Retire a matching non-grant reward without reopening SDK UI. */
  confirmRecoveredRewardResult(idempotencyKey: string, result: GameServicesRewardedAdResult): boolean;
  /** Concurrent callers join one recovery query; only a matching committed grant unlocks new keys. */
  reconcile(): Promise<GameActionReconciliationResult>;
  getAvailability(): GameActionAvailability;
  /**
   * Hears each change of `getAvailability()`, with no initial delivery: an
   * action starting or settling, and a presentation (an outside purchase
   * included) taking or leaving the shared scope. Ends after `disposed`. The
   * sources are watched only while at least one listener is subscribed.
   */
  subscribeAvailability(listener: UiListener<GameActionAvailability>): () => void;
  /** Terminal for new calls; pending external work still settles and releases its own block. */
  dispose(): void;
}

interface Flight<K extends GameActionKind> {
  readonly id: number;
  readonly key: string;
  readonly promise: Promise<Results[K]>;
  readonly bridge: GameUiBridge<GameActionSnapshot<K>, never, never>;
  settled: boolean;
  start(): void;
}

type AnyFlight = Flight<'purchase'> | Flight<'rewarded-ad'>;
const purchaseSources: Readonly<Record<GameServicesPurchaseInput['source'], true>> = {
  shop: true,
  stage_fail: true,
  result: true,
  event: true,
};

/** A coordinated store's refusal before its provider ran; structural, so this entry imports no commerce code. */
export interface GameActionPurchaseRefusal {
  readonly idempotencyKey: string;
  readonly reason: CoordinatorRefusal;
}
export interface GameActionPurchaseRefusalSource {
  subscribe(listener: (refusal: GameActionPurchaseRefusal) => void): () => void;
}

/**
 * Which coordinator refusal a service result is, exactly, if any: a failed
 * purchase that never launched (no transaction, evidence, verification or
 * ledger entry) whose diagnostic is one of the coordinator's own answers.
 */
function coordinatorRefusalOf(result: GameServicesPurchaseResult): CoordinatorRefusal | undefined {
  const diagnostic = result.purchase.diagnostic;
  if (result.status !== 'failed' || result.purchase.status !== 'failed'
    || result.purchase.transactionId !== undefined || result.purchase.evidence !== undefined
    || result.purchase.authoritativeGrant !== undefined
    || result.verification !== undefined || result.ledgerEntryId !== undefined || diagnostic === undefined) {
    return undefined;
  }
  return matchCoordinatorRefusal({
    code: diagnostic.code,
    retryable: diagnostic.retryable,
    storeCode: diagnostic.providerCode,
  });
}

/** Bind one coordinator to one runtime/client (including its player identity), above all screens. */
export function createGameActionCoordinator(options: {
  readonly execution: GameExecutionController;
  readonly client: Pick<GameServicesOperationClient, 'purchase' | 'claimRewardedAd'>;
  /**
   * The shared full-screen scope: while any presentation owns it (an outside
   * purchase included), the coordinator is `busy` and new actions reject with
   * `busy`. With `actionBlock: 'without-presentation'` (the default) the
   * actions also rely on that scope's leases instead of their own block, so
   * use it only with a client backed by createCoordinatedPlatformGateway
   * sharing this scope/execution.
   */
  readonly presentation?: FullScreenPresentationScope;
  /**
   * When each action holds its own simulation/gameplay-input block from before
   * the service call until its result: only without a `presentation` scope
   * (default), or `always`, for a client whose rewarded ads take no lease.
   */
  readonly actionBlock?: 'without-presentation' | 'always';
  /**
   * The coordinated store's own refusals before its provider ran (the
   * `onRefusal` of createCoordinatedCommerceProvider). When the coordinator
   * refused a running purchase action's store call (`busy`: another purchase
   * took the scope after the action was reserved; `history-full`; `disposed`)
   * and the service answers with exactly that refusal, the action rejects with
   * the same code and keeps its key, as if the preflight had refused it.
   */
  readonly purchaseRefusals?: GameActionPurchaseRefusalSource;
  /** Never evicts keys: once full, new keys are rejected until application teardown. Default 1024. */
  readonly maxRememberedKeys?: number;
  readonly reconciliation?: GameActionReconciliationPort;
  readonly onObserverError?: ObserverErrorHandler;
}): GameActionCoordinator {
  const { execution, client, onObserverError } = options;
  if (options.presentation !== undefined && options.presentation.execution !== execution) {
    throw new TypeError(
      'Action and presentation coordination must share one execution controller.',
    );
  }
  const capacity = options.maxRememberedKeys ?? 1024;
  const actionBlock = options.actionBlock ?? 'without-presentation';
  if (actionBlock !== 'without-presentation' && actionBlock !== 'always') {
    throw new TypeError('actionBlock must be without-presentation or always.');
  }
  const recoveryPlayerId = options.reconciliation?.playerId;
  const recoveryPort = options.reconciliation;
  if (recoveryPort && (typeof recoveryPlayerId !== 'string' || recoveryPlayerId.trim() === '' || typeof recoveryPort.recover !== 'function')) {
    throw new GameActionExecutionError('invalid-input');
  }
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 10000) {
    throw new RangeError('maxRememberedKeys must be an integer from 1 to 10000.');
  }
  const recover = recoveryPort?.recover.bind(recoveryPort);
  const history = new Map<string, string>();
  let current: AnyFlight | undefined;
  let last: AnyFlight | undefined;
  let nextId = 0;
  let disposed = false;
  let unconfirmed: GameActionPendingOperation | undefined;
  const recoveredNonGrants = new Set<string>();
  let recoveryFlight: Promise<GameActionReconciliationResult> | undefined;

  function isDisposed(): boolean {
    return disposed || execution.getSnapshot().status === 'destroyed'
      || options.presentation?.getSnapshot().status === 'disposed';
  }

  function availability(): GameActionAvailability {
    if (isDisposed()) {
      return 'disposed';
    }
    // The same order as the `execute` preflight in `reserve`.
    if (unconfirmed !== undefined) {
      return 'reconciliation-required';
    }
    if (current !== undefined) {
      return 'busy';
    }
    // Any owner of the shared scope, including a purchase started outside these actions.
    if (options.presentation?.getSnapshot().owner !== undefined) {
      return 'busy';
    }
    return history.size >= capacity ? 'history-full' : 'ready';
  }

  // Availability goes out through a UI bridge: on change, in order, also to
  // listeners that reenter, with no initial delivery. `disposed` is the last
  // value; then the sources detach and, once that delivery is done, the bridge
  // and its listeners go. The sources are watched only while someone listens.
  const detachSources: (() => void)[] = [];
  let listening = 0;
  let closed = false;
  function refreshAvailability(): void {
    if (closed) {
      return;
    }
    const next = availability();
    if (next === 'disposed') {
      closed = true;
      detachAvailabilitySources();
    }
    availabilityBridge.setSnapshot(next);
    if (closed) {
      // Delivery is synchronous; a reentrant `disposed` queued behind the
      // current delivery still reaches its listeners before this runs.
      void Promise.resolve().then(() => availabilityBridge.destroy());
    }
  }

  function reserve<K extends GameActionKind>(kind: K, supplied: Inputs[K], canStart: () => boolean): Flight<K> {
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
        || !Object.hasOwn(purchaseSources, source ?? '')))
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
    if (current !== undefined && current.key === key) {
      return current as Flight<K>;
    }
    if (last !== undefined && last.key === key) {
      return last as Flight<K>;
    }
    if (prior !== undefined) {
      throw new GameActionExecutionError('already-completed');
    }
    if (unconfirmed !== undefined) {
      throw new GameActionExecutionError('reconciliation-required');
    }
    if (current !== undefined) {
      throw new GameActionExecutionError('busy');
    }
    if (options.presentation?.getSnapshot().owner !== undefined) {
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
      if (invoked && (status === 'pending' || status === 'exception') && !(kind === 'rewarded-ad' && recoveredNonGrants.has(key))) {
        unconfirmed = Object.freeze({ kind, operationId: id, input }) as GameActionPendingOperation;
      }
      recoveredNonGrants.delete(key);
      current = undefined;
      if (invoked) {
        last = flight as AnyFlight;
      } else {
        history.delete(key);
      }
      // Reentrant release observers can start another operation; only this flight is touched below.
      bridge.setSnapshot(
        invoked
          ? Object.freeze({ kind, status, operationId: id })
          : Object.freeze({ kind, status: 'idle' }),
      );
      observe(() => block?.release(), onObserverError);
      bridge.destroy();
      refreshAvailability();
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
      id, key, promise, bridge, settled: false,
      start(): void {
        if (started) {
          return;
        }
        started = true;
        void (async () => {
          try {
            if (isDisposed() || !canStart()) {
              throw new GameActionExecutionError('disposed');
            }
            if (options.presentation === undefined || actionBlock === 'always') {
              block = execution.acquireBlock({ reason: `action:${kind}`, channels: ['simulation', 'gameplay-input'] });
            }
            if (isDisposed() || !canStart()) {
              throw new GameActionExecutionError('disposed');
            }
            // Another purchase can take the scope between the reservation and
            // this call; the coordinated store then refuses it before its provider runs.
            let refused: CoordinatorRefusal | undefined;
            let stopRefusals: (() => void) | undefined;
            const refusals = kind === 'purchase' ? options.purchaseRefusals : undefined;
            if (refusals !== undefined) {
              // A failing source only loses this recognition, never the purchase.
              observe(() => {
                stopRefusals = refusals.subscribe((refusal) => {
                  if (refusal.idempotencyKey === key && !flight.settled) {
                    refused = refusal.reason;
                  }
                });
              }, onObserverError);
            }
            invoked = true;
            let result: Results[K];
            try {
              result = await (kind === 'purchase'
                ? client.purchase(input as Inputs['purchase'], { onProgress: (value) => observe(() => progress(value as Progress[K]), onObserverError) })
                : client.claimRewardedAd(input as Inputs['rewarded-ad'], { onProgress: (value) => observe(() => progress(value as Progress[K]), onObserverError) })) as Results[K];
            } finally {
              if (stopRefusals !== undefined) {
                observe(stopRefusals, onObserverError);
              }
            }
            if (refused !== undefined && coordinatorRefusalOf(result as GameServicesPurchaseResult) === refused) {
              // Nothing reached the store: answer as the preflight would, and keep the key.
              invoked = false;
              finish('exception');
              reject(new GameActionExecutionError(refused));
              return;
            }
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
    refreshAvailability();
    return flight;
  }

  function reconcile(): Promise<GameActionReconciliationResult> {
    if (isDisposed()) {
      return Promise.reject(new GameActionExecutionError('disposed'));
    }
    if (recoveryFlight) {
      return recoveryFlight;
    }
    const operation = unconfirmed;
    if (!operation) {
      return Promise.resolve(Object.freeze({ status: 'not-required' }));
    }
    if (!recover || recoveryPlayerId === undefined) {
      return Promise.reject(new GameActionExecutionError('reconciliation-unavailable'));
    }
    // Queue invocation until the shared promise is installed, including reentrant port calls.
    const work = Promise.resolve().then(async (): Promise<GameActionReconciliationResult> => {
      if (isDisposed()) {
        throw new GameActionExecutionError('disposed');
      }
      const recovered = await recover(Object.freeze({ ...operation, playerId: recoveryPlayerId }));
      if (isDisposed()) {
        throw new GameActionExecutionError('disposed');
      }
      if (recovered === undefined) {
        return Object.freeze({ status: 'pending', operation });
      }
      const transaction = recovered?.transaction;
      const grantId = operation.kind === 'purchase' ? operation.input.productId : operation.input.placementId;
      const source = operation.kind === 'purchase' ? 'purchase' : 'ad_reward';
      if (!recovered || unconfirmed !== operation || recovered.operationId !== operation.operationId
        || !transaction || transaction.playerId !== recoveryPlayerId || transaction.source !== source
        || transaction.grantId !== grantId || transaction.idempotencyKey !== operation.input.idempotencyKey
        || typeof transaction.ledgerEntryId !== 'string' || transaction.ledgerEntryId.trim() === '') {
        throw new GameActionExecutionError('invalid-reconciliation');
      }
      const result = Object.freeze({ status: 'reconciled' as const, operation, ledgerEntryId: transaction.ledgerEntryId });
      // History and the original promise are retained: recovering never makes the same key executable again.
      unconfirmed = undefined;
      refreshAvailability();
      return result;
    });
    const joined = work.finally(() => {
      if (recoveryFlight === joined) {
        recoveryFlight = undefined;
      }
    });
    void (recoveryFlight = joined);
    return joined;
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
        const flight = reserve(kind, input, () => !ownerDisposed);
        if (trackedId !== flight.id) {
          detach();
          trackedId = flight.id;
          const update = (value: GameActionSnapshot<K>): void => {
            if (trackedId !== flight.id) {
              return;
            }
            snapshot = value;
            if (flight.settled) {
              detach();
              detach = () => {};
            }
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
        flight.start();
        return flight.promise;
      } catch (error) {
        return Promise.reject(error);
      }
    }

    return Object.freeze({
      execute,
      getSnapshot: () => snapshot,
      subscribe(listener: UiListener<GameActionSnapshot<K>>): () => void {
        if (ownerDisposed) {
          throw new GameActionExecutionError('disposed');
        }
        return bridge.subscribeSnapshot(listener);
      },
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
                if (flight.settled) {
                  detachView();
                  detachView = () => {};
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

  const availabilityBridge = createGameUiBridge<GameActionAvailability, never, never>({
    initialSnapshot: availability(),
    ...(onObserverError === undefined ? {} : { onListenerError: onObserverError }),
  });
  closed = availabilityBridge.getSnapshot() === 'disposed';
  function detachAvailabilitySources(): void {
    for (const detach of detachSources.splice(0)) {
      observe(detach, onObserverError);
    }
  }

  return Object.freeze({
    createPurchaseController: () => makeController('purchase'),
    getPendingOperation: () => unconfirmed,
    confirmRecoveredRewardResult(idempotencyKey: string, result: GameServicesRewardedAdResult) {
      if (isDisposed()) { throw new GameActionExecutionError('disposed'); }
      const rejected = result.status === 'rejected' && result.claim?.granted === false && result.claim.disposition === 'rejected';
      const noCandidate = ['failed', 'skipped', 'unavailable'].includes(result.status) && result.reward.status === result.status
        && result.reward.rewardGranted === false && result.reward.evidence === undefined && result.reward.ledgerEntryId === undefined && result.claim === undefined;
      if ((!rejected && !noCandidate) || result.ledgerEntryId !== undefined || result.claim?.ledgerEntryId !== undefined || result.reward.ledgerEntryId !== undefined || result.reward.rewardGranted !== false) { throw new GameActionExecutionError('invalid-reconciliation'); }
      if (unconfirmed?.kind === 'rewarded-ad' && unconfirmed.input.idempotencyKey === idempotencyKey) {
        unconfirmed = undefined;
        refreshAvailability();
        return true;
      }
      if (current !== undefined && current.key === idempotencyKey && current.bridge.getSnapshot().kind === 'rewarded-ad' && !current.settled) {
        recoveredNonGrants.add(idempotencyKey);
        return true;
      }
      return false;
    },
    reconcile,
    createRewardedAdController: () => makeController('rewarded-ad'),
    getAvailability: availability,
    subscribeAvailability(listener: UiListener<GameActionAvailability>): () => void {
      if (closed || isDisposed()) {
        throw new GameActionExecutionError('disposed');
      }
      if (typeof listener !== 'function') {
        throw new TypeError('Availability listener must be a function.');
      }
      if (listening === 0) {
        // Nobody heard the changes since the last listener left: catch up
        // silently before this listener joins.
        availabilityBridge.setSnapshot(availability());
        // Execution tells destruction; the scope tells owners coming and going.
        detachSources.push(execution.subscribe(refreshAvailability));
        if (options.presentation !== undefined) {
          detachSources.push(options.presentation.subscribe(refreshAvailability));
        }
      }
      const unsubscribe = availabilityBridge.subscribeSnapshot(listener);
      listening += 1;
      let active = true;
      return () => {
        if (!active) {
          return;
        }
        active = false;
        unsubscribe();
        listening -= 1;
        if (listening === 0) {
          detachAvailabilitySources();
        }
      };
    },
    dispose(): void {
      disposed = true;
      refreshAvailability();
    },
  });
}

export function createPurchaseActionController(input: { coordinator: GameActionCoordinator }): GameActionController<'purchase'> {
  return input.coordinator.createPurchaseController();
}

export function createRewardedAdActionController(input: { coordinator: GameActionCoordinator }): GameActionController<'rewarded-ad'> {
  return input.coordinator.createRewardedAdController();
}
