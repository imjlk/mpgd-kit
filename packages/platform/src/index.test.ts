import { describe, expect, it } from 'vitest';

import {
  isShareCompleted,
  PlatformOperationError,
  readPlatformOperationFailure,
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

describe('platform operation failures', () => {
  it('preserves a safe code and retry hint across adapter boundaries', () => {
    const error = new PlatformOperationError({
      code: 'AIT_IAP_CATALOG_UNAVAILABLE',
      message: 'The native catalog is unavailable.',
      retryable: true,
    });

    expect(error).toMatchObject({
      name: 'PlatformOperationError',
      code: 'AIT_IAP_CATALOG_UNAVAILABLE',
      message: 'The native catalog is unavailable.',
      retryable: true,
    });
    expect(readPlatformOperationFailure(error)).toEqual({
      code: 'AIT_IAP_CATALOG_UNAVAILABLE',
      retryable: true,
    });
  });

  it('accepts a cross-realm structural failure but rejects unsafe codes', () => {
    expect(readPlatformOperationFailure({
      code: 'MOBILE_STORE_UNAVAILABLE',
      retryable: false,
    })).toEqual({ code: 'MOBILE_STORE_UNAVAILABLE', retryable: false });
    expect(readPlatformOperationFailure({
      code: 'provider message with spaces',
      retryable: true,
    })).toBeNull();

    const normalized = new PlatformOperationError({
      code: 'unsafe provider message',
      message: 'The provider rejected the operation.',
      retryable: false,
    });
    expect(normalized.code).toBe('PLATFORM_OPERATION_FAILED');

    const malformed = new PlatformOperationError({
      code: undefined,
      message: 'An older bridge omitted diagnostics.',
      retryable: undefined,
    });
    expect(readPlatformOperationFailure(malformed)).toEqual({
      code: 'PLATFORM_OPERATION_FAILED',
      retryable: false,
    });

    const missing = new PlatformOperationError();
    expect(missing).toMatchObject({
      code: 'PLATFORM_OPERATION_FAILED',
      message: 'The platform operation failed.',
      retryable: false,
    });
  });
});
