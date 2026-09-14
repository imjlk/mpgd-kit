/** FIFO, abortable weighted permits. Reservations are made before allocating payloads. */
export function createPackBudget(limit: number): {
  acquire(weight: number, signal: AbortSignal): Promise<() => void>;
} {
  let used = 0;
  const queue: {
    weight: number;
    signal: AbortSignal;
    resolve: (release: () => void) => void;
    reject: (error: unknown) => void;
    cancel: () => void;
  }[] = [];
  const drain = (): void => {
    while (queue.length) {
      const next = queue[0]!;
      if (used + next.weight > limit) {
        return;
      }
      queue.shift();
      next.signal.removeEventListener('abort', next.cancel);
      used += next.weight;
      let released = false;
      next.resolve(() => {
        if (!released) {
          released = true;
          used -= next.weight;
          drain();
        }
      });
    }
  };
  return {
    async acquire(weight, signal) {
      signal.throwIfAborted();
      if (!Number.isSafeInteger(weight) || weight <= 0 || weight > limit) {
        throw new Error('Asset reservation exceeds buffered byte limit');
      }
      return new Promise((resolve, reject) => {
        const entry = {
          weight, signal, resolve, reject, cancel: () => {
            const index = queue.indexOf(entry);
            if (index !== -1) {
              queue.splice(index, 1);
              reject(signal.reason);
              drain();
            }
          },
        };
        queue.push(entry);
        signal.addEventListener('abort', entry.cancel, {
          once: true,
        });
        drain();
      });
    },
  };
}
