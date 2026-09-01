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

type WechatMiniGameRuntimeScope = typeof globalThis & {
  readonly __MPGD_MINIGAME_RUNTIME_ASSET_ORIGINS__?: readonly string[];
  __MPGD_MINIGAME_RUNTIME__?: StarterMiniGameRuntimeBridge;
};

const scope = globalThis as WechatMiniGameRuntimeScope;
const remoteAssetOrigins = scope.__MPGD_MINIGAME_RUNTIME_ASSET_ORIGINS__;

if (
  !Array.isArray(remoteAssetOrigins)
  || !remoteAssetOrigins.every((origin) => typeof origin === 'string')
) {
  throw new Error('Mini-game runtime asset-origin metadata is unavailable.');
}

const api = resolveWechatMiniGameApi(globalThis);
const host = createWechatMiniGameHostFromGlobal(globalThis);
const globals = installMiniGameGlobals(host, {
  image: { allowedRemoteOrigins: remoteAssetOrigins },
  transport: { allowedRemoteOrigins: remoteAssetOrigins },
});
const attachedGames = new WeakSet<object>();
let disposed = false;
let disposing = false;
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
    if (disposed || disposing) {
      return;
    }
    disposing = true;

    try {
      globals.dispose();
      disposed = true;

      if (scope.__MPGD_MINIGAME_RUNTIME__ === bridge) {
        Reflect.deleteProperty(scope, '__MPGD_MINIGAME_RUNTIME__');
      }
      if (scope.__MPGD_MINIGAME_RUNTIME_ASSET_ORIGINS__ === remoteAssetOrigins) {
        Reflect.deleteProperty(scope, '__MPGD_MINIGAME_RUNTIME_ASSET_ORIGINS__');
      }
    } finally {
      disposing = false;
    }
  },
};

if (scope.__MPGD_MINIGAME_RUNTIME__ !== undefined) {
  globals.dispose();
  Reflect.deleteProperty(scope, '__MPGD_MINIGAME_RUNTIME_ASSET_ORIGINS__');
  throw new Error('Mini-game runtime bridge is already installed.');
}

Object.defineProperty(scope, '__MPGD_MINIGAME_RUNTIME__', {
  configurable: true,
  enumerable: false,
  writable: false,
  value: bridge,
});
