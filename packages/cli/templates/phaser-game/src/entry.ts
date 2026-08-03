import { renderEntryFailure } from './runtime/renderEntryFailure';

try {
  if (__APP_TARGET__ === 'reddit') {
    await import('./platform/devvitEntrypoint');
  } else {
    await import('./main');
  }
} catch (error) {
  renderEntryFailure(error);
}

export {};
