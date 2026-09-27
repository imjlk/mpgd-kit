import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const implementations = [
  {
    path: 'native-plugins/capacitor-game-services/android/src/main/java/dev/mpgd/capacitor/CapacitorGameServicesPlugin.java',
    capability: (name, enabled) => new RegExp(`\\.put\\("${name}", ${enabled}\\)`),
  },
  {
    path: 'native-plugins/capacitor-game-services/ios/Sources/CapacitorGameServices/CapacitorGameServicesPlugin.swift',
    capability: (name, enabled) => new RegExp(`"${name}": ${enabled}`),
  },
];

for (const implementation of implementations) {
  const source = read(implementation.path);

  for (const name of [
    'nativeIap',
    'nativeAds',
    'rewardedAds',
    'interstitialAds',
    'bannerAds',
    'nativeLeaderboard',
  ]) {
    assert.match(source, implementation.capability(name, false), `${implementation.path}: ${name} must be disabled without a provider`);
  }
  assert.match(
    source,
    implementation.capability('localizedContent', true),
    `${implementation.path}: WebView localization remains available without native providers`,
  );

  for (const code of ['NATIVE_IAP_UNAVAILABLE', 'NATIVE_ADS_UNAVAILABLE', 'NATIVE_LEADERBOARD_UNAVAILABLE']) {
    assert.ok(source.includes(code), `${implementation.path}: missing fail-closed ${code} response`);
  }

  for (const method of [
    'commerce.getProducts',
    'commerce.purchase',
    'commerce.restore',
    'commerce.getEntitlements',
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
  assert.equal(routedResolves.length, 3, `${implementation.path}: expected one fail-closed route group per service`);
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
assert.match(playBilling, /queryPurchasesAsync\(/u, 'Play Billing must support owned-purchase requery');
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
assert.match(storeKitPurchase, /call\.resolve\(\["status": "purchased", "transaction": payload\]\)/u,
  'StoreKit purchase must return provisional transaction evidence');
assert.doesNotMatch(storeKit.split('@objc func finishTransaction')[0], /transaction\.finish\(/u,
  'StoreKit must not finish a transaction during checkout or event delivery');
assert.match(storeKit, /@objc func finishTransaction[\s\S]*?transaction\.finish\(\)/u,
  'StoreKit finish must be a separate post-grant operation');
assert.equal((storeKit.match(/transaction\.finish\(\)/gu) ?? []).length, 1,
  'Only the explicit post-grant method may finish StoreKit transactions');

console.log('Capacitor reference native services fail closed without providers.');
