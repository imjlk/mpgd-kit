import { describe, expect, it } from 'vitest';

import {
  isShareCompleted,
  resolveShareCompletion,
  type LogicalAdPlacementId,
  type LogicalProductId,
} from './index';

const gameOwnedProductId = 'SUDOKU_THEME_PACK' satisfies LogicalProductId;
const gameOwnedAdPlacementId = 'SUDOKU_HINT_REWARDED' satisfies LogicalAdPlacementId;
const starterProductId = 'COINS_100' satisfies LogicalProductId;
const starterAdPlacementId = 'CONTINUE_AFTER_FAIL' satisfies LogicalAdPlacementId;

void gameOwnedProductId;
void gameOwnedAdPlacementId;
void starterProductId;
void starterAdPlacementId;

describe('share completion semantics', () => {
  it('preserves legacy shared results as completed', () => {
    const result = { status: 'shared' } as const;

    expect(resolveShareCompletion(result)).toBe('completed');
    expect(isShareCompleted(result)).toBe(true);
  });

  it('distinguishes a presented share surface from completed sharing', () => {
    const result = { status: 'shared', completion: 'presented' } as const;

    expect(resolveShareCompletion(result)).toBe('presented');
    expect(isShareCompleted(result)).toBe(false);
  });

  it('does not attach completion meaning to unsuccessful results', () => {
    expect(resolveShareCompletion({ status: 'cancelled' })).toBeUndefined();
    expect(resolveShareCompletion({ status: 'unavailable' })).toBeUndefined();
    expect(isShareCompleted({ status: 'cancelled' })).toBe(false);
  });
});
