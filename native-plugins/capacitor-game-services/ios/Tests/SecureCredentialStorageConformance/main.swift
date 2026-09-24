import Foundation

private enum SimulatedFailure: Error {
    case load
    case save
    case remove
}

private final class FakeBackend: SecureCredentialBackend {
    var values: [String: String] = [:]
    var failNextLoad = false
    var failNextSave = false
    var failNextRemove = false

    func load(key: String) throws -> String? {
        if failNextLoad {
            failNextLoad = false
            throw SimulatedFailure.load
        }
        return values[key]
    }

    func save(key: String, value: String) throws {
        if failNextSave {
            failNextSave = false
            throw SimulatedFailure.save
        }
        values[key] = value
    }

    func remove(key: String) throws {
        if failNextRemove {
            failNextRemove = false
            throw SimulatedFailure.remove
        }
        values.removeValue(forKey: key)
    }
}

private func require(_ condition: Bool, _ message: String) {
    if !condition { fatalError(message) }
}

private func requireError(
    code: String,
    retryable: Bool,
    operation: () throws -> Void
) {
    do {
        try operation()
        fatalError("Expected secure credential operation to fail.")
    } catch let error as SecureCredentialStorageError {
        require(error.bridgeCode == code, "Unexpected credential error code: \(error.bridgeCode)")
        require(error.retryable == retryable, "Unexpected credential retryability.")
    } catch {
        fatalError("Unexpected secure credential error: \(error)")
    }
}

private func runConformance() throws {
    let backend = FakeBackend()
    let storage = SecureCredentialStorage(backend: backend)
    require(try storage.load(key: "session.refresh") == nil, "Missing credentials must return nil.")
    try storage.save(key: "session.refresh", value: "opaque-one")
    require(try storage.load(key: "session.refresh") == "opaque-one", "Credential must round-trip.")
    try storage.save(key: "session.refresh", value: "opaque-two")
    require(try storage.load(key: "session.refresh") == "opaque-two", "Credential must rotate.")

    requireError(code: "NATIVE_CREDENTIAL_INVALID_KEY", retryable: false) {
        try storage.save(key: "../unsafe", value: "opaque")
    }
    requireError(code: "NATIVE_CREDENTIAL_INVALID_VALUE", retryable: false) {
        try storage.save(key: "session.refresh", value: "")
    }
    requireError(code: "NATIVE_CREDENTIAL_INVALID_VALUE", retryable: false) {
        try storage.save(key: "session.refresh", value: String(repeating: "x", count: 17_000))
    }
    require(try storage.load(key: "session.refresh") == "opaque-two",
        "Invalid input must preserve the committed credential.")

    backend.failNextLoad = true
    requireError(code: "NATIVE_CREDENTIAL_LOAD_FAILED", retryable: true) {
        _ = try storage.load(key: "session.refresh")
    }
    backend.failNextSave = true
    requireError(code: "NATIVE_CREDENTIAL_SAVE_FAILED", retryable: true) {
        try storage.save(key: "session.refresh", value: "never-committed")
    }
    require(try storage.load(key: "session.refresh") == "opaque-two",
        "Failed rotation must preserve the committed credential.")

    backend.values["session.refresh"] = ""
    requireError(code: "NATIVE_CREDENTIAL_DECRYPT_FAILED", retryable: false) {
        _ = try storage.load(key: "session.refresh")
    }
    backend.values["session.refresh"] = "opaque-two"
    backend.failNextRemove = true
    requireError(code: "NATIVE_CREDENTIAL_REMOVE_FAILED", retryable: true) {
        try storage.remove(key: "session.refresh")
    }
    try storage.remove(key: "session.refresh")
    require(try storage.load(key: "session.refresh") == nil, "Removal must clear the credential.")
}

do {
    try runConformance()
    print("Secure credential storage conformance passed.")
} catch {
    fatalError("Secure credential storage conformance failed: \(error)")
}
