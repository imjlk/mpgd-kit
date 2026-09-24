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

console.log('Capacitor reference native services fail closed without providers.');
