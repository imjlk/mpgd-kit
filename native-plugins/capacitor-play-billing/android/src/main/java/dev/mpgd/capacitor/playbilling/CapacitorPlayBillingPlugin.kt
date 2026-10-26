package dev.mpgd.capacitor.playbilling

import android.os.Handler
import android.os.Looper
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import dev.hyo.openiap.OpenIapError
import dev.hyo.openiap.PurchaseAndroid
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONException

/**
 * Purchase collection only, over the OpenIAP Google core. Finalization is
 * server-owned after the mpgd ledger grant: this plugin never finishes,
 * acknowledges, or consumes a purchase, and the encoded `isAcknowledged` flag
 * lets the TypeScript provider list unfinished purchases for the backend
 * finalizer. All plugin state is touched on the main thread only.
 */
@CapacitorPlugin(name = "CapacitorPlayBilling")
class CapacitorPlayBillingPlugin : Plugin() {
    private val mainHandler = Handler(Looper.getMainLooper())
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var connection: OpenIapPlayConnection? = null
    private var providerError: String? = null
    private var activePurchase: PluginCall? = null
    private var activeProductId: String? = null
    private var purchaseTimeout: Job? = null

    /** True from the start of an OpenIAP purchase flow until OpenIAP returns. */
    private var flowInProgress = false

    /**
     * Product of a purchase call that timed out while the Play UI was still
     * up. When OpenIAP later reports that flow's cancel or failure, it is
     * delivered as a `purchaseUpdated` event so the JavaScript attempt the
     * timeout left open can close.
     */
    private var timedOutProductId: String? = null

    override fun load() {
        try {
            connection = OpenIapPlayConnection.open(context) { purchase ->
                onMain { onPurchaseUpdated(purchase) }
            }
        } catch (error: OpenIapError) {
            providerError = error.message
        } catch (error: RuntimeException) {
            providerError = "OpenIAP could not load the Google Play provider."
        }
    }

    override fun handleOnDestroy() {
        activePurchase?.let { call ->
            clearActivePurchase(call)
            call.reject("Purchase flow was interrupted.", "PLAY_BILLING_INTERRUPTED")
        }
        scope.cancel()
        connection?.close()
        connection = null
        super.handleOnDestroy()
    }

    @PluginMethod
    fun getProducts(call: PluginCall) {
        onMain { getProductsOnMain(call) }
    }

    private fun getProductsOnMain(call: PluginCall) {
        val ids = call.getArray("productIds")
        if (ids == null || ids.length() == 0 || ids.length() > 100) {
            call.reject("Provide 1-100 product IDs.", "PLAY_BILLING_INVALID_PRODUCTS")
            return
        }
        val productIds = mutableListOf<String>()
        try {
            for (index in 0 until ids.length()) {
                val productId = ids.getString(index)
                if (productId == null || productId.trim().isEmpty()) {
                    call.reject("Product ID is invalid.", "PLAY_BILLING_INVALID_PRODUCT")
                    return
                }
                productIds += productId
            }
        } catch (error: JSONException) {
            call.reject("Product IDs are invalid.", "PLAY_BILLING_INVALID_PRODUCTS")
            return
        }
        val active = connectionOrReject(call) ?: return
        launchCall(call) {
            if (!active.connect()) {
                rejectUnavailable(call)
                return@launchCall
            }
            val products = JSArray()
            for (product in active.fetchInAppProducts(productIds)) {
                PlayBillingPolicy.productPayload(product)?.let { products.put(toJs(it)) }
            }
            call.resolve(JSObject().put("products", products))
        }
    }

    @PluginMethod
    fun purchase(call: PluginCall) {
        onMain { purchaseOnMain(call) }
    }

