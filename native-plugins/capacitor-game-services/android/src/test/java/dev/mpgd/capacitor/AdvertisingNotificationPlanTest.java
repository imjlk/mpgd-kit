package dev.mpgd.capacitor;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.Test;

public class AdvertisingNotificationPlanTest {
    private static final long EXPIRES_AT = 1760875200000L;
    private static final long NOW = EXPIRES_AT - 60_000L;

    /** The data message the FCM provider builds for a rendering endpoint (fcm.test.ts). */
    private static Map<String, String> message() {
        Map<String, String> data = new LinkedHashMap<>();
        data.put("offer", "autumn");
        data.put("topic", "sale");
        data.put("route", "/shop");
        data.put("mpgd.render", "advertising");
        data.put("mpgd.title", "(광고) 세일");
        data.put("mpgd.body", "(광고) 02-000-0000\n세일 중\n무료 수신거부: 수신거부 버튼");
        data.put("mpgd.channel", "promotions");
        data.put("mpgd.actionTitle", "수신거부");
        data.put("mpgd.optOutRoute", "/settings/ads");
        data.put("mpgd.expiresAt", Long.toString(EXPIRES_AT));
        return data;
    }

    private static AdvertisingNotificationPlan background(Map<String, String> data, long now) {
        return AdvertisingNotificationPlan.decide(data, "0:1%abc", "c0ffee", now, () -> false);
    }

    @Test
    public void postsOnTheSendsChannelWithTheOptOutAction() {
        AdvertisingNotificationPlan plan = background(message(), NOW);
        assertEquals(AdvertisingNotificationPlan.Kind.POST, plan.kind);
        assertTrue(plan.consumed());
        assertEquals("promotions", plan.channelId);
        assertEquals("(광고) 세일", plan.title);
        assertEquals("(광고) 02-000-0000\n세일 중\n무료 수신거부: 수신거부 버튼", plan.body);
        assertEquals("수신거부", plan.actionLabel);
        assertEquals("c0ffee", plan.tag);
        assertEquals(AdvertisingPush.NOTIFICATION_ID, plan.notificationId);
        // Taken off the shade when it expires.
        assertEquals(Long.valueOf(60_000L), plan.timeoutAfterMillis);
    }

    @Test
    public void theBodyOpensTheSendsRouteAndTheActionTheTopicsOptOutRoute() {
        AdvertisingNotificationPlan plan = background(message(), NOW);
        assertEquals("/shop", plan.bodyExtras.get("route"));
        assertEquals("sale", plan.bodyExtras.get("topic"));
        assertEquals("autumn", plan.bodyExtras.get("offer"));
        assertEquals("0:1%abc", plan.bodyExtras.get("google.message_id"));
        assertFalse(plan.bodyExtras.containsKey("mpgd.action"));

        assertEquals("/settings/ads", plan.actionExtras.get("route"));
        assertNotEquals("/shop", plan.actionExtras.get("route"));
        assertEquals("sale", plan.actionExtras.get("topic"));
        assertEquals("advertising-opt-out", plan.actionExtras.get("mpgd.action"));
        assertEquals("0:1%abc", plan.actionExtras.get("google.message_id"));
        // Two intents of one notification never share a request code.
        assertNotEquals(plan.bodyRequestCode, plan.actionRequestCode);
    }

    @Test
    public void anActionWithoutTheOptOutRouteCarriesNoSendRoute() {
        // Under advertisingRules 'none' the content has no action: the label
        // falls back and the intent carries no route, so the provider's
        // declared opt-out route is the only one.
        Map<String, String> data = message();
        data.remove("mpgd.optOutRoute");
        data.remove("mpgd.actionTitle");
        AdvertisingNotificationPlan plan = background(data, NOW);
        assertEquals("수신거부", plan.actionLabel);
        assertFalse(plan.actionExtras.containsKey("route"));
        assertEquals("/shop", plan.bodyExtras.get("route"));
    }

    @Test
    public void inTheForegroundThePluginGetsIt() {
        AdvertisingNotificationPlan plan =
            AdvertisingNotificationPlan.decide(message(), "id", "tag", NOW, () -> true);
        assertEquals(AdvertisingNotificationPlan.Kind.HAND_TO_PLUGIN, plan.kind);
        assertFalse(plan.consumed());
        assertNull(plan.channelId);
    }

    @Test
    public void anExpiredPushIsDroppedWithoutAskingForTheForeground() {
        for (long now : new long[] {EXPIRES_AT, EXPIRES_AT + 1}) {
            AdvertisingNotificationPlan plan = AdvertisingNotificationPlan.decide(
                message(),
                "id",
                "tag",
                now,
                () -> {
                    fail("An expired push needs no foreground check.");
                    return false;
                }
            );
            assertEquals(AdvertisingNotificationPlan.Kind.DROP_EXPIRED, plan.kind);
            assertTrue(plan.consumed());
        }
        // A millisecond before, it is shown, for at least a millisecond.
        AdvertisingNotificationPlan last = background(message(), EXPIRES_AT - 1);
        assertEquals(AdvertisingNotificationPlan.Kind.POST, last.kind);
        assertEquals(Long.valueOf(1L), last.timeoutAfterMillis);
    }

    @Test
    public void withoutAnExpiryItStaysUntilDismissed() {
        Map<String, String> data = message();
        data.remove("mpgd.expiresAt");
        assertNull(background(data, NOW).timeoutAfterMillis);
    }

    @Test
    public void otherMessagesGoToThePluginAndMalformedOnesAreDropped() {
        Map<String, String> plain = new LinkedHashMap<>();
        plain.put("topic", "friend-challenge");
        plain.put("route", "/");
        AdvertisingNotificationPlan other = background(plain, NOW);
        assertEquals(AdvertisingNotificationPlan.Kind.NOT_OURS, other.kind);
        assertFalse(other.consumed());

        Map<String, String> untitled = message();
        untitled.remove("mpgd.title");
        AdvertisingNotificationPlan malformed = background(untitled, NOW);
        assertEquals(AdvertisingNotificationPlan.Kind.DROP_MALFORMED, malformed.kind);
        assertTrue(malformed.consumed());
    }
}
