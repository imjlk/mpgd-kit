import Foundation
import OpenIAP

/// The OpenIAP Apple connection one Capacitor plugin instance owns.
///
/// This is the store-neutral half of the bridge: it selects the Apple
/// provider explicitly, checks that the selected provider really is `apple`,
/// keeps one OpenIAP purchase listener for the plugin's lifetime, and closes
/// the connection when the plugin goes away. mpgd policy (which transactions
/// are reported and finished) lives in `StoreKitTransactionPolicy`.
public final class OpenIapAppleConnection {
    public let module: OpenIapModule
    private var purchaseSubscription: Subscription?
    private var started = false

    /// The Apple provider is selected explicitly rather than through the
    /// `dev.hyo.openiap.PROVIDER` Info.plist key, so a host app cannot route
    /// mpgd's App Store evidence through another store's provider.
    public init(module: OpenIapModule = OpenIapModule(factory: OpenIapAppleProviderFactory())) {
        self.module = module
    }

    /// The provider error, or nil when OpenIAP selected the Apple provider.
    /// Every plugin method rejects while this is non-nil.
    public var providerError: String? {
        guard let storeId = module.storeId else {
            return "The OpenIAP Apple provider could not be selected."
        }
        guard storeId == StoreKitTransactionPolicy.appleStoreId else {
            return "OpenIAP selected the \(storeId) provider; this plugin requires apple."
        }
        return nil
    }

    /// Opens the connection and attaches the single purchase listener. Safe to
    /// call more than once; later calls are no-ops. `onPurchase` receives every
    /// verified purchase OpenIAP reports, replays included
    /// (`dedupeTransactionIOS: false`), so the plugin keeps forwarding each
    /// StoreKit update the way the 0.3 `Transaction.updates` loop did.
    public func start(onPurchase: @escaping @Sendable (PurchaseIOS) -> Void) {
        guard !started, providerError == nil else { return }
        started = true
        purchaseSubscription = module.purchaseUpdatedListener({ purchase in
            if case .purchaseIos(let ios) = purchase {
                onPurchase(ios)
            }
        }, options: PurchaseUpdatedListenerOptions(dedupeTransactionIOS: false))
        Task { [module] in
            // Every OpenIAP call also ensures the connection; this only starts
            // the transaction listener at launch, as the 0.3 plugin did.
            _ = try? await module.initConnection()
        }
    }

    /// Removes the listener and ends the connection. The plugin calls this
    /// from `deinit`; nothing is finished or cancelled in StoreKit.
    public func stop() {
        if let subscription = purchaseSubscription {
            module.removeListener(subscription)
            purchaseSubscription = nil
        }
        guard started else { return }
        started = false
        Task { [module] in
            _ = try? await module.endConnection()
        }
    }
}
