package dev.mpgd.capacitor.playbilling

import com.android.billingclient.api.BillingClient.BillingResponseCode
import dev.hyo.openiap.DiscountOffer
import dev.hyo.openiap.OpenIapError
import dev.hyo.openiap.ProductAndroid
import dev.hyo.openiap.ProductStatusAndroid
import dev.hyo.openiap.ProductType
import dev.hyo.openiap.PurchaseAndroid
import dev.hyo.openiap.PurchaseState
import kotlin.math.roundToLong

/**
 * mpgd policy over OpenIAP's canonical Play purchase and product: which
 * entries the plugin reports, the 0.3 payload shapes it reports them in, which
 * one-time offer a purchase uses, and how OpenIAP errors become the plugin's
 * existing `PLAY_BILLING_*` codes. Nothing here talks to Play; the plugin and
 * the JVM unit tests drive it directly.
 *
 * The payloads keep the 0.3 field names exactly (`products`, `purchaseToken`,
 * `orderId`, `purchaseTime`, `purchaseState`, `isAcknowledged`, `quantity`,
 * `obfuscatedAccountId`), so the TypeScript SDK, existing journals, and the
 * `play-token-sha256:<hex>` fallback keep working unchanged.
 */
internal object PlayBillingPolicy {
    /** OpenIAP's store id for the Google Play provider; mpgd calls it `google-play`. */
    const val PLAY_STORE_ID = "play"

    /**
     * The 0.3 `PlayPurchase` payload, or null for an entry the plugin never
     * reported: another provider, an unspecified state, or no token or product.
     * `orderId` is OpenIAP's `transactionId`, which stays null until Play
     * assigns an order id. OpenIAP's `id` falls back to the token and is never
     * used as the order id; the TypeScript SDK derives the token key instead.
     */
    fun purchasePayload(purchase: PurchaseAndroid): Map<String, Any>? {
        if (purchase.storeId != PLAY_STORE_ID) return null
        val state = when (purchase.purchaseState) {
            PurchaseState.Purchased -> "purchased"
            PurchaseState.Pending -> "pending"
            else -> return null
        }
        val token = purchase.purchaseToken
        if (token == null || token.trim().isEmpty()) return null
        val products = purchase.ids.orEmpty()
        if (products.isEmpty()) return null
        val payload = linkedMapOf<String, Any>(
            "products" to products.toList(),
            "purchaseToken" to token,
            "purchaseState" to state,
            "purchaseTime" to purchase.transactionDate.toLong(),
            "quantity" to purchase.quantity,
            "isAcknowledged" to (purchase.isAcknowledgedAndroid == true),
        )
        purchase.transactionId?.let { payload["orderId"] = it }
        purchase.obfuscatedAccountIdAndroid?.let { payload["obfuscatedAccountId"] = it }
        return payload
    }

    /** The `purchaseUpdated` outcome and `purchase` resolution for one purchase. */
    fun outcomePayload(purchase: Map<String, Any>): Map<String, Any> =
        linkedMapOf("status" to (purchase["purchaseState"] as String), "purchase" to purchase)

    /** Whether Play returned details for the product (not an unfetched placeholder). */
    fun isAvailable(product: ProductAndroid): Boolean =
        product.type == ProductType.InApp &&
            (product.productStatusAndroid == null || product.productStatusAndroid == ProductStatusAndroid.Ok)

    /** One-time offers the plugin sells: no rental or pre-order offers, as in 0.3. */
    fun eligibleOffers(product: ProductAndroid): List<DiscountOffer> =
        product.discountOffers.orEmpty().filter { offer ->
            offer.rentalDetailsAndroid == null &&
                offer.preorderDetailsAndroid == null &&
                !offer.offerTokenAndroid.isNullOrEmpty()
        }

    /** The 0.3 `PlayProduct` payload, or null when Play lists no eligible offer. */
    fun productPayload(product: ProductAndroid): Map<String, Any>? {
        if (!isAvailable(product)) return null
        val offers = eligibleOffers(product)
        if (offers.isEmpty()) return null
        return linkedMapOf(
            "productId" to product.id,
            "title" to product.title,
            "description" to product.description,
            "offers" to offers.map(::offerPayload),
        )
    }

