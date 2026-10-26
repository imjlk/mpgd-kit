import { bindGameAudio } from '@mpgd/game-runtime/audio';
import type { CanvasSurface, LiteShell } from '@mpgd/lite-shell';

import { mountDeleteAccountButton } from '../lite/deleteAccountButton';
import { mountRestorePurchasesButton } from '../lite/restorePurchasesButton';
import { createTapGame } from '../lite/tapGame';
import type { StarterContext } from './gameContext';

/** Lite template: no Phaser. Mount a renderer-agnostic lite shell into the game element. */
export function createStarterGame(input: {
  readonly mountId: string;
  readonly preserveBrowserTouchGestures?: boolean;
  readonly context: StarterContext;
}): LiteShell<CanvasSurface> {
  const mount = document.getElementById(input.mountId);
  if (mount === null) {
    throw new Error(`Missing game mount #${input.mountId}.`);
  }
  mount.style.width = '100%';
  mount.style.height = '100%';
  let muted = false;
  const audio = bindGameAudio({
    execution: input.context.gameRuntime.execution,
    sink: {
      getMuted: () => muted,
      setMuted: (next) => {
        muted = next;
      },
    },
    onError: (error) => {
      console.error('[game-audio]', error);
    },
  });
  // Mounted before the game so later overlays (such as a settings dialog) stack above it.
  const disposeRestorePurchases = mountRestorePurchasesButton(mount, input.context);
  const disposeDeleteAccount = mountDeleteAccountButton(mount, input.context);
  const shell = createTapGame({ mount, title: '__GAME_TITLE__' });
  let disposed = false;
  const dispose = (): void => {
    if (disposed) {
      return;
    }
    disposed = true;
    globalThis.removeEventListener('pagehide', onPageHide);
    audio.dispose();
    input.context.gameRuntime.dispose();
    // In reverse order of mounting: each restores the mount's position it saw.
    disposeDeleteAccount();
    disposeRestorePurchases();
    shell.dispose();
  };
  const onPageHide = (event: PageTransitionEvent): void => {
    if (!event.persisted) {
      dispose();
    }
  };
  globalThis.addEventListener('pagehide', onPageHide);
  return {
    ...shell,
    get size() {
      return shell.size;
    },
    dispose,
  };
}
