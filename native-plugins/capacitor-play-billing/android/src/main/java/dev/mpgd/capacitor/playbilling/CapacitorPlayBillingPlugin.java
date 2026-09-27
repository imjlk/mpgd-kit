package dev.mpgd.capacitor.playbilling;

import android.os.Handler;
import android.os.Looper;
import com.android.billingclient.api.BillingClient;
import com.android.billingclient.api.BillingClientStateListener;
import com.android.billingclient.api.BillingFlowParams;
import com.android.billingclient.api.BillingResult;
import com.android.billingclient.api.PendingPurchasesParams;
import com.android.billingclient.api.ProductDetails;
import com.android.billingclient.api.Purchase;
import com.android.billingclient.api.QueryProductDetailsParams;
import com.android.billingclient.api.QueryPurchasesParams;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import org.json.JSONException;

/** Purchase collection only. Finalization is server-owned after the mpgd ledger grant. */
@CapacitorPlugin(name = "CapacitorPlayBilling")
public class CapacitorPlayBillingPlugin extends Plugin {
    private BillingClient billingClient;
    private final List<PendingOperation> afterConnection = new ArrayList<>();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private boolean connecting;
    private PluginCall activePurchase;
    private String activeProductId;
    private Runnable purchaseTimeout;

    @Override
    public void load() {
        billingClient = BillingClient.newBuilder(getContext())
            .setListener((result, purchases) ->
                mainHandler.post(() -> onPurchasesUpdated(result, purchases)))
            .enablePendingPurchases(PendingPurchasesParams.newBuilder().enableOneTimeProducts().build())
            .enableAutoServiceReconnection()
            .build();
    }

    @Override
    protected void handleOnDestroy() {
        if (activePurchase != null) {
            activePurchase.reject("Purchase flow was interrupted.", "PLAY_BILLING_INTERRUPTED");
            clearActivePurchase(activePurchase);
        }
        for (PendingOperation operation : afterConnection) {
            operation.call.reject("Billing connection was interrupted.", "PLAY_BILLING_INTERRUPTED");
        }
        afterConnection.clear();
        if (billingClient != null) {
            billingClient.endConnection();
        }
        super.handleOnDestroy();
    }

    @PluginMethod
    public void getProducts(PluginCall call) {
        mainHandler.post(() -> getProductsOnMain(call));
    }

    private void getProductsOnMain(PluginCall call) {
        JSArray productIds = call.getArray("productIds");
        if (productIds == null || productIds.length() == 0 || productIds.length() > 100) {
            call.reject("Provide 1-100 product IDs.", "PLAY_BILLING_INVALID_PRODUCTS");
            return;
        }
        List<QueryProductDetailsParams.Product> products = new ArrayList<>();
        try {
            for (int index = 0; index < productIds.length(); index++) {
                String productId = productIds.getString(index);
                if (productId == null || productId.trim().isEmpty()) {
                    call.reject("Product ID is invalid.", "PLAY_BILLING_INVALID_PRODUCT");
                    return;
                }
                products.add(QueryProductDetailsParams.Product.newBuilder()
                    .setProductId(productId)
                    .setProductType(BillingClient.ProductType.INAPP)
                    .build());
            }
        } catch (JSONException error) {
            call.reject("Product IDs are invalid.", "PLAY_BILLING_INVALID_PRODUCTS");
            return;
        }
        connected(call, () -> billingClient.queryProductDetailsAsync(
            QueryProductDetailsParams.newBuilder().setProductList(products).build(),
            (result, detailsResult) -> {
                if (!isOk(result)) {
                    rejectBilling(call, result);
                    return;
                }
                JSArray found = new JSArray();
                for (ProductDetails details : detailsResult.getProductDetailsList()) {
                    List<ProductDetails.OneTimePurchaseOfferDetails> offers =
                        details.getOneTimePurchaseOfferDetailsList();
                    if (offers == null || offers.isEmpty()) {
                        continue;
                    }
                    JSArray eligibleOffers = new JSArray();
                    for (ProductDetails.OneTimePurchaseOfferDetails offer : offers) {
                        if (offer.getRentalDetails() == null && offer.getPreorderDetails() == null) {
                            eligibleOffers.put(new JSObject()
                                .put("offerToken", offer.getOfferToken())
                                .put("formattedPrice", offer.getFormattedPrice())
                                .put("currencyCode", offer.getPriceCurrencyCode()));
                        }
                    }
                    if (eligibleOffers.length() == 0) {
                        continue;
                    }
                    found.put(new JSObject()
                        .put("productId", details.getProductId())
                        .put("title", details.getTitle())
                        .put("description", details.getDescription())
                        .put("offers", eligibleOffers));
                }
                call.resolve(new JSObject().put("products", found));
            }
        ));
    }

