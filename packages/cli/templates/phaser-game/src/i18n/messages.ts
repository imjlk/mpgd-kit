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
  | 'restoreToDevice'
  | 'restoreHolderLimit'
  | 'restoreNothing'
  | 'restoreIncomplete'
  | 'restorePartial'
  | 'restoreNeedsSession'
  | 'restoreNeedsConnection'
  | 'restoreFailed'
  | 'deleteAccount'
  | 'deleteAccountConfirm'
  | 'deleteAccountPendingPurchase'
  | 'deleteAccountConfirmButton'
  | 'deleteAccountCancel'
  | 'deleteAccountClose'
  | 'deleteAccountWorking'
  | 'deleteAccountDone'
  | 'deleteAccountDoneLocalFailed'
  | 'deleteAccountSessionEnded'
  | 'deleteAccountNeedsSession'
  | 'deleteAccountUnavailable'
  | 'deleteAccountFailed'
  | 'deleteAccountRejected';

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
    restoreToDevice: 'Restored to this device ({count} confirmed)',
    restoreHolderLimit: 'This purchase is already in use on the maximum number of devices',
    restoreNothing: 'No new purchases to restore',
    restoreIncomplete: 'Some purchases are not confirmed yet. Try again later.',
    restorePartial: 'Purchases restored ({count}); others are not confirmed yet. Try again later.',
    restoreNeedsSession: 'Restoring purchases needs a game server session',
    restoreNeedsConnection: 'Could not reach the game server. Tap to try again.',
    restoreFailed: 'Could not restore purchases. Try again later.',
    deleteAccount: 'Delete account',
    deleteAccountConfirm:
      'Delete your account? Your progress, scores, and notification settings are erased and you are signed out. '
      + 'Purchases are not refunded and cannot be moved to a new account; ask the store you bought from for a refund. '
      + 'Purchase records are kept for 5 years from the purchase or its last refund, for payment and supply record obligations, without your player ID.',
    deleteAccountPendingPurchase:
      'A purchase is still being processed. Deleting now loses it: Google Play refunds it, but for an App Store purchase ask Apple for the refund.',
    deleteAccountConfirmButton: 'Delete permanently',
    deleteAccountCancel: 'Cancel',
    deleteAccountClose: 'Close',
    deleteAccountWorking: 'Deleting your account...',
    deleteAccountDone: 'Your account was deleted and you are signed out.',
    deleteAccountDoneLocalFailed:
      'Your account was deleted, but this device could not forget its sign-in. Clear the app data or reinstall the app.',
    deleteAccountSessionEnded: 'Your session has ended: your account deletion most likely completed.',
    deleteAccountNeedsSession: 'Sign in to delete your account.',
    deleteAccountUnavailable: 'Account deletion is not available here. Use the deletion page linked from the privacy policy.',
    deleteAccountFailed: 'Could not delete your account. Try again.',
    deleteAccountRejected: 'Could not delete your account. Contact support.',
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
    restoreToDevice: '이 기기로 구매를 복원했습니다 ({count}건 확인)',
    restoreHolderLimit: '이 구매는 이미 허용된 최대 기기 수에서 사용 중입니다',
    restoreNothing: '새로 복원할 구매가 없습니다',
    restoreIncomplete: '아직 확인되지 않은 구매가 있습니다. 나중에 다시 시도하세요.',
    restorePartial: '{count}건 복원, 아직 확인되지 않은 구매가 있습니다. 나중에 다시 시도하세요.',
    restoreNeedsSession: '구매를 복원하려면 게임 서버 세션이 필요합니다',
    restoreNeedsConnection: '게임 서버에 연결하지 못했습니다. 다시 시도하려면 누르세요.',
    restoreFailed: '구매를 복원하지 못했습니다. 나중에 다시 시도하세요.',
    deleteAccount: '계정 삭제',
    deleteAccountConfirm:
      '계정을 삭제할까요? 진행 상황, 점수, 알림 설정이 지워지고 로그아웃됩니다. '
      + '구매는 환불되지 않으며 새 계정으로 옮길 수 없습니다. 환불은 구매한 스토어에 요청하세요. '
      + '구매 기록은 거래기록 보존 의무에 따라 구매 또는 마지막 환불 시점부터 5년 동안 플레이어 ID 없이 보관됩니다.',
    deleteAccountPendingPurchase:
      '아직 처리 중인 구매가 있습니다. 지금 삭제하면 이 구매는 지급되지 않습니다. Google Play는 자동으로 환불하지만, App Store 구매는 Apple에 환불을 요청해야 합니다.',
    deleteAccountConfirmButton: '영구 삭제',
    deleteAccountCancel: '취소',
    deleteAccountClose: '닫기',
    deleteAccountWorking: '계정을 삭제하는 중...',
    deleteAccountDone: '계정이 삭제되었고 로그아웃되었습니다.',
    deleteAccountDoneLocalFailed:
      '계정은 삭제되었지만 이 기기의 로그인 정보를 지우지 못했습니다. 앱 데이터를 지우거나 앱을 다시 설치하세요.',
    deleteAccountSessionEnded: '세션이 종료되었습니다. 계정 삭제가 완료되었을 가능성이 높습니다.',
    deleteAccountNeedsSession: '계정을 삭제하려면 로그인하세요.',
    deleteAccountUnavailable: '여기서는 계정을 삭제할 수 없습니다. 개인정보처리방침에 연결된 삭제 페이지를 이용하세요.',
    deleteAccountFailed: '계정을 삭제하지 못했습니다. 다시 시도하세요.',
    deleteAccountRejected: '계정을 삭제하지 못했습니다. 고객 지원에 문의하세요.',
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
