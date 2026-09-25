import CryptoKit
import Foundation
import Security

func requiredEnvironment(_ name: String) throws -> String {
  guard let value = ProcessInfo.processInfo.environment[name], !value.isEmpty else {
    throw NSError(domain: "mpgd.ios.signing", code: 1, userInfo: [
      NSLocalizedDescriptionKey: "Missing iOS signing input: \(name)",
    ])
  }
  return value
}

do {
  let keychainPath = try requiredEnvironment("MPGD_IOS_SESSION_KEYCHAIN")
  let keychainPassword = try requiredEnvironment("MPGD_IOS_SESSION_KEYCHAIN_PASSWORD")
  let certificatePath = try requiredEnvironment("MPGD_IOS_SIGNING_P12")
  let certificatePassword = try requiredEnvironment("MPGD_IOS_SIGNING_P12_PASSWORD")
  let certificateData = try Data(contentsOf: URL(fileURLWithPath: certificatePath))

  var keychain: SecKeychain?
  let createStatus = keychainPath.withCString { path in
    keychainPassword.withCString { password in
      SecKeychainCreate(path, UInt32(keychainPassword.utf8.count), password, false, nil, &keychain)
    }
  }
  guard createStatus == errSecSuccess, let keychain else {
    throw NSError(domain: "mpgd.ios.signing", code: Int(createStatus), userInfo: [
      NSLocalizedDescriptionKey: "Could not create an isolated iOS signing keychain.",
    ])
  }

  let options: [String: Any] = [
    kSecImportExportPassphrase as String: certificatePassword,
    kSecImportExportKeychain as String: keychain,
  ]
  var imported: CFArray?
  let importStatus = SecPKCS12Import(certificateData as CFData, options as CFDictionary, &imported)
  guard importStatus == errSecSuccess,
    let items = imported as? [[String: Any]],
    items.count == 1,
    let rawIdentity = items[0][kSecImportItemIdentity as String],
    CFGetTypeID(rawIdentity as CFTypeRef) == SecIdentityGetTypeID() else {
    throw NSError(domain: "mpgd.ios.signing", code: Int(importStatus), userInfo: [
      NSLocalizedDescriptionKey: "Could not import one iOS signing identity into its keychain.",
    ])
  }
  let identity = rawIdentity as! SecIdentity

  var certificate: SecCertificate?
  let certificateStatus = SecIdentityCopyCertificate(identity, &certificate)
  guard certificateStatus == errSecSuccess, let certificate else {
    throw NSError(domain: "mpgd.ios.signing", code: Int(certificateStatus), userInfo: [
      NSLocalizedDescriptionKey: "Imported iOS signing identity has no certificate.",
    ])
  }
  let certificateBytes = SecCertificateCopyData(certificate) as Data
  let sha256 = SHA256.hash(data: certificateBytes)
    .map { String(format: "%02X", $0) }.joined()
  let sha1 = Insecure.SHA1.hash(data: certificateBytes)
    .map { String(format: "%02X", $0) }.joined()
  let response = ["certificateSha256": sha256, "certificateSha1": sha1]
  let json = try JSONSerialization.data(withJSONObject: response, options: [.sortedKeys])
  FileHandle.standardOutput.write(json)
  FileHandle.standardOutput.write(Data([0x0A]))
} catch {
  FileHandle.standardError.write(Data("iOS signing identity import failed.\n".utf8))
  exit(1)
}
