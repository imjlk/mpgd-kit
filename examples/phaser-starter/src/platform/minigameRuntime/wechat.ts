import {
  createWechatMiniGameHostFromGlobal,
  createWechatPlatformGateway,
  resolveWechatMiniGameApi,
} from '@mpgd/adapter-wechat';
import {
  createMiniGamePhaserConfig,
  installMiniGameGlobals,
  installPhaserMiniGameRuntime,
} from '@mpgd/phaser-minigame-runtime';

import type { StarterMiniGameRuntimeBridge } from '../minigameBridge';
import {
  requireStarterMiniGameRuntimeAssetOrigins,
  StarterMiniGameBridgeLifecycle,
} from '../minigameBridgeLifecycle';

type WechatMiniGameRuntimeScope = typeof globalThis & {
  readonly __MPGD_MINIGAME_RUNTIME_ASSET_ORIGINS__?: unknown;
  __MPGD_MINIGAME_RUNTIME__?: StarterMiniGameRuntimeBridge;
};

const scope = globalThis as WechatMiniGameRuntimeScope;
const remoteAssetOrigins = requireStarterMiniGameRuntimeAssetOrigins(
  scope,
  __MPGD_MINIGAME_REMOTE_ASSET_ORIGINS__,
);

const api = resolveWechatMiniGameApi(globalThis);
const host = createWechatMiniGameHostFromGlobal(globalThis);
const globals = installMiniGameGlobals(host, {
  image: { allowedRemoteOrigins: remoteAssetOrigins },
  transport: { allowedRemoteOrigins: remoteAssetOrigins },
});
const attachedGames = new WeakSet<object>();
const bridgeLifecycle = new StarterMiniGameBridgeLifecycle(() => globals.dispose());
let bridge: StarterMiniGameRuntimeBridge;
const disposeBridgeAfterGame = () => bridge.dispose();
bridge = {
  target: 'wechat',
  gateway: createWechatPlatformGateway({ api }),
  createPhaserConfig(config) {
    return createMiniGamePhaserConfig(config, globals);
  },
  attachGame(game) {
    const events = game.events;

    if (events?.once === undefined) {
      throw new Error('Mini-game Phaser game must expose a destroy event.');
    }
    if (attachedGames.has(game as object)) {
      installPhaserMiniGameRuntime(game, {
        globals,
        onDispose: disposeBridgeAfterGame,
      });
      return;
    }

    installPhaserMiniGameRuntime(game, {
      globals,
      onDispose: disposeBridgeAfterGame,
    });
    attachedGames.add(game as object);
  },
  dispose() {
    bridgeLifecycle.dispose(scope, bridge);
  },
};

if (scope.__MPGD_MINIGAME_RUNTIME__ !== undefined) {
  globals.dispose();
  throw new Error('Mini-game runtime bridge is already installed.');
}

Object.defineProperty(scope, '__MPGD_MINIGAME_RUNTIME__', {
  configurable: true,
  enumerable: false,
  writable: false,
  value: bridge,
});
