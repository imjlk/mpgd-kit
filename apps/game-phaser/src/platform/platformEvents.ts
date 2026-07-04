import Phaser from 'phaser';

import type { PlatformGateway } from '@mpgd/platform';

export function installPlatformEvents(game: Phaser.Game, platform: PlatformGateway): void {
  const removePause = platform.lifecycle.onPause(() => {
    game.loop.sleep();
  });

  const removeResume = platform.lifecycle.onResume(() => {
    game.loop.wake();
  });

  game.events.once(Phaser.Core.Events.DESTROY, () => {
    removePause();
    removeResume();
  });
}
