// Re-export the packaged worker entry as an application-deployed worker
// module. Bundlers treat this file as the worker entry referenced by
// `new Worker(new URL('./archive-decode-worker.ts', import.meta.url))`.
import '@mpgd/phaser-assets/archive-worker';
