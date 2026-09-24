package dev.mpgd.capacitor;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.fail;

import java.util.HashMap;
import java.util.Map;
import org.junit.Test;

public class SecureCredentialStorageTest {
    @Test
    public void storesOnlySealedValuesAndRemovesThem() throws Exception {
        FakeBackend backend = new FakeBackend();
        SecureCredentialStorage storage = new SecureCredentialStorage(new FakeCipher(), backend);

        assertNull(storage.load("session.refresh"));
        storage.save("session.refresh", "opaque-token-one");
        assertEquals("opaque-token-one", storage.load("session.refresh"));
        assertFalse(backend.values.get("session.refresh").contains("opaque-token-one"));
        storage.save("session.refresh", "opaque-token-two");
        assertEquals("opaque-token-two", storage.load("session.refresh"));
        storage.remove("session.refresh");
        assertNull(storage.load("session.refresh"));
    }

    @Test
    public void rejectsCorruptionAndBackendFailureWithoutPlaintextFallback() throws Exception {
        FakeBackend backend = new FakeBackend();
        SecureCredentialStorage storage = new SecureCredentialStorage(new FakeCipher(), backend);
        storage.save("session.refresh", "committed");
        backend.values.put("session.refresh", "plaintext-token");
        assertStorageError("NATIVE_CREDENTIAL_DECRYPT_FAILED", false,
            () -> storage.load("session.refresh"));

        backend.values.put("session.refresh", "sealed:other.key:token");
        assertStorageError("NATIVE_CREDENTIAL_DECRYPT_FAILED", false,
            () -> storage.load("session.refresh"));

        backend.failNextLoad = true;
        assertStorageError("NATIVE_CREDENTIAL_LOAD_FAILED", true,
            () -> storage.load("session.refresh"));
    }

    @Test
    public void rejectsInvalidInputAndPreservesCommittedValueOnSaveFailure() throws Exception {
        FakeBackend backend = new FakeBackend();
        SecureCredentialStorage storage = new SecureCredentialStorage(new FakeCipher(), backend);
        storage.save("session.refresh", "committed");
        assertStorageError("NATIVE_CREDENTIAL_INVALID_KEY", false,
            () -> storage.save("../unsafe", "secret"));
        assertStorageError("NATIVE_CREDENTIAL_INVALID_VALUE", false,
            () -> storage.save("session.refresh", ""));
        assertStorageError("NATIVE_CREDENTIAL_INVALID_VALUE", false,
            () -> storage.save("session.refresh", repeat("x", 17_000)));

        backend.failNextSave = true;
        assertStorageError("NATIVE_CREDENTIAL_SAVE_FAILED", true,
            () -> storage.save("session.refresh", "new-value"));
        assertEquals("committed", storage.load("session.refresh"));

        backend.failNextRemove = true;
        assertStorageError("NATIVE_CREDENTIAL_REMOVE_FAILED", true,
            () -> storage.remove("session.refresh"));
        assertEquals("committed", storage.load("session.refresh"));
    }

    private static void assertStorageError(
        String code, boolean retryable, ThrowingOperation operation
    ) throws Exception {
        try {
            operation.run();
            fail("Expected secure credential operation to fail.");
        } catch (SecureCredentialStorage.StorageException error) {
            assertEquals(code, error.getCode());
            assertEquals(retryable, error.isRetryable());
        }
    }

    private interface ThrowingOperation {
        void run() throws Exception;
    }

    private static String repeat(String value, int count) {
        StringBuilder result = new StringBuilder(value.length() * count);
        for (int index = 0; index < count; index += 1) result.append(value);
        return result.toString();
    }

    private static final class FakeCipher implements SecureCredentialStorage.CipherBackend {
        @Override
        public String seal(String key, String value) {
            return "sealed:" + key + ":" + new StringBuilder(value).reverse();
        }

        @Override
        public String open(String key, String ciphertext) throws Exception {
            String prefix = "sealed:" + key + ":";
            if (!ciphertext.startsWith(prefix)) throw new Exception("invalid ciphertext");
            return new StringBuilder(ciphertext.substring(prefix.length())).reverse().toString();
        }
    }

    private static final class FakeBackend implements SecureCredentialStorage.CiphertextBackend {
        private final Map<String, String> values = new HashMap<>();
        private boolean failNextLoad;
        private boolean failNextSave;
        private boolean failNextRemove;

        @Override
        public String get(String key) throws Exception {
            if (failNextLoad) {
                failNextLoad = false;
                throw new Exception("load failed");
            }
            return values.get(key);
        }

        @Override
        public void set(String key, String ciphertext) throws Exception {
            if (failNextSave) {
                failNextSave = false;
                throw new Exception("save failed");
            }
            values.put(key, ciphertext);
        }

        @Override
        public void remove(String key) throws Exception {
            if (failNextRemove) {
                failNextRemove = false;
                throw new Exception("remove failed");
            }
            values.remove(key);
        }
    }
}
