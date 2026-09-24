import { evidence } from '@ttsc/evidence';

// Evidence is run once through docs:evidence, not during every ttsc/ttsx
// invocation in the large prepared-test suite.
const evidenceEnabled = process.env.MPGD_EVIDENCE === '1';
const capabilitySpec = {
  type: 'markdown',
  files: ['docs/specs/platform-capability-snapshots.md'],
  symbol: 'h2',
  noEvidenceExclude: true,
  requireReview: true,
};
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
};

export default {
  ...(evidenceEnabled ? { plugins: { evidence } } : {}),
  ignores: ['**/node_modules/**', 'packages/i18n/src/paraglide/**'],
  format: {
    severity: 'error',
    printWidth: 100,
    singleQuote: true,
    trailingComma: 'all',
    semi: true,
    sortImports: {
      order: [
        '<BUILTIN_MODULES>',
        '',
        '<THIRD_PARTY_MODULES>',
        '',
        '^@mpgd/',
        '',
        '^[./]',
      ],
    },
    jsDoc: false,
  },
  rules: {
    'no-var': 'error',
    'prefer-const': 'error',
    eqeqeq: 'error',
    curly: 'error',
    'no-debugger': 'error',
    'no-duplicate-imports': 'error',
    'typescript/no-explicit-any': 'warning',
    'typescript/no-floating-promises': 'error',
    'typescript/no-non-null-assertion': 'warning',
    ...(evidenceEnabled ? {
      'evidence/graph': ['error', evidenceGraph],
      'evidence/review': 'error',
    } : {}),
  },
};
