import { observe, type ObserverErrorHandler } from './observers.js';

export type { ObserverErrorHandler } from './observers.js';

export type ExecutionChannel = 'simulation' | 'gameplay-input' | 'rendering' | 'audio';

export interface ExecutionBlockInput {
  readonly reason: string;
  readonly channels: readonly ExecutionChannel[];
}

export interface ExecutionBlockInfo extends ExecutionBlockInput {
  /** Diagnostic identifier, local to this controller. It cannot release a block. */
  readonly id: number;
}

export interface ExecutionBlock {
  readonly info: ExecutionBlockInfo;
  release(): void;
}

export interface GameExecutionSnapshot {
  readonly status: 'active' | 'destroyed';
  readonly version: number;
  /** True means blocked. Destroyed snapshots fail closed on every channel. */
  readonly blocked: Readonly<Record<ExecutionChannel, boolean>>;
  readonly blocks: readonly ExecutionBlockInfo[];
}

export type ExecutionListener = (snapshot: GameExecutionSnapshot) => void | Promise<void>;

export interface GameExecutionController {
  acquireBlock(input: ExecutionBlockInput): ExecutionBlock;
  getSnapshot(): GameExecutionSnapshot;
  /** Does not deliver the initial snapshot. Read it explicitly after subscribing. */
  subscribe(listener: ExecutionListener): () => void;
  destroy(): void;
}

interface Subscription {
  readonly listener: ExecutionListener;
  active: boolean;
}

const channels: readonly ExecutionChannel[] = [
  'simulation',
  'gameplay-input',
  'rendering',
  'audio',
];

export function createGameExecutionController(
  options: { readonly onListenerError?: ObserverErrorHandler } = {},
): GameExecutionController {
  const onError = options.onListenerError;
  const blocks = new Map<number, ExecutionBlockInfo>();
  const subscriptions = new Set<Subscription>();
  const queue: { snapshot: GameExecutionSnapshot; recipients: Subscription[] }[] = [];
  let nextId = 0;
  let destroyed = false;
  let delivering = false;
  let snapshot = makeSnapshot(0);

  function assertActive(): void {
    if (destroyed) {
      throw new Error('Game execution controller is destroyed.');
    }
  }

  function makeSnapshot(version: number): GameExecutionSnapshot {
    const blocked: Record<ExecutionChannel, boolean> = {
      simulation: destroyed,
      'gameplay-input': destroyed,
      rendering: destroyed,
      audio: destroyed,
    };
    for (const block of blocks.values()) {
      for (const channel of block.channels) {
        blocked[channel] = true;
      }
    }
    return Object.freeze({
      status: destroyed ? 'destroyed' : 'active',
      version,
      blocked: Object.freeze(blocked),
      blocks: Object.freeze([...blocks.values()]),
    });
  }

  function publish(): void {
    snapshot = makeSnapshot(snapshot.version + 1);
    queue.push({ snapshot, recipients: [...subscriptions] });
    if (delivering) {
      return;
    }
    delivering = true;
    try {
      for (let cursor = 0; cursor < queue.length; cursor += 1) {
        const delivery = queue[cursor];
        if (delivery === undefined) {
          continue;
        }
        for (const subscription of delivery.recipients) {
          // Destruction supersedes all queued active deliveries, including this round.
          if (subscription.active && (!destroyed || delivery.snapshot.status === 'destroyed')) {
            observe(() => subscription.listener(delivery.snapshot), onError);
          }
        }
      }
    } finally {
      queue.length = 0;
      delivering = false;
      if (destroyed) {
        subscriptions.clear();
      }
    }
  }

  return Object.freeze({
    acquireBlock(input: ExecutionBlockInput): ExecutionBlock {
      assertActive();
      // Copy and validate all caller-controlled data before mutating state.
      const reason = input.reason;
      const requested = input.channels;
      if (typeof reason !== 'string' || reason.trim().length === 0) {
        throw new TypeError('Block reason must be a non-empty string.');
      }
      if (!Array.isArray(requested) || requested.length === 0) {
        throw new TypeError('At least one execution channel is required.');
      }
      const selected = [...new Set(requested)];
      if (selected.some((channel) => !channels.includes(channel))) {
        throw new TypeError('Unknown execution channel.');
      }
      // Input getters/iterators may have reentered the controller.
      assertActive();
      const info: ExecutionBlockInfo = Object.freeze({
        id: ++nextId,
        reason,
        channels: Object.freeze(selected),
      });
      blocks.set(info.id, info);
      const token: ExecutionBlock = Object.freeze({
        info,
        release(): void {
          if (!destroyed && blocks.delete(info.id)) {
            publish();
          }
        },
      });
      publish();
      return token;
    },
    getSnapshot: () => snapshot,
    subscribe(listener: ExecutionListener): () => void {
      assertActive();
      if (typeof listener !== 'function') {
        throw new TypeError('Execution listener must be a function.');
      }
      const subscription: Subscription = { listener, active: true };
      subscriptions.add(subscription);
      return () => {
        subscription.active = false;
        subscriptions.delete(subscription);
      };
    },
    destroy(): void {
      if (destroyed) {
        return;
      }
      destroyed = true;
      blocks.clear();
      publish();
    },
  });
}