    fun offerPayload(offer: DiscountOffer): Map<String, Any> = linkedMapOf(
        "offerToken" to offer.offerTokenAndroid.orEmpty(),
        "formattedPrice" to offer.displayPrice,
        "currencyCode" to offer.currency,
        // OpenIAP reports `priceAmountMicros / 1e6`; micros round-trip exactly
        // for any real price.
        "priceAmountMicros" to (offer.price * 1_000_000.0).roundToLong(),
    )

    /**
     * The offer a purchase uses: the named one, or the only eligible one when
     * none is named. Several eligible offers and no choice is an error, never
     * a silent pick.
     */
    fun selectOffer(offers: List<DiscountOffer>, offerToken: String?): DiscountOffer? {
        if (offerToken != null) return offers.firstOrNull { it.offerTokenAndroid == offerToken }
        return offers.singleOrNull()
    }

    fun isCancellation(error: OpenIapError): Boolean =
        error is OpenIapError.UserCancelled || error === OpenIapError.PurchaseCancelled

    /** The 0.3 plugin code for an OpenIAP error (cancellation is not an error). */
    fun errorCode(error: OpenIapError): String = when (error) {
        is OpenIapError.ServiceDisconnected -> "PLAY_BILLING_DISCONNECTED"
        is OpenIapError.ServiceUnavailable,
        is OpenIapError.ServiceTimeout,
        is OpenIapError.StoreConnectionFailure,
        OpenIapError.NotPrepared,
        OpenIapError.InitConnection -> "PLAY_BILLING_SERVICE_UNAVAILABLE"
        is OpenIapError.NetworkFailure,
        OpenIapError.NetworkError -> "PLAY_BILLING_NETWORK_ERROR"
        is OpenIapError.BillingError,
        is OpenIapError.PurchaseFailed -> "PLAY_BILLING_TRANSIENT_ERROR"
        is OpenIapError.ItemAlreadyOwned -> "PLAY_BILLING_ALREADY_OWNED"
        is OpenIapError.ItemUnavailable,
        is OpenIapError.SkuNotFound,
        is OpenIapError.ProductNotFound -> "PLAY_BILLING_PRODUCT_UNAVAILABLE"
        is OpenIapError.DeveloperError,
        is OpenIapError.ProviderConfiguration -> "PLAY_BILLING_CONFIGURATION_ERROR"
        is OpenIapError.SkuOfferMismatchFailure,
        OpenIapError.SkuOfferMismatch -> "PLAY_BILLING_OFFER_REQUIRED"
        OpenIapError.MissingCurrentActivity -> "PLAY_BILLING_ACTIVITY_REQUIRED"
        // A deferred result has no purchase yet: requery, as for an empty callback.
        is OpenIapError.DeferredPurchase,
        OpenIapError.PurchaseDeferred -> "PLAY_BILLING_EMPTY_PURCHASE"
        is OpenIapError.QueryProduct -> error.responseCode?.let(::billingResponseCode) ?: "PLAY_BILLING_ERROR"
        else -> "PLAY_BILLING_ERROR"
    }

    /** The 0.3 table for a raw `BillingResponseCode` (product-query failures carry one). */
    @Suppress("DEPRECATION")
    fun billingResponseCode(responseCode: Int): String = when (responseCode) {
        BillingResponseCode.SERVICE_DISCONNECTED -> "PLAY_BILLING_DISCONNECTED"
        BillingResponseCode.SERVICE_UNAVAILABLE,
        BillingResponseCode.SERVICE_TIMEOUT -> "PLAY_BILLING_SERVICE_UNAVAILABLE"
        BillingResponseCode.NETWORK_ERROR -> "PLAY_BILLING_NETWORK_ERROR"
        BillingResponseCode.ERROR -> "PLAY_BILLING_TRANSIENT_ERROR"
        BillingResponseCode.ITEM_ALREADY_OWNED -> "PLAY_BILLING_ALREADY_OWNED"
        BillingResponseCode.ITEM_UNAVAILABLE -> "PLAY_BILLING_PRODUCT_UNAVAILABLE"
        BillingResponseCode.DEVELOPER_ERROR -> "PLAY_BILLING_CONFIGURATION_ERROR"
        else -> "PLAY_BILLING_ERROR"
    }
}
