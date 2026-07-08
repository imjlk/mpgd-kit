import './styles.css';

import { resolveMpgdLocale } from '@mpgd/i18n';

import { createStarterGame } from './runtime/createGame';
import { detectRuntime } from './platform/runtimeDetector';
import { createStarterGameServices } from './platform/gameServices';
import { installStarterPlatform } from './platform/installStarterPlatform';

const runtimeConfig = detectRuntime();
const platform = await installStarterPlatform(runtimeConfig);
const runtime = await platform.getTargetRuntime();
const player =
  (await platform.identity.getPlayer()) ?? {
    playerId: 'local-player',
    displayName: 'Local Player',
  };
const locale = resolveMpgdLocale(runtime.capabilities);
const gameServices = createStarterGameServices({
  gateway: platform,
  playerId: player.playerId,
});

createStarterGame({
  mountId: 'game',
  context: {
    platform,
    runtime,
    player,
    locale,
    gameServices,
  },
});
