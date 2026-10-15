// @ts-check
// @ttsc/strip 0.32.1 resolves a TS config incorrectly when macOS TMPDIR is a symlink.
// Keep this loader boundary in JS until that case passes without environment overrides.
/** @satisfies {import('@ttsc/strip').ITtscStripConfig} */
export default {
  calls: ['console.log', 'console.debug', 'console.trace'],
  statements: ['debugger'],
};
