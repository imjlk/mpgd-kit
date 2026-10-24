import type { JavaScriptEntry } from './javascript-policy.js';

// Exact paths: legacy backlog cannot admit newly authored JavaScript.
export const javascriptInventory = [
  {
    file: 'tools/smoke/published-starter-consumer.mjs',
    disposition: 'runtime-exception',
    reason: 'Public npm consumer runs without repository dependencies, compiler hooks or workspace aliases; checked by the bootstrap JS project.',
  },
  {
    file: 'tools/workspace/kit-dependency-links.mjs',
    disposition: 'runtime-exception',
    reason: 'Dependency ownership inspection must run before broken compiler dependency links are repaired; checked by the bootstrap JS project.',
  },
  {
    file: 'tools/workspace/relink-kit-workspace.mjs',
    disposition: 'runtime-exception',
    reason: 'Dependency repair cannot require the compiler whose installation it repairs; checked by the bootstrap JS project.',
  },
  {
    file: 'adapters/capacitor/test/native-http-runtime.mjs',
    disposition: 'migration-backlog',
    reason: 'Existing JavaScript orchestration or test awaiting a typed migration; this is not a runtime exception.',
  },
  {
    file: 'adapters/capacitor/test/package-import.mjs',
    disposition: 'runtime-exception',
    reason: 'Plain Node consumer verifies shipped JavaScript without TypeScript loaders or workspace source aliases.',
  },
  {
    file: 'adapters/capacitor/test/packed-runtime.mjs',
    disposition: 'runtime-exception',
    reason: 'Plain Node consumer verifies shipped JavaScript without TypeScript loaders or workspace source aliases.',
  },
  {
    file: 'adapters/devvit/test/payments-dist-import.mjs',
    disposition: 'runtime-exception',
    reason: 'Plain Node consumer verifies shipped JavaScript without TypeScript loaders or workspace source aliases.',
  },
  {
    file: 'adapters/devvit/test/server-dist-import.mjs',
    disposition: 'runtime-exception',
    reason: 'Plain Node consumer verifies shipped JavaScript without TypeScript loaders or workspace source aliases.',
  },
  {
    file: 'adapters/devvit/test/web-dist-import.mjs',
    disposition: 'runtime-exception',
    reason: 'Plain Node consumer verifies shipped JavaScript without TypeScript loaders or workspace source aliases.',
  },
  {
    file: 'adapters/verse8/test/agent8-dist-import.mjs',
    disposition: 'runtime-exception',
    reason: 'Plain Node consumer verifies shipped JavaScript without TypeScript loaders or workspace source aliases.',
  },
  {
    file: 'adapters/verse8/test/server-dist-import.mjs',
    disposition: 'runtime-exception',
    reason: 'Plain Node consumer verifies shipped JavaScript without TypeScript loaders or workspace source aliases.',
  },
  {
    file: 'adapters/wechat/test/dist-import.mjs',
    disposition: 'runtime-exception',
    reason: 'Plain Node consumer verifies shipped JavaScript without TypeScript loaders or workspace source aliases.',
  },
  {
    file: 'apps/target-deploy-tooling-compat/test/compat.test.mjs',
    disposition: 'migration-backlog',
    reason: 'Existing JavaScript orchestration or test awaiting a typed migration; this is not a runtime exception.',
  },
  {
    file: 'examples/asset-packs/test/artifacts.mjs',
    disposition: 'migration-backlog',
    reason: 'Existing JavaScript orchestration or test awaiting a typed migration; this is not a runtime exception.',
  },
  {
    file: 'examples/asset-packs/test/browser.mjs',
    disposition: 'migration-backlog',
    reason: 'Existing JavaScript orchestration or test awaiting a typed migration; this is not a runtime exception.',
  },
  {
    file: 'examples/asset-packs/test/measure.mjs',
    disposition: 'migration-backlog',
    reason: 'Existing JavaScript orchestration or test awaiting a typed migration; this is not a runtime exception.',
  },
  {
    file: 'examples/asset-packs/test/packed-consumer.mjs',
    disposition: 'runtime-exception',
    reason: 'Plain Node consumer verifies shipped JavaScript without TypeScript loaders or workspace source aliases.',
  },
  {
    file: 'examples/asset-packs/test/static-server.mjs',
    disposition: 'migration-backlog',
    reason: 'Existing JavaScript orchestration or test awaiting a typed migration; this is not a runtime exception.',
  },
  {
    file: 'examples/runtime-controls/test/actions.mjs',
    disposition: 'migration-backlog',
    reason: 'Existing JavaScript orchestration or test awaiting a typed migration; this is not a runtime exception.',
  },
  {
    file: 'examples/runtime-controls/test/browser.mjs',
    disposition: 'migration-backlog',
    reason: 'Existing JavaScript orchestration or test awaiting a typed migration; this is not a runtime exception.',
  },
  {
    file: 'packages/analytics/test/dist-import.mjs',
    disposition: 'runtime-exception',
    reason: 'Plain Node consumer verifies shipped analytics exports without TypeScript loaders or source aliases masking ESM resolution failures.',
  },
  {
    file: 'packages/bridge/test/index-dist-import.mjs',
    disposition: 'runtime-exception',
    reason: 'Plain Node consumer verifies shipped JavaScript without TypeScript loaders or workspace source aliases.',
  },
  {
    file: 'packages/bridge/test/orpc-node-dist-import.mjs',
    disposition: 'runtime-exception',
    reason: 'Plain Node consumer verifies shipped JavaScript without TypeScript loaders or workspace source aliases.',
  },
  {
    file: 'packages/game-runtime/test/dist-import.mjs',
    disposition: 'runtime-exception',
    reason: 'Plain Node consumer verifies shipped JavaScript without TypeScript loaders or workspace source aliases.',
  },
  {
    file: 'packages/game-runtime/test/package-import.mjs',
    disposition: 'runtime-exception',
    reason: 'Plain Node consumer verifies shipped JavaScript without TypeScript loaders or workspace source aliases.',
  },
  {
    file: 'packages/game-runtime/test/phaser-dist-import.mjs',
    disposition: 'runtime-exception',
    reason: 'Plain Node consumer verifies shipped JavaScript without TypeScript loaders or workspace source aliases.',
  },
  {
    file: 'packages/game-services/test/operation-progress-import.mjs',
    disposition: 'migration-backlog',
    reason: 'Existing JavaScript orchestration or test awaiting a typed migration; this is not a runtime exception.',
  },
  {
    file: 'packages/game-services/test/reward-evidence-import.mjs',
    disposition: 'migration-backlog',
    reason: 'Existing JavaScript orchestration or test awaiting a typed migration; this is not a runtime exception.',
  },
  {
    file: 'packages/game-services/test/runtime-transport-package-import.mjs',
    disposition: 'runtime-exception',
    reason: 'Plain Node consumer verifies shipped JavaScript without TypeScript loaders or workspace source aliases.',
  },
  {
    file: 'packages/game-services/test/runtime-transport-packed-runtime.mjs',
    disposition: 'runtime-exception',
    reason: 'Plain Node consumer verifies shipped JavaScript without TypeScript loaders or workspace source aliases.',
  },
  {
    file: 'packages/i18n/src/paraglideAdapter.js',
    disposition: 'migration-backlog',
    reason: 'Existing JavaScript orchestration or test awaiting a typed migration; this is not a runtime exception.',
  },
  {
    file: 'packages/lite-shell/test/dist-import.mjs',
    disposition: 'runtime-exception',
    reason: 'Plain Node consumer verifies shipped JavaScript without TypeScript loaders or workspace source aliases.',
  },
  {
    file: 'packages/phaser-assets/test/resolution-dist-import.mjs',
    disposition: 'runtime-exception',
    reason: 'Plain Node consumer verifies shipped JavaScript without TypeScript loaders or workspace source aliases.',
  },
  {
    file: 'packages/phaser-minigame-runtime/test/dist-import.mjs',
    disposition: 'runtime-exception',
    reason: 'Plain Node consumer verifies shipped JavaScript without TypeScript loaders or workspace source aliases.',
  },
  {
    file: 'packages/platform/test/ads-dist-import.mjs',
    disposition: 'runtime-exception',
    reason: 'Plain Node consumer verifies shipped JavaScript without TypeScript loaders or workspace source aliases.',
  },
  {
    file: 'packages/platform/test/capability-conformance-dist-import.mjs',
    disposition: 'runtime-exception',
    reason: 'Plain Node consumer verifies shipped JavaScript without TypeScript loaders or workspace source aliases.',
  },
  {
    file: 'packages/platform/test/commerce-conformance-dist-import.mjs',
    disposition: 'runtime-exception',
    reason: 'Plain Node consumer verifies shipped JavaScript without TypeScript loaders or workspace source aliases.',
  },
  {
    file: 'packages/platform/test/commerce-dist-import.mjs',
    disposition: 'runtime-exception',
    reason: 'Plain Node consumer verifies shipped JavaScript without TypeScript loaders or workspace source aliases.',
  },
  {
    file: 'packages/platform/test/notifications-conformance-dist-import.mjs',
    disposition: 'runtime-exception',
    reason: 'Plain Node consumer verifies shipped JavaScript without TypeScript loaders or workspace source aliases.',
  },
  {
    file: 'packages/platform/test/notifications-dist-import.mjs',
    disposition: 'runtime-exception',
    reason: 'Plain Node consumer verifies shipped JavaScript without TypeScript loaders or workspace source aliases.',
  },
  {
    file: 'packages/platform/test/routes-dist-import.mjs',
    disposition: 'runtime-exception',
    reason: 'Plain Node consumer verifies shipped JavaScript without TypeScript loaders or workspace source aliases.',
  },
  {
    file: 'packages/platform/test/share-link-conformance-dist-import.mjs',
    disposition: 'runtime-exception',
    reason: 'Plain Node consumer verifies shipped JavaScript without TypeScript loaders or workspace source aliases.',
  },
  {
    file: 'packages/platform/test/storage-conformance-dist-import.mjs',
    disposition: 'runtime-exception',
    reason: 'Plain Node consumer verifies shipped JavaScript without TypeScript loaders or workspace source aliases.',
  },
  {
    file: 'packages/platform/test/wallet-commerce-dist-import.mjs',
    disposition: 'runtime-exception',
    reason: 'Plain Node consumer verifies shipped JavaScript without TypeScript loaders or workspace source aliases.',
  },
  {
    file: 'packages/runtime-diagnostics/test/dist-import.mjs',
    disposition: 'runtime-exception',
    reason: 'Plain Node consumer verifies shipped JavaScript without TypeScript loaders or workspace source aliases.',
  },
  {
    file: 'packages/target-config/test/adaptive-shell-dist-import.mjs',
    disposition: 'runtime-exception',
    reason: 'Plain Node consumer verifies shipped JavaScript without TypeScript loaders or workspace source aliases.',
  },
  {
    file: 'packages/target-config/test/dist-import.mjs',
    disposition: 'runtime-exception',
    reason: 'Plain Node consumer verifies shipped JavaScript without TypeScript loaders or workspace source aliases.',
  },
  {
    file: 'packages/tutorial/test/dist-import.mjs',
    disposition: 'runtime-exception',
    reason: 'Plain Node consumer verifies shipped JavaScript without TypeScript loaders or workspace source aliases.',
  },
  {
    file: 'packages/tutorial/test/package-import.mjs',
    disposition: 'runtime-exception',
    reason: 'Plain Node consumer verifies shipped JavaScript without TypeScript loaders or workspace source aliases.',
  },
  {
    file: 'strip.config.js',
    disposition: 'runtime-exception',
    reason: 'The pinned strip loader fails TS configs with symlinked macOS temporary roots; checked JSDoc preserves its config contract.',
  },
  {
    file: 'tools/ci/attest-pr-merge.mjs',
    disposition: 'migration-backlog',
    reason: 'Existing JavaScript orchestration or test awaiting a typed migration; this is not a runtime exception.',
  },
  {
    file: 'tools/ci/attest-pr-merge.test.mjs',
    disposition: 'migration-backlog',
    reason: 'Existing JavaScript orchestration or test awaiting a typed migration; this is not a runtime exception.',
  },
  {
    file: 'tools/ci/compiled-loader.mjs',
    disposition: 'runtime-exception',
    reason: 'Native Node loader resolves already compiled output without invoking the compiler under test.',
  },
  {
    file: 'tools/ci/native-scope.mjs',
    disposition: 'runtime-exception',
    reason: 'Runs in CI before dependencies and the pinned Node toolchain are installed; checked by the JS boundary project.',
  },
  {
    file: 'tools/ci/native-scope.test.mjs',
    disposition: 'migration-backlog',
    reason: 'Existing JavaScript orchestration or test awaiting a typed migration; this is not a runtime exception.',
  },
  {
    file: 'tools/ci/run-compiled.mjs',
    disposition: 'runtime-exception',
    reason: 'Bootstraps the native Node loader for the precompiled CI suite.',
  },
  {
    file: 'tools/ci/verify-coverage.mjs',
    disposition: 'runtime-exception',
    reason: 'Runs in the final checkout-only CI job without installed dependencies; checked by the JS boundary project.',
  },
  {
    file: 'tools/ci/verify-coverage.test.mjs',
    disposition: 'migration-backlog',
    reason: 'Existing JavaScript orchestration or test awaiting a typed migration; this is not a runtime exception.',
  },
  {
    file: 'tools/ci/windows-timings.mjs',
    disposition: 'runtime-exception',
    reason: 'Reports timings in the checkout-only CI gate without dependencies or a TypeScript loader; checked by the JS boundary project.',
  },
  {
    file: 'tools/deploy/store-tooling-packed-consumer.mjs',
    disposition: 'runtime-exception',
    reason: 'Plain Node consumer verifies shipped JavaScript without TypeScript loaders or workspace source aliases.',
  },
  {
    file: 'tools/deploy/validate-asc.mjs',
    disposition: 'migration-backlog',
    reason: 'Existing JavaScript orchestration or test awaiting a typed migration; this is not a runtime exception.',
  },
  {
    file: 'tools/fixtures/ttsx-assertion-canary.js',
    disposition: 'runtime-exception',
    reason: 'Authored JavaScript sibling fixture proves the TS runner never overwrites an existing JS source.',
  },
  {
    file: 'tools/package/packed-dependency-closure.mjs',
    disposition: 'migration-backlog',
    reason: 'Existing JavaScript orchestration or test awaiting a typed migration; this is not a runtime exception.',
  },
  {
    file: 'tools/run-ttsx.mjs',
    disposition: 'runtime-exception',
    reason: 'Bootstraps the TypeScript runner and native binary before typed tools can execute.',
  },
  {
    file: 'tools/run-ttsx.test.mjs',
    disposition: 'runtime-exception',
    reason: 'Untransformed observer tests the compiler launcher, source ownership and type-stripping boundary independently.',
  },
  {
    file: 'tools/smoke/cli-output.mjs',
    disposition: 'migration-backlog',
    reason: 'Existing JavaScript orchestration or test awaiting a typed migration; this is not a runtime exception.',
  },
  {
    file: 'tools/smoke/lite-template-lifecycle.mjs',
    disposition: 'migration-backlog',
    reason: 'Existing JavaScript orchestration or test awaiting a typed migration; this is not a runtime exception.',
  },
  {
    file: 'tools/smoke/native-cli-packed-consumer.mjs',
    disposition: 'runtime-exception',
    reason: 'Plain Node consumer verifies shipped JavaScript without TypeScript loaders or workspace source aliases.',
  },
  {
    file: 'tools/smoke/native-packed-consumer.mjs',
    disposition: 'runtime-exception',
    reason: 'Plain Node consumer verifies shipped JavaScript without TypeScript loaders or workspace source aliases.',
  },
  {
    file: 'tools/smoke/native-packed-swift.mjs',
    disposition: 'migration-backlog',
    reason: 'Existing JavaScript orchestration or test awaiting a typed migration; this is not a runtime exception.',
  },
  {
    file: 'tools/smoke/ttsx-assertions.mjs',
    disposition: 'runtime-exception',
    reason: 'Untransformed observer must detect assertion stripping in the compiler under test.',
  },
  {
    file: 'tools/smoke/windows-host-contracts/Verify-DocumentTransport.mjs',
    disposition: 'migration-backlog',
    reason: 'Existing JavaScript orchestration or test awaiting a typed migration; this is not a runtime exception.',
  },
  {
    file: 'tools/smoke/windows-host-contracts/Verify-WebClient.mjs',
    disposition: 'migration-backlog',
    reason: 'Existing JavaScript orchestration or test awaiting a typed migration; this is not a runtime exception.',
  },
  {
    file: 'tools/smoke/windows-native/bridge-fixture.mjs',
    disposition: 'runtime-exception',
    reason: 'JavaScript is loaded directly by the native WebView fixture without a TS loader.',
  },
  {
    file: 'tools/smoke/windows-starter-consumer.mjs',
    disposition: 'runtime-exception',
    reason: 'Plain Node consumer verifies shipped JavaScript without TypeScript loaders or workspace source aliases.',
  },
  {
    file: 'tools/toolchain.test.mjs',
    disposition: 'runtime-exception',
    reason: 'Untransformed observer verifies toolchain pin validation without relying on the validated compiler.',
  },
  {
    file: 'tools/ttsx-project-entry.mjs',
    disposition: 'runtime-exception',
    reason: 'Installs the TypeScript runtime entry before the selected typed script runs.',
  },
  {
    file: 'tools/validate-toolchain.mjs',
    disposition: 'runtime-exception',
    reason: 'Detects toolchain pin drift before relying on that toolchain to compile tools.',
  },
] as const satisfies readonly JavaScriptEntry[];
