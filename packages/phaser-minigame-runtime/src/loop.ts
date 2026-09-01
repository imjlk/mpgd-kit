import type { MiniGameHost } from './host.js';

export type MiniGameFrameErrorHandler = (error: unknown) => void;

interface ScheduledFrame {
  readonly nativeId?: number;
}

export class MiniGameAnimationFrameScheduler {
  readonly #host: MiniGameHost;
  readonly #onError: MiniGameFrameErrorHandler;
  readonly #scheduled = new Map<number, ScheduledFrame>();
  #nextId = 1;
  #disposed = false;

  constructor(host: MiniGameHost, onError: MiniGameFrameErrorHandler = reportFrameError) {
    this.#host = host;
    this.#onError = onError;
  }

  request(callback: (time: number) => void): number {
    if (this.#disposed) {
      return 0;
    }

    const id = this.#nextId++;
    this.#scheduled.set(id, {});

    try {
      const nativeId = this.#host.requestAnimationFrame((time) => {
        if (!this.#scheduled.delete(id) || this.#disposed) {
          return;
        }

        try {
          callback(time);
        } catch (error) {
          this.#reportError(error);
        }
      });

      if (nativeId !== undefined && this.#scheduled.has(id)) {
        this.#scheduled.set(id, { nativeId });
      }
    } catch (error) {
      this.#scheduled.delete(id);
      throw error;
    }

    return id;
  }

  cancel(id: number): void {
    const frame = this.#scheduled.get(id);

    if (frame === undefined) {
      return;
    }

    this.#scheduled.delete(id);

    if (frame.nativeId !== undefined) {
      try {
        this.#host.cancelAnimationFrame?.(frame.nativeId);
      } catch (error) {
        this.#reportError(error);
      }
    }
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }

    this.#disposed = true;

    for (const [id] of this.#scheduled) {
      this.cancel(id);
    }
  }

  #reportError(error: unknown): void {
    try {
      this.#onError(error);
    } catch (reporterError) {
      try {
        console.error('Mini-game animation frame error reporter failed.', reporterError);
      } catch {
        // Scheduler cleanup and future frames must not depend on host logging.
      }
    }
  }
}

function reportFrameError(error: unknown): void {
  console.error('Mini-game animation frame failed; the scheduler remains active.', error);
}
