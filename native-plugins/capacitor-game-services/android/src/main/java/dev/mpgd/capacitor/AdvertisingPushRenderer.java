package dev.mpgd.capacitor;

import android.app.ActivityManager;
import android.app.KeyguardManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Bundle;
import android.os.Process;
import android.util.Log;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import java.util.List;
import java.util.Map;

/**
 * Renders the advertising pushes an Android shell shows itself (notifications
 * v2 RFC, "Capacitor"): an FCM data message the backend marked with
 * {@code mpgd.render: advertising}, posted on its channel with the
 * "수신거부" opt-out action. Tapping the body or the action opens the app's
 * launcher activity with the extras the messaging plugin reports as a
 * notification open, so the Capacitor provider's {@code opened} event and its
 * cold-start buffering work as for any other push.
 *
 * <p>{@link AdvertisingMessagingService} calls it; a shell with its own
 * messaging service can call {@link #handle} from {@code onMessageReceived}
 * and declare {@link #META_DATA_RENDERER} on that service.
 */
public final class AdvertisingPushRenderer {
    private static final String TAG = "MpgdAdvertisingPush";
    /** The intent action Firebase Messaging resolves its one messaging service by. */
    static final String MESSAGING_EVENT = "com.google.firebase.MESSAGING_EVENT";
    /**
     * Declared on the shell's messaging service, true when that service
     * renders advertising pushes with this class. The Capacitor provider
     * registers {@code rendersAdvertising} only when the service Firebase
     * Messaging resolves declares it.
     */
    public static final String META_DATA_RENDERER = "dev.mpgd.notifications.advertising_renderer";
    /** Firebase Messaging's own small icon and color settings, which this renderer reads too. */
    static final String META_DATA_ICON = "com.google.firebase.messaging.default_notification_icon";
    static final String META_DATA_COLOR = "com.google.firebase.messaging.default_notification_color";

    private AdvertisingPushRenderer() {}

    /**
     * Handles one received data message. Returns {@code true} when the push
     * was an advertising push for the shell to render and is done with: shown,
     * or dropped because it expired or cannot be shown as the rules require.
     * Returns {@code false} for any other message, and for an advertising push
     * while the app is in the foreground, which the caller hands to the
     * messaging plugin as Android does with a notification message: the game
     * gets a {@code received} event and no notification is shown.
     */
    public static boolean handle(
        final Context context,
        Map<String, String> data,
        String messageId,
        String collapseKey
    ) {
        AdvertisingNotificationPlan plan = AdvertisingNotificationPlan.decide(
            data,
            messageId,
            collapseKey,
            System.currentTimeMillis(),
            () -> isAppInForeground(context)
        );
        if (plan.kind == AdvertisingNotificationPlan.Kind.DROP_MALFORMED) {
            Log.w(TAG, "Dropped an advertising push without a title, body, topic, or readable expiry.");
        } else if (plan.kind == AdvertisingNotificationPlan.Kind.POST) {
            post(context, plan);
        }
        return plan.consumed();
    }

    /** The messaging plugin's entry points the kit's service forwards to. */
    static final String MESSAGING_PLUGIN_CLASS =
        "io.capawesome.capacitorjs.plugins.firebase.messaging.FirebaseMessagingPlugin";
    static final String REMOTE_MESSAGE_CLASS = "com.google.firebase.messaging.RemoteMessage";

    /**
     * Whether the messaging service Firebase Messaging resolves for this app
     * declares {@link #META_DATA_RENDERER} (Android sends a messaging event
     * to one service only, so this is the service that receives pushes), and
     * the messaging plugin's entry points it forwards every other message
     * and token to resolve. A plugin release that renamed them would leave
     * the shell without its plugin events, so it does not count as a renderer.
     */
    public static boolean isInstalled(Context context) {
        if (!declaresRenderer(context)) {
            return false;
        }
        if (!pluginEntryPointsResolve()) {
            Log.w(TAG, "The messaging plugin's entry points do not resolve; no advertising renderer.", entryPointFailure);
            return false;
        }
        return true;
    }

    static boolean pluginEntryPointsResolve() {
        return pluginEntryPoints() != null;
    }

    /**
     * The messaging plugin's static {@code onNewToken(String)} and
     * {@code onMessageReceived(RemoteMessage)}, in that order, or
     * {@code null} when either does not resolve. The one definition of the
     * forwarding contract, which {@link AdvertisingMessagingService} calls
     * through; plain reflection, so a JVM unit test can call it.
     */
    static java.lang.reflect.Method[] pluginEntryPoints() {
        try {
            Class<?> plugin = Class.forName(MESSAGING_PLUGIN_CLASS);
            return new java.lang.reflect.Method[] {
                plugin.getMethod("onNewToken", String.class),
                plugin.getMethod("onMessageReceived", Class.forName(REMOTE_MESSAGE_CLASS)),
            };
        } catch (ReflectiveOperationException | LinkageError error) {
            // Kept for the callers' logs; this method stays free of android.util.Log.
            entryPointFailure = error;
            return null;
        }
    }

    /** Why `pluginEntryPoints()` last answered null, for the callers' logs. */
    static volatile Throwable entryPointFailure;

    private static boolean declaresRenderer(Context context) {
        Intent intent = new Intent(MESSAGING_EVENT).setPackage(context.getPackageName());
        ResolveInfo resolved;
        try {
            resolved = context.getPackageManager().resolveService(intent, PackageManager.GET_META_DATA);
        } catch (RuntimeException error) {
            return false;
        }
        ServiceInfo service = resolved == null ? null : resolved.serviceInfo;
        Bundle metaData = service == null ? null : service.metaData;
        return metaData != null && metaData.getBoolean(META_DATA_RENDERER, false);
    }

