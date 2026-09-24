package dev.mpgd.capacitor;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.AtomicFile;
import android.util.Base64;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.regex.Pattern;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Device-key-encrypted credentials in no-backup storage, separate from game JSON. */
final class SecureCredentialStorage {
    private static final int MAXIMUM_VALUE_BYTES = 16 * 1024;
    private static final int MAXIMUM_CIPHERTEXT_BYTES = 32 * 1024;
    private static final Pattern KEY_PATTERN = Pattern.compile("[A-Za-z0-9._:-]{1,128}");
    private static final String STORAGE_DIRECTORY = "dev.mpgd.capacitor.credentials.v1";
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
        this(new KeystoreCipher(), new NoBackupFileBackend(context));
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

    static boolean hasCommittedFile(File file) {
        return file.exists() || new File(file.getPath() + ".bak").exists();
    }

    private static final class MissingKeyException extends Exception { }

    private static final class NoBackupFileBackend implements CiphertextBackend {
        private final File directory;

        NoBackupFileBackend(Context context) {
            directory = new File(context.getNoBackupFilesDir(), STORAGE_DIRECTORY);
        }

        private File fileFor(String key) throws Exception {
            byte[] hash = MessageDigest.getInstance("SHA-256")
                .digest(key.getBytes(StandardCharsets.UTF_8));
            StringBuilder name = new StringBuilder(hash.length * 2 + 5);
            for (byte part : hash) {
                name.append(Character.forDigit((part >>> 4) & 0xf, 16));
                name.append(Character.forDigit(part & 0xf, 16));
            }
            return new File(directory, name.append(".blob").toString());
        }

        private boolean hasStoredFile(File file) {
            return hasCommittedFile(file) || new File(file.getPath() + ".new").exists();
        }

        @Override
        public String get(String key) throws Exception {
            File file = fileFor(key);
            if (!hasCommittedFile(file)) {
                return null;
            }
            try (FileInputStream input = new AtomicFile(file).openRead();
                 ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                byte[] chunk = new byte[4096];
                int count;
                while ((count = input.read(chunk)) != -1) {
                    if (output.size() + count > MAXIMUM_CIPHERTEXT_BYTES) {
                        throw new IOException("Encrypted credential exceeded its size limit.");
                    }
                    output.write(chunk, 0, count);
                }
                return output.toString(StandardCharsets.UTF_8.name());
            }
        }

        @Override
        public void set(String key, String ciphertext) throws Exception {
            if (!directory.isDirectory() && !directory.mkdirs()) {
                throw new IOException("Secure credential directory could not be created.");
            }
            AtomicFile file = new AtomicFile(fileFor(key));
            FileOutputStream output = file.startWrite();
            try {
                output.write(ciphertext.getBytes(StandardCharsets.UTF_8));
                file.finishWrite(output);
            } catch (Exception error) {
                file.failWrite(output);
                throw error;
            }
        }

        @Override
        public void remove(String key) throws Exception {
            File file = fileFor(key);
            AtomicFile atomic = new AtomicFile(file);
            atomic.delete();
            if (hasStoredFile(file)) {
                throw new IOException("Encrypted credential removal failed.");
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