    private fun purchaseOnMain(call: PluginCall) {
        val productId = call.getString("productId")
        val accountId = call.getString("obfuscatedAccountId")
        val selectedOfferToken = call.getString("offerToken")
        if (productId == null || productId.trim().isEmpty() || accountId == null ||
            accountId.trim().isEmpty() || accountId.length > 64
        ) {
            call.reject("Product and account identifiers are required.", "PLAY_BILLING_INVALID_REQUEST")
            return
        }
        val active = connectionOrReject(call) ?: return
        // OpenIAP holds one flow at a time, including one whose call already
        // timed out here; a second flow is busy until OpenIAP releases it.
        if (activePurchase != null || flowInProgress) {
            call.reject("Another purchase is already in progress.", "PLAY_BILLING_BUSY")
            return
        }
        activePurchase = call
        activeProductId = productId
        timedOutProductId = null
        flowInProgress = true
        purchaseTimeout = scope.launch {
            delay(PURCHASE_TIMEOUT_MILLIS)
            if (activePurchase === call) {
                timedOutProductId = activeProductId
                clearActivePurchase(call)
                call.reject("Purchase confirmation timed out; requery owned purchases.", "PLAY_BILLING_TIMEOUT")
            }
        }
        scope.launch {
            val resolution = try {
                runPurchase(active, productId, accountId, selectedOfferToken)
            } catch (error: CancellationException) {
                flowInProgress = false
                throw error
            } catch (error: OpenIapError) {
                if (PlayBillingPolicy.isCancellation(error)) {
                    PurchaseResolution.Cancelled
                } else {
                    PurchaseResolution.Failed(PlayBillingPolicy.errorCode(error), billingMessage(error))
                }
            } catch (error: RuntimeException) {
                PurchaseResolution.Failed("PLAY_BILLING_ERROR", "Google Play Billing failed.")
            }
            flowInProgress = false
            settlePurchase(call, productId, resolution)
        }
    }

    private suspend fun runPurchase(
        active: OpenIapPlayConnection,
        productId: String,
        accountId: String,
        selectedOfferToken: String?,
    ): PurchaseResolution {
        if (!active.connect()) {
            return PurchaseResolution.Failed("PLAY_BILLING_SERVICE_UNAVAILABLE", UNAVAILABLE_MESSAGE)
        }
        val product = active.fetchInAppProducts(listOf(productId))
            .filter { it.id == productId && PlayBillingPolicy.isAvailable(it) }
            .singleOrNull()
            ?: return PurchaseResolution.Failed("PLAY_BILLING_PRODUCT_UNAVAILABLE", "Product is unavailable.")
        val offer = PlayBillingPolicy.selectOffer(PlayBillingPolicy.eligibleOffers(product), selectedOfferToken)
            ?: return PurchaseResolution.Failed("PLAY_BILLING_OFFER_REQUIRED", "Select an eligible one-time offer.")
        val activity = activity
            ?: return PurchaseResolution.Failed("PLAY_BILLING_ACTIVITY_REQUIRED", "Billing requires a foreground activity.")
        // Tokens Play already reports. OpenIAP answers ITEM_ALREADY_OWNED with
        // the owned purchase; the 0.3 contract rejects instead, and the owned
        // purchase still reaches JavaScript through `purchaseUpdated`.
        val ownedBefore = active.inAppPurchases().mapNotNullTo(HashSet()) { it.purchaseToken }
        val (purchases, error) = active.purchase(activity, productId, offer.offerTokenAndroid.orEmpty(), accountId)
        val matched = purchases.firstOrNull { it.ids.orEmpty().contains(productId) }
        if (matched != null) {
            if (matched.purchaseToken in ownedBefore) {
                return PurchaseResolution.Failed("PLAY_BILLING_ALREADY_OWNED", "The product is already owned.")
            }
            val payload = PlayBillingPolicy.purchasePayload(matched)
                ?: return PurchaseResolution.Failed("PLAY_BILLING_EMPTY_PURCHASE", EMPTY_MESSAGE)
            return PurchaseResolution.Reported(PlayBillingPolicy.outcomePayload(payload))
        }
        return when {
            error == null -> PurchaseResolution.Failed("PLAY_BILLING_EMPTY_PURCHASE", EMPTY_MESSAGE)
            PlayBillingPolicy.isCancellation(error) -> PurchaseResolution.Cancelled
            else -> PurchaseResolution.Failed(PlayBillingPolicy.errorCode(error), billingMessage(error))
        }
    }

    private fun settlePurchase(call: PluginCall, productId: String, resolution: PurchaseResolution) {
        if (activePurchase === call) {
            clearActivePurchase(call)
            when (resolution) {
                is PurchaseResolution.Reported -> call.resolve(toJs(resolution.outcome))
                PurchaseResolution.Cancelled -> call.resolve(JSObject().put("status", "cancelled"))
                is PurchaseResolution.Failed -> call.reject(resolution.message, resolution.code)
            }
            return
        }
        // The call already timed out. A purchase reached JavaScript through
        // `purchaseUpdated`; a cancel or failure closes the open attempt.
        if (timedOutProductId != productId) return
        when (resolution) {
            is PurchaseResolution.Reported -> timedOutProductId = null
            PurchaseResolution.Cancelled -> notifyLateTerminalResult("cancelled", null)
            is PurchaseResolution.Failed ->
                if (resolution.code != "PLAY_BILLING_EMPTY_PURCHASE") {
                    notifyLateTerminalResult("failed", resolution.code)
                }
        }
    }