    /** Clears the notification an open came from, when the open names one of this renderer's. */
    static void clearOpened(Context context, Intent intent) {
        if (intent == null) {
            return;
        }
        String tag = intent.getStringExtra(AdvertisingPush.EXTRA_TAG);
        if (tag == null || tag.isEmpty()) {
            return;
        }
        // The action does not dismiss the notification by itself.
        NotificationManagerCompat.from(context).cancel(tag, AdvertisingPush.NOTIFICATION_ID);
    }

    private static void post(Context context, AdvertisingNotificationPlan plan) {
        Intent launch = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
        if (launch == null) {
            Log.w(TAG, "Dropped an advertising push: the app has no launcher activity to open.");
            return;
        }
        NotificationManagerCompat manager = NotificationManagerCompat.from(context);
        // Android drops these posts without an error, so say why here.
        if (!manager.areNotificationsEnabled()) {
            Log.w(
                TAG,
                "Dropped an advertising push: notifications are off for the app "
                    + "(turned off, or POST_NOTIFICATIONS not granted)."
            );
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            android.app.NotificationChannel channel = manager.getNotificationChannel(plan.channelId);
            if (channel == null) {
                // The provider creates the catalog's channels before it
                // registers a token; a channel that is gone was deleted since,
                // and posting without it would show nothing.
                Log.w(TAG, "Dropped an advertising push: its channel " + plan.channelId + " does not exist.");
                return;
            }
            if (channel.getImportance() == android.app.NotificationManager.IMPORTANCE_NONE) {
                // The player turned this channel off in system settings.
                Log.i(TAG, "Dropped an advertising push: its channel " + plan.channelId + " is turned off.");
                return;
            }
        }
        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, plan.channelId)
            .setSmallIcon(smallIcon(context))
            .setContentTitle(plan.title)
            .setContentText(plan.body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(plan.body))
            .setAutoCancel(true)
            .setContentIntent(openIntent(context, launch, plan.bodyExtras, plan.bodyRequestCode))
            .addAction(
                0,
                plan.actionLabel,
                openIntent(context, launch, plan.actionExtras, plan.actionRequestCode)
            );
        Integer color = color(context);
        if (color != null) {
            builder.setColor(color);
        }
        if (plan.timeoutAfterMillis != null) {
            // Taken off the shade once it expires (Android 8+).
            builder.setTimeoutAfter(plan.timeoutAfterMillis);
        }
        try {
            manager.notify(plan.tag, plan.notificationId, builder.build());
        } catch (SecurityException error) {
            // Some builds throw instead of dropping when POST_NOTIFICATIONS is missing.
            Log.w(TAG, "Dropped an advertising push: notifications are not permitted.", error);
        }
    }

    private static PendingIntent openIntent(
        Context context,
        Intent launch,
        Map<String, String> extras,
        int requestCode
    ) {
        Intent intent = new Intent(launch);
        intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        for (Map.Entry<String, String> extra : extras.entrySet()) {
            intent.putExtra(extra.getKey(), extra.getValue());
        }
        return PendingIntent.getActivity(
            context,
            requestCode,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
    }

    /** Firebase Messaging's default icon when the shell sets one, else the app icon. */
    private static int smallIcon(Context context) {
        ApplicationInfo info = applicationInfo(context);
        int icon = 0;
        if (info != null && info.metaData != null) {
            icon = info.metaData.getInt(META_DATA_ICON, 0);
        }
        if (icon == 0 && info != null) {
            icon = info.icon;
        }
        if (icon == 0 || isAdaptiveIconOnOreo(context, icon)) {
            // Android 8.0 cannot use an adaptive icon as a small icon.
            return android.R.drawable.sym_def_app_icon;
        }
        return icon;
    }

    private static boolean isAdaptiveIconOnOreo(Context context, int icon) {
        if (Build.VERSION.SDK_INT != Build.VERSION_CODES.O) {
            return false;
        }
        try {
            return ContextCompat.getDrawable(context, icon) instanceof android.graphics.drawable.AdaptiveIconDrawable;
        } catch (RuntimeException error) {
            return true;
        }
    }

    private static Integer color(Context context) {
        ApplicationInfo info = applicationInfo(context);
        int resource = info == null || info.metaData == null ? 0 : info.metaData.getInt(META_DATA_COLOR, 0);
        if (resource == 0) {
            return null;
        }
        try {
            return ContextCompat.getColor(context, resource);
        } catch (RuntimeException error) {
            return null;
        }
    }

    private static ApplicationInfo applicationInfo(Context context) {
        try {
            return context.getPackageManager().getApplicationInfo(
                context.getPackageName(),
                PackageManager.GET_META_DATA
            );
        } catch (PackageManager.NameNotFoundException error) {
            return null;
        }
    }

    /**
     * Whether this process has a visible activity and the screen is
     * unlocked, as Firebase Messaging decides whether to show a notification
     * message itself.
     */
    private static boolean isAppInForeground(Context context) {
        KeyguardManager keyguard = (KeyguardManager) context.getSystemService(Context.KEYGUARD_SERVICE);
        if (keyguard != null && keyguard.isKeyguardLocked()) {
            return false;
        }
        ActivityManager activities = (ActivityManager) context.getSystemService(Context.ACTIVITY_SERVICE);
        List<ActivityManager.RunningAppProcessInfo> processes =
            activities == null ? null : activities.getRunningAppProcesses();
        if (processes == null) {
            return false;
        }
        int pid = Process.myPid();
        for (ActivityManager.RunningAppProcessInfo process : processes) {
            if (process.pid == pid) {
                return process.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND;
            }
        }
        return false;
    }
}
