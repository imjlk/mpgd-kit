import Capacitor
import Foundation
import MpgdStoreKitBridge
import OpenIAP

/// The `CapacitorStoreKit` plugin: the 0.3 JavaScript contract over the
/// OpenIAP Apple core. OpenIAP talks to StoreKit 2; this class only parses
/// Capacitor calls, applies `StoreKitTransactionPolicy`, and answers in the
/// payload shapes the 0.3 plugin defined. Nothing here grants, and nothing
/// here finishes a transaction except `finishTransaction`, which the game
/// calls only after its backend confirmed the ledger grant.
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

    private let connection = OpenIapAppleConnection()
    private let revocations = RevocationUpdatesShim()

    private var module: OpenIapModule { connection.module }

    @objc override public func load() {
        super.load()
        // OpenIAP delivers verified, non-revoked updates (and the result of a
        // purchase call, which StoreSdk and the reconciler deduplicate); the
        // shim delivers verified revocations OpenIAP skips. Neither is
        // retained for a listener that attaches later: `getTransactions` is
        // the authoritative recovery query.
        connection.start { [weak self] purchase in
            guard let transaction = StoreKitTransactionPolicy.transaction(from: purchase) else { return }
            self?.notifyListeners("transactionUpdated", data: StoreKitTransactionPolicy.payload(transaction))
        }
        if connection.providerError == nil {
            revocations.start { [weak self] transaction in
                // Delivered on the main actor, as OpenIAP's listener and the
                // 0.3 update loop were, never from the shim's detached task.
                Task { @MainActor in
                    self?.notifyListeners("transactionUpdated", data: StoreKitTransactionPolicy.payload(transaction))
                }
            }
        }
    }

    deinit {
        revocations.stop()
        connection.stop()
    }

    /// Rejects the call when OpenIAP did not select the Apple provider.
    private func providerReady(_ call: CAPPluginCall) -> Bool {
        guard let message = connection.providerError else { return true }
        call.reject(message, "STOREKIT_CONFIGURATION_ERROR")
        return false
    }

    @objc func getProducts(_ call: CAPPluginCall) {
        guard let identifiers = call.options["productIds"] as? [String],
              !identifiers.isEmpty, identifiers.count <= 100,
              identifiers.allSatisfy({ StoreKitTransactionPolicy.isValidProductId($0) }) else {
            call.reject("Provide 1-100 valid product IDs.", "STOREKIT_INVALID_PRODUCTS")
            return
        }
        guard providerReady(call) else { return }
        Task { @MainActor [module] in
            do {
                let result = try await module.fetchProducts(ProductRequest(skus: identifiers, type: .inApp))
                let values = Self.iosProducts(result).compactMap(StoreKitTransactionPolicy.productPayload)
                call.resolve(["products": values])
            } catch {
                call.reject("StoreKit product lookup failed.", "STOREKIT_UNAVAILABLE", error)
            }
        }
    }

    @objc func purchase(_ call: CAPPluginCall) {
        guard let productId = call.getString("productId"),
              StoreKitTransactionPolicy.isValidProductId(productId),
              let accountToken = StoreKitTransactionPolicy.normalizedAccountToken(
                call.getString("appAccountToken"), allowNil: true) else {
            call.reject("A product ID and app account token are required.", "STOREKIT_INVALID_PURCHASE")
            return
        }
        guard providerReady(call) else { return }
        Task { @MainActor [module] in
            do {
                let result = try await module.fetchProducts(ProductRequest(skus: [productId], type: .inApp))
                guard let product = Self.iosProducts(result).first(where: { $0.id == productId }),
                      MpgdOneTimeType(productType: product.typeIOS) != nil else {
                    call.reject("The one-time product is unavailable.", "STOREKIT_PRODUCT_UNAVAILABLE")
                    return
                }
            } catch {
                call.reject("StoreKit product lookup failed.", "STOREKIT_PRODUCT_LOOKUP_FAILED", error)
                return
            }
            let request = RequestPurchaseProps(
                request: .purchase(RequestPurchasePropsByPlatforms(apple: RequestPurchaseIosProps(
                    // Never finish here: the game backend must commit its ledger grant first.
                    andDangerouslyFinishTransactionAutomatically: false,
                    appAccountToken: accountToken,
                    sku: productId
                ))),
                type: .inApp
            )
            do {
                let outcome = try await module.requestPurchase(request)
                guard case .purchase(let purchased?) = outcome,
                      case .purchaseIos(let ios) = purchased,
                      let transaction = StoreKitTransactionPolicy.transaction(from: ios),
                      StoreKitTransactionPolicy.matchesPurchaseRequest(
                        transaction, productId: productId, appAccountToken: accountToken) else {
                    call.reject("StoreKit transaction failed verification or account binding.",
                                "STOREKIT_TRANSACTION_UNVERIFIED")
                    return
                }
                call.resolve([
                    "status": "purchased",
                    "transaction": StoreKitTransactionPolicy.payload(transaction)
                ])
            } catch let error as PurchaseError {
                switch StoreKitTransactionPolicy.purchaseFailure(error.code) {
                case .cancelled:
                    call.resolve(["status": "cancelled"])
                case .pending:
                    // Ask to Buy: the approved transaction arrives through
                    // `transactionUpdated` or `getTransactions` later.
                    call.resolve(["status": "pending"])
                case .rejected(let code, let message):
                    call.reject(message, code, error)
                }
            } catch {
                // The purchase sheet may have completed before an error reached us.
                call.reject("StoreKit purchase result is uncertain; requery transactions.",
                            "STOREKIT_PURCHASE_UNCERTAIN", error)
            }
        }
    }

    @objc func getTransactions(_ call: CAPPluginCall) {
        guard providerReady(call) else { return }
        Task { [module] in
            do {
                // Verified `Transaction.unfinished`, then current entitlements
                // (`Transaction.currentEntitlements`). Never `Transaction.all`:
                // finished consumables must not return to the recovery list.
                let unfinished = try await module.getPendingTransactionsIOS()
                let entitlements = try await module.getAvailablePurchases(
                    PurchaseOptions(alsoPublishToEventListenerIOS: false, onlyIncludeActiveItemsIOS: true))
                call.resolve(["transactions": try StoreKitTransactionPolicy.listedTransactions(
                    unfinished: unfinished,
                    entitlements: entitlements.compactMap(Self.iosPurchase)
                )])
            } catch {
                // A failed query is never an empty list: the game reads a
                // transaction leaving this list as evidence that it finished.
                call.reject("StoreKit transaction query failed.",
                            StoreKitTransactionPolicy.queryFailureCode(error), error)
            }
        }
    }

    @objc func sync(_ call: CAPPluginCall) {
        guard providerReady(call) else { return }
        // User-initiated restore only (`AppStore.sync` may show sign-in UI).
        Task { @MainActor [module] in
            do {
                _ = try await module.syncIOS()
                call.resolve(["synced": true])
            } catch {
                call.reject("StoreKit account synchronization failed.", "STOREKIT_SYNC_FAILED", error)
            }
        }
    }

    @objc func finishTransaction(_ call: CAPPluginCall) {
        // The ledger id is still a client string. The token match is the local
        // gate: finish only a verified, non-revoked, one-time transaction whose
        // app account token equals the one the caller supplies. The StoreKit
        // SDK supplies the session token and applies the same match before
        // calling. A signed server finish capability is still required to stop
        // a webview caller who read the token from `getTransactions`.
        guard let transactionId = call.getString("transactionId"), UInt64(transactionId) != nil,
              let ledgerEntryId = call.getString("ledgerEntryId"),
              !ledgerEntryId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let accountToken = StoreKitTransactionPolicy.normalizedAccountToken(
                call.getString("appAccountToken")) else {
            call.reject(
                "A transaction ID, confirmed ledger entry, and app account token are required.",
                "STOREKIT_FINISH_REQUIRES_GRANT"
            )
            return
        }
        guard providerReady(call) else { return }
        Task { [module] in
            do {
                // The full verified purchase behind the id: unfinished first,
                // then the StoreKit history (`Transaction.all`) the 0.3 plugin
                // searched, so finishing an already-finished durable stays an
                // idempotent `finished: true`.
                var candidate = StoreKitTransactionPolicy.finishable(
                    transactionId: transactionId,
                    appAccountToken: accountToken,
                    in: try await module.getPendingTransactionsIOS())
                if candidate == nil {
                    let history = try await module.getAvailablePurchases(
                        PurchaseOptions(alsoPublishToEventListenerIOS: false, onlyIncludeActiveItemsIOS: false))
                    candidate = StoreKitTransactionPolicy.finishable(
                        transactionId: transactionId,
                        appAccountToken: accountToken,
                        in: history.compactMap(Self.iosPurchase))
                }
                guard let match = candidate else {
                    call.resolve(["finished": false])
                    return
                }
                try await module.finishTransaction(
                    purchase: .purchaseIos(match.purchase),
                    isConsumable: match.type == .consumable)
                call.resolve(["finished": true])
            } catch {
                call.reject("StoreKit could not finish the transaction.",
                            StoreKitTransactionPolicy.queryFailureCode(error), error)
            }
        }
    }

    private static func iosProducts(_ result: FetchProductsResult) -> [ProductIOS] {
        guard case .products(let products?) = result else { return [] }
        return products.compactMap { product in
            if case .productIos(let ios) = product { return ios }
            return nil
        }
    }

    private static func iosPurchase(_ purchase: OpenIAP.Purchase) -> PurchaseIOS? {
        if case .purchaseIos(let ios) = purchase { return ios }
        return nil
    }
}
