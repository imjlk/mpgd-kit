package dev.mpgd.capacitor;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Arrays;
import java.util.regex.Pattern;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Device-key-encrypted credentials, intentionally separate from game JSON storage. */
final class SecureCredentialStorage {
    private static final int MAXIMUM_VALUE_BYTES = 16 * 1024;
    private static final Pattern KEY_PATTERN = Pattern.compile("[A-Za-z0-9._:-]{1,128}");
    private static final String PREFERENCES = "dev.mpgd.capacitor.credentials.v1";
    private static final String KEY_ALIAS = "dev.mpgd.capacitor.credentials.aes.v1";
    private static final int IV_BYTES = 12;
    private static final byte FORMAT_VERSION = 1;

    interface CipherBackend {
        String seal(String key, String value) throws Exception;
        String open(String key, String ciphertext) throws Exception;
    }

    interface CiphertextBackend {
        String get(String key) throws Exception;
        void set(String key, String ciphertext) throws Exception;
        void remove(String key) throws Exception;
    }

    static final class StorageException extends Exception {
        private final String code;
        private final boolean retryable;

        StorageException(String code, boolean retryable) {
            super(code);
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

    private final CipherBackend cipher;
    private final CiphertextBackend backend;

    SecureCredentialStorage(Context context) {
        this(new KeystoreCipher(), new PreferencesBackend(context));
    }

    SecureCredentialStorage(CipherBackend cipher, CiphertextBackend backend) {
        this.cipher = cipher;
        this.backend = backend;
    }

    synchronized String load(String key) throws StorageException {
        validateKey(key);
        final String ciphertext;
        try {
            ciphertext = backend.get(key);
        } catch (Exception error) {
            throw new StorageException("NATIVE_CREDENTIAL_LOAD_FAILED", true);
        }
        if (ciphertext == null) {
            return null;
        }
        try {
            String value = cipher.open(key, ciphertext);
            validateValue(value);
            return value;
        } catch (MissingKeyException error) {
            throw new StorageException("NATIVE_CREDENTIAL_KEY_MISSING", false);
        } catch (Exception error) {
            // A corrupted value or restored ciphertext without its device key
            // is never treated as a missing credential or plaintext fallback.
            throw new StorageException("NATIVE_CREDENTIAL_DECRYPT_FAILED", false);
        }
    }

    synchronized void save(String key, String value) throws StorageException {
        validateKey(key);
        validateValue(value);
        final String ciphertext;
        try {
            ciphertext = cipher.seal(key, value);
        } catch (Exception error) {
            throw new StorageException("NATIVE_CREDENTIAL_STORE_UNAVAILABLE", false);
        }
        try {
            backend.set(key, ciphertext);
        } catch (Exception error) {
            throw new StorageException("NATIVE_CREDENTIAL_SAVE_FAILED", true);
        }
    }

    synchronized void remove(String key) throws StorageException {
        validateKey(key);
        try {
            backend.remove(key);
        } catch (Exception error) {
            throw new StorageException("NATIVE_CREDENTIAL_REMOVE_FAILED", true);
        }
    }

    private static void validateKey(String key) throws StorageException {
        if (key == null || !KEY_PATTERN.matcher(key).matches()) {
            throw new StorageException("NATIVE_CREDENTIAL_INVALID_KEY", false);
        }
    }

    private static void validateValue(String value) throws StorageException {
        if (value == null || value.isEmpty()
            || value.getBytes(StandardCharsets.UTF_8).length > MAXIMUM_VALUE_BYTES) {
            throw new StorageException("NATIVE_CREDENTIAL_INVALID_VALUE", false);
        }
    }

    private static final class MissingKeyException extends Exception { }

    private static final class PreferencesBackend implements CiphertextBackend {
        private final SharedPreferences preferences;

        PreferencesBackend(Context context) {
            preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
        }

        @Override
        public String get(String key) {
            return preferences.getString(key, null);
        }

        @Override
        public void set(String key, String ciphertext) throws Exception {
            if (!preferences.edit().putString(key, ciphertext).commit()) {
                throw new Exception("Encrypted credential commit failed.");
            }
        }

        @Override
        public void remove(String key) throws Exception {
            if (!preferences.edit().remove(key).commit()) {
                throw new Exception("Encrypted credential removal failed.");
            }
        }
    }

    private static final class KeystoreCipher implements CipherBackend {
        @Override
        public String seal(String key, String value) throws Exception {
            Cipher operation = Cipher.getInstance("AES/GCM/NoPadding");
            operation.init(Cipher.ENCRYPT_MODE, key(true));
            byte[] iv = operation.getIV();
            if (iv == null || iv.length != IV_BYTES) {
                throw new IllegalStateException("Keystore did not generate a GCM nonce.");
            }
            operation.updateAAD(key.getBytes(StandardCharsets.UTF_8));
            byte[] plaintext = value.getBytes(StandardCharsets.UTF_8);
            try {
                byte[] sealed = operation.doFinal(plaintext);
                byte[] packed = new byte[1 + IV_BYTES + sealed.length];
                packed[0] = FORMAT_VERSION;
                System.arraycopy(iv, 0, packed, 1, IV_BYTES);
                System.arraycopy(sealed, 0, packed, 1 + IV_BYTES, sealed.length);
                return Base64.encodeToString(packed, Base64.NO_WRAP);
            } finally {
                Arrays.fill(plaintext, (byte) 0);
            }
        }

        @Override
        public String open(String key, String ciphertext) throws Exception {
            byte[] packed = Base64.decode(ciphertext, Base64.NO_WRAP);
            if (packed.length < 1 + IV_BYTES + 16 || packed[0] != FORMAT_VERSION) {
                throw new IllegalArgumentException("Unsupported credential ciphertext format.");
            }
            byte[] iv = Arrays.copyOfRange(packed, 1, 1 + IV_BYTES);
            byte[] sealed = Arrays.copyOfRange(packed, 1 + IV_BYTES, packed.length);
            Cipher operation = Cipher.getInstance("AES/GCM/NoPadding");
            operation.init(Cipher.DECRYPT_MODE, key(false), new GCMParameterSpec(128, iv));
            operation.updateAAD(key.getBytes(StandardCharsets.UTF_8));
            byte[] plaintext = operation.doFinal(sealed);
            try {
                return new String(plaintext, StandardCharsets.UTF_8);
            } finally {
                Arrays.fill(plaintext, (byte) 0);
            }
        }

        private SecretKey key(boolean createIfMissing) throws Exception {
            KeyStore store = KeyStore.getInstance("AndroidKeyStore");
            store.load(null);
            SecretKey existing = (SecretKey) store.getKey(KEY_ALIAS, null);
            if (existing != null) {
                return existing;
            }
            if (!createIfMissing) {
                throw new MissingKeyException();
            }
            KeyGenerator generator = KeyGenerator.getInstance(
                KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore"
            );
            generator.init(new KeyGenParameterSpec.Builder(
                KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .setKeySize(256)
                .build());
            return generator.generateKey();
        }
    }
}
