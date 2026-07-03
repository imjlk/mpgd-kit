import type { PlatformCapabilities } from '@mpgd/platform-contract';

export type DemoLocale = 'en' | 'ko';

export type DemoMessageKey =
  | 'appTitle'
  | 'target'
  | 'loadingPlayer'
  | 'preparingDemo'
  | 'player'
  | 'saveSummary'
  | 'sdkSummary'
  | 'mockOnly'
  | 'tapToStart'
  | 'policyUnavailable'
  | 'policySummary'
  | 'policyFeatureIap'
  | 'policyFeatureRewardedAds'
  | 'policyFeatureInterstitialAds'
  | 'policyFeatureLeaderboard'
  | 'policyFeatureI18n'
  | 'policyOn'
  | 'policyOff'
  | 'policyUnsupported'
  | 'statusCleared'
  | 'statusTryAgain'
  | 'score'
  | 'savingResult'
  | 'saved'
  | 'savedAndSubmitted'
  | 'leaderboardUnavailable'
  | 'rewardAdAction'
  | 'rewardAdUnavailable'
  | 'purchaseAction'
  | 'purchaseUnavailable'
  | 'leaderboardAction'
  | 'leaderboardActionUnavailable'
  | 'playAgain'
  | 'showingRewardedAd'
  | 'rewardGranted'
  | 'rewardUnavailable'
  | 'openingPurchase'
  | 'purchaseCompleted'
  | 'purchaseStatus'
  | 'leaderboardOpened'
  | 'featurePolicyDisabled'
  | 'featureUnsupported'
  | 'featureUnavailable'
  | 'actionPurchases'
  | 'actionRewardAds'
  | 'actionInterstitialAds'
  | 'actionLeaderboard'
  | 'actionI18n'
  | 'capRewardedAds'
  | 'capIap'
  | 'capLeaderboard'
  | 'capSave'
  | 'capI18n';

