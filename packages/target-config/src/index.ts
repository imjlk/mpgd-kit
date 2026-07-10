import typia from 'typia';

import type { EffectiveTargetConfigMatrix } from './effective.js';
import type { TargetConfigMatrix } from './runtime.js';

export * from './effective.js';
export * from './runtime.js';
export * from './viewport.js';

export const assertEffectiveTargetConfigMatrix =
  typia.createAssert<EffectiveTargetConfigMatrix>();
export const assertTargetConfigMatrix = typia.createAssert<TargetConfigMatrix>();
