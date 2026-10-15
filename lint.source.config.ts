import type { ITtscLintConfig } from '@ttsc/lint';

// Per-file lint and format settings for kit sources.
//
// `files` scopes this entry to files under the kit checkout. ttsc compares a
// file's real path against the config directory before matching `files` or
// `ignores`, and a file outside it never matches either list. A plain
// `ignores: ['**/node_modules/**']` therefore cannot exclude a dependency that
// resolves outside the kit, which happens in `--workspace` games: pnpm links
// kit packages' dependencies from `../<game>/node_modules`, and packages that
// ship raw `.ts` sources (for example @webview-bridge/types) were linted and
// failed `build:devvit` / `build:ait`. With `files` set, such files are out of
// scope, so neither rules nor formatting apply to them.
export const lintedSourceFiles = ['**/*'];
export const ignoredSourceFiles = ['**/node_modules/**', 'packages/i18n/src/paraglide/**'];

export default {
  files: lintedSourceFiles,
  ignores: ignoredSourceFiles,
  format: {
    severity: 'error',
    printWidth: 100,
    singleQuote: true,
    trailingComma: 'all',
    semi: true,
    sortImports: {
      order: ['<BUILTIN_MODULES>', '', '<THIRD_PARTY_MODULES>', '', '^@mpgd/', '', '^[./]'],
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
  },
} satisfies ITtscLintConfig;
