import Foundation
import OpenIAP
import XCTest
@testable import MpgdStoreKitBridge

/// Locks the 0.3 `CapacitorStoreKit` wire contract over OpenIAP's canonical
/// Apple purchase. The expected dictionaries below are what the 0.3 native
/// plugin (`verifiedPayload`, `getTransactions`) produced for the same
/// StoreKit transaction, so journals and evidence written by the old engine
/// keep resolving under the new one.
final class StoreKitTransactionPolicyTests: XCTestCase {
    private let token = "6f1c8e2a-4b7d-4c2e-9a1f-0d3b5c7e9f11"
    private let purchasedAtMillis = 1_700_000_000_123.0

    private func jws(type: String?, extra: [String: Any] = [:]) -> String {
        func encode(_ object: [String: Any]) -> String {
            let data = try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
            return data.base64EncodedString()
                .replacingOccurrences(of: "+", with: "-")
                .replacingOccurrences(of: "/", with: "_")
                .replacingOccurrences(of: "=", with: "")
        }
        var claims: [String: Any] = ["transactionId": "2000000000000001", "bundleId": "dev.mpgd.test"]
        if let type { claims["type"] = type }
        claims.merge(extra) { _, new in new }
        return "\(encode(["alg": "ES256", "x5c": ["cert"]])).\(encode(claims)).c2lnbmF0dXJl"
    }

    private func purchase(
        id: String = "2000000000000001",
        originalId: String? = "2000000000000000",
        productId: String = "coins_100",
        type: String? = "Consumable",
        token: String? = "6F1C8E2A-4B7D-4C2E-9A1F-0D3B5C7E9F11",
        revokedAtMillis: Double? = nil,
        storeId: String = "apple",
        purchaseToken: String? = nil
    ) -> PurchaseIOS {
        PurchaseIOS(
            appAccountToken: token,
            id: id,
            isAutoRenewing: false,
            originalTransactionIdentifierIOS: originalId,
            productId: productId,
            purchaseState: .purchased,
            purchaseToken: purchaseToken ?? jws(type: type),
            quantity: 1,
            revocationDateIOS: revokedAtMillis,
            store: .apple,
            storeId: storeId,
            transactionDate: purchasedAtMillis,
            transactionId: id
        )
    }

    // MARK: - Payload shape

    func testPayloadMatchesThe03NativeShape() throws {
        let purchase = purchase()
        let transaction = try XCTUnwrap(StoreKitTransactionPolicy.transaction(from: purchase))
        let payload = StoreKitTransactionPolicy.payload(transaction)
        XCTAssertEqual(Set(payload.keys), [
            "transactionId", "originalTransactionId", "productId", "type",
            "purchasedAt", "signedTransaction", "appAccountToken"
        ])
        XCTAssertEqual(payload["transactionId"] as? String, "2000000000000001")
        XCTAssertEqual(payload["originalTransactionId"] as? String, "2000000000000000")
        XCTAssertEqual(payload["productId"] as? String, "coins_100")
        XCTAssertEqual(payload["type"] as? String, "consumable")
        // ISO8601DateFormatter defaults, exactly as the 0.3 plugin formatted
        // `transaction.purchaseDate`.
        XCTAssertEqual(payload["purchasedAt"] as? String, "2023-11-14T22:13:20Z")
        XCTAssertEqual(payload["purchasedAt"] as? String,
                       ISO8601DateFormatter().string(from: Date(timeIntervalSince1970: 1_700_000_000.123)))
        XCTAssertEqual(payload["signedTransaction"] as? String, purchase.purchaseToken)
        // StoreKit's uppercase UUID string is lowercased, as before.
        XCTAssertEqual(payload["appAccountToken"] as? String, token)
        XCTAssertNil(payload["unfinished"])
        XCTAssertNil(payload["revokedAt"])
    }

