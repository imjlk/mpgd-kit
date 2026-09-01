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
const bridge: StarterMiniGameRuntimeBridge = {
  target: 'wechat',
  gateway: createWechatPlatformGateway({ api }),
  createPhaserConfig(config) {
    return createMiniGamePhaserConfig(config, globals);
  },
  attachGame(game) {
    if (attachedGames.has(game as object)) {
      installPhaserMiniGameRuntime(game, { globals });
      return;
    }

    const installation = installPhaserMiniGameRuntime(game, { globals });
    const events = game.events;

    if (events?.once === undefined) {
      installation.dispose();
      throw new Error('Mini-game Phaser game must expose a destroy event.');
    }

    attachedGames.add(game as object);
    events.once('destroy', () => {
      installation.dispose();
      bridge.dispose();
    });
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
