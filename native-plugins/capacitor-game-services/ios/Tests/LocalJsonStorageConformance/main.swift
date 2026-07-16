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
}

do {
    try runConformance()
    print("iOS native storage conformance passed.")
} catch {
    fatalError("iOS native storage conformance failed: \(error)")
}
