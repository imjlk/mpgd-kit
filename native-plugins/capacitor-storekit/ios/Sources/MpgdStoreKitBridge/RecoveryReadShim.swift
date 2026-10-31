import Foundation
import StoreKit

/// Compatibility shim: the verified, read-only transaction lists behind
/// `getTransactions` and the `finishTransaction` lookup.
///
/// Why: OpenIAP Apple 4.0.7's `getPendingTransactionsIOS` and
/// `getAvailablePurchases` throw on the first transaction StoreKit cannot
/// verify (`OpenIapStoreKitModule.checkVerified`), so one unverifiable
/// transaction on a device would hide every verified one from recovery and
/// block finishing them. The 0.3 plugin skipped an unverified transaction on
/// its own. This shim reads `Transaction.unfinished`,
/// `Transaction.currentEntitlements`, and `Transaction.all` the same way and
/// classifies each entry (`StoreKitTransactionPolicy.ReadEntry`).
///
/// Scope: reads only. It never purchases, finishes, or filters by account
/// (the TypeScript SDK admits transactions for the session account). Purchase,
/// finish, and the update listener stay on OpenIAP; the finish itself is
/// `OpenIapModule.finishTransaction`, whose own `Transaction.unfinished` scan
/// skips unverified entries.
///
/// Errors: these StoreKit sequences do not throw. Nothing here turns a
/// failure into an empty list; an empty list means StoreKit returned none.
///
/// Removal: delete this shim once the pinned OpenIAP release offers a
/// verified-only read that skips (and reports) unverified entries (upstream
/// request 3 in `docs/specs/commerce/openiap-upstream-proposal.md`).
public enum RecoveryReadShim {
    /// `Transaction.unfinished`.
    public static func unfinished() async -> [StoreKitTransactionPolicy.ReadEntry] {
        await read(StoreKit.Transaction.unfinished)
    }

    /// `Transaction.currentEntitlements` (active non-consumables and
    /// subscriptions; revoked ones are not entitlements).
    public static func currentEntitlements() async -> [StoreKitTransactionPolicy.ReadEntry] {
        await read(StoreKit.Transaction.currentEntitlements)
    }

    /// `Transaction.all`, the history the 0.3 finish searched.
    public static func history() async -> [StoreKitTransactionPolicy.ReadEntry] {
        await read(StoreKit.Transaction.all)
    }

    static func read(_ sequence: StoreKit.Transaction.Transactions) async -> [StoreKitTransactionPolicy.ReadEntry] {
        var entries: [StoreKitTransactionPolicy.ReadEntry] = []
        for await result in sequence {
            entries.append(entry(result))
        }
        return entries
    }

    static func entry(
        _ result: VerificationResult<StoreKit.Transaction>
    ) -> StoreKitTransactionPolicy.ReadEntry {
        guard case .verified(let transaction) = result else { return .unverified }
        guard let mapped = MpgdStoreKitTransaction(verified: transaction, jws: result.jwsRepresentation) else {
            return .notOneTime
        }
        return .oneTime(mapped)
    }
}

extension MpgdStoreKitTransaction {
    /// The 0.3 fields of a StoreKit-verified one-time transaction; nil for a
    /// subscription. Shared by the read and revocation shims.
    init?(verified transaction: StoreKit.Transaction, jws: String) {
        let type: MpgdOneTimeType
        switch transaction.productType {
        case .consumable: type = .consumable
        case .nonConsumable: type = .nonConsumable
        default: return nil
        }
        self.init(
            transactionId: String(transaction.id),
            originalTransactionId: String(transaction.originalID),
            productId: transaction.productID,
            type: type,
            appAccountToken: transaction.appAccountToken?.uuidString,
            purchasedAtMillis: transaction.purchaseDate.timeIntervalSince1970 * 1000,
            revokedAtMillis: transaction.revocationDate.map { $0.timeIntervalSince1970 * 1000 },
            signedTransaction: jws
        )
    }
}
