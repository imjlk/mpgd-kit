import typia from 'typia';

import type { PolicyMatrix } from './runtime';

export * from './runtime';

export const assertPolicyMatrix = typia.createAssert<PolicyMatrix>();
