import { redis } from '@devvit/web/server';
import {
  createDevvitRedisPostOperationStore,
  type DevvitIndexedDurableOperationStore,
} from '@mpgd/adapter-devvit/server';

export function createPostOperationStore(): DevvitIndexedDurableOperationStore {
  return createDevvitRedisPostOperationStore(redis);
}
