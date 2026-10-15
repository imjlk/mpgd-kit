import {
  evidence,
  type ITtscEvidenceGraphConfig,
  type ITtscEvidenceGraphMarkdownReference,
  type ITtscEvidenceRules,
} from '@ttsc/evidence';
import type { ITtscLintConfig } from '@ttsc/lint';

import { ignoredSourceFiles } from './lint.source.config.ts';

// Evidence is run once through docs:evidence, not during every ttsc/ttsx
// invocation in the large prepared-test suite.
const evidenceEnabled = process.env.MPGD_EVIDENCE === '1';
const capabilitySpec = {
  type: 'markdown',
  files: ['docs/specs/platform-capability-snapshots.md'],
  symbol: 'h2',
  noEvidenceExclude: true,
  requireReview: true,
} satisfies ITtscEvidenceGraphMarkdownReference;
const evidenceGraph = {
  claims: [
    {
      name: 'guide documents the published capability conformance API',
      type: 'markdown',
      files: ['docs/guides/platform-capabilities.md'],
      symbol: 'h2',
      reference: {
        type: 'typescript',
        root: '.',
        files: ['packages/platform/src/capability-conformance.ts'],
        symbol: 'function',
        noEvidenceExclude: true,
        requireReview: true,
      },
    },
    {
      name: 'guide explains confirmed capability behavior',
      type: 'markdown',
      files: ['docs/guides/platform-capabilities.md'],
      symbol: 'h2',
      reference: capabilitySpec,
    },
    {
      name: 'platform implementation realizes capability behavior',
      type: 'typescript',
      files: ['packages/platform/src/capability-conformance.ts'],
      symbol: 'function',
      reference: capabilitySpec,
    },
    {
      name: 'platform tests verify capability behavior',
      type: 'typescript',
      files: ['packages/platform/src/capability-conformance.test.ts'],
      symbol: 'function',
      reference: capabilitySpec,
    },
    {
      name: 'typed examples demonstrate capability behavior',
      type: 'typescript',
      files: ['docs/examples/platform-capabilities.ts'],
      symbol: 'function',
      reference: capabilitySpec,
    },
    {
      name: 'each guide applies documentation principles',
      type: 'markdown',
      files: ['docs/guides/platform-capabilities.md'],
      symbol: 'file',
      reference: {
        type: 'markdown',
        files: ['docs/standards/documentation-principles.md'],
        symbol: 'h2',
        checklist: true,
        noEvidenceExclude: true,
        requireReview: true,
      },
    },
  ],
} satisfies ITtscEvidenceGraphConfig;

// Source-scoped rules and formatting live in lint.source.config.ts (see the
// note there on files outside the kit). This root entry carries only the
// global ignores and the project-level evidence rules, which ttsc accepts only
// in an entry without `files`.
export default {
  extends: './lint.source.config.ts',
  ignores: ignoredSourceFiles,
  ...(evidenceEnabled ? {
    plugins: { evidence },
    rules: {
      'evidence/graph': ['error', evidenceGraph],
      'evidence/review': 'error',
    },
  } : {}),
} satisfies ITtscLintConfig<ITtscEvidenceRules>;
