import { PlatformOperationError, type StorageAdapter } from '@mpgd/platform';

import type { WechatMiniGameApi } from './api.js';

const defaultStoragePrefix = 'mpgd:';
const storageSchemaVersion = 1;

interface StoredWechatValue {
  readonly schemaVersion: typeof storageSchemaVersion;
  readonly value: unknown;
}

export function createWechatStorageAdapter(
  api: WechatMiniGameApi,
  keyPrefix = defaultStoragePrefix,
): StorageAdapter {
  if (keyPrefix.length === 0) {
    throw new PlatformOperationError({
      code: 'WECHAT_STORAGE_PREFIX_INVALID',
      message: 'WeChat storage key prefix must not be empty.',
      retryable: false,
    });
  }

  return {
    async load({ key }) {
      let stored: unknown;

      try {
        stored = api.getStorageSync(toStorageKey(keyPrefix, key));
      } catch {
        throw storageError('WECHAT_STORAGE_LOAD_FAILED', 'Failed to load WeChat storage.');
      }

      if (stored === undefined || stored === null || stored === '') {
        return null;
      }

      if (typeof stored !== 'string') {
        throw storageError(
          'WECHAT_STORAGE_VALUE_INVALID',
          'Stored WeChat value is not an mpgd JSON envelope.',
        );
      }

      try {
        const parsed = JSON.parse(stored) as unknown;

        if (!isStoredWechatValue(parsed)) {
          throw new Error('Invalid storage envelope.');
        }

        return { value: parsed.value };
      } catch {
        throw storageError(
          'WECHAT_STORAGE_VALUE_INVALID',
          'Stored WeChat value is not a valid mpgd JSON envelope.',
        );
      }
    },
    async save({ key, value }) {
      const storageKey = toStorageKey(keyPrefix, key);
      let serializedValue: string | undefined;

      try {
        assertJsonRoundTripValue(value);
        serializedValue = JSON.stringify(value);
      } catch {
        throw storageError(
          'WECHAT_STORAGE_VALUE_NOT_SERIALIZABLE',
          'WeChat storage values must be JSON serializable.',
        );
      }

      if (serializedValue === undefined) {
        throw storageError(
          'WECHAT_STORAGE_VALUE_NOT_SERIALIZABLE',
          'WeChat storage values must be JSON serializable.',
        );
      }
      const serialized = `{"schemaVersion":${String(storageSchemaVersion)},"value":${serializedValue}}`;

      try {
        api.setStorageSync(storageKey, serialized);
      } catch {
        throw storageError(
          'WECHAT_STORAGE_SAVE_FAILED',
          'Failed to save WeChat storage. The platform quota may be exhausted.',
        );
      }
    },
  };
}

function assertJsonRoundTripValue(value: unknown, ancestors = new Set<object>()): void {
  if (
    value === undefined
    || typeof value === 'function'
    || typeof value === 'symbol'
    || typeof value === 'bigint'
    || (typeof value === 'number' && (!Number.isFinite(value) || Object.is(value, -0)))
  ) {
    throw new Error('Value cannot round-trip through JSON storage.');
  }

  if (value === null || typeof value !== 'object') {
    return;
  }
  if (ancestors.has(value)) {
    throw new Error('Cyclic values cannot round-trip through JSON storage.');
  }

  const prototype = Object.getPrototypeOf(value) as unknown;

  if (Array.isArray(value)) {
    if (prototype !== Array.prototype) {
      throw new Error('Array subclasses cannot round-trip through JSON storage.');
    }
  } else if (prototype !== Object.prototype && prototype !== null) {
    throw new Error('Only plain objects can round-trip through JSON storage.');
  }

  ancestors.add(value);

  try {
    if (Array.isArray(value)) {
      assertJsonArray(value, ancestors);
    } else {
      assertJsonObject(value, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

function assertJsonArray(value: readonly unknown[], ancestors: Set<object>): void {
  let indexedValues = 0;

  for (const key of Reflect.ownKeys(value)) {
    if (key === 'length') {
      continue;
    }
    if (typeof key !== 'string' || !isCanonicalArrayIndex(key, value.length)) {
      throw new Error('Arrays with custom properties cannot round-trip through JSON storage.');
    }

    const descriptor = Object.getOwnPropertyDescriptor(value, key);

    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new Error('Array accessors cannot round-trip through JSON storage.');
    }
    indexedValues += 1;
    assertJsonRoundTripValue(descriptor.value, ancestors);
  }

  if (indexedValues !== value.length) {
    throw new Error('Sparse arrays cannot round-trip through JSON storage.');
  }
}

function assertJsonObject(value: object, ancestors: Set<object>): void {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') {
      throw new Error('Symbol properties cannot round-trip through JSON storage.');
    }

    const descriptor = Object.getOwnPropertyDescriptor(value, key);

    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new Error('Object accessors cannot round-trip through JSON storage.');
    }
    assertJsonRoundTripValue(descriptor.value, ancestors);
  }
}

function isCanonicalArrayIndex(key: string, length: number): boolean {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(key)) {
    return false;
  }

  const index = Number(key);

  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key;
}

function toStorageKey(prefix: string, key: string): string {
  const normalized = key.trim();

  if (normalized.length === 0 || normalized !== key) {
    throw storageError(
      'WECHAT_STORAGE_KEY_INVALID',
      'WeChat storage keys must be non-empty and have no surrounding whitespace.',
    );
  }

  return `${prefix}${normalized}`;
}

function isStoredWechatValue(input: unknown): input is StoredWechatValue {
  return typeof input === 'object'
    && input !== null
    && !Array.isArray(input)
    && (input as Record<string, unknown>).schemaVersion === storageSchemaVersion
    && Object.prototype.hasOwnProperty.call(input, 'value');
}

function storageError(code: string, message: string): PlatformOperationError {
  return new PlatformOperationError({ code, message, retryable: false });
}
