import Foundation
import StoreKit

/// Compatibility shim: forwards verified **revoked** one-time transactions.
///
/// Why: OpenIAP Apple 4.0.5's `Transaction.updates` listener skips any
/// transaction with a `revocationDate` (`OpenIapStoreKitModule`
/// `startTransactionListener`, "Skipping revoked transaction"). The 0.3 mpgd
/// plugin forwarded those updates as `transactionUpdated` with `revokedAt`,
/// and `StoreSdk` turns them into `state: 'revoked'` so the game asks its
/// server to re-check the grant. Dropping them would silently remove the
/// refund signal.
///
/// Scope: this observes `Transaction.updates` only to read revocations. It
/// never purchases, lists, or finishes anything, and it ignores every
/// non-revoked update (OpenIAP's listener delivers those). The signal is a
/// prompt for the server to re-verify, never a ledger clawback by itself.
///
/// Removal: delete this shim once the pinned OpenIAP release can deliver
/// revoked transactions to its purchase listener (the upstream proposal in
/// `docs/specs/commerce/openiap-upstream-proposal.md` asks for that).
public final class RevocationUpdatesShim {
    private var task: Task<Void, Never>?

    public init() {}

    public func start(onRevoked: @escaping @Sendable (MpgdStoreKitTransaction) -> Void) {
        guard task == nil else { return }
        task = Task.detached(priority: .utility) {
            for await result in StoreKit.Transaction.updates {
                if Task.isCancelled { return }
                guard case .verified(let transaction) = result,
                      let revoked = Self.revokedTransaction(transaction, jws: result.jwsRepresentation) else {
                    continue
                }
                onRevoked(revoked)
            }
        }
    }

    public func stop() {
        task?.cancel()
        task = nil
    }

    deinit {
        task?.cancel()
    }

    static func revokedTransaction(
        _ transaction: StoreKit.Transaction,
        jws: String
    ) -> MpgdStoreKitTransaction? {
        guard transaction.revocationDate != nil else { return nil }
        return MpgdStoreKitTransaction(verified: transaction, jws: jws)
    }
}
