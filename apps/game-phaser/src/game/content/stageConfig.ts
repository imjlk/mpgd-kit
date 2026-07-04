import type { GameImageAssetKey } from '../assets/manifest';

export interface StageBounds {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
}

export interface StageScaleRange {
  readonly min: number;
  readonly max: number;
}

export interface StageCompletionConfig {
  readonly hitGoal: number;
  readonly maxMisses: number;
}

export interface StageConfig {
  readonly id: string;
  readonly title: string;
  readonly durationMs: number;
  readonly targetImage: GameImageAssetKey;
  readonly targetBounds: StageBounds;
  readonly targetScale: StageScaleRange;
  readonly completion: StageCompletionConfig;
}

export const quickstartStage = {
  id: 'orb-quickstart',
  title: 'Hit the orb',
  durationMs: 15_000,
  targetImage: 'orb',
  targetBounds: {
    minX: 140,
    maxX: 820,
    minY: 150,
    maxY: 460,
  },
  targetScale: {
    min: 0.55,
    max: 0.9,
  },
  completion: {
    hitGoal: 10,
    maxMisses: 5,
  },
} as const satisfies StageConfig;
