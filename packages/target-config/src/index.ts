import typia from 'typia';

import type { EffectiveTargetConfigMatrix } from './effective';
import type { TargetConfigMatrix } from './runtime';

export * from './effective';
export * from './runtime';
export * from './viewport';

export const assertEffectiveTargetConfigMatrix =
  typia.createAssert<EffectiveTargetConfigMatrix>();
export const assertTargetConfigMatrix = typia.createAssert<TargetConfigMatrix>();
