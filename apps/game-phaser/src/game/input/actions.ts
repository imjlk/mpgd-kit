export const gameplayActions = ['hit-target', 'miss', 'return-lobby'] as const;

export type GameplayAction = (typeof gameplayActions)[number];
export type GameplayActionSource = 'pointer' | 'keyboard' | 'test';

export interface GameplayInputEvent {
  readonly action: GameplayAction;
  readonly source: GameplayActionSource;
}

export interface GameplayActionBinding {
  readonly action: GameplayAction;
  readonly pointer?: 'target' | 'background';
  readonly keyboard?: readonly string[];
}

export const gameplayActionBindings = [
  {
    action: 'hit-target',
    pointer: 'target',
    keyboard: ['Space'],
  },
  {
    action: 'miss',
    pointer: 'background',
    keyboard: ['M'],
  },
  {
    action: 'return-lobby',
    keyboard: ['Escape'],
  },
] as const satisfies readonly GameplayActionBinding[];

export function isGameplayAction(value: string): value is GameplayAction {
  return gameplayActions.includes(value as GameplayAction);
}
