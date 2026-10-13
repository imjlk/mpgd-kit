export interface FrameScheduler {
  request(callback: (time: number) => void): number;
  cancel(handle: number): void;
}

export interface FrameLoopOptions {
  /** Return true while the frame needs another tick (animation, physics). */
  readonly tick: (deltaMs: number, time: number) => boolean;
  readonly scheduler?: FrameScheduler;
}

export interface FrameLoop {
  /** Wake the loop; it keeps running until `tick` reports idle. */
  wake(): void;
  readonly running: boolean;
  dispose(): void;
}

/** Demand-driven frame loop: sleeps when idle so an inline post costs ~0% CPU. */
export function createFrameLoop(options: FrameLoopOptions): FrameLoop {
  const scheduler = options.scheduler ?? {
    request: (callback: (time: number) => void) => globalThis.requestAnimationFrame(callback),
    cancel: (handle: number) => globalThis.cancelAnimationFrame(handle),
  };
  let handle: number | undefined;
  let last: number | undefined;
  let disposed = false;

  const step = (time: number): void => {
    handle = undefined;
    const delta = last === undefined ? 0 : Math.min(time - last, 100);
    last = time;
    if (!disposed && options.tick(delta, time)) {
      handle = scheduler.request(step);
    } else {
      last = undefined;
    }
  };

  return {
    wake() {
      if (!disposed && handle === undefined) {
        handle = scheduler.request(step);
      }
    },
    get running() {
      return handle !== undefined;
    },
    dispose() {
      disposed = true;
      if (handle !== undefined) {
        scheduler.cancel(handle);
        handle = undefined;
      }
    },
  };
}