    @PluginMethod
    public void purchase(PluginCall call) {
        mainHandler.post(() -> purchaseOnMain(call));
    }

    private void purchaseOnMain(PluginCall call) {
        String productId = call.getString("productId");
        String accountId = call.getString("obfuscatedAccountId");
        String selectedOfferToken = call.getString("offerToken");
        if (productId == null || productId.trim().isEmpty() || accountId == null
            || accountId.trim().isEmpty() || accountId.length() > 64) {
            call.reject("Product and account identifiers are required.", "PLAY_BILLING_INVALID_REQUEST");
            return;
        }
        if (activePurchase != null) {
            call.reject("Another purchase is already in progress.", "PLAY_BILLING_BUSY");
            return;
        }
        activePurchase = call;
        activeProductId = productId;
        purchaseTimeout = () -> {
            if (activePurchase == call) {
                clearActivePurchase(call);
                call.reject("Purchase confirmation timed out; requery owned purchases.",
                    "PLAY_BILLING_TIMEOUT");
            }
        };
        mainHandler.postDelayed(purchaseTimeout, 180_000);
        connected(call, () -> {
            if (activePurchase != call) {
                return;
            }
            billingClient.queryProductDetailsAsync(
                QueryProductDetailsParams.newBuilder().setProductList(Collections.singletonList(
                    QueryProductDetailsParams.Product.newBuilder()
                        .setProductId(productId)
                        .setProductType(BillingClient.ProductType.INAPP)
                        .build()
                )).build(),
                (result, detailsResult) -> {
                if (activePurchase != call) {
                    return;
                }
                if (!isOk(result)) {
                    clearActivePurchase(call);
                    rejectBilling(call, result);
                    return;
                }
                if (detailsResult.getProductDetailsList().size() != 1) {
                    clearActivePurchase(call);
                    call.reject("Product is unavailable.", "PLAY_BILLING_PRODUCT_UNAVAILABLE");
                    return;
                }
                ProductDetails details = detailsResult.getProductDetailsList().get(0);
                List<ProductDetails.OneTimePurchaseOfferDetails> offers =
                    details.getOneTimePurchaseOfferDetailsList();
                ProductDetails.OneTimePurchaseOfferDetails selected = selectOffer(
                    offers, selectedOfferToken);
                if (selected == null) {
                    clearActivePurchase(call);
                    call.reject("Select an eligible one-time offer.", "PLAY_BILLING_OFFER_REQUIRED");
                    return;
                }
                BillingFlowParams.ProductDetailsParams productParams =
                    BillingFlowParams.ProductDetailsParams.newBuilder()
                        .setProductDetails(details)
                        .setOfferToken(selected.getOfferToken())
                        .build();
                BillingFlowParams flow = BillingFlowParams.newBuilder()
                    .setProductDetailsParamsList(Collections.singletonList(productParams))
                    .setObfuscatedAccountId(accountId)
                    .build();
                if (getActivity() == null) {
                    clearActivePurchase(call);
                    call.reject("Billing requires a foreground activity.",
                        "PLAY_BILLING_ACTIVITY_REQUIRED");
                    return;
                }
                BillingResult launched = billingClient.launchBillingFlow(getActivity(), flow);
                if (!isOk(launched)) {
                    clearActivePurchase(call);
                    if (launched.getResponseCode() == BillingClient.BillingResponseCode.USER_CANCELED) {
                        call.resolve(new JSObject().put("status", "cancelled"));
                    } else {
                        rejectBilling(call, launched);
                    }
                }
                }
            );
        });
    }

    @PluginMethod
    public void getPurchases(PluginCall call) {
        mainHandler.post(() -> getPurchasesOnMain(call));
    }

    private void getPurchasesOnMain(PluginCall call) {
        connected(call, () -> billingClient.queryPurchasesAsync(
            QueryPurchasesParams.newBuilder().setProductType(BillingClient.ProductType.INAPP).build(),
            (result, purchases) -> {
                if (!isOk(result)) {
                    rejectBilling(call, result);
                    return;
                }
                JSArray found = new JSArray();
                for (Purchase purchase : purchases) {
                    JSObject encoded = encodePurchase(purchase);
                    if (encoded != null) {
                        found.put(encoded);
                    }
                }
                call.resolve(new JSObject().put("purchases", found));
            }
        ));
    }

