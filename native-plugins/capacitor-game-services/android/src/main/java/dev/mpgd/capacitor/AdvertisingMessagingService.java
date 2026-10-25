package dev.mpgd.capacitor;

import android.util.Log;
import androidx.annotation.NonNull;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;
import java.lang.reflect.Method;

/**
 * The shell's Firebase messaging service when it renders advertising pushes
 * (notifications v2 RFC, "Capacitor"). Android delivers a messaging event to
 * one service only, so the shell declares this service in place of the one
 * {@code @capacitor-firebase/messaging} 8.x declares
 * ({@code io.capawesome.capacitorjs.plugins.firebase.messaging.MessagingService},
 * removed with {@code tools:node="remove"}), with the
 * {@link AdvertisingPushRenderer#META_DATA_RENDERER} meta-data.
 * {@code mpgd target init capacitor --providers notifications} writes both.
 *
 * <p>It renders the advertising pushes the backend marks for the shell and
 * hands every other message, and every new token, to the messaging plugin
 * exactly as the plugin's own service does (its public static
 * {@code FirebaseMessagingPlugin.onMessageReceived} and {@code onNewToken},
 * which Capacitor's ProGuard rules keep), so the plugin's events reach the
 * game unchanged.
 *
 * <p>The library compiles it against {@code firebase-messaging} without
 * shipping that dependency and declares it in no manifest of its own: an app
 * without Firebase never loads it.
 */
public class AdvertisingMessagingService extends FirebaseMessagingService {
    private static final String TAG = "MpgdAdvertisingPush";
    /** The messaging plugin's entry points; resolved once. */
    static final String PLUGIN_CLASS =
        "io.capawesome.capacitorjs.plugins.firebase.messaging.FirebaseMessagingPlugin";
    private static volatile Method onNewToken;
    private static volatile Method onMessageReceived;
    private static volatile boolean resolved;

    @Override
    public void onNewToken(@NonNull String token) {
        super.onNewToken(token);
        forward(true, token);
    }

    @Override
    public void onMessageReceived(@NonNull RemoteMessage message) {
        super.onMessageReceived(message);
        boolean handled = false;
        try {
            handled = AdvertisingPushRenderer.handle(
                this,
                message.getData(),
                message.getMessageId(),
                message.getCollapseKey()
            );
        } catch (RuntimeException error) {
            // A rendering failure must not take the plugin's events with it.
            Log.e(TAG, "Could not render an advertising push.", error);
            handled = AdvertisingPush.isShellRendered(message.getData());
        }
        if (!handled) {
            forward(false, message);
        }
    }

    private static void forward(boolean token, Object argument) {
        resolve();
        Method method = token ? onNewToken : onMessageReceived;
        if (method == null) {
            Log.w(TAG, "@capacitor-firebase/messaging is not installed; the push reaches no plugin.");
            return;
        }
        try {
            method.invoke(null, argument);
        } catch (ReflectiveOperationException | RuntimeException error) {
            Log.e(TAG, "Could not hand a push to @capacitor-firebase/messaging.", error);
        }
    }

    private static void resolve() {
        if (resolved) {
            return;
        }
        synchronized (AdvertisingMessagingService.class) {
            if (resolved) {
                return;
            }
            try {
                Class<?> plugin = Class.forName(PLUGIN_CLASS);
                onNewToken = plugin.getMethod("onNewToken", String.class);
                onMessageReceived = plugin.getMethod("onMessageReceived", RemoteMessage.class);
            } catch (ReflectiveOperationException | LinkageError error) {
                Log.w(TAG, "@capacitor-firebase/messaging entry points not found.", error);
            }
            resolved = true;
        }
    }
}
