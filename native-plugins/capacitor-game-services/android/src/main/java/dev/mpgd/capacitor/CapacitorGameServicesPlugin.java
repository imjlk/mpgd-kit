package dev.mpgd.capacitor;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONObject;

@CapacitorPlugin(name = "CapacitorGameServices")
public class CapacitorGameServicesPlugin extends Plugin {
    @PluginMethod
    public void request(PluginCall call) {
        String id = call.getString("id");
        String method = call.getString("method");

        if (id == null || id.isEmpty()) {
            id = "android-native-mock";
        }

        if (method == null || method.isEmpty()) {
            call.resolve(errorResponse(id, "INVALID_BRIDGE_REQUEST", "Bridge method is required."));
            return;
        }

        switch (method) {
            case "runtime.getCapabilities":
                call.resolve(okResponse(id, capabilities()));
                return;
            case "identity.getPlayer":
                call.resolve(okResponse(id, player()));
                return;
            case "commerce.getProducts":
                call.resolve(okResponse(id, new Object[] { product() }));
                return;
            case "commerce.purchase":
                call.resolve(okResponse(id, new JSObject()
                    .put("status", "completed")
                    .put("transactionId", "android-mock-" + id)
                    .put("entitlementIds", new String[] { "COINS_100" })));
                return;
            case "commerce.restore":
                call.resolve(okResponse(id, new JSObject().put("restoredEntitlements", new Object[] {})));
                return;
            case "commerce.getEntitlements":
                call.resolve(okResponse(id, new Object[] {}));
                return;
            case "ads.preload":
                call.resolve(okResponse(id, new JSObject()));
                return;
            case "ads.showRewarded":
                call.resolve(okResponse(id, new JSObject()
                    .put("status", "completed")
                    .put("rewardGranted", true)
                    .put("ledgerEntryId", "android-reward-" + id)));
                return;
            case "ads.showInterstitial":
                call.resolve(okResponse(id, new JSObject().put("status", "shown")));
                return;
            case "leaderboard.submitScore":
                call.resolve(okResponse(id, new JSObject().put("submitted", true)));
                return;
            case "leaderboard.open":
                call.resolve(okResponse(id, new JSObject().put("opened", true)));
                return;
            case "storage.load":
                call.resolve(okResponse(id, JSONObject.NULL));
                return;
            case "storage.save":
                call.resolve(okResponse(id, new JSObject()));
                return;
            default:
                call.resolve(errorResponse(id, "UNSUPPORTED_METHOD", "Unsupported bridge method: " + method));
        }
    }

    private JSObject okResponse(String id, Object data) {
        return new JSObject()
            .put("id", id)
            .put("ok", true)
            .put("data", data);
    }

    private JSObject errorResponse(String id, String code, String message) {
        return new JSObject()
            .put("id", id)
            .put("ok", false)
            .put("error", new JSObject()
                .put("code", code)
                .put("message", message)
                .put("retryable", false));
    }

    private JSObject capabilities() {
        return new JSObject()
            .put("nativeIap", true)
            .put("nativeAds", true)
            .put("rewardedAds", true)
            .put("interstitialAds", true)
            .put("nativeLeaderboard", true)
            .put("achievements", false)
            .put("cloudSave", false)
            .put("socialShare", false)
            .put("haptics", true);
    }

    private JSObject player() {
        return new JSObject()
            .put("playerId", "android-local-player")
            .put("displayName", "Android Local Player");
    }

    private JSObject product() {
        return new JSObject()
            .put("id", "COINS_100")
            .put("type", "consumable")
            .put("title", "100 Coins")
            .put("description", "Adds 100 demo coins.")
            .put("price", new JSObject()
                .put("formatted", "$0.99")
                .put("currencyCode", "USD"));
    }
}
