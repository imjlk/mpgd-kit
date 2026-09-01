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
        serializedValue = JSON.stringify(value, rejectLossyJsonValue);
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

function rejectLossyJsonValue(_key: string, value: unknown): unknown {
  if (
    value === undefined
    || typeof value === 'function'
    || typeof value === 'symbol'
    || typeof value === 'bigint'
    || (typeof value === 'number' && (!Number.isFinite(value) || Object.is(value, -0)))
  ) {
    throw new Error('Value cannot round-trip through JSON storage.');
  }

  return value;
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
