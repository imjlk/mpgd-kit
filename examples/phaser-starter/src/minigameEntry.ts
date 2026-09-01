import { bootstrapStarter } from './bootstrap';

void bootstrapStarter().catch((error: unknown): never => {
  throw error;
});
