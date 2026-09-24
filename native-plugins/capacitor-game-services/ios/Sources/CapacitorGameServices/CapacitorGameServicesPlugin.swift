import Capacitor
import Foundation

@objc(CapacitorGameServicesPlugin)
public class CapacitorGameServicesPlugin: CAPPlugin, CAPBridgedPlugin {
    private let storageLoadProtocol = "mpgd.storage.load.v1"
    public let identifier = "CapacitorGameServicesPlugin"
    public let jsName = "CapacitorGameServices"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "request", returnType: CAPPluginReturnPromise)
    ]
    private lazy var localStorage = LocalJsonStorage(
        backend: MigratingFileLocalJsonStorageBackend(
            backend: FileLocalJsonStorageBackend(),
            legacyDefaults: .standard
        )
    )

    @objc func request(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), !id.isEmpty else {
            call.resolve(errorResponse(id: "", code: "INVALID_BRIDGE_REQUEST", message: "Bridge request ID is required."))
            return
        }

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
        case "commerce.getProducts", "commerce.purchase", "commerce.restore", "commerce.getEntitlements":
            call.resolve(errorResponse(id: id, code: "NATIVE_IAP_UNAVAILABLE", message: "No native store provider is installed."))
        case "ads.preload", "ads.showRewarded", "ads.showInterstitial", "ads.mountBanner", "ads.unmountBanner":
            call.resolve(errorResponse(id: id, code: "NATIVE_ADS_UNAVAILABLE", message: "No native ads provider is installed."))
        case "leaderboard.submitScore", "leaderboard.open":
            call.resolve(errorResponse(id: id, code: "NATIVE_LEADERBOARD_UNAVAILABLE", message: "No native leaderboard provider is installed."))
        case "storage.load":
            loadStorage(call, id: id)
        case "storage.save":
            saveStorage(call, id: id)
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

    private func errorResponse(
        id: String,
        code: String,
        message: String,
        retryable: Bool = false
    ) -> [String: Any] {
        return [
            "id": id,
            "ok": false,
            "error": [
                "code": code,
                "message": message,
                "retryable": retryable
            ]
        ]
    }

    private func loadStorage(_ call: CAPPluginCall, id: String) {
        guard let key = storageKey(call) else {
            call.resolve(errorResponse(
                id: id,
                code: "INVALID_STORAGE_KEY",
                message: "Storage key must be a string."
            ))
            return
        }

        do {
            guard let serializedValue = try localStorage.load(key: key) else {
                call.resolve(okResponse(id: id, data: [
                    "__mpgdBridgeProtocol": storageLoadProtocol,
                    "found": false
                ]))
                return
            }

            let value = try JSONSerialization.jsonObject(
                with: Data(serializedValue.utf8),
                options: [.fragmentsAllowed]
            )
            call.resolve(okResponse(id: id, data: [
                "__mpgdBridgeProtocol": storageLoadProtocol,
                "found": true,
                "value": value
            ]))
        } catch let error as LocalJsonStorageError {
            call.resolve(errorResponse(
                id: id,
                code: error.bridgeCode,
                message: error.bridgeMessage,
                retryable: error.retryable
            ))
        } catch {
            call.resolve(errorResponse(
                id: id,
                code: "NATIVE_STORAGE_LOAD_FAILED",
                message: "Native storage contained an invalid JSON value."
            ))
        }
    }

    private func saveStorage(_ call: CAPPluginCall, id: String) {
        guard let payload = call.getObject("payload"),
              let key = payload["key"] as? String else {
            call.resolve(errorResponse(
                id: id,
                code: "INVALID_STORAGE_KEY",
                message: "Storage key must be a string."
            ))
            return
        }

        guard payload.keys.contains("value"), let value = payload["value"] else {
            call.resolve(errorResponse(
                id: id,
                code: "INVALID_STORAGE_VALUE",
                message: "Storage value must be JSON serializable."
            ))
            return
        }

        let serializedValue: String

        do {
            let data = try JSONSerialization.data(
                withJSONObject: value,
                options: [.fragmentsAllowed]
            )

            guard let candidate = String(data: data, encoding: .utf8) else {
                throw EncodingError.invalidValue(
                    value,
                    EncodingError.Context(
                        codingPath: [],
                        debugDescription: "JSON serialization did not produce UTF-8."
                    )
                )
            }

            serializedValue = candidate
        } catch {
            call.resolve(errorResponse(
                id: id,
                code: "INVALID_STORAGE_VALUE",
                message: "Storage value must be JSON serializable."
            ))
            return
        }

        do {
            try localStorage.save(key: key, serializedValue: serializedValue)
            call.resolve(okResponse(id: id, data: ["saved": true]))
        } catch let error as LocalJsonStorageError {
            call.resolve(errorResponse(
                id: id,
                code: error.bridgeCode,
                message: error.bridgeMessage,
                retryable: error.retryable
            ))
        } catch {
            call.resolve(errorResponse(
                id: id,
                code: "NATIVE_STORAGE_SAVE_FAILED",
                message: "Native storage could not be saved.",
                retryable: true
            ))
        }
    }

    private func storageKey(_ call: CAPPluginCall) -> String? {
        return call.getObject("payload")?["key"] as? String
    }

    private func capabilities() -> [String: Any] {
        return [
            "nativeIap": false,
            "nativeAds": false,
            "rewardedAds": false,
            "interstitialAds": false,
            "bannerAds": false,
            "nativeLeaderboard": false,
            "remoteLeaderboard": false,
            "achievements": false,
            "cloudSave": false,
            "socialShare": false,
            "haptics": false,
            "localizedContent": true
        ]
    }

    private func player() -> [String: Any] {
        return [
            "playerId": "ios-local-player",
            "displayName": "iOS Local Player"
        ]
    }

}