const messages = {
  en: {
    appTitle: 'MPGD Kit',
    target: 'Target: {target}',
    loadingPlayer: 'Loading player...',
    preparingDemo: 'Preparing SDK demo...',
    player: 'Player: {name}',
    saveSummary: 'Best {bestScore}  Coins {coins}',
    sdkSummary: 'SDK: {features}',
    mockOnly: 'mock only',
    tapToStart: 'Tap or press Enter',
    policyUnavailable: 'Policy: unavailable',
    policySummary: 'Policy {target}: {summary}',
    policyFeatureIap: 'IAP',
    policyFeatureRewardedAds: 'Reward',
    policyFeatureInterstitialAds: 'Inter',
    policyFeatureLeaderboard: 'Board',
    policyFeatureI18n: 'i18n',
    policyOn: 'on',
    policyOff: 'off',
    policyUnsupported: 'n/a',
    statusCleared: 'Cleared',
    statusTryAgain: 'Try Again',
    score: 'Score {score}',
    savingResult: 'Saving result...',
    saved: 'Saved.',
    savedAndSubmitted: 'Saved and submitted.',
    leaderboardUnavailable: 'Leaderboard unavailable.',
    rewardAdAction: 'Reward ad +10 coins',
    rewardAdUnavailable: 'Reward ad unavailable',
    purchaseAction: 'Buy 100 coins',
    purchaseUnavailable: 'Purchase unavailable',
    leaderboardAction: 'Open leaderboard',
    leaderboardActionUnavailable: 'Leaderboard unavailable',
    playAgain: 'Play again',
    showingRewardedAd: 'Showing rewarded ad...',
    rewardGranted: 'Reward granted.',
    rewardUnavailable: 'Reward unavailable: {status}',
    openingPurchase: 'Opening mock purchase...',
    purchaseCompleted: 'Purchase completed.',
    purchaseStatus: 'Purchase {status}.',
    leaderboardOpened: 'Leaderboard opened.',
    featurePolicyDisabled: '{feature} disabled by policy.',
    featureUnsupported: '{feature} unsupported on this target.',
    featureUnavailable: '{feature} unavailable.',
    actionPurchases: 'Purchases',
    actionRewardAds: 'Reward ads',
    actionInterstitialAds: 'Interstitial ads',
    actionLeaderboard: 'Leaderboard',
    actionI18n: 'Localization',
    capRewardedAds: 'rewarded ads',
    capIap: 'iap',
    capLeaderboard: 'leaderboard',
    capSave: 'save',
    capI18n: 'i18n',
  },
  ko: {
    appTitle: 'MPGD 키트',
    target: '타깃: {target}',
    loadingPlayer: '플레이어 불러오는 중...',
    preparingDemo: 'SDK 데모 준비 중...',
    player: '플레이어: {name}',
    saveSummary: '최고 {bestScore}  코인 {coins}',
    sdkSummary: 'SDK: {features}',
    mockOnly: '목업 전용',
    tapToStart: '탭하거나 Enter',
    policyUnavailable: '정책: 없음',
    policySummary: '정책 {target}: {summary}',
    policyFeatureIap: '결제',
    policyFeatureRewardedAds: '보상광고',
    policyFeatureInterstitialAds: '전면광고',
    policyFeatureLeaderboard: '랭킹',
    policyFeatureI18n: '다국어',
    policyOn: '켜짐',
    policyOff: '꺼짐',
    policyUnsupported: '미지원',
    statusCleared: '클리어',
    statusTryAgain: '다시 도전',
    score: '점수 {score}',
    savingResult: '결과 저장 중...',
    saved: '저장됨.',
    savedAndSubmitted: '저장 및 랭킹 제출 완료.',
    leaderboardUnavailable: '랭킹 사용 불가.',
    rewardAdAction: '보상광고 +10 코인',
    rewardAdUnavailable: '보상광고 사용 불가',
    purchaseAction: '100 코인 구매',
    purchaseUnavailable: '구매 사용 불가',
    leaderboardAction: '랭킹 열기',
    leaderboardActionUnavailable: '랭킹 사용 불가',
    playAgain: '다시 플레이',
    showingRewardedAd: '보상광고 표시 중...',
    rewardGranted: '보상 지급 완료.',
    rewardUnavailable: '보상 사용 불가: {status}',
    openingPurchase: '목업 구매 여는 중...',
    purchaseCompleted: '구매 완료.',
    purchaseStatus: '구매 {status}.',
    leaderboardOpened: '랭킹 열림.',
    featurePolicyDisabled: '{feature} 정책 비활성.',
    featureUnsupported: '{feature} 이 타깃에서 미지원.',
    featureUnavailable: '{feature} 사용 불가.',
    actionPurchases: '구매',
    actionRewardAds: '보상광고',
    actionInterstitialAds: '전면광고',
    actionLeaderboard: '랭킹',
    actionI18n: '다국어',
    capRewardedAds: '보상광고',
    capIap: '결제',
    capLeaderboard: '랭킹',
    capSave: '저장',
    capI18n: '다국어',
  },
} satisfies Record<DemoLocale, Record<DemoMessageKey, string>>;

export function resolveDemoLocale(
  capabilities: Pick<PlatformCapabilities, 'localizedContent'>,
  preferredLocale = readPreferredLocale(),
): DemoLocale {
  if (!capabilities.localizedContent) {
    return 'en';
  }

  return preferredLocale.toLowerCase().startsWith('ko') ? 'ko' : 'en';
}

export function translate(
  locale: DemoLocale,
  key: DemoMessageKey,
  values: Readonly<Record<string, string | number>> = {},
): string {
  let template = messages[locale][key];

  for (const [name, value] of Object.entries(values)) {
    template = template.replaceAll(`{${name}}`, String(value));
  }

  return template;
}

function readPreferredLocale(): string {
  return globalThis.navigator?.language ?? 'en';
}
