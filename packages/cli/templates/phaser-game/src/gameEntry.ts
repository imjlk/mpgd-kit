import { renderEntryFailure } from './runtime/renderEntryFailure';

try {
  await import('./main');
} catch (error) {
  renderEntryFailure(error);
}

export {};
