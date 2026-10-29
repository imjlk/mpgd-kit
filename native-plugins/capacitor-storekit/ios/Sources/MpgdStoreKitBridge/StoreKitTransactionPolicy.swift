import Foundation
import OpenIAP

/// The one-time product kinds the mpgd StoreKit plugin sells and reports.
/// Raw values are the plugin's wire values (`StoreKitTransaction.type`).
public enum MpgdOneTimeType: String, Equatable, Sendable {
    case consumable = "consumable"
    case nonConsumable = "non_consumable"

    /// The App Store product kind as StoreKit and OpenIAP describe a product.
    public init?(productType: ProductTypeIOS) {
        switch productType {
        case .consumable: self = .consumable
        case .nonConsumable: self = .nonConsumable
        default: return nil
        }
    }

    /// The `type` claim of a StoreKit-verified JWS transaction
    /// (`JWSTransactionDecodedPayload.type`): `Consumable` or `Non-Consumable`.
    /// Subscriptions and unknown values are not one-time purchases.
    public init?(transactionTypeClaim: String) {
        switch transactionTypeClaim {
        case "Consumable": self = .consumable
        case "Non-Consumable": self = .nonConsumable
        default: return nil
        }
    }
}

/// The fields of one verified StoreKit transaction the mpgd plugin reports.
/// Both the OpenIAP purchase path and the revocation shim build this value,
/// so every `transactionUpdated` and `getTransactions` entry has one shape.
public struct MpgdStoreKitTransaction: Equatable, Sendable {
    public let transactionId: String
    public let originalTransactionId: String
    public let productId: String
    public let type: MpgdOneTimeType
    /// Lowercased UUID, as the 0.3 native plugin reported it.
    public let appAccountToken: String?
    public let purchasedAtMillis: Double
    public let revokedAtMillis: Double?
    /// The StoreKit-verified JWS; the backend verifies it again.
    public let signedTransaction: String

    public init(
        transactionId: String,
        originalTransactionId: String,
        productId: String,
        type: MpgdOneTimeType,
        appAccountToken: String?,
        purchasedAtMillis: Double,
        revokedAtMillis: Double?,
        signedTransaction: String
    ) {
        self.transactionId = transactionId
        self.originalTransactionId = originalTransactionId
        self.productId = productId
        self.type = type
        self.appAccountToken = appAccountToken?.lowercased()
        self.purchasedAtMillis = purchasedAtMillis
        self.revokedAtMillis = revokedAtMillis
        self.signedTransaction = signedTransaction
    }
}

/// mpgd policy over OpenIAP's canonical Apple purchase: which transactions the
/// plugin reports, the payload shape it reports them in, which ones it may
/// finish, and how OpenIAP errors become the plugin's existing codes. Nothing
/// here calls StoreKit; the Capacitor plugin and tests drive it directly.
public enum StoreKitTransactionPolicy {
    /// The provider the plugin requires. OpenIAP's Apple provider reports
    /// `apple`; mpgd names the same store `app-store` on the JavaScript side.
    public static let appleStoreId = StoreIds.Apple

    // MARK: - Mapping

    /// What the plugin makes of one OpenIAP Apple purchase (the `purchase`
    /// result and listener events).
    public enum Classification: Equatable {
        /// A verified consumable or non-consumable the plugin reports.
        case oneTime(MpgdStoreKitTransaction)
        /// A subscription (its JWS `type` claim says so); never reported.
        case notOneTime
        /// No readable StoreKit JWS, no `type` claim, another provider, or no
        /// id. Never reported from the OpenIAP purchase and listener paths.
        case unreadable
    }

