import Foundation

private enum SimulatedFailure: Error {
    case load
    case save
}

private final class FakeBackend: LocalJsonStorageBackend {
    var values: [String: String] = [:]
    var failNextLoad = false
    var failNextSave = false

    func string(forKey key: String) throws -> String? {
        if failNextLoad {
            failNextLoad = false
            throw SimulatedFailure.load
        }

        return values[key]
    }

    func set(_ value: String, forKey key: String) throws {
        if failNextSave {
            failNextSave = false
            throw SimulatedFailure.save
        }

        values[key] = value
    }
}

private func require(_ condition: Bool, _ message: String) {
    guard condition else {
        fatalError(message)
    }
}

private func requireStorageError(
    code: String,
    retryable: Bool,
    operation: () throws -> Void
) {
    do {
        try operation()
        fatalError("Expected native storage operation to fail.")
    } catch let error as LocalJsonStorageError {
        require(error.bridgeCode == code, "Unexpected storage error code: \(error.bridgeCode)")
        require(error.retryable == retryable, "Unexpected storage retryability.")
    } catch {
        fatalError("Unexpected native storage error: \(error)")
    }
}

private func runConformance() throws {
    let primaryBackend = FakeBackend()
    let isolatedBackend = FakeBackend()
    let primary = LocalJsonStorage(backend: primaryBackend, maximumValueBytes: 32)
    let isolated = LocalJsonStorage(backend: isolatedBackend, maximumValueBytes: 32)

    require(try primary.load(key: "save") == nil, "Missing values must return nil.")
    try primary.save(key: "save", serializedValue: "{\"revision\":1}")
    require(
        try primary.load(key: "save") == "{\"revision\":1}",
        "Saved values must round-trip."
    )
    require(try isolated.load(key: "save") == nil, "Storage areas must be isolated.")

    try primary.save(key: "save", serializedValue: "{\"revision\":2}")
    try isolated.save(key: "save", serializedValue: "{\"owner\":\"isolated\"}")
    require(
        try primary.load(key: "save") == "{\"revision\":2}",
        "Later saves must overwrite the same key."
    )
    require(
        try isolated.load(key: "save") == "{\"owner\":\"isolated\"}",
        "The isolated area must retain its own value."
    )

    requireStorageError(code: "NATIVE_STORAGE_QUOTA_EXCEEDED", retryable: false) {
        try primary.save(key: "save", serializedValue: String(repeating: "x", count: 64))
    }
    require(
        try primary.load(key: "save") == "{\"revision\":2}",
        "Quota rejection must preserve the committed value."
    )

    primaryBackend.failNextSave = true
    requireStorageError(code: "NATIVE_STORAGE_SAVE_FAILED", retryable: true) {
        try primary.save(key: "save", serializedValue: "{\"revision\":3}")
    }
    require(
        try primary.load(key: "save") == "{\"revision\":2}",
        "Save failure must preserve the committed value."
    )

    primaryBackend.failNextLoad = true
    requireStorageError(code: "NATIVE_STORAGE_LOAD_FAILED", retryable: true) {
        _ = try primary.load(key: "save")
    }
    require(
        try primary.load(key: "save") == "{\"revision\":2}",
        "A later load must recover after a transient failure."
    )

    try runFileBackendConformance()
}

