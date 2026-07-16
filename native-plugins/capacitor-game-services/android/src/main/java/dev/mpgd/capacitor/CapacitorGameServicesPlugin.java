package dev.mpgd.capacitor;

import android.content.Context;
import android.content.SharedPreferences;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONObject;

@CapacitorPlugin(name = "CapacitorGameServices")
public class CapacitorGameServicesPlugin extends Plugin {
    private static final String STORAGE_PREFERENCES =
        "dev.mpgd.capacitor.gameservices.storage";
    private LocalJsonStorage localStorage;

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
            case "identity.getSession":
                call.resolve(okResponse(id, new JSObject()
                    .put("identityLevel", "platform-anonymous")
                    .put("playerId", "android-local-player")
                    .put("trustLevel", "local")));
                return;
            case "identity.requestUpgrade":
                call.resolve(okResponse(id, new JSObject()
                    .put("status", "unavailable")
                    .put("reloadExpected", false)));
                return;
            case "presentation.getLaunchIntent":
                call.resolve(okResponse(id, new JSObject().put("entry", "home")));
                return;
            case "presentation.requestGameSurface":
                call.resolve(okResponse(id, "already-fullscreen"));
                return;
            case "share.share":
                call.resolve(okResponse(id, new JSObject().put("status", "unavailable")));
                return;
            case "share.readInboundShare":
                call.resolve(okResponse(id, JSONObject.NULL));
                return;
            case "notifications.getStatus":
                call.resolve(okResponse(id, "configuration-required"));
                return;
            case "notifications.requestSubscription":
                call.resolve(okResponse(id, "unavailable"));
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
                loadStorage(call, id);
                return;
            case "storage.save":
                saveStorage(call, id);
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
        return errorResponse(id, code, message, false);
    }

    private JSObject errorResponse(String id, String code, String message, boolean retryable) {
        return new JSObject()
            .put("id", id)
            .put("ok", false)
            .put("error", new JSObject()
                .put("code", code)
                .put("message", message)
                .put("retryable", retryable));
    }

    private void loadStorage(PluginCall call, String id) {
        String key = storageKey(call);

        if (key == null) {
            call.resolve(errorResponse(
                id,
                "INVALID_STORAGE_KEY",
                "Storage key must be a string."
            ));
            return;
        }

        try {
            String serializedValue = localStorage().load(key);
            Object value;

            if (serializedValue == null) {
                value = JSONObject.NULL;
            } else {
                JSONObject wrapper = new JSONObject(serializedValue);

                if (!wrapper.has("value")) {
                    throw new IllegalStateException("Stored JSON wrapper is missing its value.");
                }

                value = wrapper.opt("value");
            }

            call.resolve(okResponse(id, value));
        } catch (LocalJsonStorage.StorageException error) {
            call.resolve(errorResponse(
                id,
                error.getCode(),
                error.getMessage(),
                error.isRetryable()
            ));
        } catch (Exception error) {
            call.resolve(errorResponse(
                id,
                "NATIVE_STORAGE_LOAD_FAILED",
                "Native storage contained an invalid JSON value."
            ));
        }
    }

    private void saveStorage(PluginCall call, String id) {
        JSObject payload = call.getObject("payload");
        String key = storageKey(payload);

        if (key == null) {
            call.resolve(errorResponse(
                id,
                "INVALID_STORAGE_KEY",
                "Storage key must be a string."
            ));
            return;
        }

        if (payload == null || !payload.has("value")) {
            call.resolve(errorResponse(
                id,
                "INVALID_STORAGE_VALUE",
                "Storage value must be JSON serializable."
            ));
            return;
        }

        final String serializedValue;

        try {
            serializedValue = new JSONObject()
                .put("value", payload.opt("value"))
                .toString();
        } catch (Exception error) {
            call.resolve(errorResponse(
                id,
                "INVALID_STORAGE_VALUE",
                "Storage value must be JSON serializable."
            ));
            return;
        }

        try {
            localStorage().save(key, serializedValue);
            call.resolve(okResponse(id, new JSObject().put("saved", true)));
        } catch (LocalJsonStorage.StorageException error) {
            call.resolve(errorResponse(
                id,
                error.getCode(),
                error.getMessage(),
                error.isRetryable()
            ));
        }
    }

    private String storageKey(PluginCall call) {
        return storageKey(call.getObject("payload"));
    }

    private String storageKey(JSObject payload) {
        return payload == null ? null : payload.getString("key");
    }

    private synchronized LocalJsonStorage localStorage() {
        if (localStorage != null) {
            return localStorage;
        }

        SharedPreferences preferences = getContext().getSharedPreferences(
            STORAGE_PREFERENCES,
            Context.MODE_PRIVATE
        );
        localStorage = new LocalJsonStorage(new LocalJsonStorage.Backend() {
            @Override
            public String get(String key) {
                return preferences.getString(key, null);
            }

            @Override
            public boolean put(String key, String value) {
                boolean hadPreviousValue = preferences.contains(key);
                String previousValue = hadPreviousValue ? preferences.getString(key, null) : null;
                boolean committed = preferences.edit().putString(key, value).commit();

                if (!committed) {
                    SharedPreferences.Editor rollback = preferences.edit();

                    if (hadPreviousValue) {
                        rollback.putString(key, previousValue);
                    } else {
                        rollback.remove(key);
                    }

                    rollback.commit();
                }

                return committed;
            }
        });
        return localStorage;
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
            .put("haptics", true)
            .put("localizedContent", true);
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