    func testRevokedAndUnboundTransactionsKeepTheirOptionalFields() throws {
        let revoked = try XCTUnwrap(StoreKitTransactionPolicy.transaction(
            from: purchase(token: nil, revokedAtMillis: 1_700_000_100_000)))
        let payload = StoreKitTransactionPolicy.payload(revoked, unfinished: false)
        XCTAssertEqual(payload["revokedAt"] as? String, "2023-11-14T22:15:00Z")
        XCTAssertNil(payload["appAccountToken"])
        XCTAssertEqual(payload["unfinished"] as? Bool, false)
    }

    func testOriginalIdFallsBackToTheTransactionId() throws {
        let transaction = try XCTUnwrap(StoreKitTransactionPolicy.transaction(from: purchase(originalId: nil)))
        XCTAssertEqual(transaction.originalTransactionId, "2000000000000001")
    }

    func testNonConsumableTypeClaim() throws {
        let transaction = try XCTUnwrap(StoreKitTransactionPolicy.transaction(
            from: purchase(productId: "remove_ads", type: "Non-Consumable")))
        XCTAssertEqual(transaction.type, .nonConsumable)
        XCTAssertEqual(StoreKitTransactionPolicy.payload(transaction)["type"] as? String, "non_consumable")
    }

    func testOnlyVerifiedOneTimeAppleTransactionsAreReported() {
        XCTAssertNil(StoreKitTransactionPolicy.transaction(from: purchase(type: "Auto-Renewable Subscription")))
        XCTAssertNil(StoreKitTransactionPolicy.transaction(from: purchase(type: "Non-Renewing Subscription")))
        XCTAssertNil(StoreKitTransactionPolicy.transaction(from: purchase(type: nil)))
        XCTAssertNil(StoreKitTransactionPolicy.transaction(from: purchase(storeId: "play")))
        // OpenIAP falls back to the transaction id when it has no JWS.
        XCTAssertNil(StoreKitTransactionPolicy.transaction(from: purchase(purchaseToken: "2000000000000001")))
        XCTAssertNil(StoreKitTransactionPolicy.transaction(from: purchase(purchaseToken: "a.!!!.c")))
    }

    // MARK: - getTransactions scope

    func testListedTransactionsKeepThe03Scope() throws {
        let unfinishedConsumable = purchase(id: "11")
        let unfinishedDurable = purchase(id: "12", productId: "remove_ads", type: "Non-Consumable")
        let finishedDurable = purchase(id: "13", productId: "starter_pack", type: "Non-Consumable")
        let subscription = purchase(id: "14", productId: "vip", type: "Auto-Renewable Subscription")
        // currentEntitlements never lists consumables; a bogus one is ignored anyway.
        let entitledConsumable = purchase(id: "15")
        let listed = try StoreKitTransactionPolicy.listedTransactions(
            unfinished: [unfinishedConsumable, unfinishedDurable, subscription],
            entitlements: [unfinishedDurable, finishedDurable, subscription, entitledConsumable]
        )
        XCTAssertEqual(listed.map { $0["transactionId"] as? String }, ["11", "12", "13"])
        XCTAssertEqual(listed.map { $0["unfinished"] as? Bool }, [true, true, false])
    }

    func testAnEmptyStoreListsNothing() throws {
        XCTAssertTrue(try StoreKitTransactionPolicy.listedTransactions(unfinished: [], entitlements: []).isEmpty)
    }

    func testAnUnreadableTransactionFailsTheQueryInsteadOfShorteningIt() {
        // A verified purchase whose JWS carries no `type` claim must not just
        // disappear: the game would read a missing consumable as finished.
        for unreadable in [
            purchase(id: "31", type: nil),
            purchase(id: "32", purchaseToken: "2000000000000032"),
            purchase(id: "33", storeId: "play")
        ] {
            XCTAssertEqual(StoreKitTransactionPolicy.classify(unreadable), .unreadable)
            XCTAssertThrowsError(try StoreKitTransactionPolicy.listedTransactions(
                unfinished: [purchase(id: "30"), unreadable], entitlements: [])) { error in
                XCTAssertEqual(error as? StoreKitTransactionPolicy.UnreadableTransaction,
                               StoreKitTransactionPolicy.UnreadableTransaction(transactionId: unreadable.id))
                XCTAssertEqual(StoreKitTransactionPolicy.queryFailureCode(error), "STOREKIT_EVIDENCE_INVALID")
            }
            XCTAssertThrowsError(try StoreKitTransactionPolicy.listedTransactions(
                unfinished: [], entitlements: [unreadable]))
        }
        XCTAssertEqual(StoreKitTransactionPolicy.classify(purchase(type: "Auto-Renewable Subscription")), .notOneTime)
    }