private func runFileBackendConformance() throws {
    let fileManager = FileManager.default
    let root = fileManager.temporaryDirectory
        .appendingPathComponent("mpgd-native-storage-\(UUID().uuidString)", isDirectory: true)

    defer {
        try? fileManager.removeItem(at: root)
    }

    let fileStorage = LocalJsonStorage(
        backend: FileLocalJsonStorageBackend(fileManager: fileManager, directoryURL: root),
        maximumValueBytes: 64
    )
    try fileStorage.save(key: "save", serializedValue: "null")
    require(
        try fileStorage.load(key: "save") == "null",
        "The atomic file backend must round-trip a top-level JSON null."
    )

    try runLegacyMigrationConformance(fileManager: fileManager, root: root)

    let blockedDirectory = root.appendingPathComponent("blocked", isDirectory: false)
    try Data("not-a-directory".utf8).write(to: blockedDirectory, options: .atomic)
    let failingStorage = LocalJsonStorage(
        backend: FileLocalJsonStorageBackend(
            fileManager: fileManager,
            directoryURL: blockedDirectory
        ),
        maximumValueBytes: 64
    )
    requireStorageError(code: "NATIVE_STORAGE_SAVE_FAILED", retryable: true) {
        try failingStorage.save(key: "save", serializedValue: "{\"revision\":1}")
    }

    try runFailedLegacyMigrationConformance(
        fileManager: fileManager,
        blockedDirectory: blockedDirectory
    )
}

private func runLegacyMigrationConformance(
    fileManager: FileManager,
    root: URL
) throws {
    let suiteName = "dev.mpgd.local-storage-migration.\(UUID().uuidString)"

    guard let legacyDefaults = UserDefaults(suiteName: suiteName) else {
        fatalError("Expected an isolated UserDefaults suite.")
    }

    defer {
        legacyDefaults.removePersistentDomain(forName: suiteName)
    }

    let legacyStorageKey = LocalJsonStorage.storageKeyPrefix + "legacy-save"
    legacyDefaults.set("{\"revision\":1}", forKey: legacyStorageKey)
    let migrationDirectory = root.appendingPathComponent("migrated", isDirectory: true)
    let backend = MigratingFileLocalJsonStorageBackend(
        backend: FileLocalJsonStorageBackend(
            fileManager: fileManager,
            directoryURL: migrationDirectory
        ),
        legacyDefaults: legacyDefaults
    )
    let storage = LocalJsonStorage(backend: backend, maximumValueBytes: 64)

    require(
        try storage.load(key: "legacy-save") == "{\"revision\":1}",
        "The file backend must expose migrated UserDefaults values on first access."
    )
    require(
        legacyDefaults.object(forKey: legacyStorageKey) == nil,
        "A legacy UserDefaults value must be removed after its file write succeeds."
    )
    try storage.save(key: "legacy-save", serializedValue: "{\"revision\":2}")
    require(
        try storage.load(key: "legacy-save") == "{\"revision\":2}",
        "Normal file-backed saves must continue after migration."
    )
}

private func runFailedLegacyMigrationConformance(
    fileManager: FileManager,
    blockedDirectory: URL
) throws {
    let suiteName = "dev.mpgd.local-storage-migration-failure.\(UUID().uuidString)"

    guard let legacyDefaults = UserDefaults(suiteName: suiteName) else {
        fatalError("Expected an isolated UserDefaults suite.")
    }

    defer {
        legacyDefaults.removePersistentDomain(forName: suiteName)
    }

    let legacyStorageKey = LocalJsonStorage.storageKeyPrefix + "legacy-save"
    let legacyValue = "{\"revision\":1}"
    legacyDefaults.set(legacyValue, forKey: legacyStorageKey)
    let backend = MigratingFileLocalJsonStorageBackend(
        backend: FileLocalJsonStorageBackend(
            fileManager: fileManager,
            directoryURL: blockedDirectory
        ),
        legacyDefaults: legacyDefaults
    )
    var migrationFailed = false

    do {
        _ = try backend.string(forKey: legacyStorageKey)
    } catch {
        migrationFailed = true
    }

    require(migrationFailed, "A failed legacy file write must surface an error.")
    require(
        legacyDefaults.string(forKey: legacyStorageKey) == legacyValue,
        "A legacy UserDefaults value must remain when its file write fails."
    )
}

do {
    try runConformance()
    print("iOS native storage conformance passed.")
} catch {
    fatalError("iOS native storage conformance failed: \(error)")
}
