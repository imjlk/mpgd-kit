import Foundation
import Security

protocol SecureCredentialBackend {
    func load(key: String) throws -> String?
    func save(key: String, value: String) throws
    func remove(key: String) throws
}

enum SecureCredentialStorageError: Error {
    case invalidKey
    case invalidValue
    case loadFailed
    case corruptValue
    case saveFailed
    case removeFailed

    var bridgeCode: String {
        switch self {
        case .invalidKey: return "NATIVE_CREDENTIAL_INVALID_KEY"
        case .invalidValue: return "NATIVE_CREDENTIAL_INVALID_VALUE"
        case .loadFailed: return "NATIVE_CREDENTIAL_LOAD_FAILED"
        case .corruptValue: return "NATIVE_CREDENTIAL_DECRYPT_FAILED"
        case .saveFailed: return "NATIVE_CREDENTIAL_SAVE_FAILED"
        case .removeFailed: return "NATIVE_CREDENTIAL_REMOVE_FAILED"
        }
    }

    var retryable: Bool {
        switch self {
        case .loadFailed, .saveFailed, .removeFailed: return true
        case .invalidKey, .invalidValue, .corruptValue: return false
        }
    }
}

/** Keychain-backed opaque credentials, never migrated through game JSON storage. */
final class SecureCredentialStorage {
    private static let maximumValueBytes = 16 * 1024
    private let backend: SecureCredentialBackend
    private let lock = NSLock()

    init(backend: SecureCredentialBackend = KeychainCredentialBackend()) {
        self.backend = backend
    }

    func load(key: String) throws -> String? {
        try Self.validate(key: key)
        lock.lock()
        defer { lock.unlock() }
        do {
            guard let value = try backend.load(key: key) else { return nil }
            do {
                try Self.validate(value: value)
            } catch {
                throw SecureCredentialStorageError.corruptValue
            }
            return value
        } catch let error as SecureCredentialStorageError {
            throw error
        } catch {
            throw SecureCredentialStorageError.loadFailed
        }
    }

    func save(key: String, value: String) throws {
        try Self.validate(key: key)
        try Self.validate(value: value)
        lock.lock()
        defer { lock.unlock() }
        do {
            try backend.save(key: key, value: value)
        } catch let error as SecureCredentialStorageError {
            throw error
        } catch {
            throw SecureCredentialStorageError.saveFailed
        }
    }

    func remove(key: String) throws {
        try Self.validate(key: key)
        lock.lock()
        defer { lock.unlock() }
        do {
            try backend.remove(key: key)
        } catch let error as SecureCredentialStorageError {
            throw error
        } catch {
            throw SecureCredentialStorageError.removeFailed
        }
    }

    private static func validate(key: String) throws {
        let scalars = key.unicodeScalars
        guard (1...128).contains(scalars.count), scalars.allSatisfy({ scalar in
            (65...90).contains(scalar.value) || (97...122).contains(scalar.value)
                || (48...57).contains(scalar.value)
                || [46, 95, 58, 45].contains(scalar.value)
        }) else {
            throw SecureCredentialStorageError.invalidKey
        }
    }

    private static func validate(value: String) throws {
        guard !value.isEmpty, value.utf8.count <= maximumValueBytes else {
            throw SecureCredentialStorageError.invalidValue
        }
    }
}

/** Device-only Keychain items are not synced or migrated to a new device. */
private final class KeychainCredentialBackend: SecureCredentialBackend {
    private let service = "dev.mpgd.capacitor.credentials.v1"

    func load(key: String) throws -> String? {
        var query = baseQuery(key: key)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else {
            throw SecureCredentialStorageError.loadFailed
        }
        guard let data = result as? Data, let value = String(data: data, encoding: .utf8) else {
            throw SecureCredentialStorageError.corruptValue
        }
        return value
    }

    func save(key: String, value: String) throws {
        let data = Data(value.utf8)
        var attributes = baseQuery(key: key)
        attributes[kSecValueData as String] = data
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        let status = SecItemAdd(attributes as CFDictionary, nil)
        if status == errSecSuccess { return }
        guard status == errSecDuplicateItem else {
            throw SecureCredentialStorageError.saveFailed
        }
        let update = [kSecValueData as String: data] as CFDictionary
        guard SecItemUpdate(baseQuery(key: key) as CFDictionary, update) == errSecSuccess else {
            throw SecureCredentialStorageError.saveFailed
        }
    }

    func remove(key: String) throws {
        let status = SecItemDelete(baseQuery(key: key) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw SecureCredentialStorageError.removeFailed
        }
    }

    private func baseQuery(key: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecAttrSynchronizable as String: false
        ]
    }
}
