import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

import { manifest, optionalObject, parseObject } from './validation/json.js';

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
// The six commerce v2 bridge methods are the whole commerce bridge (the v1
// `commerce.*` methods were removed in commerce v2 PR C4).
const commerceV2Methods = [
  'commerce.v2.getCapabilities',
  'commerce.v2.fetchProducts',
  'commerce.v2.requestPurchase',
  'commerce.v2.getAvailablePurchases',
  'commerce.v2.finishTransaction',
  'commerce.v2.restorePurchases',
];
const retiredCommerceMethods = [
  'commerce.getProducts',
  'commerce.purchase',
  'commerce.restore',
  'commerce.getEntitlements',
];
const implementations = [
  {
    path: 'native-plugins/capacitor-game-services/android/src/main/java/dev/mpgd/capacitor/CapacitorGameServicesPlugin.java',
    capability: (name: string, enabled: boolean) => new RegExp(`\\.put\\("${name}", ${enabled}\\)`),
  },
  {
    path: 'native-plugins/capacitor-game-services/ios/Sources/CapacitorGameServices/CapacitorGameServicesPlugin.swift',
    capability: (name: string, enabled: boolean) => new RegExp(`"${name}": ${enabled}`),
  },
];

for (const implementation of implementations) {
  const source = read(implementation.path);

  for (const name of [
    'nativeAds',
    'rewardedAds',
    'interstitialAds',
    'bannerAds',
    'nativeLeaderboard',
  ]) {
    assert.match(
      source,
      implementation.capability(name, false),
      `${implementation.path}: ${name} must be disabled without a provider`,
    );
  }
  // The commerce capability block is the gateway's: the native base answer
  // carries none of the retired boolean flags.
  for (const name of ['nativeIap', 'subscriptionIap']) {
    assert.doesNotMatch(
      source,
      new RegExp(`["']${name}["']`, 'u'),
      `${implementation.path}: the retired ${name} flag must not be reported`,
    );
  }
  assert.match(
    source,
    implementation.capability('localizedContent', true),
    `${implementation.path}: WebView localization remains available without native providers`,
  );

  for (const code of [
    'COMMERCE_V2_UNAVAILABLE',
    'NATIVE_ADS_UNAVAILABLE',
    'NATIVE_LEADERBOARD_UNAVAILABLE',
  ]) {
    assert.ok(
      source.includes(code),
      `${implementation.path}: missing fail-closed ${code} response`,
    );
  }

  for (const method of retiredCommerceMethods) {
    assert.ok(
      !source.includes(`"${method}"`),
      `${implementation.path}: the retired v1 ${method} route must not return`,
    );
  }

  for (const method of [
    ...commerceV2Methods,
    'ads.preload',
    'ads.showRewarded',
    'ads.showInterstitial',
    'ads.mountBanner',
    'ads.unmountBanner',
    'leaderboard.submitScore',
    'leaderboard.open',
  ]) {
    assert.ok(source.includes(`"${method}"`), `${implementation.path}: missing ${method} route`);
  }

  const routedResolves = source.match(
    /case "(?:commerce|ads|leaderboard)\.[^"]+"[\s\S]*?call\.resolve\((?:ok|error)Response/gu,
  ) ?? [];
  assert.equal(
    routedResolves.length,
    3,
    `${implementation.path}: expected one fail-closed route group per service`,
  );
  for (const resolve of routedResolves) {
    assert.ok(
      resolve.endsWith('call.resolve(errorResponse'),
      `${implementation.path}: unconfigured native services must not return a successful response`,
    );
  }

  assert.doesNotMatch(source, /(?:android|ios)-mock-|rewardGranted|COINS_100|100 demo coins/u);
}

