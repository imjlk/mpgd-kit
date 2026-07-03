export interface SeededRng {
  readonly seed: number;
  next(): number;
  nextInt(maxExclusive: number): number;
}

export function createSeededRng(seed: number): SeededRng {
  let state = seed >>> 0;

  return {
    seed,
    next() {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 0x100000000;
    },
    nextInt(maxExclusive: number) {
      if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
        throw new RangeError('maxExclusive must be a positive integer.');
      }

      return Math.floor(this.next() * maxExclusive);
    },
  };
}
