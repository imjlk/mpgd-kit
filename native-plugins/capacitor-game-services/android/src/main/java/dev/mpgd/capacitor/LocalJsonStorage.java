package dev.mpgd.capacitor;

import java.nio.charset.StandardCharsets;

final class LocalJsonStorage {
    static final int DEFAULT_MAXIMUM_VALUE_BYTES = 262_144;
    private static final String STORAGE_KEY_PREFIX = "mpgd:storage:";

    interface Backend {
        String get(String key) throws Exception;

        boolean put(String key, String value) throws Exception;
    }

    static final class StorageException extends Exception {
        private final String code;
        private final boolean retryable;

        StorageException(String code, String message, boolean retryable) {
            super(message);
            this.code = code;
            this.retryable = retryable;
        }

        String getCode() {
            return code;
        }

        boolean isRetryable() {
            return retryable;
        }
    }

    private final Backend backend;
    private final int maximumValueBytes;

    LocalJsonStorage(Backend backend) {
        this(backend, DEFAULT_MAXIMUM_VALUE_BYTES);
    }

    LocalJsonStorage(Backend backend, int maximumValueBytes) {
        this.backend = backend;
        this.maximumValueBytes = maximumValueBytes;
    }

    String load(String key) throws StorageException {
        try {
            return backend.get(storageKey(key));
        } catch (Exception error) {
            throw new StorageException(
                "NATIVE_STORAGE_LOAD_FAILED",
                "Native storage could not be loaded.",
                true
            );
        }
    }

    void save(String key, String serializedValue) throws StorageException {
        if (serializedValue.getBytes(StandardCharsets.UTF_8).length > maximumValueBytes) {
            throw new StorageException(
                "NATIVE_STORAGE_QUOTA_EXCEEDED",
                "Native storage value exceeds the configured UTF-8 byte limit.",
                false
            );
        }

        try {
            if (!backend.put(storageKey(key), serializedValue)) {
                throw new StorageException(
                    "NATIVE_STORAGE_SAVE_FAILED",
                    "Native storage could not be saved.",
                    true
                );
            }
        } catch (StorageException error) {
            throw error;
        } catch (Exception error) {
            throw new StorageException(
                "NATIVE_STORAGE_SAVE_FAILED",
                "Native storage could not be saved.",
                true
            );
        }
    }

    private String storageKey(String key) {
        return STORAGE_KEY_PREFIX + key;
    }
}
