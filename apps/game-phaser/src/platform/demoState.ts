import type { SaveData } from '@mpgd/game-save';
import {
  createUnsupportedCapabilities,
  type PlatformCapabilities,
  type PlatformGateway,
  type PlayerIdentity,
} from '@mpgd/platform-contract';
import { isPolicyEnforcedGateway, type PolicyRuntimeSnapshot } from '@mpgd/policy-matrix';

export const SAVE_KEY = 'save:v1';

export interface DemoState {
  readonly player: PlayerIdentity;
  readonly capabilities: PlatformCapabilities;
  readonly policyRuntime: PolicyRuntimeSnapshot | null;
  readonly save: SaveData;
}

export async function loadDemoState(platform: PlatformGateway): Promise<DemoState> {
  const [capabilities, player, policyRuntime] = await Promise.all([
    platform.getCapabilities().catch(() => createUnsupportedCapabilities()),
    platform.identity.getPlayer().catch(() => null),
    readPolicyRuntime(platform),
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
    policyRuntime,
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

async function readPolicyRuntime(
  platform: PlatformGateway,
): Promise<PolicyRuntimeSnapshot | null> {
  if (!isPolicyEnforcedGateway(platform)) {
    return null;
  }

  return platform.getPolicyRuntime().catch(() => null);
}
