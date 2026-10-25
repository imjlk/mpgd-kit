import type { Locale } from '@mpgd/i18n';

export type GameMessageKey =
  | 'title'
  | 'target'
  | 'viewport'
  | 'orientationPolicy'
  | 'orientationMismatch'
  | 'backend'
  | 'features'
  | 'featuresNone'
  | 'tapToStart'
  | 'score'
  | 'reward'
  | 'rewardError'
  | 'rewardPending'
  | 'rewardUnavailable'
  | 'analytics'
  | 'bootError'
  | 'restorePurchases'
  | 'restoreWorking'
  | 'restoreDone'
  | 'restoreNothing'
  | 'restoreIncomplete'
  | 'restorePartial'
  | 'restoreNeedsSession'
  | 'restoreFailed';

const messages = {
  en: {
    title: '__GAME_TITLE__',
    target: 'Target: {target}',
    viewport: 'Viewport: {sizeClass} {orientation} - controls {controls}',
    orientationPolicy: 'Orientation policy: {mode}',
    orientationMismatch: 'Rotate to {orientation} for {mode}',
    backend: 'Game Services: {mode}',
    features: 'Features: {features}',
    featuresNone: 'none',
    tapToStart: 'Tap or press Enter to start',
    score: 'Score {score}',
    reward: 'Rewarded ad smoke: {status}',
    rewardError: 'Rewarded ad smoke failed',
    rewardPending: 'Press R to request a rewarded ad smoke',
    rewardUnavailable: 'Rewarded ads unavailable on this target',
    analytics: 'Analytics events: {count}',
    bootError: 'Failed to start game',
    restorePurchases: 'Restore purchases',
    restoreWorking: 'Restoring purchases...',
    restoreDone: 'Purchases restored ({count} confirmed)',
    restoreNothing: 'No new purchases to restore',
    restoreIncomplete: 'Some purchases are not confirmed yet. Try again later.',
    restorePartial: 'Purchases restored ({count}); others are not confirmed yet. Try again later.',
    restoreNeedsSession: 'Connect to the game server to restore purchases',
    restoreFailed: 'Could not restore purchases. Try again later.',
  },
  ko: {
    title: '__GAME_TITLE__',
    target: '타깃: {target}',
    viewport: '뷰포트: {sizeClass} {orientation} - 컨트롤 {controls}',
    orientationPolicy: '방향 정책: {mode}',
    orientationMismatch: '{mode}: {orientation} 방향으로 회전',
    backend: 'Game Services: {mode}',
    features: '기능: {features}',
    featuresNone: '없음',
    tapToStart: '탭하거나 Enter를 눌러 시작',
    score: '점수 {score}',
    reward: '리워드 광고 스모크: {status}',
    rewardError: '리워드 광고 스모크 실패',
    rewardPending: 'R 키로 리워드 광고 스모크 요청',
    rewardUnavailable: '이 타깃에서는 리워드 광고를 사용할 수 없음',
    analytics: '애널리틱스 이벤트: {count}',
    bootError: '게임 시작 실패',
    restorePurchases: '구매 복원',
    restoreWorking: '구매 복원 중...',
    restoreDone: '구매 복원 완료 ({count}건 확인)',
    restoreNothing: '새로 복원할 구매가 없습니다',
    restoreIncomplete: '아직 확인되지 않은 구매가 있습니다. 나중에 다시 시도하세요.',
    restorePartial: '{count}건 복원, 아직 확인되지 않은 구매가 있습니다. 나중에 다시 시도하세요.',
    restoreNeedsSession: '구매를 복원하려면 게임 서버에 연결하세요',
    restoreFailed: '구매를 복원하지 못했습니다. 나중에 다시 시도하세요.',
  },
} satisfies Record<Locale, Record<GameMessageKey, string>>;

export function t(
  locale: Locale,
  key: GameMessageKey,
  values: Record<string, string | number> = {},
): string {
  const language = locale === 'ko' ? 'ko' : 'en';
  let text: string = messages[language][key] ?? messages.en[key];

  for (const [name, value] of Object.entries(values)) {
    text = text.replaceAll(`{${name}}`, String(value));
  }

  return text;
}
