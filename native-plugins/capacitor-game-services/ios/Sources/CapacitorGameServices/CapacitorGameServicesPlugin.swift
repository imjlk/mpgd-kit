import Capacitor
import Foundation

@objc(CapacitorGameServicesPlugin)
public class CapacitorGameServicesPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "CapacitorGameServicesPlugin"
    public let jsName = "CapacitorGameServices"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "request", returnType: CAPPluginReturnPromise)
    ]
    private lazy var localStorage = LocalJsonStorage(
        backend: FileLocalJsonStorageBackend()
    )

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
                call.resolve(okResponse(id: id, data: ["found": false]))
                return
            }

            let value = try JSONSerialization.jsonObject(
                with: Data(serializedValue.utf8),
                options: [.fragmentsAllowed]
            )
            call.resolve(okResponse(id: id, data: [
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
