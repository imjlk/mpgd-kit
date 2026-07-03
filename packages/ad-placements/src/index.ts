import typia from 'typia';

import type { LogicalAdPlacementId } from '@mpgd/monetization-contract';

export type AdPlacementTarget = 'android' | 'ios' | 'ait';

export interface FrequencyCap {
  readonly cooldownSeconds: number;
  readonly maxPerSession?: number;
  readonly minStageInterval?: number;
}

export interface AdReward {
  readonly type: 'continue' | 'currency';
  readonly amount: number;
  readonly currency?: 'coin' | 'gem';
}

export interface AdPlacementEntry {
  readonly id: LogicalAdPlacementId;
  readonly type: 'rewarded' | 'interstitial';
  readonly reward?: AdReward;
  readonly frequencyCap: FrequencyCap;
  readonly platformPlacementIds: Partial<Record<AdPlacementTarget, string>>;
}

export interface AdPlacements {
  readonly version: string;
  readonly placements: readonly AdPlacementEntry[];
}

export const assertAdPlacements = typia.createAssert<AdPlacements>();
