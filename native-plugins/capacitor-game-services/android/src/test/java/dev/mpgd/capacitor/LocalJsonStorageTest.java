package dev.mpgd.capacitor;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.fail;

import java.util.HashMap;
import java.util.Map;
import org.junit.Test;

public class LocalJsonStorageTest {
    @Test
    public void roundTripsOverwritesAndIsolatesStorageAreas() throws Exception {
        FakeBackend primaryBackend = new FakeBackend();
        FakeBackend isolatedBackend = new FakeBackend();
        LocalJsonStorage primary = new LocalJsonStorage(primaryBackend, 64);
        LocalJsonStorage isolated = new LocalJsonStorage(isolatedBackend, 64);

        assertNull(primary.load("save"));
        primary.save("save", "{\"revision\":1}");
        assertEquals("{\"revision\":1}", primary.load("save"));
        assertNull(isolated.load("save"));

        primary.save("save", "{\"revision\":2}");
        isolated.save("save", "{\"owner\":\"isolated\"}");
        assertEquals("{\"revision\":2}", primary.load("save"));
        assertEquals("{\"owner\":\"isolated\"}", isolated.load("save"));
    }

    @Test
    public void quotaAndSaveFailuresPreserveTheCommittedValue() throws Exception {
        FakeBackend backend = new FakeBackend();
        LocalJsonStorage storage = new LocalJsonStorage(backend, 32);
        storage.save("save", "{\"revision\":1}");

        assertStorageError(
            "NATIVE_STORAGE_QUOTA_EXCEEDED",
            false,
            () -> storage.save("save", repeat("x", 64))
        );
        assertEquals("{\"revision\":1}", storage.load("save"));

        backend.failNextSave = true;
        assertStorageError(
            "NATIVE_STORAGE_SAVE_FAILED",
            true,
            () -> storage.save("save", "{\"revision\":2}")
        );
        assertEquals("{\"revision\":1}", storage.load("save"));
    }

    @Test
    public void loadFailuresRejectInsteadOfReportingMissing() throws Exception {
        FakeBackend backend = new FakeBackend();
        LocalJsonStorage storage = new LocalJsonStorage(backend, 64);
        storage.save("save", "{\"revision\":1}");
        backend.failNextLoad = true;

        assertStorageError("NATIVE_STORAGE_LOAD_FAILED", true, () -> storage.load("save"));
        assertEquals("{\"revision\":1}", storage.load("save"));
    }

    private static void assertStorageError(
        String code,
        boolean retryable,
        ThrowingOperation operation
    ) throws Exception {
        try {
            operation.run();
            fail("Expected native storage operation to fail.");
        } catch (LocalJsonStorage.StorageException error) {
            assertEquals(code, error.getCode());
            assertEquals(retryable, error.isRetryable());
        }
    }

    private interface ThrowingOperation {
        void run() throws Exception;
    }

    private static String repeat(String value, int count) {
        StringBuilder result = new StringBuilder(value.length() * count);

        for (int index = 0; index < count; index += 1) {
            result.append(value);
        }

        return result.toString();
    }

    private static final class FakeBackend implements LocalJsonStorage.Backend {
        private final Map<String, String> values = new HashMap<>();
        private boolean failNextLoad;
        private boolean failNextSave;

        @Override
        public String get(String key) throws Exception {
            if (failNextLoad) {
                failNextLoad = false;
                throw new Exception("simulated load failure");
            }

            return values.get(key);
        }

        @Override
        public boolean put(String key, String value) {
            if (failNextSave) {
                failNextSave = false;
                return false;
            }

            values.put(key, value);
            return true;
        }
    }
}
