import { describe, expect, it } from 'vitest';

import { calculateScore, createGameSession, finishStage, recordHit, recordMiss } from './index';

describe('game-core', () => {
  it('keeps scoring deterministic', () => {
    expect(
      calculateScore({
        hits: 10,
        misses: 1,
        elapsedMs: 12_000,
        comboPeak: 4,
      }),
    ).toEqual({
      base: 1000,
      speedBonus: 18_000,
      comboBonus: 100,
      missPenalty: 75,
      total: 19_025,
    });
  });

  it('finishes a cleared stage from immutable session updates', () => {
    let session = createGameSession({
      id: 'test-session',
      seed: 42,
      startedAtMs: 0,
    });

    for (let index = 0; index < 10; index += 1) {
      session = recordHit(session);
    }

    session = recordMiss(session);

    expect(finishStage(session, 20_000).cleared).toBe(true);
  });
});