    @PluginMethod
    fun getPurchases(call: PluginCall) {
        onMain {
            val active = connectionOrReject(call) ?: return@onMain
            launchCall(call) {
                if (!active.connect()) {
                    rejectUnavailable(call)
                    return@launchCall
                }
                val purchases = JSArray()
                for (purchase in active.inAppPurchases()) {
                    PlayBillingPolicy.purchasePayload(purchase)?.let { purchases.put(toJs(it)) }
                }
                call.resolve(JSObject().put("purchases", purchases))
            }
        }
    }

    private fun onPurchaseUpdated(purchase: PurchaseAndroid) {
        val payload = PlayBillingPolicy.purchasePayload(purchase) ?: return
        // Retained until a listener consumes it: a purchase that completes
        // after the purchase call timed out, or before the web view attached
        // its listener, must still reach the provider's subscription.
        notifyListeners("purchaseUpdated", toJs(PlayBillingPolicy.outcomePayload(payload)), true)
        val timedOut = timedOutProductId
        if (timedOut != null && purchase.ids.orEmpty().contains(timedOut)) {
            timedOutProductId = null
        }
    }

    /**
     * A cancel or failure that arrives after the purchase call already timed
     * out has no call to answer; without this event the JavaScript attempt
     * would stay open and block another purchase of the product.
     */
    private fun notifyLateTerminalResult(status: String, code: String?) {
        val productId = timedOutProductId ?: return
        timedOutProductId = null
        val outcome = JSObject().put("status", status).put("productId", productId)
        if (code != null) {
            outcome.put("code", code)
        }
        notifyListeners("purchaseUpdated", outcome, true)
    }

    private fun connectionOrReject(call: PluginCall): OpenIapPlayConnection? {
        connection?.let { return it }
        call.reject(providerError ?: "Google Play Billing is not configured.", "PLAY_BILLING_CONFIGURATION_ERROR")
        return null
    }

    /** Runs a query on the main thread and answers every outcome, interruption included. */
    private fun launchCall(call: PluginCall, block: suspend () -> Unit) {
        scope.launch {
            try {
                block()
            } catch (error: CancellationException) {
                call.reject("Billing connection was interrupted.", "PLAY_BILLING_INTERRUPTED")
                throw error
            } catch (error: OpenIapError) {
                call.reject(billingMessage(error), PlayBillingPolicy.errorCode(error))
            } catch (error: RuntimeException) {
                call.reject("Google Play Billing failed.", "PLAY_BILLING_ERROR")
            }
        }
    }

    private fun rejectUnavailable(call: PluginCall) {
        call.reject(UNAVAILABLE_MESSAGE, "PLAY_BILLING_SERVICE_UNAVAILABLE")
    }

    private fun clearActivePurchase(call: PluginCall) {
        if (activePurchase === call) {
            activePurchase = null
            activeProductId = null
            purchaseTimeout?.cancel()
            purchaseTimeout = null
        }
    }

    private fun onMain(task: () -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            task()
        } else {
            mainHandler.post(task)
        }
    }

    private sealed class PurchaseResolution {
        data class Reported(val outcome: Map<String, Any>) : PurchaseResolution()
        object Cancelled : PurchaseResolution()
        data class Failed(val code: String, val message: String) : PurchaseResolution()
    }

    private companion object {
        const val PURCHASE_TIMEOUT_MILLIS = 180_000L
        const val UNAVAILABLE_MESSAGE = "Google Play Billing is unavailable."
        const val EMPTY_MESSAGE = "Purchase callback was empty; requery owned purchases."

        fun billingMessage(error: OpenIapError): String =
            "Google Play Billing is unavailable (${error.code})."

        @Suppress("UNCHECKED_CAST")
        fun toJs(value: Map<String, Any>): JSObject {
            val result = JSObject()
            for ((key, item) in value) {
                when (item) {
                    is Map<*, *> -> result.put(key, toJs(item as Map<String, Any>))
                    is List<*> -> result.put(key, toJsArray(item))
                    else -> result.put(key, item)
                }
            }
            return result
        }

        @Suppress("UNCHECKED_CAST")
        fun toJsArray(values: List<*>): JSArray {
            val result = JSArray()
            for (item in values) {
                when (item) {
                    is Map<*, *> -> result.put(toJs(item as Map<String, Any>))
                    is List<*> -> result.put(toJsArray(item))
                    else -> result.put(item)
                }
            }
            return result
        }
    }
}
