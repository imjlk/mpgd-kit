package dev.mpgd.capacitor;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * An advertising push the shell renders itself, read from an FCM data
 * message (notifications v2 RFC, "Delivery providers" and "Capacitor"). An
 * Android FCM notification message cannot carry the advertising opt-out
 * action the Korean rules require, so the backend sends advertising to an
 * installation that registered {@code rendersAdvertising} as a data message
 * with these keys ({@code fcmShellRenderedDataKeys} in
 * {@code @mpgd/game-services/notifications}), and the kit's messaging
 * service posts it with the action.
 *
 * <p>Plain values only, so the reading is testable without an Android
 * runtime. The open extras reach the game through the messaging plugin's
 * notification-open path: they carry {@code google.message_id}, which
 * {@code FirebaseMessagingPlugin.handleOnNewIntent} looks for, the push's
 * {@code topic} and {@code route}, and its routing data. The opt-out action
 * adds {@link #EXTRA_ACTION}; the Capacitor provider then opens the topic's
 * declared opt-out route, never a route from the payload.
 */
final class AdvertisingPush {
    static final String KEY_RENDER = "mpgd.render";
    static final String RENDER_ADVERTISING = "advertising";
    static final String KEY_TITLE = "mpgd.title";
    static final String KEY_BODY = "mpgd.body";
    static final String KEY_CHANNEL = "mpgd.channel";
    static final String KEY_ACTION_TITLE = "mpgd.actionTitle";
    static final String KEY_EXPIRES_AT = "mpgd.expiresAt";
    static final String KEY_TOPIC = "topic";
    /** The prefix of the renderer's own keys, which never reach the game as data. */
    static final String RESERVED_PREFIX = "mpgd.";
    /** The extra the messaging plugin reads to report a notification open. */
    static final String EXTRA_MESSAGE_ID = "google.message_id";
    /** On the opt-out action's intent: the action id the Capacitor provider reads. */
    static final String EXTRA_ACTION = "mpgd.action";
    /** On both intents: the notification's tag, so the open can clear it. */
    static final String EXTRA_TAG = "mpgd.tag";
    /** {@code notificationAdvertisingOptOutActionId} in {@code @mpgd/platform/notifications}. */
    static final String OPT_OUT_ACTION_ID = "advertising-opt-out";
    static final String DEFAULT_ACTION_TITLE = "수신거부";
    static final String DEFAULT_CHANNEL = "mpgd-advertising";
    /** The id every advertising notification posts under; the tag tells them apart. */
    static final int NOTIFICATION_ID = 0x6d706764;

    final String title;
    final String body;
    final String channel;
    final String actionTitle;
    /** Epoch milliseconds after which the push is not shown, or {@code null}. */
    final Long expiresAt;
    final String tag;
    private final Map<String, String> openData;

    private AdvertisingPush(
        String title,
        String body,
        String channel,
        String actionTitle,
        Long expiresAt,
        String tag,
        Map<String, String> openData
    ) {
        this.title = title;
        this.body = body;
        this.channel = channel;
        this.actionTitle = actionTitle;
        this.expiresAt = expiresAt;
        this.tag = tag;
        this.openData = openData;
    }

    /** Whether the backend asked the shell to render this data message. */
    static boolean isShellRendered(Map<String, String> data) {
        return data != null && RENDER_ADVERTISING.equals(data.get(KEY_RENDER));
    }

    /**
     * Reads a push {@link #isShellRendered} accepted. Returns {@code null} when
     * it cannot be shown as the rules require: no title, body, or topic (the
     * opt-out action opens the topic's opt-out route), or an expiry that is
     * not a number, since the push may then arrive inside the night window.
     */
    static AdvertisingPush parse(Map<String, String> data, String messageId, String collapseKey) {
        if (!isShellRendered(data)) {
            return null;
        }
        String title = data.get(KEY_TITLE);
        String body = data.get(KEY_BODY);
        String topic = data.get(KEY_TOPIC);
        if (isBlank(title) || isBlank(body) || isBlank(topic)) {
            return null;
        }
        Long expiresAt = null;
        String expiry = data.get(KEY_EXPIRES_AT);
        if (expiry != null) {
            try {
                expiresAt = Long.parseLong(expiry.trim());
            } catch (NumberFormatException error) {
                return null;
            }
        }
        String channel = isBlank(data.get(KEY_CHANNEL)) ? DEFAULT_CHANNEL : data.get(KEY_CHANNEL);
        String actionTitle = isBlank(data.get(KEY_ACTION_TITLE))
            ? DEFAULT_ACTION_TITLE
            : data.get(KEY_ACTION_TITLE);
        // A replay of the same send carries the same collapse key and so
        // replaces the first notification instead of showing a second.
        String tag = !isBlank(collapseKey)
            ? collapseKey
            : !isBlank(messageId) ? messageId : "mpgd-advertising";
        Map<String, String> openData = new LinkedHashMap<>();
        for (Map.Entry<String, String> entry : data.entrySet()) {
            String key = entry.getKey();
            if (key != null && entry.getValue() != null && !key.startsWith(RESERVED_PREFIX)
                && !key.startsWith("google.") && !key.startsWith("gcm.")) {
                openData.put(key, entry.getValue());
            }
        }
        openData.put(EXTRA_MESSAGE_ID, isBlank(messageId) ? tag : messageId);
        openData.put(EXTRA_TAG, tag);
        return new AdvertisingPush(
            title,
            body,
            channel,
            actionTitle,
            expiresAt,
            tag,
            Collections.unmodifiableMap(openData)
        );
    }

    /** Arrival decides: a push that arrives at or after its expiry is not shown. */
    boolean isExpired(long nowMillis) {
        return expiresAt != null && nowMillis >= expiresAt;
    }

    /** The extras of a tap on the notification: its topic, route, and routing data. */
    Map<String, String> tapExtras() {
        return openData;
    }

    /** The extras of the opt-out action: the tap's, and the action id. */
    Map<String, String> optOutExtras() {
        Map<String, String> extras = new LinkedHashMap<>(openData);
        extras.put(EXTRA_ACTION, OPT_OUT_ACTION_ID);
        return Collections.unmodifiableMap(extras);
    }

    /**
     * The request code of one of this push's two intents, so the tap and the
     * action of one notification, and the intents of two notifications, do
     * not replace each other's extras.
     */
    int requestCode(boolean optOut) {
        return (tag.hashCode() & 0x3fffffff) * 2 + (optOut ? 1 : 0);
    }

    private static boolean isBlank(String value) {
        return value == null || value.trim().isEmpty();
    }
}
