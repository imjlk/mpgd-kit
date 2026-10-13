/** Default tap thresholds: movement beyond 10 CSS px or a press longer than 600 ms is not a tap. */
export const defaultTapThreshold = { maxDistancePx: 10, maxDurationMs: 600 } as const;

export interface TapThreshold {
  readonly maxDistancePx: number;
  readonly maxDurationMs: number;
}

export interface TapPoint {
  readonly x: number;
  readonly y: number;
  readonly time: number;
}

/**
 * Pure tap recognizer. Feed pointer down/move/up; `up` returns true only when the
 * gesture stayed within the distance and duration budget, so a feed scroll or a
 * long press never becomes a game tap.
 */
export class TapRecognizer {
  readonly #threshold: TapThreshold;
  readonly #active = new Map<number, { start: TapPoint; cancelled: boolean }>();

  constructor(threshold: TapThreshold = defaultTapThreshold) {
    this.#threshold = threshold;
  }

  down(pointerId: number, point: TapPoint): void {
    this.#active.set(pointerId, { start: point, cancelled: false });
  }

  move(pointerId: number, point: TapPoint): void {
    const entry = this.#active.get(pointerId);
    if (entry !== undefined && this.#exceedsDistance(entry.start, point)) {
      entry.cancelled = true;
    }
  }

  cancel(pointerId: number): void {
    this.#active.delete(pointerId);
  }

  up(pointerId: number, point: TapPoint): boolean {
    const entry = this.#active.get(pointerId);
    this.#active.delete(pointerId);
    if (entry === undefined || entry.cancelled) {
      return false;
    }
    return !this.#exceedsDistance(entry.start, point)
      && point.time - entry.start.time <= this.#threshold.maxDurationMs;
  }

  #exceedsDistance(a: TapPoint, b: TapPoint): boolean {
    return Math.hypot(b.x - a.x, b.y - a.y) > this.#threshold.maxDistancePx;
  }
}
