import { redis } from '@devvit/web/server';
import { createDevvitRedisVerifiedLeaderboardService } from '@mpgd/adapter-devvit/server';
import type { VerifiedLeaderboardService } from '@mpgd/game-services/verified-leaderboard';

export function createVerifiedLeaderboardService(): VerifiedLeaderboardService {
  return createDevvitRedisVerifiedLeaderboardService(redis);
}
