package dev.mpgd.capacitor.playbilling

import android.app.Activity
import android.content.Context
import dev.hyo.openiap.FetchProductsResultProducts
import dev.hyo.openiap.OpenIapError
import dev.hyo.openiap.OpenIapProtocol
import dev.hyo.openiap.OpenIapProvider
import dev.hyo.openiap.ProductAndroid
import dev.hyo.openiap.ProductQueryType
import dev.hyo.openiap.ProductRequest
import dev.hyo.openiap.PurchaseAndroid
import dev.hyo.openiap.RequestPurchaseAndroidProps
import dev.hyo.openiap.RequestPurchaseProps
import dev.hyo.openiap.RequestPurchasePropsByPlatforms
import dev.hyo.openiap.RequestPurchaseResultPurchase
import dev.hyo.openiap.RequestPurchaseResultPurchases
import dev.hyo.openiap.listener.OpenIapPurchaseErrorListener
import dev.hyo.openiap.listener.OpenIapPurchaseUpdateListener
import dev.hyo.openiap.store.OpenIapStore
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * The OpenIAP Google connection one Capacitor plugin instance owns: the
 * store-neutral half of the bridge.
 *
 * The provider comes from OpenIAP's own discovery (the merged
 * `dev.hyo.openiap.PROVIDER` manifest entry), not from a hard-coded Play
 * class, and the plugin refuses to run unless that provider is `play`: a
 * receipt from another store must never reach the Google Play verifier.
 * `OpenIapStore` is the public facade for connection, products, and purchase
 * flows; the provider module is kept only for the in-app-only ownership
 * query (`getAvailableItems(InApp)`), which the facade does not expose.
 *
 * The connection never finishes a purchase. `OpenIapStore.finishTransaction`,
 * `acknowledgePurchaseAndroid`, and `consumePurchaseAndroid` are not called
 * anywhere in this plugin: the mpgd backend finalizer consumes or
 * acknowledges after its ledger grant.
 */
internal class OpenIapPlayConnection private constructor(
    private val module: OpenIapProtocol,
    private val store: OpenIapStore,
    onPurchase: (PurchaseAndroid) -> Unit,
) {
    private val errorSink = AtomicReference<((OpenIapError) -> Unit)?>(null)
    private val updateListener = OpenIapPurchaseUpdateListener { purchase ->
        (purchase as? PurchaseAndroid)?.let(onPurchase)
    }
    private val errorListener = OpenIapPurchaseErrorListener { error ->
        errorSink.get()?.invoke(error)
    }

    init {
        store.addPurchaseUpdateListener(updateListener)
        store.addPurchaseErrorListener(errorListener)
    }

    /** Connects, or confirms the live connection. False when Play Billing is unavailable. */
    suspend fun connect(): Boolean = store.initConnection(null)

    suspend fun fetchInAppProducts(productIds: List<String>): List<ProductAndroid> {
        val result = store.fetchProducts(ProductRequest(skus = productIds, type = ProductQueryType.InApp))
        return (result as? FetchProductsResultProducts)?.value.orEmpty().filterIsInstance<ProductAndroid>()
    }

    /** Every in-app purchase Play reports (`queryPurchasesAsync(INAPP)`), never subscriptions. */
    suspend fun inAppPurchases(): List<PurchaseAndroid> =
        module.getAvailableItems(ProductQueryType.InApp).filterIsInstance<PurchaseAndroid>()

    /**
     * Runs one purchase flow and returns the purchases OpenIAP matched to it,
     * with the error OpenIAP published for it when it matched none. OpenIAP
     * reports most flow failures (cancel included) through its error listener
     * and an empty result rather than by throwing.
     */
    suspend fun purchase(
        activity: Activity,
        productId: String,
        offerToken: String,
        obfuscatedAccountId: String,
    ): Pair<List<PurchaseAndroid>, OpenIapError?> {
        // OpenIAP publishes one error per purchase request, tagged with its
        // product; an untagged error counts only until a tagged one arrives.
        val captured = AtomicReference<OpenIapError?>(null)
        errorSink.set { error ->
            when (error.requestProductId) {
                productId -> captured.set(error)
                null -> captured.compareAndSet(null, error)
            }
        }
        try {
            store.setActivity(activity)
            val result = store.requestPurchase(
                RequestPurchaseProps(
                    request = RequestPurchaseProps.Request.Purchase(
                        RequestPurchasePropsByPlatforms(
                            google = RequestPurchaseAndroidProps(
                                obfuscatedAccountId = obfuscatedAccountId,
                                offerToken = offerToken,
                                skus = listOf(productId),
                            ),
                        ),
                    ),
                    type = ProductQueryType.InApp,
                ),
            )
            val purchases = when (result) {
                is RequestPurchaseResultPurchases -> result.value.orEmpty()
                is RequestPurchaseResultPurchase -> listOfNotNull(result.value)
                else -> emptyList()
            }.filterIsInstance<PurchaseAndroid>()
            return purchases to captured.get()
        } finally {
            errorSink.set(null)
        }
    }

    fun close() {
        store.removePurchaseUpdateListener(updateListener)
        store.removePurchaseErrorListener(errorListener)
        errorSink.set(null)
        store.clear()
        // Ending the connection never touches a purchase; it only releases Play.
        CoroutineScope(SupervisorJob() + Dispatchers.IO).launch {
            runCatching { store.endConnection() }
        }
    }

    companion object {
        /** Throws `OpenIapError.ProviderConfiguration` unless OpenIAP links the Play provider. */
        fun open(context: Context, onPurchase: (PurchaseAndroid) -> Unit): OpenIapPlayConnection {
            val factory = OpenIapProvider.factory(context)
            if (factory.storeId != PlayBillingPolicy.PLAY_STORE_ID) {
                throw OpenIapError.ProviderConfiguration(
                    "OpenIAP links the ${factory.storeId} provider; this plugin requires play.",
                )
            }
            val module = OpenIapProvider.create(context, factory)
            return OpenIapPlayConnection(module, OpenIapStore(module), onPurchase)
        }
    }
}
