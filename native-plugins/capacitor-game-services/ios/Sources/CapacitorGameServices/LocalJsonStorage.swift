import CryptoKit
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
    static let storageKeyPrefix = "mpgd:storage:"

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

private enum FileLocalJsonStorageBackendError: Error {
    case applicationSupportDirectoryUnavailable
    case expectedFile
}

struct FileLocalJsonStorageBackend: LocalJsonStorageBackend {
    private let fileManager: FileManager
    private let directoryURL: URL?

    init(
        fileManager: FileManager = .default,
        directoryURL: URL? = nil
    ) {
        self.fileManager = fileManager
        self.directoryURL = directoryURL ?? fileManager
            .urls(for: .applicationSupportDirectory, in: .userDomainMask)
            .first?
            .appendingPathComponent("mpgd-local-storage-v1", isDirectory: true)
    }

    func string(forKey key: String) throws -> String? {
        let fileURL = try storageFileURL(forKey: key)
        var isDirectory: ObjCBool = false

        guard fileManager.fileExists(atPath: fileURL.path, isDirectory: &isDirectory) else {
            return nil
        }

        guard !isDirectory.boolValue else {
            throw FileLocalJsonStorageBackendError.expectedFile
        }

        return try String(contentsOf: fileURL, encoding: .utf8)
    }

    func set(_ value: String, forKey key: String) throws {
        let directoryURL = try requiredDirectoryURL()
        try fileManager.createDirectory(
            at: directoryURL,
            withIntermediateDirectories: true
        )
        try Data(value.utf8).write(
            to: try storageFileURL(forKey: key),
            options: .atomic
        )
    }

    private func storageFileURL(forKey key: String) throws -> URL {
        let digest = SHA256.hash(data: Data(key.utf8))
        let filename = digest.map { String(format: "%02x", $0) }.joined() + ".json"
        return try requiredDirectoryURL().appendingPathComponent(filename, isDirectory: false)
    }

    private func requiredDirectoryURL() throws -> URL {
        guard let directoryURL else {
            throw FileLocalJsonStorageBackendError.applicationSupportDirectoryUnavailable
        }

        return directoryURL
    }
}

final class MigratingFileLocalJsonStorageBackend: LocalJsonStorageBackend {
    private let backend: FileLocalJsonStorageBackend
    private let legacyDefaults: UserDefaults
    private let migrationLock = NSLock()
    private var didMigrateLegacyValues = false

    init(
        backend: FileLocalJsonStorageBackend,
        legacyDefaults: UserDefaults
    ) {
        self.backend = backend
        self.legacyDefaults = legacyDefaults
    }

    func string(forKey key: String) throws -> String? {
        try migrateLegacyValuesIfNeeded()
        return try backend.string(forKey: key)
    }

    func set(_ value: String, forKey key: String) throws {
        try migrateLegacyValuesIfNeeded()
        try backend.set(value, forKey: key)
    }

    private func migrateLegacyValuesIfNeeded() throws {
        migrationLock.lock()
        defer { migrationLock.unlock() }

        guard !didMigrateLegacyValues else {
            return
        }

        let legacyValues: [(key: String, value: String)] = legacyDefaults
            .dictionaryRepresentation()
            .compactMap { key, value in
                guard
                    key.hasPrefix(LocalJsonStorage.storageKeyPrefix),
                    let serializedValue = value as? String
                else {
                    return nil
                }

                return (key: key, value: serializedValue)
            }
            .sorted { $0.key < $1.key }

        for legacyValue in legacyValues {
            try backend.set(legacyValue.value, forKey: legacyValue.key)
            legacyDefaults.removeObject(forKey: legacyValue.key)
        }

        didMigrateLegacyValues = true
    }
}
