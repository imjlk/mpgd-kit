import type { ITtscEvidenceRules } from '@ttsc/evidence';
import type { ITtscLintConfig } from '@ttsc/lint';
import type { ITtscStripConfig } from '@ttsc/strip';

// These deliberate errors must stay errors when the toolchain is upgraded.
export const invalidLint = {
  // @ts-expect-error Rule severities are checked, not widened to strings.
  rules: { 'no-var': 'fatal' },
} satisfies ITtscLintConfig;

export const invalidEvidence = {
  rules: {
    // @ts-expect-error The Evidence graph option has an exact claim-array type.
    'evidence/graph': ['error', { claims: 'unchecked configuration' }],
  },
} satisfies ITtscLintConfig<ITtscEvidenceRules>;

export const invalidStrip = {
  // @ts-expect-error Call patterns must be strings.
  calls: [123],
} satisfies ITtscStripConfig;
