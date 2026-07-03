export default {
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
  },
};
