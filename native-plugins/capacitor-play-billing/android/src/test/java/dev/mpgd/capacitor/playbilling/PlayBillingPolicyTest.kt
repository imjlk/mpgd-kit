package dev.mpgd.capacitor.playbilling

import dev.hyo.openiap.DiscountOffer
import dev.hyo.openiap.DiscountOfferType
import dev.hyo.openiap.IapStore
import dev.hyo.openiap.OpenIapError
import dev.hyo.openiap.PreorderDetailsAndroid
import dev.hyo.openiap.ProductAndroid
import dev.hyo.openiap.ProductStatusAndroid
import dev.hyo.openiap.PurchaseAndroid
import dev.hyo.openiap.PurchaseState
import dev.hyo.openiap.RentalDetailsAndroid
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Locks the 0.3 `CapacitorPlayBilling` wire contract over OpenIAP's canonical
 * Play purchase. Each expected map is what the 0.3 Java `encodePurchase` /
 * `getProducts` produced for the same Billing 9.1.0 purchase or product, so
 * journals, the `play-token-sha256:<hex>` fallback, and server evidence written
 * by the old engine keep resolving under the new one.
 */
class PlayBillingPolicyTest {
    private fun purchase(
        state: PurchaseState = PurchaseState.Purchased,
        orderId: String? = "GPA.3301-1234-5678-90123",
        token: String? = "token-abc",
        products: List<String>? = listOf("coins_100"),
        acknowledged: Boolean? = false,
        account: String? = "acct_7f3a",
        storeId: String = "play",
        quantity: Int = 1,
    ) = PurchaseAndroid(
        // OpenIAP's `id` falls back to the token when Play has no order id.
        id = orderId ?: token.orEmpty(),
        ids = products,
        isAcknowledgedAndroid = acknowledged,
        isAutoRenewing = false,
        obfuscatedAccountIdAndroid = account,
        productId = products?.firstOrNull().orEmpty(),
        purchaseState = state,
        purchaseToken = token,
        quantity = quantity,
        store = IapStore.Google,
        storeId = storeId,
        transactionDate = 1_700_000_000_123.0,
        transactionId = orderId,
    )

    private fun offer(
        token: String?,
        micros: Long = 990_000,
        rental: Boolean = false,
        preorder: Boolean = false,
    ) = DiscountOffer(
        currency = "USD",
        displayPrice = "$0.99",
        offerTokenAndroid = token,
        preorderDetailsAndroid = if (preorder) PreorderDetailsAndroid("1", "2") else null,
        price = micros.toDouble() / 1_000_000.0,
        rentalDetailsAndroid = if (rental) RentalDetailsAndroid(rentalPeriod = "P1D") else null,
        type = DiscountOfferType.OneTime,
    )

    private fun product(
        offers: List<DiscountOffer>?,
        status: ProductStatusAndroid? = ProductStatusAndroid.Ok,
    ) = ProductAndroid(
        currency = "USD",
        description = "100 coins",
        discountOffers = offers,
        displayPrice = "$0.99",
        id = "coins_100",
        nameAndroid = "Coins",
        productStatusAndroid = status,
        title = "Coins (Game)",
    )

    @Test
    fun purchasePayloadMatchesThe03JavaEncoding() {
        assertEquals(
            mapOf(
                "products" to listOf("coins_100"),
                "purchaseToken" to "token-abc",
                "purchaseState" to "purchased",
                "purchaseTime" to 1_700_000_000_123L,
                "quantity" to 1,
                "isAcknowledged" to false,
                "orderId" to "GPA.3301-1234-5678-90123",
                "obfuscatedAccountId" to "acct_7f3a",
            ),
            PlayBillingPolicy.purchasePayload(purchase()),
        )
    }

    @Test
    fun aPurchaseWithoutAnOrderIdNeverUsesTheTokenAsOrderId() {
        val payload = PlayBillingPolicy.purchasePayload(purchase(state = PurchaseState.Pending, orderId = null))!!
        assertFalse(payload.containsKey("orderId"))
        assertEquals("pending", payload["purchaseState"])
        assertEquals("token-abc", payload["purchaseToken"])
    }

    @Test
    fun acknowledgedDurablesStayListedWithTheirFlag() {
        assertEquals(true, PlayBillingPolicy.purchasePayload(purchase(acknowledged = true))!!["isAcknowledged"])
        // Billing always reports the flag; a missing one is not acknowledged.
        assertEquals(false, PlayBillingPolicy.purchasePayload(purchase(acknowledged = null))!!["isAcknowledged"])
    }

    @Test
    fun multiLineAndQuantityArePreservedNotCollapsed() {
        val payload = PlayBillingPolicy.purchasePayload(
            purchase(products = listOf("coins_100", "gems_10"), quantity = 3),
        )!!
        assertEquals(listOf("coins_100", "gems_10"), payload["products"])
        assertEquals(3, payload["quantity"])
    }

    @Test
    fun entriesThe03PluginNeverReportedAreDropped() {
        assertNull(PlayBillingPolicy.purchasePayload(purchase(state = PurchaseState.Unknown)))
        assertNull(PlayBillingPolicy.purchasePayload(purchase(token = null)))
        assertNull(PlayBillingPolicy.purchasePayload(purchase(token = "  ")))
        assertNull(PlayBillingPolicy.purchasePayload(purchase(products = emptyList())))
        assertNull(PlayBillingPolicy.purchasePayload(purchase(products = null)))
        assertNull(PlayBillingPolicy.purchasePayload(purchase(storeId = "horizon")))
        assertNull(PlayBillingPolicy.purchasePayload(purchase(account = null))!!["obfuscatedAccountId"])
    }

