package dev.mpgd.capacitor;

/**
 * The settings screen {@code openNotificationSettings} opens, as plain values
 * so the choice is testable without an Android runtime. Android 8 (API 26)
 * and later have a notification settings screen per app
 * ({@code Settings.ACTION_APP_NOTIFICATION_SETTINGS} with
 * {@code Settings.EXTRA_APP_PACKAGE}); older versions only have the app's
 * details screen ({@code Settings.ACTION_APPLICATION_DETAILS_SETTINGS} with a
 * {@code package:} URI), where notifications are one entry.
 */
final class NotificationSettingsIntent {
    /** {@code Settings.ACTION_APP_NOTIFICATION_SETTINGS}. */
    static final String ACTION_APP_NOTIFICATION_SETTINGS =
        "android.settings.APP_NOTIFICATION_SETTINGS";
    /** {@code Settings.EXTRA_APP_PACKAGE}. */
    static final String EXTRA_APP_PACKAGE = "android.provider.extra.APP_PACKAGE";
    /** {@code Settings.ACTION_APPLICATION_DETAILS_SETTINGS}. */
    static final String ACTION_APPLICATION_DETAILS_SETTINGS =
        "android.settings.APPLICATION_DETAILS_SETTINGS";
    /** {@code Build.VERSION_CODES.O}: the first version with a notification settings screen per app. */
    static final int APP_NOTIFICATION_SETTINGS_MIN_SDK = 26;

    final String action;
    /** The {@code EXTRA_APP_PACKAGE} value, or {@code null} when the screen takes a data URI. */
    final String appPackageExtra;
    /** The intent's data URI, or {@code null}. */
    final String data;

    private NotificationSettingsIntent(String action, String appPackageExtra, String data) {
        this.action = action;
        this.appPackageExtra = appPackageExtra;
        this.data = data;
    }

    /**
     * The app details screen, which every Android version has: the fallback
     * when a device cannot resolve the notification settings screen (some
     * OEM builds and restricted profiles).
     */
    static NotificationSettingsIntent appDetails(String packageName) {
        requirePackage(packageName);
        return new NotificationSettingsIntent(
            ACTION_APPLICATION_DETAILS_SETTINGS,
            null,
            "package:" + packageName
        );
    }

    /** Whether this is already the app details screen, which has no further fallback. */
    boolean isAppDetails() {
        return ACTION_APPLICATION_DETAILS_SETTINGS.equals(action);
    }

    static NotificationSettingsIntent forPackage(int sdkInt, String packageName) {
        requirePackage(packageName);
        if (sdkInt >= APP_NOTIFICATION_SETTINGS_MIN_SDK) {
            return new NotificationSettingsIntent(
                ACTION_APP_NOTIFICATION_SETTINGS,
                packageName,
                null
            );
        }
        return appDetails(packageName);
    }

    private static void requirePackage(String packageName) {
        if (packageName == null || packageName.isEmpty()) {
            throw new IllegalArgumentException("The app package name is required.");
        }
    }
}
