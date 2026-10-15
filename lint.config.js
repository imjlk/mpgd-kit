// @ts-check
// @ttsc/lint 0.32.1's TS config loader races on file ownership during Windows
// parallel builds. Node 24 loads this typed source directly without that loader.
export { default } from './tools/config/lint.ts';
