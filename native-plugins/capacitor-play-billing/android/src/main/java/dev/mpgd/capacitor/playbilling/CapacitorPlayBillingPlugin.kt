package dev.mpgd.capacitor.playbilling

import android.app.Activity
import android.app.Application
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import dev.hyo.openiap.OpenIapError
import dev.hyo.openiap.PurchaseAndroid
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
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
    // Every coroutine below answers its own call; the handler only keeps a
    // billing failure that escapes them (an Error) from crashing the game.
    private val scope = CoroutineScope(
        SupervisorJob() + Dispatchers.Main.immediate + CoroutineExceptionHandler { _, error ->
            Log.e(TAG, "Unhandled Google Play Billing failure: ${error.javaClass.name}")
        },
    )
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

    /** Sheet facts of the flow in progress; see `PurchasePresentationTracker`. */
    private val presentation = PurchasePresentationTracker { id, state, reason ->
        if (state == PurchasePresentationTracker.OPEN) {
            armSheetTimeout(id)
        } else {
            sheetTimeout?.cancel()
            sheetTimeout = null
        }
        notifyPresentation(id, state, reason)
    }
    private var sheetTimeout: Job? = null
    private var purchaseJob: Job? = null
    private var lateLaunchBound: Job? = null
    private var presentationId: String? = null
    private var lifecycleApplication: Application? = null

    // Every activity of the app process, the Billing Library's proxy
    // activities included; callbacks arrive on the main thread.
    private val activityCallbacks = object : Application.ActivityLifecycleCallbacks {
        override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {
            presentation.onActivityCreated(activity.javaClass.name)
        }

        override fun onActivityResumed(activity: Activity) {
            presentation.onActivityResumed(activity.javaClass.name)
        }

        override fun onActivityPaused(activity: Activity) {
            presentation.onActivityPaused(activity.javaClass.name)
        }

        override fun onActivityStarted(activity: Activity) = Unit
        override fun onActivityStopped(activity: Activity) = Unit
        override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit
        override fun onActivityDestroyed(activity: Activity) = Unit
    }

    override fun load() {
        try {
            connection = OpenIapPlayConnection.open(context) { purchase ->
                onMain { onPurchaseUpdated(purchase) }
            }
        } catch (error: OpenIapError) {
            providerError = error.message
        } catch (error: Exception) {
            logUnexpected("provider load", error)
            providerError = "OpenIAP could not load the Google Play provider."
        }
        lifecycleApplication = (context.applicationContext as? Application)?.also {
            it.registerActivityLifecycleCallbacks(activityCallbacks)
        }
    }

    override fun handleOnDestroy() {
        // Nothing is observed after this. A finishing app reports a sheet
        // still open as closed (`interrupted`); an activity that is only
        // recreated (a configuration change the manifest does not handle)
        // may leave the Play sheet up, so nothing is claimed for it.
        presentation.onTeardown(reportClosed = activity?.isChangingConfigurations != true)
        lateLaunchBound?.cancel()
        activePurchase?.let { call ->
            val id = presentationId
            clearActivePurchase(call)
            call.reject("Purchase flow was interrupted.", "PLAY_BILLING_INTERRUPTED", null, presentationData(id))
        }
        lifecycleApplication?.unregisterActivityLifecycleCallbacks(activityCallbacks)
        lifecycleApplication = null
        scope.cancel()
        connection?.close()
        connection = null
        super.handleOnDestroy()
    }

    /**
     * Declares the sheet facts this native code reports (`purchasePresentation`
     * events and the `presentation` field of `purchase` answers). A plugin
     * build without this method answers `UNIMPLEMENTED`, and the TypeScript
     * SDK then sells nothing that would wait for facts.
     */
    @PluginMethod
    fun getPresentationSupport(call: PluginCall) {
        call.resolve(JSObject().put("purchasePresentation", PurchasePresentationTracker.PROTOCOL_VERSION))
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
        // Correlates this call's sheet facts; sent only by a TypeScript SDK
        // that reads them. Without it the flow reports no facts, as before.
        val requestedPresentationId = call.getString("presentationId")
        if (requestedPresentationId != null &&
            !PurchasePresentationTracker.isValidPresentationId(requestedPresentationId)
        ) {
            call.reject(
                "The presentation id is invalid.",
                "PLAY_BILLING_INVALID_REQUEST",
                null,
                JSObject().put("presentation", PurchasePresentationTracker.NOT_STARTED),
            )
            return
        }
        if (productId == null || productId.trim().isEmpty() || accountId == null ||
            accountId.trim().isEmpty() || accountId.length > 64
        ) {
            rejectNotStarted(call, requestedPresentationId, "Product and account identifiers are required.", "PLAY_BILLING_INVALID_REQUEST")
            return
        }
        val active = connection
        if (active == null) {
            rejectNotStarted(
                call,
                requestedPresentationId,
                providerError ?: "Google Play Billing is not configured.",
                "PLAY_BILLING_CONFIGURATION_ERROR",
            )
            return
        }
        // OpenIAP holds one flow at a time, including one whose call already
        // timed out here; a second flow is busy until OpenIAP releases it, and
        // until the sheet of the last one is gone (its `closed` is still owed).
        if (activePurchase != null || flowInProgress || presentation.active) {
            rejectNotStarted(call, requestedPresentationId, "Another purchase is already in progress.", "PLAY_BILLING_BUSY")
            return
        }
        activePurchase = call
        activeProductId = productId
        presentationId = requestedPresentationId
        timedOutProductId = null
        flowInProgress = true
        requestedPresentationId?.let { presentation.begin(it) }
        purchaseTimeout = scope.launch {
            delay(PURCHASE_TIMEOUT_MILLIS)
            if (activePurchase === call) {
                val id = presentationId
                // A flow that never reached `launchBillingFlow` (stuck before
                // the launch) is ended here, `not-started`, and cancelled, so
                // the game is not held for a sheet that cannot come. A
                // launched flow keeps running and reports its sheet as events.
                if (id != null && presentation.cancelBeforeLaunch(id)) {
                    purchaseJob?.cancel()
                }
                timedOutProductId = activeProductId
                clearActivePurchase(call)
                // The sheet may still be up: its facts keep arriving as events.
                call.reject(
                    "Purchase confirmation timed out; requery owned purchases.",
                    "PLAY_BILLING_TIMEOUT",
                    null,
                    presentationData(id),
                )
            }
        }
        purchaseJob = scope.launch {
            val resolution = try {
                val outcome = try {
                    runPurchase(active, productId, accountId, selectedOfferToken, requestedPresentationId)
                } catch (error: CancellationException) {
                    throw error
                } catch (error: OpenIapError) {
                    if (PlayBillingPolicy.isCancellation(error)) {
                        PurchaseResolution.Cancelled
                    } else {
                        PurchaseResolution.Failed(PlayBillingPolicy.errorCode(error), billingMessage(error))
                    }
                } catch (error: Exception) {
                    logUnexpected("purchase", error)
                    PurchaseResolution.Failed("PLAY_BILLING_ERROR", "Google Play Billing failed.")
                }
                // `launchBillingFlow` was called but no billing activity was
                // seen yet: give one that was just started time to be created
                // before the flow counts as never shown.
                if (requestedPresentationId != null &&
                    presentation.awaitsLaunchObservation(requestedPresentationId)
                ) {
                    delay(LAUNCH_OBSERVATION_GRACE_MILLIS)
                }
                outcome
            } finally {
                requestedPresentationId?.let { id ->
                    presentation.onFlowEnded(id)
                    // The game's activity is still paused after a launch
                    // attempt: the verdict waits for it (or a late billing
                    // activity), bounded here. The flow stays busy meanwhile.
                    if (presentation.isTracking(id) && presentation.openPresentationId == null) {
                        armLateLaunchBound(id)
                    }
                }
                // Released on every path, so one failure never leaves later
                // purchases answering PLAY_BILLING_BUSY until a restart.
                flowInProgress = false
            }
            settlePurchase(call, productId, requestedPresentationId, resolution)
        }
    }

    private suspend fun runPurchase(
        active: OpenIapPlayConnection,
        productId: String,
        accountId: String,
        selectedOfferToken: String?,
        presentationId: String?,
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
        // A flow the call timeout already ended must not open a sheet now.
        currentCoroutineContext().ensureActive()
        if (presentationId != null && !presentation.isTracking(presentationId)) {
            return PurchaseResolution.Failed("PLAY_BILLING_TIMEOUT", "Purchase confirmation timed out; requery owned purchases.")
        }
        presentationId?.let { presentation.onLaunchAttempted(it) }
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

    private fun settlePurchase(
        call: PluginCall,
        productId: String,
        presentationId: String?,
        resolution: PurchaseResolution,
    ) {
        if (activePurchase === call) {
            clearActivePurchase(call)
            // The answer carries the sheet state too, so the SDK reads a
            // `not-started` or `closed` that the event may not have delivered
            // yet. `open` means the sheet is still up and `closed` follows.
            val sheet = presentationId?.let { presentation.answerState(it) }
            when (resolution) {
                is PurchaseResolution.Reported -> call.resolve(withPresentation(toJs(resolution.outcome), sheet))
                PurchaseResolution.Cancelled -> call.resolve(withPresentation(JSObject().put("status", "cancelled"), sheet))
                is PurchaseResolution.Failed -> call.reject(resolution.message, resolution.code, null, presentationData(presentationId))
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

    /**
     * Bounds how long one sheet keeps the plugin busy without the host
     * resuming; the TypeScript provider has the same bound for the game.
     */
    private fun armSheetTimeout(id: String) {
        sheetTimeout?.cancel()
        sheetTimeout = scope.launch {
            delay(SHEET_TIMEOUT_MILLIS)
            presentation.onSafetyTimeout(id)
        }
    }

    private fun armLateLaunchBound(id: String) {
        lateLaunchBound?.cancel()
        lateLaunchBound = scope.launch {
            delay(LATE_LAUNCH_BOUND_MILLIS)
            presentation.onLateBound(id)
        }
    }

    /** A refusal before any flow began; its sheet never opened. */
    private fun rejectNotStarted(call: PluginCall, id: String?, message: String, code: String) {
        if (id == null) {
            call.reject(message, code)
            return
        }
        notifyPresentation(id, PurchasePresentationTracker.NOT_STARTED, null)
        call.reject(message, code, null, JSObject().put("presentation", PurchasePresentationTracker.NOT_STARTED))
    }

    private fun presentationData(id: String?): JSObject? =
        id?.let { JSObject().put("presentation", presentation.answerState(it)) }

    private fun withPresentation(answer: JSObject, sheet: String?): JSObject =
        if (sheet == null) answer else answer.put("presentation", sheet)

    /**
     * Retained until a listener consumes it, like `purchaseUpdated`; the
     * random id keeps a fact of an earlier web session from matching a new call.
     */
    private fun notifyPresentation(id: String, state: String, reason: String?) {
        val event = JSObject().put("presentationId", id).put("state", state)
        if (reason != null) {
            event.put("reason", reason)
        }
        notifyListeners("purchasePresentation", event, true)
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
            } catch (error: Exception) {
                logUnexpected(call.methodName ?: "query", error)
                call.reject("Google Play Billing failed.", "PLAY_BILLING_ERROR")
            }
        }
    }

    /**
     * The exception class only: a message or stack trace can carry a
     * purchase token or account id, so neither is logged.
     */
    private fun logUnexpected(operation: String, error: Exception) {
        Log.w(TAG, "Unexpected Google Play Billing failure in $operation: ${error.javaClass.name}")
    }

    private fun rejectUnavailable(call: PluginCall) {
        call.reject(UNAVAILABLE_MESSAGE, "PLAY_BILLING_SERVICE_UNAVAILABLE")
    }

    private fun clearActivePurchase(call: PluginCall) {
        if (activePurchase === call) {
            activePurchase = null
            activeProductId = null
            presentationId = null
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
        const val TAG = "CapacitorPlayBilling"
        const val PURCHASE_TIMEOUT_MILLIS = 180_000L
        /** How long a launched flow waits for its billing activity before it counts as never shown. */
        const val LAUNCH_OBSERVATION_GRACE_MILLIS = 500L
        /** How long a launched flow's verdict may wait for the game's paused activity. */
        const val LATE_LAUNCH_BOUND_MILLIS = 10_000L
        /** The OpenIAP Google purchase flow timeout, and the TypeScript provider's sheet bound. */
        const val SHEET_TIMEOUT_MILLIS = 900_000L
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