    func testQueryFailuresAreNeverAnEmptyList() {
        let unverified = PurchaseError(code: .transactionValidationFailed, message: "Transaction verification failed")
        XCTAssertEqual(StoreKitTransactionPolicy.queryFailureCode(unverified), "STOREKIT_TRANSACTION_UNVERIFIED")
        XCTAssertEqual(StoreKitTransactionPolicy.queryFailureCode(
            PurchaseError(code: .initConnection, message: "init")), "STOREKIT_UNAVAILABLE")
        XCTAssertEqual(StoreKitTransactionPolicy.queryFailureCode(CancellationError()), "STOREKIT_UNAVAILABLE")
    }

    // MARK: - finishTransaction gate

    func testFinishRequiresTheSessionTokenAndNoRevocation() throws {
        let bound = purchase(id: "21")
        let match = try XCTUnwrap(StoreKitTransactionPolicy.finishable(
            transactionId: "21", appAccountToken: token.uppercased(), in: [bound]))
        XCTAssertEqual(match.purchase.id, "21")
        XCTAssertEqual(match.type, .consumable)

        XCTAssertNil(StoreKitTransactionPolicy.finishable(
            transactionId: "21", appAccountToken: "0a1c8e2a-4b7d-4c2e-9a1f-0d3b5c7e9f11", in: [bound]))
        XCTAssertNil(StoreKitTransactionPolicy.finishable(
            transactionId: "22", appAccountToken: token, in: [bound]))
        XCTAssertNil(StoreKitTransactionPolicy.finishable(
            transactionId: "23", appAccountToken: token,
            in: [purchase(id: "23", revokedAtMillis: 1_700_000_100_000)]))
        XCTAssertNil(StoreKitTransactionPolicy.finishable(
            transactionId: "24", appAccountToken: token, in: [purchase(id: "24", token: nil)]))
        XCTAssertNil(StoreKitTransactionPolicy.finishable(
            transactionId: "25", appAccountToken: token,
            in: [purchase(id: "25", type: "Auto-Renewable Subscription")]))
        XCTAssertNil(StoreKitTransactionPolicy.finishable(
            transactionId: "26", appAccountToken: token, in: [purchase(id: "26", storeId: "play")]))
    }

    func testPurchaseResultMustMatchTheRequest() throws {
        let transaction = try XCTUnwrap(StoreKitTransactionPolicy.transaction(from: purchase()))
        XCTAssertTrue(StoreKitTransactionPolicy.matchesPurchaseRequest(
            transaction, productId: "coins_100", appAccountToken: token))
        XCTAssertFalse(StoreKitTransactionPolicy.matchesPurchaseRequest(
            transaction, productId: "coins_500", appAccountToken: token))
        XCTAssertFalse(StoreKitTransactionPolicy.matchesPurchaseRequest(
            transaction, productId: "coins_100", appAccountToken: "0a1c8e2a-4b7d-4c2e-9a1f-0d3b5c7e9f11"))
    }

    // MARK: - Purchase outcomes

    func testAskToBuyIsPendingNotCancelled() {
        XCTAssertEqual(StoreKitTransactionPolicy.purchaseFailure(.deferredPayment), .pending)
        XCTAssertEqual(StoreKitTransactionPolicy.purchaseFailure(.userCancelled), .cancelled)
    }

