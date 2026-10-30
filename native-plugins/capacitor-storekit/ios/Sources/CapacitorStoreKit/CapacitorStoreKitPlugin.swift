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
        CAPPluginMethod(name: "finishTransaction", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getPresentationSupport", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getFinishSupport", returnType: CAPPluginReturnPromise)
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

    /// Declares the sheet facts this native code reports
    /// (`purchasePresentation` events and the `presentation` field of
    /// `purchase` answers). A build without this method answers
    /// `UNIMPLEMENTED`, and the TypeScript SDK then sells nothing that would
    /// wait for facts.
    @objc func getPresentationSupport(_ call: CAPPluginCall) {
        call.resolve(["purchasePresentation": MpgdPurchaseSheet.protocolVersion])
    }

    /// Declares the finish matches this native code applies beyond the
    /// session token: `withoutAppAccountToken`, the explicit no-token match
    /// for a non-consumable bound to no token. A build without this method
    /// answers `UNIMPLEMENTED`, and the TypeScript SDK then leaves such a
    /// transaction unfinished, as before.
    @objc func getFinishSupport(_ call: CAPPluginCall) {
        call.resolve(["withoutAppAccountToken": StoreKitTransactionPolicy.finishWithoutAppAccountTokenVersion])
    }

    @objc func purchase(_ call: CAPPluginCall) {
        // Correlates this call's sheet facts; sent only by a TypeScript SDK
        // that reads them. Without it the call reports no facts, as before.
        let presentationId = call.getString("presentationId")
        if presentationId != nil && !MpgdPurchaseSheet.isValidPresentationId(presentationId) {
            call.reject("The presentation id is invalid.", "STOREKIT_INVALID_PURCHASE", nil,
                        ["presentation": MpgdPurchaseSheet.Fact.notStarted.rawValue])
            return
        }
        let sheet = presentationId.map { id in
            MpgdPurchaseSheet(presentationId: id) { [weak self] id, fact in
                self?.notifyPresentation(id, fact)
            }
        }
        guard let productId = call.getString("productId"),
              StoreKitTransactionPolicy.isValidProductId(productId),
              let accountToken = StoreKitTransactionPolicy.normalizedAccountToken(
                call.getString("appAccountToken"), allowNil: true) else {
            sheet?.end()
            call.reject("A product ID and app account token are required.", "STOREKIT_INVALID_PURCHASE",
                        nil, Self.presentationData(sheet))
            return
        }
        if let message = connection.providerError {
            sheet?.end()
            call.reject(message, "STOREKIT_CONFIGURATION_ERROR", nil, Self.presentationData(sheet))
            return
        }
        Task { @MainActor [module] in
            do {
                let result = try await module.fetchProducts(ProductRequest(skus: [productId], type: .inApp))
                guard let product = Self.iosProducts(result).first(where: { $0.id == productId }),
                      MpgdOneTimeType(productType: product.typeIOS) != nil else {
                    sheet?.end()
                    call.reject("The one-time product is unavailable.", "STOREKIT_PRODUCT_UNAVAILABLE",
                                nil, Self.presentationData(sheet))
                    return
                }
            } catch {
                sheet?.end()
                call.reject("StoreKit product lookup failed.", "STOREKIT_PRODUCT_LOOKUP_FAILED", error,
                            Self.presentationData(sheet))
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
            // `open` right before OpenIAP calls `Product.purchase()`, which
            // presents the sheet; `closed` once that call returned or threw,
            // before the answer, which carries the same fact.
            sheet?.open()
            do {
                let outcome = try await module.requestPurchase(request)
                sheet?.end()
                guard case .purchase(let purchased?) = outcome,
                      case .purchaseIos(let ios) = purchased,
                      let transaction = StoreKitTransactionPolicy.transaction(from: ios),
                      StoreKitTransactionPolicy.matchesPurchaseRequest(
                        transaction, productId: productId, appAccountToken: accountToken) else {
                    call.reject("StoreKit transaction failed verification or account binding.",
                                "STOREKIT_TRANSACTION_UNVERIFIED", nil, Self.presentationData(sheet))
                    return
                }
                call.resolve(Self.withPresentation([
                    "status": "purchased",
                    "transaction": StoreKitTransactionPolicy.payload(transaction)
                ], sheet))
            } catch let error as PurchaseError {
                sheet?.end()
                switch StoreKitTransactionPolicy.purchaseFailure(error.code) {
                case .cancelled:
                    call.resolve(Self.withPresentation(["status": "cancelled"], sheet))
                case .pending:
                    // Ask to Buy: the approved transaction arrives through
                    // `transactionUpdated` or `getTransactions` later. The
                    // sheet itself is done.
                    call.resolve(Self.withPresentation(["status": "pending"], sheet))
                case .rejected(let code, let message):
                    call.reject(message, code, error, Self.presentationData(sheet))
                }
            } catch {
                sheet?.end()
                // The purchase sheet may have completed before an error reached us.
                call.reject("StoreKit purchase result is uncertain; requery transactions.",
                            "STOREKIT_PURCHASE_UNCERTAIN", error, Self.presentationData(sheet))
            }
        }
    }

    /// Retained until a listener consumes it; the random id keeps a fact of
    /// an earlier web session from matching a new call.
    private func notifyPresentation(_ presentationId: String, _ fact: MpgdPurchaseSheet.Fact) {
        notifyListeners("purchasePresentation",
                        data: ["presentationId": presentationId, "state": fact.rawValue],
                        retainUntilConsumed: true)
    }

    private static func presentationData(_ sheet: MpgdPurchaseSheet?) -> [String: Any]? {
        guard let sheet else { return nil }
        return ["presentation": sheet.answer]
    }

    private static func withPresentation(_ answer: [String: Any], _ sheet: MpgdPurchaseSheet?) -> [String: Any] {
        guard let sheet else { return answer }
        var answered = answer
        answered["presentation"] = sheet.answer
        return answered
    }

    @objc func getTransactions(_ call: CAPPluginCall) {
        guard providerReady(call) else { return }
        Task {
            // Verified `Transaction.unfinished`, then current entitlements, read
            // by `RecoveryReadShim`: an unverified entry is skipped on its own
            // (0.3 behavior) instead of failing the whole OpenIAP query. Never
            // `Transaction.all`: finished consumables must not return to the
            // recovery list. No account filter: the TypeScript SDK admits.
            let unfinished = await RecoveryReadShim.unfinished()
            let entitlements = await RecoveryReadShim.currentEntitlements()
            call.resolve(["transactions": StoreKitTransactionPolicy.listedTransactions(
                unfinished: unfinished,
                entitlements: entitlements
            )])
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
        // `withoutAppAccountToken: true` (and no token argument) instead
        // matches only a non-consumable bound to no token; a missing token
        // without it is refused, as before.
        guard let transactionId = call.getString("transactionId"), UInt64(transactionId) != nil,
              let ledgerEntryId = call.getString("ledgerEntryId"),
              !ledgerEntryId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let binding = StoreKitTransactionPolicy.finishBinding(
                appAccountToken: call.options["appAccountToken"],
                withoutAppAccountToken: call.options["withoutAppAccountToken"]) else {
            call.reject(
                "A transaction ID, confirmed ledger entry, and app account token are required.",
                "STOREKIT_FINISH_REQUIRES_GRANT"
            )
            return
        }
        guard providerReady(call) else { return }
        Task { [module] in
            do {
                // The verified transaction behind the id, through the same read
                // as `getTransactions` (an unverified sibling never blocks it):
                // unfinished first, then the StoreKit history
                // (`Transaction.all`) the 0.3 plugin searched, so finishing an
                // already-finished durable stays an idempotent `finished: true`.
                var candidate = StoreKitTransactionPolicy.finishable(
                    transactionId: transactionId,
                    binding: binding,
                    in: await RecoveryReadShim.unfinished())
                if candidate == nil {
                    candidate = StoreKitTransactionPolicy.finishable(
                        transactionId: transactionId,
                        binding: binding,
                        in: await RecoveryReadShim.history())
                }
                guard let match = candidate else {
                    call.resolve(["finished": false])
                    return
                }
                // OpenIAP finishes it (and checks the Apple storeId).
                try await module.finishTransaction(
                    purchase: .purchaseIos(StoreKitTransactionPolicy.finishInput(match)),
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
}
