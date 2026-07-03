import typia from 'typia';

import type { TargetConfigMatrix } from './runtime';

export * from './runtime';

export const assertTargetConfigMatrix = typia.createAssert<TargetConfigMatrix>();