    @Test
    fun outcomeCarriesThePurchaseState() {
        val payload = PlayBillingPolicy.purchasePayload(purchase(state = PurchaseState.Pending))!!
        assertEquals(mapOf("status" to "pending", "purchase" to payload), PlayBillingPolicy.outcomePayload(payload))
    }

    @Test
    fun productPayloadListsEligibleOneTimeOffersOnly() {
        val payload = PlayBillingPolicy.productPayload(
            product(listOf(offer("base"), offer("rent", rental = true), offer("pre", preorder = true), offer(null))),
        )!!
        assertEquals("coins_100", payload["productId"])
        assertEquals("Coins (Game)", payload["title"])
        assertEquals("100 coins", payload["description"])
        assertEquals(
            listOf(mapOf(
                "offerToken" to "base",
                "formattedPrice" to "$0.99",
                "currencyCode" to "USD",
                "priceAmountMicros" to 990_000L,
            )),
            payload["offers"],
        )
    }

    @Test
    fun microsRoundTripThroughOpenIapPrices() {
        for (micros in listOf(0L, 1L, 990_000L, 1_234_567_890L, 109_000_000_000L)) {
            val offers = PlayBillingPolicy.productPayload(product(listOf(offer("o", micros))))!!["offers"] as List<*>
            assertEquals(micros, (offers.single() as Map<*, *>)["priceAmountMicros"])
        }
    }

    @Test
    fun productsWithoutEligibleOffersOrDetailsAreSkipped() {
        assertNull(PlayBillingPolicy.productPayload(product(emptyList())))
        assertNull(PlayBillingPolicy.productPayload(product(null)))
        assertNull(PlayBillingPolicy.productPayload(product(listOf(offer("rent", rental = true)))))
        assertNull(PlayBillingPolicy.productPayload(product(listOf(offer("o")), ProductStatusAndroid.NotFound)))
    }

    @Test
    fun offerSelectionNeverGuesses() {
        val a = offer("a")
        val b = offer("b")
        assertSame(a, PlayBillingPolicy.selectOffer(listOf(a), null))
        assertNull(PlayBillingPolicy.selectOffer(listOf(a, b), null))
        assertSame(b, PlayBillingPolicy.selectOffer(listOf(a, b), "b"))
        assertNull(PlayBillingPolicy.selectOffer(listOf(a, b), "c"))
        assertNull(PlayBillingPolicy.selectOffer(emptyList(), null))
    }

    @Test
    fun errorsKeepThe03Codes() {
        assertTrue(PlayBillingPolicy.isCancellation(OpenIapError.UserCancelled()))
        assertTrue(PlayBillingPolicy.isCancellation(OpenIapError.PurchaseCancelled))
        assertFalse(PlayBillingPolicy.isCancellation(OpenIapError.ServiceTimeout()))
        val expected = listOf<Pair<OpenIapError, String>>(
            OpenIapError.ServiceDisconnected() to "PLAY_BILLING_DISCONNECTED",
            OpenIapError.ServiceUnavailable() to "PLAY_BILLING_SERVICE_UNAVAILABLE",
            OpenIapError.ServiceTimeout() to "PLAY_BILLING_SERVICE_UNAVAILABLE",
            OpenIapError.NotPrepared to "PLAY_BILLING_SERVICE_UNAVAILABLE",
            OpenIapError.NetworkFailure() to "PLAY_BILLING_NETWORK_ERROR",
            OpenIapError.BillingError() to "PLAY_BILLING_TRANSIENT_ERROR",
            OpenIapError.PurchaseFailed() to "PLAY_BILLING_TRANSIENT_ERROR",
            OpenIapError.ItemAlreadyOwned() to "PLAY_BILLING_ALREADY_OWNED",
            OpenIapError.ItemUnavailable() to "PLAY_BILLING_PRODUCT_UNAVAILABLE",
            OpenIapError.SkuNotFound("coins_100") to "PLAY_BILLING_PRODUCT_UNAVAILABLE",
            OpenIapError.DeveloperError() to "PLAY_BILLING_CONFIGURATION_ERROR",
            OpenIapError.ProviderConfiguration("x") to "PLAY_BILLING_CONFIGURATION_ERROR",
            OpenIapError.SkuOfferMismatchFailure() to "PLAY_BILLING_OFFER_REQUIRED",
            OpenIapError.MissingCurrentActivity to "PLAY_BILLING_ACTIVITY_REQUIRED",
            OpenIapError.BillingUnavailable() to "PLAY_BILLING_ERROR",
            OpenIapError.QueryProduct.withDiagnostics(responseCode = 12) to "PLAY_BILLING_NETWORK_ERROR",
            OpenIapError.QueryProduct.withDiagnostics(responseCode = 2) to "PLAY_BILLING_SERVICE_UNAVAILABLE",
            OpenIapError.QueryProduct.withDiagnostics() to "PLAY_BILLING_ERROR",
        )
        for ((error, code) in expected) {
            assertEquals(error.javaClass.simpleName, code, PlayBillingPolicy.errorCode(error))
        }
    }
}
