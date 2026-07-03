export type Locale = 'en' | 'ko';

export interface MessageOptions {
  readonly locale?: Locale;
}

export type EmptyMessage = (
  inputs?: Record<string, never>,
  options?: MessageOptions,
) => string;

export type MessageFunction<TInputs extends Record<string, string | number>> = (
  inputs: TInputs,
  options?: MessageOptions,
) => string;

export interface MpgdMessages {
  readonly action_i18n: EmptyMessage;
  readonly action_interstitial_ads: EmptyMessage;
  readonly action_leaderboard: EmptyMessage;
  readonly action_purchases: EmptyMessage;
  readonly action_reward_ads: EmptyMessage;
  readonly app_title: EmptyMessage;
  readonly cap_i18n: EmptyMessage;
  readonly cap_iap: EmptyMessage;
  readonly cap_leaderboard: EmptyMessage;
  readonly cap_rewarded_ads: EmptyMessage;
  readonly cap_save: EmptyMessage;
  readonly feature_policy_disabled: MessageFunction<{ readonly feature: string }>;
  readonly feature_unavailable: MessageFunction<{ readonly feature: string }>;
  readonly feature_unsupported: MessageFunction<{ readonly feature: string }>;
  readonly leaderboard_action: EmptyMessage;
  readonly leaderboard_action_unavailable: EmptyMessage;
  readonly leaderboard_opened: EmptyMessage;
  readonly leaderboard_unavailable: EmptyMessage;
  readonly loading_player: EmptyMessage;
  readonly mock_only: EmptyMessage;
  readonly opening_purchase: EmptyMessage;
  readonly player: MessageFunction<{ readonly name: string }>;
  readonly play_again: EmptyMessage;
  readonly policy_feature_i18n: EmptyMessage;
  readonly policy_feature_iap: EmptyMessage;
  readonly policy_feature_interstitial_ads: EmptyMessage;
  readonly policy_feature_leaderboard: EmptyMessage;
  readonly policy_feature_rewarded_ads: EmptyMessage;
  readonly policy_off: EmptyMessage;
  readonly policy_on: EmptyMessage;
  readonly policy_summary: MessageFunction<{
    readonly target: string;
    readonly summary: string;
  }>;
  readonly policy_unavailable: EmptyMessage;
  readonly policy_unsupported: EmptyMessage;
  readonly preparing_demo: EmptyMessage;
  readonly purchase_action: EmptyMessage;
  readonly purchase_completed: EmptyMessage;
  readonly purchase_status: MessageFunction<{ readonly status: string }>;
  readonly purchase_unavailable: EmptyMessage;
  readonly reward_ad_action: EmptyMessage;
  readonly reward_ad_unavailable: EmptyMessage;
  readonly reward_granted: EmptyMessage;
  readonly reward_unavailable: MessageFunction<{ readonly status: string }>;
  readonly save_summary: MessageFunction<{
    readonly bestScore: number;
    readonly coins: number;
  }>;
  readonly saved: EmptyMessage;
  readonly saved_and_submitted: EmptyMessage;
  readonly saving_result: EmptyMessage;
  readonly score: MessageFunction<{ readonly score: number }>;
  readonly sdk_summary: MessageFunction<{ readonly features: string }>;
  readonly showing_rewarded_ad: EmptyMessage;
  readonly status_cleared: EmptyMessage;
  readonly status_try_again: EmptyMessage;
  readonly tap_to_start: EmptyMessage;
  readonly target: MessageFunction<{ readonly target: string }>;
}

export const m: MpgdMessages;
export const baseLocale: Locale;
export const locales: readonly Locale[];