    public static func classify(_ purchase: PurchaseIOS) -> Classification {
        guard purchase.storeId == appleStoreId, purchase.store == .apple,
              !purchase.id.isEmpty, !purchase.productId.isEmpty,
              let jws = purchase.purchaseToken, isCompactJws(jws),
              let claims = jwsPayload(jws),
              let typeClaim = claims["type"] as? String else {
            return .unreadable
        }
        guard let type = MpgdOneTimeType(transactionTypeClaim: typeClaim) else {
            return .notOneTime
        }
        return .oneTime(MpgdStoreKitTransaction(
            transactionId: purchase.id,
            // OpenIAP omits an original id of 0; the 0.3 plugin always sent one.
            originalTransactionId: purchase.originalTransactionIdentifierIOS ?? purchase.id,
            productId: purchase.productId,
            type: type,
            appAccountToken: purchase.appAccountToken,
            purchasedAtMillis: purchase.transactionDate,
            revokedAtMillis: purchase.revocationDateIOS,
            signedTransaction: jws
        ))
    }

    /// The verified one-time transaction an OpenIAP Apple purchase describes,
    /// or nil for anything the plugin does not report.
    public static func transaction(from purchase: PurchaseIOS) -> MpgdStoreKitTransaction? {
        if case .oneTime(let transaction) = classify(purchase) { return transaction }
        return nil
    }

    /// The `StoreKitTransaction` payload of the 0.3 native plugin, key for key.
    /// `unfinished` is set only on `getTransactions` entries.
    public static func payload(
        _ transaction: MpgdStoreKitTransaction,
        unfinished: Bool? = nil
    ) -> [String: Any] {
        var payload: [String: Any] = [
            "transactionId": transaction.transactionId,
            "originalTransactionId": transaction.originalTransactionId,
            "productId": transaction.productId,
            "type": transaction.type.rawValue,
            "purchasedAt": isoTimestamp(milliseconds: transaction.purchasedAtMillis),
            "signedTransaction": transaction.signedTransaction
        ]
        if let token = transaction.appAccountToken {
            payload["appAccountToken"] = token
        }
        if let revoked = transaction.revokedAtMillis {
            payload["revokedAt"] = isoTimestamp(milliseconds: revoked)
        }
        if let unfinished {
            payload["unfinished"] = unfinished
        }
        return payload
    }

    /// The `StoreKitProduct` payload of a one-time product, or nil for a
    /// subscription the plugin does not sell.
    public static func productPayload(_ product: ProductIOS) -> [String: Any]? {
        guard let type = MpgdOneTimeType(productType: product.typeIOS) else {
            return nil
        }
        return [
            "productId": product.id,
            "type": type.rawValue,
            "title": product.displayNameIOS,
            "description": product.description,
            "formattedPrice": product.displayPrice,
            "currencyCode": product.currency
        ]
    }

    /// One entry of a StoreKit read (`RecoveryReadShim`): a verified one-time
    /// transaction, a verified subscription the plugin never reports, or a
    /// transaction StoreKit could not verify, which is skipped on its own as
    /// the 0.3 plugin did, so it never hides or blocks a verified sibling.
    public enum ReadEntry: Equatable, Sendable {
        case oneTime(MpgdStoreKitTransaction)
        case notOneTime
        case unverified
    }

    /// `getTransactions`: every verified unfinished one-time transaction
    /// (`unfinished: true`), then every current non-consumable entitlement not
    /// already listed (`unfinished: false`), merged by transaction id.
    /// Finished consumables are never added: they are not current
    /// entitlements, and the game reads a consumable leaving this list as
    /// evidence that its finish landed. No account filter here: the
    /// TypeScript SDK admits transactions for the session account (and
    /// restore handling needs to see the others).
    public static func listedTransactions(
        unfinished: [ReadEntry],
        entitlements: [ReadEntry]
    ) -> [[String: Any]] {
        var seen = Set<String>()
        var listed: [[String: Any]] = []
        for entry in unfinished {
            guard case .oneTime(let transaction) = entry,
                  seen.insert(transaction.transactionId).inserted else { continue }
            listed.append(payload(transaction, unfinished: true))
        }
        for entry in entitlements {
            guard case .oneTime(let transaction) = entry,
                  transaction.type == .nonConsumable,
                  seen.insert(transaction.transactionId).inserted else { continue }
            listed.append(payload(transaction, unfinished: false))
        }
        return listed
    }

