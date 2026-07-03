export interface ScoreInput {
  readonly hits: number;
  readonly misses: number;
  readonly elapsedMs: number;
  readonly comboPeak: number;
}

export interface ScoreBreakdown {
  readonly base: number;
  readonly speedBonus: number;
  readonly comboBonus: number;
  readonly missPenalty: number;
  readonly total: number;
}

export function calculateScore(input: ScoreInput): ScoreBreakdown {
  const base = input.hits * 100;
  const speedBonus = Math.max(0, 30_000 - input.elapsedMs);
  const comboBonus = input.comboPeak * 25;
  const missPenalty = input.misses * 75;
  const total = Math.max(0, base + speedBonus + comboBonus - missPenalty);

  return {
    base,
    speedBonus,
    comboBonus,
    missPenalty,
    total,
  };
}
