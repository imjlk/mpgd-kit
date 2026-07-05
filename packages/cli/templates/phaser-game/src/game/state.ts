const scoreIntervalMs = 100;
const phasePeriodMs = 2400;

export interface StarterRunState {
  readonly elapsedMs: number;
  readonly score: number;
  readonly phase: number;
}

export function createStarterRunState(): StarterRunState {
  return {
    elapsedMs: 0,
    score: 0,
    phase: 0,
  };
}

export function stepStarterRunState(
  state: StarterRunState,
  deltaMs: number,
): StarterRunState {
  const elapsedMs = state.elapsedMs + deltaMs;

  return {
    elapsedMs,
    score: Math.floor(elapsedMs / scoreIntervalMs),
    phase: (elapsedMs % phasePeriodMs) / phasePeriodMs,
  };
}