    private void onPurchasesUpdated(BillingResult result, List<Purchase> purchases) {
        PluginCall pending = activePurchase;
        String expectedProductId = activeProductId;
        if (result.getResponseCode() == BillingClient.BillingResponseCode.USER_CANCELED) {
            if (pending != null) {
                clearActivePurchase(pending);
                pending.resolve(new JSObject().put("status", "cancelled"));
            }
            return;
        }
        if (!isOk(result)) {
            if (pending != null) {
                clearActivePurchase(pending);
                rejectBilling(pending, result);
            }
            return;
        }
        if (purchases == null || purchases.isEmpty()) {
            if (pending != null) {
                clearActivePurchase(pending);
                pending.reject("Purchase callback was empty; requery owned purchases.",
                    "PLAY_BILLING_EMPTY_PURCHASE");
            }
            return;
        }
        for (Purchase purchase : purchases) {
            JSObject encoded = encodePurchase(purchase);
            if (encoded == null) {
                continue;
            }
            JSObject outcome = new JSObject()
                .put("status", encoded.optString("state"))
                .put("purchase", encoded);
            notifyListeners("purchaseUpdated", outcome);
            if (pending != null && purchase.getProducts().contains(expectedProductId)) {
                clearActivePurchase(pending);
                pending.resolve(outcome);
                pending = null;
            }
        }
    }

    private JSObject encodePurchase(Purchase purchase) {
        int state = purchase.getPurchaseState();
        if (state != Purchase.PurchaseState.PURCHASED
            && state != Purchase.PurchaseState.PENDING) {
            return null;
        }
        String token = purchase.getPurchaseToken();
        if (token == null || token.trim().isEmpty() || purchase.getProducts().isEmpty()) {
            return null;
        }
        JSArray productIds = new JSArray();
        for (String productId : purchase.getProducts()) {
            productIds.put(productId);
        }
        JSObject encoded = new JSObject()
            .put("productIds", productIds)
            .put("purchaseToken", token)
            .put("state", state == Purchase.PurchaseState.PURCHASED ? "purchased" : "pending");
        if (purchase.getPurchaseTime() > 0) {
            encoded.put("purchaseTimeMillis", purchase.getPurchaseTime());
        }
        if (purchase.getOrderId() != null) {
            encoded.put("orderId", purchase.getOrderId());
        }
        return encoded;
    }

    private ProductDetails.OneTimePurchaseOfferDetails selectOffer(
        List<ProductDetails.OneTimePurchaseOfferDetails> offers,
        String offerToken
    ) {
        if (offers == null) {
            return null;
        }
        ProductDetails.OneTimePurchaseOfferDetails only = null;
        int eligibleCount = 0;
        for (ProductDetails.OneTimePurchaseOfferDetails offer : offers) {
            if (offer.getRentalDetails() != null || offer.getPreorderDetails() != null) {
                continue;
            }
            if (offerToken != null && offerToken.equals(offer.getOfferToken())) {
                return offer;
            }
            eligibleCount++;
            only = offer;
        }
        return offerToken == null && eligibleCount == 1 ? only : null;
    }

    private void connected(PluginCall call, Runnable task) {
        if (billingClient.isReady()) {
            task.run();
            return;
        }
        afterConnection.add(new PendingOperation(call, task));
        if (connecting) {
            return;
        }
        connecting = true;
        billingClient.startConnection(new BillingClientStateListener() {
            @Override
            public void onBillingSetupFinished(BillingResult result) {
                connecting = false;
                List<PendingOperation> queued = new ArrayList<>(afterConnection);
                afterConnection.clear();
                if (!isOk(result)) {
                    for (PendingOperation operation : queued) {
                        clearActivePurchase(operation.call);
                        rejectBilling(operation.call, result);
                    }
                    return;
                }
                for (PendingOperation operation : queued) {
                    operation.task.run();
                }
            }

            @Override
            public void onBillingServiceDisconnected() {
                connecting = false;
                List<PendingOperation> queued = new ArrayList<>(afterConnection);
                afterConnection.clear();
                for (PendingOperation operation : queued) {
                    clearActivePurchase(operation.call);
                    operation.call.reject("Billing service disconnected.", "PLAY_BILLING_DISCONNECTED");
                }
            }
        });
    }

    private boolean isOk(BillingResult result) {
        return result.getResponseCode() == BillingClient.BillingResponseCode.OK;
    }

    private void rejectBilling(PluginCall call, BillingResult result) {
        call.reject("Google Play Billing is unavailable (" + result.getResponseCode() + ").",
            "PLAY_BILLING_ERROR");
    }

    private void clearActivePurchase(PluginCall call) {
        if (activePurchase == call) {
            activePurchase = null;
            activeProductId = null;
            if (purchaseTimeout != null) {
                mainHandler.removeCallbacks(purchaseTimeout);
                purchaseTimeout = null;
            }
        }
    }

    private static final class PendingOperation {
        final PluginCall call;
        final Runnable task;

        PendingOperation(PluginCall call, Runnable task) {
            this.call = call;
            this.task = task;
        }
    }
}
