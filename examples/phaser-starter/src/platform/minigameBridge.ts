import type { PlatformGateway, PlatformTarget } from '@mpgd/platform';
import type {
  MiniGamePhaserConfigOverrides,
  MiniGamePhaserGame,
} from '@mpgd/phaser-minigame-runtime';

export interface StarterMiniGameRuntimeBridge {
  readonly target: 'wechat' | 'tiktok';
  readonly gateway: PlatformGateway;
  createPhaserConfig<T extends Readonly<Record<string, unknown>>>(
    config: T,
  ): T & MiniGamePhaserConfigOverrides;
  attachGame(game: MiniGamePhaserGame): void;
  dispose(): void;
}

export function requireStarterMiniGameRuntimeBridge(
  target?: 'wechat' | 'tiktok',
): StarterMiniGameRuntimeBridge {
  const bridge = readStarterMiniGameRuntimeBridge();

  if (bridge === undefined) {
    throw new Error('Mini-game runtime.js must execute before game.bundle.js.');
  }
  if (target !== undefined && bridge.target !== target) {
    throw new Error(
      `Mini-game runtime target mismatch: expected ${target}, received ${bridge.target}.`,
    );
  }

  return bridge;
}

export function disposeStarterMiniGameBridgeAfterBootstrapFailure(target?: PlatformTarget): void {
  if (target !== undefined && target !== 'wechat' && target !== 'tiktok') {
    return;
  }

  const bridge = readStarterMiniGameRuntimeBridge();

  if (bridge === undefined) {
    return;
  }

  try {
    bridge.dispose();
  } catch (error) {
    try {
      console.error('Failed mini-game bootstrap cleanup encountered an error.', error);
    } catch {
      // Preserve the authoritative bootstrap error when host logging is unavailable.
    }
  }
}

function readStarterMiniGameRuntimeBridge(): StarterMiniGameRuntimeBridge | undefined {
  return (
    globalThis as typeof globalThis & {
      __MPGD_MINIGAME_RUNTIME__?: StarterMiniGameRuntimeBridge;
    }
  ).__MPGD_MINIGAME_RUNTIME__;
}
