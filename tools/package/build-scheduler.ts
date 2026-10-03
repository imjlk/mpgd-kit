export interface ScheduledTask {
  readonly name: string;
  /** Names that must finish first; names outside the scheduled set are ignored. */
  readonly dependencies: readonly string[];
}

/**
 * Runs `run` for every task once all of its scheduled dependencies have
 * finished, keeping at most `concurrency` tasks in flight. Ready tasks start in
 * input order. After a failure no further task starts, and the first error is
 * rethrown once the tasks already running have settled.
 */
export function runInDependencyOrder<T extends ScheduledTask>(
  tasks: readonly T[],
  concurrency: number,
  run: (task: T) => Promise<void>,
): Promise<void> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`Task concurrency must be a positive integer: ${concurrency}`);
  }

  const scheduled = new Set(tasks.map((task) => task.name));
  const pending = new Map(tasks.map((task) => [task.name, task]));
  const finished = new Set<string>();
  let running = 0;
  let failure: { readonly error: unknown } | undefined;

  return new Promise((resolve, reject) => {
    startReadyTasks();

    function startReadyTasks(): void {
      for (const task of failure === undefined ? pending.values() : []) {
        if (running >= concurrency) {
          break;
        }
        if (!task.dependencies.every((name) => !scheduled.has(name) || finished.has(name))) {
          continue;
        }

        pending.delete(task.name);
        running += 1;
        run(task).then(
          () => {
            finished.add(task.name);
          },
          (error: unknown) => {
            failure ??= { error };
          },
        ).finally(() => {
          running -= 1;
          startReadyTasks();
        });
      }

      if (running > 0) {
        return;
      }
      if (failure !== undefined) {
        reject(failure.error);
      } else if (pending.size > 0) {
        reject(new Error(`Circular task dependency: ${[...pending.keys()].join(', ')}`));
      } else {
        resolve();
      }
    }
  });
}
