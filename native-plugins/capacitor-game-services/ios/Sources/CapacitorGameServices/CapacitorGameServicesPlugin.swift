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
        case "commerce.getProducts":
            call.resolve(okResponse(id: id, data: ["products": []]))
        case "commerce.purchase":
            call.resolve(okResponse(id: id, data: [
                "status": "pending_verification",
                "transactionId": "ios-mock-\(id)"
            ]))
        case "commerce.restore", "commerce.getEntitlements":
            call.resolve(okResponse(id: id, data: ["entitlements": []]))
        case "ads.preload":
            call.resolve(okResponse(id: id, data: ["preloaded": true]))
        case "ads.showRewarded":
            call.resolve(okResponse(id: id, data: [
                "status": "rewarded",
                "rewardClaimId": "ios-reward-\(id)"
            ]))
        case "ads.showInterstitial":
            call.resolve(okResponse(id: id, data: ["status": "shown"]))
        case "leaderboard.submitScore":
            call.resolve(okResponse(id: id, data: ["submitted": true]))
        case "leaderboard.open":
            call.resolve(okResponse(id: id, data: ["opened": true]))
        case "storage.load":
            call.resolve(okResponse(id: id, data: ["saveData": NSNull()]))
        case "storage.save":
            call.resolve(okResponse(id: id, data: ["saved": true]))
        default:
            call.resolve(errorResponse(id: id, code: "UNSUPPORTED_METHOD", message: "Unsupported bridge method: \(method)"))
        }
    }

    private func okResponse(id: String, data: [String: Any]) -> [String: Any] {
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
            "haptics": true
        ]
    }

    private func player() -> [String: Any] {
        return [
            "id": "ios-local-player",
            "displayName": "iOS Local Player",
            "isGuest": true
        ]
    }
}
