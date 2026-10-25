package dev.mpgd.capacitor;

import java.util.Map;
import java.util.function.BooleanSupplier;

/**
 * What the renderer does with one received data message, decided in plain
 * Java so every decision is testable without an Android runtime:
 * {@link AdvertisingPushRenderer} only turns a {@link Kind#POST} plan into a
 * {@code NotificationCompat} notification and two activity intents.
 *
 * <p>A plan to post names the channel, the title and body, the opt-out
 * action's label, the extras of the body's intent (the send's route) and of
 * the action's intent (the topic's opt-out route and the action mark, never
 * the send's route), their request codes, the tag and id to post under, and
 * how long the notification may stay in the shade.
 */
final class AdvertisingNotificationPlan {
    enum Kind {
        /** Not an advertising push for the shell: the plugin gets it. */
        NOT_OURS,
        /** Marked for the shell but not showable as the rules require: dropped. */
        DROP_MALFORMED,
        /** Arrived at or after its expiry: dropped. */
        DROP_EXPIRED,
        /** The app is in the foreground: the plugin reports it, nothing is shown. */
        HAND_TO_PLUGIN,
        /** Shown with the opt-out action. */
        POST,
    }

    final Kind kind;
    final String channelId;
    final String title;
    final String body;
    final String actionLabel;
    final String tag;
    final int notificationId;
    final Map<String, String> bodyExtras;
    final Map<String, String> actionExtras;
    final int bodyRequestCode;
    final int actionRequestCode;
    /** Milliseconds the notification may stay in the shade, or {@code null} without an expiry. */
    final Long timeoutAfterMillis;

    private AdvertisingNotificationPlan(Kind kind, AdvertisingPush push, long nowMillis) {
        this.kind = kind;
        boolean post = kind == Kind.POST;
        this.channelId = post ? push.channel : null;
        this.title = post ? push.title : null;
        this.body = post ? push.body : null;
        this.actionLabel = post ? push.actionTitle : null;
        this.tag = post ? push.tag : null;
        this.notificationId = AdvertisingPush.NOTIFICATION_ID;
        this.bodyExtras = post ? push.tapExtras() : null;
        this.actionExtras = post ? push.optOutExtras() : null;
        this.bodyRequestCode = post ? push.requestCode(false) : 0;
        this.actionRequestCode = post ? push.requestCode(true) : 0;
        this.timeoutAfterMillis = post && push.expiresAt != null
            ? Math.max(1L, push.expiresAt - nowMillis)
            : null;
    }

    /**
     * Decides what to do with one data message at {@code nowMillis}.
     * {@code foreground} is asked only for a push that would otherwise be
     * shown, because it costs a system call.
     */
    static AdvertisingNotificationPlan decide(
        Map<String, String> data,
        String messageId,
        String collapseKey,
        long nowMillis,
        BooleanSupplier foreground
    ) {
        if (!AdvertisingPush.isShellRendered(data)) {
            return new AdvertisingNotificationPlan(Kind.NOT_OURS, null, nowMillis);
        }
        AdvertisingPush push = AdvertisingPush.parse(data, messageId, collapseKey);
        if (push == null) {
            return new AdvertisingNotificationPlan(Kind.DROP_MALFORMED, null, nowMillis);
        }
        if (push.isExpired(nowMillis)) {
            // The Korean rules judge arrival: one that arrives too late is not shown.
            return new AdvertisingNotificationPlan(Kind.DROP_EXPIRED, push, nowMillis);
        }
        if (foreground.getAsBoolean()) {
            return new AdvertisingNotificationPlan(Kind.HAND_TO_PLUGIN, push, nowMillis);
        }
        return new AdvertisingNotificationPlan(Kind.POST, push, nowMillis);
    }

    /** Whether the renderer is done with the message, so the plugin does not get it. */
    boolean consumed() {
        return kind != Kind.NOT_OURS && kind != Kind.HAND_TO_PLUGIN;
    }
}