    /// The transaction `finishTransaction` may finish: the verified one-time
    /// transaction with this id that is not revoked and whose app account
    /// token equals the session token. OpenIAP finishes whatever it is given,
    /// so this is the plugin's local gate; it is still not a signed server
    /// capability (see `finishTransaction` in the plugin definitions).
    public static func finishable(
        transactionId: String,
        appAccountToken: String,
        in entries: [ReadEntry]
    ) -> MpgdStoreKitTransaction? {
        let expected = appAccountToken.lowercased()
        for entry in entries {
            guard case .oneTime(let transaction) = entry,
                  transaction.transactionId == transactionId,
                  transaction.revokedAtMillis == nil,
                  transaction.appAccountToken == expected else { continue }
            return transaction
        }
        return nil
    }

    /// The transaction a revoked finish (`finishTransaction` with `revoked`)
    /// may finish: the verified, **revoked** consumable with this id whose app
    /// account token equals the session token. The App Store refunded it while
    /// it was unfinished, so StoreKit keeps it in `Transaction.unfinished` and
    /// redelivers it at every launch until `finish()`; finishing it grants
    /// nothing. A transaction that is not revoked (still paid), a durable, and
    /// another or no token never match, so this path never finishes a
    /// purchase the player still holds. Read from `Transaction.unfinished`
    /// only: a finished one has nothing left to finish.
    public static func finishableRevoked(
        transactionId: String,
        appAccountToken: String,
        in entries: [ReadEntry]
    ) -> MpgdStoreKitTransaction? {
        let expected = appAccountToken.lowercased()
        for entry in entries {
            guard case .oneTime(let transaction) = entry,
                  transaction.transactionId == transactionId,
                  transaction.revokedAtMillis != nil,
                  transaction.type == .consumable,
                  transaction.appAccountToken == expected else { continue }
            return transaction
        }
        return nil
    }

    /// The OpenIAP purchase handed to `OpenIapModule.finishTransaction` for a
    /// transaction the read resolved. OpenIAP finishes by transaction id
    /// (looking it up in `Transaction.unfinished`, then
    /// `Transaction.latest(for:)`) after checking `storeId`; these are the
    /// fields it reads.
    public static func finishInput(_ transaction: MpgdStoreKitTransaction) -> PurchaseIOS {
        PurchaseIOS(
            appAccountToken: transaction.appAccountToken,
            id: transaction.transactionId,
            isAutoRenewing: false,
            originalTransactionIdentifierIOS: transaction.originalTransactionId,
            productId: transaction.productId,
            purchaseState: .purchased,
            purchaseToken: transaction.signedTransaction,
            quantity: 1,
            revocationDateIOS: transaction.revokedAtMillis,
            store: .apple,
            storeId: appleStoreId,
            transactionDate: transaction.purchasedAtMillis,
            transactionId: transaction.transactionId
        )
    }

    /// Whether a just-purchased transaction is the one the call asked for:
    /// same product and bound to the token the purchase was started with.
    public static func matchesPurchaseRequest(
        _ transaction: MpgdStoreKitTransaction,
        productId: String,
        appAccountToken: String
    ) -> Bool {
        transaction.productId == productId
            && transaction.appAccountToken == appAccountToken.lowercased()
            && transaction.revokedAtMillis == nil
    }

    // MARK: - Errors

    /// How a `requestPurchase` failure answers the plugin's `purchase` call.
    public enum PurchaseFailure: Equatable {
        case cancelled
        /// Ask to Buy or another deferred payment: never a cancellation.
        case pending
        case rejected(code: String, message: String)
    }

