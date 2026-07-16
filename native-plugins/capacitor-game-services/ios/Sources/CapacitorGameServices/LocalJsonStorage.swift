import Foundation

protocol LocalJsonStorageBackend {
    func string(forKey key: String) throws -> String?
    func set(_ value: String, forKey key: String) throws
}

enum LocalJsonStorageError: Error {
    case quotaExceeded
    case loadFailed
    case saveFailed

    var bridgeCode: String {
        switch self {
        case .quotaExceeded:
            return "NATIVE_STORAGE_QUOTA_EXCEEDED"
        case .loadFailed:
            return "NATIVE_STORAGE_LOAD_FAILED"
        case .saveFailed:
            return "NATIVE_STORAGE_SAVE_FAILED"
        }
    }

    var bridgeMessage: String {
        switch self {
        case .quotaExceeded:
            return "Native storage value exceeds the configured UTF-8 byte limit."
        case .loadFailed:
            return "Native storage could not be loaded."
        case .saveFailed:
            return "Native storage could not be saved."
        }
    }

    var retryable: Bool {
        switch self {
        case .quotaExceeded:
            return false
        case .loadFailed, .saveFailed:
            return true
        }
    }
}

struct LocalJsonStorage {
    static let defaultMaximumValueBytes = 262_144
    private static let storageKeyPrefix = "mpgd:storage:"

    private let backend: LocalJsonStorageBackend
    private let maximumValueBytes: Int

    init(
        backend: LocalJsonStorageBackend,
        maximumValueBytes: Int = LocalJsonStorage.defaultMaximumValueBytes
    ) {
        self.backend = backend
        self.maximumValueBytes = maximumValueBytes
    }

    func load(key: String) throws -> String? {
        do {
            return try backend.string(forKey: storageKey(key))
        } catch {
            throw LocalJsonStorageError.loadFailed
        }
    }

    func save(key: String, serializedValue: String) throws {
        guard serializedValue.utf8.count <= maximumValueBytes else {
            throw LocalJsonStorageError.quotaExceeded
        }

        do {
            try backend.set(serializedValue, forKey: storageKey(key))
        } catch {
            throw LocalJsonStorageError.saveFailed
        }
    }

    private func storageKey(_ key: String) -> String {
        return LocalJsonStorage.storageKeyPrefix + key
    }
}

struct UserDefaultsLocalJsonStorageBackend: LocalJsonStorageBackend {
    let defaults: UserDefaults

    func string(forKey key: String) throws -> String? {
        return defaults.string(forKey: key)
    }

    func set(_ value: String, forKey key: String) throws {
        defaults.set(value, forKey: key)
    }
}
