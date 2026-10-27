// @ts-check
// @ttsc/strip 0.32.1 resolved a TS config incorrectly when macOS TMPDIR is a symlink.
// A minimal case passes on 0.34.2, but the generated-template cases have not been
// re-measured on 0.34.2; keep this loader boundary in JS until they pass without
// environment overrides.
/** @satisfies {import('@ttsc/strip').ITtscStripConfig} */
export default {
  calls: ['console.log', 'console.debug', 'console.trace'],
  statements: ['debugger'],
};
