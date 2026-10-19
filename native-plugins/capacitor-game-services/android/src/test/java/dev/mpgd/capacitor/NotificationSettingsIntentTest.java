package dev.mpgd.capacitor;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import android.provider.Settings;
import org.junit.Test;

public class NotificationSettingsIntentTest {
    @Test
    public void opensTheAppNotificationSettingsFromAndroid8() {
        for (int sdk : new int[] {26, 33, 36}) {
            NotificationSettingsIntent intent =
                NotificationSettingsIntent.forPackage(sdk, "com.example.game");
            assertEquals(Settings.ACTION_APP_NOTIFICATION_SETTINGS, intent.action);
            assertEquals("com.example.game", intent.appPackageExtra);
            assertNull(intent.data);
        }
    }

    @Test
    public void opensTheAppDetailsBeforeAndroid8() {
        for (int sdk : new int[] {24, 25}) {
            NotificationSettingsIntent intent =
                NotificationSettingsIntent.forPackage(sdk, "com.example.game");
            assertEquals(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, intent.action);
            assertNull(intent.appPackageExtra);
            assertEquals("package:com.example.game", intent.data);
        }
    }

    @Test
    public void fallsBackToTheAppDetailsScreen() {
        NotificationSettingsIntent fallback = NotificationSettingsIntent.appDetails("com.example.game");
        assertEquals(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, fallback.action);
        assertNull(fallback.appPackageExtra);
        assertEquals("package:com.example.game", fallback.data);
        assertTrue(fallback.isAppDetails());
        // The notification screen has a fallback; the details screen has none.
        assertFalse(NotificationSettingsIntent.forPackage(36, "com.example.game").isAppDetails());
        assertTrue(NotificationSettingsIntent.forPackage(25, "com.example.game").isAppDetails());
    }

    @Test
    public void keepsTheFrameworkConstants() {
        assertEquals(
            Settings.ACTION_APP_NOTIFICATION_SETTINGS,
            NotificationSettingsIntent.ACTION_APP_NOTIFICATION_SETTINGS
        );
        assertEquals(Settings.EXTRA_APP_PACKAGE, NotificationSettingsIntent.EXTRA_APP_PACKAGE);
        assertEquals(
            Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
            NotificationSettingsIntent.ACTION_APPLICATION_DETAILS_SETTINGS
        );
    }

    @Test
    public void refusesAMissingPackageName() {
        for (String packageName : new String[] {null, ""}) {
            try {
                NotificationSettingsIntent.forPackage(36, packageName);
                fail("Expected a missing package name to be refused.");
            } catch (IllegalArgumentException expected) {
                // A settings intent without the package would open another screen.
            }
            try {
                NotificationSettingsIntent.appDetails(packageName);
                fail("Expected a missing package name to be refused by appDetails.");
            } catch (IllegalArgumentException expected) {
                // Same for the app details screen.
            }
        }
    }
}
