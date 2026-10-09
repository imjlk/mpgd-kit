import type { ExecutionBlock, GameExecutionController } from '../index.js';
import { createGameUiBridge, type UiListener } from '../ui/index.js';
import type { ObserverErrorHandler } from '../observers.js';

export type FullScreenPresentationKind = 'purchase' | 'rewarded' | 'interstitial';
export interface FullScreenPresentationOwner {
  readonly kind: FullScreenPresentationKind;
  readonly invocationId: string;
  readonly state: 'requested' | 'open' | 'unknown';
}
export interface FullScreenPresentationSnapshot {
  readonly version: number;
  readonly status: 'ready' | 'busy' | 'unknown' | 'disposed';
  readonly owner?: FullScreenPresentationOwner;
}
export interface FullScreenPresentationLease {
  /** Native facts only. A caller deadline or a backend grant cannot confirm closure. */
  markStarted(): void;
  markUnknown(): void;
  confirmClosed(): void;
}
export interface FullScreenPresentationScope {
  readonly execution: GameExecutionController;
  acquire(input: { readonly kind: FullScreenPresentationKind; readonly invocationId: string; readonly audioStart?: 'requested' | 'started' }): FullScreenPresentationLease;
  getSnapshot(): FullScreenPresentationSnapshot;
  subscribe(listener: UiListener<FullScreenPresentationSnapshot>): () => void;
  /** Stop new presentations and detach projections; retain any live native ownership. */
  dispose(): void;
}

export class PresentationExecutionError extends Error {
  constructor(readonly code: 'busy' | 'disposed' | 'key-conflict' | 'history-full' | 'already-completed') {
    super(`Presentation cannot start: ${code}`);
    this.name = 'PresentationExecutionError';
  }
}

/** Share one scope above all screens, providers, and purchase/ad entrypoints. */
export function createFullScreenPresentationScope(input: {
  readonly execution: GameExecutionController;
  readonly onObserverError?: ObserverErrorHandler;
}): FullScreenPresentationScope {
  let disposed = false;
  let version = 0;
  let owner: { info: FullScreenPresentationOwner; block?: ExecutionBlock; audioBlock?: ExecutionBlock } | undefined;
  let snapshot: FullScreenPresentationSnapshot = Object.freeze({ version, status: 'ready' });
  const bridge = createGameUiBridge<FullScreenPresentationSnapshot, never>({
    initialSnapshot: snapshot,
    ...(input.onObserverError === undefined ? {} : { onListenerError: input.onObserverError }),
  });
  const isDisposed = () => disposed || input.execution.getSnapshot().status === 'destroyed';
  function publish(): void {
    let status: FullScreenPresentationSnapshot['status'] = 'ready';
    if (isDisposed()) {
      status = 'disposed';
    } else if (owner?.info.state === 'unknown') {
      status = 'unknown';
    } else if (owner !== undefined) {
      status = 'busy';
    }
    snapshot = Object.freeze({
      version: ++version,
      status,
      ...(owner === undefined ? {} : { owner: owner.info }),
    });
    if (!disposed) {
      bridge.setSnapshot(snapshot);
    }
  }
  return Object.freeze({
    execution: input.execution,
    acquire(request: Parameters<FullScreenPresentationScope['acquire']>[0]): FullScreenPresentationLease {
      if (isDisposed()) { throw new PresentationExecutionError('disposed'); }
      if (owner !== undefined) { throw new PresentationExecutionError('busy'); }
      const kind = request.kind;
      const invocationId = request.invocationId;
      const audioStart = request.audioStart ?? 'requested';
      if (!['purchase', 'rewarded', 'interstitial'].includes(kind)
        || typeof invocationId !== 'string' || invocationId.trim() === '' || invocationId.length > 512
        || (audioStart !== 'requested' && audioStart !== 'started')) {
        throw new TypeError('Invalid presentation identity.');
      }
      if (isDisposed()) { throw new PresentationExecutionError('disposed'); }
      if (owner !== undefined) { throw new PresentationExecutionError('busy'); }
      const owned: { info: FullScreenPresentationOwner; block?: ExecutionBlock; audioBlock?: ExecutionBlock } = {
        info: Object.freeze({ kind, invocationId, state: 'requested' }),
      };
      // Install ownership before execution listeners can reenter during acquisition.
      owner = owned;
      try {
        owned.block = input.execution.acquireBlock({
          reason: `presentation:${kind}`, channels: audioStart === 'started' ? ['simulation', 'gameplay-input'] : ['simulation', 'gameplay-input', 'audio'],
        });
      } catch (error) {
        if (owner === owned) { owner = undefined; }
        throw error;
      }
      let acquiringAudio = false;
      const ensureAudio = () => {
        if (audioStart !== 'started' || acquiringAudio || owned.audioBlock !== undefined || input.execution.getSnapshot().status === 'destroyed') { return; }
        acquiringAudio = true;
        try {
          const block = input.execution.acquireBlock({ reason: `presentation:${kind}:audio`, channels: ['audio'] });
          if (owner === owned) { owned.audioBlock = block; } else { block.release(); }
        } finally { acquiringAudio = false; }
      };
      publish();
      return Object.freeze({
        markStarted(): void {
          if (owner === owned && owned.info.state !== 'open') {
            const previousInfo = owned.info;
            ensureAudio();
            if (owner !== owned || owned.info !== previousInfo) { return; }
            owned.info = Object.freeze({ ...owned.info, state: 'open' });
            publish();
          }
        },
        markUnknown(): void {
          if (owner === owned && owned.info.state !== 'unknown') {
            const previousInfo = owned.info;
            // Lost native observations quarantine audio as well as execution.
            ensureAudio();
            if (owner !== owned || owned.info !== previousInfo) { return; }
            owned.info = Object.freeze({ ...owned.info, state: 'unknown' });
            publish();
          }
        },
        confirmClosed(): void {
          if (owner !== owned) { return; }
          owner = undefined;
          publish();
          owned.audioBlock?.release();
          owned.block?.release();
        },
      });
    },
    getSnapshot(): FullScreenPresentationSnapshot {
      if (isDisposed() && snapshot.status !== 'disposed') { publish(); }
      return snapshot;
    },
    subscribe: (listener: UiListener<FullScreenPresentationSnapshot>) => bridge.subscribeSnapshot(listener),
    dispose(): void {
      if (disposed) { return; }
      // Publish disposal before detaching view projections, without proving native closure.
      snapshot = Object.freeze({ version: ++version, status: 'disposed', ...(owner === undefined ? {} : { owner: owner.info }) });
      disposed = true;
      bridge.setSnapshot(snapshot);
      bridge.destroy();
    },
  });
}
