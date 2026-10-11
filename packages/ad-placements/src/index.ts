import typia, { type tags } from 'typia';

import type { LogicalAdPlacementId } from '@mpgd/platform';

export type AdPlacementTarget = 'android' | 'ios' | 'ait';

export interface FrequencyCap {
  readonly cooldownSeconds: number;
  readonly maxPerSession?: number;
  readonly minStageInterval?: number;
}

export interface AdReward {
  readonly type: 'continue' | 'currency';
  readonly amount: number;
  /** A currency the product catalog declares; checked by `validate:ads`. */
  readonly currency?: string & tags.MinLength<1>;
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
