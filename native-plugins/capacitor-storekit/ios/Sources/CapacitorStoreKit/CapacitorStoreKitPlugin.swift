import Capacitor
import Foundation
import StoreKit

@objc(CapacitorStoreKitPlugin)
public class CapacitorStoreKitPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "CapacitorStoreKitPlugin"
    public let jsName = "CapacitorStoreKit"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getProducts", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "purchase", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getTransactions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "sync", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "finishTransaction", returnType: CAPPluginReturnPromise)
    ]

    private var updatesTask: Task<Void, Never>?

    @objc override public func load() {
        super.load()
        updatesTask = Task { @MainActor [weak self] in
            for await result in Transaction.updates {
                guard !Task.isCancelled else { return }
                if let payload = Self.verifiedPayload(result) {
                    self?.notifyListeners("transactionUpdated", data: payload)
                }
            }
        }
    }

    deinit {
        updatesTask?.cancel()
    }

    @objc func getProducts(_ call: CAPPluginCall) {
        guard let identifiers = call.options["productIds"] as? [String],
              !identifiers.isEmpty, identifiers.count <= 100,
              identifiers.allSatisfy({ Self.validProductId($0) }) else {
            call.reject("Provide 1-100 valid product IDs.", "STOREKIT_INVALID_PRODUCTS")
            return
        }
        Task { @MainActor in
            do {
                let products = try await Product.products(for: identifiers)
                let values: [[String: Any]] = products.compactMap { product in
                    guard let type = Self.oneTimeType(product.type) else { return nil }
                    return [
                        "productId": product.id,
                        "type": type,
                        "title": product.displayName,
                        "description": product.description,
                        "formattedPrice": product.displayPrice,
                        "currencyCode": product.priceFormatStyle.currencyCode
                    ]
                }
                call.resolve(["products": values])
            } catch {
                call.reject("StoreKit product lookup failed.", "STOREKIT_UNAVAILABLE", error)
            }
        }
    }

    @objc func purchase(_ call: CAPPluginCall) {
        guard let productId = call.getString("productId"), Self.validProductId(productId),
              let rawAccountToken = call.getString("appAccountToken"),
              let accountToken = UUID(uuidString: rawAccountToken) else {
            call.reject("A product ID and app account token are required.", "STOREKIT_INVALID_PURCHASE")
            return
        }
        Task { @MainActor in
            let product: Product
            do {
                guard let found = try await Product.products(for: [productId]).first,
                      found.id == productId,
                      Self.oneTimeType(found.type) != nil else {
                    call.reject("The one-time product is unavailable.", "STOREKIT_PRODUCT_UNAVAILABLE")
                    return
                }
                product = found
            } catch {
                call.reject("StoreKit product lookup failed.", "STOREKIT_PRODUCT_LOOKUP_FAILED", error)
                return
            }
            do {
                let result = try await product.purchase(options: [.appAccountToken(accountToken)])
                switch result {
                case .success(let verification):
                    guard let payload = Self.verifiedPayload(verification),
                          payload["productId"] as? String == productId,
                          (payload["appAccountToken"] as? String)?.lowercased()
                            == accountToken.uuidString.lowercased() else {
                        call.reject("StoreKit transaction failed verification or account binding.",
                                    "STOREKIT_TRANSACTION_UNVERIFIED")
                        return
                    }
                    // Never finish here: the game backend must commit its ledger grant first.
                    call.resolve(["status": "purchased", "transaction": payload])
                case .pending:
                    call.resolve(["status": "pending"])
                case .userCancelled:
                    call.resolve(["status": "cancelled"])
                @unknown default:
                    call.reject("StoreKit returned an unknown purchase result.", "STOREKIT_UNKNOWN_RESULT")
                }
            } catch {
                // The purchase sheet may have completed before an error reached us.
                call.reject("StoreKit purchase result is uncertain; requery transactions.",
                            "STOREKIT_PURCHASE_UNCERTAIN", error)
            }
        }
    }

    @objc func getTransactions(_ call: CAPPluginCall) {
        Task {
            var byId: [String: [String: Any]] = [:]
            for await result in Transaction.unfinished {
                if let payload = Self.verifiedPayload(result),
                   let id = payload["transactionId"] as? String {
                    byId[id] = payload
                }
            }
            for await result in Transaction.currentEntitlements {
                if let payload = Self.verifiedPayload(result),
                   payload["type"] as? String == "non_consumable",
                   let id = payload["transactionId"] as? String {
                    byId[id] = payload
                }
            }
            call.resolve(["transactions": Array(byId.values)])
        }
    }

    @objc func sync(_ call: CAPPluginCall) {
        Task { @MainActor in
            do {
                try await AppStore.sync()
                call.resolve(["synced": true])
            } catch {
                call.reject("StoreKit account synchronization failed.", "STOREKIT_SYNC_FAILED", error)
            }
        }
    }

    @objc func finishTransaction(_ call: CAPPluginCall) {
        guard let rawId = call.getString("transactionId"), let id = UInt64(rawId),
              let ledgerEntryId = call.getString("ledgerEntryId"),
              !ledgerEntryId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            call.reject("A transaction ID and confirmed ledger entry are required.",
                        "STOREKIT_FINISH_REQUIRES_GRANT")
            return
        }
        Task {
            for await result in Transaction.all {
                guard case .verified(let transaction) = result,
                      transaction.id == id,
                      transaction.revocationDate == nil,
                      Self.oneTimeType(transaction.productType) != nil else { continue }
                await transaction.finish()
                call.resolve(["finished": true])
                return
            }
            call.resolve(["finished": false])
        }
    }

    private static func verifiedPayload(
        _ result: VerificationResult<Transaction>
    ) -> [String: Any]? {
        guard case .verified(let transaction) = result,
              let type = oneTimeType(transaction.productType) else { return nil }
        var payload: [String: Any] = [
            "transactionId": String(transaction.id),
            "originalTransactionId": String(transaction.originalID),
            "productId": transaction.productID,
            "type": type,
            "purchasedAt": ISO8601DateFormatter().string(from: transaction.purchaseDate),
            "signedTransaction": result.jwsRepresentation
        ]
        if let accountToken = transaction.appAccountToken {
            payload["appAccountToken"] = accountToken.uuidString.lowercased()
        }
        if let revocationDate = transaction.revocationDate {
            payload["revokedAt"] = ISO8601DateFormatter().string(from: revocationDate)
        }
        return payload
    }

    private static func oneTimeType(_ type: Product.ProductType) -> String? {
        switch type {
        case .consumable: return "consumable"
        case .nonConsumable: return "non_consumable"
        default: return nil
        }
    }

    private static func validProductId(_ value: String) -> Bool {
        value.range(of: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$", options: .regularExpression) != nil
    }
}
