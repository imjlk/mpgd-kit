// @ts-check
// @ttsc/strip 0.32.1 resolved a TS config incorrectly when macOS TMPDIR is a symlink.
// Re-measured on 0.37.2: a strip.config.ts still fails to load there (the loader
// looks for the config under the temporary directory's /private root), so keep this
// loader boundary in JS until a TS config loads without environment overrides.
/** @satisfies {import('@ttsc/strip').ITtscStripConfig} */
export default {
  calls: ['console.log', 'console.debug', 'console.trace'],
  statements: ['debugger'],
};
