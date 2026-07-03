import typia from 'typia';

export interface SaveDataV1 {
  readonly version: 1;
  readonly playerId: string;
  readonly bestScore: number;
  readonly coins: number;
  readonly updatedAt: string;
}

export type SaveData = SaveDataV1;

export const assertSaveData = typia.createAssert<SaveData>();

export function createDefaultSave(playerId: string, now: string): SaveData {
  return {
    version: 1,
    playerId,
    bestScore: 0,
    coins: 0,
    updatedAt: now,
  };
}
