// swift-tools-version: 5.9
import PackageDescription

// `MPGD_STOREKIT_BRIDGE_TESTS=1 swift test` builds only the store-neutral
// bridge and its XCTests on a Mac. Capacitor ships iOS-only binaries, so the
// plugin target is left out of that host build. Consumers never set it.
let bridgeTestsOnly = Context.environment["MPGD_STOREKIT_BRIDGE_TESTS"] == "1"

let openIap = Target.Dependency.product(name: "OpenIAP", package: "openiap")

let bridge = Target.target(
    name: "MpgdStoreKitBridge",
    dependencies: [openIap],
    path: "ios/Sources/MpgdStoreKitBridge"
)

let package = Package(
    name: "MpgdCapacitorStoreKit",
    platforms: bridgeTestsOnly ? [.iOS(.v15), .macOS(.v14)] : [.iOS(.v15)],
    products: bridgeTestsOnly ? [] : [
        .library(name: "MpgdCapacitorStoreKit", targets: ["MpgdCapacitorStoreKit"])
    ],
    dependencies: (bridgeTestsOnly ? [] : [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "8.5.2")
    ]) + [
        // OpenIAP Apple core (StoreKit 2), pinned exactly. See
        // docs/specs/commerce/openiap-migration.md before changing it.
        .package(url: "https://github.com/hyodotdev/openiap.git", exact: "4.0.5")
    ],
    targets: bridgeTestsOnly ? [
        bridge,
        .testTarget(
            name: "MpgdStoreKitBridgeTests",
            dependencies: ["MpgdStoreKitBridge", openIap],
            path: "ios/Tests/MpgdStoreKitBridgeTests"
        )
    ] : [
        bridge,
        .target(
            name: "MpgdCapacitorStoreKit",
            dependencies: [
                "MpgdStoreKitBridge",
                openIap,
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm")
            ],
            path: "ios/Sources/CapacitorStoreKit"
        )
    ]
)
