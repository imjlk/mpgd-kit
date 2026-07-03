export interface LeaderboardScoreInput {
  readonly leaderboardId: string;
  readonly score: number;
  readonly runId: string;
  readonly submittedAt: string;
}

export interface LeaderboardSubmitResult {
  readonly submitted: boolean;
  readonly rank?: number;
}

export interface LeaderboardAdapter {
  submitScore(input: LeaderboardScoreInput): Promise<LeaderboardSubmitResult>;
  open(input?: { readonly leaderboardId?: string }): Promise<void>;
}
