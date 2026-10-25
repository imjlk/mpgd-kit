# Consumer rules of @mpgd/capacitor-game-services (notifications v2 RFC,
# "Capacitor", Android advertising rendering).

# AdvertisingMessagingService references Firebase Messaging and the
# @capacitor-firebase/messaging plugin, which only a shell with that plugin
# bundles. Without them the class is never declared or loaded, so its
# references must not fail R8.
-dontwarn com.google.firebase.messaging.**
-dontwarn io.capawesome.capacitorjs.plugins.firebase.messaging.**

# The shell's manifest declares this service by name; keep it whole.
-keep class dev.mpgd.capacitor.AdvertisingMessagingService { *; }

# AdvertisingPushRenderer.pluginEntryPoints() looks these up by name and
# forwards every token and every message the kit does not render to them.
# Renamed or removed, a minified release build would lose them silently.
# (@capacitor-firebase/messaging 8.5.2 ships no consumer rules of its own;
# Capacitor's `-keep public class * extends com.getcapacitor.Plugin { *; }`
# covers the plugin class too, but these do not rely on it.)
-keep class io.capawesome.capacitorjs.plugins.firebase.messaging.FirebaseMessagingPlugin {
    public static void onNewToken(java.lang.String);
    public static void onMessageReceived(com.google.firebase.messaging.RemoteMessage);
}
-keepnames class com.google.firebase.messaging.RemoteMessage
