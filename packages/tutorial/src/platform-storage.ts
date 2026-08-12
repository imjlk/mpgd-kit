import type { StorageAdapter } from '@mpgd/platform';

import type { TutorialDefinition } from './definition.js';
import {
  parseTutorialProgress,
  type TutorialProgressOf,
  type TutorialProgressStore,
} from './progress.js';

export const defaultTutorialStorageLoadTimeoutMs = 10_000;

export interface CreatePlatformTutorialProgressStoreInput<TDefinition extends TutorialDefinition> {
  readonly definition: TDefinition;
  readonly invalidRecord?: 'disable' | 'ignore';
  readonly key: string;
  readonly migrate?: (value: unknown) => unknown;
  readonly onError?: (error: unknown) => void;
  readonly storage: Pick<StorageAdapter, 'load' | 'save'>;
  readonly loadTimeoutMs?: number;
}

export async function createPlatformTutorialProgressStore<
  TDefinition extends TutorialDefinition,
>(
  input: CreatePlatformTutorialProgressStoreInput<TDefinition>,
): Promise<TutorialProgressStore<TutorialProgressOf<TDefinition>>> {
  const loadTimeoutMs = resolveLoadTimeoutMs(input.loadTimeoutMs);
  let current: TutorialProgressOf<TDefinition> | null = null;
  let available = true;
  let queue = Promise.resolve();

  try {
    const stored = await loadWithTimeout(input.storage.load({ key: input.key }), loadTimeoutMs);

    if (stored !== null) {
      const migrated = input.migrate === undefined ? stored.value : input.migrate(stored.value);
      current = parseTutorialProgress(input.definition, migrated);

      if (current === null && (input.invalidRecord ?? 'disable') === 'disable') {
        available = false;
        input.onError?.(new Error(`Invalid tutorial progress: ${input.key}`));
      }
    }
  } catch (error) {
    available = false;
    input.onError?.(error);
  }

  return {
    get available() {
      return available;
    },
    async flush() {
      await queue;
    },
    getSnapshot: () => current,
    save(progress) {
      if (!available) {
        return Promise.resolve();
      }

      const operation = queue.then(async () => {
        if (!available) {
          return;
        }

        await input.storage.save({ key: input.key, value: progress });
        current = progress;
      });

      void (queue = operation.catch((error: unknown) => {
        available = false;
        input.onError?.(error);
      }));
      return operation;
    },
  };
}

function resolveLoadTimeoutMs(timeoutMs: number | undefined): number {
  const resolved = timeoutMs ?? defaultTutorialStorageLoadTimeoutMs;

  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new TypeError('Tutorial storage loadTimeoutMs must be a positive finite number.');
  }

  return resolved;
}

async function loadWithTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined;

  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = globalThis.setTimeout(() => {
          reject(new Error(`Tutorial storage load timed out after ${timeoutMs}ms.`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      globalThis.clearTimeout(timer);
    }
  }
}
