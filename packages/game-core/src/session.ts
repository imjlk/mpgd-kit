import { calculateScore, type ScoreBreakdown } from './scoring';

export interface GameSession {
  readonly id: string;
  readonly seed: number;
  readonly startedAtMs: number;
  readonly stage: number;
  readonly hits: number;
  readonly misses: number;
  readonly combo: number;
  readonly comboPeak: number;
}

export interface FinishedStage {
  readonly session: GameSession;
  readonly score: ScoreBreakdown;
  readonly cleared: boolean;
}

export interface FinishStageOptions {
  readonly hitGoal?: number;
  readonly maxMisses?: number;
}

export function createGameSession(input: {
  readonly id: string;
  readonly seed: number;
  readonly startedAtMs: number;
  readonly stage?: number;
}): GameSession {
  return {
    id: input.id,
    seed: input.seed,
    startedAtMs: input.startedAtMs,
    stage: input.stage ?? 1,
    hits: 0,
    misses: 0,
    combo: 0,
    comboPeak: 0,
  };
}

export function recordHit(session: GameSession): GameSession {
  const combo = session.combo + 1;

  return {
    ...session,
    hits: session.hits + 1,
    combo,
    comboPeak: Math.max(session.comboPeak, combo),
  };
}

export function recordMiss(session: GameSession): GameSession {
  return {
    ...session,
    misses: session.misses + 1,
    combo: 0,
  };
}

export function finishStage(
  session: GameSession,
  finishedAtMs: number,
  options: FinishStageOptions = {},
): FinishedStage {
  const hitGoal = options.hitGoal ?? 10;
  const maxMisses = options.maxMisses ?? 5;
  const score = calculateScore({
    hits: session.hits,
    misses: session.misses,
    elapsedMs: Math.max(0, finishedAtMs - session.startedAtMs),
    comboPeak: session.comboPeak,
  });

  return {
    session,
    score,
    cleared: session.hits >= hitGoal && session.misses <= maxMisses,
  };
}
