import { bootstrapStarter } from './bootstrap';

void bootstrapStarter().catch((error: unknown): never => {
  console.error('[starter] mini-game bootstrap failed.', error);
  throw error;
});
