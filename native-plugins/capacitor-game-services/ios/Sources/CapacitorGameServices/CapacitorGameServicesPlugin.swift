import Capacitor
import Foundation

@objc(CapacitorGameServicesPlugin)
public class CapacitorGameServicesPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "CapacitorGameServicesPlugin"
    public let jsName = "CapacitorGameServices"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "request", returnType: CAPPluginReturnPromise)
    ]

    @objc func request(_ call: CAPPluginCall) {
        let id = call.getString("id") ?? "ios-native-mock"

        guard let method = call.getString("method"), !method.isEmpty else {
            call.resolve(errorResponse(id: id, code: "INVALID_BRIDGE_REQUEST", message: "Bridge method is required."))
            return
        }

        switch method {
        case "runtime.getCapabilities":
            call.resolve(okResponse(id: id, data: capabilities()))
        case "identity.getPlayer":
            call.resolve(okResponse(id: id, data: player()))
        case "identity.getSession":
            call.resolve(okResponse(id: id, data: [
                "identityLevel": "platform-anonymous",
                "playerId": "ios-local-player",
                "trustLevel": "local"
            ]))
        case "identity.requestUpgrade":
            call.resolve(okResponse(id: id, data: [
                "status": "unavailable",
                "reloadExpected": false
            ]))
        case "presentation.getLaunchIntent":
            call.resolve(okResponse(id: id, data: ["entry": "home"]))
        case "presentation.requestGameSurface":
            call.resolve(okResponse(id: id, data: "already-fullscreen"))
        case "share.share":
            call.resolve(okResponse(id: id, data: ["status": "unavailable"]))
        case "share.readInboundShare":
            call.resolve(okResponse(id: id, data: NSNull()))
        case "notifications.getStatus":
            call.resolve(okResponse(id: id, data: "configuration-required"))
        case "notifications.requestSubscription":
            call.resolve(okResponse(id: id, data: "unavailable"))
        case "commerce.getProducts":
            call.resolve(okResponse(id: id, data: [product()]))
        case "commerce.purchase":
            call.resolve(okResponse(id: id, data: [
                "status": "completed",
                "transactionId": "ios-mock-\(id)",
                "entitlementIds": ["COINS_100"]
            ]))
        case "commerce.restore":
            call.resolve(okResponse(id: id, data: ["restoredEntitlements": []]))
        case "commerce.getEntitlements":
            call.resolve(okResponse(id: id, data: []))
        case "ads.preload":
            call.resolve(okResponse(id: id, data: [:]))
        case "ads.showRewarded":
            call.resolve(okResponse(id: id, data: [
                "status": "completed",
                "rewardGranted": true,
                "ledgerEntryId": "ios-reward-\(id)"
            ]))
        case "ads.showInterstitial":
            call.resolve(okResponse(id: id, data: ["status": "shown"]))
        case "leaderboard.submitScore":
            call.resolve(okResponse(id: id, data: ["submitted": true]))
        case "leaderboard.open":
            call.resolve(okResponse(id: id, data: ["opened": true]))
        case "storage.load":
            call.resolve(okResponse(id: id, data: NSNull()))
        case "storage.save":
            call.resolve(okResponse(id: id, data: [:]))
        default:
            call.resolve(errorResponse(id: id, code: "UNSUPPORTED_METHOD", message: "Unsupported bridge method: \(method)"))
        }
    }

    private func okResponse(id: String, data: Any) -> [String: Any] {
        return [
            "id": id,
            "ok": true,
            "data": data
        ]
    }

    private func errorResponse(id: String, code: String, message: String) -> [String: Any] {
        return [
            "id": id,
            "ok": false,
            "error": [
                "code": code,
                "message": message,
                "retryable": false
            ]
        ]
    }

    private func capabilities() -> [String: Any] {
        return [
            "nativeIap": true,
            "nativeAds": true,
            "rewardedAds": true,
            "interstitialAds": true,
            "nativeLeaderboard": true,
            "achievements": false,
            "cloudSave": false,
            "socialShare": false,
            "haptics": true,
            "localizedContent": true
        ]
    }

    private func player() -> [String: Any] {
        return [
            "playerId": "ios-local-player",
            "displayName": "iOS Local Player"
        ]
    }

    private func product() -> [String: Any] {
        return [
            "id": "COINS_100",
            "type": "consumable",
            "title": "100 Coins",
            "description": "Adds 100 demo coins.",
            "price": [
                "formatted": "$0.99",
                "currencyCode": "USD"
            ]
        ]
    }
}
