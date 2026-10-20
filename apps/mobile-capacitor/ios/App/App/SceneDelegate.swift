import UIKit
import Capacitor
import UserNotifications

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = CAPBridgeViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
        // A killed-app tap is only in connectionOptions.notificationResponse.
        // Capacitor 8.5's scene proxy replays URL contexts on capacitorViewDidAppear
        // and does not read this, and @capacitor/ios 8.5.2 never does either.
        forwardColdStartNotification(connectionOptions.notificationResponse)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }

    /// Replays a cold-start notification response once plugins have registered
    /// with Capacitor's notification router. `load()` runs before
    /// `capacitorViewDidAppear`, which is how the scene proxy replays URL contexts.
    private func forwardColdStartNotification(_ response: UNNotificationResponse?) {
        guard let response else { return }
        var token: NSObjectProtocol?
        token = NotificationCenter.default.addObserver(
            forName: .capacitorViewDidAppear,
            object: nil,
            queue: .main
        ) { _ in
            if let token {
                NotificationCenter.default.removeObserver(token)
            }
            self.deliverColdStartNotification(response)
        }
    }

    private func deliverColdStartNotification(_ response: UNNotificationResponse) {
        let center = UNUserNotificationCenter.current()
        if let delegate = center.delegate {
            delegate.userNotificationCenter?(center, didReceive: response, withCompletionHandler: {})
            return
        }
        guard let controller = window?.rootViewController as? CAPBridgeViewController,
              let bridge = controller.bridge else {
            return
        }
        bridge.notificationRouter.userNotificationCenter(
            center,
            didReceive: response,
            withCompletionHandler: {}
        )
    }
}
