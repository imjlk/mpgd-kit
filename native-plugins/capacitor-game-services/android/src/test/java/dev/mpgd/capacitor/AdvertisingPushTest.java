package dev.mpgd.capacitor;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.Test;

public class AdvertisingPushTest {
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
        data.put("mpgd.expiresAt", "1760875200000");
        return data;
    }

    @Test
    public void readsWhatTheBackendRendered() {
        AdvertisingPush push = AdvertisingPush.parse(message(), "0:1%abc", "c0ffee");
        assertNotNull(push);
        assertEquals("(광고) 세일", push.title);
        assertEquals("(광고) 02-000-0000\n세일 중\n무료 수신거부: 수신거부 버튼", push.body);
        assertEquals("promotions", push.channel);
        assertEquals("수신거부", push.actionTitle);
        assertEquals(Long.valueOf(1760875200000L), push.expiresAt);
        // The collapse key tags the notification, so a replay replaces it.
        assertEquals("c0ffee", push.tag);
    }

    @Test
    public void opensThroughTheMessagingPluginWithTheTopicRouteAndData() {
        AdvertisingPush push = AdvertisingPush.parse(message(), "0:1%abc", "c0ffee");
        Map<String, String> expected = new LinkedHashMap<>();
        expected.put("offer", "autumn");
        expected.put("topic", "sale");
        expected.put("route", "/shop");
        expected.put("google.message_id", "0:1%abc");
        expected.put("mpgd.tag", "c0ffee");
        assertEquals(expected, push.tapExtras());
        // The action adds only its id: the provider opens the topic's declared
        // opt-out route, never a route from the payload.
        Map<String, String> optOut = new LinkedHashMap<>(expected);
        optOut.put("mpgd.action", "advertising-opt-out");
        assertEquals(optOut, push.optOutExtras());
        assertEquals(
            push.optOutExtras().get(AdvertisingPush.EXTRA_ACTION),
            AdvertisingPush.OPT_OUT_ACTION_ID
        );
    }

    @Test
    public void keepsTheTwoIntentsApart() {
        AdvertisingPush push = AdvertisingPush.parse(message(), "0:1%abc", "c0ffee");
        assertNotEquals(push.requestCode(false), push.requestCode(true));
        assertTrue(push.requestCode(false) >= 0);
        assertTrue(push.requestCode(true) >= 0);
        AdvertisingPush other = AdvertisingPush.parse(message(), "0:2%abc", "beef");
        assertNotEquals(push.requestCode(false), other.requestCode(false));
    }

    @Test
    public void defaultsTheChannelTheActionTitleAndTheTag() {
        Map<String, String> data = message();
        data.remove("mpgd.channel");
        data.remove("mpgd.actionTitle");
        data.remove("mpgd.expiresAt");
        AdvertisingPush push = AdvertisingPush.parse(data, "0:1%abc", null);
        assertEquals("mpgd-advertising", push.channel);
        assertEquals("수신거부", push.actionTitle);
        assertNull(push.expiresAt);
        assertFalse(push.isExpired(Long.MAX_VALUE));
        assertEquals("0:1%abc", push.tag);
        // Without a message id the open still carries one, or the plugin would not report it.
        AdvertisingPush bare = AdvertisingPush.parse(data, null, null);
        assertEquals("mpgd-advertising", bare.tag);
        assertEquals("mpgd-advertising", bare.tapExtras().get("google.message_id"));
    }

    @Test
    public void arrivalAtOrAfterTheExpiryIsNotShown() {
        AdvertisingPush push = AdvertisingPush.parse(message(), "id", "tag");
        assertFalse(push.isExpired(1760875199999L));
        assertTrue(push.isExpired(1760875200000L));
        assertTrue(push.isExpired(1760875200001L));
    }

    @Test
    public void ignoresEveryOtherMessage() {
        assertFalse(AdvertisingPush.isShellRendered(null));
        Map<String, String> plain = new HashMap<>();
        plain.put("topic", "friend-challenge");
        plain.put("route", "/");
        assertFalse(AdvertisingPush.isShellRendered(plain));
        assertNull(AdvertisingPush.parse(plain, "id", "tag"));
        plain.put("mpgd.render", "service");
        assertFalse(AdvertisingPush.isShellRendered(plain));
        assertTrue(AdvertisingPush.isShellRendered(message()));
    }

    @Test
    public void refusesAPushItCannotShowAsTheRulesRequire() {
        for (String key : new String[] {"mpgd.title", "mpgd.body", "topic"}) {
            Map<String, String> data = message();
            data.put(key, " ");
            assertNull(key, AdvertisingPush.parse(data, "id", "tag"));
            data.remove(key);
            assertNull(key, AdvertisingPush.parse(data, "id", "tag"));
        }
        Map<String, String> data = message();
        data.put("mpgd.expiresAt", "soon");
        assertNull(AdvertisingPush.parse(data, "id", "tag"));
    }

    @Test
    public void keepsTransportAndRendererKeysOutOfTheOpen() {
        Map<String, String> data = message();
        data.put("google.c.a.e", "1");
        data.put("gcm.n.e", "1");
        data.put("mpgd.action", "advertising-opt-out");
        AdvertisingPush push = AdvertisingPush.parse(data, "id", "tag");
        assertFalse(push.tapExtras().containsKey("google.c.a.e"));
        assertFalse(push.tapExtras().containsKey("gcm.n.e"));
        // A payload cannot turn a tap into the opt-out action.
        assertFalse(push.tapExtras().containsKey("mpgd.action"));
        assertFalse(push.tapExtras().containsKey("mpgd.title"));
    }

    @Test
    public void keepsTheProviderConstants() {
        assertEquals("dev.mpgd.notifications.advertising_renderer", AdvertisingPushRenderer.META_DATA_RENDERER);
        assertEquals("com.google.firebase.MESSAGING_EVENT", AdvertisingPushRenderer.MESSAGING_EVENT);
        assertEquals(
            "io.capawesome.capacitorjs.plugins.firebase.messaging.FirebaseMessagingPlugin",
            AdvertisingPushRenderer.MESSAGING_PLUGIN_CLASS
        );
        // Without the plugin on the classpath, the renderer does not count as installed.
        assertFalse(AdvertisingPushRenderer.pluginEntryPointsResolve());
    }
}
