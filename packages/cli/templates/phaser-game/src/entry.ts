import gameProjectConfig from '../mpgd.game.json';

import { renderEntryFailure } from './runtime/renderEntryFailure';
import {
  installTextSelectionPolicy,
  resolveTextSelectionMode,
} from './platform/textSelection';

try {
  installTextSelectionPolicy(
    resolveTextSelectionMode((gameProjectConfig as { readonly ui?: unknown }).ui),
  );

  if (__APP_TARGET__ === 'reddit') {
    await import('./platform/devvitEntrypoint');
  } else {
    await import('./main');
  }
} catch (error) {
  renderEntryFailure(error);
}

export {};