    func testFailuresAfterTheSheetStayUncertain() {
        for code in [ErrorCode.purchaseError, .networkError, .serviceError, .remoteError, .interrupted] {
            XCTAssertEqual(StoreKitTransactionPolicy.purchaseFailure(code), .rejected(
                code: "STOREKIT_PURCHASE_UNCERTAIN",
                message: "StoreKit purchase result is uncertain; requery transactions."), "\(code)")
        }
        XCTAssertEqual(StoreKitTransactionPolicy.purchaseFailure(.unknown), .rejected(
            code: "STOREKIT_UNKNOWN_RESULT", message: "StoreKit returned an unknown purchase result."))
    }

    func testFailuresBeforeTheSheetUseThe03Codes() {
        func code(_ error: ErrorCode) -> String? {
            if case .rejected(let code, _) = StoreKitTransactionPolicy.purchaseFailure(error) { return code }
            return nil
        }
        XCTAssertEqual(code(.skuNotFound), "STOREKIT_PRODUCT_UNAVAILABLE")
        XCTAssertEqual(code(.itemUnavailable), "STOREKIT_PRODUCT_UNAVAILABLE")
        XCTAssertEqual(code(.queryProduct), "STOREKIT_PRODUCT_LOOKUP_FAILED")
        XCTAssertEqual(code(.developerError), "STOREKIT_INVALID_PURCHASE")
        XCTAssertEqual(code(.transactionValidationFailed), "STOREKIT_TRANSACTION_UNVERIFIED")
        XCTAssertEqual(code(.iapNotAvailable), "STOREKIT_UNAVAILABLE")
        XCTAssertEqual(code(.initConnection), "STOREKIT_UNAVAILABLE")
    }

    // MARK: - Products and inputs

    func testProductPayloadSellsOneTimeProductsOnly() throws {
        func product(_ type: ProductTypeIOS) -> ProductIOS {
            ProductIOS(currency: "USD", description: "100 coins", displayNameIOS: "Coins", displayPrice: "$0.99",
                       id: "coins_100", isFamilyShareableIOS: false, jsonRepresentationIOS: "{}",
                       title: "Coins", typeIOS: type)
        }
        let payload = try XCTUnwrap(StoreKitTransactionPolicy.productPayload(product(.consumable)))
        XCTAssertEqual(payload["productId"] as? String, "coins_100")
        XCTAssertEqual(payload["type"] as? String, "consumable")
        XCTAssertEqual(payload["title"] as? String, "Coins")
        XCTAssertEqual(payload["description"] as? String, "100 coins")
        XCTAssertEqual(payload["formattedPrice"] as? String, "$0.99")
        XCTAssertEqual(payload["currencyCode"] as? String, "USD")
        XCTAssertEqual(StoreKitTransactionPolicy.productPayload(product(.nonConsumable))?["type"] as? String,
                       "non_consumable")
        XCTAssertNil(StoreKitTransactionPolicy.productPayload(product(.autoRenewableSubscription)))
        XCTAssertNil(StoreKitTransactionPolicy.productPayload(product(.nonRenewingSubscription)))
    }

    func testAccountTokensAndProductIds() {
        XCTAssertEqual(StoreKitTransactionPolicy.normalizedAccountToken(token.uppercased()), token)
        XCTAssertNil(StoreKitTransactionPolicy.normalizedAccountToken("00000000-0000-0000-0000-000000000000"))
        // `purchase` keeps the 0.3 rule: any UUID; only finish refuses the nil one.
        XCTAssertEqual(StoreKitTransactionPolicy.normalizedAccountToken(
            "00000000-0000-0000-0000-000000000000", allowNil: true), "00000000-0000-0000-0000-000000000000")
        XCTAssertNil(StoreKitTransactionPolicy.normalizedAccountToken("not-a-uuid"))
        XCTAssertNil(StoreKitTransactionPolicy.normalizedAccountToken(nil))
        XCTAssertTrue(StoreKitTransactionPolicy.isValidProductId("coins_100.v2-a"))
        XCTAssertFalse(StoreKitTransactionPolicy.isValidProductId("_coins"))
        XCTAssertFalse(StoreKitTransactionPolicy.isValidProductId(String(repeating: "a", count: 129)))
    }
}