const playBilling = read(
  'native-plugins/capacitor-play-billing/android/src/main/java/dev/mpgd/capacitor/playbilling/CapacitorPlayBillingPlugin.java',
);
assert.match(
  playBilling,
  /queryPurchasesAsync\(/u,
  'Play Billing must support owned-purchase requery',
);
assert.doesNotMatch(
  playBilling,
  /\b(?:acknowledgePurchase|consumeAsync)\s*\(/u,
  'Client-side Billing must never finalize before the backend ledger grant',
);

const storeKit = read(
  'native-plugins/capacitor-storekit/ios/Sources/CapacitorStoreKit/CapacitorStoreKitPlugin.swift',
);
assert.match(storeKit, /Transaction\.unfinished/u, 'StoreKit must requery unfinished purchases');
assert.match(storeKit, /Transaction\.updates/u, 'StoreKit must listen for delayed transactions');
const storeKitPurchase = storeKit.split('@objc func purchase')[1]
  ?.split('@objc func getTransactions')[0] ?? '';
assert.match(storeKitPurchase, /case \.success/u, 'StoreKit must handle successful purchases');
assert.match(
  storeKitPurchase,
  /call\.resolve\(\["status": "purchased", "transaction": payload\]\)/u,
  'StoreKit purchase must return provisional transaction evidence',
);
assert.doesNotMatch(
  storeKit.split('@objc func finishTransaction')[0] ?? '',
  /transaction\.finish\(/u,
  'StoreKit must not finish a transaction during checkout or event delivery',
);
assert.match(
  storeKit,
  /@objc func finishTransaction[\s\S]*?transaction\.finish\(\)/u,
  'StoreKit finish must be a separate post-grant operation',
);
assert.equal(
  (storeKit.match(/transaction\.finish\(\)/gu) ?? []).length,
  1,
  'Only the explicit post-grant method may finish StoreKit transactions',
);

// Commerce v2 store providers (RFC C3). A shell built without the native
// plugin answers Capacitor's UNIMPLEMENTED, which both SDKs report as
// `configuration-required` instead of crashing or offering a purchase.
for (const [path, label] of [
  ['native-plugins/capacitor-play-billing/src/store-sdk.ts', 'Play Billing'],
  ['native-plugins/capacitor-storekit/src/store-sdk.ts', 'StoreKit'],
] as const) {
  const sdk = read(path);
  assert.match(
    sdk,
    /'UNIMPLEMENTED'/u,
    `${label}: a missing native plugin must map to configuration-required`,
  );
}

// Commerce v2 PR C4 removed the v1 recovery drivers and bridge providers: a
// store plugin ships only its commerce v2 provider and `StoreSdk`.
for (const name of ['capacitor-play-billing', 'capacitor-storekit']) {
  assert.ok(
    !existsSync(new URL(`../native-plugins/${name}/src/provider.ts`, import.meta.url)),
    `${name}: the v1 provider and recovery driver must not return`,
  );
}

// The reference shell does not bundle a store plugin: `mpgd target init
// capacitor --providers` installs one into a game-owned shell on request.
const referenceShell = manifest(read('apps/mobile-capacitor/package.json'), 'reference shell');
for (const name of ['@mpgd/capacitor-play-billing', '@mpgd/capacitor-storekit']) {
  assert.equal(
    referenceShell.dependencies?.[name],
    undefined,
    `The reference shell must not bundle ${name}`,
  );
}

// The generated and private starter gateways register the store providers
// through the plugins' service-provider factories and never finish, consume,
// or grant on their own; the reconciler does that after the ledger grant.
const wiredGateways = [
  [
    'src/platform/buildGateways/capacitorAndroid.ts',
    'createCapacitorPlayBillingServiceProvider',
    '@mpgd/capacitor-play-billing',
  ],
  [
    'src/platform/buildGateways/capacitorIos.ts',
    'createCapacitorStoreKitServiceProvider',
    '@mpgd/capacitor-storekit',
  ],
] as const;
for (const root of ['packages/cli/templates/phaser-game', 'examples/phaser-starter']) {
  for (const [file, factory, packageName] of wiredGateways) {
    const gateway = read(`${root}/${file}`);
    assert.ok(
      gateway.includes(`from '${packageName}'`),
      `${root}/${file}: must import ${packageName}`,
    );
    assert.match(
      gateway,
      new RegExp(`${factory}\\(\\{`, 'u'),
      `${root}/${file}: must register ${factory}`,
    );
    assert.match(
      gateway,
      /\n {4}providers,\n/u,
      `${root}/${file}: must pass the providers to the gateway`,
    );
    assert.doesNotMatch(
      gateway,
      /\b(?:finishTransaction|acknowledgePurchase|consumePurchase|completeProductGrant|grantEntitlement)\s*\(/u,
      `${root}/${file}: a gateway must never finish or grant a purchase`,
    );
  }
}

// The CLI installs exactly these plugins, each for the platform its native
// code targets, and wires the same gateway files.
const shellStarter = read('packages/cli/src/capacitor-shell-starter.ts');
for (const [file, factory, packageName] of wiredGateways) {
  const plugin = manifest(
    read(`native-plugins/${packageName.slice('@mpgd/'.length)}/package.json`),
    'native plugin',
  );
  const platform = Object.keys(plugin.capacitor ?? {});
  assert.equal(platform.length, 1, `${packageName}: must declare exactly one Capacitor platform`);
  const entry = new RegExp(
    `packageName: '${packageName}',[\\s\\S]*?platform: '${platform[0]}',\\s*gatewayFile: '${file}',\\s*gatewayFactory: '${factory}'`,
    'u',
  );
  assert.match(
    shellStarter,
    entry,
    `capacitor-shell-starter.ts: ${packageName} must install for ${platform[0]} and wire ${file}`,
  );
}

// Notifications v2 (RFC "Provider profiles", Capacitor): the two plugins are
// optional peers that only the notifications subpath imports, so a shell
// without them fails closed; `@capacitor/push-notifications` never joins them,
// because on iOS it claims the push handler Firebase Messaging needs; and
// local reminders stay inexact.
const notificationPlugins = ['@capacitor-firebase/messaging', '@capacitor/local-notifications'];
const adapterManifestText = read('adapters/capacitor/package.json');
const adapterManifest = manifest(adapterManifestText, 'Capacitor adapter');
const adapterPackage = parseObject(adapterManifestText, 'Capacitor adapter');
assert.ok(
  optionalObject(adapterPackage, 'exports')['./notifications'] !== undefined,
  'The Capacitor adapter must export ./notifications',
);
const optionalPeers = optionalObject(adapterPackage, 'peerDependenciesMeta');
for (const name of notificationPlugins) {
  assert.equal(
    adapterManifest.dependencies[name],
    undefined,
    `${name} must not be a dependency of the Capacitor adapter`,
  );
  assert.ok(
    adapterManifest.peerDependencies[name] !== undefined
      && optionalObject(optionalPeers, name)['optional'] === true,
    `${name} must be an optional peer of the Capacitor adapter`,
  );
  for (const field of ['dependencies', 'devDependencies'] as const) {
    assert.equal(
      referenceShell[field][name],
      undefined,
      `The reference shell must not bundle ${name}`,
    );
  }
}
/**
 * Source without comments, for the provider's own flag checks only. One pass
 * that keeps string and template literals whole, so a `/*` or `//` inside one
 * does not swallow code. A regex literal holding a quote or a backtick would
 * put it out of step, so it runs only on `notifications-provider.ts`, which
 * has none; the import scan and the CLI starter check read the raw text.
 */
const codeOf = (source: string): string => source.replace(
  /("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu,
  (match, literal: string | undefined) => literal ?? (match.startsWith('/*') ? ' ' : ''),
);
const starterManifests = [
  'packages/cli/templates/phaser-game/package.json',
  'examples/phaser-starter/package.json',
];
const pushNotificationsManifests: [string, ReturnType<typeof manifest>][] = [
  ['package.json', manifest(read('package.json'), 'root')],
  ['adapters/capacitor/package.json', adapterManifest],
  ['apps/mobile-capacitor/package.json', referenceShell],
  ...[
    ...starterManifests,
    ...readdirSync(new URL('../native-plugins/', import.meta.url))
      .map((name) => `native-plugins/${name}/package.json`)
      .filter((path) => existsSync(new URL(`../${path}`, import.meta.url))),
  ].map((path): [string, ReturnType<typeof manifest>] => [path, manifest(read(path), path)]),
];
for (const [path, packageManifest] of pushNotificationsManifests) {
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies'] as const) {
    assert.equal(
      packageManifest[field]['@capacitor/push-notifications'],
      undefined,
      `${path}: @capacitor/push-notifications conflicts with @capacitor-firebase/messaging on iOS`,
    );
  }
}
assert.doesNotMatch(
  shellStarter,
  /@capacitor\/push-notifications/u,
  'The CLI shell starter must not install @capacitor/push-notifications',
);
// The base entry's module graph stays free of the optional peers: no other
// module imports them (or one of their subpaths), a notifications module, or
// the package's own notifications subpath. Matched as import syntax on the
// raw text: `from` or a bare `import` with a quoted specifier, or `import(`
// and `require(` with a quoted or template specifier, comments allowed before
// it (`import(/* @vite-ignore */ '…')`). Prose that names a module in
// backticks after "from" does not trip it.
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/]/gu, '\\$&');
const adapterName = adapterPackage['name'];
assert.ok(
  typeof adapterName === 'string' && adapterName !== '',
  'The Capacitor adapter must have a name',
);
const forbiddenSpecifier = [
  `(?:${notificationPlugins.map(escapeRegExp).join('|')})(?:\\/[^"'\`]*)?`,
  `(?:\\.\\.?\\/)+(?:[^"'\`]*\\/)?notifications[^"'\`]*`,
  `${escapeRegExp(adapterName)}\\/notifications(?:\\/[^"'\`]*)?`,
].join('|');
const commentsThenSpace = '\\s*(?:\\/\\*[\\s\\S]*?\\*\\/\\s*)*';
const notificationsSpecifier = new RegExp(
  `(?:\\b(?:from|import)\\s*["'](?:${forbiddenSpecifier})["']`
    + `|\\b(?:import|require)\\s*\\(${commentsThenSpace}["'\`](?:${forbiddenSpecifier})["'\`])`,
  'u',
);
// The pattern itself is checked, so an escaping slip cannot turn the scan
// into a silent pass.
for (const line of [
  "import { LocalNotifications } from '@capacitor/local-notifications';",
  'export * from "@capacitor-firebase/messaging/web";',
  "import './notifications-sdk.js';",
  'const m = import(/* @vite-ignore */ `../notifications/index.js`);',
  `type X = typeof import('${adapterName}/notifications');`,
  "const r = require('@capacitor/local-notifications');",
]) {
  assert.match(line, notificationsSpecifier, `The import scan must catch: ${line}`);
}
for (const line of [
  "import { Capacitor } from '@capacitor/core';",
  "import { createCapacitorAdMobRewardedProvider } from './admob.js';",
  '// Loaded from `@capacitor/local-notifications` by the notifications subpath.',
]) {
  assert.doesNotMatch(line, notificationsSpecifier, `The import scan must not catch: ${line}`);
}
const scanned: string[] = [];
for (const file of readdirSync(new URL('../adapters/capacitor/src/', import.meta.url), {
  encoding: 'utf8',
  recursive: true,
})) {
  const path = file.replaceAll('\\', '/');
  if (!path.endsWith('.ts') || path.endsWith('.test.ts')
    || /^notifications[^/]*\.ts$|^notifications\//u.test(path)) {
    continue;
  }
  scanned.push(path);
  assert.doesNotMatch(
    read(`adapters/capacitor/src/${path}`),
    notificationsSpecifier,
    `adapters/capacitor/src/${path}: only the notifications subpath may import the notification plugins or modules`,
  );
}
assert.ok(
  scanned.includes('index.ts') && scanned.includes('providers.ts'),
  'The base entry modules must be among the scanned Capacitor sources',
);
const notificationsProvider = codeOf(read('adapters/capacitor/src/notifications-provider.ts'));
assert.match(
  notificationsProvider,
  /^\s*isExactNotification:\s*false\b/mu,
  'Capacitor local reminders must be scheduled with inexact alarms',
);
assert.doesNotMatch(
  notificationsProvider,
  /isExactNotification:\s*true|isExactMandatory/u,
  'Capacitor local reminders must never ask for exact alarms',
);

console.info(
  'Capacitor reference native services fail closed without providers, and store and notification providers stay opt-in.',
);
