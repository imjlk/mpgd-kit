export interface StarterRunState {
  readonly elapsedMs: number;
  readonly phase: number;
}

export function createStarterRunState(): StarterRunState {
  return {
    elapsedMs: 0,
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
    phase: (elapsedMs % 2400) / 2400,
  };
}