    /// Maps an OpenIAP purchase error to the 0.3 plugin outcome. Anything that
    /// may have happened after the purchase sheet opened stays
    /// `STOREKIT_PURCHASE_UNCERTAIN`, so the game requeries instead of
    /// assuming nothing was bought.
    public static func purchaseFailure(_ code: ErrorCode) -> PurchaseFailure {
        switch code {
        case .userCancelled:
            return .cancelled
        case .deferredPayment, .pending:
            return .pending
        case .transactionValidationFailed:
            return .rejected(code: "STOREKIT_TRANSACTION_UNVERIFIED",
                             message: "StoreKit transaction failed verification or account binding.")
        case .skuNotFound, .itemUnavailable, .emptySkuList:
            return .rejected(code: "STOREKIT_PRODUCT_UNAVAILABLE",
                             message: "The one-time product is unavailable.")
        case .queryProduct:
            return .rejected(code: "STOREKIT_PRODUCT_LOOKUP_FAILED",
                             message: "StoreKit product lookup failed.")
        case .developerError:
            return .rejected(code: "STOREKIT_INVALID_PURCHASE",
                             message: "A product ID and app account token are required.")
        case .iapNotAvailable, .notPrepared, .initConnection:
            // Raised before any purchase sheet: nothing was bought.
            return .rejected(code: "STOREKIT_UNAVAILABLE",
                             message: "StoreKit purchases are unavailable on this device.")
        case .unknown:
            return .rejected(code: "STOREKIT_UNKNOWN_RESULT",
                             message: "StoreKit returned an unknown purchase result.")
        default:
            return .rejected(code: "STOREKIT_PURCHASE_UNCERTAIN",
                             message: "StoreKit purchase result is uncertain; requery transactions.")
        }
    }

    /// The code an OpenIAP failure rejects with (`finishTransaction`). The
    /// transaction lists come from `RecoveryReadShim`, which skips an
    /// unverified entry instead of failing.
    public static func queryFailureCode(_ error: Error) -> String {
        if let purchaseError = error as? PurchaseError,
           purchaseError.code == .transactionValidationFailed {
            return "STOREKIT_TRANSACTION_UNVERIFIED"
        }
        return "STOREKIT_UNAVAILABLE"
    }

    // MARK: - Validation and formatting

    public static func isValidProductId(_ value: String) -> Bool {
        value.range(of: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$", options: .regularExpression) != nil
    }

    /// A UUID app account token, lowercased; nil when invalid. `finish`
    /// also refuses the nil UUID, as the 0.3 plugin did; `purchase` accepted
    /// any UUID in 0.3 and still does (the StoreKit SDK never sends the nil one).
    public static func normalizedAccountToken(_ value: String?, allowNil: Bool = false) -> String? {
        guard let value, let uuid = UUID(uuidString: value) else { return nil }
        let normalized = uuid.uuidString.lowercased()
        return !allowNil && normalized == "00000000-0000-0000-0000-000000000000" ? nil : normalized
    }

    /// The 0.3 plugin's timestamp format: `ISO8601DateFormatter` defaults.
    public static func isoTimestamp(milliseconds: Double) -> String {
        ISO8601DateFormatter().string(from: Date(timeIntervalSince1970: milliseconds / 1000))
    }

    static func isCompactJws(_ value: String) -> Bool {
        let parts = value.split(separator: ".", omittingEmptySubsequences: false)
        return parts.count == 3 && parts.allSatisfy { !$0.isEmpty }
    }

    /// The claims of a compact JWS StoreKit already verified. Only read for
    /// the `type` claim OpenIAP's `PurchaseIOS` does not carry.
    static func jwsPayload(_ jws: String) -> [String: Any]? {
        let parts = jws.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3 else { return nil }
        var base64 = String(parts[1])
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        while base64.count % 4 != 0 {
            base64.append("=")
        }
        guard let data = Data(base64Encoded: base64),
              let object = try? JSONSerialization.jsonObject(with: data),
              let claims = object as? [String: Any] else {
            return nil
        }
        return claims
    }
}
