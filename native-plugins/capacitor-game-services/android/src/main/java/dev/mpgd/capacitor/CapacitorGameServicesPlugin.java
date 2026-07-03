package dev.mpgd.capacitor;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

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
                call.resolve(okResponse(id, new JSObject().put("products", new Object[] {})));
                return;
            case "commerce.purchase":
                call.resolve(okResponse(id, new JSObject()
                    .put("status", "pending_verification")
                    .put("transactionId", "android-mock-" + id)));
                return;
            case "commerce.restore":
            case "commerce.getEntitlements":
                call.resolve(okResponse(id, new JSObject().put("entitlements", new Object[] {})));
                return;
            case "ads.preload":
                call.resolve(okResponse(id, new JSObject().put("preloaded", true)));
                return;
            case "ads.showRewarded":
                call.resolve(okResponse(id, new JSObject()
                    .put("status", "rewarded")
                    .put("rewardClaimId", "android-reward-" + id)));
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
                call.resolve(okResponse(id, new JSObject().put("saveData", null)));
                return;
            case "storage.save":
                call.resolve(okResponse(id, new JSObject().put("saved", true)));
                return;
            default:
                call.resolve(errorResponse(id, "UNSUPPORTED_METHOD", "Unsupported bridge method: " + method));
        }
    }

    private JSObject okResponse(String id, JSObject data) {
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
            .put("id", "android-local-player")
            .put("displayName", "Android Local Player")
            .put("isGuest", true);
    }
}
