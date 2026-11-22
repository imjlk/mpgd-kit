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
        .library(name: "MpgdCapacitorStoreKit", targets: ["MpgdCapacitorStoreKit"]),
        // `cap sync ios` derives the product it links from the npm package
        // name (`@mpgd/capacitor-storekit` -> `MpgdCapacitorStorekit`).
        .library(name: "MpgdCapacitorStorekit", targets: ["MpgdCapacitorStoreKit"])
    ],
    dependencies: (bridgeTestsOnly ? [] : [
        // The shell's generated CapApp-SPM pins Capacitor exactly. This range
        // matches the npm peer (^8.5.1), so the plugin resolves in any
        // Capacitor 8 shell from 8.5.1 on rather than in one patch release.
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.5.1")
    ]) + [
        // OpenIAP Apple core (StoreKit 2), pinned exactly. See
        // docs/specs/commerce/openiap-migration.md before changing it.
        .package(url: "https://github.com/hyodotdev/openiap.git", exact: "4.0.7")
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
