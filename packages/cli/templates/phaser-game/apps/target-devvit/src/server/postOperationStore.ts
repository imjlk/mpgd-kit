import { redis } from '@devvit/web/server';
import {
  createDevvitRedisPostOperationStore,
  type DevvitDurableOperationStore,
} from '@mpgd/adapter-devvit/server';

export function createPostOperationStore(): DevvitDurableOperationStore {
  return createDevvitRedisPostOperationStore(redis);
}
