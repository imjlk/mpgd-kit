import type { SaveData } from '@mpgd/game-save';
import { resolveMpgdLocale, type MpgdLocale } from '@mpgd/i18n';
import {
  createUnsupportedCapabilities,
  type PlatformCapabilities,
  type PlatformGateway,
  type PlayerIdentity,
} from '@mpgd/platform-contract';
import { isTargetConfiguredGateway, type TargetRuntimeSnapshot } from '@mpgd/target-config';

export const SAVE_KEY = 'save:v1';

export interface DemoState {
  readonly player: PlayerIdentity;
  readonly capabilities: PlatformCapabilities;
  readonly targetRuntime: TargetRuntimeSnapshot | null;
  readonly locale: MpgdLocale;
  readonly save: SaveData;
}

export async function loadDemoState(platform: PlatformGateway): Promise<DemoState> {
  const [capabilities, player, targetRuntime] = await Promise.all([
    platform.getCapabilities().catch(() => createUnsupportedCapabilities()),
    platform.identity.getPlayer().catch(() => null),
    readTargetRuntime(platform),
  ]);
  const resolvedPlayer =
    player ??
    ({
      playerId: `${platform.target}-guest`,
      displayName: 'Guest Player',
    } satisfies PlayerIdentity);
  const loaded = await platform.storage.load({ key: SAVE_KEY }).catch(() => null);

  return {
    player: resolvedPlayer,
    capabilities,
    targetRuntime,
    locale: resolveMpgdLocale(capabilities),
    save: parseSaveData(loaded, resolvedPlayer.playerId),
  };
}

export async function persistDemoSave(
  platform: PlatformGateway,
  save: SaveData,
): Promise<void> {
  await platform.storage.save({
    key: SAVE_KEY,
    value: save,
  });
}

export function applyScoreToSave(save: SaveData, score: number, cleared: boolean): SaveData {
  return {
    ...save,
    bestScore: Math.max(save.bestScore, score),
    coins: save.coins + (cleared ? 25 : 5),
    updatedAt: new Date().toISOString(),
  };
}

export function addCoinsToSave(save: SaveData, coins: number): SaveData {
  return {
    ...save,
    coins: save.coins + coins,
    updatedAt: new Date().toISOString(),
  };
}

function parseSaveData(input: unknown, playerId: string): SaveData {
  if (
    typeof input === 'object' &&
    input !== null &&
    (input as Partial<SaveData>).version === 1 &&
    typeof (input as Partial<SaveData>).playerId === 'string' &&
    typeof (input as Partial<SaveData>).bestScore === 'number' &&
    typeof (input as Partial<SaveData>).coins === 'number' &&
    typeof (input as Partial<SaveData>).updatedAt === 'string'
  ) {
    return input as SaveData;
  }

  return {
    version: 1,
    playerId,
    bestScore: 0,
    coins: 0,
    updatedAt: new Date().toISOString(),
  };
}

async function readTargetRuntime(
  platform: PlatformGateway,
): Promise<TargetRuntimeSnapshot | null> {
  if (!isTargetConfiguredGateway(platform)) {
    return null;
  }

  return platform.getTargetRuntime().catch(() => null);
}
