# AdvertisingMessagingService references Firebase Messaging, which only a
# shell with @capacitor-firebase/messaging bundles. Without it the class is
# never declared or loaded, so its references must not fail R8.
-dontwarn com.google.firebase.messaging.**
